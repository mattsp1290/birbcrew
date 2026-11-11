import { publishObservation } from "./observation.ts";
import { savedProposal, type Approval } from "./approvals.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import {
  checkpointSchema, claimSchema, commitSchema, conversationKey, executionSchema, MemberStoreError,
  openSchema, spawnSchema, submitSchema,
  type BeginTurn, type Conversation, type Member, type TurnRequest,
} from "./domain.ts";

type ConversationKey = z.input<typeof conversationKey>;
type Claim = z.input<typeof claimSchema>;
type Execution = z.input<typeof executionSchema>;

type TurnRow = {
  phase: "started" | "uncertain" | "committed";
  prompt_digest: Buffer;
  workflow_run_id: string | null;
  activity_id: string | null;
  attempt: number;
  reply: string | null;
};

async function conversationFor(
  db: Pool | PoolClient, key: ConversationKey, lock: boolean,
): Promise<Conversation> {
  const result = await db.query<Conversation>(
    `SELECT c.owner_id AS "ownerId", c.conversation_id AS "conversationId",
            m.member_id AS "memberId", m.engine, m.profile
       FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING (owner_id, member_id)
      WHERE c.owner_id = $1 AND c.conversation_id = $2 ${lock ? "FOR UPDATE OF c" : ""}`,
    [key.ownerId, key.conversationId],
  );
  if (!result.rows.length) throw new MemberStoreError("not_found");
  return result.rows[0];
}

export class MemberStore {
  readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async migrate(): Promise<void> {
    await this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('birbcrew_ts.migration', 0))");
      await db.query("CREATE SCHEMA IF NOT EXISTS birbcrew_ts");
      await db.query("CREATE TABLE IF NOT EXISTS birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
      for (const [version, name] of [[1, "001-members.sql"], [2, "002-approvals.sql"], [4, "004-observation.sql"]] as const) {
        const applied = await db.query("SELECT 1 FROM birbcrew_ts.schema_versions WHERE version=$1", [version]);
        if (applied.rowCount) continue;
        await db.query(await readFile(new URL("./sql/" + name, import.meta.url), "utf8"));
        await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [version]);
      }
    });
  }

  async spawn(input: z.input<typeof spawnSchema>): Promise<Member> {
    const { ownerId, requestId, engine, profile } = spawnSchema.parse(input);
    return this.transaction(async (db) => {
      await db.query(
        `INSERT INTO birbcrew_ts.members (owner_id, spawn_request_id, engine, profile)
         VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id, spawn_request_id) DO NOTHING`,
        [ownerId, requestId, engine, profile],
      );
      const { rows: [member] } = await db.query<Member>(
        `SELECT owner_id AS "ownerId", member_id AS "memberId", engine, profile
           FROM birbcrew_ts.members WHERE owner_id = $1 AND spawn_request_id = $2`,
        [ownerId, requestId],
      );
      if (member.engine !== engine || member.profile !== profile) throw new MemberStoreError("conflict");
      return member;
    });
  }

  async openConversation(input: z.input<typeof openSchema>): Promise<Conversation> {
    const key = openSchema.parse(input);
    return this.transaction(async (db) => {
      await db.query(
        `INSERT INTO birbcrew_ts.conversations (owner_id, member_id, conversation_id)
         SELECT owner_id, member_id, $3 FROM birbcrew_ts.members WHERE owner_id = $1 AND member_id = $2
         ON CONFLICT (conversation_id) DO NOTHING`,
        [key.ownerId, key.memberId, key.conversationId],
      );
      const conversation = await conversationFor(db, key, false);
      if (conversation.memberId !== key.memberId) throw new MemberStoreError("conflict");
      return conversation;
    });
  }

  getConversation(key: ConversationKey): Promise<Conversation> {
    return conversationFor(this.pool, conversationKey.parse(key), false);
  }

  async workflowRunId(key: ConversationKey): Promise<string | undefined> {
    const { rows: [turn] } = await this.pool.query<{ run: string | null }>(
      `SELECT t.workflow_run_id AS run
         FROM birbcrew_ts.turns t JOIN birbcrew_ts.conversations c USING (conversation_id)
        WHERE c.owner_id = $1 AND c.conversation_id = $2 AND t.position = 1`,
      [key.ownerId, key.conversationId],
    );
    return turn?.run ?? undefined;
  }

  async committedReply(input: z.input<typeof submitSchema>): Promise<string | undefined> {
    const key = submitSchema.parse(input);
    const { rows: [turn] } = await this.pool.query<Pick<TurnRow, "prompt_digest" | "phase" | "reply">>(
      `SELECT t.prompt_digest, t.phase, t.reply
         FROM birbcrew_ts.turns t JOIN birbcrew_ts.conversations c USING (conversation_id)
        WHERE c.owner_id = $1 AND c.conversation_id = $2 AND t.request_id = $3`,
      [key.ownerId, key.conversationId, key.requestId],
    );
    if (!turn) return undefined;
    const digest = createHash("sha256").update(key.text, "utf8").digest();
    if (!turn.prompt_digest.equals(digest) || turn.phase === "uncertain") throw new MemberStoreError("conflict");
    return turn.reply ?? undefined;
  }

  async beginTurn(input: z.input<typeof submitSchema>, identity?: Execution): Promise<BeginTurn> {
    const key = submitSchema.parse(input);
    const execution = executionSchema.optional().parse(identity);
    const digest = createHash("sha256").update(key.text, "utf8").digest();
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const { rows: [turn] } = await db.query<TurnRow>(
        `SELECT phase, prompt_digest, workflow_run_id, activity_id, attempt, reply
           FROM birbcrew_ts.turns WHERE conversation_id = $1 AND request_id = $2`,
        [key.conversationId, key.requestId],
      );
      if (turn) {
        if (!turn.prompt_digest.equals(digest)) throw new MemberStoreError("conflict");
        if (turn.reply !== null) return { kind: "replay", reply: turn.reply };
        if (turn.phase === "started") {
          const approval = await savedProposal(db, conversation, key.requestId);
          if (approval) return { kind: "pending", approval };
        }
        if (turn.phase === "started" && execution) {
          if (turn.workflow_run_id !== execution.workflowRunId || turn.activity_id !== execution.activityId
              || turn.attempt > execution.attempt) throw new MemberStoreError("stale");
          if (turn.attempt < execution.attempt) {
            await db.query(
              `UPDATE birbcrew_ts.turns SET phase = 'uncertain', attempt = $3
                WHERE conversation_id = $1 AND request_id = $2`,
              [key.conversationId, key.requestId, execution.attempt],
            );
            await publishObservation(db, key.conversationId, { kind: "failed", requestId: key.requestId });
          }
        }
        return { kind: "uncertain" };
      }
      const { rows: [last] } = await db.query<{ position: number; phase: string; checkpoint: unknown }>(
        `SELECT position, phase, checkpoint FROM birbcrew_ts.turns
          WHERE conversation_id = $1 ORDER BY position DESC LIMIT 1`,
        [key.conversationId],
      );
      if (last && last.phase !== "committed") throw new MemberStoreError("busy");
      if (last?.position === 4) throw new MemberStoreError("input_limit");
      const { rows: [{ token }] } = await db.query<{ token: string }>(
        `INSERT INTO birbcrew_ts.turns
           (conversation_id, request_id, prompt_digest, position, phase, workflow_run_id, activity_id, attempt)
         VALUES ($1, $2, $3, $4, 'started', $5, $6, $7) RETURNING token`,
        [key.conversationId, key.requestId, digest, (last?.position ?? 0) + 1,
          execution?.workflowRunId ?? null, execution?.activityId ?? null, execution?.attempt ?? 1],
      );
      await publishObservation(db, key.conversationId, { kind: "input", requestId: key.requestId, text: key.text });
      return { kind: "start", conversation, token, checkpoint: last ? checkpointSchema.parse(last.checkpoint) : null };
    });
  }

  async beginResume(request: TurnRequest, approval: Approval, execution: Execution) {
    const key = submitSchema.parse(request);
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const { rows: [turn] } = await db.query<TurnRow & {
        token: string; checkpoint: unknown; resume_activity_id: string | null;
      }>(`SELECT t.*, s.checkpoint, s.resume_activity_id FROM birbcrew_ts.turns t
          JOIN birbcrew_ts.paused_segments s USING (conversation_id, request_id)
          WHERE t.conversation_id=$1 AND t.request_id=$2 AND s.approval_id=$3`,
        [key.conversationId, key.requestId, approval.approvalId]);
      if (!turn || !turn.prompt_digest.equals(createHash("sha256").update(key.text).digest()) ||
          turn.workflow_run_id !== execution.workflowRunId) throw new MemberStoreError("stale");
      if (turn.phase === "committed" && turn.reply !== null) return { kind: "replay" as const, reply: turn.reply };
      if (turn.phase === "uncertain") return { kind: "uncertain" as const };
      if (turn.resume_activity_id !== null) {
        if (turn.resume_activity_id !== execution.activityId || turn.attempt > execution.attempt) {
          throw new MemberStoreError("stale");
        }
        if (turn.attempt < execution.attempt) {
          await db.query("UPDATE birbcrew_ts.turns SET phase='uncertain',attempt=$3 WHERE conversation_id=$1 AND request_id=$2",
            [key.conversationId, key.requestId, execution.attempt]);
          await publishObservation(db, key.conversationId, { kind: "failed", requestId: key.requestId });
        }
        return { kind: "uncertain" as const };
      }
      const { rows: [{ token }] } = await db.query<{token: string}>(
        `UPDATE birbcrew_ts.turns SET token=gen_random_uuid(),activity_id=$3,attempt=$4
         WHERE conversation_id=$1 AND request_id=$2 RETURNING token`,
        [key.conversationId, key.requestId, execution.activityId, execution.attempt]);
      await db.query("UPDATE birbcrew_ts.paused_segments SET resume_activity_id=$2 WHERE approval_id=$1",
        [approval.approvalId, execution.activityId]);
      await publishObservation(db, key.conversationId, { kind: "resume", approvalId: approval.approvalId });
      return { kind: "start" as const, token, conversation, checkpoint: checkpointSchema.parse(turn.checkpoint) };
    });
  }

  async commitTurn(input: Claim & { checkpoint: unknown; reply: string }): Promise<string> {
    const key = commitSchema.parse(input);
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      if (key.checkpoint.engine !== conversation.engine) throw new MemberStoreError("conflict");
      const args = [key.conversationId, key.requestId, key.token, key.reply, JSON.stringify(key.checkpoint)];
      const update = await db.query(
        `UPDATE birbcrew_ts.turns SET phase = 'committed', reply = $4, checkpoint = $5
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase = 'started'`, args,
      );
      if (update.rowCount) {
        await publishObservation(db, key.conversationId, { kind: "reply", requestId: key.requestId, text: key.reply });
        return key.reply;
      }
      const replay = await db.query<{ reply: string }>(
        `SELECT reply FROM birbcrew_ts.turns
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase = 'committed'
            AND reply = $4 AND checkpoint = $5::jsonb`, args,
      );
      if (replay.rows.length) return replay.rows[0].reply;
      throw new MemberStoreError("stale");
    });
  }

  async markUncertain(input: Claim): Promise<void> {
    const key = claimSchema.parse(input);
    await this.transaction(async (db) => {
      await conversationFor(db, key, true);
      const result = await db.query(
        `UPDATE birbcrew_ts.turns SET phase = 'uncertain'
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase IN ('started', 'uncertain')`,
        [key.conversationId, key.requestId, key.token],
      );
      if (!result.rowCount) throw new MemberStoreError("stale");
      await publishObservation(db, key.conversationId, { kind: "failed", requestId: key.requestId });
    });
  }
}

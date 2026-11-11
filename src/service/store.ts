import { interruptLiveLocked } from "./codex-calls.ts";
import { captureProjectNotes } from "./project-notes.ts";
import { requestNativeStop } from "./native-admission.ts";
import { textProjection } from "./text-stream.ts";
import { publishObservation } from "./observation.ts";
import type { ChildOutcome } from "@birbcrew/pi-subagents";
import { childrenFor } from "./children.ts";
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
      const migrations = [[1, "001-members.sql"], [2, "002-approvals.sql"], [3, "003-native-launches.sql"],
      [4, "004-observation.sql"], [5, "005-pi-children.sql"], [6, "006-open-text.sql"], [7, "007-native-stops.sql"], [8, "008-tool-previews.sql"], [9, "009-project-notes.sql"], [10, "010-next-step.sql"], [11, "011-codex-members.sql"], [12, "012-codex-calls.sql"]] as const;
      for (const [version, name] of migrations) {
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
      const inserted = await db.query(
        `INSERT INTO birbcrew_ts.conversations (owner_id, member_id, conversation_id)
         SELECT owner_id, member_id, $3 FROM birbcrew_ts.members WHERE owner_id = $1 AND member_id = $2
         ON CONFLICT (conversation_id) DO NOTHING`,
        [key.ownerId, key.memberId, key.conversationId],
      );
      const conversation = await conversationFor(db, key, false);
      if (conversation.memberId !== key.memberId) throw new MemberStoreError("conflict");
      if (inserted.rowCount) {
        const capture = await captureProjectNotes(key.ownerId);
        if (capture) await db.query("INSERT INTO birbcrew_ts.conversation_notes (conversation_id,capture) VALUES ($1,$2)",
          [key.conversationId, JSON.stringify(capture)]);
      }
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

  async cancelGenerating(key: Pick<TurnRequest, "ownerId" | "conversationId" | "requestId">) {
    return this.transaction(async db => {
      const member = await conversationFor(db,key,true);
      const args = [key.conversationId,key.requestId];
      const {rows:[turn]} = await db.query<{token:string;phase:string}>(
        "SELECT token,phase FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",args);
      if (!turn || turn.phase !== "started") throw new MemberStoreError("conflict");
      if (await savedProposal(db,member,key.requestId) || (await childrenFor(db,member,key.requestId)).length) return false;
      // Stop publication cannot wait for the SDK's shared grant on the turn row.
      await db.query("INSERT INTO birbcrew_ts.native_stop_requests VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[...args,turn.token]);
      await db.query("INSERT INTO birbcrew_ts.tool_cancellations VALUES ($1,$2) ON CONFLICT DO NOTHING",args);
      await publishObservation(db,key.conversationId,{kind:"cancelled",requestId:key.requestId});
      return true;
    });
  }

  async reconcileTurn(input: z.input<typeof submitSchema>, workflowRunId: string, resuming: boolean, allowRecovery = true) {
    const key = submitSchema.parse(input);
    const digest = createHash("sha256").update(key.text).digest();
    await requestNativeStop(this.pool, key, { workflowRunId });
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const { rows: [turn] } = await db.query<TurnRow>(
        "SELECT reply, phase, prompt_digest, workflow_run_id FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",
        [key.conversationId, key.requestId],
      );
      if (turn) {
        if (turn.workflow_run_id !== workflowRunId || !turn.prompt_digest.equals(digest)) {
          throw new MemberStoreError("conflict");
        }
        if (turn.reply !== null) return { kind: "complete", text: turn.reply } as const;
        if (!resuming && turn.phase === "started") {
          const children = await childrenFor(db, conversation, key.requestId);
          if (children.length) return {kind:"delegated" as const, children};
          const approval = await savedProposal(db, conversation, key.requestId);
          if (approval) return { kind: "pending", approval } as const;
        }
        await db.query("UPDATE birbcrew_ts.turns SET phase='uncertain' WHERE conversation_id=$1 AND request_id=$2",
          [key.conversationId, key.requestId]);
        if (!resuming && allowRecovery && conversation.engine === "claude") {
          const admitted = await db.query(`SELECT 1 FROM birbcrew_ts.native_launches n
            JOIN birbcrew_ts.turns t USING (conversation_id,request_id,token)
            JOIN birbcrew_ts.profiles p ON p.name=$3 AND p.engine='claude' AND (p.protected_tool='record_work_item' OR p.human_tool='choose_next_step')
            WHERE n.conversation_id=$1 AND n.request_id=$2 AND NOT n.recovery_closed`, [key.conversationId, key.requestId, conversation.profile]);
          if (admitted.rowCount) return { kind: "recover" } as const;
        }
      } else {
        await db.query(`INSERT INTO birbcrew_ts.turns
          (conversation_id,request_id,position,prompt_digest,phase,workflow_run_id,activity_id,attempt)
          SELECT $1,$2,coalesce(max(position),0)+1,$3,'uncertain',$4,'unadmitted',1
          FROM birbcrew_ts.turns WHERE conversation_id=$1`, [key.conversationId, key.requestId, digest, workflowRunId]);
      }
      await db.query("UPDATE birbcrew_ts.native_launches SET recovery_closed=true WHERE conversation_id=$1 AND request_id=$2",
        [key.conversationId, key.requestId]);
      if (conversation.engine === "codex") await interruptLiveLocked(db, key);
      const stopped = await db.query(`SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2
        AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND request_id=$2 AND NOT stopped)`,
        [key.conversationId,key.requestId]);
      await publishObservation(db, key.conversationId, { kind: stopped.rowCount ? "stopped" : "failed", requestId:key.requestId });
      return null;
    });
  }

  async stoppedProposal(input: TurnRequest, workflowRunId: string) {
    const key = submitSchema.parse(input);
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      if (conversation.engine !== "claude") return null;
      const { rows: [row] } = await db.query<{ token: string; stopped: boolean; phase: string; checkpoint: unknown }>(
        `SELECT t.token, n.stopped, t.phase, previous.checkpoint FROM birbcrew_ts.turns t
         JOIN birbcrew_ts.native_launches n USING (conversation_id,request_id,token)
         LEFT JOIN birbcrew_ts.turns previous ON previous.conversation_id=t.conversation_id AND previous.position=t.position-1
         WHERE t.conversation_id=$1 AND t.request_id=$2 AND t.workflow_run_id=$3 AND t.prompt_digest=$4 AND NOT n.recovery_closed
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.paused_segments s
             WHERE s.conversation_id=t.conversation_id AND s.request_id=t.request_id AND s.resume_activity_id IS NOT NULL)`,
        [key.conversationId, key.requestId, workflowRunId, createHash("sha256").update(key.text).digest()]);
      if (!row) return null;
      if (row.phase === "started") {
        const approval = await savedProposal(db, conversation, key.requestId);
        return approval ? { kind: "pending", approval } as const : null;
      }
      if (row.phase !== "uncertain") return null;
      if (!row.stopped) return { kind: "stopping" } as const;
      return { kind: "recover" as const, conversation, token: row.token,
        checkpoint: row.checkpoint === null ? null : checkpointSchema.parse(row.checkpoint) };
    });
  }

  async beginTurn(input: z.input<typeof submitSchema>, identity?: Execution): Promise<BeginTurn> {
    const key = submitSchema.parse(input);
    const execution = executionSchema.optional().parse(identity);
    const digest = createHash("sha256").update(key.text, "utf8").digest();
    if (execution && execution.attempt > 1) await requestNativeStop(this.pool, key, {
      workflowRunId: execution.workflowRunId,
      activityId: execution.activityId, beforeAttempt: execution.attempt
    });
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
          const children = await childrenFor(db, conversation, key.requestId);
          if (children.length) return { kind: "delegated", children };
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

  async beginResume(request: TurnRequest, approval: Approval | null, execution: Execution) {
    const key = submitSchema.parse(request);
    if (execution && execution.attempt > 1) await requestNativeStop(this.pool, key, {
      workflowRunId: execution.workflowRunId,
      activityId: execution.activityId, beforeAttempt: execution.attempt
    });
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const args = [key.conversationId, key.requestId];
      const paused = approval
        ? "SELECT checkpoint,resume_activity_id FROM birbcrew_ts.paused_segments WHERE conversation_id=$1 AND request_id=$2 AND approval_id=$3"
        : "SELECT parent_checkpoint AS checkpoint,resume_activity_id FROM birbcrew_ts.delegations WHERE conversation_id=$1 AND request_id=$2";
      const { rows: [turn] } = await db.query<TurnRow & {
        checkpoint: unknown; resume_activity_id: string | null;
      }>(`SELECT t.*,s.checkpoint,s.resume_activity_id FROM birbcrew_ts.turns t CROSS JOIN (${paused}) s
          WHERE t.conversation_id=$1 AND t.request_id=$2`, approval ? [...args, approval.approvalId] : args);
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
        }
        return { kind: "uncertain" as const };
      }
      const { rows: [{ token }] } = await db.query<{token: string}>(
        `UPDATE birbcrew_ts.turns SET token=gen_random_uuid(),activity_id=$3,attempt=$4
         WHERE conversation_id=$1 AND request_id=$2 RETURNING token`,
        [key.conversationId, key.requestId, execution.activityId, execution.attempt]);
      let childResults: ChildOutcome[] | undefined;
      if (approval) {
        await db.query("UPDATE birbcrew_ts.paused_segments SET resume_activity_id=$2 WHERE approval_id=$1",
          [approval.approvalId, execution.activityId]);
        await publishObservation(db,key.conversationId,{kind:"resume",approvalId:approval.approvalId});
      } else {
        const { rows } = await db.query<{ outcome: ChildOutcome | null }>(
          "SELECT outcome FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2 ORDER BY ordinal", args);
        childResults = rows.map(({ outcome }) => {
          if (!outcome) throw new MemberStoreError("busy");
          return outcome;
        });
        if (!childResults.length) throw new MemberStoreError("not_found");
        await db.query("UPDATE birbcrew_ts.delegations SET resume_activity_id=$3 WHERE conversation_id=$1 AND request_id=$2",
          [...args, execution.activityId]);
      }
      return { kind: "start" as const, token, conversation, checkpoint: checkpointSchema.parse(turn.checkpoint), childResults };
    });
  }

  async previewTool(claim: Claim & {childId?:string}, nativeCallId: string, matchedOperation = false) {
    await this.transaction(async (db) => {
      await conversationFor(db, { ownerId: claim.ownerId, conversationId: claim.conversationId }, true);
      const { rows: [preview] } = await db.query<{ public_id: string }>(`INSERT INTO birbcrew_ts.tool_previews AS p
        (conversation_id,request_id,invocation_id,native_call_id,generation)
        SELECT n.conversation_id,n.request_id,COALESCE(n.child_id,t.request_id),$4,n.token
          FROM birbcrew_ts.native_launches n JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
          LEFT JOIN birbcrew_ts.pi_children j ON j.child_id=n.child_id
         WHERE n.conversation_id=$1 AND n.request_id=$2 AND n.token=$3 AND n.child_id IS NOT DISTINCT FROM $5::uuid
           AND t.phase='started' AND NOT n.stopped AND
           ((n.child_id IS NULL AND t.token=n.token) OR (j.generation=n.token AND j.phase='running' AND NOT j.launch_revoked))
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)
        ON CONFLICT (conversation_id,request_id,invocation_id) DO UPDATE SET public_id=p.public_id
        WHERE p.native_call_id=EXCLUDED.native_call_id AND p.generation=EXCLUDED.generation RETURNING public_id`,
        [claim.conversationId, claim.requestId, claim.token, nativeCallId, claim.childId ?? null]);
      if (!preview) throw new MemberStoreError("stale");
      await publishObservation(db, claim.conversationId, { kind: "toolPreview", invocationId: claim.childId ?? claim.requestId, publicId: preview.public_id });
      if (matchedOperation) await publishObservation(db, claim.conversationId, {
        kind: "toolValue", invocationId: claim.childId ?? claim.requestId, publicId: preview.public_id, requestId: claim.requestId,
      });
    });
  }

  async appendText(claim: Claim & { childId?: string }, messageId: string, index: number, delta: string) {
    await this.transaction(async (db) => {
      await conversationFor(db, { ownerId: claim.ownerId, conversationId: claim.conversationId }, true);
      const args = [claim.conversationId,claim.requestId,claim.token];
      const active = claim.childId
        ? await db.query(`SELECT 1 FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2 AND generation=$3
           AND child_id=$4 AND phase IN ('running','resuming') AND NOT launch_revoked
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)`, [...args,claim.childId])
        : await db.query(`SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2 AND token=$3 AND phase='started'
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)`, args);
      if (!active.rowCount) throw new MemberStoreError("stale");
      await publishObservation(db, claim.conversationId, { kind:"text", messageId,index,delta,childId:claim.childId });
    });
  }

  async appendCodexItem(claim: Claim, index: number, text: string) {
    await this.transaction(async db => {
      const member = await conversationFor(db, claim, true);
      if (member.engine !== "codex") throw new MemberStoreError("conflict");
      const current = await db.query("SELECT 1 FROM birbcrew_ts.turns t WHERE conversation_id=$1 AND request_id=$2 AND token=$3 AND phase='started' " +
        "AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)",
        [claim.conversationId, claim.requestId, claim.token]);
      if (!current.rowCount) throw new MemberStoreError("stale");
      const project = await textProjection(db,claim.conversationId);
      await publishObservation(db,claim.conversationId,{kind:"nativeItem",requestId:claim.requestId,index,text:project(text,true)});
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
        const project = await textProjection(db, key.conversationId);
        const cancelled = await db.query("SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2",
          [key.conversationId,key.requestId]);
        await publishObservation(db, key.conversationId, { kind: "reply", requestId: key.requestId, text: project(key.reply, true), cancelled:!!cancelled.rowCount });
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
    await requestNativeStop(this.pool, key, { token: key.token });
    await this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const result = await db.query(
        `UPDATE birbcrew_ts.turns SET phase = 'uncertain'
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase IN ('started', 'uncertain')`,
        [key.conversationId, key.requestId, key.token],
      );
      if (!result.rowCount) throw new MemberStoreError("stale");
      if (conversation.engine === "codex") await interruptLiveLocked(db, key, key.token);
      await publishObservation(db, key.conversationId, { kind: "failed", requestId: key.requestId });
    });
  }
}

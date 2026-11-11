import { publishObservation } from "./observation.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { checkpointSchema, MemberStoreError, openSchema, turnKey, type Conversation } from "./domain.ts";

const uuid = turnKey.shape.requestId;
const scopeSchema = openSchema.extend({ requestId: uuid });
const callSchema = scopeSchema.extend({
  invocationId: uuid,
  nativeCallId: z.string().min(1).refine((id) =>
    id.isWellFormed() && !id.includes("\0") && Buffer.byteLength(id) <= 256),
});
export const recordWorkItemArguments = z.strictObject({
  operation_id: uuid,
  note: z.string().refine((s) => s.isWellFormed() && !s.includes("\0") && Buffer.byteLength(s) <= 4096).optional(),
});
const proposalSchema = callSchema.extend({
  token: uuid, toolName: z.literal("record_work_item"), arguments: recordWorkItemArguments,
});
const approvalKey = callSchema.extend({ approvalId: uuid });
export const decisionSchema = approvalKey.extend({
  argumentDigest: z.string().regex(/^[0-9a-f]{64}$/), version: z.number().int(), choice: z.enum(["approve", "deny"]),
});
const settleSchema = approvalKey.extend({ token: uuid });

type Scope = z.infer<typeof scopeSchema>;
type CallKey = z.infer<typeof approvalKey>;
export type Decision = z.infer<typeof decisionSchema>;
export type Choice = z.infer<typeof decisionSchema>["choice"];
export type Approval = CallKey & {
  toolName: "record_work_item"; argumentDigest: string; version: 1; policyVersion: 1;
  summary: "Record one work item";
};
export type ToolOutcome =
  | { nativeCallId: string; kind: "recorded"; receipt: { receiptId: string; operationId: string } }
  | { nativeCallId: string; kind: "denied" | "cancelled" | "budget_exhausted" };

type CallRow = {
  approvalId: string; invocationId: string; nativeCallId: string; argumentDigest: string;
  toolName: "record_work_item"; version: 1; policyVersion: 1; decision: Choice | null; budget_exhausted: boolean;
};
const columns = `p.approval_id AS "approvalId", p.invocation_id AS "invocationId", p.native_call_id AS "nativeCallId",
  p.argument_digest AS "argumentDigest", p.tool_name AS "toolName", p.decision_version AS version,
  p.policy_version AS "policyVersion", p.decision, p.budget_exhausted`;

function publicApproval(scope: Scope, row: CallRow): Approval {
  return {
    ownerId: scope.ownerId, memberId: scope.memberId, conversationId: scope.conversationId, requestId: scope.requestId,
    approvalId: row.approvalId, invocationId: row.invocationId, nativeCallId: row.nativeCallId,
    toolName: row.toolName, argumentDigest: row.argumentDigest, version: row.version, policyVersion: row.policyVersion,
    summary: "Record one work item",
  };
}

async function lockTurn(db: PoolClient, scope: Scope) {
  const conversation = await db.query(
    `SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id = $1 AND member_id = $2 AND conversation_id = $3
     FOR UPDATE`, [scope.ownerId, scope.memberId, scope.conversationId],
  );
  if (!conversation.rowCount) throw new MemberStoreError("not_found");
  const { rows: [turn] } = await db.query<{ token: string; phase: string }>(
    "SELECT token, phase FROM birbcrew_ts.turns WHERE conversation_id = $1 AND request_id = $2",
    [scope.conversationId, scope.requestId],
  );
  if (!turn) throw new MemberStoreError("not_found");
  return turn;
}

async function findCall(db: PoolClient, key: CallKey) {
  const { rows: [row] } = await db.query<CallRow>(
    `SELECT ${columns} FROM birbcrew_ts.protected_calls p WHERE p.conversation_id = $1 AND p.request_id = $2
     AND p.invocation_id = $3 AND p.native_call_id = $4 AND p.approval_id = $5`,
    [key.conversationId, key.requestId, key.invocationId, key.nativeCallId, key.approvalId],
  );
  if (!row) throw new MemberStoreError("not_found");
  return row;
}

async function cancelled(db: PoolClient, key: Scope) {
  const result = await db.query(
    "SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id = $1 AND request_id = $2",
    [key.conversationId, key.requestId],
  );
  return result.rows.length > 0;
}

export async function savedProposal(db: PoolClient, conversation: Conversation, requestId: string) {
  const { rows: [row] } = await db.query<CallRow>(
    `SELECT ${columns} FROM birbcrew_ts.protected_calls p JOIN birbcrew_ts.paused_segments s USING (approval_id)
     WHERE p.conversation_id=$1 AND p.request_id=$2`, [conversation.conversationId, requestId],
  );
  return row ? publicApproval({ ...conversation, requestId }, row) : undefined;
}

export class ApprovalStore {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

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

  async migrate() {
    const sql = await readFile(new URL("./sql/002-approvals.sql", import.meta.url), "utf8");
    await this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('birbcrew_ts.migration', 0))");
      await db.query(sql);
    });
  }

  async propose(input: z.input<typeof proposalSchema>, pendingCheckpoint?: unknown): Promise<Approval> {
    const key = proposalSchema.parse(input);
    if (key.arguments.operation_id !== key.requestId) throw new MemberStoreError("conflict");
    const checkpoint = pendingCheckpoint === undefined ? undefined : checkpointSchema.parse(pendingCheckpoint);
    const digest = createHash("sha256").update(JSON.stringify([key.toolName, key.arguments.operation_id,
      key.arguments.note ?? null])).digest("hex");
    const ids = [key.conversationId, key.requestId, key.invocationId, key.nativeCallId];
    return this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      if (turn.token !== key.token || turn.phase !== "started") throw new MemberStoreError("stale");
      if (await cancelled(db, key)) throw new MemberStoreError("conflict");
      const existing = await db.query<CallRow>(
        `SELECT ${columns} FROM birbcrew_ts.protected_calls p WHERE p.conversation_id = $1 AND p.request_id = $2
         AND p.invocation_id = $3 AND p.native_call_id = $4`, ids,
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.argumentDigest !== digest) throw new MemberStoreError("conflict");
        if (checkpoint) {
          const same = await db.query("SELECT 1 FROM birbcrew_ts.paused_segments WHERE approval_id=$1 AND checkpoint=$2::jsonb",
            [prior.approvalId, JSON.stringify(checkpoint)]);
          if (!same.rowCount) throw new MemberStoreError("conflict");
        }
        return publicApproval(key, prior);
      }
      const inserted = await db.query<CallRow>(
        `INSERT INTO birbcrew_ts.protected_calls AS p
         (conversation_id, request_id, invocation_id, native_call_id, tool_name, arguments, argument_digest,
          policy_version, decision_version)
         SELECT $1, $2, $3, $4, $5, $6, $7, 1, 1
         WHERE (SELECT count(*) FROM birbcrew_ts.protected_calls WHERE conversation_id = $1 AND request_id = $2) < 16
         RETURNING ${columns}`, [...ids, key.toolName, key.arguments, digest],
      );
      if (!inserted.rows.length) throw new MemberStoreError("input_limit");
      const row = inserted.rows[0];
      if (checkpoint) {
        await db.query(`INSERT INTO birbcrew_ts.paused_segments (approval_id,conversation_id,request_id,checkpoint)
                        VALUES ($1,$2,$3,$4)`, [row.approvalId, key.conversationId, key.requestId, JSON.stringify(checkpoint)]);
      }
      const approval = publicApproval(key, row);
      await publishObservation(db, key.conversationId, { kind: "call", approval });
      return approval;
    });
  }

  async pending(input: z.input<typeof openSchema>): Promise<Approval[]> {
    const key = openSchema.parse(input);
    const conversation = await this.pool.query(
      "SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id = $1 AND member_id = $2 AND conversation_id = $3",
      [key.ownerId, key.memberId, key.conversationId],
    );
    if (!conversation.rowCount) throw new MemberStoreError("not_found");
    const result = await this.pool.query<CallRow & { requestId: string }>(
      `SELECT ${columns}, p.request_id AS "requestId" FROM birbcrew_ts.protected_calls p
         JOIN birbcrew_ts.turns t USING (conversation_id, request_id)
         LEFT JOIN birbcrew_ts.tool_cancellations x USING (conversation_id, request_id)
       WHERE p.conversation_id = $1 AND p.decision IS NULL
         AND t.phase = 'started' AND x.request_id IS NULL ORDER BY p.approval_id`,
      [key.conversationId],
    );
    return result.rows.map((row) => publicApproval({ ...key, requestId: row.requestId }, row));
  }

  async previousDecision(input: Decision): Promise<Choice | null> {
    const key = decisionSchema.parse(input);
    return this.transaction(async (db) => {
      await lockTurn(db, key);
      const call = await findCall(db, key);
      if (call.version !== key.version || call.argumentDigest !== key.argumentDigest ||
          (call.decision && call.decision !== key.choice)) throw new MemberStoreError("conflict");
      return call.decision;
    });
  }

  async decide(input: z.input<typeof decisionSchema>): Promise<Choice> {
    const key = decisionSchema.parse(input);
    return this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      const call = await findCall(db, key);
      if (call.version !== key.version || call.argumentDigest !== key.argumentDigest) throw new MemberStoreError("conflict");
      if (call.decision === key.choice) return call.decision;
      if (call.decision || turn.phase !== "started" || await cancelled(db, key)) throw new MemberStoreError("conflict");
      await db.query("UPDATE birbcrew_ts.protected_calls SET decision = $2 WHERE approval_id = $1",
        [key.approvalId, key.choice]);
      await publishObservation(db, key.conversationId, { kind: "answered", approvalId: key.approvalId });
      return key.choice;
    });
  }

  async isCancelled(scope: Scope) {
    const key = scopeSchema.parse(scope);
    return this.transaction(async (db) => {
      await lockTurn(db, key);
      return cancelled(db, key);
    });
  }

  async cancelTurn(input: Scope): Promise<void> {
    const key = scopeSchema.parse(input);
    await this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      if (await cancelled(db, key)) return;
      if (turn.phase !== "started") throw new MemberStoreError("conflict");
      await db.query("INSERT INTO birbcrew_ts.tool_cancellations (conversation_id, request_id) VALUES ($1,$2)",
        [key.conversationId, key.requestId]);
      await publishObservation(db, key.conversationId, { kind: "cancelled", requestId: key.requestId });
    });
  }

  async settleConfirmed(approval: Approval): Promise<ToolOutcome> {
    const { ownerId, memberId, conversationId, requestId, approvalId, invocationId, nativeCallId } = approval;
    const { rows: [turn] } = await this.pool.query<{ token: string }>(
      `SELECT token FROM birbcrew_ts.turns JOIN birbcrew_ts.conversations USING (conversation_id)
       WHERE owner_id=$1 AND member_id=$2 AND conversation_id=$3 AND request_id=$4`,
      [ownerId, memberId, conversationId, requestId]);
    if (!turn) throw new MemberStoreError("not_found");
    return this.settle({ ownerId, memberId, conversationId, requestId, approvalId, invocationId, nativeCallId, token: turn.token });
  }

  async settle(input: z.input<typeof settleSchema>): Promise<ToolOutcome> {
    const key = settleSchema.parse(input);
    return this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      if (turn.token !== key.token) throw new MemberStoreError("stale");
      const call = await findCall(db, key);
      const nativeCallId = key.nativeCallId;
      async function finish(outcome: ToolOutcome) {
        await publishObservation(db, key.conversationId, { kind: "result", approvalId: key.approvalId, outcome });
        return outcome;
      }
      if (call.budget_exhausted) return finish({ nativeCallId, kind: "budget_exhausted" });
      if (call.decision === "deny") return finish({ nativeCallId, kind: "denied" });
      const existing = await db.query<{ approval_id: string; receipt_id: string }>(
        "SELECT approval_id, receipt_id FROM birbcrew_ts.work_items WHERE conversation_id = $1 AND request_id = $2",
        [key.conversationId, key.requestId],
      );
      if (existing.rows[0]?.approval_id === key.approvalId) {
        return finish({ nativeCallId, kind: "recorded", receipt: { receiptId: existing.rows[0].receipt_id, operationId: key.requestId } });
      }
      if (await cancelled(db, key)) return finish({ nativeCallId, kind: "cancelled" });
      if (call.decision !== "approve") throw new MemberStoreError("conflict");
      if (existing.rows.length) {
        await db.query("UPDATE birbcrew_ts.protected_calls SET budget_exhausted = true WHERE approval_id = $1",
          [key.approvalId]);
        return finish({ nativeCallId, kind: "budget_exhausted" });
      }
      if (turn.phase !== "started") throw new MemberStoreError("stale");
      const inserted = await db.query<{ receipt_id: string }>(
        `INSERT INTO birbcrew_ts.work_items (conversation_id, request_id, approval_id, note)
         SELECT conversation_id, request_id, approval_id, arguments->>'note' FROM birbcrew_ts.protected_calls
         WHERE approval_id = $1 AND decision = 'approve' RETURNING receipt_id`, [key.approvalId],
      );
      return finish({ nativeCallId, kind: "recorded", receipt: { receiptId: inserted.rows[0].receipt_id, operationId: key.requestId } });
    });
  }
}

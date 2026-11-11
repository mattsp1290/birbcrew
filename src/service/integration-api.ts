import { z } from "zod";
import type { MemberClient } from "./client.ts";
import { MemberStoreError, submitSchema, turnKey } from "./domain.ts";
import { conversationTurnLimit, workflowGenerationTurnLimit } from "./limits.ts";
import type { MemberStore } from "./store.ts";

export const integrationCapabilities = {
  apiVersion: "1",
  requestContract: "sql-admission-temporal-queue-v1",
  identity: "owner/conversation/request UUID; exact UTF-8 text equivalence",
  cancellation: "durable-intent-v1",
  retention: "receipts-and-results-retained-with-database; no-automatic-TTL",
  rollover: { version: 1, maximumTurns: conversationTurnLimit, generationTurns: workflowGenerationTurnLimit },
  proxy: { version: 1, protocols: ["anthropic-messages", "openai-responses", "openai-chat-completions"] },
  trustedContext: { version: 1, transport: "operator-configured-local-runtime", httpSubmission: false },
  observation: { version: 1, protocol: "AG-UI", mode: "snapshot-and-bounded-tail", cursorExpiry: "reconnect-for-snapshot" },
} as const;

const keySchema = turnKey;
type Key = z.infer<typeof keySchema>;
type Status = "accepted" | "waiting" | "running" | "completed" | "cancellation_requested" | "cancelled" | "failed" | "uncertain";
export interface RequestReceipt {
  apiVersion: "1";
  conversationId: string;
  requestId: string;
  acceptance: { boundary: "sql_admission_and_temporal_queue" };
  status: Status;
  result?: { text: string };
  reason?: string;
  cancellation?: { receiptId: string; delivery: "pending" | "delivered"; nativeTermination: "confirmed" | "unconfirmed"; effects: "not_assessed" };
}

/** Public contract adapter; no SDK or Temporal internals are exposed to HTTP consumers. */
export class IntegrationApi {
  readonly store: MemberStore;
  readonly members: Pick<MemberClient, "accept" | "cancelPending" | "requestStatus">;
  private readonly delivering = new Set<string>();
  private scanning = false;

  constructor(store: MemberStore, members: Pick<MemberClient, "accept" | "cancelPending" | "requestStatus">) {
    this.store = store;
    this.members = members;
  }

  async submit(input: unknown): Promise<RequestReceipt> {
    const request = submitSchema.parse(input);
    // Unlike the legacy ACCEPTED stage, acceptTurn waits for SQL admission.
    // On lost acknowledgement the caller must reconcile, never choose a new UUID.
    await this.members.accept(request);
    return this.status({ ownerId: request.ownerId, conversationId: request.conversationId, requestId: request.requestId });
  }

  async status(input: unknown): Promise<RequestReceipt> {
    const key = keySchema.parse(input);
    // Reconcile an accepted/no-turn receipt against a terminal logical workflow.
    // This observes Temporal only: it never starts a workflow or dispatches inference.
    await this.members.requestStatus(key);
    const { rows: [row] } = await this.store.pool.query<{
      admission: string; reason: string | null; phase: string | null; reply: string | null;
      receipt_id: string | null; delivered_at: Date | null; stopped: boolean; waiting: boolean;
    }>(`SELECT a.phase AS admission,a.reason,t.phase,t.reply,x.receipt_id,x.delivered_at,
       EXISTS(SELECT 1 FROM birbcrew_ts.deferred_calls d WHERE d.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND d.request_id=COALESCE(a.request_id,t.request_id) AND d.decision IS NULL) AS waiting,
       (EXISTS(SELECT 1 FROM birbcrew_ts.tool_cancellations tc WHERE tc.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND tc.request_id=COALESCE(a.request_id,t.request_id))
        AND EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND n.request_id=COALESCE(a.request_id,t.request_id))
        AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND n.request_id=COALESCE(a.request_id,t.request_id) AND NOT n.stopped)) AS stopped
       FROM birbcrew_ts.request_admissions a FULL JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
       JOIN birbcrew_ts.conversations c ON c.conversation_id=COALESCE(a.conversation_id,t.conversation_id)
       LEFT JOIN birbcrew_ts.integration_cancellations x ON x.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND x.request_id=COALESCE(a.request_id,t.request_id)
       WHERE c.owner_id=$1 AND COALESCE(a.conversation_id,t.conversation_id)=$2 AND COALESCE(a.request_id,t.request_id)=$3`,
      [key.ownerId,key.conversationId,key.requestId]);
    if (!row) throw new MemberStoreError("not_found");
    // A cancellation intent never overwrites the committed winner or claims rollback.
    const status: Status = row.phase === "committed" ? "completed"
      : row.admission === "rejected" ? (row.reason === "predecessor_cancelled" ? "cancelled" : "failed")
      : row.phase === "uncertain" ? "uncertain"
      : row.receipt_id ? "cancellation_requested"
      : row.waiting ? "waiting" : row.phase === "started" ? "running" : "accepted";
    return {
      apiVersion: "1", conversationId: key.conversationId, requestId: key.requestId,
      acceptance: { boundary: "sql_admission_and_temporal_queue" }, status,
      ...(row.phase === "committed" ? { result: { text: row.reply! } } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.receipt_id ? { cancellation: {
        receiptId: row.receipt_id, delivery: row.delivered_at ? "delivered" as const : "pending" as const,
        nativeTermination: row.stopped ? "confirmed" as const : "unconfirmed" as const, effects: "not_assessed" as const,
      } } : {}),
    };
  }

  async cancel(input: unknown): Promise<RequestReceipt> {
    const key = keySchema.parse(input);
    // Backfill active legacy turns created after migration17, without inventing an
    // admission for an unknown UUID or accepting a new payload.
    await this.store.pool.query(`INSERT INTO birbcrew_ts.request_admissions(conversation_id,request_id,prompt_digest)
      SELECT t.conversation_id,t.request_id,t.prompt_digest FROM birbcrew_ts.turns t
      JOIN birbcrew_ts.conversations c USING(conversation_id)
      WHERE c.owner_id=$1 AND t.conversation_id=$2 AND t.request_id=$3
      ON CONFLICT(conversation_id,request_id) DO NOTHING`, [key.ownerId,key.conversationId,key.requestId]);
    // Atomic ownership check and FK admission requirement. Repeated intent has one receipt.
    await this.store.pool.query(`INSERT INTO birbcrew_ts.integration_cancellations(conversation_id,request_id)
      SELECT a.conversation_id,a.request_id FROM birbcrew_ts.request_admissions a
      JOIN birbcrew_ts.conversations c USING(conversation_id)
      WHERE c.owner_id=$1 AND a.conversation_id=$2 AND a.request_id=$3
      ON CONFLICT(conversation_id,request_id) DO NOTHING`, [key.ownerId,key.conversationId,key.requestId]);
    return this.status(key);
  }

  /** Restart-safe delivery outbox. Reads never call this; gateway invokes it on a timer. */
  async flushCancellations(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { rows } = await this.store.pool.query<Key>(`SELECT c.owner_id AS "ownerId",x.conversation_id AS "conversationId",x.request_id AS "requestId"
        FROM birbcrew_ts.integration_cancellations x JOIN birbcrew_ts.conversations c USING(conversation_id)
        WHERE x.delivered_at IS NULL ORDER BY x.last_attempt_at NULLS FIRST,x.requested_at LIMIT 64`);
      await Promise.all(rows.map(async key => {
        const id = `${key.conversationId}/${key.requestId}`;
        if (this.delivering.has(id)) return;
        this.delivering.add(id);
        try {
          await this.store.pool.query(`UPDATE birbcrew_ts.integration_cancellations SET last_attempt_at=clock_timestamp()
            WHERE conversation_id=$1 AND request_id=$2`, [key.conversationId,key.requestId]);
          const receipt = await this.status(key);
          if (!["completed", "failed", "cancelled"].includes(receipt.status)) await this.members.cancelPending(key, Date.now() + 10_000);
          await this.store.pool.query(`UPDATE birbcrew_ts.integration_cancellations SET delivered_at=COALESCE(delivered_at,clock_timestamp())
            WHERE conversation_id=$1 AND request_id=$2`, [key.conversationId,key.requestId]);
        } catch {
          // A failed/ambiguous delivery remains pending and is retried with the same identity.
        } finally { this.delivering.delete(id); }
      }));
    } finally { this.scanning = false; }
  }
}

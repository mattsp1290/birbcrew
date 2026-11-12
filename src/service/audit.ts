import type { PoolClient } from "pg";
import { z } from "zod";
import { nextStep, toolNameSchema } from "./deferral.ts";
import { engineSchema } from "./domain.ts";

const uuid = z.uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// Each key names one partial unique index in 021-audit.sql. A naming mismatch fails
// loudly, and unrelated conflicts (such as a primary key) still raise errors.
const requestFact = "(event_type, conversation_id, request_id) WHERE event_type IN ('request.accepted', 'request.cancellation_requested', 'request.finished')";

/** The closed audit vocabulary. 021-audit.sql repeats these types in a CHECK.
 * Payloads are strict: identifiers, digests, choices and statuses only, never
 * prompt/reply text, tool arguments or secrets. */
export const auditEvents = {
  "member.spawned": { actor: "owner", key: "(member_id) WHERE event_type = 'member.spawned'",
    payload: z.strictObject({ spawnRequestId: uuid, engine: engineSchema, profile: z.string().min(1) }) },
  "conversation.opened": { actor: "owner", key: "(conversation_id) WHERE event_type = 'conversation.opened'",
    payload: z.strictObject({}) },
  "request.accepted": { actor: "owner", key: requestFact, payload: z.strictObject({ promptDigest: sha256 }) },
  "approval.decided": { actor: "owner", key: "((payload->>'approvalId')) WHERE event_type = 'approval.decided'",
    payload: z.strictObject({
      approvalId: uuid, invocationId: uuid, toolName: toolNameSchema, argumentDigest: sha256,
      choice: z.enum(["approve", "deny", ...nextStep.options]),
    }) },
  "work_item.committed": { actor: "system", key: "((payload->>'receiptId')) WHERE event_type = 'work_item.committed'",
    payload: z.strictObject({ receiptId: uuid, approvalId: uuid }) },
  "request.cancellation_requested": { actor: "owner", key: requestFact, payload: z.strictObject({ receiptId: uuid.optional() }) },
  "request.finished": { actor: "system", key: requestFact, payload: z.strictObject({
    status: z.enum(["completed", "failed", "cancelled", "uncertain"]),
    reason: z.enum(["predecessor_failed", "predecessor_cancelled", "admission_unconfirmed"]).optional(),
  }) },
  "trusted_effect.completed": { actor: "system", key: "((payload->>'operationId')) WHERE event_type = 'trusted_effect.completed'",
    payload: z.strictObject({ operationId: uuid, toolName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }) },
} as const;
export type AuditEventType = keyof typeof auditEvents;
export const auditEventTypes = Object.keys(auditEvents) as AuditEventType[];

export interface AuditFact<T extends AuditEventType> {
  type: T; ownerId: string; memberId: string; conversationId?: string; requestId?: string;
  payload: z.input<(typeof auditEvents)[T]["payload"]>;
}

/** Call inside the transaction that commits the recorded fact, after that transaction
 * holds the conversation row (the foreign key below locks it), and as late as possible:
 * the insert holds a shared lock that audit reads wait for until commit. */
export async function appendAudit<T extends AuditEventType>(db: Pick<PoolClient, "query">, fact: AuditFact<T>) {
  const definition: { actor: "owner" | "system"; key: string; payload: z.ZodType } = auditEvents[fact.type];
  const payload = definition.payload.parse(fact.payload);
  await db.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,
      event_type,member_id,conversation_id,request_id,payload)
    VALUES ($1,$2,$3,'owner',$1,$4,$5,$6,$7,$8) ON CONFLICT ${definition.key} DO NOTHING`,
    [fact.ownerId, definition.actor, definition.actor === "owner" ? fact.ownerId : null, fact.type, fact.memberId,
      fact.conversationId ?? null, fact.requestId ?? null, JSON.stringify(payload)]);
}


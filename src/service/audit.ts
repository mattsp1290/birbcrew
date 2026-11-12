import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
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
 * holds the conversation row (the foreign key below locks it), and as late as possible.
 * Await nothing outside the database after it: the insert holds a shared lock that
 * every owner's audit reads wait for until commit. */
export async function appendAudit<T extends AuditEventType>(db: Pick<PoolClient, "query">, fact: AuditFact<T>) {
  const definition: { actor: "owner" | "system"; key: string; payload: z.ZodType } = auditEvents[fact.type];
  const payload = definition.payload.parse(fact.payload);
  await db.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,
      event_type,member_id,conversation_id,request_id,payload)
    VALUES ($1,$2,$3,'owner',$1,$4,$5,$6,$7,$8) ON CONFLICT ${definition.key} DO NOTHING`,
    [fact.ownerId, definition.actor, definition.actor === "owner" ? fact.ownerId : null, fact.type, fact.memberId,
      fact.conversationId ?? null, fact.requestId ?? null, JSON.stringify(payload)]);
}

// Same default for both formats, so a format change never changes which rows return.
export const auditLimits = { default: 100, json: 1000, csv: 10_000 } as const;

// Zod runs refinements even after a failed regex, so they must accept any input.
const auditParameters = {
  after: z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine(value => value.length < 19 || value <= "9223372036854775807").optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,4}$/).optional(),
  conversationId: z.uuid().transform(value => value.toLowerCase()).optional(),
  format: z.enum(["json", "csv"]).optional(),
};
// A strict object still accepts inherited names such as __proto__; callers check names too.
export const auditParameterNames: readonly string[] = Object.keys(auditParameters);
export const auditQuerySchema = z.strictObject(auditParameters)
  .refine(query => Number(query.limit ?? 1) <= auditLimits[query.format === "csv" ? "csv" : "json"], { path: ["limit"] })
  .transform(query => ({ after: query.after ?? "0", limit: query.limit ? Number(query.limit) : auditLimits.default,
    conversationId: query.conversationId ?? null, format: query.format ?? "json" }));
export type AuditQuery = z.output<typeof auditQuerySchema>;

export interface AuditEvent {
  eventId: string; occurredAt: string; type: AuditEventType;
  actor: { kind: "owner" | "system"; id: string | null };
  initiator: { kind: "owner"; id: string };
  memberId: string; conversationId: string | null; requestId: string | null;
  payload: Record<string, unknown>;
}

export const auditSettleWindowMs = 5_000;
/** An audited transaction stayed open for the whole read window. Retrying later is safe. */
export class AuditUnsettledError extends Error {
  constructor() { super("Audit writers did not settle"); this.name = "AuditUnsettledError"; }
}

// Identity values are allocated before commit, so a later ID can become visible first;
// paging past it would lose the earlier row forever. Inserts hold the shared lock taken
// by 021-audit.sql's statement trigger. Obtaining it exclusively proves every allocated
// ID has committed or rolled back, and this statement's snapshot predates the lock, so
// its maximum is a safe horizon. Polling with try-lock never queues ahead of writers.
// The lock is global, so one stalled writer makes every owner's read wait out the window.
// The backoff keeps those waiting readers from crowding the gateway's small pool.
async function stableHorizon(pool: Pool): Promise<string> {
  const deadline = Date.now() + auditSettleWindowMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    const { rows: [row] } = await pool.query<{ horizon: string | null }>(`SELECT CASE
      WHEN pg_try_advisory_xact_lock(hashtextextended('birbcrew_ts.audit_events', 0))
      THEN (SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events)::text END AS horizon`);
    if (row.horizon !== null) return row.horizon;
    if (Date.now() > deadline) throw new AuditUnsettledError();
    await delay(wait);
  }
}

/** Owner comes from authentication only. Another owner's conversation filter matches nothing. */
export async function readAudit(pool: Pool, ownerId: string, query: AuditQuery) {
  const horizon = await stableHorizon(pool);
  const { rows } = await pool.query<AuditEvent>(`SELECT event_id::text AS "eventId",
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", event_type AS type,
      json_build_object('kind', actor_kind, 'id', actor_id) AS actor,
      json_build_object('kind', initiator_kind, 'id', initiator_id) AS initiator,
      member_id AS "memberId", conversation_id AS "conversationId", request_id AS "requestId", payload
    FROM birbcrew_ts.audit_events
    WHERE owner_id=$1 AND event_id>$2 AND event_id<=$3 AND ($4::uuid IS NULL OR conversation_id=$4)
    ORDER BY event_id LIMIT $5`, [ownerId, query.after, horizon, query.conversationId, query.limit + 1]);
  const events = rows.slice(0, query.limit);
  return { events, nextAfter: events.at(-1)?.eventId ?? query.after, hasMore: rows.length > query.limit };
}

const csvColumns = ["eventId", "occurredAt", "type", "actorKind", "actorId", "initiatorKind", "initiatorId",
  "memberId", "conversationId", "requestId", "payload"];
// Spreadsheets run a cell that starts with = + - @ tab or CR as a formula; owner IDs are
// free text. Prefixing ' keeps such a cell inert. A leading ' gets one too, so a reader
// recovers every value exactly by dropping one leading '.
function csvCell(value: string | null) {
  if (value === null) return "";
  const inert = /^[=+\-@\t\r']/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(inert) ? `"${inert.replaceAll('"', '""')}"` : inert;
}
export function auditCsv(events: AuditEvent[]) {
  const lines = [csvColumns.join(",")];
  for (const event of events) {
    lines.push([event.eventId, event.occurredAt, event.type, event.actor.kind, event.actor.id, event.initiator.kind,
      event.initiator.id, event.memberId, event.conversationId, event.requestId, JSON.stringify(event.payload)].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

import { z } from "zod";

/** Shared validation source for the portable client and the Crew server. */
export const engineSchema = z.enum(["pi", "claude", "codex"]);
export function boundedText(bytes: number) {
  return z.string().min(1).refine(text => !text.includes("\0") && text.isWellFormed()
    && new TextEncoder().encode(text).length <= bytes,
  { message: `Expected valid UTF-8 text of at most ${bytes} bytes` }).meta({ "x-maxUtf8Bytes": bytes, "x-forbidden": "NUL; unpaired surrogates" });
}
const disallowedControl = /(?![\t\n])\p{Cc}/u;
/** Owner-authored model context in memories, member instructions and instruction packs. */
export function ownerText(bytes: number) {
  return z.string().min(1).refine(text => text.isWellFormed() && !disallowedControl.test(text)
    && new TextEncoder().encode(text).length <= bytes,
  { message: `Expected well-formed UTF-8 text of at most ${bytes} bytes without control characters other than tab and newline` })
    .meta({ "x-maxUtf8Bytes": bytes, "x-controlCharacters": "Only tab and newline allowed" });
}
export const uuid = z.uuid().overwrite(value => value.toLowerCase());
/** Must match the body CHECK in src/service/sql/029-member-instructions.sql. */
export const instructionsBytes = 16_384;
/** Owner, CLI and routine prompt bound. Reserved handoff requests use the server turnTextBytes bound. */
export const promptBytes = 16_384;
/** Must match the position CHECK in src/service/sql/033-instruction-packs.sql. */
export const instructionPacksPerMember = 8;
const instructionPackIds = z.array(uuid).min(1).max(instructionPacksPerMember).refine(ids => new Set(ids).size === ids.length)
  .meta({ uniqueItems: true, description: "Instruction pack UUIDs in model reading order, each once." });
/** Must match src/service/sql/028-approval-expiry.sql. Omission leaves cards without this deadline. */
export const approvalDeadline = { minimumSeconds: 60, maximumSeconds: 604_800 } as const;
export const approvalDeadlineSeconds = z.int().min(approvalDeadline.minimumSeconds).max(approvalDeadline.maximumSeconds);
export const createMemberSchema = z.strictObject({ requestId: uuid, engine: engineSchema,
  profile: boundedText(128), instructions: ownerText(instructionsBytes).optional(), instructionPacks: instructionPackIds.optional() });
export const conversationIdentitySchema = z.strictObject({ conversationId: uuid });
export const openConversationSchema = conversationIdentitySchema.extend({ memberId: uuid });
export const requestIdentitySchema = conversationIdentitySchema.extend({ requestId: uuid });
export const submitRequestSchema = requestIdentitySchema.extend({ text: boundedText(promptBytes), approvalDeadlineSeconds: approvalDeadlineSeconds.optional() });
/** New accepted kinds require a case in server initiatorColumns and migrations widening
 * request_admissions_initiator_kind_check and audit_events_initiator_check. Owner has no id.
 * Routine and handoff ids are authorized by their reserved server rows, never by caller input. */
export const requestInitiator = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("routine"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("handoff"), id: z.uuid() }),
]);
export const nextStep = z.enum(["inspect", "test"]);
/** Offered only in standingChoices, never in the ordinary card choices array. */
export const standingChoice = z.enum(["allow_conversation", "allow_always"]);
export const decisionChoice = z.enum(["approve", "deny", ...nextStep.options, ...standingChoice.options]);
export const decideSchema = requestIdentitySchema.extend({ memberId: uuid, invocationId: uuid, approvalId: uuid, version: z.int(), choice: decisionChoice });
export const decisionReceiptSchema = z.object({ approvalId: z.uuid(), decision: decisionChoice });
const result = z.object({ text: z.string() });
const receiptBase = z.object({
  apiVersion: z.literal("1"), conversationId: z.uuid(), requestId: z.uuid(),
  acceptance: z.object({ boundary: z.literal("sql_admission_and_temporal_queue") }),
  initiator: requestInitiator.optional(), result: result.optional(), reason: z.string().optional(),
  cancellation: z.object({ receiptId: z.uuid(), delivery: z.enum(["pending", "delivered"]),
    nativeTermination: z.enum(["confirmed", "unconfirmed"]), effects: z.literal("not_assessed") }).optional(),
  approvalDeadlineSeconds: approvalDeadlineSeconds.optional(),
  expiredApproval: z.object({ approvalId: z.uuid(), expiresAt: z.iso.datetime(), expiredAt: z.iso.datetime() }).optional(),
});
export const requestReceiptSchema = z.discriminatedUnion("status", [
  receiptBase.extend({ status: z.literal("completed"), result }),
  receiptBase.extend({ status: z.enum(["accepted", "waiting", "running", "cancellation_requested", "cancelled", "failed", "uncertain"]) }),
]);
/** Response-only initiators accept additive fields and new kinds without changing server admission. */
export const observedRequestInitiatorSchema = z.union([
  requestInitiator.options[0].loose(), requestInitiator.options[1].loose(), requestInitiator.options[2].loose(),
  z.looseObject({ kind: z.string().min(1).refine(kind => !requestInitiator.options.some(option => option.shape.kind.value === kind)).meta({ not: { enum: requestInitiator.options.map(option => option.shape.kind.value) } }), id: z.string().optional() }),
]);
const observedReceiptBase = receiptBase.extend({ initiator: observedRequestInitiatorSchema.optional() });
export const requestReceiptResponseSchema = z.discriminatedUnion("status", [
  observedReceiptBase.extend({ status: z.literal("completed"), result }),
  observedReceiptBase.extend({ status: z.enum(["accepted", "waiting", "running", "cancellation_requested", "cancelled", "failed", "uncertain"]) }),
]);
export const instructionsSummarySchema = z.object({ bytes: z.int().nonnegative(), digest: z.string().regex(/^[0-9a-f]{64}$/) });
export const memberSchema = z.object({ memberId: z.uuid(), engine: engineSchema, profile: z.string(), instructions: instructionsSummarySchema.optional(), instructionPacks: instructionPackIds.optional() });
export const listMembersSchema = z.strictObject({ limit: z.int().min(1).max(100).optional(), after: z.string().max(128).optional() });
export const memberPageSchema = z.object({ apiVersion: z.literal("1"), members: z.array(memberSchema), next: z.string().nullable() });
export const conversationStateSchema = z.object({ conversationId: z.uuid(), memberId: z.uuid(), engine: engineSchema,
  profile: z.string(), phase: z.enum(["idle", "running", "waiting", "complete", "cancelled", "failed"]) });
export const conversationSnapshotSchema = conversationStateSchema.extend({ cursor: z.int().nonnegative() });
export const snapshotWireSchema = z.object({ cursor: z.int().nonnegative(), state: conversationStateSchema,
  messages: z.array(z.json()), openTools: z.record(z.string(), z.json()), openText: z.json(), childText: z.record(z.string(), z.json()) });
export const capabilitiesSchema = z.looseObject({ apiVersion: z.literal("1"), requestContract: z.literal("sql-admission-temporal-queue-v1"),
  observation: z.looseObject({ protocol: z.literal("AG-UI"), mode: z.literal("snapshot-and-bounded-tail") }), initiatorKinds: z.array(z.string().min(1)) });
const dependencyStatus = z.enum(["ready", "unavailable"]);
export const healthSchema = z.object({ apiVersion: z.literal("1"), status: z.enum(["ready", "not_ready"]),
  dependencies: z.object({ database: z.object({ status: dependencyStatus, schemaVersion: z.int().nullable() }), temporal: z.object({ status: dependencyStatus }) }) });
export const errorSchema = z.object({ error: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/) });
export type Engine = z.infer<typeof engineSchema>;
export type CreateMember = z.input<typeof createMemberSchema>;
export type OpenConversation = z.input<typeof openConversationSchema>;
export type SubmitRequest = z.input<typeof submitRequestSchema>;
export type RequestIdentity = z.infer<typeof requestIdentitySchema>;
export type RequestInitiator = z.infer<typeof requestInitiator>;
export type ObservedRequestInitiator = z.infer<typeof observedRequestInitiatorSchema>;
export type ObservedRequestReceipt = z.infer<typeof requestReceiptResponseSchema>;
/** Strict server output and command-authoring contract. The client root RequestReceipt alias is observed. */
export type RequestReceipt = z.infer<typeof requestReceiptSchema>;
export type Member = z.infer<typeof memberSchema>;
export type MemberPage = z.infer<typeof memberPageSchema>;
export type Decide = z.input<typeof decideSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Health = z.infer<typeof healthSchema>;

export const routes = {
  capabilities: { method: "GET", path: "/v1/capabilities", response: capabilitiesSchema, status: 200 },
  health: { method: "GET", path: "/v1/health", response: healthSchema, status: 200 },
  listMembers: { method: "GET", path: "/v1/members", response: memberPageSchema, query: listMembersSchema, status: 200 },
  createMember: { method: "POST", path: "/v1/members", body: createMemberSchema, response: memberSchema, status: 201 },
  openConversation: { method: "POST", path: "/v1/conversations", body: openConversationSchema, response: snapshotWireSchema, status: 201 },
  conversation: { method: "GET", path: "/v1/conversations/{conversationId}", response: snapshotWireSchema, status: 200 },
  submit: { method: "POST", path: "/v1/conversations/{conversationId}/requests", body: submitRequestSchema.omit({ conversationId: true }), response: requestReceiptResponseSchema, status: 202 },
  requestStatus: { method: "GET", path: "/v1/conversations/{conversationId}/requests/{requestId}", response: requestReceiptResponseSchema, status: 200 },
  cancel: { method: "POST", path: "/v1/conversations/{conversationId}/requests/{requestId}/cancel", body: z.strictObject({}), response: requestReceiptResponseSchema, status: 202 },
  decide: { method: "POST", path: "/v1/conversations/{conversationId}/human", body: decideSchema.omit({ conversationId: true }), response: decisionReceiptSchema, status: 200 },
} as const;
export const observerPath = "/v1/conversations/{conversationId}/events";

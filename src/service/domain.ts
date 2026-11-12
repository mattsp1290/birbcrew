import type { ChildOutcome } from "@birbcrew/pi-subagents";
import type { ChildKey } from "./children.ts";
import type { Approval } from "./approvals.ts";
import { z } from "zod";

export const engineSchema = z.enum(["pi", "claude", "codex"]);
export type Engine = z.infer<typeof engineSchema>;

function boundedText(bytes: number) {
  return z.string().min(1).refine(
    (text) => !text.includes("\0") && text.isWellFormed()
      && new TextEncoder().encode(text).length <= bytes,
    { message: `Expected valid UTF-8 text of at most ${bytes} bytes` },
  );
}

// \p{Cc} is C0, DEL and C1. Tab and newline are the only control characters owner text may hold.
const disallowedControl = /(?![\t\n])\p{Cc}/u;
/** Text an owner writes for a model to read: member memory (memories.ts) and member instructions. */
export function ownerText(bytes: number) {
  return z.string().min(1).refine(text => text.isWellFormed() && !disallowedControl.test(text) && Buffer.byteLength(text) <= bytes,
    { message: `Expected well-formed UTF-8 text of at most ${bytes} bytes without control characters other than tab and newline` });
}
/** The most UTF-8 bytes of member instructions (docs/member-instructions.md); the body CHECK in
 * 029-member-instructions.sql repeats it. */
export const instructionsBytes = 16_384;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const ownerId = boundedText(256);
const profile = boundedText(128);

export const spawnSchema = z.strictObject({
  ownerId, requestId: uuid, engine: engineSchema, profile, instructions: ownerText(instructionsBytes).optional(),
});
export const conversationKey = z.strictObject({ ownerId, conversationId: uuid });
export const openSchema = conversationKey.extend({ memberId: uuid });
export const turnKey = conversationKey.extend({ requestId: uuid });
/** The prompt bound for every request an owner, the CLI or a routine submits. */
export const promptBytes = 16_384;
/** The bound on every internal path from MemberClient to the engine. Only a conversation
 * handoff's first request may use more than promptBytes: admission allows it only for the
 * request a handoff row reserved (handoffs.ts), never on a caller's say-so. */
export const turnTextBytes = 65_536;
/** How long a Claude or Pi card of the request may wait for a decision (docs/approval-expiry.md).
 * 028-approval-expiry.sql repeats the bounds. Absent, a card waits until someone answers it. */
export const approvalDeadline = { minimumSeconds: 60, maximumSeconds: 604_800 } as const;
export const approvalDeadlineSeconds = z.int().min(approvalDeadline.minimumSeconds).max(approvalDeadline.maximumSeconds);
export const submitSchema = turnKey.extend({ text: boundedText(promptBytes), approvalDeadlineSeconds: approvalDeadlineSeconds.optional() });
export const turnRequestSchema = submitSchema.extend({ text: boundedText(turnTextBytes) });
export const executionSchema = z.strictObject({
  workflowRunId: boundedText(256),
  activityId: boundedText(256),
  attempt: z.number().int().min(1).max(2_147_483_647),
});
export type TurnRequest = z.infer<typeof submitSchema>;
export const claimSchema = turnKey.extend({ token: uuid });

export const checkpointSchema = z.strictObject({
  version: z.literal(1),
  engine: engineSchema,
  state: z.json(),
}).refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 4 * 1024 * 1024, "Checkpoint exceeds 4 MiB");

export const commitSchema = claimSchema.extend({ reply: boundedText(65_536), checkpoint: checkpointSchema });

/** What started a request, recorded once with its durable admission. The closed set of kinds:
 * a later kind is a new member here, a case in initiatorColumns, and a migration widening
 * request_admissions_initiator_kind_check and audit_events_initiator_check. The owner carries
 * no id because the conversation's owner_id already names them. A routine is named by its id;
 * only its firing row can make an admission record it (025-routines.sql). A handoff is named by
 * its id; only its own row can make an admission record it, for the one request it reserved
 * (027-handoffs.sql). */
export const requestInitiator = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("routine"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("handoff"), id: z.uuid() }),
]);
export type RequestInitiator = z.infer<typeof requestInitiator>;
export const initiatorKinds = requestInitiator.options.map(option => option.shape.kind.value);
export const ownerInitiator: RequestInitiator = Object.freeze({ kind: "owner" });

/** The (initiator_kind, initiator_id) pair stored in request_admissions. */
export function initiatorColumns(initiator: RequestInitiator): [kind: RequestInitiator["kind"], id: string | null] {
  switch (initiator.kind) {
    case "owner": return ["owner", null];
    case "routine": return ["routine", initiator.id];
    case "handoff": return ["handoff", initiator.id];
  }
}

/** A stored kind this release does not know (after a rollback) is a server fault, never invalid input. */
export function initiatorFromColumns(kind: string, id: string | null): RequestInitiator {
  const initiator = requestInitiator.safeParse(id === null ? { kind } : { kind, id });
  if (!initiator.success) throw new Error("Unknown request initiator");
  return initiator.data;
}

export type Member = Pick<z.infer<typeof spawnSchema>, "ownerId" | "engine" | "profile"> & { memberId: string };
export type Conversation = Member & { conversationId: string };
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type BeginTurn =
  | { kind: "start"; conversation: Conversation; token: string; checkpoint: Checkpoint | null; childResults?: ChildOutcome[] }
  | { kind: "pending"; approval: Approval }
  | { kind: "delegated"; children: ChildKey[] }
  | { kind: "replay"; reply: string }
  | { kind: "uncertain" };

export class MemberStoreError extends Error {
  readonly code: "not_found" | "conflict" | "busy" | "stale" | "input_limit" | "history_unavailable" | "request_rejected"
    | "routine_limit" | "routine_deleted" | "memory_limit" | "memory_deleted" | "instructions_limit"
    | "handed_off" | "handoff_pending" | "handoff_empty" | "handoff_too_large" | "trusted_conversation";

  constructor(code: MemberStoreError["code"]) {
    super(code);
    this.name = "MemberStoreError";
    this.code = code;
  }
}

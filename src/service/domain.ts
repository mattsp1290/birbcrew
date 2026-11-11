import type { ChildOutcome } from "@birbcrew/pi-subagents";
import type { ChildKey } from "./children.ts";
import type { Approval } from "./approvals.ts";
import { z } from "zod";

export const engineSchema = z.enum(["pi", "claude"]);
export type Engine = z.infer<typeof engineSchema>;

function boundedText(bytes: number) {
  return z.string().min(1).refine(
    (text) => !text.includes("\0") && text.isWellFormed()
      && new TextEncoder().encode(text).length <= bytes,
    { message: `Expected valid UTF-8 text of at most ${bytes} bytes` },
  );
}

const uuid = z.uuid().transform((value) => value.toLowerCase());
const ownerId = boundedText(256);
const profile = boundedText(128);

export const spawnSchema = z.strictObject({ ownerId, requestId: uuid, engine: engineSchema, profile });
export const conversationKey = z.strictObject({ ownerId, conversationId: uuid });
export const openSchema = conversationKey.extend({ memberId: uuid });
export const turnKey = conversationKey.extend({ requestId: uuid });
export const submitSchema = turnKey.extend({ text: boundedText(16_384) });
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
  readonly code: "not_found" | "conflict" | "busy" | "stale" | "input_limit" | "history_unavailable";

  constructor(code: MemberStoreError["code"]) {
    super(code);
    this.name = "MemberStoreError";
    this.code = code;
  }
}

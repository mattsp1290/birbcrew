import type { Delegation } from "@birbcrew/pi-subagents";
import { z } from "zod";
import { engineSchema, spawnSchema } from "./domain.ts";

/** Where a delegated child runs: the engine and registered profile whose activity queue and
 * driver execute it. It is stored as `target` in the child row's role_profile JSON. A row
 * without one runs on its parent's Pi profile, as every child did before targets existed. */
export const childTargetSchema = z.strictObject({ engine: engineSchema, profile: spawnSchema.shape.profile });
export type ChildTarget = z.infer<typeof childTargetSchema>;
/** A child's stored role profile. */
export type ChildProfile = Delegation["profile"] & { target?: ChildTarget };

/** Why a child target was refused. Only a registered delegating Pi profile can be a target until
 * the other engines have child drivers, so a Claude or Codex target is unsupported. */
export class ChildTargetError extends Error {
  readonly code: "invalid_target" | "unsupported_engine" | "unregistered_target";
  constructor(code: ChildTargetError["code"]) {
    super(`Child target refused: ${code}`);
    this.name = "ChildTargetError";
    this.code = code;
  }
}

/** The (engine, profile) a child runs on. */
export function childTarget(target: ChildTarget | undefined, parentProfile: string): ChildTarget {
  return target ?? { engine: "pi", profile: parentProfile };
}

/** Reads a target stored in a child row (null or absent when the child has none). */
export function storedTarget(value: unknown): ChildTarget | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = childTargetSchema.safeParse(value);
  if (!parsed.success) throw new ChildTargetError("invalid_target");
  return parsed.data;
}

import type { Delegation } from "@birbcrew/pi-subagents";
import { z } from "zod";
import { engineSchema, spawnSchema, type Engine } from "./domain.ts";

/** Where a delegated child runs: the engine and registered profile whose activity queue and
 * driver execute it. It is stored as `target` in the child row's role_profile JSON. A row
 * without one runs on its parent's Pi profile, as every child did before targets existed.
 * This module owns the rules for reading a target. The one reader outside it is the usage
 * ledger's insert (usage.ts), which takes the engine in SQL from `role_profile->'target'`. */
export const childTargetSchema = z.strictObject({ engine: engineSchema, profile: spawnSchema.shape.profile });
export type ChildTarget = z.infer<typeof childTargetSchema>;
/** A child's stored role profile. */
export type ChildProfile = Delegation["profile"] & { target?: ChildTarget };

/** Why a child target was refused. Until the other engines have child drivers, a target must be a
 * registered delegating Pi profile that holds every tool its child gets, as its parent must. Its
 * driver also requires the child's pinned model, always the parent's, to be its own; the profiles
 * table has no model column, so only a launch checks that. */
export class ChildTargetError extends Error {
  readonly code: "invalid_target" | "unsupported_engine" | "ineligible_target";
  constructor(code: ChildTargetError["code"]) {
    super(`Child target refused: ${code}`);
    this.name = "ChildTargetError";
    this.code = code;
  }
}

/** Only Pi has a child driver so far (profiles.ts). */
export function hasChildDriver(engine: Engine) {
  return engine === "pi";
}

/** The (engine, profile) a child runs on. */
export function childTarget(target: ChildTarget | undefined, parentProfile: string): ChildTarget {
  return target ?? { engine: "pi", profile: parentProfile };
}

function parsedTarget(value: unknown): ChildTarget {
  const parsed = childTargetSchema.safeParse(value);
  if (!parsed.success) throw new ChildTargetError("invalid_target");
  return parsed.data;
}

/** Reads a target stored in a child row (null or absent when the child has none). */
export function storedTarget(value: unknown): ChildTarget | undefined {
  return value === null || value === undefined ? undefined : parsedTarget(value);
}

/** The target a ChildKey carries. One this release cannot read is left off, so it never fails the
 * parent turn: the child's own activity reads its row and refuses it (ChildStore.target). */
export function keyTarget(value: unknown): ChildTarget | undefined {
  return childTargetSchema.safeParse(value).data;
}

/** A delegation's proposed target, refused before anything is written. Absent, the child runs on its
 * parent's profile. */
export function proposedTarget(value: unknown): ChildTarget | undefined {
  if (value === undefined) return undefined;
  const target = parsedTarget(value);
  if (!hasChildDriver(target.engine)) throw new ChildTargetError("unsupported_engine");
  return target;
}

/** Whether a profile holding this protected tool (if any) holds every tool the child gets. */
export function holdsChildTools(protectedTool: string | null | undefined, child: Pick<ChildProfile, "tools">) {
  return child.tools.every(tool => tool === protectedTool);
}

/** Whether a profile can run a child: it delegates and holds every tool the child gets. The Pi driver
 * applies this at launch (profiles.ts), and ChildStore.delegate applies it to a target before writing.
 * A launch also requires the child's pinned model, which the profiles table cannot show. */
export function runsChild(profile: { delegateTask: boolean; protectedTool?: string | null }, child: Pick<ChildProfile, "tools">) {
  return profile.delegateTask && holdsChildTools(profile.protectedTool, child);
}

import { runPiTurn, runPiSegment } from "./pi.ts";
import { runClaudeTurn, runClaudeSegment } from "./claude.ts";
import type { MemberProfiles, TurnDriver } from "./activities.ts";
import type { Engine } from "./domain.ts";

export interface MemberProfile {
  accountId: string;
  protectedTool?: "record_work_item";
  pi?: Parameters<typeof runPiTurn>[1];
  claude?: Omit<Parameters<typeof runClaudeTurn>[1], "ownerId" | "memberId" | "stateDir" | "invocationGroup">;
}

export function memberProfiles(config: ReadonlyMap<string, MemberProfile>, stateDir: string, invocationGroup?: number): MemberProfiles {
  const profiles = new Map<string, Partial<Record<Engine, TurnDriver>>>();
  for (const [name, { pi, claude, protectedTool }] of config) {
    const drivers: Partial<Record<Engine, TurnDriver>> = {};
    if (pi) drivers.pi = async (input) => protectedTool ? runPiSegment(input, pi) :
      { kind: "complete", ...await runPiTurn(input, pi) };
    if (claude) drivers.claude = async (input, { ownerId, memberId }) => {
      const options = { ...claude, ownerId, memberId, stateDir, invocationGroup };
      return protectedTool ? runClaudeSegment(input, options) : { kind: "complete", ...await runClaudeTurn(input, options) };
    };
    profiles.set(name, drivers);
  }
  return profiles;
}

import { runPiTurn } from "./pi.ts";
import { runClaudeTurn } from "./claude.ts";
import type { MemberProfiles, TurnDriver } from "./activities.ts";
import type { Engine } from "./domain.ts";

export interface MemberProfile {
  accountId: string;
  pi?: Parameters<typeof runPiTurn>[1];
  claude?: Omit<Parameters<typeof runClaudeTurn>[1], "ownerId" | "memberId" | "stateDir">;
}

export function memberProfiles(config: ReadonlyMap<string, MemberProfile>, stateDir: string): MemberProfiles {
  const profiles = new Map<string, Partial<Record<Engine, TurnDriver>>>();
  for (const [name, { pi, claude }] of config) {
    const drivers: Partial<Record<Engine, TurnDriver>> = {};
    if (pi) drivers.pi = (input) => runPiTurn(input, pi);
    if (claude) drivers.claude = (input, { ownerId, memberId }) =>
      runClaudeTurn(input, { ...claude, ownerId, memberId, stateDir });
    profiles.set(name, drivers);
  }
  return profiles;
}

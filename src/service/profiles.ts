import { runPiTurn, runPiSegment, runPiDelegatingSegment } from "./pi.ts";
import { runClaudeTurn, runClaudeSegment } from "./claude.ts";
import type { MemberProfiles, TurnDriver } from "./activities.ts";
import type { Engine } from "./domain.ts";

export interface MemberProfile {
  accountId: string;
  delegateTask?: true;
  protectedTool?: "record_work_item";
  pi?: Parameters<typeof runPiTurn>[1];
  claude?: Omit<Parameters<typeof runClaudeTurn>[1], "ownerId" | "memberId" | "stateDir" | "invocationGroup">;
}

export function memberProfiles(config: ReadonlyMap<string, MemberProfile>, stateDir: string, invocationGroup?: number): MemberProfiles {
  const profiles = new Map<string, Partial<Record<Engine, TurnDriver>>>();
  for (const [name, { pi, claude, protectedTool, delegateTask }] of config) {
    const drivers: Partial<Record<Engine, TurnDriver>> = {};
    if (pi) drivers.pi = async (input) => {
      if (input.childProfile) {
        const child = input.childProfile;
        if (!delegateTask || child.model !== pi.model.id || (child.tools.length && !protectedTool)) {
          throw new Error("Child profile differs from member");
        }
        const options = { ...pi, instructions: child.instructions };
        return child.tools.includes("record_work_item") ? runPiSegment(input, options) :
          { kind: "complete", ...await runPiTurn(input, options) };
      }
      if (delegateTask) return runPiDelegatingSegment(input, { ...pi, allowRecordWorkItem: !!protectedTool });
      return protectedTool ? runPiSegment(input, pi) : { kind: "complete", ...await runPiTurn(input, pi) };
    };
    if (claude) drivers.claude = async (input, { ownerId, memberId }) => {
      const options = { ...claude, ownerId, memberId, stateDir, invocationGroup };
      return protectedTool ? runClaudeSegment(input, options) : { kind: "complete", ...await runClaudeTurn(input, options) };
    };
    profiles.set(name, drivers);
  }
  return profiles;
}

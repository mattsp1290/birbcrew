import { MemberStore } from "./store.ts";
import { runLiveTool } from "./codex-live.ts";
import { trustedProjectContext } from "./project-notes.ts";
import { withNativeAdmission } from "./native-admission.ts";
import type { Launch } from "./supervisor.ts";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { registerProfiles } from "./deployment.ts";
import { memberProfiles } from "./profiles.ts";
import type { DriverInput } from "./activities.ts";
import type { Conversation, Checkpoint } from "./domain.ts";

interface AdmittedTurn {
  launch: Launch;
  conversation: Conversation;
  runId: string;
  threadId: string;
  childProfile?: DriverInput["childProfile"];
  childResults?: DriverInput["childResults"];
  text: string;
  checkpoint: Checkpoint | null;
  continuation?: DriverInput["continuation"];
}

const controller = new AbortController();
process.once("disconnect", () => process.exit(1));
process.on("message", (message) => {
  if (message === "stop") controller.abort();
});
process.once("message", async (command: AdmittedTurn) => {
  const [configPath, stateDir] = process.argv.slice(2);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL });
  let reply;
  try {
    const { profiles, close } = await import(pathToFileURL(configPath).href);
    try {
      await registerProfiles(pool, profiles, stateDir);
      const member = command.conversation;
      const driver = memberProfiles(profiles, stateDir, process.pid).get(member.profile)?.[member.engine];
      if (!driver) throw new Error("Unsupported member profile");
      const projectContext = command.childProfile ? undefined : await trustedProjectContext(pool, member);
      const profile = profiles.get(member.profile);
      const tool = profile?.protectedTool ?? profile?.humanTool;
      const store = new MemberStore(pool);
      let nextItem = 0;
      reply = await withNativeAdmission(pool,command.launch,AbortSignal.any([controller.signal,AbortSignal.timeout(170_000)]), signal => {
        const input: DriverInput = {
        ...(projectContext && { projectContext }),
        ...(command.childProfile && {childProfile: command.childProfile}),
        ...(command.childResults && {childResults: command.childResults}),
        threadId: command.threadId, runId: command.runId, text: command.text,
        onToolArgs: (toolArgs, matchedOperation) => process.send?.({ toolArgs, matchedOperation }),
        onText: member.engine === "codex"
          ? text => store.appendCodexItem(command.launch, nextItem++, text)
          : delta => { process.send?.({ delta }); },
        checkpoint: command.checkpoint, continuation: command.continuation, signal,
        };
        return member.engine === "codex" && tool
          ? runLiveTool(pool, command.launch, member, tool, input, value => driver(value, member))
          : driver(input, member);
      });
    } finally {
      await close?.();
    }
  } catch {
    reply = { error: "Native SDK turn failed" };
  } finally {
    await pool.end();
  }
  if (process.connected) process.send?.(reply, () => process.exit(0));
});

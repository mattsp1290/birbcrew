import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { registerProfiles } from "./deployment.ts";
import { memberProfiles } from "./profiles.ts";
import type { DriverInput } from "./activities.ts";
import type { Conversation, Checkpoint } from "./domain.ts";

interface AdmittedTurn {
  conversation: Conversation;
  runId: string;
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
      const driver = memberProfiles(profiles, stateDir).get(member.profile)?.[member.engine];
      if (!driver) throw new Error("Unsupported member profile");
      reply = await driver({
        threadId: member.conversationId, runId: command.runId, text: command.text,
        checkpoint: command.checkpoint, continuation: command.continuation, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(170_000)]),
      }, member);
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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { ClaudeAgentAdapter, type SessionBinding } from "@ag-ui/claude-agent-sdk";
import { getSessionMessages, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeCheckpoint, claudeCommand } from "./claude.ts";

const profile = "claude-chat-v1";
const cwd = process.cwd();
const controller = new AbortController();
class ClaudeTurnError extends Error {}

async function digest(sessionId: string) {
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  if (messages.at(-1)?.type !== "assistant") throw new ClaudeTurnError("Claude recovery failed: original transcript is missing or incomplete");
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

async function run(command: z.infer<typeof claudeCommand>) {
  let binding: SessionBinding | undefined = command.checkpoint?.state.binding;
  if (binding) {
    const saved = JSON.parse(await readFile("binding.json", "utf8"));
    if (saved.sessionId !== binding.sessionId || saved.profile !== profile ||
        binding.profile !== profile || await digest(binding.sessionId) !== command.checkpoint?.state.transcriptDigest) {
      throw new ClaudeTurnError("Claude recovery failed: original transcript does not match its checkpoint");
    }
  }
  let exited: Promise<void> | undefined;
  const options: Options = {
    cwd,
    spawnClaudeCodeProcess({ command, args, env, signal }) {
      const launcher = fileURLToPath(new URL("./claude-launch.py", import.meta.url));
      const cli = spawn("/usr/bin/python3", ["-I", launcher, String(process.pid), command, ...args], {
        cwd, env, signal, stdio: ["pipe", "pipe", "ignore"],
      });
      exited = new Promise<void>((resolve) => cli.once("close", () => resolve()));
      return cli;
    },
    model: command.model,
    env: process.env,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    settingSources: [],
    permissionMode: "dontAsk",
    maxTurns: 1,
  };
  const adapter = new ClaudeAgentAdapter({
    abortController: controller,
    sessionRecovery: {
      profile,
      resolveProfile: async () => options,
      store: {
        load: async () => binding,
        async save(_, value) {
          const confirmed = claudeCheckpoint.shape.state.shape.binding.parse(value);
          if (confirmed.profile !== profile || (binding && binding.sessionId !== confirmed.sessionId)) {
            throw new ClaudeTurnError("Claude session identity changed");
          }
          await writeFile("binding.tmp", JSON.stringify(confirmed), { mode: 0o600, flush: true });
          await rename("binding.tmp", "binding.json");
          binding = confirmed;
        },
      },
    },
  });
  let text = "";
  let finished = false;
  const textEvent = z.object({ delta: z.string() });
  const terminal = z.object({ outcome: z.object({
    type: z.literal("success"),
    pendingToolCallIds: z.array(z.string()).max(0).optional(),
  }).optional() });
  await adapter.run({
    threadId: command.threadId, runId: command.runId,
    messages: [{ role: "user", id: command.runId, content: command.text }],
    tools: [], context: [], state: null, forwardedProps: {},
  }).forEach((event) => {
    if (finished) throw new Error("Unexpected event after Claude terminal");
    if (event.type === "RUN_ERROR") throw new ClaudeTurnError("Claude SDK run failed");
    if (event.type === "TEXT_MESSAGE_CONTENT") {
      text += textEvent.parse(event).delta;
      if (Buffer.byteLength(text) > 65_536) throw new ClaudeTurnError("Claude response exceeded size limit");
    }
    if (event.type === "RUN_FINISHED") {
      terminal.parse(event);
      finished = true;
    }
  });
  await exited;
  if (!finished || !binding || !text.length) throw new ClaudeTurnError("Claude turn did not settle");
  const checkpoint = claudeCheckpoint.parse({
    version: 1, engine: "claude",
    state: { threadId: command.threadId, model: command.model, binding, transcriptDigest: await digest(binding.sessionId) },
  });
  return { text, checkpoint };
}

// The adapter owns a detached process group. Losing the host revokes that entire turn.
const hostLost = () => process.kill(-process.pid, "SIGKILL");
process.once("disconnect", hostLost);
process.once("message", async (payload) => {
  let reply;
  try {
    reply = await run(claudeCommand.parse(payload));
  } catch (error) {
    controller.abort();
    reply = { error: error instanceof ClaudeTurnError ? error.message : "Claude turn or native session recovery failed" };
  }
  if (process.connected) process.send?.(reply, () => {
    process.removeListener("disconnect", hostLost);
    process.disconnect();
  });
});

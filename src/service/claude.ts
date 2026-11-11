import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const binding = z.strictObject({ profile: z.string(), sessionId: z.uuid() });

export const claudeCheckpoint = z.strictObject({
  version: z.literal(1),
  engine: z.literal("claude"),
  state: z.strictObject({
    threadId: z.uuid(),
    model: z.string(),
    binding,
    transcriptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export const claudeCommand = z.strictObject({
  threadId: z.uuid(),
  runId: z.uuid(),
  text: z.string().min(1).max(16_384),
  model: z.string().min(1),
  checkpoint: claudeCheckpoint.nullable(),
});

const success = z.strictObject({ text: z.string().min(1).max(65_536), checkpoint: claudeCheckpoint });
const response = z.union([success, z.strictObject({ error: z.string() })]);

interface ClaudeProfile {
  stateDir: string;
  memberId: string;
  ownerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  authorize?: () => Promise<void>;
}

export async function runClaudeTurn(
  input: { threadId: string; runId: string; text: string; checkpoint: unknown; signal: AbortSignal },
  profile: ClaudeProfile,
): Promise<z.infer<typeof success>> {
  const { signal, ...turn } = input;
  signal.throwIfAborted();
  await profile.authorize?.();
  signal.throwIfAborted();
  const command = claudeCommand.parse({ ...turn, model: profile.model });
  if (!isAbsolute(profile.stateDir)) throw new Error("Claude state directory must be absolute");
  const member = z.uuid().parse(profile.memberId);
  const owner = createHash("sha256").update(profile.ownerId).digest("hex");
  if (!command.checkpoint) await mkdir(profile.stateDir, { recursive: true, mode: 0o700 });
  const parent = join(await realpath(profile.stateDir), "claude", owner, member);
  const cwd = join(parent, command.threadId);
  if (command.checkpoint) {
    if (command.checkpoint.state.threadId !== command.threadId || command.checkpoint.state.model !== profile.model) {
      throw new Error("Claude checkpoint does not match the conversation profile");
    }
    if (await realpath(cwd) !== cwd) throw new Error("Unexpected Claude session directory");
  } else {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent) throw new Error("Unexpected Claude member directory");
    await mkdir(cwd, { mode: 0o700 });
  }
  const tmp = join(cwd, "tmp");
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const child = fork(new URL("./claude-worker.ts", import.meta.url), [], {
    cwd,
    execArgv: [],
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: cwd,
      TMPDIR: tmp,
      CLAUDE_CONFIG_DIR: join(cwd, "config"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      ANTHROPIC_API_KEY: profile.apiKey,
      ANTHROPIC_BASE_URL: profile.baseUrl,
    },
  });
  return new Promise((resolve, reject) => {
    let result: unknown;
    const stop = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) reject(error);
        }
      }
    };
    child.once("error", reject);
    child.once("message", (value) => { result = value; });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(new Error("Claude turn cancelled"));
      const reply = response.safeParse(result);
      if (code !== 0 || !reply.success) return reject(new Error("Claude worker exited without a result"));
      if ("error" in reply.data) return reject(new Error(reply.data.error));
      resolve(reply.data);
    });
    signal.addEventListener("abort", stop, { once: true });
    child.send(command);
    if (signal.aborted) stop();
  });
}

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { codexExecutable } from "./codex-executable.ts";

const envelope = z.object({ id: z.number().optional(), result: z.unknown().optional() });
const status = z.object({ authMethod: z.literal("chatgpt"), requiresOpenaiAuth: z.literal(true), authToken: z.string().min(1) });
const claims = z.object({
  exp: z.number().int().positive(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
});

type Subscription = { accessToken: string; accountId: string };
const reads = new Map<string, Promise<Subscription>>();
const signInRequired = "A current ChatGPT Codex sign-in for the approved account is required";

export async function readCodexSubscription(codexHome: string, expectedAccountId?: string): Promise<Subscription> {
  if (!isAbsolute(codexHome) || !(await stat(codexHome)).isDirectory()) throw new Error("Select an existing absolute Codex sign-in home");
  const home = await realpath(codexHome);
  let current = reads.get(home);
  if (!current) {
    current = readLogin(home).finally(() => reads.delete(home));
    reads.set(home, current);
  }
  const subscription = await current;
  if (expectedAccountId !== undefined && subscription.accountId !== expectedAccountId) throw new Error(signInRequired);
  return subscription;
}

// The CLI owns refresh-token rotation. Only the current access token crosses its private stdio channel.
async function readLogin(codexHome: string): Promise<Subscription> {
  const binary = codexExecutable();
  const scratch = await mkdtemp(join(tmpdir(), "birb-codex-signin-"));
  // App-server normally fetches a catalog at startup. This process only handles sign-in.
  const child = spawn(binary, ["app-server", "--listen", "stdio://",
    "-c", 'model_provider="openai"', "-c", 'chatgpt_base_url="http://127.0.0.1:0"',
    "-c", "log_dir=" + JSON.stringify(scratch), "-c", "analytics.enabled=false"], {
    cwd: scratch,
    env: {
      HOME: scratch, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: scratch, PATH: "/usr/local/bin:/usr/bin:/bin", RUST_LOG: "off",
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = once(child, "close").catch(() => {});
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  try {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "birbcrew", version: "1" } } });
    for await (const line of lines) {
      const response = envelope.parse(JSON.parse(line));
      if (response.id === 1) {
        if (!response.result) break;
        send({ method: "initialized" });
        send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken: false } });
      }
      if (response.id !== 2) continue;
      const signedIn = status.safeParse(response.result);
      if (!signedIn.success) throw new Error("Missing Codex subscription sign-in");
      const token = signedIn.data.authToken;
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("Invalid Codex subscription access token");
      const parsed = claims.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
      const accountId = parsed["https://api.openai.com/auth"].chatgpt_account_id;
      if (parsed.exp * 1000 <= Date.now()) throw new Error("Expired Codex subscription access token");
      return { accessToken: token, accountId };
    }
  } catch {
    // Protocol and JSON parse errors can include private reply values.
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.destroy();
    child.kill("SIGKILL");
    await closed;
    await rm(scratch, { recursive: true, force: true });
  }
  throw new Error(signInRequired);
}

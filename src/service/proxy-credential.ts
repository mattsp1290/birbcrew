import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

const credential = z.strictObject({
  headers: z.record(z.string(), z.string()).refine((headers) => Object.keys(headers).length > 0),
  expiresAt: z.number().finite(),
});
const outputLimit = 16_384;
const terminationGraceMs = 100;

/** Fixed, trusted executable/arguments. stdout is a private JSON protocol, never a diagnostic.
 * Helpers must not daemonize or escape their private process group. This is lifecycle
 * management, not a sandbox for untrusted executables.
 */
export function commandCredentialResolver(config: {
  executable: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}) {
  if (!isAbsolute(config.executable) || (config.timeoutMs !== undefined &&
      (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000))) {
    throw new Error("Invalid proxy credential helper configuration");
  }
  const executable = config.executable, args = [...(config.args ?? [])], env = { ...config.env };
  const timeout = config.timeoutMs ?? 10_000;
  return (signal: AbortSignal): Promise<z.infer<typeof credential>> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Proxy credential resolution cancelled"));
    // A new session/process group limits signals to this invocation and its descendants.
    const child = (() => {
      try { return spawn(executable, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false }); }
      catch { return undefined; }
    })();
    if (!child) return reject(new Error("Proxy credential resolution failed"));
    let failed = false, exited = false;
    let stdoutBytes = 0, stderrBytes = 0;
    const stdout: Buffer[] = [];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let pipeDeadline: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, value); } catch {
        // Never expose OS errors or command details; ESRCH means already gone.
      }
    };
    const stop = () => {
      if (failed) return;
      failed = true;
      stdout.length = 0;
      if (exited) return;
      signalGroup("SIGTERM");
      // Even a helper that ignores SIGTERM must be killed, not merely rejected.
      escalation = setTimeout(() => signalGroup("SIGKILL"), terminationGraceMs);
    };
    const deadline = setTimeout(stop, timeout);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) stop();
      else if (!failed) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > outputLimit) stop();
    });
    child.once("error", () => { failed = true; });
    child.once("exit", () => {
      exited = true;
      clearTimeout(deadline);
      // Reap group-local descendants even if the helper exits first or succeeds.
      // Do this synchronously, never via a later PID scan or deferred stale-PID signal.
      signalGroup("SIGKILL");
      if (escalation) clearTimeout(escalation);
      // Drain bounded pending output normally. Escaped/daemonized helpers must not
      // keep inherited pipes open after the direct child has been reaped.
      pipeDeadline = setTimeout(() => {
        failed = true;
        child.stdout.destroy();
        child.stderr.destroy();
      }, terminationGraceMs);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (pipeDeadline) clearTimeout(pipeDeadline);
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener("abort", stop);
      // close follows exit (reaped child) or a spawn error (no child to reap).
      if (failed || !exited || code !== 0) return reject(new Error("Proxy credential resolution failed"));
      try {
        const result = credential.parse(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        if (result.expiresAt <= Date.now()) throw new Error();
        resolve(result);
      } catch {
        reject(new Error("Proxy credential resolution failed"));
      }
    });
  });
}

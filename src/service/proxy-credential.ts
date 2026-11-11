import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

const credential = z.strictObject({
  headers: z.record(z.string(), z.string()).refine((headers) => Object.keys(headers).length > 0),
  expiresAt: z.number().finite(),
});

/** Fixed, trusted executable/arguments. stdout is a private JSON protocol, never a diagnostic. */
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
    execFile(executable, args, { env, signal, timeout, maxBuffer: 16_384, encoding: "utf8", shell: false }, (error, stdout) => {
      // Do not propagate Error: it can include command arguments, stdout and stderr.
      if (error) return reject(new Error("Proxy credential resolution failed"));
      try {
        const result = credential.parse(JSON.parse(stdout));
        if (result.expiresAt <= Date.now()) throw new Error();
        resolve(result);
      } catch {
        reject(new Error("Proxy credential resolution failed"));
      }
    });
  });
}

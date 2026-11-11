import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export type Engine = "pi" | "claude" | "codex";
export const run = promisify(execFile);
export async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 60_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(200);
  }
  throw new Error("Timed out waiting for " + label);
}

export async function services(selected?: Engine) {
  const directory = await mkdtemp(join(tmpdir(), "birb-members-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: directory, BIRBCREW_STATE_DIR: join(directory, "native"),
    BIRBCREW_PROOF_STREAM_DIR: directory, BIRBCREW_PROOF_REQUESTS: join(directory, "requests.jsonl"),
    BIRBCREW_PROOF_CODEX_REQUESTS: join(directory, "codex-results.jsonl"),
    BIRBCREW_PROOF_NOTES: join(directory, "note-evidence.jsonl"),
    ...(selected && { BIRBCREW_PROOF_ENGINE: selected }),
  };
  const temporal = process.env.TEMPORAL_CLI ?? "temporal";
  const db = "birb-proof-" + randomUUID(), password = randomBytes(24).toString("hex");
  const controller = new AbortController();
  const interrupt = () => { void close().finally(() => process.exit(130)); };
  const stopProcesses = new Set<() => Promise<void>>();
  async function child(program: string, args: string[], options = env, log = "worker.log") {
    const file = await open(join(directory, log), "a", 0o600);
    const proc = spawn(program, args, { env: options, detached: true, stdio: ["ignore", file.fd, file.fd] });
    const exit = once(proc, "exit");
    void exit.catch(() => {});
    await file.close();
    const stop = async () => {
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        try { process.kill(-proc.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await exit;
      stopProcesses.delete(stop);
    };
    stopProcesses.add(stop);
    return stop;
  }
  let disposed: Promise<void> | undefined;
  function close(): Promise<void> {
    controller.abort();
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    return disposed ??= (async () => {
      const workers = await Promise.allSettled([...stopProcesses].map((stop) => stop()));
      const resources = await Promise.allSettled([
        run("docker", ["rm", "-f", db], { timeout: 30_000 }), rm(directory, { recursive: true, force: true }),
      ]);
      const failures = [...workers, ...resources].filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), "Fixture cleanup failed");
    })().catch(error => { disposed = undefined; throw error; });
  }
  async function databaseReady() {
    await until(async () => {
      try { await run("docker", ["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }
      catch { return undefined; }
    }, "PostgreSQL");
    const { stdout } = await run("docker", ["port", db, "5432/tcp"]);
    const port = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    assert.ok(port, "Expected a loopback-only PostgreSQL port");
    env.BIRBCREW_DATABASE_URL = env.BIRBCREW_TEST_DATABASE_URL = "postgres://postgres:" + password + "@127.0.0.1:" + port + "/birbcrew_ts";
  }
  async function sql(statement: string) {
    return (await run("docker", ["exec", db, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "birbcrew_ts", "-Atc", statement],
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  }
  async function worker(engine = selected) {
    return child(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"],
      { ...env, ...(engine && { BIRBCREW_PROOF_ENGINE: engine }) });
  }
  async function startTemporal() {
    const address = env.BIRBCREW_TEMPORAL_ADDRESS!;
    const stop = await child(temporal, ["server", "start-dev", "--headless", "--port", address.split(":")[1],
      "--db-filename", join(directory, "temporal.db")], env, "temporal.log");
    await until(async () => {
      try { await run(temporal, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"], { env }); return true; }
      catch { return undefined; }
    }, "Temporal");
    return stop;
  }
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const cliVersion = await run(temporal, ["--version"]);
    assert.match(cliVersion.stdout, /^temporal version 1\.10\.0\b/);
    await run("docker", ["run", "--rm", "--name", db, "-d", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=birbcrew_ts",
      "-p", "127.0.0.1::5432", "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, signal: controller.signal });
    await databaseReady();
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address === "object");
    env.BIRBCREW_TEMPORAL_ADDRESS = "127.0.0.1:" + address.port;
    await new Promise<void>((done) => probe.close(() => done()));
    return { env, signal: controller.signal, sql, worker, child, directory, startTemporal, close,
      restartDatabase: async () => { await run("docker", ["restart", db]); await databaseReady(); } };
  } catch (error) { await close(); throw error; }
}
export type Services = Awaited<ReturnType<typeof services>>;

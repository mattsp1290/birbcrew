import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { piLaunch } from "../../../../src/service/pi-launch.ts";
import { runPiTurn } from "../../../../src/service/pi.ts";
import { createPiFixtureOptions } from "./index.mts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("the confined Pi worker cannot read outside its code or open a socket", { timeout: 20_000 }, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "birb-pi-scope-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const directory = join(scope, "conversation");
  await mkdir(directory, { mode: 0o700 });
  const sibling = join(scope, "other-owner.txt");
  await writeFile(sibling, "private fixture sentinel");
  let connections = 0;
  const server = createServer((socket) => { connections++; socket.destroy(); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const paths = { sibling, checkout: fileURLToPath(import.meta.url), host: `/proc/${process.pid}/environ`,
    code: join(root, "src/service/pi-worker.ts") };
  const probe = `
    const fs = require("node:fs");
    const attempt = (action) => { try { action(); return "allowed"; } catch (error) { return error.code; } };
    const paths = ${JSON.stringify(paths)};
    const result = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, attempt(() => fs.readFileSync(path))]));
    result.private = attempt(() => fs.writeFileSync("scratch", "own state"));
    const done = (tcp) => process.send({ ...result, tcp }, () => process.exit(0));
    require("node:net").connect(${address.port}, "127.0.0.1").once("connect", () => done("allowed")).once("error", (error) => done(error.code));
  `;
  const launch = piLaunch(directory, ["-e", probe]);
  const child = spawn(launch.command, launch.args, launch.options);
  const [message] = await once(child, "message");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  // Landlock denies reads outside the code and the private directory; seccomp denies the socket itself.
  assert.deepEqual(message, { sibling: "EACCES", checkout: "EACCES", host: "EACCES", code: "allowed", private: "allowed", tcp: "EPERM" });
  assert.equal(connections, 0);

  const unconfined = piLaunch(directory, ["-e", "0"]);
  const refused = spawn(unconfined.command, unconfined.args, { ...unconfined.options, stdio: "ignore" });
  assert.deepEqual(await once(refused, "exit"), [126, null], "The launcher must refuse a Pi worker without its IPC channel");
});

function processStatus(pid: number) {
  return Object.fromEntries(readFileSync(`/proc/${pid}/status`, "utf8").trim().split("\n").map((line) => line.split(":\t")));
}

test("a Pi turn runs in a launcher-confined worker with no inherited environment", { timeout: 20_000 }, async (t) => {
  const seen: { status: Record<string, string>; command: string[]; environment: string[] }[] = [];
  const profile = await createPiFixtureOptions(() => {
    const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/);
    for (const pid of children.map(Number)) {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!command.at(-1)?.endsWith("/src/service/pi-worker.ts")) continue;
      const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => entry.split("=")[0]!);
      seen.push({ status: processStatus(pid), command, environment });
    }
  });
  process.env.BIRBCREW_PI_TEST_SENTINEL = randomUUID();
  t.after(() => { delete process.env.BIRBCREW_PI_TEST_SENTINEL; });
  const turn = await runPiTurn({ threadId: randomUUID(), runId: randomUUID(), text: "remember cedar", checkpoint: null, signal: t.signal }, profile);
  assert.equal(turn.text, "stored cedar");
  assert.equal(seen.length, 1);
  const [worker] = seen;
  assert.equal(worker.status.NoNewPrivs, "1");
  assert.equal(Number(worker.status.Seccomp_filters), Number(processStatus(process.pid).Seccomp_filters) + 1);
  assert.deepEqual(worker.command, [process.execPath, join(root, "src/service/pi-worker.ts")]);
  assert.deepEqual(worker.environment.sort(), ["HOME", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "TMPDIR"]);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { commands } from "./member-commands.mts";
import { run, services, until, type Engine, type Services } from "./member-services.mts";

const matrix = {
  pi: { native: ["pi/durable", "pi/protected", "pi/delegation"], service: ["child-launch"], archive: "^(?:@ag-ui/pi |Pi's )",
    observers: "^pi |^two HttpAgents .*child|^two HttpAgents .*subagents|^terminated Pi child" },
  claude: { native: ["claude/durable", "claude/protected"], service: [], archive: "^@ag-ui/claude", observers: "^claude " },
  codex: { native: ["codex/qualification", "codex/native"], service: ["codex-mcp", "codex-registration", "codex-chat"],
    archive: "^the locked official Codex", observers: "^codex " },
} as const;

async function execute(program: string, args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(program, args, { env, stdio: "inherit" });
  const [code] = await once(proc, "exit");
  if (code !== 0) throw new Error("Verification command failed: " + [program, ...args].join(" "));
}
async function test(paths: string[], env: NodeJS.ProcessEnv, pattern?: string) {
  if (paths.length) await execute(process.execPath, ["--test", ...(pattern ? ["--test-name-pattern=" + pattern] : []), ...paths], env);
}

async function verify(s: Services, engines: Engine[], selected?: Engine) {
  const { env } = s, { command, create } = commands(s);
  const node = process.execPath;
  await execute(node, ["node_modules/typescript/bin/tsc", "--noEmit"], env);
  await test(["tests/fixtures/engines/artifacts.test.ts"], env, selected && matrix[selected].archive);
  await test(["tests/fixtures/engines/consumer.test.mjs"], env, selected && "^" + selected + " ");
  await test(engines.flatMap((e) => matrix[e].native.map((n) => "tests/fixtures/engines/" + n + ".test.ts")), env);
  if (!selected) await test(["store", "providers", "approvals"].map((n) => "tests/service/" + n + ".test.ts"), env);

  let temporal = await s.startTemporal();
  const workers = await Promise.all(engines.map((e) => s.worker(e)));
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1'") === String(engines.length) || undefined; }
    catch { return undefined; }
  }, "selected member profiles");
  const serviceFiles = engines.flatMap((e) => matrix[e].service.map((n) => "tests/service/" + n + ".test.ts"));
  await test(serviceFiles, env);
  if (!selected) await test(["tests/service/closure.test.ts", "tests/service/supervisor.test.ts"], env);
  else if (selected !== "codex") await test(["tests/service/supervisor.test.ts"], env, "^" + selected + " ");
  const cases = [];
  for (const engine of engines) {
    const member = await create(engine);
    for (let i = 0; i < 2; i++) {
      const key = await member.open();
      const nonce = randomUUID();
      const request = { ...key, requestId: randomUUID(), text: "remember " + nonce };
      cases.push({ engine, key, request, nonce });
    }
  }
  await Promise.all(cases.map(async ({ request, nonce }) => assert.deepEqual(await command("turn", request), { text: "stored " + nonce })));
  await Promise.all(workers.map((stop) => stop()));
  await temporal();
  await s.restartDatabase();
  temporal = await s.startTemporal();
  let stop = await s.worker();
  await Promise.all(cases.map(async ({ key, nonce, request, engine }) => {
    assert.deepEqual(await command("turn", request), { text: "stored " + nonce });
    await command("turn", { ...request, text: "changed" }, true);
    const recall = { ...key, requestId: randomUUID(), text: "recall" };
    await command("turn", { ...recall, ownerId: "another-owner" }, true);
    await command("turn", { ...recall, engine }, true);
    assert.deepEqual(await command("turn", recall), { text: "recalled " + nonce });
  }));
  console.log("Verified two native conversations per member after PostgreSQL, Temporal and worker replacement.");
  const requests = async () => (await readFile(env.BIRBCREW_PROOF_REQUESTS!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const { engine, request } of cases) {
    assert.equal((await requests()).filter((r) => r.engine === engine && r.prompt === request.text).length, 1);
  }
  const interrupted = cases.filter((_, i) => i % 2 === 0);
  const hanging = interrupted.map(({ key }) => command("turn", { ...key, requestId: randomUUID(), text: "wait" }, true));
  const all = Promise.all(hanging);
  void all.catch(() => {});
  await until(async () => (await requests()).filter((r) => r.prompt === "wait").length === engines.length || undefined, "all native providers in flight");
  await stop();
  stop = await s.worker();
  await all;
  for (const { key } of interrupted) assert.equal(await s.sql("SELECT phase FROM birbcrew_ts.turns WHERE conversation_id='" + key.conversationId +
    "' ORDER BY position DESC LIMIT 1"), "uncertain");
  assert.equal((await requests()).filter((r) => r.prompt === "wait").length, engines.length);

  await test(["tests/service/observation.test.ts"], env, selected && matrix[selected].observers);
  const codexGateway = "tests/service/codex-gateway.test.ts";
  if (engines.includes("codex") && existsSync(codexGateway)) await test([codexGateway], env);
  if (!selected && existsSync("tests/proof/replay-traces.mts")) await execute(node, ["tests/proof/replay-traces.mts"], {
    ...env, ...(process.env.BIRBCREW_REPLAY_EVIDENCE && { BIRBCREW_REPLAY_EVIDENCE: process.env.BIRBCREW_REPLAY_EVIDENCE }),
  });
  await stop();
  await temporal();
}
const { values } = parseArgs({ options: { engine: { type: "string" }, mode: { type: "string", default: "fixture" },
  attestation: { type: "string" }, help: { type: "boolean" } }, strict: true });
if (values.help) {
  console.log("scripts/verify-members [--mode fixture] [--engine pi|claude|codex]\nscripts/verify-members --mode live --engine ENGINE --attestation FILE");
} else {
  assert.equal(process.version, "v22.23.3", "Activate pinned Node 22.23.3");
  const engine = z.enum(["pi", "claude", "codex"]).optional().parse(values.engine);
  if (values.mode === "live") {
    if (!engine || !values.attestation) throw new Error("Supply an engine and explicit account attestation");
    await execute(process.execPath, ["tests/proof/live-members.mts", "--engine", engine, "--attestation", values.attestation], process.env);
  } else {
    if (values.mode !== "fixture" || values.attestation) throw new Error("Expected fixture mode with no account attestation");
    await run("scripts/build-native", []);
    const s = await services(engine);
    const shutdown = () => { void s.close().finally(() => process.exit(130)); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    try { await verify(s, engine ? [engine] : ["pi", "claude", "codex"], engine); }
    finally { process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); await s.close(); }
  }
}

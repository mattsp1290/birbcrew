import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { redact } from "../../src/service/diagnostics.ts";
import { MemberStore } from "../../src/service/store.ts";

const plantedJwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJwbGFudGVkIn0.cGxhbnRlZA";
const plantedKey = "sk-proj-" + "Q".repeat(48);

function launch() {
  return { ownerId: "owner", conversationId: randomUUID(), requestId: randomUUID(), text: "hello", token: randomUUID(),
    execution: { workflowRunId: randomUUID(), activityId: "1", attempt: 1 } };
}

test("redaction removes token-shaped text and keeps the rest readable", () => {
  const id = randomUUID();
  const text = `Error: Read-only file system (os error 30) for ${id}\nAuthorization: Bearer ${plantedKey} token=${plantedKey.slice(0, 20)} ` +
    `{"refresh_token":"rt_abc"} jwt ${plantedJwt} cut ${plantedJwt.slice(0, 30)} other aaaaaaaa1.bbbbbbbb2.cccccccc3`;
  const line = redact(text, 4096);
  for (const secret of [plantedKey, plantedKey.slice(0, 20), "rt_abc", plantedJwt, plantedJwt.slice(0, 30), "aaaaaaaa1.bbbbbbbb2"]) {
    assert.ok(!line.includes(secret), secret);
  }
  assert.ok(line.startsWith(`Error: Read-only file system (os error 30) for ${id} Authorization: [redacted]`));
  assert.equal(redact("Error: Read-only file system (os error 30) at auth.json.lock"), "Error: Read-only file system (os error 30) at auth.json.lock");
  assert.ok(!line.includes("\n"));
  assert.equal(redact("x".repeat(20) + " " + "y".repeat(20), 10), "xxxxxxxxxx…");
  assert.equal(redact("WARNING: first\nWARNING: second\nError: Read-only file system (os error 30)\n", 42, "end"),
    "…Error: Read-only file system (os error 30)");
  assert.equal(redact(`Bearer ${plantedKey}\nError: stopped`, 14, "end"), "…Error: stopped");
});

async function failingProfiles(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "birb-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "profiles.mjs");
  await writeFile(config, `throw new Error(${JSON.stringify("Profiles unavailable with Bearer " + plantedJwt + " key=" + plantedKey)});\n`);
  return { dir, config };
}

test("a failed turn runner sends its cause to the supervisor host with tokens removed and keeps its reply", { timeout: 30_000 }, async (t) => {
  const { dir, config } = await failingProfiles(t);
  const runner = fork(new URL("../../src/service/supervisor-runner.ts", import.meta.url), [config, dir], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    env: { ...process.env, BIRBCREW_DATABASE_URL: "postgresql://birbcrew:unused@127.0.0.1:1/unused" },
  });
  t.after(() => { if (runner.exitCode === null) runner.kill("SIGKILL"); });
  const messages: unknown[] = [];
  runner.on("message", (message) => messages.push(message));
  const closed = once(runner, "close");
  const turn = launch();
  runner.send({ launch: turn, conversation: {}, runId: turn.requestId, threadId: turn.conversationId, text: turn.text, checkpoint: null });
  await closed;
  assert.equal(messages.length, 2);
  const [forwarded, reply] = messages as [{ warning: string }, unknown];
  assert.deepEqual(reply, { error: "Native SDK turn failed" });
  assert.deepEqual(Object.keys(forwarded), ["warning"]);
  assert.ok(!forwarded.warning.includes(plantedJwt) && !forwarded.warning.includes(plantedKey));
  assert.deepEqual(JSON.parse(forwarded.warning), { level: "warn", logger: "birbcrew", event: "native_turn_failed",
    conversationId: turn.conversationId, requestId: turn.requestId, error: "Error",
    message: "Profiles unavailable with Bearer [redacted] key=[redacted]" });
});

// Answers every startup with a PostgreSQL error that names the user, as a real server does.
async function refusingPostgres(t: TestContext, message: string) {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const fields = ["SFATAL", "VFATAL", "C28P01", "M" + message].map((field) => Buffer.from(field + "\0"));
      const body = Buffer.concat([...fields, Buffer.from([0])]);
      const header = Buffer.alloc(5);
      header.write("E", 0);
      header.writeInt32BE(body.length + 4, 1);
      socket.end(Buffer.concat([header, body]));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("the supervisor host logs why a turn was denied, with tokens removed, and keeps its reply", { timeout: 30_000 }, async (t) => {
  const { dir, config } = await failingProfiles(t);
  const port = await refusingPostgres(t, `password authentication failed for user "${plantedJwt}"`);
  const host = fork(new URL("../../src/service/supervisor-host.ts", import.meta.url), [config, dir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
    env: { ...process.env, BIRBCREW_DATABASE_URL: `postgresql://birbcrew:unused@127.0.0.1:${port}/unused` },
  });
  t.after(() => { if (host.exitCode === null) host.kill("SIGKILL"); });
  let stderr = "";
  host.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  assert.equal((await once(host, "message"))[0], "ready");
  const id = randomUUID(), turn = launch();
  host.send({ id, action: "start", launch: turn });
  assert.deepEqual((await once(host, "message"))[0], { id, ok: false, error: "Native turn denied or outcome uncertain" });
  // A parent's disconnect() leaves "close" unemitted, so wait for the exit and the end of stderr.
  const exited = Promise.all([once(host, "exit"), once(host.stderr!, "close")]);
  host.disconnect();
  await exited;
  assert.ok(!stderr.includes(plantedJwt));
  assert.deepEqual(stderr.trim().split("\n").map((line) => JSON.parse(line)), [{ level: "warn", logger: "birbcrew",
    event: "native_turn_unconfirmed", action: "start", conversationId: turn.conversationId, requestId: turn.requestId,
    error: "error", code: "28P01", message: 'password authentication failed for user "[redacted]"' }]);
});

const database = process.env.BIRBCREW_TEST_DATABASE_URL;

test("a Codex sign-in failure reaches the worker's stderr through the turn runner and the supervisor host", { timeout: 60_000,
  skip: !database && "needs a disposable PostgreSQL database in BIRBCREW_TEST_DATABASE_URL; the integration API workflow runs this case" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "sign-in"), state = join(dir, "state"), scratch = join(dir, "tmp"), config = join(dir, "profiles.mjs");
  for (const path of [home, state, scratch]) await mkdir(path, { mode: 0o700 });
  const accountId = randomUUID(), profile = "sign-in-" + randomUUID();
  const exp = Math.floor(Date.now() / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (kind: string) => [encode({ alg: "none", typ: "JWT" }),
    encode({ exp, kind, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } }), "eA"].join(".");
  const tokens = { account_id: accountId, id_token: token("id"), access_token: token("access"), refresh_token: "planted-refresh-" + randomUUID() };
  await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(), tokens }), { mode: 0o600 });
  const reader = new URL("../../src/service/codex-subscription.ts", import.meta.url).href;
  // The closed loopback endpoint keeps a turn off the network if the sign-in check ever lets this login through.
  await writeFile(config, `import { readCodexSubscription } from ${JSON.stringify(reader)};
export const profiles = new Map([[${JSON.stringify(profile)}, { accountId: ${JSON.stringify(accountId)}, codex: { model: "gpt-5.4",
  baseUrl: "http://127.0.0.1:1/closed", authorize: async () => {},
  subscription: () => readCodexSubscription(${JSON.stringify(home)}, ${JSON.stringify(accountId)}) } }]]);\n`);

  const pool = new Pool({ connectionString: database });
  t.after(() => pool.end());
  const store = new MemberStore(pool);
  await store.migrate();
  const ownerId = randomUUID(), conversationId = randomUUID();
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "codex", profile });
  await store.openConversation({ ownerId, memberId, conversationId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "hello" };
  const execution = { workflowRunId: randomUUID(), activityId: "1", attempt: 1 };
  const claim = await store.beginTurn(request, execution);
  assert.equal(claim.kind, "start");

  const host = fork(new URL("../../src/service/supervisor-host.ts", import.meta.url), [config, state], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
    env: { ...process.env, BIRBCREW_DATABASE_URL: database, TMPDIR: scratch },
  });
  t.after(() => { if (host.exitCode === null) host.kill("SIGKILL"); });
  let stderr = "";
  host.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  assert.equal((await once(host, "message"))[0], "ready");
  const id = randomUUID();
  host.send({ id, action: "start", launch: { ...request, token: claim.token, execution } });
  assert.deepEqual((await once(host, "message"))[0], { id, ok: false, error: "Native turn denied or outcome uncertain" });
  const exited = Promise.all([once(host, "exit"), once(host.stderr!, "close")]);
  host.disconnect();
  await exited;
  const signInRequired = "A current ChatGPT Codex sign-in for the approved account is required";
  assert.deepEqual(stderr.trim().split("\n").map((line) => JSON.parse(line)), [
    { level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "expired", expiredAt: new Date(exp * 1000).toISOString() },
    { level: "warn", logger: "birbcrew", event: "native_turn_failed", conversationId, requestId: request.requestId,
      error: "CodexSignInError", reason: "expired", message: signInRequired },
    { level: "warn", logger: "birbcrew", event: "native_turn_unconfirmed", action: "start", conversationId, requestId: request.requestId,
      error: "Error", message: "Native runner reported a failed turn" },
  ]);
  for (const secret of [tokens.id_token, tokens.access_token, tokens.refresh_token]) {
    assert.ok(!stderr.includes(secret), "the worker's stderr contains a token");
  }
  assert.deepEqual(await readdir(scratch), []);
});

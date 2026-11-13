import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCodexTurn } from "../../src/service/codex.ts";
import { readCodexSubscription, signInCopy } from "../../src/service/codex-subscription.ts";
import { forwardWarnings } from "../../src/service/diagnostics.ts";

const signInRequired = /^A current ChatGPT Codex sign-in for the approved account is required$/;
// Token-shaped strings that no log line may contain.
const plantedJwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJwbGFudGVkIn0.cGxhbnRlZA";
const plantedRefresh = "planted-refresh-" + randomUUID();

async function isolatedLogin(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "birb-test-subscription-"));
  t.after(async () => {
    await chmod(home, 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  return { home, auth: join(home, "auth.json") };
}

// Scratch copies are made under TMPDIR. A private one shows what a read leaves behind.
async function privateTmp(t: TestContext, parent = tmpdir()) {
  const previous = process.env.TMPDIR;
  const dir = await mkdtemp(join(parent, "birb-test-tmp-"));
  process.env.TMPDIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function warnings(t: TestContext) {
  const lines: string[] = [];
  forwardWarnings((line) => { lines.push(line); });
  t.after(() => forwardWarnings(() => {}));
  return { lines, parsed: () => lines.map((line) => JSON.parse(line)) };
}

function chatgpt(accountId: string, { revision = "first", expiresIn = 3600, refresh = "synthetic-refresh" } = {}) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function token(kind: string) {
    const payload = {
      exp: Math.floor(Date.now() / 1000) + expiresIn, email: "offline@example.invalid", kind, revision,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
    };
    return [encode({ alg: "none", typ: "JWT" }), encode(payload), "eA"].join(".");
  }
  return {
    auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { account_id: accountId, id_token: token("id"), access_token: token("access"), refresh_token: refresh },
  };
}

// Paths, kinds, modes, sizes and contents of every entry.
async function snapshot(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath, entry.name), info = await stat(path);
    const digest = entry.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "directory";
    return `${path} ${info.mode.toString(8)} ${info.size} ${digest}`;
  })).then((lines) => lines.sort());
}

/** Makes the home read-only, or returns false when this user can still write it (root ignores modes). */
async function readOnly(home: string) {
  await chmod(join(home, "auth.json"), 0o400);
  await chmod(home, 0o500);
  try {
    await writeFile(join(home, "probe"), "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") return true;
    throw error;
  }
  await rm(join(home, "probe"));
  return false;
}

async function writable(home: string) {
  await chmod(home, 0o700);
  await chmod(join(home, "auth.json"), 0o600);
}

const scratchCopies = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith("birb-codex-signin-"));

test("a read-only sign-in home yields the subscription, follows the executor's rotation, and is left untouched", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const tmp = await privateTmp(t);
  const log = warnings(t);
  const accountId = "807c7885-5f13-4c72-aac4-c6cc3d240aba";
  await writeFile(auth, JSON.stringify(chatgpt(accountId)), { mode: 0o600 });
  if (!(await readOnly(home))) {
    t.skip("this user can write a mode 0500 directory (root); CI runs the read-only case as an unprivileged user");
    return;
  }
  for (const revision of ["first", "rotated by the executor"]) {
    const login = chatgpt(accountId, { revision });
    await writable(home);
    await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
    assert.equal(await readOnly(home), true);
    const before = await snapshot(home);
    const [subscription] = await Promise.all([
      readCodexSubscription(home, accountId),
      assert.rejects(readCodexSubscription(home, "another-workspace"), { message: signInRequired, reason: "account" }),
    ]);
    assert.deepEqual(subscription, { accessToken: login.tokens.access_token, accountId });
    assert.deepEqual(await snapshot(home), before);
  }
  assert.deepEqual(log.parsed(), Array(2).fill({ level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "account" }));
  assert.deepEqual(await scratchCopies(tmp), []);
});

test("a read leaves a writable sign-in home byte-for-byte unchanged with no new files", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const tmp = await privateTmp(t);
  const accountId = randomUUID();
  const login = chatgpt(accountId);
  await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
  const before = await snapshot(home);
  assert.deepEqual(await readCodexSubscription(home, accountId), { accessToken: login.tokens.access_token, accountId });
  assert.deepEqual(await snapshot(home), before);
  assert.deepEqual(await scratchCopies(tmp), []);
});

test("subscription reads follow the CLI login, return only access credentials, and pin the workspace across changes", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const accountId = "807c7885-5f13-4c72-aac4-c6cc3d240aba";
  for (const revision of ["first", "renewed"]) {
    const login = chatgpt(accountId, { revision });
    await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
    const [subscription] = await Promise.all([
      readCodexSubscription(home, accountId),
      assert.rejects(readCodexSubscription(home, "another-workspace"), { message: signInRequired, reason: "account" }),
    ]);
    assert.deepEqual(subscription, { accessToken: login.tokens.access_token, accountId });
    assert.deepEqual(JSON.parse(await readFile(auth, "utf8")), login);
  }
  await writeFile(auth, JSON.stringify(chatgpt("5ed40c50-f1bb-4dbd-8702-afc6af3b81c2")));
  await assert.rejects(readCodexSubscription(home, accountId), { message: signInRequired, reason: "account" });
});

test("a Codex API key cannot satisfy a subscription login", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  await writeFile(auth, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-private-api-key" }), { mode: 0o600 });
  await assert.rejects(readCodexSubscription(home), { message: signInRequired, reason: "signed-out" });
});

test("an expired access token fails with its own logged reason and the refresh token stays unused", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const tmp = await privateTmp(t);
  const log = warnings(t);
  const accountId = randomUUID();
  const login = chatgpt(accountId, { expiresIn: -60, refresh: plantedRefresh });
  await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
  const before = await snapshot(home);
  const started = Date.now();
  await assert.rejects(readCodexSubscription(home, accountId), { message: signInRequired, reason: "expired" });
  // Codex tries to refresh a token this close to expiry. The refresh goes nowhere, so the read does not wait on it.
  assert.ok(Date.now() - started < 10_000);
  const exp = JSON.parse(Buffer.from(login.tokens.access_token.split(".")[1], "base64url").toString()).exp;
  assert.deepEqual(log.parsed(), [{ level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "expired",
    expiredAt: new Date(exp * 1000).toISOString() }]);
  assert.deepEqual(await snapshot(home), before);
  assert.deepEqual(await scratchCopies(tmp), []);
});

test("the cause of a failed read is logged without any token", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  // Codex names its home on stderr when that home is under /tmp, so a token-shaped path reaches the logged output.
  const tmp = await privateTmp(t, "/tmp");
  await mkdir(join(tmp, plantedJwt));
  process.env.TMPDIR = join(tmp, plantedJwt);
  const log = warnings(t);
  const login = { auth_mode: "apikey", OPENAI_API_KEY: plantedJwt, tokens: chatgpt(randomUUID(), { refresh: plantedRefresh }).tokens };
  await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
  await assert.rejects(readCodexSubscription(home), { message: signInRequired, reason: "signed-out" });
  const [warning, ...rest] = log.parsed();
  assert.deepEqual(rest, []);
  assert.equal(warning.level, "warn");
  assert.equal(warning.event, "codex_signin_unavailable");
  assert.equal(warning.reason, "signed-out");
  assert.equal(warning.authMethod, "apikey");
  assert.match(warning.stderr, /codex_home: .*\[redacted\]/);
  for (const secret of [plantedJwt, plantedRefresh, login.tokens.access_token, login.tokens.id_token]) {
    assert.ok(log.lines.every((line) => !line.includes(secret)), "a log line contains a token");
  }
  assert.deepEqual(await scratchCopies(join(tmp, plantedJwt)), []);
});

test("app-server reads a copy of the login without its refresh token", () => {
  const login = chatgpt(randomUUID(), { refresh: plantedRefresh });
  const copy = signInCopy(Buffer.from(JSON.stringify(login)));
  assert.ok(!copy.includes(plantedRefresh));
  assert.deepEqual(JSON.parse(copy), { ...login, tokens: { ...login.tokens, refresh_token: "" } });
  const apiKey = { auth_mode: "apikey", OPENAI_API_KEY: "fixture-private-api-key" };
  assert.deepEqual(JSON.parse(signInCopy(Buffer.from(JSON.stringify(apiKey)))), apiKey);
});

test("an unreadable login is reported without quoting the file", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const log = warnings(t);
  await writeFile(auth, `{"tokens": {"access_token": "${plantedJwt}", `, { mode: 0o600 });
  await assert.rejects(readCodexSubscription(home), { message: signInRequired, reason: "login-file" });
  await rm(auth);
  await assert.rejects(readCodexSubscription(home), { message: signInRequired, reason: "login-file" });
  assert.deepEqual(log.parsed(), [
    { level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "login-file", code: "not JSON" },
    { level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "login-file", code: "ENOENT" },
  ]);
});

test("a scratch copy left by a killed reader is removed by the next read", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const tmp = await privateTmp(t);
  const accountId = randomUUID();
  await writeFile(auth, JSON.stringify(chatgpt(accountId)), { mode: 0o600 });
  const abandoned = join(tmp, "birb-codex-signin-abandoned"), current = join(tmp, "birb-codex-signin-current");
  for (const dir of [abandoned, current]) {
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "auth.json"), JSON.stringify(chatgpt(accountId)), { mode: 0o600 });
  }
  const tenMinutesAgo = new Date(Date.now() - 600_000);
  await utimes(abandoned, tenMinutesAgo, tenMinutesAgo);
  await readCodexSubscription(home, accountId);
  assert.deepEqual(await scratchCopies(tmp), ["birb-codex-signin-current"]);
});

test("a native Codex turn runs on a read-only sign-in home without writing it", { timeout: 60_000 }, async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-subscription-turn-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const accountId = randomUUID(), marker = randomUUID();
  const login = chatgpt(accountId);
  await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
  // Without read-only enforcement (root), the snapshot below still shows that nothing wrote the home.
  await readOnly(home);
  const before = await snapshot(home);
  const seen: { authorization?: string; account?: string | string[] }[] = [];
  const server = createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization, account: req.headers["chatgpt-account-id"] });
    req.resume();
    req.on("end", () => {
      const send = (type: string, value: object) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...value }) + "\n\n");
      const id = "resp_" + randomUUID();
      res.writeHead(200, { "content-type": "text/event-stream" });
      send("response.created", { response: { id } });
      send("response.output_item.done", { item: { type: "message", id: "msg_" + randomUUID(), role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: marker }] } });
      send("response.completed", { response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const turn = await runCodexTurn({ threadId: randomUUID(), runId: randomUUID(), text: "Say the marker", checkpoint: null, signal: t.signal }, {
    ownerId: randomUUID(), memberId: randomUUID(), stateDir, model: "gpt-5.4", baseUrl: `http://127.0.0.1:${address.port}/scoped`,
    authorize: async () => {}, subscription: () => readCodexSubscription(home, accountId),
  });
  assert.equal(turn.text, marker);
  assert.deepEqual(seen, [{ authorization: "Bearer " + login.tokens.access_token, account: accountId }]);
  assert.deepEqual(await snapshot(home), before);
});

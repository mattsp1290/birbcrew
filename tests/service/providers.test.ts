import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadLiveProfiles } from "../../src/service/providers.ts";
import { runPiTurn } from "../../src/service/pi.ts";

const model = "glm-5.3-flash";
const base = "https://opencode.ai/inference/go/openai/v1";
const account = () => ({ checked_at: new Date().toISOString(), evidence: "local fixture", account_path: "fixture owner" });
const go = () => ({ ...account(), provider: "opencode-go", extra_usage_disabled: true, eligible_coding_use: true });
const claude = () => ({ ...account(), provider: "anthropic-api", approved_sdk_use: true, model: "claude-sonnet-4-6" });

async function attestation(t: TestContext, data: object) {
  const dir = await mkdtemp(join(tmpdir(), "birb-account-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "account.json");
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
  return path;
}

async function localhost(t: TestContext) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const policy: { models: string[]; echo: string | null; redirect: boolean } = { models: [model], echo: model, redirect: false };
  let leaked = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/elsewhere") { leaked = true; return res.end(); }
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    calls.push({ url: base + req.url, headers, body: await text(req) });
    if (req.url === "/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ data: policy.models.map((id) => ({ id })) }));
    }
    if (policy.redirect) return res.writeHead(307, { Location: "/elsewhere" }).end();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = {
      id: "fixture", object: "chat.completion.chunk", created: 1,
      ...(policy.echo && { model: policy.echo }),
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    };
    res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.ok(request.url === base + "/models" || request.url === base + "/chat/completions");
    assert.equal(request.redirect, "error");
    return fetch(`http://127.0.0.1:${addr.port}` + request.url.slice(base.length), init);
  };
  return { calls, policy, transport, leaked: () => leaked };
}

test("Codex subscription members bind the approved workspace and reread credentials across turns", async t => {
  const id = randomUUID();
  const approval = { ...account(), provider: "chatgpt-subscription", model: "gpt-5.4", approved_sdk_use: true, account_id: id };
  const path = await attestation(t, approval);
  const env = { BIRBCREW_CODEX_ATTESTATION: path, BIRBCREW_CODEX_AUTH_HOME: "/trusted/codex", BIRBCREW_CODEX_API_KEY: "unused-api-key" };
  let accesses = 0;
  const members = await loadLiveProfiles(env, fetch, async (home, expected) => {
    assert.equal(home, "/trusted/codex");
    assert.equal(expected, id);
    return { accountId: id, accessToken: "synthetic-" + ++accesses };
  });
  const name = "chatgpt-gpt-5.4";
  assert.deepEqual([...members.keys()].sort(), [name + ".approval.v1", name + ".next-step.v1", name + ".v1"]);
  const member = members.get(name + ".approval.v1");
  assert.equal(member?.accountId, id);
  const profile = member?.codex;
  assert.ok(profile?.authorize && profile.subscription);
  assert.equal(profile.apiKey, undefined);
  assert.equal(accesses, 0);
  for (const n of [1, 2]) {
    await profile.authorize();
    assert.equal((await profile.subscription()).accessToken, "synthetic-" + n);
  }
  await writeFile(path, JSON.stringify({ ...approval, account_id: randomUUID() }));
  await assert.rejects(profile.authorize(), /changed/);
  await writeFile(path, JSON.stringify({ ...approval, provider: "openai-api" }));
  await assert.rejects(profile.authorize(), /changed/);
});

test("live profiles require separate keys, eligible accounts and a current owner decision", async (t) => {
  const env = { OPENCODE_API_KEY: "alternate", ANTHROPIC_API_KEY: "other" };
  assert.equal((await loadLiveProfiles(env)).size, 0);
  const piPath = await attestation(t, go());
  await assert.rejects(loadLiveProfiles({ ...env, BIRBCREW_PI_ATTESTATION: piPath }), /OPENCODE_GO_API_KEY/);
  const piEnv = { BIRBCREW_PI_ATTESTATION: piPath, OPENCODE_GO_API_KEY: "synthetic-go" };
  await writeFile(piPath, JSON.stringify({ ...go(), extra_usage_disabled: false }));
  await assert.rejects(loadLiveProfiles(piEnv), /attestation/);
  await writeFile(piPath, JSON.stringify({ ...go(), checked_at: new Date(Date.now() - 13 * 3600_000).toISOString() }));
  await assert.rejects(loadLiveProfiles(piEnv), /12 hours/);
  const path = await attestation(t, claude());
  await assert.rejects(loadLiveProfiles({ ...env, BIRBCREW_CLAUDE_ATTESTATION: path }), /BIRBCREW_CLAUDE_API_KEY/);
  const profiles = await loadLiveProfiles({ ...env, BIRBCREW_CLAUDE_ATTESTATION: path, BIRBCREW_CLAUDE_API_KEY: "synthetic-claude" });
  const config = profiles.get("anthropic-claude-sonnet-4-6.v1")?.claude;
  assert.ok(config?.authorize);
  assert.equal(config.baseUrl, "https://api.anthropic.com");
  assert.equal(config.apiKey, "synthetic-claude");
  await config.authorize();
  await writeFile(path, JSON.stringify({ ...claude(), model: "claude-opus-4-7" }));
  await assert.rejects(config.authorize(), /changed model/);
});

test("the Pi coding SDK sends the approved model and stable BirbCrew session headers to the Go transport", async (t) => {
  const local = await localhost(t);
  const path = await attestation(t, go());
  const config = (await loadLiveProfiles({ BIRBCREW_PI_ATTESTATION: path, OPENCODE_GO_API_KEY: "synthetic-go" }, local.transport))
    .get("pi-go-glm-5.3-flash.v1")?.pi;
  assert.ok(config);
  const run = (threadId: string, checkpoint: Parameters<typeof runPiTurn>[0]["checkpoint"] = null) =>
    runPiTurn({ threadId, runId: randomUUID(), text: "hello", signal: AbortSignal.timeout(15_000), checkpoint }, config);
  const thread = randomUUID();
  const first = await run(thread);
  assert.equal(first.text, "ok");
  await run(thread, first.checkpoint);
  await run(randomUUID());
  assert.deepEqual(local.calls.map((x) => x.url.slice(base.length)), [
    "/models", "/chat/completions", "/models", "/chat/completions", "/models", "/chat/completions",
  ]);
  const sends = local.calls.filter((x) => x.body.length > 0);
  for (const call of sends) {
    assert.equal(JSON.parse(call.body).model, model);
    assert.equal(JSON.parse(call.body).max_tokens, 1200);
    assert.equal(call.headers.get("authorization"), "Bearer synthetic-go");
    assert.equal(call.headers.get("user-agent"), "birbcrew-coding-proof/0.1.0");
    assert.equal(call.headers.get("x-opencode-client"), null);
  }
  const ids = sends.map((x) => x.headers.get("x-opencode-session"));
  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);

  for (const echo of [null, "different-model"]) {
    local.policy.echo = echo;
    await assert.rejects(run(randomUUID()), /did not confirm the approved response model/);
  }
  local.policy.redirect = true;
  await assert.rejects(run(randomUUID()));
  assert.equal(local.leaked(), false);
  local.policy.models = ["another-model"];
  const count = local.calls.length;
  await assert.rejects(run(randomUUID()), /preflight/);
  assert.equal(local.calls.length, count + 1);
  await writeFile(path, JSON.stringify({ ...go(), checked_at: new Date(Date.now() - 13 * 3600_000).toISOString() }));
  await assert.rejects(run(randomUUID()), /12 hours/);
  assert.equal(local.calls.length, count + 1);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { goEndpoint, goModel } from "../../src/service/accounts.ts";
import { authorizeLive } from "./live-account.ts";
import { verifyLive } from "./live-members.ts";
import { openRelay } from "./live-relay.ts";

async function attestation(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "birb-live-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "owner.json");
  const value = { provider: "opencode-go", account_path: "test", checked_at: new Date().toISOString(), evidence: "fixture",
    eligible_coding_use: true, extra_usage_disabled: true, approved_live_proof: true, endpoint: goEndpoint, model: goModel, max_requests: 16 };
  const write = (extra: object = {}) => writeFile(path, JSON.stringify({ ...value, ...extra }), { mode: 0o600 });
  await write();
  const args = ["--engine", "pi", "--attestation", path];
  const env = { OPENCODE_GO_API_KEY: "synthetic" };
  return { path, args, env, write };
}

test("live preflight requires a current private decision for exactly one provider, model, origin and request budget", async (t) => {
  const gate = await attestation(t);
  await assert.rejects(authorizeLive([], gate.env));
  await assert.rejects(authorizeLive([...gate.args, "--engine", "pi"], gate.env));
  await assert.rejects(authorizeLive(["--engine", "claude", "--attestation", gate.path], { BIRBCREW_CLAUDE_API_KEY: "synthetic" }));
  await assert.rejects(authorizeLive(gate.args, { OPENAI_API_KEY: "ignored" }));
  for (const invalid of [{ approved_live_proof: false }, { endpoint: "https://example.invalid" }, { max_requests: 25 },
    { model: "other" }, { checked_at: "2020-01-01T00:00:00Z" }, { extra_usage_disabled: false }]) {
    await gate.write(invalid);
    await assert.rejects(authorizeLive(gate.args, gate.env));
  }
  await gate.write();
  await chmod(gate.path, 0o644);
  await assert.rejects(authorizeLive(gate.args, gate.env));
});

test("the relay counts before upstream submission and fails closed on revocation", async (t) => {
  const gate = await attestation(t);
  for (const revoked of [true, false]) {
    await gate.write({ max_requests: 1 });
    const account = await authorizeLive(gate.args, gate.env);
    let upstream = 0;
    const relay = await openRelay(account, async (url, init) => {
      assert.equal(url, goEndpoint + "/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic");
      assert.equal(init?.redirect, "error");
      upstream++;
      return Response.json({ data: [] });
    });
    try {
      if (revoked) await gate.write({ approved_live_proof: false });
      const get = () => fetch(relay.url + "/models", { headers: { "User-Agent": "birbcrew-coding-proof/0.1.0" } });
      const responses = await Promise.all([get(), get()]);
      assert.deepEqual(responses.map(r => r.status).sort(), revoked ? [403, 403] : [200, 403]);
      assert.equal(upstream, revoked ? 0 : 1);
    } finally { await relay.close(); }
  }
});

test("the live Pi entry exercises native tool results, cold recall, delegation and cleanup with a controlled upstream", { timeout: 150_000 }, async (t) => {
  const gate = await attestation(t);
  const account = await authorizeLive(gate.args, gate.env);
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === goEndpoint + "/models") return Response.json({ data: [{ id: goModel }] });
    assert.equal(request.url, goEndpoint + "/chat/completions");
    const { messages } = await request.json() as { messages: { role: string; content: unknown }[] };
    const user = JSON.stringify(messages.findLast(m => m.role === "user")?.content);
    const last = messages.at(-1);
    const body = JSON.stringify(messages);
    let call: { name: string; arguments: string } | undefined;
    let text = "";
    if (last?.role === "tool") {
      const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      text = content.match(/"receiptId":"([a-f0-9-]+)"/)?.[1] ?? content.match(/CHILD-[a-f0-9-]+/)?.[0] ?? "";
    } else if (user.includes("record_work_item once")) {
      call = { name: "record_work_item", arguments: JSON.stringify({ operation_id: user.match(/operation_id ([a-f0-9-]+)/)![1], note: "synthetic regression test" }) };
    } else if (user.includes("Test delegation")) {
      call = { name: "delegate_task", arguments: JSON.stringify({ role: "analyst", task: "Reply exactly " + user.match(/CHILD-[a-f0-9-]+/)![0] }) };
    } else text = body.match(/(?:BIRB|CHILD)-[a-f0-9-]+/)?.[0] ?? "";
    assert.ok(call || text);
    const delta = call ? { role: "assistant", tool_calls: [{ type: "function", index: 0, id: "call_" + randomUUID(), function: call }] } : { content: text };
    const frame = { id: "message", object: "chat.completion.chunk", model: goModel, created: 1,
      choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] };
    return new Response("data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  const report = await verifyLive(account, AbortSignal.timeout(120_000), transport);
  assert.equal(report.delegatedChild, true);
  assert.equal(report.committedWorkItems, 1);
  assert.equal(report.workerContainerReplaced, true);
  assert.equal(report.cleanup, "verified");
});

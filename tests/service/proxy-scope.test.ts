import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import test from "node:test";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";

test("Codex host cancellation closes upstream despite retained SDK socket, without cancelling another turn", { timeout: 5000 }, async t => {
  const disconnected = new Set<number>();
  const server = createServer(async (req, res) => {
    const input = await json(req) as { invocation: number };
    res.once("close", () => disconnected.add(input.invocation));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.output_text.delta","delta":"waiting"}\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const configured = await createProxyProfile({ engine: "codex", protocol: "openai-responses", accountId: "fixture",
    model: "fixture", endpoint: `http://127.0.0.1:${address.port}/responses`, allowHttpLoopback: true,
    resolveCredential: async () => ({ headers: { authorization: "Bearer synthetic" }, expiresAt: Date.now() + 1000 }) });
  t.after(configured.close);
  const first = new AbortController(), second = new AbortController();
  const open = configured.profile.codex!.proxyTransport!;
  const a = await open(first.signal), b = await open(second.signal);
  assert.notEqual(a.apiKey, b.apiKey);
  assert.notEqual(a.baseUrl, b.baseUrl);
  const receive = async (lease: typeof a, invocation: number) => {
    const response = await fetch(lease.baseUrl + "/responses", { method: "POST",
      headers: { authorization: `Bearer ${lease.apiKey}` }, body: JSON.stringify({ model: "fixture", invocation }) });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /waiting/);
    return reader;
  };
  const readerA = await receive(a, 1), readerB = await receive(b, 2);
  t.after(() => readerA.cancel().catch(() => {}));
  t.after(() => readerB.cancel().catch(() => {}));
  // Deliberately retain both fetch streams. No simulated SDK disconnect is used.
  first.abort();
  await a.close();
  for (let i = 0; i < 100 && !disconnected.has(1); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(disconnected.has(1), "host signal alone disconnected first upstream");
  assert.equal(disconnected.has(2), false, "unrelated invocation remains connected");
  await assert.rejects(open(first.signal));
  await configured.close();
  for (let i = 0; i < 100 && !disconnected.has(2); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(disconnected.has(2), "profile shutdown closes remaining upstream");
  await assert.rejects(open(new AbortController().signal), /closed/);
});

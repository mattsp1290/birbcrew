import assert from "node:assert/strict";
import { createServer, request as httpRequest, type RequestListener } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { startProxyRelay, type ProxyProtocol } from "../src/service/proxy-relay.ts";

async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/upstream`, close: async () => {
    const done = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await done;
  } };
}
const local = (baseUrl: string, protocol: ProxyProtocol) => baseUrl + (protocol === "anthropic-messages" ? "/v1/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions");

for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat-completions"] as const) {
  test(`${protocol}: per-request renewal, model/tool correlation and restart`, async () => {
    const received: unknown[] = [];
    let generation = 0;
    const upstream = await fixture(async (req, res) => {
      assert.equal(req.url, "/upstream");
      assert.equal(req.headers.authorization, `Bearer synthetic-${generation}`);
      assert.equal(req.headers["x-required"], "fixture");
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream", "x-secret": "do-not-forward" });
      res.end('data: {"tool_call_id":"call-1","text":"ok"}\n\n');
    });
    try {
      for (let restart = 0; restart < 2; restart++) {
        const relay = await startProxyRelay({ protocol, endpoint: upstream.url, model: "fixture-model", allowHttpLoopback: true,
          headers: { "x-required": "fixture" }, resolveCredential: async () => {
            generation++;
            return { headers: { authorization: `Bearer synthetic-${generation}` }, expiresAt: Date.now() + 50 };
          } });
        try {
          for (let request = 0; request < 2; request++) {
            const response = await fetch(local(relay.baseUrl, protocol), { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` },
              body: JSON.stringify({ model: "fixture-model", tool_call_id: "call-1", stream: true }) });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("x-secret"), null);
            assert.match(await response.text(), /call-1/);
            // Cross the previous synthetic credential expiry within the same worker.
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
        } finally { await relay.close(); }
      }
      assert.equal(generation, 4);
      assert.equal(received.length, 4);
      assert.deepEqual(received[0], { model: "fixture-model", tool_call_id: "call-1", stream: true });
    } finally { await upstream.close(); }
  });
}

test("wrong token, model and route never reach resolver or upstream", async () => {
  let calls = 0;
  const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: "https://example.invalid/v1/responses", model: "allowed",
    resolveCredential: async () => { calls++; throw new Error("SECRET"); } });
  try {
    for (const [path, model, token, status] of [["/responses", "allowed", "wrong", 401], ["/responses", "wrong", relay.apiKey, 400], ["/other", "allowed", relay.apiKey, 400]] as const) {
      const result = await fetch(relay.baseUrl + path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model }) });
      assert.equal(result.status, status);
      assert.doesNotMatch(await result.text(), /SECRET/);
    }
    assert.equal(calls, 0);
  } finally { await relay.close(); }
});

test("expired credentials and helper output fail closed without leaking", async () => {
  for (const resolveCredential of [async () => ({ headers: { authorization: "SECRET" }, expiresAt: 0 }), async () => { throw new Error("SECRET command stdout stderr"); }]) {
    const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: "https://example.invalid/v1/responses", model: "allowed", resolveCredential });
    try {
      const response = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /SECRET|stdout|stderr/);
    } finally { await relay.close(); }
  }
});

test("redirect and error bodies are not forwarded", async () => {
  let destinationCalls = 0;
  const destination = await fixture((_req, res) => { destinationCalls++; res.end("SECRET"); });
  for (const status of [302, 401, 500]) {
    const upstream = await fixture((_req, res) => { res.writeHead(status, { location: destination.url }); res.end("SECRET"); });
    const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: upstream.url, allowHttpLoopback: true, model: "allowed",
      resolveCredential: async () => ({ headers: { authorization: "Bearer synthetic" }, expiresAt: Date.now() + 1000 }) });
    try {
      const response = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /SECRET/);
    } finally { await relay.close(); await upstream.close(); }
  }
  assert.equal(destinationCalls, 0);
  await destination.close();
});

test("disconnect cancels the upstream stream", async () => {
  let upstreamClosed!: () => void;
  const disconnected = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const upstream = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"text":"started"}\n\n');
    res.once("close", upstreamClosed);
  });
  const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: upstream.url, allowHttpLoopback: true, model: "allowed",
    resolveCredential: async () => ({ headers: {}, expiresAt: Date.now() + 1000 }) });
  try {
    const controller = new AbortController();
    const response = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}', signal: controller.signal });
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream not cancelled")), 2000).unref())]);
  } finally { await relay.close(); await upstream.close(); }
});

test("configuration rejects unsupported protocols and non-TLS remote endpoints", async () => {
  const resolveCredential = async () => ({ headers: {}, expiresAt: Date.now() + 1000 });
  for (const endpoint of ["http://example.com/v1", "https://user:SECRET@example.com/v1", "https://example.com/v1?token=SECRET"]) {
    await assert.rejects(startProxyRelay({ protocol: "openai-responses", model: "allowed", endpoint, resolveCredential, allowHttpLoopback: true }), /Invalid proxy/);
  }
  await assert.rejects(startProxyRelay({ protocol: "unsupported" as ProxyProtocol, model: "allowed", endpoint: "https://example.com/v1", resolveCredential }), /Invalid proxy/);
});

test("unavailable upstream and hung credential helper fail visibly", async () => {
  const upstream = await fixture((_req, res) => res.end());
  const endpoint = upstream.url;
  await upstream.close();
  for (const resolveCredential of [async () => ({ headers: {}, expiresAt: Date.now() + 1000 }), async () => new Promise<never>(() => {})]) {
    const relay = await startProxyRelay({ protocol: "openai-responses", endpoint, allowHttpLoopback: true, model: "allowed", requestTimeoutMs: 100, resolveCredential });
    try {
      const response = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
      assert.ok([502, 504].includes(response.status));
      assert.equal((await response.json()).error.message, "AI proxy request failed");
    } finally { await relay.close(); }
  }
});

test("bounded bodies are never forwarded", async () => {
  let resolutions = 0;
  const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: "https://example.invalid/v1/responses", model: "allowed", maxBodyBytes: 8,
    resolveCredential: async () => { resolutions++; return { headers: {}, expiresAt: Date.now() + 1000 }; } });
  try {
    // Oversized input is rejected before resolving a credential.
    await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' })
      .then(async (response) => { assert.equal(response.status, 413); await response.text(); });
    assert.equal(resolutions, 0);
  } finally { await relay.close(); }
});

test("timeout interrupts an authenticated client stalled while uploading", async () => {
  let resolutions = 0;
  const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: "https://example.invalid/v1/responses", model: "allowed", requestTimeoutMs: 100,
    resolveCredential: async () => { resolutions++; return { headers: {}, expiresAt: Date.now() + 1000 }; } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { request.destroy(); reject(new Error("stalled upload was not interrupted")); }, 2000);
      const request = httpRequest(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}`, "content-length": "10000" } });
      request.once("error", () => { clearTimeout(timeout); resolve(); });
      request.write('{"model":');
      // Deliberately do not call end().
    });
    assert.equal(resolutions, 0);
  } finally { await relay.close(); }
});

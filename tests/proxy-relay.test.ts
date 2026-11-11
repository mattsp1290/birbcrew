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

test("Claude beta Messages suffix preserves exact upstream endpoint and beta header", async () => {
  let forwarded = 0;
  const upstream = await fixture(async (request, response) => {
    forwarded++;
    assert.equal(request.url, "/upstream");
    assert.equal(request.headers["anthropic-beta"], "fixture-beta");
    for await (const _ of request) { /* consume request */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const relay = await startProxyRelay({ protocol: "anthropic-messages", endpoint: upstream.url, model: "allowed", allowHttpLoopback: true,
    resolveCredential: async () => ({ headers: { "x-api-key": "synthetic" }, expiresAt: Date.now() + 1000 }) });
  try {
    for (const [suffix, expected] of [["?beta=true", 200], ["?beta=false", 400], ["?beta=true&other=1", 400], ["?other=1", 400], ["/count_tokens", 400]] as const) {
      const response = await fetch(relay.baseUrl + "/v1/messages" + suffix, { method: "POST", headers: { "x-api-key": relay.apiKey, "anthropic-beta": "fixture-beta" }, body: '{"model":"allowed"}' });
      assert.equal(response.status, expected);
      await response.text();
    }
    assert.equal(forwarded, 1);
  } finally { await relay.close(); await upstream.close(); }
});

for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat-completions"] as const) {
  for (const stream of [false, true]) {
    test(`${protocol}: HTTP 200 ${stream ? "SSE" : "JSON"} protocol diagnostics are redacted before SDK boundary`, async () => {
      const canary = "SYNTHETIC-UPSTREAM-DIAGNOSTIC";
      const error = protocol === "anthropic-messages" ? { type: "error", error: { type: "overloaded_error", message: canary } } :
        protocol === "openai-responses" ? { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: canary } } } :
          { error: { type: "invalid_request_error", message: canary } };
      const body = JSON.stringify(error);
      const upstream = await fixture((_req, res) => {
        res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        // Prior safe content must remain streaming; split CRLF and error JSON across writes.
        if (stream) res.write('data: {"text":"safe-content","tool_call_id":"safe-call"}\r\n\r\n');
        const payload = stream ? `event: ${protocol === "openai-responses" ? "response.failed" : "message"}\r\ndata: ${body}\r\n\r\n` : body;
        res.write(payload.slice(0, 15));
        setTimeout(() => res.end(payload.slice(15)), 10);
      });
      const relay = await startProxyRelay({ protocol, endpoint: upstream.url, allowHttpLoopback: true, model: "allowed",
        resolveCredential: async () => ({ headers: { authorization: canary }, expiresAt: Date.now() + 1000 }) });
      try {
        const result = await fetch(local(relay.baseUrl, protocol), { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
        assert.equal(result.status, stream ? 200 : 502);
        const text = await result.text();
        assert.doesNotMatch(text, /SYNTHETIC-UPSTREAM-DIAGNOSTIC|overloaded_error|server_error|invalid_request_error/);
        assert.match(text, /AI proxy request failed/);
        if (stream) { assert.match(text, /safe-content/); assert.match(text, /safe-call/); }
      } finally { await relay.close(); await upstream.close(); }
    });
  }
}

test("SSE named errors with non-JSON diagnostics and oversized/truncated frames fail generically", async () => {
  for (const payload of [
    'event: error\ndata: SYNTHETIC-DIAGNOSTIC\n\n',
    'data: {"error":{"message":"' + 'SYNTHETIC-DIAGNOSTIC'.repeat(70_000) + '"}}\n\n',
    'data: {"text":"unterminated SYNTHETIC-DIAGNOSTIC"}',
    'data: {"type":"error","message":"SYNTHETIC-DIAGNOSTIC"}\n\n',
  ]) {
    const upstream = await fixture((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(payload); });
    const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: upstream.url, allowHttpLoopback: true, model: "allowed",
      resolveCredential: async () => ({ headers: {}, expiresAt: Date.now() + 1000 }) });
    try {
      const result = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
      const text = await result.text();
      assert.doesNotMatch(text, /SYNTHETIC-DIAGNOSTIC/);
      assert.match(text, /AI proxy request failed/);
      assert.ok(text.length < 200);
    } finally { await relay.close(); await upstream.close(); }
  }
});

test("oversized JSON response is rejected before any upstream bytes escape", async () => {
  const upstream = await fixture((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: "SYNTHETIC-DIAGNOSTIC".repeat(70_000) })); });
  const relay = await startProxyRelay({ protocol: "openai-responses", endpoint: upstream.url, allowHttpLoopback: true, model: "allowed",
    resolveCredential: async () => ({ headers: {}, expiresAt: Date.now() + 1000 }) });
  try {
    const result = await fetch(relay.baseUrl + "/responses", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
    assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /SYNTHETIC-DIAGNOSTIC/);
  } finally { await relay.close(); await upstream.close(); }
});

test("successful SSE remains incremental beyond the per-event limit", async () => {
  const upstream = await fixture(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 400; i++) {
      res.write('data: ' + JSON.stringify({ text: "x".repeat(3000), sequence: i }) + '\r');
      await new Promise(resolve => setImmediate(resolve));
      res.write('\n\r\n');
    }
    res.end('data: [DONE]\n\n');
  });
  const relay = await startProxyRelay({ protocol: "openai-chat-completions", endpoint: upstream.url, allowHttpLoopback: true, model: "allowed",
    resolveCredential: async () => ({ headers: {}, expiresAt: Date.now() + 1000 }) });
  try {
    const result = await fetch(relay.baseUrl + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{"model":"allowed"}' });
    const text = await result.text();
    assert.ok(text.length > 1024 * 1024);
    assert.equal(text.match(/"sequence":/g)?.length, 400);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /proxy_error/);
  } finally { await relay.close(); await upstream.close(); }
});

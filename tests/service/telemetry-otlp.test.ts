import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./telemetry-child.ts", import.meta.url));
type Run = { code: number | null; stdout: string; stderr: string };
type Received = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
type Span = { name: string; traceId: string; spanId: string; parentSpanId?: string; status: { code: number };
  attributes: { key: string; value: unknown }[] };

// The module reads its configuration at import time, so each case runs in a fresh process.
function run(env: Record<string, string>, ids: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [child, ...ids], { env: { PATH: process.env.PATH, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
        stdout, stderr }));
  });
}

async function listen(t: TestContext, server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function collector(t: TestContext) {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    received.push({ method: request.method, url: request.url, headers: request.headers, body: await text(request) });
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  return { port: await listen(t, server), received };
}

const ids = () => [randomUUID(), randomUUID(), randomUUID()];
const string = (value: string) => ({ stringValue: value });

test("exports validated spans to an OTLP/HTTP collector beside the JSONL file", async (t) => {
  const { port, received } = await collector(t);
  const directory = await mkdtemp(join(tmpdir(), "birb-otlp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [conversationId, requestId, workflowRunId] = ids();
  const secret = "private-" + randomUUID(), token = "collector-" + randomUUID();
  const result = await run({
    BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
    BIRBCREW_TRACE_FILE: join(directory, "traces.jsonl"),
    OTEL_EXPORTER_OTLP_HEADERS: "x-collector-token=" + token,
  }, [conversationId, requestId, workflowRunId, secret]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, true);
  for (const output of [result.stdout, result.stderr]) assert.ok(!output.includes(token) && !output.includes(secret));

  assert.ok(received.length >= 1);
  for (const request of received) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/traces");
    assert.match(String(request.headers["content-type"]), /^application\/json/);
    assert.equal(request.headers["x-collector-token"], token);
    assert.ok(!request.body.includes(secret) && !request.body.includes("prompt") && !request.body.includes("apiKey"));
  }
  const batches = received.flatMap((request) => JSON.parse(request.body).resourceSpans);
  for (const { resource } of batches) assert.deepEqual(resource.attributes, [{ key: "service.name", value: string("birbcrew") }]);
  const spans: Span[] = batches.flatMap((batch) => batch.scopeSpans.flatMap((scope: { spans: Span[] }) => scope.spans));
  assert.deepEqual(spans.map((span) => span.name).sort(), ["model.invoke", "workflow.segment"]);
  const traceId = createHash("sha256").update(conversationId + "/" + requestId).digest("hex").slice(0, 32);
  const segment = spans.find((span) => span.name === "workflow.segment")!, invoke = spans.find((span) => span.name === "model.invoke")!;
  assert.ok(!segment.parentSpanId);
  assert.equal(invoke.parentSpanId, segment.spanId);
  for (const span of spans) {
    assert.equal(span.traceId, traceId);
    assert.equal(span.status.code, 1);
    assert.deepEqual(span.attributes.sort((a, b) => a.key.localeCompare(b.key)), [
      { key: "conversationId", value: string(conversationId) }, { key: "engine", value: string("claude") },
      { key: "requestId", value: string(requestId) }, { key: "workflowRunId", value: string(workflowRunId) },
    ]);
  }

  const lines = (await readFile(join(directory, "traces.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.name, line.traceId, line.spanId]).sort(),
    spans.map((span) => [span.name, span.traceId, span.spanId]).sort());
});

test("an unreachable or silent collector cannot hold a flush past its budget", async (t) => {
  // Bound and released so connections are refused; nothing in this test binds it again.
  const refused = createServer().listen(0, "127.0.0.1");
  await once(refused, "listening");
  const closedPort = (refused.address() as AddressInfo).port;
  refused.close();
  await once(refused, "close");
  // Accepts connections and never answers.
  const silent = createServer(() => {});
  const silentPort = await listen(t, silent);
  const token = "collector-" + randomUUID();
  // Upper bounds sit well above each budget, for slow runners, and well below the five-second export timeout.
  for (const [flush, limit] of [["turn", 750], ["exit", 2_500]] as const) {
    for (const port of [closedPort, silentPort]) {
      const result = await run({
        BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`, OTEL_EXPORTER_OTLP_HEADERS: "x-collector-token=" + token,
      }, [...ids(), "private-" + randomUUID(), flush]);
      assert.equal(result.code, 0, result.stderr);
      const { value, flushed } = JSON.parse(result.stdout);
      assert.equal(value, true);
      assert.ok(flushed < limit, `${flush} flush to port ${port} took ${flushed} ms`);
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    }
  }
});

test("a malformed endpoint fails at startup without echoing it", async (t) => {
  const { port, received } = await collector(t);
  for (const value of ["collector:4318/v1/traces", "not a url", `ftp://127.0.0.1:${port}/v1/traces`,
    `http://operator:hunter2@127.0.0.1:${port}/v1/traces`, `http://127.0.0.1:${port}`, `https://127.0.0.1:${port}/`,
    // Plain http beyond numeric loopback would carry collector headers in the clear.
    `http://collector.example:${port}/v1/traces`, `http://localhost:${port}/v1/traces`,
    // The exporter would drop these silently.
    `https://127.0.0.1:${port}/v1/traces?api_key=hunter2`, `https://127.0.0.1:${port}/v1/traces#hunter2`]) {
    const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: value }, [...ids(), "private"]);
    assert.notEqual(result.code, 0, value);
    assert.equal(result.stdout, "", value);
    assert.match(result.stderr, /BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL/);
    assert.ok(!result.stderr.includes(value) && !result.stderr.includes("hunter2"), value);
  }
  assert.equal(received.length, 0);
});

test("an https endpoint on any host is accepted", async () => {
  const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: "https://collector.invalid/v1/traces" }, [...ids(), "private", "turn"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, true);
});

test("with no sink configured traced work runs untouched", async () => {
  const result = await run({}, [...ids(), "private"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, true);
});

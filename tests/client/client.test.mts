import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { CrewClient, CrewHttpError, CrewProtocolError, CrewUnknownOutcomeError } from "@birbcrew/client";
import { requestReceiptSchema } from "@birbcrew/client/contract";

const conversationId = randomUUID(), requestId = randomUUID(), memberId = randomUUID();
const key = { conversationId, requestId };
const receipt = { apiVersion: "1", ...key, acceptance: { boundary: "sql_admission_and_temporal_queue" }, status: "accepted" };
const member = { memberId, engine: "claude", profile: "test" };
const snapshot = { cursor: 0, state: { ...member, conversationId, phase: "idle" }, messages: [], openTools: {}, openText: null, childText: {} };
const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>) {
  const seen: { path: string; method: string; auth: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => { void (async () => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ path: request.url!, method: request.method!, auth: request.headers.authorization, body });
    await handler(request, response, body);
  })(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { seen, baseUrl, client: new CrewClient({ baseUrl, token: "secret-token" }), close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("all domain methods send one authenticated request with exact text", async () => {
  const approvalId = randomUUID();
  const s = await serve((request, response) => {
    const path = request.url!;
    if (path.includes("/human")) return json(response, { approvalId, decision: "deny" });
    if (path.includes("/requests")) return json(response, receipt, request.method === "POST" ? 202 : 200);
    if (path === "/v1/members" && request.method === "POST") return json(response, { ...member, ownerId: "private-owner" }, 201);
    if (path.startsWith("/v1/members")) return json(response, { apiVersion: "1", members: [member], next: null });
    if (path === "/v1/health") return json(response, { apiVersion: "1", status: "not_ready", dependencies: { database: { status: "ready", schemaVersion: 29 }, temporal: { status: "unavailable" } } }, 503);
    if (path === "/v1/capabilities") return json(response, { apiVersion: "1", requestContract: "sql-admission-temporal-queue-v1", observation: { protocol: "AG-UI", mode: "snapshot-and-bounded-tail" }, initiatorKinds: ["owner"] });
    return json(response, snapshot, request.method === "POST" ? 201 : 200);
  });
  try {
    await s.client.capabilities(); assert.equal((await s.client.health()).status, "not_ready");
    assert.equal((await s.client.listMembers({ limit: 2, after: "opaque+/=" })).members.length, 1);
    assert.equal("ownerId" in await s.client.createMember({ requestId, engine: "claude", profile: "test" }), false);
    await s.client.openConversation({ conversationId, memberId });
    assert.equal((await s.client.conversation({ conversationId })).phase, "idle");
    const text = "  Exact\n\té and e\u0301 🪶  ";
    await s.client.submit({ ...key, text }); const saved = { ...key, text }; await s.client.requestStatus(saved); await s.client.cancel(key);
    await s.client.decide({ ...key, memberId, invocationId: randomUUID(), approvalId, version: 1, choice: "deny" });
    assert.equal(s.seen.length, 10);
    assert.ok(s.seen.every(request => request.auth === "Bearer secret-token"));
    assert.equal(s.seen[2].path, "/v1/members?limit=2&after=opaque%2B%2F%3D");
    assert.equal(s.seen[6].body, JSON.stringify({ requestId, text }));
    assert.equal(s.seen[7].method, "GET"); assert.equal(s.seen[8].body, "{}");
  } finally { await s.close(); }
});

test("invalid UUID, text, byte bounds and pre-aborted calls dispatch nothing", async () => {
  const s = await serve((_, response) => json(response, receipt));
  try {
    for (const text of ["", "\0", "\ud800", "é".repeat(8193)]) assert.throws(() => s.client.submit({ ...key, text }));
    assert.throws(() => s.client.submit({ ...key, conversationId: "../evil", text: "x" }));
    assert.throws(() => s.client.createMember({ requestId, engine: "pi", profile: "p", instructions: "\r" }));
    await assert.rejects(s.client.submit({ ...key, text: "x" }, { signal: AbortSignal.abort("stopped") }), error => error === "stopped");
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
});

test("lost acknowledgement preserves original identity and status never resubmits", async () => {
  const s = await serve((request, response) => request.method === "POST" ? request.socket.destroy() : json(response, { error: "not_found" }, 404));
  try {
    await assert.rejects(s.client.submit({ ...key, text: "accepted before socket close" }), error => error instanceof CrewUnknownOutcomeError && error.command.kind === "request" && error.command.requestId === requestId);
    await assert.rejects(s.client.requestStatus(key), error => error instanceof CrewHttpError && error.status === 404);
    assert.deepEqual(s.seen.map(request => request.method), ["POST", "GET"]);
  } finally { await s.close(); }
});

test("abort after acceptance means unknown outcome", async () => {
  const abort = new AbortController();
  const s = await serve(() => abort.abort());
  try {
    await assert.rejects(s.client.submit({ ...key, text: "accepted" }, { signal: abort.signal }), CrewUnknownOutcomeError);
    assert.equal(s.seen.length, 1);
  } finally { await s.close(); }
});

for (const [status, error] of [[409, "conflict"], [404, "not_found"], [401, "authentication_required"], [503, "retry_same_request"], [409, "future_error"]] as const) {
  test(`HTTP ${status} ${error} remains bounded and never retries`, async () => {
    const s = await serve((_, response) => json(response, { error }, status));
    try {
      await assert.rejects(s.client.submit({ ...key, text: "sensitive prompt" }), failure => {
        assert.ok(!String(failure).includes("secret-token") && !String(failure).includes("sensitive prompt"));
        return status === 503 ? failure instanceof CrewUnknownOutcomeError : failure instanceof CrewHttpError && failure.code === error && failure.status === status;
      });
      assert.equal(s.seen.length, 1);
    } finally { await s.close(); }
  });
}

for (const malformed of ["not json", { ...receipt, apiVersion: "2" }, { ...receipt, requestId: randomUUID() }, { ...receipt, status: "completed" }]) {
  test(`malformed or wrong-identity reply does not imply completion: ${JSON.stringify(malformed)}`, async () => {
    const s = await serve((request, response) => {
      response.statusCode = request.method === "POST" ? 202 : 200;
      response.end(typeof malformed === "string" ? malformed : JSON.stringify(malformed));
    });
    try {
      await assert.rejects(s.client.submit({ ...key, text: "x" }), CrewUnknownOutcomeError);
      await assert.rejects(s.client.requestStatus(key), CrewProtocolError);
      assert.equal(s.seen.length, 2);
    } finally { await s.close(); }
  });
}

test("oversized and malicious response bodies are bounded", async () => {
  const s = await serve((request, response) => {
    response.statusCode = request.method === "POST" ? 202 : 200;
    response.end("x".repeat(8 * 1024 * 1024 + 1));
  });
  try {
    await assert.rejects(s.client.submit({ ...key, text: "x" }), CrewUnknownOutcomeError);
    await assert.rejects(s.client.requestStatus(key), CrewProtocolError);
  } finally { await s.close(); }
  const e = await serve((_, response) => json(response, { error: "secret-token\n".repeat(20_000) }, 503));
  try { await assert.rejects(e.client.cancel(key), failure => failure instanceof CrewUnknownOutcomeError && !String(failure).includes("secret-token")); }
  finally { await e.close(); }
});

test("redirects cannot forward bearer credentials or replay writes", async () => {
  const s = await serve((_, response) => { response.writeHead(307, { Location: "/second" }); response.end(); });
  try { await assert.rejects(s.client.submit({ ...key, text: "x" }), CrewUnknownOutcomeError); assert.equal(s.seen.length, 1); }
  finally { await s.close(); }
});

test("receipt validation preserves independent cancellation facts and historical nonterminal results", () => {
  for (const status of ["accepted", "uncertain", "completed", "cancelled"] as const) {
    const value = { ...receipt, status, result: { text: "historical result" }, initiator: { kind: "handoff", id: randomUUID() },
      cancellation: { receiptId: randomUUID(), delivery: "pending", nativeTermination: "confirmed", effects: "not_assessed" } };
    assert.deepEqual(requestReceiptSchema.parse(value), value);
  }
});

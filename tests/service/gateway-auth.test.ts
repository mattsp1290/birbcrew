import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import test, { type TestContext } from "node:test";
import type { MemberClient } from "../../src/service/client.ts";
import { createGateway } from "../../src/service/gateway.ts";
import type { MemberStore } from "../../src/service/store.ts";

// No database or Temporal: authentication must reject before either is touched. The gateway's background loops
// (cancellation outbox, routine dispatcher) query the store on their own timers, so only calls made inside a
// request's async context are recorded. The empty result answers those loops: nothing to flush, recovery not active.
const cause = new AsyncLocalStorage<string>();
const reached: string[] = [];
const record = (target: string) => { const request = cause.getStore(); if (request) reached.push(`${request} -> ${target}`); };
const store = { pool: { async query() { record("store"); return { rows: [], rowCount: 0 }; } } } as unknown as MemberStore;
const members = new Proxy({}, { get: (_, name) => () => { record("members." + String(name)); throw new Error("unreachable"); } }) as MemberClient;

const token = randomUUID();
const conversation = randomUUID(), request = randomUUID();
const routes: [string, string][] = [
  ["GET", "/v1/capabilities"], ["POST", "/v1/members"], ["POST", "/v1/conversations"],
  ["GET", `/v1/conversations/${conversation}`], ["POST", `/v1/conversations/${conversation}/requests`],
  ["GET", `/v1/conversations/${conversation}/requests/${request}`], ["POST", `/v1/conversations/${conversation}/requests/${request}/cancel`],
  ["POST", `/v1/conversations/${conversation}/events`], ["POST", `/v1/conversations/${conversation}/human`],
  ["POST", `/v1/conversations/${conversation}/inputs`], ["POST", `/v1/conversations/${conversation}/cancel`],
  ["POST", "/members"], ["POST", "/conversations"], ["GET", `/conversations/${conversation}`],
  ["GET", `/conversations/${conversation}/requests/${request}`], ["POST", `/conversations/${conversation}/inputs`],
  ["POST", `/conversations/${conversation}/human`], ["POST", `/conversations/${conversation}/cancel`],
  ["POST", `/conversations/${conversation}/events`],
  ["GET", "/"], ["GET", "/health"], ["GET", "/healthz"], ["GET", "/v1/healthz"], ["GET", "/healthz/"], ["GET", "/healthz?probe=1"],
  ["POST", "/healthz"], ["PUT", "/healthz"], ["DELETE", "/healthz"],
];

async function listen(t: TestContext) {
  const server = createGateway(store, members, { [createHash("sha256").update(token).digest("hex")]: randomUUID() });
  const [handle] = server.listeners("request") as ((request: IncomingMessage, response: ServerResponse) => void)[];
  server.removeListener("request", handle);
  server.on("request", (request: IncomingMessage, response: ServerResponse) =>
    cause.run(`${request.method} ${request.url}`, handle, request, response));
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await server.stopped();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function raw(port: number, method: string, target: string) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.end(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  const reply = Buffer.concat(await socket.toArray()).toString();
  return Number(/^HTTP\/1\.1 (\d{3}) /.exec(reply)?.[1]);
}

test("every route rejects requests without a valid bearer token before reaching the store or Temporal", async (t) => {
  const port = await listen(t), base = `http://127.0.0.1:${port}`;
  for (const [method, path] of routes) {
    for (const authorization of [undefined, "", "Bearer ", "Bearer " + randomUUID(), "Basic " + token, "bearer " + token]) {
      const response = await fetch(base + path, { method, headers: authorization === undefined ? {} : { Authorization: authorization },
        ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}) });
      assert.equal(response.status, 401, `${method} ${path} with ${authorization === undefined ? "no" : JSON.stringify(authorization.split(" ")[0])} credential`);
      assert.deepEqual(await response.json(), { error: "authentication_required" });
    }
  }
  // Request targets that fetch normalizes away, including ones a URL parser rejects or rewrites.
  for (const [method, target] of [["HEAD", "/healthz"], ["OPTIONS", "/healthz"], ["GET", "//"], ["GET", "//evil/healthz"],
    ["GET", "http://x/healthz"], ["GET", "http://[/healthz"], ["GET", "http://x:99999/healthz"], ["GET", "/./healthz"],
    ["GET", "/v1/../healthz"], ["GET", "/%2e/healthz"], ["GET", "*"]]) {
    assert.equal(await raw(port, method, target), 401, `${method} ${target}`);
  }
  assert.deepEqual(reached, [], "no unauthenticated request reached the store or Temporal client");

  assert.equal((await fetch(base + "/v1/capabilities", { headers: { Authorization: "Bearer " + token } })).status, 200);
  // Positive control: a request that does reach the store is recorded, so the empty list above means something.
  assert.equal((await fetch(base + "/v1/members", { headers: { Authorization: "Bearer " + token } })).status, 200);
  assert.deepEqual(reached, ["GET /v1/members -> store"]);
});

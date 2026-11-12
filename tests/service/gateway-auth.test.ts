import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import test, { type TestContext } from "node:test";
import type { MemberClient } from "../../src/service/client.ts";
import { createGateway } from "../../src/service/gateway.ts";
import type { MemberStore } from "../../src/service/store.ts";

// No database or Temporal: authentication must reject before either is touched.
const reached: string[] = [];
const store = { pool: { async query(sql: string) {
  if (!sql.includes("integration_cancellations x JOIN")) reached.push("store");
  return { rows: [], rowCount: 0 };
} } } as unknown as MemberStore;
const members = new Proxy({}, { get: (_, name) => () => { reached.push("members." + String(name)); throw new Error("unreachable"); } }) as MemberClient;

const token = randomUUID();
const conversation = randomUUID(), request = randomUUID();
const routes: [string, string][] = [
  ["GET", "/v1/capabilities"], ["POST", "/v1/members"], ["POST", "/v1/conversations"],
  ["GET", `/v1/conversations/${conversation}`], ["POST", `/v1/conversations/${conversation}/requests`],
  ["GET", `/v1/conversations/${conversation}/requests/${request}`], ["POST", `/v1/conversations/${conversation}/requests/${request}/cancel`],
  ["POST", `/v1/conversations/${conversation}/events`], ["POST", `/v1/conversations/${conversation}/human`],
  ["POST", "/members"], ["POST", "/conversations"], ["GET", `/conversations/${conversation}`],
  ["GET", `/conversations/${conversation}/requests/${request}`], ["POST", `/conversations/${conversation}/inputs`],
  ["POST", `/conversations/${conversation}/human`], ["POST", `/conversations/${conversation}/cancel`],
  ["POST", `/conversations/${conversation}/events`],
  ["GET", "/"], ["GET", "/v1/healthz"], ["GET", "/healthz/"], ["POST", "/healthz"], ["PUT", "/healthz"], ["DELETE", "/healthz"],
];

async function listen(t: TestContext, host: string) {
  const server = createGateway(store, members, { [createHash("sha256").update(token).digest("hex")]: randomUUID() });
  server.listen(0, host);
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("every existing route rejects requests without a valid bearer token; only GET /healthz answers", async (t) => {
  const base = `http://127.0.0.1:${await listen(t, "127.0.0.1")}`;
  for (const [method, path] of routes) {
    for (const authorization of [undefined, "", "Bearer ", "Bearer " + randomUUID(), "Basic " + token, "bearer " + token]) {
      const response = await fetch(base + path, { method, headers: authorization === undefined ? {} : { Authorization: authorization },
        ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}) });
      assert.equal(response.status, 401, `${method} ${path} with ${authorization === undefined ? "no" : JSON.stringify(authorization.split(" ")[0])} credential`);
      assert.deepEqual(await response.json(), { error: "authentication_required" });
    }
  }
  assert.deepEqual(reached, [], "no unauthenticated request reached the store or Temporal client");
  assert.equal((await fetch(base + "/v1/capabilities", { headers: { Authorization: "Bearer " + token } })).status, 200);

  for (const authorization of [undefined, "Bearer " + randomUUID()]) {
    const health = await fetch(base + "/healthz?probe=1", { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(await health.text(), JSON.stringify({ status: "ok" }));
  }
  assert.deepEqual(reached, [], "health does not read state");
});

test("health answers loopback peers only, even if the gateway were bound more widely", async (t) => {
  const external = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!external) return t.skip("no non-loopback IPv4 interface");
  const port = await listen(t, "0.0.0.0");
  const remote = await fetch(`http://${external}:${port}/healthz`);
  assert.equal(remote.status, 401);
  assert.deepEqual(await remote.json(), { error: "authentication_required" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

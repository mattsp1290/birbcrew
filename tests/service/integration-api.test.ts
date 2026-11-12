import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type { Client } from "@temporalio/client";
import { MemberClient } from "../../src/service/client.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { MemberStore } from "../../src/service/store.ts";
import { createGateway, probeTimeout } from "../../src/service/gateway.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import type { TurnRequest } from "../../src/service/domain.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const consumerDatabase = "integration_consumer_" + randomUUID().replaceAll("-", "");
const consumerUrl = new URL(url); consumerUrl.pathname = "/" + consumerDatabase;
const consumerPool = new Pool({ connectionString: consumerUrl.toString() });
let consumerCreated = false;
before(async () => {
  await store.migrate();
  await pool.query(`CREATE DATABASE "${consumerDatabase}"`);
  consumerCreated = true;
  // This schema belongs to the fixture consumer, not Birbcrew. Both rows commit in
  // the consumer's own transaction before any network operation is attempted.
  await consumerPool.query(`CREATE SCHEMA IF NOT EXISTS integration_consumer_fixture;
    CREATE TABLE IF NOT EXISTS integration_consumer_fixture.events(event_id uuid PRIMARY KEY, payload text NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_consumer_fixture.handoffs(
      event_id uuid PRIMARY KEY REFERENCES integration_consumer_fixture.events,
      conversation_id uuid NOT NULL,request_id uuid NOT NULL,payload text NOT NULL,
      acknowledged boolean NOT NULL DEFAULT false,result text)`);
});
after(async () => {
  await consumerPool.end();
  try { if (consumerCreated) await pool.query(`DROP DATABASE "${consumerDatabase}"`); }
  finally { await pool.end(); }
});

async function fixture(automaticallyComplete = false) {
  const ownerId = randomUUID(), token = randomUUID(), stranger = randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture-v1" });
  const key = { ownerId, conversationId: randomUUID() };
  await store.openConversation({ ...key, memberId: member.memberId });
  let accepts = 0, cancels = 0, effects = 0;
  async function finish(input: TurnRequest) {
    if (await store.committedReply(input) !== undefined) return;
    const turn = await store.beginTurn(input, { workflowRunId: randomUUID(), activityId: "fixture", attempt: 1 });
    if (turn.kind === "start") {
      effects++;
      await store.commitTurn({ ...key, requestId: input.requestId, token: turn.token,
        reply: "original result: " + input.text, checkpoint: { version: 1, engine: "pi", state: {} } });
    }
  }
  const members = {
    async accept(input: TurnRequest) {
      accepts++;
      await store.recordAcceptance(input);
      if (automaticallyComplete) await finish(input);
      return { requestId: input.requestId };
    },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return store.requestStatus(input); },
    async cancelPending() { cancels++; },
  } as unknown as MemberClient;
  const auth = { [createHash("sha256").update(token).digest("hex")]: ownerId,
    [createHash("sha256").update(stranger).digest("hex")]: randomUUID() };
  let server = createGateway(store, members, auth);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let endpoint = `http://127.0.0.1:${address.port}`;
  async function api(path: string, body?: unknown, credential: string = token) {
    return fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const stop = async () => {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  };
  return { ...key, token, stranger, api, members, finish, get endpoint() { return endpoint; },
    counts: () => ({ accepts, cancels, effects }), stop,
    async restart() {
      await stop();
      server = createGateway(new MemberStore(pool), members, auth);
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      endpoint = `http://127.0.0.1:${address.port}`;
    },
  };
}

const child = `
  import { Pool } from 'pg';
  const db = new Pool({connectionString:process.env.BIRBCREW_CONSUMER_DATABASE_URL});
  const [endpoint, token, conversationId, requestId, stage] = process.argv.slice(1);
  const eventId = requestId, text = 'consumer event ' + eventId;
  const c = await db.connect();
  await c.query('BEGIN');
  await c.query('INSERT INTO integration_consumer_fixture.events VALUES($1,$2)',[eventId,text]);
  await c.query('INSERT INTO integration_consumer_fixture.handoffs(event_id,conversation_id,request_id,payload) VALUES($1,$2,$3,$4)',[eventId,conversationId,requestId,text]);
  await c.query('COMMIT'); c.release();
  if(stage==='before_send') process.kill(process.pid,'SIGKILL');
  const path='/v1/conversations/'+conversationId+'/requests';
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const accepted=await fetch(endpoint+path,{method:'POST',headers,body:JSON.stringify({requestId,text})});
  if(accepted.status!==202) throw new Error('expected accepted: '+accepted.status);
  const receipt=await accepted.json();
  if(stage==='after_acceptance' && receipt.status!=='accepted') throw new Error('expected waiting acceptance before kill');
  if(stage==='after_completion') {
    const result=await fetch(endpoint+path+'/'+requestId,{headers});
    if((await result.json()).status!=='completed') throw new Error('expected complete');
  }
  process.kill(process.pid,'SIGKILL');
`;

for (const boundary of ["before_send", "after_acceptance", "after_completion"] as const) {
  test(`fixture consumer recovers after SIGKILL ${boundary} without duplicate logical execution`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(boundary !== "after_acceptance"); t.after(f.stop);
    const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests`;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", child, f.endpoint, f.token, f.conversationId, requestId, boundary],
      { cwd: new URL("../../", import.meta.url), env: { ...process.env, BIRBCREW_CONSUMER_DATABASE_URL: consumerUrl.toString() }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; proc.stderr.on("data", data => { stderr += data; });
    const [code, signal] = await once(proc, "exit");
    assert.equal(code, null, stderr); assert.equal(signal, "SIGKILL", stderr);
    await f.restart();
    const consumer = new Pool({ connectionString: consumerUrl.toString() });
    try {
      const { rows: [handoff] } = await consumer.query("SELECT * FROM integration_consumer_fixture.handoffs WHERE event_id=$1", [requestId]);
      assert.equal(handoff.acknowledged, false);
      const lookup = await f.api(path + "/" + requestId);
      if (boundary === "before_send") assert.equal(lookup.status, 404);
      else assert.equal((await lookup.json()).status, boundary === "after_acceptance" ? "accepted" : "completed");
      // Retry the same identity even when acceptance/completion acknowledgements
      // were lost. The consumer never invents a replacement request identifier.
      const submitted = await f.api(path, { requestId, text: handoff.payload });
      assert.equal(submitted.status, 202);
      if (boundary === "after_acceptance") {
        assert.equal((await submitted.json()).status, "accepted");
        assert.equal(f.counts().effects, 0, "acceptance is not execution completion");
        await f.finish({ ownerId: f.ownerId, conversationId: f.conversationId, requestId, text: handoff.payload });
      }
      const result = await (await f.api(path + "/" + requestId)).json();
      assert.equal(result.status, "completed");
      assert.equal(result.result.text, "original result: " + handoff.payload);
      await consumer.query("UPDATE integration_consumer_fixture.handoffs SET acknowledged=true,result=$2 WHERE event_id=$1", [requestId, result.result.text]);
      assert.equal((await pool.query("SELECT count(*)::integer n FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2", [f.conversationId, requestId])).rows[0].n, 1);
      assert.equal(f.counts().effects, 1);
      const before = f.counts();
      for (let i = 0; i < 3; i++) assert.deepEqual(await (await f.api(path + "/" + requestId)).json(), result);
      assert.deepEqual(f.counts(), before, "status/result lookup cannot dispatch or cancel work");
    } finally { await consumer.end(); }
  });
}

test("v1 HTTP contract enforces ownership, strict identity, capability version and payload equivalence", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests`;
  const body = { requestId, text: " exact\n" };
  const response = await f.api(path, body); assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.apiVersion, "1"); assert.equal(receipt.status, "accepted");
  assert.equal(receipt.acceptance.boundary, "sql_admission_and_temporal_queue");
  assert.deepEqual(await (await f.api(path, body)).json(), receipt);
  assert.equal((await f.api(path, { ...body, text: body.text.trim() })).status, 409);
  assert.equal((await f.api(path, { ...body, ownerId: f.ownerId })).status, 400);
  assert.equal((await f.api(path + "/" + requestId, undefined, f.stranger)).status, 404);
  assert.equal((await f.api(path, body, f.stranger)).status, 404);
  assert.equal((await f.api(path + "/" + requestId + "/cancel", {}, f.stranger)).status, 404);
  assert.equal((await f.api(path + "/" + requestId, undefined, "invalid")).status, 401);
  const capabilities = await (await f.api("/v1/capabilities")).json();
  assert.equal(capabilities.apiVersion, "1");
  const before = f.counts();
  assert.deepEqual(await (await f.api(path + "/" + requestId)).json(), receipt);
  assert.deepEqual(f.counts(), before);
});

test("cancellation receipt is durable, deduplicated and distinct from native termination", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests`;
  assert.equal((await f.api(path, { requestId, text: "queued" })).status, 202);
  const cancel = await f.api(path + "/" + requestId + "/cancel", {}); assert.equal(cancel.status, 202);
  const first = await cancel.json();
  assert.equal(first.status, "cancellation_requested");
  assert.ok(first.cancellation.receiptId);
  assert.equal(first.cancellation.nativeTermination, "unconfirmed");
  await f.restart();
  const again = await (await f.api(path + "/" + requestId + "/cancel", {})).json();
  assert.equal(again.cancellation.receiptId, first.cancellation.receiptId);
  await new IntegrationApi(store, f.members).flushCancellations();
  const status = await (await f.api(path + "/" + requestId)).json();
  assert.equal(status.cancellation.receiptId, first.cancellation.receiptId);
  assert.equal(status.cancellation.delivery, "delivered");
  assert.equal(status.cancellation.nativeTermination, "unconfirmed", "transport acknowledgment is not native termination");
});

test("completed result survives a racing later cancellation intent", async (t) => {
  const f = await fixture(true); t.after(f.stop);
  const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests`;
  await f.api(path, { requestId, text: "finish" });
  const settled = await (await f.api(path + "/" + requestId)).json();
  const cancelled = await (await f.api(path + "/" + requestId + "/cancel", {})).json();
  assert.equal(cancelled.status, "completed");
  assert.deepEqual(cancelled.result, settled.result);
  await new IntegrationApi(store, f.members).flushCancellations();
  assert.equal(f.counts().cancels, 0, "completed winner must not send cancellation downstream");
});

test("status distinguishes execution start and uncertainty without dispatch", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests`;
  const input = { ownerId: f.ownerId, conversationId: f.conversationId, requestId, text: "uncertain" };
  await f.api(path, { requestId, text: input.text });
  const turn = await store.beginTurn(input, { workflowRunId: randomUUID(), activityId: "uncertain-fixture", attempt: 1 });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const before = f.counts();
  assert.equal((await (await f.api(path + "/" + requestId)).json()).status, "running");
  await store.markUncertain({ ownerId: f.ownerId, conversationId: f.conversationId, requestId, token: turn.token });
  assert.equal((await (await f.api(path + "/" + requestId)).json()).status, "uncertain");
  assert.deepEqual(f.counts(), before);
});

test("ambiguous cancellation delivery retries the original durable intent", async () => {
  const f = await fixture();
  await f.stop(); // Own the pump explicitly; no background gateway delivery race.
  const input = { ownerId: f.ownerId, conversationId: f.conversationId, requestId: randomUUID(), text: "retry intent" };
  await store.recordAcceptance(input);
  let deliveries = 0;
  const api = new IntegrationApi(store, { accept: f.members.accept.bind(f.members), requestStatus: f.members.requestStatus.bind(f.members), async cancelPending() {
    if (++deliveries === 1) throw new Error("ambiguous transport failure");
  } });
  const key = { ownerId: input.ownerId, conversationId: input.conversationId, requestId: input.requestId };
  const receipt = await api.cancel(key);
  await api.flushCancellations();
  assert.equal((await api.status(key)).cancellation?.delivery, "pending");
  await api.flushCancellations();
  const settled = await api.status(key);
  assert.equal(settled.cancellation?.delivery, "delivered");
  assert.equal(settled.cancellation?.receiptId, receipt.cancellation?.receiptId);
  assert.equal(deliveries, 2);
});

test("failing older cancellation intents cannot starve a later healthy request", async () => {
  const f = await fixture(); await f.stop();
  const ids = Array.from({ length: 65 }, () => randomUUID());
  const healthy = ids[64];
  let delivered = false;
  const api = new IntegrationApi(store, { accept: f.members.accept.bind(f.members), requestStatus: f.members.requestStatus.bind(f.members), async cancelPending(input, deadline) {
    assert.equal(typeof deadline, "number");
    assert.ok(deadline! > Date.now() && deadline! <= Date.now() + 10_000, "delivery gets a bounded actual RPC deadline");
    const { requestId } = input as { requestId: string };
    if (requestId !== healthy) throw new Error("unavailable old workflow");
    delivered = true;
  } });
  try {
    for (const requestId of ids) {
      await store.recordAcceptance({ ownerId: f.ownerId, conversationId: f.conversationId, requestId, text: "cancel fairness" });
      await api.cancel({ ownerId: f.ownerId, conversationId: f.conversationId, requestId });
    }
    await api.flushCancellations();
    assert.equal(delivered, false, "first bounded batch contains only older requests");
    await api.flushCancellations();
    assert.equal(delivered, true, "retry order must advance beyond permanently failing oldest batch");
  } finally {
    await pool.query("UPDATE birbcrew_ts.integration_cancellations SET delivered_at=clock_timestamp() WHERE conversation_id=$1", [f.conversationId]);
  }
});

test("concurrent completion and cancellation preserve one committed result", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests`;
  const input = { ownerId: f.ownerId, conversationId: f.conversationId, requestId, text: "concurrent finish" };
  const accepted = await (await f.api(path, { requestId, text: input.text })).json();
  assert.equal(accepted.status, "accepted");
  const [, cancellation] = await Promise.all([
    f.finish(input),
    f.api(path + "/" + requestId + "/cancel", {}).then(async response => {
      assert.equal(response.status, 202);
      return response.json();
    }),
  ]);
  assert.ok(cancellation.cancellation.receiptId);
  const result = await (await f.api(path + "/" + requestId)).json();
  assert.equal(result.status, "completed");
  assert.equal(result.result.text, "original result: concurrent finish");
  assert.equal(result.cancellation.receiptId, cancellation.cancellation.receiptId);
  await new IntegrationApi(store, f.members).flushCancellations();
  const repeated = await (await f.api(path, { requestId, text: input.text })).json();
  assert.equal(repeated.status, "completed");
  assert.deepEqual(repeated.result, result.result);
  assert.equal(f.counts().effects, 1);
  assert.equal((await pool.query("SELECT count(*)::integer n FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2", [f.conversationId, requestId])).rows[0].n, 1);
});

test("legacy committed turn without an admission retains result and cancellation receipt", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const requestId = randomUUID(), path = `/v1/conversations/${f.conversationId}/requests/${requestId}`;
  const input = { ownerId: f.ownerId, conversationId: f.conversationId, requestId, text: "legacy accepted before migration" };
  // An already-running pre-v1 workflow can commit a turn without executing the
  // new admission activity after migration 17 has finished its backfill.
  const turn = await store.beginTurn(input, { workflowRunId: randomUUID(), activityId: "legacy-workflow", attempt: 1 });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  await store.commitTurn({ ownerId: f.ownerId, conversationId: f.conversationId, requestId, token: turn.token,
    reply: "legacy original result", checkpoint: { version: 1, engine: "pi", state: {} } });
  assert.equal((await pool.query("SELECT count(*)::integer n FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2", [f.conversationId, requestId])).rows[0].n, 0);
  const response = await f.api(path); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "completed");
  assert.equal(result.result.text, "legacy original result");
  const before = f.counts();
  const cancel = await f.api(path + "/cancel", {}); assert.equal(cancel.status, 202);
  const receipt = await cancel.json();
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.result, result.result);
  assert.ok(receipt.cancellation.receiptId);
  assert.equal((await pool.query("SELECT count(*)::integer n FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2", [f.conversationId, requestId])).rows[0].n, 1);
  const repeated = await (await f.api(path + "/cancel", {})).json();
  assert.equal(repeated.cancellation.receiptId, receipt.cancellation.receiptId);
  await new IntegrationApi(store, f.members).flushCancellations();
  assert.deepEqual(f.counts(), before, "legacy result and cancellation reconciliation cannot execute work");
});


test("legacy requests awaiting a human decision report waiting without mutating admission", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const requestId = randomUUID(), key = { ownerId: f.ownerId, conversationId: f.conversationId, requestId };
  const turn = await store.beginTurn({ ...key, text: "legacy human decision" },
    { workflowRunId: randomUUID(), activityId: "legacy-wait", attempt: 1 });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const conversation = await store.getConversation({ ownerId: f.ownerId, conversationId: f.conversationId });
  const approvals = new ApprovalStore(pool);
  const proposal = await approvals.propose({ ...key, memberId: conversation.memberId, token: turn.token,
    invocationId: requestId, nativeCallId: "legacy-call", toolName: "record_work_item",
    arguments: { operation_id: requestId, note: "not exposed" } });
  const path = `/v1/conversations/${f.conversationId}/requests/${requestId}`;
  const counts = f.counts();
  for (let i = 0; i < 2; i++) {
    const response = await f.api(path); assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.status, "waiting");
    assert.equal(JSON.stringify(receipt).includes("not exposed"), false);
  }
  assert.equal((await pool.query("SELECT count(*)::integer n FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2", [f.conversationId, requestId])).rows[0].n, 0);
  assert.deepEqual(f.counts(), counts, "read-only status must not materialize or execute admissions");
  assert.equal((await f.api(path, undefined, f.stranger)).status, 404);
  await approvals.decide({ ...key, memberId: conversation.memberId, invocationId: requestId,
    nativeCallId: proposal.nativeCallId, approvalId: proposal.approvalId, argumentDigest: proposal.argumentDigest,
    version: proposal.version, choice: "deny" });
  assert.equal((await (await f.api(path)).json()).status, "running", "resolved decision no longer waits");
});


test("v1 status reconciles an unstarted admission after terminal workflow without dispatch", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const key = { ownerId: f.ownerId, conversationId: f.conversationId, requestId: randomUUID() };
  const input = { ...key, text: "SQL commit before admission acknowledgement was lost" };
  await store.recordAcceptance(input);
  let describes = 0;
  const temporal = {
    connection: { async withDeadline(deadline: number, action: () => Promise<unknown>) {
      assert.ok(deadline > Date.now() && deadline <= Date.now() + 10_000); return action();
    } },
    workflow: { getHandle() { return { async describe() { describes++; return { status: { name: "FAILED" } }; } }; } },
  } as unknown as Client;
  const members = new MemberClient(store, temporal);
  const api = new IntegrationApi(store, members);
  const receipt = await api.status(key);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.reason, "admission_unconfirmed");
  assert.equal(receipt.result, undefined);
  assert.deepEqual(await api.status(key), receipt);
  assert.equal(describes, 1, "terminal receipt no longer requires workflow observation");
  await assert.rejects(api.submit(input), { code: "request_rejected" });
  await assert.rejects(api.status({ ...key, ownerId: randomUUID() }), { code: "not_found" });
  assert.equal(describes, 1, "wrong-owner reads and terminal retries cannot dispatch");
  assert.equal((await pool.query("SELECT count(*)::integer n FROM birbcrew_ts.turns WHERE conversation_id=$1", [key.conversationId])).rows[0].n, 0);
});

async function serve(gatewayStore: MemberStore, members: MemberClient) {
  const token: string = randomUUID();
  const server = createGateway(gatewayStore, members, { [createHash("sha256").update(token).digest("hex")]: randomUUID() });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return {
    get: (path: string, credential = token) => fetch(`http://127.0.0.1:${address.port}${path}`,
      { headers: { Authorization: "Bearer " + credential }, signal: AbortSignal.timeout(10_000) }),
    async stop() { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; },
  };
}

test("v1 health is authenticated, strict and reports every ready dependency", async (t) => {
  const { rows: [{ version }] } = await pool.query("SELECT max(version)::integer AS version FROM birbcrew_ts.schema_versions");
  const gateway = await serve(store, { async temporalReachable() {} } as unknown as MemberClient); t.after(gateway.stop);
  assert.equal((await gateway.get("/v1/health", "invalid")).status, 401);
  const response = await gateway.get("/v1/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { apiVersion: "1", status: "ready", dependencies: {
    database: { status: "ready", schemaVersion: version }, temporal: { status: "ready" } } });
  assert.equal((await gateway.get("/v1/health?verbose=1")).status, 400);
  assert.equal((await gateway.get("/health")).status, 404, "health is versioned-only");
});

test("v1 health answers 503 with the same shape, bounded and without dependency detail", { timeout: 20_000 }, async (t) => {
  const { rows: [{ version }] } = await pool.query("SELECT max(version)::integer AS version FROM birbcrew_ts.schema_versions");
  const secret = "do-not-leak-" + randomUUID();
  const refused = new Pool({ connectionString: `postgresql://probe:${secret}@127.0.0.1:1/absent` });
  t.after(() => refused.end());
  const cases = [
    { store, members: { async temporalReachable() { throw new Error("connect ECONNREFUSED " + secret); } },
      dependencies: { database: { status: "ready", schemaVersion: version }, temporal: { status: "unavailable" } } },
    { store: new MemberStore(refused), members: { async temporalReachable() {} },
      dependencies: { database: { status: "unavailable", schemaVersion: null }, temporal: { status: "ready" } } },
    // Both dependencies hang: the probes run concurrently and each is cut off.
    { store: new MemberStore({ connect: () => new Promise(() => {}) } as unknown as Pool), members: { temporalReachable: () => new Promise(() => {}) },
      dependencies: { database: { status: "unavailable", schemaVersion: null }, temporal: { status: "unavailable" } } },
  ];
  for (const { store: target, members, dependencies } of cases) {
    const gateway = await serve(target, members as unknown as MemberClient);
    try {
      const started = Date.now();
      const response = await gateway.get("/v1/health");
      assert.ok(Date.now() - started < probeTimeout * 1.5, "both dependency probes run concurrently, each bounded");
      assert.equal(response.status, 503);
      const report = await response.json();
      assert.deepEqual(report, { apiVersion: "1", status: "not_ready", dependencies });
      const text = JSON.stringify(report);
      assert.ok(!text.includes(secret) && !text.includes("ECONNREFUSED") && !text.includes("127.0.0.1"), text);
    } finally { await gateway.stop(); }
  }
});

test("v1 health gives back a blocked probe's pooled connection so other routes keep serving", { timeout: 20_000 }, async (t) => {
  const single = new Pool({ connectionString: url, max: 1 });
  const gateway = await serve(new MemberStore(single), { async temporalReachable() {} } as unknown as MemberClient);
  t.after(async () => { await gateway.stop(); await single.end(); });
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE birbcrew_ts.schema_versions IN ACCESS EXCLUSIVE MODE");
    const blocked = await gateway.get("/v1/health");
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).dependencies.database.status, "unavailable");
    assert.equal((await gateway.get("/v1/members")).status, 200, "the only pooled connection was not stranded on the lock");
    // The server cancels the blocked read itself; abandoning it client-side would leave a backend waiting on the lock.
    const waiting = async () => (await pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM birbcrew_ts.schema_versions'`)).rows[0].n;
    for (const started = Date.now(); await waiting() && Date.now() - started < probeTimeout;) await delay(50);
    assert.equal(await waiting(), 0, "no probe backend is left waiting while the lock is still held");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
});

test("v1 health on a saturated pool answers 503 within its bound and queues at most one probe", { timeout: 30_000 }, async (t) => {
  const single = new Pool({ connectionString: url, max: 1 });
  const gateway = await serve(new MemberStore(single), { async temporalReachable() {} } as unknown as MemberClient);
  t.after(async () => { await gateway.stop(); await single.end(); });
  const statements: string[] = [], seen = new WeakSet<object>();
  single.on("acquire", client => {
    if (seen.has(client)) return; seen.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      statements.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
      return query(...args);
    }) as typeof client.query;
  });
  const held = await single.connect();
  let released = false;
  try {
    const health = async () => {
      const started = Date.now(), response = await gateway.get("/v1/health");
      assert.ok(Date.now() - started < probeTimeout * 1.5, "health is bounded while the pool is saturated");
      assert.equal(response.status, 503);
      assert.equal((await response.json()).dependencies.database.status, "unavailable");
    };
    // The gateway's cancellation flusher queues one scan of its own on the saturated pool.
    for (const started = Date.now(); !single.waitingCount && Date.now() - started < 3_000;) await delay(10);
    assert.equal(single.waitingCount, 1);
    const calls = [health(), health()];
    await delay(probeTimeout / 2);
    await Promise.all([...calls, health()]);
    await health();
    assert.equal(single.waitingCount, 2, "concurrent and repeated health calls share one queued probe");
    const real = gateway.get("/v1/members");
    for (const started = Date.now(); single.waitingCount < 3 && Date.now() - started < probeTimeout;) await delay(10);
    assert.equal(single.waitingCount, 3);
    statements.length = 0;
    held.release(); released = true;
    assert.equal((await real).status, 200);
    assert.ok(!statements.some(text => text.includes("schema_versions")), "the abandoned probe ran no query ahead of the real request");
    assert.equal((await gateway.get("/v1/health")).status, 200, "the next probe starts afresh once the pool frees");
  } finally { if (!released) held.release(); }
});

test("v1 listings page an owner's members and conversations without gaps, duplicates or text", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const { memberId: first } = await store.getConversation({ ownerId: f.ownerId, conversationId: f.conversationId });
  const second = await store.spawn({ ownerId: f.ownerId, requestId: randomUUID(), engine: "claude", profile: "fixture-claude" });
  const owned = new Map<string, string>([[f.conversationId, first]]);
  for (let i = 0; i < 4; i++) {
    const conversationId = randomUUID(), memberId = i % 2 ? first : second.memberId;
    await store.openConversation({ ownerId: f.ownerId, conversationId, memberId }); owned.set(conversationId, memberId);
  }
  const other = randomUUID(), otherMember = await store.spawn({ ownerId: other, requestId: randomUUID(), engine: "pi", profile: "fixture-v1" });
  const otherConversation = randomUUID();
  await store.openConversation({ ownerId: other, conversationId: otherConversation, memberId: otherMember.memberId });
  const text = "listing must not expose " + randomUUID();
  const turn = await store.beginTurn({ ownerId: f.ownerId, conversationId: f.conversationId, requestId: randomUUID(), text },
    { workflowRunId: randomUUID(), activityId: "listing", attempt: 1 });
  assert.equal(turn.kind, "start");
  // A conversation predating the public event ledger, as migration 004 marks them.
  const legacy = randomUUID();
  await store.openConversation({ ownerId: f.ownerId, conversationId: legacy, memberId: first }); owned.set(legacy, first);
  await pool.query("INSERT INTO birbcrew_ts.public_snapshots (conversation_id,history_complete,state) VALUES ($1,false,'{}')", [legacy]);
  assert.equal((await f.api(`/v1/conversations/${legacy}`)).status, 409);

  async function all(path: string, key: "members" | "conversations", credential?: string) {
    const rows: Record<string, unknown>[] = [], sizes: number[] = [];
    for (let next: string | null = null, pages = 0; pages === 0 || next; pages++) {
      assert.ok(pages < 10, "pagination terminates");
      const separator = path.includes("?") ? "&" : "?";
      const response = await f.api(next ? `${path}${separator}after=${next}` : path, undefined, credential);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ["apiVersion", key, "next"].sort());
      assert.equal(JSON.stringify(body).includes(text), false, "listings never carry message text");
      rows.push(...body[key]); sizes.push(body[key].length); next = body.next;
    }
    return { rows, sizes };
  }

  const expectedMembers = [{ memberId: first, engine: "pi", profile: "fixture-v1" },
    { memberId: second.memberId, engine: "claude", profile: "fixture-claude" }].sort((a, b) => a.memberId < b.memberId ? -1 : 1);
  assert.deepEqual((await all("/v1/members", "members")).rows, expectedMembers);
  const members = await all("/v1/members?limit=1", "members");
  assert.deepEqual(members.sizes, [1, 1], "an exactly full final page reports no next cursor");
  assert.deepEqual(members.rows, expectedMembers);

  const conversations = await all("/v1/conversations?limit=2", "conversations");
  assert.deepEqual(conversations.sizes, [2, 2, 2]);
  assert.deepEqual(conversations.rows.map(row => row.conversationId), [...owned.keys()].sort(), "stable order, no gaps or duplicates");
  for (const row of conversations.rows) {
    const member = expectedMembers.find(m => m.memberId === owned.get(row.conversationId as string))!;
    assert.deepEqual(row, { conversationId: row.conversationId, memberId: member.memberId, engine: member.engine, profile: member.profile,
      phase: row.conversationId === f.conversationId ? "running" : row.conversationId === legacy ? null : "idle" });
  }

  const filtered = await all(`/v1/conversations?limit=1&memberId=${first.toUpperCase()}`, "conversations");
  assert.deepEqual(filtered.rows.map(row => row.conversationId),
    [...owned].filter(([, memberId]) => memberId === first).map(([id]) => id).sort());
  assert.ok(filtered.rows.every(row => row.memberId === first));

  // Another owner's rows never appear, and naming them is indistinguishable from naming nothing.
  const listed = JSON.stringify([(await all("/v1/members", "members")).rows, conversations.rows]);
  assert.ok(!listed.includes(other) && !listed.includes(otherMember.memberId) && !listed.includes(otherConversation));
  for (const memberId of [otherMember.memberId, randomUUID()]) {
    const response = await f.api(`/v1/conversations?memberId=${memberId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { apiVersion: "1", conversations: [], next: null });
  }
  // A cursor naming another owner's row is only a position: it neither fails nor reveals that row.
  const foreign = await f.api(`/v1/conversations?after=${Buffer.from("conversation:" + otherConversation).toString("base64url")}`);
  assert.equal(foreign.status, 200);
  assert.deepEqual((await foreign.json()).conversations.map((row: { conversationId: string }) => row.conversationId),
    [...owned.keys()].sort().filter(id => id > otherConversation));
  assert.deepEqual((await all("/v1/members", "members", f.stranger)).rows, []);
  assert.deepEqual((await all(`/v1/conversations?memberId=${first}`, "conversations", f.stranger)).rows, []);
  assert.equal((await f.api("/v1/members", undefined, "invalid")).status, 401);
});

test("v1 listings reject unknown, repeated, out-of-range and forged query parameters", async (t) => {
  const f = await fixture(); t.after(f.stop);
  await store.spawn({ ownerId: f.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture-v1" });
  const { memberId } = await store.getConversation({ ownerId: f.ownerId, conversationId: f.conversationId });
  await store.openConversation({ ownerId: f.ownerId, conversationId: randomUUID(), memberId });
  const memberCursor = (await (await f.api("/v1/members?limit=1")).json()).next;
  const conversationCursor = (await (await f.api("/v1/conversations?limit=1")).json()).next;
  assert.ok(memberCursor && conversationCursor);
  assert.equal((await f.api("/v1/members?limit=100")).status, 200, "maximum limit is inclusive");
  const forged = (value: string) => Buffer.from(value).toString("base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function cursors(kind: string, cursor: string, otherListing: string) {
    const id = Buffer.from(cursor, "base64url").toString().slice(kind.length + 1);
    // Flipping an unused trailing bit decodes to identical bytes; only the canonical encoding is accepted.
    const altered = cursor.slice(0, -1) + alphabet[alphabet.indexOf(cursor.at(-1)!) ^ 1];
    assert.ok(Buffer.from(altered, "base64url").equals(Buffer.from(cursor, "base64url")));
    return ["", "not-a-cursor", otherListing, forged(kind + ":" + id.toUpperCase()), forged(kind + ":" + id + ":x"),
      forged("x".repeat(kind.length) + ":" + id), cursor + "=", altered].map(value => "after=" + value);
  }
  const common = ["limit=0", "limit=101", "limit=abc", "limit=1.5", "limit=01", "limit=", "limit=1&limit=2", `ownerId=${f.ownerId}`, "unknown=1"];
  for (const query of [...common, ...cursors("member", memberCursor, conversationCursor), `memberId=${memberId}`]) {
    assert.equal((await f.api("/v1/members?" + query)).status, 400, query);
  }
  for (const query of [...common, ...cursors("conversation", conversationCursor, memberCursor), "memberId=not-a-uuid",
    `memberId=${memberId}&memberId=${memberId}`]) {
    assert.equal((await f.api("/v1/conversations?" + query)).status, 400, query);
  }
  for (const path of ["/members", "/conversations"]) assert.equal((await f.api(path)).status, 404, "listings are versioned-only");
});

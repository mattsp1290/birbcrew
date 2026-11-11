import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type { MemberClient } from "../../src/service/client.ts";
import { MemberStore } from "../../src/service/store.ts";
import { createGateway } from "../../src/service/gateway.ts";
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
  const api = new IntegrationApi(store, { accept: f.members.accept.bind(f.members), async cancelPending() {
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
  const api = new IntegrationApi(store, { accept: f.members.accept.bind(f.members), async cancelPending(input, deadline) {
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

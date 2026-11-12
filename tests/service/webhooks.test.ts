import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { appendAudit } from "../../src/service/audit.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { InstallationRecovery, readRecoveryManifest, type RecoveryHooks, type RecoveryPins } from "../../src/service/recovery.ts";
import { FileRecoveryFence } from "../../src/service/recovery-fence.ts";
import { MemberStore } from "../../src/service/store.ts";
import type { ResolvedAddress, TargetPolicy } from "../../src/service/webhook-target.ts";
import { retryDelayMs, WebhookApi, WebhookDispatcher, webhookKindNames, webhookLimits, type Clock } from "../../src/service/webhooks.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
after(() => pool.end());
const sql = new URL("../../src/service/sql/", import.meta.url);

/** A fresh database, migrated up to `version`, dropped after the test. Every test that enables an
 * endpoint uses its own, so no other suite's gateway finds one to deliver to. */
async function databaseAt(t: TestContext, version = Infinity) {
  const name = "webhooks_" + randomUUID().replaceAll("-", "");
  await pool.query("CREATE DATABASE " + name);
  const target = new URL(url!); target.pathname = "/" + name;
  const db = new Pool({ connectionString: target.href });
  // Not FORCE: end() resolves before its connections close; a plain DROP waits for them.
  t.after(async () => { await db.end(); await pool.query("DROP DATABASE " + name); });
  if (version === Infinity) {
    await new MemberStore(db).migrate();
    return db;
  }
  await db.query("CREATE SCHEMA birbcrew_ts");
  await db.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version) continue;
    await db.query(await readFile(new URL(file, sql), "utf8"));
    await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return db;
}

type Received = { path: string; headers: IncomingHttpHeaders; body: string; at: number };
type Reply = number | "hang";
/** A local receiver. `reply` decides each answer by path; "hang" never answers. */
async function receiver(t: TestContext) {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const state = { reply: (_path: string): Reply => 200 };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    received.push({ path: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString(), at: Date.now() });
    const answer = state.reply(request.url!);
    if (answer !== "hang") response.writeHead(answer).end("ok");
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); });
  const { port } = server.address() as { port: number };
  return { received, state, url: (name: string) => `http://127.0.0.1:${port}/${name}`, port };
}

const insecure: TargetPolicy = { allowInsecure: true };
const signature = (secret: string, timestamp: string, body: string) =>
  "v1=" + createHmac("sha256", Buffer.from(secret, "utf8")).update(timestamp + "." + body).digest("hex");

/** A fresh database, an owner with a member, a settable clock and a dispatcher factory. */
async function harness(t: TestContext, options: { policy?: TargetPolicy } = {}) {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  let now = new Date();
  const clock: Clock = () => new Date(now);
  const ownerId = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const policy = options.policy ?? insecure;
  const api = new WebhookApi(store, clock, policy);
  const conversation = async (owner = ownerId, memberId = member.memberId) => {
    const conversationId = randomUUID();
    await store.openConversation({ ownerId: owner, memberId, conversationId });
    return conversationId;
  };
  return {
    db, store, ownerId, member, api, clock, conversation,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    dispatcher: (extra: Partial<ConstructorParameters<typeof WebhookDispatcher>[0]> = {}) =>
      new WebhookDispatcher({ store, owners: [ownerId], clock, policy, ...extra }),
    create: async (url: string, kinds: readonly string[] = webhookKindNames, owner = ownerId) =>
      (await api.create(owner, { requestId: randomUUID(), url, kinds })) as Awaited<ReturnType<WebhookApi["create"]>> & { secret: string },
    /** A request.finished row, as commitTurn or a rejection appends it. */
    async finished(conversationId: string, status = "completed", owner = ownerId, memberId = member.memberId) {
      const requestId = randomUUID();
      await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: owner, memberId, conversationId, requestId,
        payload: { status: status as "completed" } }));
      return requestId;
    },
    deliveries: async (webhookId: string) => (await db.query(`SELECT event_id::text AS "eventId", kind, state, reason, attempts,
      last_outcome AS outcome, last_status_code AS status, next_attempt_at AS "nextAttemptAt" FROM birbcrew_ts.webhook_deliveries
      WHERE webhook_id=$1 ORDER BY event_id`, [webhookId])).rows,
    endpoint: async (webhookId: string) => (await db.query("SELECT * FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1", [webhookId])).rows[0],
  };
}
async function pass(...dispatchers: WebhookDispatcher[]) {
  await Promise.all(dispatchers.map(d => d.tick()));
  await Promise.all(dispatchers.map(d => d.idle()));
}

async function gateway(t: TestContext, store: MemberStore, clock: Clock, webhookTargets: TargetPolicy) {
  const token = randomUUID(), stranger = randomUUID();
  const ownerId = "owner-" + randomUUID(), strangerId = "owner-" + randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const members = {} as MemberClient;
  const server = createGateway(store, members, { [hash(token)]: ownerId, [hash(stranger)]: strangerId }, { clock, webhookTargets });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const stop = async () => {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
    await server.stopped();
  };
  t.after(stop);
  async function api(path: string, body?: unknown, credential: string = token, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : undefined, text };
  }
  return { ownerId, strangerId, token, stranger, api, stop };
}

test("the webhook routes are strict, idempotent, owner-scoped and bounded, and return the secret once", async (t) => {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  // hooks.example.com resolves only here. No test event is deliverable, so nothing is ever sent to it.
  const answers: Record<string, ResolvedAddress[]> = { "hooks.example.com": [{ address: "93.184.215.14", family: 4 }],
    "internal.example.com": [{ address: "10.0.0.7", family: 4 }], "metadata.example.com": [{ address: "169.254.169.254", family: 4 }] };
  const g = await gateway(t, store, () => new Date(), { allowInsecure: false, lookup: async host => answers[host] ?? [] });
  const body = { requestId: randomUUID(), url: "https://hooks.example.com/crew/in?team=7", kinds: ["request.finished", "approval.pending"] };
  const created = await g.api("/v1/webhooks", body);
  assert.equal(created.status, 201, created.text);
  const { webhookId, secret, createdAt } = created.body;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.text.includes(secret), true);
  const view = { apiVersion: "1", webhookId, url: body.url, host: "hooks.example.com", kinds: ["approval.pending", "request.finished"],
    state: "enabled", disabledReason: null, consecutiveFailures: 0, createdAt };
  assert.deepEqual({ ...created.body, secret: undefined }, { ...view, secret: undefined });
  // A replay is the same endpoint without its secret, which no route returns again.
  assert.deepEqual(await g.api("/v1/webhooks", { ...body, kinds: [...body.kinds].reverse() }), { status: 201, body: view, text: JSON.stringify(view) });
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, url: "https://hooks.example.com/other" })).body, { error: "conflict" });
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, kinds: ["request.finished"] })).body, { error: "conflict" });
  const path = `/v1/webhooks/${webhookId}`;
  assert.deepEqual((await g.api(path)).body, view);
  assert.deepEqual((await g.api(`/v1/webhooks/${webhookId.toUpperCase()}`)).body, view);
  assert.deepEqual((await g.api("/v1/webhooks")).body, { apiVersion: "1", webhooks: [view], nextAfter: webhookId, hasMore: false });
  for (const response of [await g.api(path), await g.api("/v1/webhooks")]) assert.equal(response.text.includes(secret), false);

  const fresh = (fields: Record<string, unknown>) => ({ requestId: randomUUID(), url: "https://hooks.example.com/x", kinds: ["request.finished"], ...fields });
  for (const invalid of [fresh({ ownerId: g.ownerId }), fresh({ secret: "chosen" }), fresh({ kinds: [] }), fresh({ kinds: ["request.finished", "request.finished"] }),
    fresh({ kinds: ["member.spawned"] }), fresh({ kinds: "request.finished" }), fresh({ url: 7 }), fresh({ url: "" }), fresh({ requestId: "nope" }),
    { url: "https://hooks.example.com/x", kinds: ["request.finished"] }]) {
    assert.deepEqual(await g.api("/v1/webhooks", invalid), { status: 400, body: { error: "invalid_input" }, text: '{"error":"invalid_input"}' },
      JSON.stringify(invalid));
  }
  // The target is checked before anything is written, and the reason is not reported.
  for (const target of ["http://hooks.example.com/x", "https://user:pw@hooks.example.com/x", "https://hooks.example.com/x#f", "https://127.0.0.1/x",
    "https://169.254.169.254/latest", "https://internal.example.com/x", "https://metadata.example.com/x", "https://unknown.example.com/x"]) {
    assert.deepEqual((await g.api("/v1/webhooks", fresh({ url: target }))).body, { error: "target_refused" }, target);
  }
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.webhook_endpoints")).rows[0].n, 1);

  // Another owner's endpoint is 404 on every route, and their list is empty.
  for (const [route, payload, method] of [[path, undefined, "GET"], [path + "/enable", {}, "POST"], [path + "/disable", {}, "POST"],
    [path, undefined, "DELETE"], [path + "/deliveries", undefined, "GET"]] as const) {
    assert.deepEqual((await g.api(route, payload, g.stranger, method)).body, { error: "not_found" }, `${method} ${route}`);
  }
  assert.deepEqual((await g.api("/v1/webhooks", undefined, g.stranger)).body.webhooks, []);
  assert.deepEqual((await g.api("/v1/webhooks", body, g.stranger)).status, 201, "a requestId is scoped to its owner");
  assert.equal((await g.api("/v1/webhooks", undefined, "invalid")).status, 401);
  assert.equal((await g.api("/v1/webhooks", {}, g.token, "PUT")).status, 405);
  assert.equal((await g.api(path + "/enable", { force: true })).status, 400);
  assert.equal((await g.api(path + "/deliveries", {})).status, 405);
  assert.equal((await g.api("/webhooks")).status, 404);
  for (const query of ["?limit=0", "?limit=101", "?before=0", "?before=-1", "?before=9223372036854775808", "?after=1", "?limit=1&limit=2", "?__proto__=1"]) {
    assert.deepEqual((await g.api(path + "/deliveries" + query)).body, { error: "invalid_input" }, query);
  }
  for (const query of ["?after=not-a-uuid", "?limit=1&limit=1", "?limit=101", "?before=1"]) {
    assert.deepEqual((await g.api("/v1/webhooks" + query)).body, { error: "invalid_input" }, query);
  }
  assert.deepEqual((await g.api(path + "?x=1")).body, { error: "invalid_input" });
  assert.deepEqual((await g.api(path + "/deliveries")).body, { apiVersion: "1", deliveries: [], nextBefore: null, hasMore: false });

  // Lifecycle: repeating a state changes nothing; a tombstone erases the URL and the secret.
  const disabled = await g.api(path + "/disable", {});
  assert.deepEqual([disabled.status, disabled.body.state, disabled.body.disabledReason], [200, "disabled", "owner"]);
  assert.deepEqual(await g.api(path + "/disable", {}), disabled);
  assert.deepEqual((await g.api(path + "/enable", {})).body, view);
  const deleted = await g.api(path, undefined, g.token, "DELETE");
  assert.deepEqual(deleted.body, { ...view, url: null, state: "deleted" });
  assert.deepEqual((await db.query("SELECT url, secret, host FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1", [webhookId])).rows,
    [{ url: null, secret: null, host: "hooks.example.com" }]);
  assert.deepEqual(await g.api(path, undefined, g.token, "DELETE"), deleted);
  for (const action of ["/enable", "/disable"]) assert.deepEqual((await g.api(path + action, {})).body, { error: "webhook_deleted" });
  assert.deepEqual((await g.api("/v1/webhooks", body)).body, { error: "webhook_deleted" }, "a replay never revives a deleted endpoint");

  // At most ten enabled endpoints: an eleventh create or a re-enable past the limit is refused.
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push((await g.api("/v1/webhooks", fresh({}))).body.webhookId);
  assert.deepEqual((await g.api("/v1/webhooks", fresh({}))).body, { error: "webhook_limit" });
  await g.api(`/v1/webhooks/${ten[0]}/disable`, {});
  const eleventh = await g.api("/v1/webhooks", fresh({}));
  assert.equal(eleventh.status, 201);
  assert.deepEqual((await g.api(`/v1/webhooks/${ten[0]}/enable`, {})).body, { error: "webhook_limit" });
  const page = (await g.api("/v1/webhooks?limit=5")).body;
  assert.deepEqual([page.webhooks.length, page.hasMore], [5, true]);
  const rest = (await g.api("/v1/webhooks?after=" + page.nextAfter)).body;
  assert.equal(page.webhooks.length + rest.webhooks.length, 12);

  // The trail names the owner and the host, never the URL path or the secret.
  const audit = await g.api("/v1/audit?limit=1000");
  const rows = audit.body.events.filter((event: { payload: { webhookId?: string } }) => event.payload.webhookId === webhookId);
  assert.deepEqual(rows.map((event: Record<string, unknown>) => [event.type, event.actor, event.memberId, event.conversationId, event.payload]), [
    ["webhook.created", { kind: "owner", id: g.ownerId }, null, null,
      { webhookId, revision: 1, host: "hooks.example.com", kinds: ["approval.pending", "request.finished"] }],
    ["webhook.disabled", { kind: "owner", id: g.ownerId }, null, null, { webhookId, revision: 2, host: "hooks.example.com", reason: "owner" }],
    ["webhook.enabled", { kind: "owner", id: g.ownerId }, null, null, { webhookId, revision: 3, host: "hooks.example.com" }],
    ["webhook.deleted", { kind: "owner", id: g.ownerId }, null, null, { webhookId, revision: 4, host: "hooks.example.com" }],
  ]);
  const csv = (await g.api("/v1/audit?format=csv&limit=10000")).text;
  for (const exported of [audit.text, csv]) {
    assert.ok(!exported.includes(secret) && !exported.includes("/crew/in") && !exported.includes("team=7"));
  }
  assert.match(csv, new RegExp(`,webhook\\.created,owner,${g.ownerId},owner,${g.ownerId},,,,`));
  const capabilities = (await g.api("/v1/capabilities")).body;
  assert.deepEqual([capabilities.webhooks.route, capabilities.webhooks.kinds, capabilities.webhooks.maximumEnabledPerOwner, capabilities.webhooks.schemes],
    ["/v1/webhooks", ["approval.pending", "request.finished", "routine.firing_settled", "routine.disabled"], 10, ["https"]]);
  for (const type of ["approval.requested", "webhook.created", "webhook.enabled", "webhook.disabled", "webhook.deleted"]) {
    assert.ok(capabilities.audit.eventTypes.includes(type), type);
  }
});

test("the gateway runs the webhook dispatcher for the owners it serves and stops it when it closes", async (t) => {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  const r = await receiver(t);
  const g = await gateway(t, store, () => new Date(), insecure);
  const created = await g.api("/v1/webhooks", { requestId: randomUUID(), url: r.url("gateway"), kinds: ["request.finished"] });
  assert.equal(created.status, 201, created.text);
  const { memberId } = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const conversationId = randomUUID(), requestId = randomUUID();
  await store.openConversation({ ownerId: g.ownerId, memberId, conversationId });
  await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: g.ownerId, memberId, conversationId, requestId,
    payload: { status: "cancelled", reason: "predecessor_cancelled" } }));
  for (let i = 0; i < 200 && !r.received.length; i++) await delay(25);
  assert.equal(r.received.length, 1, "the gateway's own loop delivered it");
  const [item] = r.received;
  assert.equal(item.headers["crew-webhook-signature"], signature(created.body.secret, item.headers["crew-webhook-timestamp"] as string, item.body));
  assert.deepEqual(JSON.parse(item.body).status, "cancelled");
  for (let i = 0; i < 40; i++) {
    if ((await g.api(`/v1/webhooks/${created.body.webhookId}/deliveries`)).body.deliveries[0]?.state === "delivered") break;
    await delay(25);
  }
  assert.deepEqual((await g.api(`/v1/webhooks/${created.body.webhookId}/deliveries`)).body.deliveries.map((d: { state: string }) => d.state), ["delivered"]);
  // Closed, the gateway sends nothing more.
  await g.stop();
  await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: g.ownerId, memberId, conversationId, requestId: randomUUID(),
    payload: { status: "completed" } }));
  await delay(2_500);
  assert.equal(r.received.length, 1);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.webhook_deliveries")).rows[0].n, 1, "nor fans anything out");
});

test("concurrent creates never pass ten enabled endpoints, and a concurrent duplicate is one endpoint with one secret", async (t) => {
  const h = await harness(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => h.create(`http://127.0.0.1:9/${i}`)));
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 10);
  assert.ok(outcomes.every(o => o.status === "fulfilled" || (o.reason as { code?: string }).code === "webhook_limit"));
  const other = "owner-" + randomUUID();
  const body = { requestId: randomUUID(), url: "http://127.0.0.1:9/same", kinds: ["request.finished"] };
  const both = await Promise.all([h.api.create(other, body), h.api.create(other, body)]);
  assert.equal(new Set(both.map(view => view.webhookId)).size, 1);
  assert.equal(both.filter(view => "secret" in view).length, 1, "only the create that inserted it returns the secret");
  assert.equal((await h.db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type='webhook.created' AND owner_id=$1",
    [other])).rows[0].n, 1);
});

test("each kind is delivered once to each endpoint that selected it, signed, with identifiers and a status only", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const before = await h.conversation();
  await h.finished(before);
  const all = await h.create(r.url("all"));
  const finishedOnly = await h.create(r.url("finished"), ["request.finished"]);

  // A card that becomes pending, through the real proposal path.
  const carded = await h.conversation();
  const request: TurnRequest = { ownerId: h.ownerId, conversationId: carded, requestId: randomUUID(), text: "private prompt PROMPT-MARKER" };
  await h.store.recordAcceptance(request, ownerInitiator);
  const turn = await h.store.beginTurn(request);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const approval = await new ApprovalStore(h.db).propose({ ownerId: h.ownerId, memberId: h.member.memberId, conversationId: carded,
    requestId: request.requestId, token: turn.token, invocationId: request.requestId, nativeCallId: "card",
    toolName: "record_work_item", arguments: { operation_id: request.requestId, note: "private NOTE-MARKER" } });
  // A finished request, through the real commit path.
  const committed = await h.conversation();
  const done = { ownerId: h.ownerId, conversationId: committed, requestId: randomUUID(), text: "another PROMPT-MARKER" };
  await h.store.recordAcceptance(done, ownerInitiator);
  const started = await h.store.beginTurn(done);
  assert.equal(started.kind, "start"); if (started.kind !== "start") return;
  await h.store.commitTurn({ ownerId: h.ownerId, conversationId: committed, requestId: done.requestId, token: started.token,
    reply: "private REPLY-MARKER", checkpoint: { version: 1, engine: "pi", state: {} } });
  // The routine dispatcher's own facts; an owner's own disable is not delivered.
  const routineId = randomUUID(), quiet = randomUUID();
  await h.store.transaction(async db => {
    await appendAudit(db, { type: "routine.firing_settled", ownerId: h.ownerId, memberId: h.member.memberId,
      payload: { routineId, scheduledFor: "2031-01-06T10:15:00.000Z", status: "failed", reason: "turn_failed" } });
    await appendAudit(db, { type: "routine.disabled", ownerId: h.ownerId, memberId: h.member.memberId,
      payload: { routineId, revision: 2, reason: "consecutive_failures" } });
    await appendAudit(db, { type: "routine.disabled", ownerId: h.ownerId, memberId: h.member.memberId,
      payload: { routineId: quiet, revision: 2, reason: "owner" } });
  });

  const dispatcher = h.dispatcher();
  // One pass sends every due delivery: an endpoint's deliveries go one after another.
  await pass(dispatcher);
  const { rows: events } = await h.db.query(`SELECT event_id::text AS "eventId", event_type AS type,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt" FROM birbcrew_ts.audit_events
    WHERE event_type IN ('approval.requested','request.finished','routine.firing_settled','routine.disabled') ORDER BY event_id`);
  const [, card, finished, settled, exhausted] = events;
  const envelope = (event: { eventId: string; occurredAt: string }, kind: string, webhookId: string) =>
    ({ webhookId, eventId: event.eventId, kind, occurredAt: event.occurredAt, memberId: h.member.memberId });
  const expected = (webhookId: string) => [
    { ...envelope(card, "approval.pending", webhookId), conversationId: carded, requestId: request.requestId, approvalId: approval.approvalId,
      toolName: "record_work_item" },
    { ...envelope(finished, "request.finished", webhookId), conversationId: committed, requestId: done.requestId, status: "completed" },
    { ...envelope(settled, "routine.firing_settled", webhookId), routineId, scheduledFor: "2031-01-06T10:15:00.000Z", status: "failed" },
    { ...envelope(exhausted, "routine.disabled", webhookId), routineId, status: "consecutive_failures" },
  ];
  const at = (name: string) => r.received.filter(item => item.path === "/" + name);
  // The event before the endpoint existed is not sent; the others are, once each.
  assert.deepEqual(at("all").map(item => JSON.parse(item.body)), expected(all.webhookId));
  assert.deepEqual(at("finished").map(item => JSON.parse(item.body)), expected(finishedOnly.webhookId).slice(1, 2));
  const timestamp = String(Math.floor(h.clock().getTime() / 1000));
  for (const [item, secret, webhookId] of [...at("all").map(item => [item, all.secret, all.webhookId] as const),
    ...at("finished").map(item => [item, finishedOnly.secret, finishedOnly.webhookId] as const)]) {
    assert.equal(item.headers["crew-webhook-timestamp"], timestamp);
    assert.equal(item.headers["crew-webhook-signature"], signature(secret, timestamp, item.body));
    assert.equal(item.headers["crew-webhook-id"], webhookId);
    assert.equal(item.headers["crew-webhook-event"], JSON.parse(item.body).eventId);
    assert.equal(item.headers["content-type"], "application/json");
    assert.equal(item.headers.authorization ?? item.headers.cookie, undefined);
    assert.ok(Buffer.byteLength(item.body) <= 1024);
    for (const marker of ["PROMPT-MARKER", "NOTE-MARKER", "REPLY-MARKER", secret]) assert.ok(!item.body.includes(marker), marker);
  }
  // A signature made with the other endpoint's secret does not verify.
  assert.notEqual(at("finished")[0].headers["crew-webhook-signature"], signature(all.secret, timestamp, at("finished")[0].body));

  const listed = await h.api.deliveries(h.ownerId, all.webhookId, {});
  assert.deepEqual(listed.deliveries.map(d => [d.eventId, d.kind, d.state, d.attempts, d.lastOutcome, d.lastStatusCode, d.reason]),
    [[exhausted, "routine.disabled"], [settled, "routine.firing_settled"], [finished, "request.finished"], [card, "approval.pending"]]
      .map(([event, kind]) => [event.eventId, kind, "delivered", 1, "delivered", 200, null]));
  const older = await h.api.deliveries(h.ownerId, all.webhookId, { limit: "2", before: exhausted.eventId });
  assert.deepEqual([older.deliveries.map(d => d.eventId), older.nextBefore, older.hasMore], [[settled.eventId, finished.eventId], finished.eventId, true]);
  // Nothing more is sent on later passes.
  await pass(dispatcher);
  assert.equal(r.received.length, 5);
});

test("a failed attempt is retried with exponential backoff; the tenth gives up; a success resets the count", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  r.state.reply = () => 503;
  await h.finished(conversationId);
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  let [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome, delivery.status], ["pending", 1, "http_status", 503]);
  assert.equal(delivery.nextAttemptAt.getTime() - h.clock().getTime(), 30_000);
  // Not due yet: nothing is sent.
  await pass(dispatcher);
  assert.equal(r.received.length, 1);
  const waits: number[] = [];
  for (let attempt = 2; attempt <= webhookLimits.maximumAttempts; attempt++) {
    h.advance(delivery.nextAttemptAt.getTime() - h.clock().getTime());
    await pass(dispatcher);
    [delivery] = await h.deliveries(endpoint.webhookId);
    if (delivery.nextAttemptAt) waits.push(delivery.nextAttemptAt.getTime() - h.clock().getTime());
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
  assert.deepEqual(waits, [2, 3, 4, 5, 6, 7, 8, 9].map(retryDelayMs));
  assert.deepEqual([delivery.state, delivery.reason, delivery.attempts, delivery.outcome], ["failed", "attempts_exhausted", 10, "http_status"]);
  assert.equal(r.received.length, 10);
  assert.equal((await h.endpoint(endpoint.webhookId)).consecutive_failures, 1);
  h.advance(24 * 3_600_000);
  await pass(dispatcher);
  assert.equal(r.received.length, 10, "a failed delivery is never sent again");

  // The next one succeeds on its second attempt, which resets the count.
  await h.finished(conversationId);
  await pass(dispatcher);
  r.state.reply = () => 204;
  h.advance(30_000);
  await pass(dispatcher);
  const [, second] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([second.state, second.attempts, second.outcome, second.status], ["delivered", 2, "delivered", 204]);
  assert.equal((await h.endpoint(endpoint.webhookId)).consecutive_failures, 0);
});

test("ten deliveries given up in a row disable the endpoint and cancel what it has not delivered", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = () => 500;
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  for (let i = 0; i < 11; i++) await h.finished(conversationId);
  const dispatcher = h.dispatcher();
  for (let i = 0; i < 120 && (await h.endpoint(endpoint.webhookId)).state === "enabled"; i++) {
    await pass(dispatcher);
    h.advance(webhookLimits.retryCapMs);
  }
  const row = await h.endpoint(endpoint.webhookId);
  assert.deepEqual([row.state, row.disabled_reason, row.consecutive_failures, row.enabled_at], ["disabled", "consecutive_failures", 10, null]);
  // Each pass gave every due delivery one attempt; the eleventh still had its last to go.
  const deliveries = await h.deliveries(endpoint.webhookId);
  assert.deepEqual(deliveries.map(d => [d.state, d.reason, d.attempts]),
    [...Array(10).fill(["failed", "attempts_exhausted", 10]), ["cancelled", "endpoint_disabled", 9]]);
  assert.equal(r.received.length, 109);
  const { rows: audit } = await h.db.query(`SELECT actor_kind AS actor, actor_id AS "actorId", member_id AS "memberId", payload
    FROM birbcrew_ts.audit_events WHERE event_type='webhook.disabled'`);
  assert.deepEqual(audit, [{ actor: "system", actorId: null, memberId: null,
    payload: { webhookId: endpoint.webhookId, revision: 2, host: `127.0.0.1:${r.port}`, reason: "consecutive_failures" } }]);
  // A disabled endpoint receives nothing, including events that occur while it is disabled.
  await h.finished(conversationId);
  h.advance(webhookLimits.retryCapMs);
  await pass(dispatcher);
  assert.equal(r.received.length, 109);
  // Enabling resets the count; only events from then on are delivered.
  r.state.reply = () => 200;
  const enabled = await h.api.change(h.ownerId, endpoint.webhookId, "enable");
  assert.deepEqual([enabled.state, enabled.consecutiveFailures, enabled.disabledReason], ["enabled", 0, null]);
  const later = await h.finished(conversationId);
  await pass(dispatcher);
  assert.deepEqual(r.received.slice(109).map(item => JSON.parse(item.body).requestId), [later]);
});

test("a slow or dead endpoint holds up only its own deliveries, and a timeout is retried", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = path => path === "/slow" ? "hang" : 200;
  const slow = await h.create(r.url("slow"), ["request.finished"]);
  const fast = await h.create(r.url("fast"), ["request.finished"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  const dispatcher = h.dispatcher({ timeouts: { connectMs: 1_000, totalMs: 1_500 } });
  const started = Date.now();
  await dispatcher.tick();
  // The pass does not wait for the hanging endpoint, and the other endpoint already has its delivery.
  assert.ok(Date.now() - started < 1_000, "the pass returns before the slow attempt settles");
  for (let i = 0; i < 50 && !r.received.some(item => item.path === "/fast"); i++) await delay(20);
  const fastAt = r.received.find(item => item.path === "/fast")!.at;
  assert.ok(fastAt - started < 1_000);
  // While its attempt is in flight, this process does not start another for the slow endpoint.
  await h.finished(conversationId);
  await dispatcher.tick();
  await delay(300);
  assert.equal(r.received.filter(item => item.path === "/slow").length, 1);
  assert.deepEqual((await h.deliveries(slow.webhookId)).map(d => [d.state, d.attempts]), [["delivering", 1], ["pending", 0]]);
  assert.equal(r.received.filter(item => item.path === "/fast").length, 2, "the other endpoint's second delivery went at once");
  await dispatcher.idle();
  const [first] = await h.deliveries(slow.webhookId);
  assert.deepEqual([first.state, first.outcome, first.status, first.attempts], ["pending", "timeout", null, 1]);
  assert.deepEqual((await h.deliveries(fast.webhookId)).map(d => d.state).slice(0, 1), ["delivered"]);
  // A change committed while the receiver hangs commits at once: the change never waits on delivery.
  const blocker = await h.db.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE birbcrew_ts.webhook_deliveries, birbcrew_ts.webhook_endpoints, birbcrew_ts.webhook_cursor IN ACCESS EXCLUSIVE MODE");
    const committing = Date.now();
    await h.finished(conversationId);
    const request: TurnRequest = { ownerId: h.ownerId, conversationId: await h.conversation(), requestId: randomUUID(), text: "p" };
    await h.store.recordAcceptance(request, ownerInitiator);
    const turn = await h.store.beginTurn(request);
    assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
    await new ApprovalStore(h.db).propose({ ownerId: h.ownerId, memberId: h.member.memberId, conversationId: request.conversationId,
      requestId: request.requestId, token: turn.token, invocationId: request.requestId, nativeCallId: "card",
      toolName: "choose_next_step", arguments: {} });
    await h.store.commitTurn({ ownerId: h.ownerId, conversationId: request.conversationId, requestId: request.requestId, token: turn.token,
      reply: "r", checkpoint: { version: 1, engine: "pi", state: {} } });
    assert.ok(Date.now() - committing < 2_000, "audited changes never touch the webhook tables");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  await dispatcher.stop();
});

test("two dispatchers fan out and deliver each event once", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoints = [];
  for (let i = 0; i < 4; i++) endpoints.push(await h.create(r.url("e" + i), ["request.finished"]));
  const conversationId = await h.conversation();
  const one = h.dispatcher(), two = h.dispatcher();
  for (let round = 0; round < 6; round++) {
    await Promise.all([h.finished(conversationId), h.finished(conversationId), h.finished(conversationId)]);
    await pass(one, two);
  }
  for (let i = 0; i < 20; i++) await pass(one, two);
  const keys = r.received.map(item => `${item.headers["crew-webhook-id"]}/${item.headers["crew-webhook-event"]}`);
  assert.equal(keys.length, 4 * 18);
  assert.equal(new Set(keys).size, keys.length, "no endpoint received one event twice");
  for (const endpoint of endpoints) {
    const deliveries = await h.deliveries(endpoint.webhookId);
    assert.equal(deliveries.length, 18);
    assert.ok(deliveries.every(d => d.state === "delivered" && d.attempts === 1));
  }
});

test("an owner's events reach only that owner's endpoints, and only from owners the gateway serves", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const otherOwner = "owner-" + randomUUID();
  const otherMember = await h.store.spawn({ ownerId: otherOwner, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const mine = await h.create(r.url("mine"), ["request.finished"]);
  const theirs = await h.create(r.url("theirs"), ["request.finished"], otherOwner);
  await h.finished(await h.conversation());
  const theirConversation = await h.conversation(otherOwner, otherMember.memberId);
  await h.finished(theirConversation, "failed", otherOwner, otherMember.memberId);
  // This gateway serves only the first owner.
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  assert.deepEqual(r.received.map(item => item.path), ["/mine"]);
  assert.equal(JSON.parse(r.received[0].body).memberId, h.member.memberId);
  // The other owner's delivery waits, unattempted, for a gateway that serves them.
  assert.deepEqual((await h.deliveries(theirs.webhookId)).map(d => [d.state, d.attempts]), [["pending", 0]]);
  await pass(h.dispatcher({ owners: [otherOwner] }));
  assert.deepEqual(r.received.map(item => item.path), ["/mine", "/theirs"]);
  assert.equal(JSON.parse(r.received[1].body).status, "failed");
  assert.equal((await h.deliveries(mine.webhookId)).length, 1);
  await assert.rejects(h.api.get(otherOwner, mine.webhookId), { code: "not_found" });
  await assert.rejects(h.api.deliveries(otherOwner, mine.webhookId, {}), { code: "not_found" });
  await assert.rejects(h.api.change(otherOwner, mine.webhookId, "delete"), { code: "not_found" });
});

test("every delivery checks its target again and refuses one that now resolves to a refused address or scheme", async (t) => {
  let answer: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];
  const policy: TargetPolicy = { allowInsecure: true, lookup: async () => answer };
  const h = await harness(t, { policy });
  const r = await receiver(t);
  const named = await h.create(`http://receiver.test:${r.port}/named`, ["request.finished"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  assert.deepEqual(r.received.map(item => [item.path, item.headers.host]), [["/named", `receiver.test:${r.port}`]]);
  // The name now answers with a metadata address, alone or beside the allowed one.
  for (const rebound of [[{ address: "169.254.169.254", family: 4 }], [{ address: "127.0.0.1", family: 4 }, { address: "169.254.169.254", family: 4 }]] as ResolvedAddress[][]) {
    answer = rebound;
    await h.finished(conversationId);
    await pass(dispatcher);
    h.advance(webhookLimits.retryCapMs);
  }
  assert.equal(r.received.length, 1);
  assert.deepEqual((await h.deliveries(named.webhookId)).slice(1).map(d => [d.state, d.outcome]), [["pending", "address_refused"], ["pending", "address_refused"]]);
  // The operator turned insecure targets off: an http endpoint is refused at delivery.
  answer = [{ address: "127.0.0.1", family: 4 }];
  const plain = await h.create(r.url("plain"), ["request.finished"]);
  await h.finished(conversationId);
  await pass(h.dispatcher({ policy: { allowInsecure: false } }));
  assert.equal(r.received.filter(item => item.path === "/plain").length, 0);
  assert.deepEqual((await h.deliveries(plain.webhookId)).map(d => d.outcome), ["url_refused"]);
});

test("a restored installation disables every endpoint and cancels undelivered rows; a source that resumes keeps them", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = () => 503;
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const idle = await h.create(r.url("idle"), ["approval.pending"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  await pass(h.dispatcher());
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => d.state), ["pending"]);
  const directory = await mkdtemp(join(tmpdir(), "birbcrew-webhooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fence = new FileRecoveryFence(join(directory, "fence"));
  const recovery = new InstallationRecovery(h.db, fence);
  await recovery.initializeFence();
  const pins: RecoveryPins = { applicationCommit: "a".repeat(40), lockfileSha256: "b".repeat(64),
    temporal: { mode: "development-fixture", serverVersion: "1.10.0", persistenceFormat: "dev-sqlite-fixture" }, logicalNativeRoot: "/var/lib/birbcrew/native" };
  const hooks: RecoveryHooks = { quiesce: async () => {}, reconcile: async () => {}, snapshot: async dir => {
    const artifacts = [];
    for (const kind of ["application-postgres", "temporal-persistence", "native-volumes", "configuration"] as const) {
      await writeFile(join(dir, kind), "fixture " + kind); artifacts.push({ kind, file: kind });
    }
    return artifacts;
  } };
  // A held installation records nothing: neither a delivery nor an endpoint change.
  const bundle = join(directory, "bundle"); await mkdir(bundle);
  await recovery.capture(bundle, pins, hooks);
  const manifest = await readRecoveryManifest(bundle);
  assert.deepEqual([manifest.inventory.webhook_endpoints, manifest.inventory.webhook_deliveries, manifest.inventory.webhook_cursor], [2, 1, 1]);
  h.advance(webhookLimits.retryCapMs);
  await pass(h.dispatcher());
  assert.equal(r.received.length, 1);
  await assert.rejects(h.api.change(h.ownerId, endpoint.webhookId, "disable"), { code: "55000" });
  await assert.rejects(h.create(r.url("held")), { code: "55000" });
  // A source that resumes without a restore keeps its endpoints and their pending rows.
  await recovery.resume(hooks);
  assert.deepEqual([(await h.endpoint(endpoint.webhookId)).state, (await h.deliveries(endpoint.webhookId))[0].state], ["enabled", "pending"]);

  // The same database accepted as a restore: resuming it disables and cancels.
  const restoreBundle = join(directory, "restore"); await mkdir(restoreBundle);
  await recovery.capture(restoreBundle, pins, hooks);
  await recovery.acceptRestore(restoreBundle, pins, randomUUID());
  await recovery.resume(hooks, await readRecoveryManifest(restoreBundle));
  for (const id of [endpoint.webhookId, idle.webhookId]) {
    const row = await h.endpoint(id);
    assert.deepEqual([row.state, row.disabled_reason], ["disabled", "recovery_restore"]);
  }
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.state, d.reason]), [["cancelled", "recovery_restore"]]);
  const { rows: audit } = await h.db.query(`SELECT actor_kind AS actor, payload->>'webhookId' AS id, payload->>'reason' AS reason
    FROM birbcrew_ts.audit_events WHERE event_type='webhook.disabled' ORDER BY event_id`);
  assert.deepEqual(audit, [endpoint, idle].map(e => ({ actor: "system", id: e.webhookId, reason: "recovery_restore" })));
  const { rows: [cursor] } = await h.db.query(`SELECT c.last_event_id::text AS cursor, (SELECT max(event_id) FROM birbcrew_ts.audit_events)::text AS max
    FROM birbcrew_ts.webhook_cursor c`);
  assert.equal(cursor.cursor, cursor.max);
  // Nothing from before the restore is sent, even once the owner enables the endpoint again.
  r.state.reply = () => 200;
  await h.api.change(h.ownerId, endpoint.webhookId, "enable");
  const after = await h.finished(conversationId);
  h.advance(webhookLimits.retryCapMs);
  await pass(h.dispatcher());
  assert.deepEqual(r.received.slice(1).map(item => JSON.parse(item.body).requestId), [after]);
});

test("a fan-out never passes an audit row that commits after a higher one", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  const writer = await h.db.connect();
  try {
    await writer.query("BEGIN");
    const early = randomUUID();
    await appendAudit(writer, { type: "request.finished", ownerId: h.ownerId, memberId: h.member.memberId, conversationId, requestId: early,
      payload: { status: "failed" } });
    const late = await h.finished(conversationId); // a higher ID, committed first
    const dispatcher = h.dispatcher();
    const passing = pass(dispatcher);
    await delay(300);
    assert.equal(r.received.length, 0, "the pass waits for the open writer instead of moving the cursor past its ID");
    await writer.query("COMMIT");
    await passing;
    assert.deepEqual(r.received.map(item => JSON.parse(item.body).requestId).sort(), [early, late].sort());
  } finally { writer.release(); }
});

test("an abandoned attempt is retried after its lease, a stale holder records nothing, and a lost last attempt fails", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = () => "hang";
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  // The holder stops mid-request: the row stays leased, its attempt counted.
  const first = h.dispatcher();
  await first.tick();
  for (let i = 0; i < 50 && !r.received.length; i++) await delay(20);
  await first.stop();
  let [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome], ["delivering", 1, null]);
  const { rows: [{ lease }] } = await h.db.query("SELECT lease_until AS lease FROM birbcrew_ts.webhook_deliveries");
  // Before the lease ends nobody takes it; after it, another dispatcher sends the same event again.
  const second = h.dispatcher();
  await pass(second);
  assert.equal(r.received.length, 1);
  h.advance(webhookLimits.leaseMs);
  await second.tick();
  for (let i = 0; i < 50 && r.received.length < 2; i++) await delay(20);
  [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts], ["delivering", 2]);
  // The first holder, settling late, matches nothing: the row's attempt count and lease are no longer its own.
  const { rowCount } = await h.db.query(`UPDATE birbcrew_ts.webhook_deliveries SET state='pending', next_attempt_at=now(), lease_until=NULL,
      last_outcome='timeout' WHERE webhook_id=$1 AND state='delivering' AND attempts=1 AND lease_until=$2`, [endpoint.webhookId, lease]);
  assert.equal(rowCount, 0);
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.state, d.attempts]), [["delivering", 2]]);
  await second.stop();
  r.state.reply = () => 200;
  h.advance(webhookLimits.leaseMs);
  const third = h.dispatcher();
  await pass(third);
  [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome], ["delivered", 3, "delivered"]);
  assert.equal(r.received.length, 3);
  assert.equal(new Set(r.received.map(item => JSON.parse(item.body).eventId)).size, 1, "one event, sent again by each holder");
  // A last attempt whose holder vanished is never sent again: it fails as interrupted.
  await h.finished(conversationId);
  await h.db.query(`INSERT INTO birbcrew_ts.webhook_deliveries (webhook_id,event_id,kind,body,state,attempts,lease_until,last_attempt_at,created_at)
    SELECT $1, max(event_id), 'request.finished', '{}', 'delivering', 10, now() - interval '1 hour', now(), now()
      FROM birbcrew_ts.audit_events`, [endpoint.webhookId]);
  await pass(third);
  const last = (await h.deliveries(endpoint.webhookId)).at(-1)!;
  assert.deepEqual([last.state, last.reason, last.attempts, last.outcome], ["failed", "attempts_exhausted", 10, "interrupted"]);
  assert.equal(r.received.length, 3);
});

test("a backlog larger than one fan-out batch is delivered in full and the cursor ends at the horizon", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  await h.store.transaction(async db => {
    for (let i = 0; i < webhookLimits.fanOutBatch + 44; i++) {
      await appendAudit(db, { type: "request.finished", ownerId: h.ownerId, memberId: h.member.memberId, conversationId,
        requestId: randomUUID(), payload: { status: "completed" } });
    }
  });
  const dispatcher = h.dispatcher();
  // One pass fans out both batches; each pass then sends at most 100 to one endpoint.
  await pass(dispatcher);
  assert.equal((await h.deliveries(endpoint.webhookId)).length, 300);
  assert.equal(r.received.length, webhookLimits.chainLength);
  for (let i = 0; i < 3; i++) await pass(dispatcher);
  assert.equal((await h.deliveries(endpoint.webhookId)).filter(d => d.state === "delivered").length, 300);
  assert.equal(r.received.length, 300, "the chain cap claims nothing it does not send");
  assert.equal(new Set(r.received.map(item => JSON.parse(item.body).eventId)).size, 300);
  const { rows: [cursor] } = await h.db.query(`SELECT c.last_event_id = (SELECT max(event_id) FROM birbcrew_ts.audit_events) AS at_end
    FROM birbcrew_ts.webhook_cursor c`);
  assert.equal(cursor.at_end, true);
});

test("with no endpoint enabled the cursor moves to the end of the trail, and a later endpoint gets only later events", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const conversationId = await h.conversation();
  for (let i = 0; i < 3; i++) await h.finished(conversationId);
  const cursor = async () => (await h.db.query(`SELECT c.last_event_id::text AS cursor, (SELECT max(event_id) FROM birbcrew_ts.audit_events)::text AS max
    FROM birbcrew_ts.webhook_cursor c`)).rows[0];
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  let position = await cursor();
  assert.equal(position.cursor, position.max);
  // At most once a minute.
  await h.finished(conversationId);
  await pass(dispatcher);
  assert.notEqual((await cursor()).cursor, (await cursor()).max);
  h.advance(60_000);
  await pass(dispatcher);
  position = await cursor();
  assert.equal(position.cursor, position.max);
  await h.create(r.url("in"), ["request.finished"]);
  const later = await h.finished(conversationId);
  await pass(dispatcher);
  assert.deepEqual(r.received.map(item => JSON.parse(item.body).requestId), [later]);
});

test("the database keeps endpoints and deliveries as history and refuses a member on a webhook audit row", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  await h.finished(await h.conversation());
  await pass(h.dispatcher());
  const refused = async (statement: string, values: unknown[] = []) => assert.rejects(h.db.query(statement, values), { code: "23514" }, statement);
  await refused("DELETE FROM birbcrew_ts.webhook_endpoints");
  await refused("TRUNCATE birbcrew_ts.webhook_endpoints CASCADE");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET kinds='{approval.pending}'");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET url='https://elsewhere.example.com/'");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET secret=repeat('a', 43)");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET url=NULL");
  await refused("DELETE FROM birbcrew_ts.webhook_deliveries");
  await refused("UPDATE birbcrew_ts.webhook_deliveries SET body='{}'");
  await refused("UPDATE birbcrew_ts.webhook_deliveries SET state='pending', next_attempt_at=now(), settled_at=NULL");
  await refused("UPDATE birbcrew_ts.webhook_cursor SET last_event_id=0");
  await refused("DELETE FROM birbcrew_ts.webhook_cursor");
  await h.api.change(h.ownerId, endpoint.webhookId, "delete");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET state='disabled', disabled_reason='owner'");
  const insert = `INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
    VALUES ($1,'owner',$1,'owner',$1,$2,$3,$4)`;
  await refused(insert, [h.ownerId, "webhook.enabled", h.member.memberId, { webhookId: endpoint.webhookId, revision: 9, host: "x" }]);
  await refused(insert, [h.ownerId, "member.spawned", null, { spawnRequestId: randomUUID(), engine: "pi", profile: "fixture" }]);
  await refused(insert, [h.ownerId, "webhook.enabled", null, { revision: 9, host: "x" }]);
});

test("migration 030 takes only audit_events, without queueing, rewrites nothing and leaves its CHECKs unvalidated", async (t) => {
  const upgraded = await databaseAt(t, 29);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  await upgraded.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,conversation_id,payload)
    VALUES ($1,'owner',$1,'owner',$1,'conversation.opened',$2,$3,'{}')`, [ownerId, memberId, conversationId]);
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = "SELECT pg_relation_filenode('birbcrew_ts.audit_events') AS audit";
    const { rows: [before] } = await db.query(files);
    await db.query(await readFile(new URL("030-webhooks.sql", sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname NOT LIKE 'webhook_%' ORDER BY 1,2`);
    assert.deepEqual(rows, [{ relation: "audit_events", mode: "AccessExclusiveLock" }, { relation: "audit_events", mode: "AccessShareLock" },
      { relation: "audit_events", mode: "ShareLock" }]);
    const { rows: checks } = await db.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conrelid='birbcrew_ts.audit_events'::regclass AND conname IN ('audit_events_type_check','audit_events_member_check') ORDER BY 1`);
    assert.deepEqual(checks, [{ name: "audit_events_member_check", validated: false }, { name: "audit_events_type_check", validated: false }]);
    const { rows: [cursor] } = await db.query(`SELECT last_event_id = (SELECT max(event_id) FROM birbcrew_ts.audit_events) AS at_end
      FROM birbcrew_ts.webhook_cursor`);
    assert.equal(cursor.at_end, true, "no event from before the upgrade is ever delivered");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  // An audited writer holding audit_events: the migration retries without queueing, so the
  // writer's next statements are not held up, and it completes once the writer commits.
  const store = new MemberStore(upgraded);
  const holder = await upgraded.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
      VALUES ($1,'owner',$1,'owner',$1,'member.spawned',$2,$3)`, [ownerId, memberId, { spawnRequestId: randomUUID(), engine: "pi", profile: "fixture" }]);
    let migrated = false;
    const migrating = store.migrate().then(() => { migrated = true; });
    for (let i = 0; i < 10; i++) {
      await delay(30);
      const { rows: waiting } = await upgraded.query(`SELECT pid FROM pg_locks WHERE NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      assert.deepEqual(waiting, [], "the migration retries instead of queueing");
    }
    assert.equal(migrated, false);
    await holder.query("COMMIT");
    await migrating;
  } finally { holder.release(); }
  assert.equal((await upgraded.query("SELECT count(*)::integer AS n FROM birbcrew_ts.schema_versions WHERE version=30")).rows[0].n, 1);
  const { rows: [nullable] } = await upgraded.query(`SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='birbcrew_ts' AND table_name='audit_events' AND column_name='member_id'`);
  assert.equal(nullable.is_nullable, "YES");
});

test("migration 030 completes while a native turn holds its admission", async (t) => {
  const upgraded = await databaseAt(t, 29);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  await withNativeAdmission(upgraded, { ownerId, conversationId, requestId, text, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([current.migrate().then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 030 must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId, token: start.token }, requestId + "/assistant", 0, "still running");
  });
  await current.commitTurn({ ownerId, conversationId, requestId, token: start.token, reply: "still running", checkpoint: { version: 1, engine: "pi", state: {} } });
  const { rows } = await upgraded.query("SELECT event_type FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id", [ownerId]);
  assert.deepEqual(rows.map(row => row.event_type), ["request.finished"]);
});

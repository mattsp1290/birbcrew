import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { actorKinds, appendAudit, auditCsv, auditEventTypes, auditFilterNames, auditQuerySchema, auditSettleWindowMs, readAudit,
  type AuditEvent, type AuditEventType, type AuditFact } from "../../src/service/audit.ts";
import { ChildStore } from "../../src/service/children.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { initiatorKinds, ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { RoutineApi, RoutineDispatcher } from "../../src/service/routines.ts";
import { admittedInitiator, MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const approvals = new ApprovalStore(pool);
const profile = "audit-fixture";
before(async () => {
  await store.migrate();
  await pool.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest) VALUES ($1,'pi',$2) ON CONFLICT DO NOTHING",
    [profile, Buffer.alloc(32)]);
});
after(() => pool.end());

type Event = { eventId: string; occurredAt: string; type: string; actor: { kind: string; id: string | null };
  initiator: { kind: string; id: string }; memberId: string; conversationId: string | null; requestId: string | null;
  payload: Record<string, string> };
type Page = { apiVersion: string; events: Event[]; nextAfter: string; hasMore: boolean };

async function fixture() {
  const ownerId = "owner-" + randomUUID(), token = randomUUID(), stranger = randomUUID(), strangerId = "owner-" + randomUUID();
  let cancels = 0;
  const members = {
    async open(input: unknown) { return store.openConversation(input as Parameters<MemberStore["openConversation"]>[0]); },
    async accept(input: TurnRequest) { await store.recordAcceptance(input, ownerInitiator); return { requestId: input.requestId }; },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return store.requestStatus(input); },
    async decide(input: Parameters<ApprovalStore["decide"]>[0]) { return approvals.decide(input); },
    async cancelPending() { cancels++; },
  } as unknown as MemberClient;
  const server = createGateway(store, members, {
    [createHash("sha256").update(token).digest("hex")]: ownerId,
    [createHash("sha256").update(stranger).digest("hex")]: strangerId,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  function api(path: string, body?: unknown, credential: string = token, method = body === undefined ? "GET" : "POST") {
    return fetch(endpoint + path, { method, headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function audit(query = "", credential: string = token): Promise<Page> {
    const response = await api("/v1/audit" + query, undefined, credential);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  // Each action must append exactly the listed event types after the previous cursor.
  let cursor = "0";
  async function appended(...types: string[]) {
    const page = await audit("?after=" + cursor);
    assert.deepEqual(page.events.map(event => event.type), types);
    cursor = page.nextAfter;
    return page.events;
  }
  async function stop() {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  }
  return { ownerId, strangerId, token, stranger, api, audit, appended, stop, cancels: () => cancels };
}

async function counts(ownerId: string) {
  const { rows } = await pool.query<{ type: string; n: number }>(
    "SELECT event_type AS type, count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE owner_id=$1 GROUP BY 1 ORDER BY 1", [ownerId]);
  return Object.fromEntries(rows.map(row => [row.type, row.n]));
}

test("each owner action appears once, attributed and in order, and never to another owner", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const owner = { kind: "owner", id: f.ownerId }, system = { kind: "system", id: null };
  const spawnRequestId = randomUUID();
  const spawned = await f.api("/v1/members", { requestId: spawnRequestId, engine: "pi", profile });
  assert.equal(spawned.status, 201);
  const { memberId } = await spawned.json();
  const [member] = await f.appended("member.spawned");
  assert.deepEqual({ actor: member.actor, initiator: member.initiator, memberId: member.memberId, payload: member.payload },
    { actor: owner, initiator: owner, memberId, payload: { spawnRequestId, engine: "pi", profile } });
  assert.match(member.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

  const conversationId = randomUUID();
  assert.equal((await f.api("/v1/conversations", { conversationId, memberId })).status, 201);
  const [opened] = await f.appended("conversation.opened");
  assert.equal(opened.conversationId, conversationId);

  const requestId = randomUUID(), prompt = "private prompt text";
  const requests = `/v1/conversations/${conversationId}/requests`;
  assert.equal((await f.api(requests, { requestId, text: prompt })).status, 202);
  const [accepted] = await f.appended("request.accepted");
  assert.deepEqual(accepted.payload, { promptDigest: createHash("sha256").update(prompt).digest("hex") });
  assert.deepEqual(accepted.actor, owner);

  // Workflow-side execution reaches a human decision on the gateway.
  const turn = await store.beginTurn({ ownerId: f.ownerId, conversationId, requestId, text: prompt });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const scope = { ownerId: f.ownerId, memberId, conversationId, requestId };
  const approval = await approvals.propose({ ...scope, token: turn.token, invocationId: requestId, nativeCallId: "audit-call",
    toolName: "record_work_item", arguments: { operation_id: requestId, note: "private-fixture-note" } });
  await f.appended();
  const decided = await f.api(`/v1/conversations/${conversationId}/human`, { memberId, requestId, invocationId: requestId,
    approvalId: approval.approvalId, version: approval.version, choice: "approve" });
  assert.equal(decided.status, 200);
  const [decision] = await f.appended("approval.decided");
  assert.deepEqual({ actor: decision.actor, payload: decision.payload }, { actor: owner, payload: {
    approvalId: approval.approvalId, invocationId: requestId, toolName: "record_work_item",
    argumentDigest: approval.argumentDigest, choice: "approve" } });

  const settled = await approvals.settle({ ...scope, approvalId: approval.approvalId, invocationId: requestId,
    nativeCallId: "audit-call", token: turn.token });
  assert.equal(settled.kind, "recorded"); if (settled.kind !== "recorded") return;
  const [effect] = await f.appended("work_item.committed");
  assert.deepEqual({ actor: effect.actor, payload: effect.payload }, { actor: system,
    payload: { receiptId: settled.receipt.receiptId, approvalId: approval.approvalId } });

  await store.commitTurn({ ownerId: f.ownerId, conversationId, requestId, token: turn.token, reply: "private reply",
    checkpoint: { version: 1, engine: "pi", state: {} } });
  const [completed] = await f.appended("request.finished");
  assert.deepEqual({ actor: completed.actor, initiator: completed.initiator, payload: completed.payload },
    { actor: system, initiator: owner, payload: { status: "completed" } });

  const queued = { ownerId: f.ownerId, conversationId, requestId: randomUUID(), text: "queued private text" };
  assert.equal((await f.api(requests, { requestId: queued.requestId, text: queued.text })).status, 202);
  const cancel = await (await f.api(`${requests}/${queued.requestId}/cancel`, {})).json();
  const [, cancellation] = await f.appended("request.accepted", "request.cancellation_requested");
  assert.deepEqual({ actor: cancellation.actor, payload: cancellation.payload },
    { actor: owner, payload: { receiptId: cancel.cancellation.receiptId } });
  await store.rejectAccepted(queued, "predecessor_cancelled");
  const [rejected] = await f.appended("request.finished");
  assert.deepEqual(rejected.payload, { status: "cancelled", reason: "predecessor_cancelled" });

  const all = await f.audit();
  assert.deepEqual(all.events.map(event => event.type), ["member.spawned", "conversation.opened", "request.accepted",
    "approval.decided", "work_item.committed", "request.finished", "request.accepted", "request.cancellation_requested", "request.finished"]);
  assert.ok(all.events.every((event, i) => i === 0 || BigInt(event.eventId) > BigInt(all.events[i - 1].eventId)));
  assert.ok(all.events.every((event, i) => i === 0 || event.occurredAt >= all.events[i - 1].occurredAt));
  const exported = JSON.stringify(all) + await (await f.api("/v1/audit?format=csv")).text();
  for (const secret of [prompt, queued.text, "private-fixture-note", "private reply", f.token]) {
    assert.equal(exported.includes(secret), false, `audit export must not contain ${secret}`);
  }
  const filtered = await f.audit("?conversationId=" + conversationId.toUpperCase());
  assert.deepEqual(filtered.events, all.events.slice(1));

  // The owner comes only from the bearer token; a filter cannot reach another owner's rows.
  assert.deepEqual((await f.audit("", f.stranger)).events, []);
  assert.deepEqual((await f.audit("?conversationId=" + conversationId, f.stranger)).events, []);
  await store.spawn({ ownerId: f.strangerId, requestId: randomUUID(), engine: "pi", profile });
  assert.deepEqual((await f.audit("", f.stranger)).events.map(event => event.actor.id), [f.strangerId]);
  assert.equal((await f.audit()).events.length, all.events.length);
});

test("retries, replays and repeated deliveries never duplicate a fact", async () => {
  const ownerId = "owner-" + randomUUID();
  const spawn = { ownerId, requestId: randomUUID(), engine: "pi" as const, profile };
  const [member] = await Promise.all([store.spawn(spawn), store.spawn(spawn)]);
  await store.spawn(spawn);
  const open = { ownerId, memberId: member.memberId, conversationId: randomUUID() };
  await Promise.all([store.openConversation(open), store.openConversation(open)]);
  const key = { ownerId, conversationId: open.conversationId };
  const input = { ...key, requestId: randomUUID(), text: "retry me" };
  await Promise.all([store.recordAcceptance(input, ownerInitiator), store.recordAcceptance(input, ownerInitiator)]);
  await store.recordAcceptance(input, ownerInitiator);
  const turn = await store.beginTurn(input);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const scope = { ...open, requestId: input.requestId };
  const approval = await approvals.propose({ ...scope, token: turn.token, invocationId: input.requestId, nativeCallId: "retry-call",
    toolName: "record_work_item", arguments: { operation_id: input.requestId } });
  const choice = { ...scope, invocationId: input.requestId, nativeCallId: "retry-call", approvalId: approval.approvalId,
    argumentDigest: approval.argumentDigest, version: approval.version, choice: "approve" as const };
  await approvals.decide(choice); await approvals.decide(choice);
  const settle = { ...scope, approvalId: approval.approvalId, invocationId: input.requestId, nativeCallId: "retry-call", token: turn.token };
  assert.deepEqual(await approvals.settle(settle), await approvals.settle(settle));
  const commit = { ...key, requestId: input.requestId, token: turn.token, reply: "done", checkpoint: { version: 1 as const, engine: "pi" as const, state: {} } };
  await store.commitTurn(commit); await store.commitTurn(commit);

  // A queued successor: durable intent, repeated intent, then rejection retried by Temporal.
  const queued = { ...key, requestId: randomUUID(), text: "queued" };
  await store.recordAcceptance(queued, ownerInitiator);
  const members = { accept: async () => ({ requestId: queued.requestId }), requestStatus: (k: Parameters<MemberStore["requestStatus"]>[0]) => store.requestStatus(k), cancelPending: async () => {} };
  const api = new IntegrationApi(store, members as unknown as MemberClient);
  const receipt = await api.cancel({ ...key, requestId: queued.requestId });
  assert.equal((await api.cancel({ ...key, requestId: queued.requestId })).cancellation?.receiptId, receipt.cancellation?.receiptId);
  await store.rejectAccepted(queued, "predecessor_cancelled");
  await store.rejectAccepted(queued, "predecessor_cancelled");

  // A started turn cancelled by the workflow, then reconciled twice as uncertain.
  const running = { ...key, requestId: randomUUID(), text: "running" };
  await store.recordAcceptance(running, ownerInitiator);
  const execution = { workflowRunId: randomUUID(), activityId: "retry", attempt: 1 };
  assert.equal((await store.beginTurn(running, execution)).kind, "start");
  assert.equal(await store.cancelGenerating(running), true);
  assert.equal(await store.cancelGenerating(running), true);
  assert.equal(await store.reconcileTurn(running, execution.workflowRunId, false), null);
  assert.equal(await store.reconcileTurn(running, execution.workflowRunId, false, false), null);

  // A failed Pi delegation is quarantined, retried by Temporal, and never reconciled.
  const delegated = { ownerId, conversationId: randomUUID(), requestId: randomUUID(), text: "delegate" };
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId: delegated.conversationId });
  await store.recordAcceptance(delegated, ownerInitiator);
  assert.equal((await store.beginTurn(delegated, execution)).kind, "start");
  const conversation = await store.getConversation({ ownerId, conversationId: delegated.conversationId });
  await new ChildStore(pool).quarantineDelegation(conversation, delegated, execution.workflowRunId);
  await new ChildStore(pool).quarantineDelegation(conversation, delegated, execution.workflowRunId);

  assert.deepEqual(await counts(ownerId), {
    "approval.decided": 1, "conversation.opened": 2, "member.spawned": 1, "request.accepted": 4,
    "request.cancellation_requested": 2, "request.finished": 4, "work_item.committed": 1,
  });
  const { rows } = await pool.query("SELECT payload FROM birbcrew_ts.audit_events WHERE owner_id=$1 AND event_type='request.finished' ORDER BY event_id", [ownerId]);
  assert.deepEqual(rows.map(row => row.payload.status), ["completed", "cancelled", "uncertain", "uncertain"]);
});

test("the database refuses to change, remove, misattribute or widen audit rows", async () => {
  const ownerId = "owner-" + randomUUID(), other = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const foreign = await store.spawn({ ownerId: other, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId: other, memberId: foreign.memberId, conversationId });
  for (const statement of ["UPDATE birbcrew_ts.audit_events SET payload='{}' WHERE owner_id=$1",
    "UPDATE birbcrew_ts.audit_events SET occurred_at=now() WHERE false AND owner_id=$1",
    "DELETE FROM birbcrew_ts.audit_events WHERE owner_id=$1"]) {
    await assert.rejects(pool.query(statement, [ownerId]), { code: "23514", message: /append-only/ });
  }
  await assert.rejects(pool.query("TRUNCATE birbcrew_ts.audit_events"), { code: "23514" });
  assert.deepEqual(await counts(ownerId), { "member.spawned": 1 });
  const insert = `INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,conversation_id,request_id,payload)
    VALUES ($1,'owner',$1,'owner',$1,$2,$3,$4,$5,'{}')`;
  await assert.rejects(pool.query(insert, [ownerId, "request.deleted", member.memberId, null, null]), { code: "23514" });
  await assert.rejects(pool.query(insert, [ownerId, "request.accepted", member.memberId, conversationId, randomUUID()]), { code: "23503" });
  // The same owner's conversation still binds its own member only.
  const sibling = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const own = randomUUID();
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId: own });
  await assert.rejects(pool.query(insert, [ownerId, "request.accepted", sibling.memberId, own, randomUUID()]),
    { code: "23503", message: /another owner or member/ });
  await assert.rejects(pool.query(insert, [ownerId, "request.accepted", member.memberId, randomUUID(), randomUUID()]), { code: "23503" });
  // A null or missing natural key would never collide, so the CHECK demands a string.
  for (const payload of [`'{"approvalId":null}'`, "'{}'"]) {
    await assert.rejects(pool.query(insert.replace("'{}'", payload), [ownerId, "approval.decided", member.memberId,
      own, randomUUID()]), { code: "23514" }, payload);
  }
  await assert.rejects(pool.query(insert.replace("'owner',$1,'owner'", "'owner',$1,'routine'"), [ownerId, "member.spawned", randomUUID(), null, null]), { code: "23514" });
  await assert.rejects(pool.query(`INSERT INTO birbcrew_ts.audit_events (event_id,owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
    VALUES (1,$1,'owner',$1,'owner',$1,'member.spawned',$2,'{}')`, [ownerId, member.memberId]), { code: "428C9" });
  // Content cannot ride along in a payload, even when a call site bypasses the types.
  const db = await pool.connect();
  try {
    await assert.rejects(appendAudit(db, { type: "request.accepted", ownerId, memberId: member.memberId, conversationId, requestId: randomUUID(),
      payload: { promptDigest: "0".repeat(64), text: "private prompt" } as never }), z.ZodError);
  } finally { db.release(); }
});

test("an audit row naming a conversation its statement cannot see is refused, even if another owner commits it before the foreign key check", async () => {
  const ownerId = "owner-" + randomUUID(), other = "owner-" + randomUUID(), conversationId = randomUUID();
  const mine = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const theirs = await store.spawn({ ownerId: other, requestId: randomUUID(), engine: "pi", profile });
  const hold = BigInt.asIntN(64, BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 16))).toString();
  const creator = await pool.connect(), writer = await pool.connect();
  try {
    await creator.query("BEGIN");
    await creator.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)",
      [other, theirs.memberId, conversationId]);
    await creator.query("SELECT pg_advisory_xact_lock($1)", [hold]);
    // Rolled back below: a row trigger after the binding check waits for the creator to commit,
    // so the foreign key check that follows runs with a snapshot that sees the conversation.
    await writer.query("BEGIN");
    await writer.query(`CREATE FUNCTION pg_temp.hold_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${hold}); RETURN NEW; END $$`);
    await writer.query(`CREATE TRIGGER audit_events_zz_hold BEFORE INSERT ON birbcrew_ts.audit_events
      FOR EACH ROW EXECUTE FUNCTION pg_temp.hold_audit()`);
    const { rows: [{ pid }] } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    let settled = false;
    const inserting = appendAudit(writer, { type: "conversation.opened", ownerId, memberId: mine.memberId, conversationId, payload: {} })
      .then(() => "accepted", (error: unknown) => error).finally(() => { settled = true; });
    // Commit only once the insert has passed the binding trigger and waits on the hold, or has already failed.
    while (!settled && !(await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [pid])).rowCount) {
      await delay(5);
    }
    await creator.query("COMMIT");
    const outcome = await inserting;
    assert.ok(outcome instanceof Error && "code" in outcome && outcome.code === "23503", `expected 23503, got ${String(outcome)}`);
  } finally {
    await creator.query("ROLLBACK");
    await writer.query("ROLLBACK");
    creator.release(); writer.release();
  }
});

test("keyset pages and CSV export return the same rows; queries are strictly validated", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const member = await store.spawn({ ownerId: f.ownerId, requestId: randomUUID(), engine: "pi", profile });
  for (let i = 0; i < 3; i++) await store.openConversation({ ownerId: f.ownerId, memberId: member.memberId, conversationId: randomUUID() });
  const all = (await f.audit()).events;
  assert.equal(all.length, 4);
  const paged: Event[] = [];
  let after = "0", pages = 0;
  for (;;) {
    const page = await f.audit(`?limit=3&after=${after}`);
    paged.push(...page.events); pages++;
    after = page.nextAfter;
    if (!page.hasMore) break;
  }
  assert.equal(pages, 2);
  assert.deepEqual(paged, all);
  assert.deepEqual(await f.audit("?after=" + after), { apiVersion: "1", events: [], nextAfter: after, hasMore: false });

  const csv = await f.api("/v1/audit?format=csv&limit=3");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
  assert.equal(csv.headers.get("audit-has-more"), "true");
  assert.equal(csv.headers.get("audit-next-after"), all[2].eventId);
  const lines = (await csv.text()).split("\r\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines[0], "eventId,occurredAt,type,actorKind,actorId,initiatorKind,initiatorId,memberId,conversationId,requestId,payload");
  // Only the payload cell can need RFC 4180 quoting.
  const rows = lines.slice(1, -1).map(line => {
    const [, head, last] = /^((?:[^,"]*,){10})(.*)$/.exec(line)!;
    const cells = head.slice(0, -1).split(",");
    const payload = last.startsWith('"') ? last.slice(1, -1).replaceAll('""', '"') : last;
    return { eventId: cells[0], occurredAt: cells[1], type: cells[2], actor: { kind: cells[3], id: cells[4] || null },
      initiator: { kind: cells[5], id: cells[6] }, memberId: cells[7], conversationId: cells[8] || null,
      requestId: cells[9] || null, payload: JSON.parse(payload) };
  });
  assert.deepEqual(rows, all.slice(0, 3));
  // The format never changes which rows a query returns; only CSV may ask for more.
  assert.equal(auditQuerySchema.parse({ format: "csv" }).limit, auditQuerySchema.parse({}).limit);
  const csvDefault = (await (await f.api("/v1/audit?format=csv")).text()).split("\r\n").slice(1, -1);
  assert.deepEqual(csvDefault.map(line => line.split(",")[0]), all.map(event => event.eventId));
  assert.equal((await f.api("/v1/audit?format=csv&limit=10000")).status, 200);
  const hostile = auditCsv([{ ...all[0], actor: { kind: "owner", id: 'a,"b"\r\nc' } } as unknown as AuditEvent]);
  assert.ok(hostile.includes(',member.spawned,owner,"a,""b""\r\nc",owner,'), hostile);

  for (const query of ["?limit=0", "?limit=1001", "?format=csv&limit=10001", "?limit=1&limit=2", "?after=-1", "?after=1.5",
    "?after=9223372036854775808", "?after=", "?conversationId=not-a-uuid", "?format=xml", "?ownerId=" + f.ownerId, "?__proto__=1", "?constructor=1"]) {
    const response = await f.api("/v1/audit" + query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_input" });
  }
  assert.equal((await f.api("/v1/audit", {})).status, 405);
  assert.equal((await f.api("/v1/audit", undefined, "invalid")).status, 401);
  assert.equal((await f.api("/audit")).status, 404);
  const capabilities = await (await f.api("/v1/capabilities")).json();
  assert.deepEqual(capabilities.audit.eventTypes, auditEventTypes);
  assert.equal(capabilities.audit.route, "/v1/audit");
});

test("a page never skips an event that an earlier transaction commits late, and readers never block writers", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const early = randomUUID(), late = randomUUID(), during = randomUUID();
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    const { rows: [inserted] } = await writer.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members (owner_id,spawn_request_id,engine,profile)
      VALUES ($1,$2,'pi',$3) RETURNING member_id`, [f.ownerId, early, profile]);
    // A raw insert, not appendAudit: the ordering lock is enforced by the table itself.
    await writer.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
      VALUES ($1,'owner',$1,'owner',$1,'member.spawned',$2,$3)`, [f.ownerId, inserted.member_id,
      JSON.stringify({ spawnRequestId: early, engine: "pi", profile })]);
    await store.spawn({ ownerId: f.ownerId, requestId: late, engine: "pi", profile }); // higher ID, committed first
    let settled = false;
    const reading = f.audit().then(page => { settled = true; return page; });
    // A filtered read keeps the same horizon.
    const filtered = f.audit("?eventType=member.spawned&actorKind=owner").then(page => { settled = true; return page; });
    await delay(100);
    await store.spawn({ ownerId: f.ownerId, requestId: during, engine: "pi", profile }); // not queued behind the reader
    await delay(100);
    assert.equal(settled, false, "the reader waits for the open writer instead of paging past its ID");
    await writer.query("COMMIT");
    const page = await reading;
    assert.deepEqual(page.events.map(event => event.payload.spawnRequestId), [early, late, during]);
    assert.deepEqual((await filtered).events.map(event => event.payload.spawnRequestId), [early, late, during]);
  } finally { writer.release(); }
});

test("the SQL CHECK and the TypeScript registry name the same event types", async () => {
  const { rows: [constraint] } = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='birbcrew_ts.audit_events'::regclass AND conname='audit_events_type_check'`);
  const named = new Set([...constraint.definition.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(match => match[1]));
  assert.deepEqual([...named].sort(), [...auditEventTypes].sort());
});

test("every event type's natural key is a working ON CONFLICT arbiter", async () => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), digest = "0".repeat(64);
    const routineId = randomUUID(), memoryId = randomUUID();
    const { rows: [{ member_id: memberId }] } = await db.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
      (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi',$3) RETURNING member_id`, [ownerId, randomUUID(), profile]);
    await db.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)",
      [ownerId, memberId, conversationId]);
    // Typed by the registry, so a new event type cannot be added without a sample here.
    const samples: { [T in AuditEventType]: Omit<AuditFact<T>, "type" | "ownerId" | "memberId"> } = {
      "member.spawned": { payload: { spawnRequestId: randomUUID(), engine: "pi", profile } },
      "conversation.opened": { conversationId, payload: {} },
      "request.accepted": { conversationId, requestId, payload: { promptDigest: digest } },
      "approval.decided": { conversationId, requestId, payload: { approvalId: randomUUID(), invocationId: requestId,
        toolName: "record_work_item", argumentDigest: digest, choice: "approve" } },
      "work_item.committed": { conversationId, requestId, payload: { receiptId: randomUUID(), approvalId: randomUUID() } },
      "request.cancellation_requested": { conversationId, requestId, payload: {} },
      "request.finished": { conversationId, requestId, payload: { status: "completed" } },
      "trusted_effect.completed": { conversationId, requestId, payload: { operationId: randomUUID(), toolName: "fixture_effect" } },
      "routine.created": { payload: { routineId, revision: 1, schedule: "*/15 * * * *", approvalPolicy: "wait", promptDigest: digest } },
      "routine.enabled": { payload: { routineId, revision: 3 } },
      "routine.disabled": { payload: { routineId, revision: 2, reason: "owner" } },
      "routine.deleted": { payload: { routineId, revision: 4 } },
      "routine.firing_settled": { payload: { routineId, scheduledFor: "2031-01-01T00:15:00.000Z", status: "skipped", reason: "missed" } },
      "approval.auto_approved": { conversationId, requestId, payload: { approvalId: randomUUID(), invocationId: requestId,
        toolName: "record_work_item", argumentDigest: digest, grantId: randomUUID() } },
      "grant.created": { conversationId, requestId, payload: { grantId: randomUUID(), approvalId: randomUUID(), scope: "member" } },
      "grant.revoked": { conversationId, payload: { grantId: randomUUID(), reason: "owner" } },
      "memory.created": { payload: { memoryId } },
      "memory.deleted": { payload: { memoryId } },
      "memory.suspended": { payload: { memoryId, reason: "recovery_restore" } },
      "approval.expired": { conversationId, requestId, payload: { approvalId: randomUUID(), invocationId: requestId,
        toolName: "choose_next_step", expiresAt: "2031-01-01T00:01:00.000Z" } },
      "conversation.handed_off": { conversationId, payload: { handoffId: randomUUID(), targetConversationId: randomUUID(),
        targetMemberId: randomUUID(), firstRequestId: randomUUID(), carriedTurns: 1, omittedTurns: 0, uncertainTurns: 0, transcriptDigest: digest } },
      "member.instructions_set": { payload: { digest, bytes: 1 } },
    };
    for (const type of auditEventTypes) {
      const fact = { type, ownerId, memberId, ...samples[type] } as AuditFact<typeof type>;
      await appendAudit(db, fact);
      await appendAudit(db, fact);
    }
    const { rows } = await db.query<{ type: string; n: number }>(`SELECT event_type AS type, count(*)::integer AS n
      FROM birbcrew_ts.audit_events WHERE owner_id=$1 GROUP BY 1`, [ownerId]);
    assert.deepEqual(Object.fromEntries(rows.map(row => [row.type, row.n])), Object.fromEntries(auditEventTypes.map(type => [type, 1])));
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("CSV cells a spreadsheet would run as formulas are inert and still recover the exact value", () => {
  const ids = ["=HYPERLINK(\"http://x\")", "+1", "-1", "@SUM(A1)", "\tlead", "\rlead", "'quoted", "plain", "a=b"];
  const event = (id: string) => ({ eventId: "1", occurredAt: "2026-11-12T00:00:00.000000Z", type: "member.spawned",
    actor: { kind: "owner", id }, initiator: { kind: "owner", id }, memberId: randomUUID(), conversationId: null,
    requestId: null, payload: {} }) as AuditEvent;
  // A plain RFC 4180 reader still parses the export.
  const records: string[][] = [];
  let record: string[] = [], cell = "", quoted = false;
  const csv = auditCsv(ids.map(event));
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") { record.push(cell); cell = ""; }
    else if (c === "\r" && csv[i + 1] === "\n") { record.push(cell); records.push(record); record = []; cell = ""; i++; }
    else cell += c;
  }
  const rows = records.slice(1);
  assert.ok(rows.every(row => row.length === 11));
  for (const column of [4, 6]) {
    const cells = rows.map(row => row[column]);
    for (const value of cells) assert.doesNotMatch(value, /^[=+\-@\t\r]/, value);
    assert.deepEqual(cells.map(value => value.startsWith("'") ? value.slice(1) : value), ids);
    assert.deepEqual(cells.slice(-2), ["plain", "a=b"]);
  }
});

test("a writer left open past the read window yields a retryable 503 audit_unsettled after a bounded number of polls", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const query = pool.query;
  let polls = 0;
  pool.query = function (this: Pool, ...args: unknown[]) {
    if (typeof args[0] === "string" && args[0].includes("pg_try_advisory_xact_lock")) polls++;
    return (query as (...values: unknown[]) => unknown).apply(this, args);
  } as unknown as typeof pool.query;
  t.after(() => { pool.query = query; });
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    const requestId = randomUUID();
    const { rows: [inserted] } = await writer.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members (owner_id,spawn_request_id,engine,profile)
      VALUES ($1,$2,'pi',$3) RETURNING member_id`, [f.ownerId, requestId, profile]);
    await writer.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
      VALUES ($1,'owner',$1,'owner',$1,'member.spawned',$2,$3)`, [f.ownerId, inserted.member_id,
      JSON.stringify({ spawnRequestId: requestId, engine: "pi", profile })]);
    const started = Date.now();
    const response = await f.api("/v1/audit?format=csv");
    assert.ok(Date.now() - started >= auditSettleWindowMs);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "audit_unsettled" });
    // Backoff from 10 ms to 200 ms: about 30 polls in the window, not about 500.
    assert.ok(polls > 0 && polls <= 40, `polls: ${polls}`);
    // Filters change which rows return, never when a page is safe to return.
    polls = 0;
    const filtered = await f.api(`/v1/audit?memberId=${inserted.member_id}&eventType=member.spawned&from=2000-01-01T00:00:00Z`);
    assert.equal(filtered.status, 503);
    assert.equal(filtered.headers.get("retry-after"), "1");
    assert.deepEqual(await filtered.json(), { error: "audit_unsettled" });
    assert.ok(polls > 0 && polls <= 40, `polls: ${polls}`);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
  assert.equal((await f.api("/v1/audit")).status, 200);
});

test("a Claude turn recovered to a pending decision is finished once, by its commit", async () => {
  const ownerId = "owner-" + randomUUID(), claude = "audit-recover-" + randomUUID();
  await pool.query(`INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,volume,protected_tool)
    VALUES ($1,'claude',$2,$3,'record_work_item')`, [claude, Buffer.alloc(32), randomUUID()]);
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "claude", profile: claude });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "recover me" };
  await store.recordAcceptance(request, ownerInitiator);
  const run = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await store.beginTurn(request, run);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  const launch = [conversationId, request.requestId, start.token];
  await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [...launch, run.workflowRunId, run.activityId]);

  // The SDK failed mid-turn. Handing the turn to recovery is not an outcome yet.
  assert.deepEqual(await store.reconcileTurn(request, run.workflowRunId, false), { kind: "recover" });
  assert.equal((await counts(ownerId))["request.finished"], undefined);
  await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND request_id=$2 AND token=$3", launch);
  assert.equal((await store.stoppedProposal(request, run.workflowRunId))?.kind, "recover");
  // recoverPending restores the native session here; its proposal is given directly.
  const scope = { ownerId, memberId: member.memberId, conversationId, requestId: request.requestId };
  const call = { invocationId: request.requestId, nativeCallId: "recovered-call" };
  const approval = await approvals.propose({ ...scope, ...call, token: start.token, toolName: "record_work_item",
    arguments: { operation_id: request.requestId } }, { version: 1, engine: "claude", state: {} }, { recoverStopped: true });
  await approvals.decide({ ...scope, ...call, approvalId: approval.approvalId, argumentDigest: approval.argumentDigest,
    version: approval.version, choice: "approve" });
  const resumed = await store.beginResume(request, approval, { ...run, activityId: "resume" });
  assert.equal(resumed.kind, "start"); if (resumed.kind !== "start") return;
  const settled = await approvals.settle({ ...scope, ...call, approvalId: approval.approvalId, token: resumed.token });
  assert.equal(settled.kind, "recorded");
  await store.commitTurn({ ownerId, conversationId, requestId: request.requestId, token: resumed.token, reply: "recovered",
    checkpoint: { version: 1, engine: "claude", state: {} } });

  const { rows } = await pool.query("SELECT payload->>'status' AS status FROM birbcrew_ts.audit_events WHERE owner_id=$1 AND event_type='request.finished'", [ownerId]);
  assert.deepEqual(rows.map(row => row.status), ["completed"]);
  assert.deepEqual(await counts(ownerId), { "approval.decided": 1, "conversation.opened": 1, "member.spawned": 1,
    "request.accepted": 1, "request.finished": 1, "work_item.committed": 1 });
});

const sql = new URL("../../src/service/sql/", import.meta.url);
/** A separate database migrated only up to `version`, as that release left it; dropped after the test. */
async function databaseAt(t: TestContext, version: number) {
  const source = new URL(url!);
  const admin = new Pool({ connectionString: source.href });
  const database = "audit_upgrade_" + randomUUID().replaceAll("-", "");
  await admin.query("CREATE DATABASE " + database);
  source.pathname = "/" + database;
  const upgraded = new Pool({ connectionString: source.href });
  // An after hook never replaces the test's own failure, even when this DROP fails because a failed
  // assertion left a session open.
  t.after(async () => {
    try {
      await upgraded.end();
      // Not FORCE: end() resolves before its connections close, and terminating one then is an unhandled pool error.
      await admin.query(`DROP DATABASE ${database}`);
    } finally { await admin.end(); }
  });
  await upgraded.query("CREATE SCHEMA birbcrew_ts");
  await upgraded.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version) continue;
    await upgraded.query(await readFile(new URL(file, sql), "utf8"));
    await upgraded.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return upgraded;
}

test("migration 21 upgrades a v20 database with rows while a native turn holds its admission", async (t) => {
  const upgraded = await databaseAt(t, 20);
  // Rows as the v20 service wrote them.
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi',$3) RETURNING member_id`, [ownerId, randomUUID(), profile]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)",
    [ownerId, memberId, conversationId]);

  // Only members and conversations are locked, and not in a mode a native turn's reads conflict with.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    await db.query(await readFile(new URL("021-audit.sql", sql), "utf8"));
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname<>'audit_events' ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "conversations", mode: "AccessShareLock" }, { relation: "conversations", mode: "ShareRowExclusiveLock" },
      { relation: "members", mode: "AccessShareLock" }, { relation: "members", mode: "ShareRowExclusiveLock" },
    ]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  const launch = { ownerId, conversationId, requestId, text, token: start.token, execution };
  await withNativeAdmission(upgraded, launch, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([current.migrate().then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 21 must not wait for a running native turn");
    // The turn's own conversation writes are not queued behind the upgrade either.
    await current.appendText({ ownerId, conversationId, requestId, token: start.token }, requestId + "/assistant", 0, "still running");
  });

  // Pre-existing conversations bind audit rows like new ones.
  await current.recordAcceptance({ ownerId, conversationId, requestId: randomUUID(), text: "after upgrade" }, ownerInitiator);
  const sibling = await current.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const client = await upgraded.connect();
  try {
    await assert.rejects(appendAudit(client, { type: "conversation.opened", ownerId, memberId: sibling.memberId, conversationId,
      payload: {} }), { code: "23503" });
  } finally { client.release(); }
  const { rows: types } = await upgraded.query("SELECT event_type FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id", [ownerId]);
  assert.deepEqual(types.map(row => row.event_type), ["request.accepted", "member.spawned"]);
  // stableHorizon's paging proof needs IDs drawn in order, which a session cache would break.
  const { rows: [identity] } = await upgraded.query(`SELECT seqcache::integer AS cache FROM pg_sequence
    WHERE seqrelid=pg_get_serial_sequence('birbcrew_ts.audit_events','event_id')::regclass`);
  assert.equal(identity.cache, 1);
});

test("migration 23 records a v21 database's admissions as owner-initiated without waiting for a native turn", async (t) => {
  const upgraded = await databaseAt(t, 21);
  // Rows as the v21 service wrote them: a started turn and two queued requests, all admitted.
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi',$3) RETURNING member_id`, [ownerId, randomUUID(), profile]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)",
    [ownerId, memberId, conversationId]);
  const [running, queued, rejected] = ["running at upgrade", "queued at upgrade", "rejected after upgrade"]
    .map(text => ({ ownerId, conversationId, requestId: randomUUID(), text }));
  for (const request of [running, queued, rejected]) {
    await upgraded.query("INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest) VALUES ($1,$2,$3)",
      [conversationId, request.requestId, createHash("sha256").update(request.text).digest()]);
  }

  // Only request_admissions is locked. Neither a rewrite nor a scan runs under that lock.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const table = `SELECT pg_relation_filenode('birbcrew_ts.request_admissions') AS file,
      pg_stat_get_xact_numscans('birbcrew_ts.request_admissions'::regclass)::integer AS scans`;
    const { rows: [before] } = await db.query(table);
    await db.query(await readFile(new URL("023-request-initiator.sql", sql), "utf8"));
    assert.deepEqual((await db.query(table)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace ORDER BY 1,2`);
    assert.deepEqual(rows, [{ relation: "request_admissions", mode: "AccessExclusiveLock" },
      { relation: "request_admissions", mode: "ShareRowExclusiveLock" }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn(running, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, running.requestId, start.token, execution.workflowRunId, execution.activityId]);
  await withNativeAdmission(upgraded, { ...running, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    // The admission transaction is the one left idle in transaction; its stop polling commits each statement.
    const { rows } = await upgraded.query(`SELECT DISTINCT c.relname AS relation, l.mode FROM pg_locks l
      JOIN pg_class c ON c.oid=l.relation JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=current_database() AND a.state='idle in transaction'
        AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "conversations", mode: "AccessShareLock" }, { relation: "members", mode: "AccessShareLock" },
      { relation: "native_launches", mode: "AccessShareLock" }, { relation: "native_stop_requests", mode: "AccessShareLock" },
      { relation: "recovery_control", mode: "AccessShareLock" }, { relation: "turns", mode: "RowShareLock" },
    ]);
    const migrated = await Promise.race([current.migrate().then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 23 must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId: running.requestId, token: start.token },
      running.requestId + "/assistant", 0, "still running");
  });

  const { rows: admissions } = await upgraded.query(`SELECT initiator_kind AS kind, initiator_id AS id, count(*)::integer AS n
    FROM birbcrew_ts.request_admissions GROUP BY 1,2`);
  assert.deepEqual(admissions, [{ kind: "owner", id: null, n: 3 }]);
  assert.deepEqual(await admittedInitiator(upgraded, queued), ownerInitiator);
  // NOT VALID is what spares the scan under the exclusive lock; the scan counter alone needs track_counts.
  const { rows: constraints } = await upgraded.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
    WHERE conrelid='birbcrew_ts.request_admissions'::regclass AND conname LIKE 'request_admissions_initiator%' ORDER BY 1`);
  assert.deepEqual(constraints, [{ name: "request_admissions_initiator_id_check", validated: false },
    { name: "request_admissions_initiator_kind_check", validated: false }]);
  // No default survives: a writer that does not name an initiator fails instead of recording the owner.
  const { rows: [column] } = await upgraded.query(`SELECT column_default FROM information_schema.columns
    WHERE table_schema='birbcrew_ts' AND table_name='request_admissions' AND column_name='initiator_kind'`);
  assert.equal(column.column_default, null);
  const insert = "INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest%s) VALUES ($1,$2,$3%s)";
  const digest = createHash("sha256").update("direct").digest();
  await assert.rejects(upgraded.query(insert.replace(/%s/g, ""), [conversationId, randomUUID(), digest]),
    { code: "23502", column: "initiator_kind" });
  // The previous release's v1 cancel backfill fails too, even for a request already admitted: NOT NULL
  // is checked before the conflict.
  await assert.rejects(upgraded.query(`INSERT INTO birbcrew_ts.request_admissions(conversation_id,request_id,prompt_digest)
    SELECT t.conversation_id,t.request_id,t.prompt_digest FROM birbcrew_ts.turns t WHERE t.conversation_id=$1 AND t.request_id=$2
    ON CONFLICT(conversation_id,request_id) DO NOTHING`, [conversationId, running.requestId]), { code: "23502" });
  // migrate() also applied 025, which admits routines; an unknown kind is still refused.
  for (const [kind, id, constraint] of [["operator", "operator-1", "request_admissions_initiator_kind_check"],
    ["owner", ownerId, "request_admissions_initiator_id_check"]]) {
    await assert.rejects(upgraded.query(insert.replace("%s", ",initiator_kind,initiator_id").replace("%s", ",$4,$5"),
      [conversationId, randomUUID(), digest, kind, id]), { code: "23514", constraint });
  }
  // The initiator is fixed at admission; the rest of the row still changes.
  await assert.rejects(upgraded.query("UPDATE birbcrew_ts.request_admissions SET initiator_id=$3 WHERE conversation_id=$1 AND request_id=$2",
    [conversationId, queued.requestId, ownerId]), { code: "23514", message: /immutable/ });
  await current.rejectAccepted(rejected, "predecessor_cancelled");
  await current.commitTurn({ ownerId, conversationId, requestId: running.requestId, token: start.token, reply: "still running",
    checkpoint: { version: 1, engine: "pi", state: {} } });
  const { rows: events } = await upgraded.query(`SELECT request_id AS "requestId", initiator_kind AS kind, initiator_id AS id
    FROM birbcrew_ts.audit_events WHERE event_type='request.finished' ORDER BY event_id`);
  assert.deepEqual(events, [rejected, running].map(({ requestId }) => ({ requestId, kind: "owner", id: ownerId })));
});

test("migration 24 adds standing grants to a v23 database without rewriting or scanning deferred_calls or waiting for a native turn", async (t) => {
  const upgraded = await databaseAt(t, 23);
  const current = new MemberStore(upgraded);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  const { memberId } = await current.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  // Seeded in SQL: this release's open and admission read tables a later migration adds.
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const running = { ownerId, conversationId, requestId: randomUUID(), text: "running at upgrade" };
  await upgraded.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind)
    VALUES ($1,$2,$3,'owner')`, [conversationId, running.requestId, createHash("sha256").update(running.text).digest()]);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn(running, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, running.requestId, start.token, execution.workflowRunId, execution.activityId]);
  // A card the v23 release left pending.
  const { rows: [card] } = await upgraded.query<{ approval_id: string; argument_digest: string }>(`INSERT INTO birbcrew_ts.deferred_calls
    (conversation_id,request_id,invocation_id,native_call_id,tool_name,arguments,argument_digest,policy_version,decision_version)
    VALUES ($1,$2,$2,'v23-call','record_work_item',$3,$4,1,1) RETURNING approval_id, argument_digest`,
    [conversationId, running.requestId, { operation_id: running.requestId }, "0".repeat(64)]);

  // Exclusive locks only on deferred_calls and audit_events; neither existing table is rewritten,
  // and deferred_calls is not scanned. Only the new unique index build reads audit_events.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const table = `SELECT pg_relation_filenode('birbcrew_ts.deferred_calls') AS calls, pg_relation_filenode('birbcrew_ts.audit_events') AS audit,
      pg_stat_get_xact_numscans('birbcrew_ts.deferred_calls'::regclass)::integer AS scans`;
    const { rows: [before] } = await db.query(table);
    await db.query(await readFile(new URL("024-standing-grants.sql", sql), "utf8"));
    assert.deepEqual((await db.query(table)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname<>'tool_grants' ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "audit_events", mode: "AccessExclusiveLock" }, { relation: "audit_events", mode: "ShareLock" },
      { relation: "conversations", mode: "AccessShareLock" }, { relation: "conversations", mode: "ShareRowExclusiveLock" },
      { relation: "deferred_calls", mode: "AccessExclusiveLock" }, { relation: "deferred_calls", mode: "AccessShareLock" },
      { relation: "deferred_calls", mode: "ShareRowExclusiveLock" },
      { relation: "members", mode: "AccessShareLock" }, { relation: "members", mode: "ShareRowExclusiveLock" },
    ]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  await withNativeAdmission(upgraded, { ...running, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([current.migrate().then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 24 must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId: running.requestId, token: start.token },
      running.requestId + "/assistant", 0, "still running");
  });

  const { rows: constraints } = await upgraded.query(`SELECT conrelid::regclass::text AS "table", conname AS name, convalidated AS validated
    FROM pg_constraint WHERE conname IN ('deferred_calls_grant_scope_check','deferred_calls_grant_id_check','deferred_calls_grant_id_fkey',
      'audit_events_type_check') ORDER BY 2`);
  assert.deepEqual(constraints.map(c => c.validated), [false, false, false, false]);
  // The card left pending by v23 takes a standing answer like a new one.
  const ledger = new ApprovalStore(upgraded);
  assert.equal(await ledger.decide({ ownerId, memberId, conversationId, requestId: running.requestId, invocationId: running.requestId,
    nativeCallId: "v23-call", approvalId: card.approval_id, argumentDigest: card.argument_digest, version: 1, choice: "allow_always" }), "allow_always");
  const { rows: events } = await upgraded.query("SELECT event_type FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id", [ownerId]);
  assert.deepEqual(events.map(row => row.event_type).slice(-2), ["approval.decided", "grant.created"]);
});

test("a request's audit rows carry the initiator its admission recorded; one without an admission records the owner", async (t) => {
  const ownerId = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
  const initiators = async () => (await pool.query(`SELECT event_type AS type, request_id AS "requestId",
    initiator_kind AS kind, initiator_id AS id FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id`, [ownerId])).rows;
  const owner = { kind: "owner", id: ownerId };

  // A workflow history older than durable admission starts and commits a turn with no admission row.
  const legacy = { ownerId, conversationId, requestId: randomUUID(), text: "legacy" };
  const turn = await store.beginTurn(legacy, { workflowRunId: randomUUID(), activityId: "legacy", attempt: 1 });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  await store.commitTurn({ ownerId, conversationId, requestId: legacy.requestId, token: turn.token, reply: "legacy reply",
    checkpoint: { version: 1, engine: "pi", state: {} } });
  const admitted = { ownerId, conversationId, requestId: randomUUID(), text: "admitted" };
  // A bare string, or an activity bound without its initiator, is refused before anything is written.
  for (const initiator of ["owner", undefined]) {
    await assert.rejects(store.recordAcceptance(admitted, initiator as never), z.ZodError);
  }
  await store.recordAcceptance(admitted, ownerInitiator);
  assert.deepEqual(await initiators(), [
    { type: "member.spawned", requestId: null, ...owner }, { type: "conversation.opened", requestId: null, ...owner },
    { type: "request.finished", requestId: legacy.requestId, ...owner }, { type: "request.accepted", requestId: admitted.requestId, ...owner },
  ]);
  assert.equal(await admittedInitiator(pool, legacy), null);
  assert.deepEqual(await admittedInitiator(pool, admitted), { kind: "owner" });

  // A version-23 database with both CHECKs dropped admits any kind, which shows the row is copied
  // from the admission rather than assumed. routines.test.ts checks real routine admissions. A
  // separate database keeps the DDL's locks away from other suites.
  const widened = await databaseAt(t, 23);
  await widened.query(`ALTER TABLE birbcrew_ts.request_admissions DROP CONSTRAINT request_admissions_initiator_kind_check;
    ALTER TABLE birbcrew_ts.audit_events DROP CONSTRAINT audit_events_initiator_check`);
  const { rows: [{ member_id: memberId }] } = await widened.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi',$3) RETURNING member_id`, [ownerId, randomUUID(), profile]);
  await widened.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)",
    [ownerId, memberId, conversationId]);
  const scheduled = randomUUID();
  await widened.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind,initiator_id)
    VALUES ($1,$2,$3,'routine','routine-7')`, [conversationId, scheduled, createHash("sha256").update("scheduled").digest()]);
  const db = await widened.connect();
  try {
    await appendAudit(db, { type: "request.finished", ownerId, memberId, conversationId, requestId: scheduled,
      payload: { status: "failed" } });
  } finally { db.release(); }
  const { rows: [row] } = await widened.query(`SELECT initiator_kind AS kind, initiator_id AS id, actor_kind AS actor
    FROM birbcrew_ts.audit_events WHERE request_id=$1`, [scheduled]);
  assert.deepEqual(row, { kind: "routine", id: "routine-7", actor: "system" });
});

test("the initiator CHECKs and the TypeScript initiator type name the same kinds", async () => {
  const { rows } = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE (conrelid,conname) IN (('birbcrew_ts.request_admissions'::regclass,'request_admissions_initiator_kind_check'),
      ('birbcrew_ts.audit_events'::regclass,'audit_events_initiator_check'))`);
  assert.equal(rows.length, 2);
  for (const { definition } of rows) {
    assert.deepEqual([...new Set([...definition.matchAll(/'([a-z_]+)'/g)].map(match => match[1]))].sort(), [...initiatorKinds].sort(), definition);
  }
});

test("the actor CHECK and the TypeScript actor kinds name the same kinds", async () => {
  const { rows: [{ definition }] } = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='birbcrew_ts.audit_events'::regclass AND conname='audit_events_actor_check'`);
  assert.deepEqual([...new Set([...definition.matchAll(/'([a-z_]+)'/g)].map(match => match[1]))].sort(), [...actorKinds].sort(), definition);
});

/** The same instant written with a +05:30 offset, keeping its microseconds. */
function atOffset(occurredAt: string) {
  const [, seconds, fraction] = /^(.*:\d{2})(\.\d{6})Z$/.exec(occurredAt)!;
  return new Date(Date.parse(seconds + "Z") + 330 * 60_000).toISOString().slice(0, 19) + fraction + "+05:30";
}

test("filters select the owner's rows with AND in JSON and CSV, page with the unchanged cursor and never reach another owner", async (t) => {
  const f = await fixture(); t.after(f.stop);
  const spawn = async (requestId = randomUUID()) => {
    const response = await f.api("/v1/members", { requestId, engine: "pi", profile });
    assert.equal(response.status, 201);
    return (await response.json()).memberId as string;
  };
  const spawnRequestId = randomUUID();
  const handled = await spawn(spawnRequestId), scheduled = await spawn();
  assert.equal(await spawn(spawnRequestId), handled, "a replayed spawn");

  // The owner denies a call on the first member.
  const conversationId = randomUUID();
  assert.equal((await f.api("/v1/conversations", { conversationId, memberId: handled })).status, 201);
  const request = { ownerId: f.ownerId, conversationId, requestId: randomUUID(), text: "filtered prompt" };
  assert.equal((await f.api(`/v1/conversations/${conversationId}/requests`, { requestId: request.requestId, text: request.text })).status, 202);
  const turn = await store.beginTurn(request);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const approval = await approvals.propose({ ownerId: f.ownerId, memberId: handled, conversationId, requestId: request.requestId,
    token: turn.token, invocationId: request.requestId, nativeCallId: "filter-call", toolName: "record_work_item",
    arguments: { operation_id: request.requestId } });
  assert.equal((await f.api(`/v1/conversations/${conversationId}/human`, { memberId: handled, requestId: request.requestId,
    invocationId: request.requestId, approvalId: approval.approvalId, version: approval.version, choice: "deny" })).status, 200);

  // A routine on the second member fires once and its turn completes. Its windows are in 2099, so the
  // gateway's own dispatcher, on the real clock, never fires it.
  let now = new Date("2099-01-05T10:00:00.000Z");
  const clock = () => new Date(now);
  const { routineId } = await new RoutineApi(store, clock).create(f.ownerId, { requestId: randomUUID(), memberId: scheduled,
    schedule: "*/15 * * * *", prompt: "scheduled prompt", approvalPolicy: "wait" });
  const members = {
    open: (input: Parameters<MemberStore["openConversation"]>[0]) => store.openConversation(input),
    async accept(input: TurnRequest) { await store.recordAcceptance(input, ownerInitiator); return { requestId: input.requestId }; },
    requestStatus: (input: Parameters<MemberStore["requestStatus"]>[0]) => store.requestStatus(input),
  } as unknown as MemberClient;
  const dispatcher = new RoutineDispatcher({ store, members, integration: new IntegrationApi(store, members), owners: [f.ownerId], clock });
  t.after(() => dispatcher.stop());
  await dispatcher.tick();
  now = new Date(now.getTime() + 15 * 60_000);
  await dispatcher.tick();
  const { rows: [firing] } = await pool.query<{ conversationId: string; requestId: string }>(`SELECT conversation_id AS "conversationId",
    request_id AS "requestId" FROM birbcrew_ts.routine_firings WHERE routine_id=$1`, [routineId]);
  const firedTurn = await store.beginTurn({ ownerId: f.ownerId, ...firing, text: "scheduled prompt" });
  assert.equal(firedTurn.kind, "start"); if (firedTurn.kind !== "start") return;
  await store.commitTurn({ ownerId: f.ownerId, ...firing, token: firedTurn.token, reply: "done", checkpoint: { version: 1, engine: "pi", state: {} } });
  now = new Date(now.getTime() + 60_000);
  await dispatcher.tick();
  const strangerMember = (await store.spawn({ ownerId: f.strangerId, requestId: randomUUID(), engine: "pi", profile })).memberId;

  const all = (await f.audit()).events;
  assert.deepEqual(all.map(event => event.type), ["member.spawned", "member.spawned", "conversation.opened", "request.accepted",
    "approval.decided", "routine.created", "conversation.opened", "request.accepted", "request.finished", "routine.firing_settled"]);
  assert.deepEqual(all.filter(event => event.initiator.kind === "routine").map(event => [event.type, event.initiator.id]),
    [["request.accepted", routineId], ["request.finished", routineId]]);
  const ids = async (query: string, credential?: string) => (await f.audit("?" + query, credential)).events.map(event => event.eventId);
  const [split, start, end] = [all[5], all[2], all[8]].map(event => event.occurredAt);
  const cases: [string, (event: Event) => boolean][] = [
    ["memberId=" + handled, event => event.memberId === handled],
    ["memberId=" + scheduled.toUpperCase(), event => event.memberId === scheduled],
    [`memberId=${handled}&eventType=approval.decided`, event => event.memberId === handled && event.type === "approval.decided"],
    ["eventType=request.finished,request.accepted", event => event.type === "request.accepted" || event.type === "request.finished"],
    ["eventType=routine.created", event => event.type === "routine.created"],
    ["actorKind=system", event => event.actor.kind === "system"],
    ["actorKind=owner&memberId=" + scheduled, event => event.actor.kind === "owner" && event.memberId === scheduled],
    ["initiatorKind=routine", event => event.initiator.kind === "routine"],
    ["initiatorKind=owner&memberId=" + scheduled, event => event.initiator.kind === "owner" && event.memberId === scheduled],
    ["initiatorId=" + routineId.toUpperCase(), event => event.initiator.kind === "routine"],
    ["initiatorKind=owner&initiatorId=" + routineId, () => false],
    ["initiatorId=" + randomUUID(), () => false],
    ["from=" + split, event => event.occurredAt >= split],
    ["to=" + split, event => event.occurredAt < split],
    [`from=${encodeURIComponent(atOffset(start))}&to=${encodeURIComponent(atOffset(end))}`,
      event => event.occurredAt >= start && event.occurredAt < end],
    [`from=${split.toLowerCase()}&memberId=${scheduled}&actorKind=system&eventType=request.finished,routine.firing_settled`,
      event => event.occurredAt >= split && event.memberId === scheduled && event.actor.kind === "system"
        && (event.type === "request.finished" || event.type === "routine.firing_settled")],
    ["from=0001-01-01T00:00:00%2B15:59&to=9999-12-31T23:59:59.999999-15:59", () => true],
    [`from=${split}&to=${split}`, () => false],
    [`from=${end}&to=${start}`, () => false],
  ];
  for (const [query, keep] of cases) assert.deepEqual(await ids(query), all.filter(keep).map(event => event.eventId), query);
  const [denial] = (await f.audit(`?memberId=${handled}&eventType=approval.decided`)).events;
  assert.equal(denial.payload.choice, "deny");
  // The replayed spawn appended nothing: one row through a filter, in either format.
  const spawned = `eventType=member.spawned&memberId=${handled}`;
  assert.deepEqual((await f.audit("?" + spawned)).events.map(event => event.payload.spawnRequestId), [spawnRequestId]);
  assert.equal((await (await f.api("/v1/audit?format=csv&" + spawned)).text()).split("\r\n").length, 3);

  // CSV returns the same rows and cursor as JSON for the same filters.
  for (const query of [`memberId=${scheduled}&limit=2`, `initiatorId=${routineId}&limit=1`, "actorKind=system&limit=1000"]) {
    const page = await f.audit("?" + query);
    const csv = await f.api("/v1/audit?format=csv&" + query);
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get("audit-next-after"), page.nextAfter, query);
    assert.equal(csv.headers.get("audit-has-more"), String(page.hasMore), query);
    assert.deepEqual((await csv.text()).split("\r\n").slice(1, -1).map(line => line.split(",")[0]), page.events.map(event => event.eventId));
  }

  // Keyset pages over a filter: nextAfter is the last returned ID, or the given after for an empty page.
  const paged: string[] = [];
  let after = "0", pages = 0;
  for (;;) {
    const page = await f.audit(`?memberId=${scheduled}&limit=1&after=${after}`);
    paged.push(...page.events.map(event => event.eventId)); pages++;
    after = page.nextAfter;
    if (!page.hasMore) break;
  }
  const own = all.filter(event => event.memberId === scheduled).map(event => event.eventId);
  assert.deepEqual([paged, pages], [own, own.length]);
  assert.deepEqual(await f.audit(`?memberId=${scheduled}&after=${after}`), { apiVersion: "1", events: [], nextAfter: after, hasMore: false });
  assert.deepEqual(await f.audit(`?memberId=${handled}&after=${after}`), { apiVersion: "1", events: [], nextAfter: after, hasMore: false });
  // A retried read returns the same page.
  const query = "?eventType=request.accepted,request.finished&initiatorKind=routine&limit=1";
  assert.deepEqual(await f.audit(query), await f.audit(query));
  assert.equal((await f.api("/v1/audit?format=csv&limit=10000&memberId=" + handled)).status, 200);
  assert.equal((await f.api("/v1/audit?limit=1001&memberId=" + handled)).status, 400);

  // Owner scoping comes first: another owner's member, routine or conversation is an empty page, never 404.
  assert.deepEqual(await f.audit("?memberId=" + strangerMember), { apiVersion: "1", events: [], nextAfter: "0", hasMore: false });
  for (const query of ["memberId=" + handled, "initiatorId=" + routineId, "conversationId=" + conversationId,
    "eventType=approval.decided", "initiatorKind=routine"]) {
    assert.deepEqual((await f.audit("?" + query, f.stranger)).events, [], query);
  }
  assert.deepEqual((await f.audit("?eventType=member.spawned&actorKind=owner&from=2000-01-01T00:00:00Z", f.stranger)).events
    .map(event => event.memberId), [strangerMember]);

  const capabilities = await (await f.api("/v1/capabilities")).json();
  assert.deepEqual(capabilities.audit.filters, ["conversationId", "memberId", "eventType", "actorKind", "initiatorKind", "initiatorId", "from", "to"]);
  assert.deepEqual(capabilities.audit.filters, auditFilterNames);
  assert.deepEqual(capabilities.audit.actorKinds, ["owner", "system"]);
});

test("filter values are validated at the gateway: unknown types and kinds and malformed IDs or timestamps are 400", async (t) => {
  const f = await fixture(); t.after(f.stop);
  for (const query of ["memberId=not-a-uuid", "memberId=", "memberId=" + randomUUID() + "&memberId=" + randomUUID(),
    "eventType=", "eventType=request.deleted", "eventType=request.accepted,", "eventType=,request.accepted",
    "eventType=request.accepted,request.accepted", "eventType=Request.Accepted", "eventType=request.accepted%20",
    "eventType=request.accepted&eventType=request.finished", "eventType=__proto__",
    "actorKind=routine", "actorKind=OWNER", "actorKind=", "initiatorKind=system", "initiatorKind=operator", "initiatorKind=",
    "initiatorId=routine-7", "initiatorId=", "initiatorId=" + f.ownerId,
    "from=2026-11-12", "from=2026-11-12T08:15:30", "from=2026-11-12%2008:15:30Z", "from=2026-11-12T08:15Z",
    "from=2026-02-29T00:00:00Z", "from=2026-13-01T00:00:00Z", "from=2026-04-31T00:00:00Z", "from=2026-11-12T24:00:00Z",
    "from=2016-12-31T23:59:60Z", "from=2026-11-12T08:15:30.Z", "from=2026-11-12T08:15:30.1234567Z",
    "from=0000-01-01T00:00:00Z", "from=2026-11-12T08:15:30%2B16:00", "from=2026-11-12T08:15:30-00:60",
    // An unencoded + is a space in a query string.
    "from=2026-11-12T08:15:30+05:30", "from=%2B2026-11-12T08:15:30Z", "from=1700000000", "to=yesterday", "to=now()",
    "to=" + encodeURIComponent("2026-11-12T08:15:30Z' OR '1'='1")]) {
    const response = await f.api("/v1/audit?" + query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_input" }, query);
  }
  for (const query of ["from=2024-02-29T00:00:00Z", "from=2000-02-29T23:59:59.5-15:59", "to=2026-11-12t08:15:30.123456z",
    "from=2026-11-12T08:15:30-00:00", "eventType=" + auditEventTypes.join(",")]) {
    assert.equal((await f.api("/v1/audit?" + query)).status, 200, query);
  }
});

test("migration 30 indexes a version-29 trail without queueing for an open audited write or waiting for a native turn", async (t) => {
  const upgraded = await databaseAt(t, 29);
  const current = new MemberStore(upgraded);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { memberId } = await current.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  await current.openConversation({ ownerId, memberId, conversationId });
  await current.recordAcceptance({ ownerId, conversationId, requestId, text }, ownerInitiator);

  // It locks only audit_events, in SHARE mode, and rewrites nothing.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const file = "SELECT pg_relation_filenode('birbcrew_ts.audit_events') AS audit";
    const { rows: [before] } = await db.query(file);
    await db.query(await readFile(new URL("030-audit-filters.sql", sql), "utf8"));
    assert.deepEqual((await db.query(file)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace ORDER BY 1,2`);
    assert.deepEqual(rows, [{ relation: "audit_events", mode: "ShareLock" }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  const [opening, second] = [randomUUID(), randomUUID()];
  await withNativeAdmission(upgraded, { ownerId, conversationId, requestId, text, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    // An open audited write: the migration retries rather than queue, so the write's next append is not held up.
    const holder = await upgraded.connect();
    try {
      await holder.query("BEGIN");
      for (const opened of [opening, second]) {
        await holder.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, opened]);
      }
      await appendAudit(holder, { type: "conversation.opened", ownerId, memberId, conversationId: opening, payload: {} });
      let migrated = false;
      const migrating = current.migrate().then(() => { migrated = true; });
      for (let i = 0; i < 10; i++) {
        await delay(30);
        const { rows: waiting } = await upgraded.query(`SELECT pid FROM pg_locks WHERE NOT granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
        assert.deepEqual(waiting, [], "the migration retries instead of queueing");
      }
      assert.equal(migrated, false);
      const appended = Date.now();
      await appendAudit(holder, { type: "conversation.opened", ownerId, memberId, conversationId: second, payload: {} });
      assert.ok(Date.now() - appended < 1_000, "the open write's next append is not held up");
      await holder.query("COMMIT");
      const finished = await Promise.race([migrating.then(() => true), delay(5_000, false)]);
      assert.equal(finished, true, "migration 30 must not wait for a running native turn");
    } finally { holder.release(); }
    await current.appendText({ ownerId, conversationId, requestId, token: start.token }, requestId + "/assistant", 0, "still running");
  });

  const { rows: indexes } = await upgraded.query(`SELECT indexname AS name FROM pg_indexes WHERE schemaname='birbcrew_ts'
    AND indexname IN ('audit_events_member_page','audit_events_type_page','audit_events_initiator_page') ORDER BY 1`);
  assert.deepEqual(indexes.map(index => index.name), ["audit_events_initiator_page", "audit_events_member_page", "audit_events_type_page"]);
  // Rows written before the upgrade are filtered like new ones, and the table is still append-only.
  const page = await readAudit(upgraded, ownerId, auditQuerySchema.parse({ memberId, eventType: "request.accepted,conversation.opened" }));
  assert.deepEqual(page.events.map(event => [event.type, event.conversationId]), [["conversation.opened", conversationId],
    ["request.accepted", conversationId], ["conversation.opened", opening], ["conversation.opened", second]]);
  await assert.rejects(upgraded.query("DELETE FROM birbcrew_ts.audit_events WHERE owner_id=$1", [ownerId]), { code: "23514" });
  // migrate() brought it to the newest migration in the directory, whatever that is.
  const migrations = (await readdir(sql)).map(file => Number(file.split("-")[0])).sort((a, b) => a - b);
  assert.deepEqual((await upgraded.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version>=29 ORDER BY 1")).rows
    .map(row => row.version), migrations.filter(version => version >= 29));
});

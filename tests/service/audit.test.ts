import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { appendAudit, auditCsv, auditEventTypes, auditQuerySchema, type AuditEvent } from "../../src/service/audit.ts";
import { ChildStore } from "../../src/service/children.ts";
import type { MemberClient } from "../../src/service/client.ts";
import type { TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { MemberStore } from "../../src/service/store.ts";

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
    async accept(input: TurnRequest) { await store.recordAcceptance(input); return { requestId: input.requestId }; },
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
  await Promise.all([store.recordAcceptance(input), store.recordAcceptance(input)]);
  await store.recordAcceptance(input);
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
  await store.recordAcceptance(queued);
  const members = { accept: async () => ({ requestId: queued.requestId }), requestStatus: (k: Parameters<MemberStore["requestStatus"]>[0]) => store.requestStatus(k), cancelPending: async () => {} };
  const api = new IntegrationApi(store, members as unknown as MemberClient);
  const receipt = await api.cancel({ ...key, requestId: queued.requestId });
  assert.equal((await api.cancel({ ...key, requestId: queued.requestId })).cancellation?.receiptId, receipt.cancellation?.receiptId);
  await store.rejectAccepted(queued, "predecessor_cancelled");
  await store.rejectAccepted(queued, "predecessor_cancelled");

  // A started turn cancelled by the workflow, then reconciled twice as uncertain.
  const running = { ...key, requestId: randomUUID(), text: "running" };
  await store.recordAcceptance(running);
  const execution = { workflowRunId: randomUUID(), activityId: "retry", attempt: 1 };
  assert.equal((await store.beginTurn(running, execution)).kind, "start");
  assert.equal(await store.cancelGenerating(running), true);
  assert.equal(await store.cancelGenerating(running), true);
  assert.equal(await store.reconcileTurn(running, execution.workflowRunId, false), null);
  assert.equal(await store.reconcileTurn(running, execution.workflowRunId, false, false), null);

  // A failed Pi delegation is quarantined, retried by Temporal, and never reconciled.
  const delegated = { ownerId, conversationId: randomUUID(), requestId: randomUUID(), text: "delegate" };
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId: delegated.conversationId });
  await store.recordAcceptance(delegated);
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
  // A null or missing natural key would never collide, so the CHECK demands a string.
  for (const payload of [`'{"approvalId":null}'`, "'{}'"]) {
    await assert.rejects(pool.query(insert.replace("'{}'", payload), [ownerId, "approval.decided", member.memberId,
      conversationId, randomUUID()]), { code: "23514" }, payload);
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
    await delay(100);
    await store.spawn({ ownerId: f.ownerId, requestId: during, engine: "pi", profile }); // not queued behind the reader
    await delay(100);
    assert.equal(settled, false, "the reader waits for the open writer instead of paging past its ID");
    await writer.query("COMMIT");
    const page = await reading;
    assert.deepEqual(page.events.map(event => event.payload.spawnRequestId), [early, late, during]);
  } finally { writer.release(); }
});

test("the SQL CHECK and the TypeScript registry name the same event types", async () => {
  const { rows: [constraint] } = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='birbcrew_ts.audit_events'::regclass AND conname='audit_events_type_check'`);
  const named = new Set([...constraint.definition.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(match => match[1]));
  assert.deepEqual([...named].sort(), [...auditEventTypes].sort());
});

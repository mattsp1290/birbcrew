import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { MemberStore } from "../../src/service/store.ts";
import type { Engine } from "../../src/service/domain.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
before(() => Promise.all([store.migrate(), store.migrate()]));
after(() => pool.end());

async function newConversation(engine: Engine) {
  const ownerId = randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine, profile: "fixture-v1" });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
  return { ownerId, conversationId };
}

test("spawn and open preserve the member choice across races, reconnects and tenants", async () => {
  const ownerId = randomUUID();
  const spawn = { ownerId, requestId: randomUUID(), engine: "pi" as const, profile: "fixture-v1" };
  const [a, b] = await Promise.all([store.spawn(spawn), store.spawn(spawn)]);
  assert.deepEqual(a, b);
  await assert.rejects(store.spawn({ ...spawn, engine: "claude" }), { code: "conflict" });
  await assert.rejects(store.spawn({ ...spawn, profile: "fixture-v2" }), { code: "conflict" });
  const other = await store.spawn({ ...spawn, ownerId: randomUUID(), engine: "claude" });
  assert.notEqual(other.memberId, a.memberId);
  const open = { ownerId, memberId: a.memberId, conversationId: randomUUID() };
  const [c, d] = await Promise.all([store.openConversation(open), store.openConversation(open)]);
  assert.deepEqual(c, d);
  const second = await store.openConversation({ ...open, conversationId: randomUUID() });
  const secondMember = await store.spawn({ ...spawn, requestId: randomUUID(), engine: "claude" });
  await assert.rejects(store.openConversation({ ...open, memberId: secondMember.memberId }), { code: "conflict" });
  await assert.rejects(store.openConversation({ ...open, ownerId: other.ownerId }), { code: "not_found" });
  await assert.rejects(store.openConversation({ ...open, memberId: other.memberId, ownerId: other.ownerId }), { code: "not_found" });
  await assert.rejects(store.getConversation({ ownerId: other.ownerId, conversationId: c.conversationId }), { code: "not_found" });
  const reconnected = new Pool({ connectionString: url });
  try {
    const freshStore = new MemberStore(reconnected);
    for (const conversation of [c, second]) {
      assert.deepEqual(await freshStore.getConversation({ ownerId, conversationId: conversation.conversationId }), conversation);
    }
    assert.deepEqual(await freshStore.spawn(spawn), a);
  } finally {
    await reconnected.end();
  }
  await assert.rejects(pool.query("UPDATE birbcrew_ts.members SET engine='claude' WHERE member_id=$1", [a.memberId]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.conversations SET member_id=$1 WHERE conversation_id=$2",
    [secondMember.memberId, c.conversationId]), { code: "23514" });
});

test("one start wins, a lost acknowledgement replays, private context advances once", async () => {
  const key = await newConversation("pi");
  const input = { ...key, requestId: randomUUID(), text: " one\n" };
  const execution = { workflowRunId: randomUUID(), activityId: "turn-1", attempt: 1 };
  const turns = await Promise.all([store.beginTurn(input, execution), store.beginTurn(input, execution)]);
  assert.deepEqual(turns.map((x) => x.kind).sort(), ["start", "uncertain"]);
  const first = turns.find((x) => x.kind === "start");
  assert.ok(first);
  assert.equal(first.checkpoint, null);
  const claim = { ...key, requestId: input.requestId, token: first.token };
  const checkpoint = { version: 1, engine: "pi", state: { native: [1, 2], private: true } };
  const commit = { ...claim, checkpoint, reply: "one reply" };
  await assert.rejects(store.commitTurn({ ...commit, ownerId: randomUUID() }), { code: "not_found" });
  await assert.rejects(store.commitTurn({ ...commit, checkpoint: { ...checkpoint, engine: "claude" } }), { code: "conflict" });
  await assert.rejects(store.commitTurn({ ...commit, token: randomUUID() }), { code: "stale" });
  await assert.rejects(store.beginTurn({ ...input, requestId: randomUUID() }), { code: "busy" });
  const attemptedOverride = { ...input, engine: "claude" };
  await assert.rejects(store.beginTurn(attemptedOverride), { name: "ZodError" });
  assert.deepEqual(await Promise.all([store.commitTurn(commit), store.commitTurn(commit)]), ["one reply", "one reply"]);
  await assert.rejects(store.commitTurn({ ...commit, reply: "changed" }), { code: "stale" });
  await assert.rejects(store.commitTurn({ ...commit, checkpoint: { ...checkpoint, state: null } }), { code: "stale" });
  await assert.rejects(store.markUncertain(claim), { code: "stale" });
  assert.deepEqual(await store.beginTurn(input, { ...execution, attempt: 2 }), { kind: "replay", reply: "one reply" });
  await assert.rejects(store.beginTurn({ ...input, text: input.text.trim() }), { code: "conflict" });
  for (let i = 2; i <= 4; i++) {
    const requestId = randomUUID();
    const next = await store.beginTurn({ ...key, requestId, text: "next" });
    assert.equal(next.kind, "start");
    assert.deepEqual(next.checkpoint, checkpoint);
    await store.commitTurn({ ...key, requestId, token: next.token, checkpoint, reply: "next" });
  }
  await assert.rejects(store.beginTurn({ ...input, requestId: randomUUID() }), { code: "input_limit" });
  assert.deepEqual(await store.beginTurn(input), { kind: "replay", reply: "one reply" });
});

test("higher Temporal attempt fences an unfinished SDK call and cannot launch a second one", async () => {
  const key = await newConversation("claude");
  const requestId = randomUUID();
  const input = { ...key, requestId, text: "pending" };
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 2 };
  const start = await store.beginTurn(input, execution);
  assert.equal(start.kind, "start");
  const claim = { ...key, requestId, token: start.token };
  await assert.rejects(store.beginTurn(input, { ...execution, attempt: 1 }), { code: "stale" });
  await assert.rejects(store.beginTurn(input, { ...execution, workflowRunId: randomUUID(), attempt: 3 }), { code: "stale" });
  await assert.rejects(store.beginTurn(input, { ...execution, activityId: "different", attempt: 3 }), { code: "stale" });
  assert.deepEqual(await store.beginTurn(input, { ...execution, attempt: 3 }), { kind: "uncertain" });
  await assert.rejects(store.commitTurn({ ...claim, reply: "late", checkpoint: { version: 1, engine: "claude", state: {} } }), { code: "stale" });
  assert.deepEqual(await store.beginTurn(input, { ...execution, attempt: 4 }), { kind: "uncertain" });
  await assert.rejects(store.beginTurn({ ...input, requestId: randomUUID() }), { code: "busy" });
});

test("uncertain native outcome is durable and scoped to its conversation", async () => {
  const key = await newConversation("pi");
  const requestId = randomUUID();
  const input = { ...key, requestId, text: "fail" };
  const start = await store.beginTurn(input);
  assert.equal(start.kind, "start");
  const claim = { ...key, requestId, token: start.token };
  await Promise.all([store.markUncertain(claim), store.markUncertain(claim)]);
  assert.deepEqual(await store.beginTurn(input), { kind: "uncertain" });
  await assert.rejects(store.commitTurn({ ...claim, reply: "late", checkpoint: { version: 1, engine: "pi", state: {} } }), { code: "stale" });
  const other = await newConversation("pi");
  const independent = await store.beginTurn({ ...input, ...other });
  assert.equal(independent.kind, "start");
  assert.equal(independent.checkpoint, null);
});

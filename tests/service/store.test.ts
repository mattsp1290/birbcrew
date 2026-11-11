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
  for (let i = 2; i <= 128; i++) {
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
  const messageId = requestId + "/assistant";
  await store.appendText(claim, messageId, 0, "provisional");
  await store.appendText(claim, messageId, 0, "provisional");
  await assert.rejects(store.appendText(claim, messageId, 0, "changed"), { code: "conflict" });
  await assert.rejects(store.beginTurn(input, { ...execution, attempt: 1 }), { code: "stale" });
  await assert.rejects(store.beginTurn(input, { ...execution, workflowRunId: randomUUID(), attempt: 3 }), { code: "stale" });
  await assert.rejects(store.beginTurn(input, { ...execution, activityId: "different", attempt: 3 }), { code: "stale" });
  assert.deepEqual(await store.beginTurn(input, { ...execution, attempt: 3 }), { kind: "uncertain" });
  await assert.rejects(store.commitTurn({ ...claim, reply: "late", checkpoint: { version: 1, engine: "claude", state: {} } }), { code: "stale" });
  await assert.rejects(store.appendText(claim, messageId, 1, "late"), { code: "stale" });
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

test("a committed stop request fences a late native argument frame", async () => {
  const key = await newConversation("pi");
  const request = { ...key, requestId: randomUUID(), text: "record" };
  const run = { workflowRunId: randomUUID(), activityId: "activity", attempt: 1 };
  const start = await store.beginTurn(request, run);
  assert.equal(start.kind, "start");
  const claim = { ...key, requestId: request.requestId, token: start.token };
  const ids = [key.conversationId, request.requestId, start.token];
  await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [...ids, run.workflowRunId, run.activityId]);
  await pool.query("INSERT INTO birbcrew_ts.native_stop_requests (conversation_id,request_id,token) VALUES ($1,$2,$3)", ids);
  await assert.rejects(store.previewTool(claim, "late-call", true), { code: "stale" });
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.tool_previews WHERE conversation_id=$1", [key.conversationId])).rowCount, 0);
});

test("rollover preserves ordered receipts, first-run audit and complete AG-UI history", async () => {
  const key = await newConversation("pi");
  const requests: {requestId:string;text:string;ownerId:string;conversationId:string}[] = [];
  const runs = [randomUUID(),randomUUID(),randomUUID()];
  for (let i=0;i<12;i++) {
    const request = {...key,requestId:randomUUID(),text:`turn ${i+1}`};
    requests.push(request);
    const started = await store.beginTurn(request,{workflowRunId:runs[Math.floor(i/4)],activityId:`turn-${i+1}`,attempt:1});
    assert.equal(started.kind,"start");
    if(started.kind!=="start")throw new Error("not started");
    await store.commitTurn({...key,requestId:request.requestId,token:started.token,reply:`reply ${i+1}`,
      checkpoint:{version:1,engine:"pi",state:{turns:i+1}}});
  }
  assert.equal(await store.workflowRunId(key),runs[0]);
  assert.deepEqual(await store.conversationProgress(key),{turns:12,limit:128,terminal:false});
  for(let i=0;i<12;i++) {
    assert.equal(await store.committedReply(requests[i]),`reply ${i+1}`);
    assert.deepEqual(await store.beginTurn(requests[i]),{kind:"replay",reply:`reply ${i+1}`});
    await assert.rejects(store.committedReply({...requests[i],text:"changed"}),{code:"conflict"});
  }
  const {readSnapshot}=await import("../../src/service/observation.ts");
  const snapshot=await readSnapshot(pool,key.ownerId,key.conversationId);
  assert.equal(snapshot.state.phase,"idle");
  assert.deepEqual(snapshot.messages.filter(m=>m.role==="user").map(m=>m.content),requests.map(r=>r.text));
  assert.equal(snapshot.messages.length,24);
  await assert.rejects(store.conversationProgress({...key,ownerId:randomUUID()}),{code:"not_found"});
});

test("legacy proof budget remains four and does not resurrect closed conversations", async () => {
  const key=await newConversation("pi");
  // Migration16 sets existing conversations to4 before changing only the default.
  await pool.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1",[key.conversationId]);
  for(let i=0;i<4;i++) {
    const request={...key,requestId:randomUUID(),text:`legacy ${i}`};
    const started=await store.beginTurn(request);
    assert.equal(started.kind,"start");
    if(started.kind!=="start")throw new Error("not started");
    await store.commitTurn({...key,requestId:request.requestId,token:started.token,reply:"ok",checkpoint:{version:1,engine:"pi",state:{}}});
  }
  assert.deepEqual(await store.conversationProgress(key),{turns:4,limit:4,terminal:true});
  await assert.rejects(store.beginTurn({...key,requestId:randomUUID(),text:"fifth"}),{code:"input_limit"});
  const {readSnapshot}=await import("../../src/service/observation.ts");
  assert.equal((await readSnapshot(pool,key.ownerId,key.conversationId)).state.phase,"complete");
});

test("durable admissions preserve rejected queue outcomes without replay or identity reuse", async () => {
  const key=await newConversation("pi");
  const first={...key,requestId:randomUUID(),text:"pending first"};
  const queued={...key,requestId:randomUUID(),text:"queued private prompt"};
  await store.recordAcceptance(first);
  await Promise.all([store.recordAcceptance(queued),store.recordAcceptance(queued)]);
  await assert.rejects(store.recordAcceptance({...queued,text:"changed"}),{code:"conflict"});
  assert.deepEqual(await store.requestStatus({...key,requestId:queued.requestId}),{requestId:queued.requestId,phase:"accepted"});
  await store.rejectAccepted(queued,"predecessor_cancelled");
  await store.rejectAccepted(queued,"predecessor_cancelled");
  const fresh=new MemberStore(pool);
  assert.deepEqual(await fresh.requestStatus({...key,requestId:queued.requestId}),{
    requestId:queued.requestId,phase:"rejected",reason:"predecessor_cancelled"});
  await assert.rejects(fresh.recordAcceptance(queued),{code:"request_rejected"});
  await assert.rejects(fresh.committedReply(queued),{code:"request_rejected"});
  await assert.rejects(fresh.beginTurn(queued),{code:"request_rejected"});
  await assert.rejects(fresh.requestStatus({...key,ownerId:randomUUID(),requestId:queued.requestId}),{code:"not_found"});
  const active=await store.beginTurn(first);
  assert.equal(active.kind,"start");
  await assert.rejects(store.rejectAccepted(first,"predecessor_failed"),{code:"conflict"});
  const count=await pool.query("SELECT count(*)::int AS count FROM birbcrew_ts.turns WHERE conversation_id=$1",[key.conversationId]);
  assert.equal(count.rows[0].count,1);
});

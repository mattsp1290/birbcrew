import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Pool } from "pg";
import { ChildStore, type ChildKey } from "../../src/service/children.ts";
import { ChildTargetError, type ChildProfile, type ChildTarget } from "../../src/service/child-target.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { MemberStoreError, type Conversation } from "../../src/service/domain.ts";
import { memberProfiles, type MemberProfile } from "../../src/service/profiles.ts";
import { MemberStore } from "../../src/service/store.ts";
import { runnerResultSchema } from "../../src/service/supervisor.ts";
import { recordSegmentUsage } from "../../src/service/usage.ts";
import type { PriceTable } from "../../src/service/usage-prices.ts";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";

// Child targets in the shared child path (docs/architecture.md): the stored record, the refusals,
// depth, and the usage ledger. Needs a disposable PostgreSQL database; no Temporal, no inference.
const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const children = new ChildStore(pool);
const stateDir = await mkdtemp(join(tmpdir(), "birb-child-targets-"));
const suffix = randomUUID();
const names = {
  crew: "crew-" + suffix, analysts: "analysts-" + suffix, chat: "chat-" + suffix, claude: "claude-" + suffix, codex: "codex-" + suffix,
};
const roles = {
  analyst: "Answer the assigned question using only the supplied task context.",
  recorder: "Complete the assigned task. Request owner approval to record a work item when asked.",
} as const;
before(async () => {
  await store.migrate();
  // Registration reads only which engines a profile has, and its tools.
  const pi = {} as NonNullable<MemberProfile["pi"]>;
  await registerProfiles(pool, new Map<string, MemberProfile>([
    [names.crew, { accountId: "crew", pi, delegateTask: true, protectedTool: "record_work_item" }],
    [names.analysts, { accountId: "analysts", pi, delegateTask: true }],
    [names.chat, { accountId: "chat", pi }],
    [names.claude, { accountId: "claude", claude: { model: "fixture", apiKey: "synthetic" } }],
    [names.codex, { accountId: "codex", codex: { model: "fixture" } }],
  ]), stateDir);
});
after(async () => {
  await pool.end();
  await rm(stateDir, { recursive: true, force: true });
});

const checkpoint = { version: 1, engine: "pi", state: {} };
function proposal(task: string, target?: unknown, role: "analyst" | "recorder" = "analyst") {
  return { nativeCallId: "call_" + randomUUID(), task, profile: { role, version: 1 as const, instructions: roles[role], model: "fixture",
    tools: role === "recorder" ? ["record_work_item" as const] : [], ...(target !== undefined && { target: target as ChildTarget }) } };
}

/** A Pi parent turn admitted and started, as the conversation workflow's first segment leaves it. */
async function parentTurn(profile = names.crew) {
  const ownerId = "owner-" + randomUUID();
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId, conversationId, memberId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "delegate" };
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const turn = await store.beginTurn(request, execution);
  assert.equal(turn.kind, "start");
  if (turn.kind !== "start") throw new Error("unreachable");
  const delegate = (proposals: ReturnType<typeof proposal>[], token = turn.token) =>
    children.delegate(turn.conversation, request.requestId, token, proposals, checkpoint);
  const delegations = async () => (await pool.query("SELECT 1 FROM birbcrew_ts.delegations WHERE request_id=$1", [request.requestId])).rowCount;
  return { request, execution, token: turn.token, conversation: turn.conversation, delegate, delegations };
}
const roleProfiles = async (requestId: string) => (await pool.query<{ role_profile: ChildProfile }>(
  "SELECT role_profile FROM birbcrew_ts.pi_children WHERE request_id=$1 ORDER BY ordinal", [requestId])).rows.map(row => row.role_profile);
const refused = (code: ChildTargetError["code"]) => (error: unknown) => error instanceof ChildTargetError && error.code === code;

test("without a target, a child's row, key and queue are exactly what they were before targets", async () => {
  const parent = await parentTurn();
  const proposals = [proposal("remember a"), proposal("remember b")];
  const keys = await parent.delegate(proposals);
  for (const key of keys) assert.deepEqual(Object.keys(key).sort(), ["childId", "conversationId", "memberId", "ownerId", "requestId"]);
  assert.deepEqual(await roleProfiles(parent.request.requestId), proposals.map(p => p.profile));
  for (const key of keys) assert.deepEqual(await children.target(key), { engine: "pi", profile: names.crew });
  // A retried first segment reads the same keys back.
  assert.deepEqual(await store.beginTurn(parent.request, parent.execution), { kind: "delegated", children: keys });
});

test("a target naming a delegating Pi profile is stored on the child row and names the queue the child runs on", async () => {
  const parent = await parentTurn();
  const target = { engine: "pi", profile: names.analysts } as const;
  const [targeted, untargeted] = await parent.delegate([proposal("remember a", target), proposal("remember b")]);
  assert.deepEqual(targeted.target, target);
  assert.equal("target" in untargeted, false);
  assert.deepEqual((await roleProfiles(parent.request.requestId)).map(profile => profile.target), [target, undefined]);
  assert.deepEqual(await children.target(targeted), target);
  // The queue comes from the row, never from what a key claims.
  assert.deepEqual(await children.target({ ...untargeted, target }), { engine: "pi", profile: names.crew });
  assert.deepEqual(await store.beginTurn(parent.request, parent.execution), { kind: "delegated", children: [targeted, untargeted] });

  // A target this release cannot read, as a later release's might be, does not fail the parent's
  // turn: the key leaves it off, and the child's own activity refuses it.
  await pool.query(`UPDATE birbcrew_ts.pi_children SET role_profile=jsonb_set(role_profile,'{target,account}','"another"')
    WHERE child_id=$1`, [targeted.childId]);
  const { target: _unreadable, ...unread } = targeted;
  assert.deepEqual(await store.beginTurn(parent.request, parent.execution), { kind: "delegated", children: [unread, untargeted] });
  await assert.rejects(children.target(targeted), refused("invalid_target"));
});

test("a Claude or Codex target is refused with a typed error, and nothing is written", async () => {
  const parent = await parentTurn();
  for (const engine of ["claude", "codex"] as const) {
    // Even a registered profile of that engine: neither has a child driver yet.
    await assert.rejects(parent.delegate([proposal("remember", { engine, profile: names[engine] })]), refused("unsupported_engine"));
    await assert.rejects(parent.delegate([proposal("remember"), proposal("remember", { engine, profile: names.crew })]),
      refused("unsupported_engine"));
  }
  for (const target of [{ engine: "pi" }, { engine: "pi", profile: names.analysts, delegateTask: true },
    { engine: "pi", profile: names.analysts, target: { engine: "pi", profile: names.crew } }, { engine: "gemini", profile: names.analysts },
    { engine: "pi", profile: "" }, names.analysts, null]) {
    await assert.rejects(parent.delegate([proposal("remember", target)]), refused("invalid_target"), JSON.stringify(target));
  }
  assert.equal(await parent.delegations(), 0);
  assert.equal((await parent.delegate([proposal("remember")])).length, 1, "the turn can still delegate");
});

test("a Pi target must be a registered delegating profile, and it and the parent must hold every tool the child gets", async () => {
  const parent = await parentTurn();
  for (const one of [
    proposal("remember", { engine: "pi", profile: "unregistered-" + suffix }),
    proposal("remember", { engine: "pi", profile: names.chat }), // registered, but does not delegate
    proposal("remember", { engine: "pi", profile: names.claude }), // registered for Claude only
    proposal("record assigned x", { engine: "pi", profile: names.analysts }, "recorder"), // lacks record_work_item
  ]) {
    await assert.rejects(parent.delegate([proposal("remember"), one]), refused("ineligible_target"), one.profile.target?.profile);
  }
  assert.equal(await parent.delegations(), 0);
  // A parent without record_work_item cannot get a recorder by naming a target that has it.
  const analysts = await parentTurn(names.analysts);
  await assert.rejects(analysts.delegate([proposal("record assigned z", { engine: "pi", profile: names.crew }, "recorder")]),
    refused("ineligible_target"));
  assert.equal(await analysts.delegations(), 0);
  assert.equal((await analysts.delegate([proposal("remember", { engine: "pi", profile: names.crew })])).length, 1);
  const keys = await parent.delegate([proposal("remember", { engine: "pi", profile: names.analysts }),
    proposal("record assigned y", { engine: "pi", profile: names.crew }, "recorder")]);
  assert.deepEqual(keys.map(key => key.target?.profile), [names.analysts, names.crew]);
});

test("a child cannot delegate further, whatever its target", async t => {
  // The store takes a delegation only under the parent turn's token, never a child's launch generation.
  const parent = await parentTurn();
  const [key] = await parent.delegate([proposal("remember", { engine: "pi", profile: names.crew })]);
  const start = await children.begin(key, { workflowRunId: randomUUID(), activityId: "child", attempt: 1 });
  assert.equal(start.kind, "start");
  if (start.kind !== "start") throw new Error("unreachable");
  await assert.rejects(parent.delegate([proposal("remember")], start.generation),
    (error: unknown) => error instanceof MemberStoreError && error.code === "stale");

  // A child on a delegating Pi profile runs the child branch: delegate_task is never offered.
  const tools: string[][] = [];
  const pi = await createPiFixtureOptions(context => { tools.push(getCurrentTools(context.messages).map(tool => tool.name).sort()); });
  const drivers = memberProfiles(new Map<string, MemberProfile>([[names.crew, {
    accountId: "crew", pi, delegateTask: true, protectedTool: "record_work_item",
    claude: { model: "fixture", apiKey: "synthetic", baseUrl: "http://127.0.0.1:9" }, codex: { model: "fixture", baseUrl: "http://127.0.0.1:9" },
  }]]), stateDir).get(names.crew)!;
  const member: Conversation = { ownerId: "owner", memberId: randomUUID(), conversationId: randomUUID(), engine: "pi", profile: names.crew };
  const input = (childProfile: ChildProfile, text: string) => ({ threadId: randomUUID(), runId: randomUUID(), text, checkpoint: null,
    signal: t.signal, childProfile });
  for (const role of ["analyst", "recorder"] as const) {
    const childProfile: ChildProfile = { role, version: 1, instructions: roles[role], model: pi.model.id,
      tools: role === "recorder" ? ["record_work_item"] : [], target: { engine: "pi", profile: names.crew } };
    const result = await drivers.pi!(input(childProfile, "remember " + role), member);
    assert.deepEqual([result.kind, "text" in result && result.text], ["complete", "stored " + role]);
  }
  assert.deepEqual(tools, [[], ["record_work_item"]]);
  // A target must run the model its parent pinned on the child; only the launch can check that.
  await assert.rejects(drivers.pi!(input({ role: "analyst", version: 1, instructions: roles.analyst, model: "another-model", tools: [],
    target: { engine: "pi", profile: names.crew } }, "remember"), member), /Child profile differs from member/);
  assert.equal(tools.length, 2, "no model call");

  // The Claude and Codex drivers refuse a child outright instead of running it as a member turn.
  const childProfile: ChildProfile = { role: "analyst", version: 1, instructions: roles.analyst, model: "fixture", tools: [],
    target: { engine: "claude", profile: names.crew } };
  for (const engine of ["claude", "codex"] as const) {
    await assert.rejects(drivers[engine]!(input({ ...childProfile, target: { engine, profile: names.crew } }, "remember"), { ...member, engine }),
      refused("unsupported_engine"));
  }
});

test("nothing a runner returns can set a child target", () => {
  const child = proposal("remember");
  const reply = { kind: "delegated", checkpoint, proposals: [child] };
  assert.equal(runnerResultSchema.safeParse(reply).success, true);
  const targeted = { ...reply, proposals: [{ ...child, profile: { ...child.profile, target: { engine: "pi", profile: names.analysts } } }] };
  assert.equal(runnerResultSchema.safeParse(targeted).success, false);
});

test("a child's usage row records the engine that ran it, is priced by the model it reported, and stays the parent member's", async () => {
  const parent = await parentTurn();
  const [targeted, untargeted] = await parent.delegate([proposal("remember a", { engine: "pi", profile: names.analysts }), proposal("remember b")]);
  // The store refuses a Claude target until Claude has a child driver. Write one directly to show
  // the ledger reads the child's engine, not its parent member's.
  const other = await parentTurn();
  const [crossed] = await other.delegate([proposal("remember c")]);
  await pool.query(`UPDATE birbcrew_ts.pi_children SET role_profile=role_profile || jsonb_build_object('target',
    jsonb_build_object('engine','claude','profile',$2::text)) WHERE child_id=$1`, [crossed.childId, names.claude]);
  // The estimate is keyed on the model the segment reported, never on its engine or its member's:
  // a child whose provider answered with another model is priced as that model.
  const prices: PriceTable = new Map([["fixture", { input: "1", cachedInput: "1", cacheWrite: "1", output: "2" }],
    ["fixture-routed", { input: "10", cachedInput: "10", cacheWrite: "10", output: "20" }]]);
  async function spend(key: ChildKey | undefined, owner: typeof parent, model = "fixture") {
    const execution = { workflowRunId: randomUUID(), activityId: key ? "child" : "turn", attempt: 1 };
    let token = owner.token;
    if (key) {
      const start = await children.begin(key, execution);
      assert.equal(start.kind, "start");
      if (start.kind !== "start") throw new Error("unreachable");
      token = start.generation;
    }
    await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt,child_id)
      VALUES ($1,$2,$3,$4,$5,1,$6)`, [owner.request.conversationId, owner.request.requestId, token, execution.workflowRunId,
      execution.activityId, key?.childId ?? null]);
    await recordSegmentUsage(pool, { ...owner.request, token, execution, ...(key && { childId: key.childId }) }, {
      state: "reported", model, inputTokens: 3, outputTokens: 2, cachedInputTokens: null, cacheWriteTokens: null,
      reasoningTokens: null, costUsd: null }, prices);
  }
  await spend(undefined, parent);
  await spend(targeted, parent, "fixture-routed");
  await spend(untargeted, parent);
  await spend(crossed, other, "fixture-routed");
  const { rows } = await pool.query<{ child_id: string | null; member_id: string; engine: string; model: string; estimated: string }>(
    `SELECT child_id,member_id,engine,model,estimated_cost_usd::text AS estimated
    FROM birbcrew_ts.usage_ledger WHERE request_id=ANY($1::uuid[]) ORDER BY usage_id`, [[parent.request.requestId, other.request.requestId]]);
  // 3 input and 2 output tokens, at $1 and $2 or at $10 and $20 per million.
  assert.deepEqual(rows, [
    { child_id: null, member_id: parent.conversation.memberId, engine: "pi", model: "fixture", estimated: "0.000007000000" },
    { child_id: targeted.childId, member_id: parent.conversation.memberId, engine: "pi", model: "fixture-routed", estimated: "0.000070000000" },
    { child_id: untargeted.childId, member_id: parent.conversation.memberId, engine: "pi", model: "fixture", estimated: "0.000007000000" },
    { child_id: crossed.childId, member_id: other.conversation.memberId, engine: "claude", model: "fixture-routed", estimated: "0.000070000000" },
  ]);
});

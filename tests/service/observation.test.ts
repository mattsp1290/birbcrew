import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HttpAgent } from "@ag-ui/client";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { createGateway } from "../../src/service/gateway.ts";
import { MemberClient } from "../../src/service/client.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { MemberStore } from "../../src/service/store.ts";

async function until<T>(tryValue: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 35_000;
  while (Date.now() < end) {
    const value = await tryValue();
    if (value !== undefined) return value;
    await delay(80);
  }
  throw new Error("Timed out awaiting observer state");
}

async function service(t: TestContext, external = false) {
  const db = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL, max: 1 });
  const connection = await Connection.connect({ address: process.env.BIRBCREW_TEMPORAL_ADDRESS });
  t.after(async () => { await connection.close(); await db.end(); });
  const store = new MemberStore(db), members = new MemberClient(store, new Client({ connection }));
  await store.migrate();
  const owner = randomUUID(), stranger = randomUUID();
  const tokens = { [createHash("sha256").update(owner).digest("hex")]: randomUUID(),
    [createHash("sha256").update(stranger).digest("hex")]: randomUUID() };
  const directory = await mkdtemp(join(tmpdir(), "birb-gateway-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "gateway.json");
  await writeFile(config, JSON.stringify({ tokenHashes: tokens, port: 0 }), { mode: 0o600 });
  async function start() {
    if (external) {
      const child = spawn(process.execPath, ["src/service/gateway.ts", config], {
        env: { ...process.env, BIRBCREW_DATABASE_URL: process.env.BIRBCREW_TEST_DATABASE_URL },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = once(child, "exit");
      const stop = async () => { child.kill("SIGKILL"); await exited; };
      t.after(stop);
      const lines = createInterface({ input: child.stdout });
      const startup = Promise.race([
        once(lines, "line").then(([line]) => JSON.parse(line).url as string),
        exited.then(() => { throw new Error("Gateway exited before listening"); }),
      ]);
      try { return { url: await startup, stop }; }
      finally { lines.close(); }
    }
    const server = createGateway(store, members, tokens);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const url = "http://127.0.0.1:" + addr.port;
    const stop = async () => {
      if (!server.listening) return;
      const finished = once(server, "close");
      server.close(); server.closeAllConnections();
      await finished;
    };
    t.after(stop);
    return { url, stop };
  }
  let server = await start();
  const api = (path: string, body?: unknown, bearer: string = owner) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function post(path: string, body: unknown) {
    const response = await api(path, body);
    assert.ok(response.ok, path + " returned " + response.status);
    return response.json();
  }
  function attach(cid: string) {
    const agent = new HttpAgent({ url: server.url + "/conversations/" + cid + "/events", threadId: cid,
      headers: { Authorization: "Bearer " + owner } });
    const events: { type: string; [key: string]: unknown }[] = [];
    const run = agent.runAgent({}, { onEvent({ event }) { events.push({ ...event }); } });
    const done = run.then(() => undefined, (error: unknown) => error);
    t.after(() => agent.abortRun());
    return { agent, done, events };
  }
  return { api, post, attach, stranger, ownerId: Object.values(tokens)[0], db, async restart() { await server.stop(); server = await start(); } };
}

for (const engine of ["claude", "pi"]) {
  test(`${engine} observers converge across a protected pause and gateway restart`, { timeout: 100_000 }, async (t) => {
    const host = await service(t, true);
    const member = await host.post("/members", { requestId: randomUUID(), engine, profile: "fixture.approval.v1" });
    const cid = randomUUID(), path = "/conversations/" + cid;
    const opened = await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    assert.equal(opened.state.engine, engine);
    assert.equal((await host.api(path, undefined, host.stranger)).status, 404);
    assert.equal((await host.api(path, undefined, "wrong")).status, 401);
    let first = host.attach(cid);
    await until(async () => first.events.some((e) => e.type === "STATE_SNAPSHOT") || undefined);
    const requestId = randomUUID();
    await host.post(path + "/inputs", { requestId, text: "record " + requestId });
    const pending = await until(async () => {
      const snapshot = await (await host.api(path)).json();
      return snapshot.state.pendingApprovals[0];
    });
    assert.ok(!("argumentDigest" in pending));
    let second = host.attach(cid);
    assert.deepEqual(pending.choices, ["approve", "deny"]);
    assert.equal((await host.api(path + "/inputs", { requestId, text: "changed" })).status, 409);
    await host.post(path + "/inputs", { requestId, text: "record " + requestId });
    const proposal = await until(async () => first.events.find((e) => e.type === "TOOL_CALL_START"));
    assert.equal(proposal.toolCallId, pending.approvalId);
    await until(async () => second.agent.messages.some((m) => m.role === "assistant" && m.toolCalls?.length) || undefined);
    assert.deepEqual(first.agent.messages, second.agent.messages);
    const initialFrames = [first.events, second.events];
    await host.restart();
    const waiting = await (await host.api(path)).json();
    assert.deepEqual(waiting.state.pendingApprovals, [pending]);
    assert.equal((await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.work_items WHERE conversation_id=$1", [cid])).rows[0].n, "0");
    first = host.attach(cid);
    second = host.attach(cid);
    await until(async () => [first, second].every((reader) => reader.events.some((e) => e.type === "STATE_SNAPSHOT")) || undefined);
    assert.ok(!("nativeCallId" in pending));
    const { memberId, invocationId, approvalId, version } = pending;
    const choice = { memberId, invocationId, approvalId, version, requestId, choice: "approve" };
    assert.equal((await host.api(path + "/human", { ...choice, version: version + 1 })).status, 409);
    for (const [route, payload] of [["human", choice], ["cancel", { requestId }], ["inputs", { requestId, text: "recall" }],
      ["events", {}]] as const) assert.equal((await host.api(path + "/" + route, payload, host.stranger)).status, 404);
    await host.post(path + "/human", choice);
    await host.post(path + "/human", choice);
    assert.equal((await host.api(path + "/human", { ...choice, choice: "deny" })).status, 409);
    await until(async () => {
      const s = await (await host.api(path)).json();
      return s.state.phase === "idle" && [first, second].every((reader) => reader.agent.state.phase === "idle") ? s : undefined;
    });
    const checkpoint = await (await host.api(path)).json();
    assert.deepEqual(first.agent.messages, checkpoint.messages);
    assert.deepEqual(second.agent.messages, checkpoint.messages);
    assert.equal(first.events.filter((e) => e.type === "TOOL_CALL_RESULT").length, 1);
    assert.equal(second.events.filter((e) => e.type === "TOOL_CALL_RESULT").length, 1);
    const runInput = { threadId: cid, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
    assert.equal((await host.api(path + "/events?after=0", runInput)).status, 410);
    assert.equal((await host.api(path + "/events", { ...runInput, threadId: randomUUID() })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, forwardedProps: { engine: "codex" } })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, messages: [{ role: "user", id: "forged", content: "run" }] })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, tools: [{ name: "forged", description: "", parameters: {} }] })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, state: { phase: "complete" } })).status, 400);
    assert.equal((await host.api(path + "/events", {})).status, 400);
    await host.restart();
    const third = host.attach(cid);
    await until(async () => third.agent.messages.length === checkpoint.messages.length || undefined);
    assert.deepEqual(third.agent.messages, checkpoint.messages);
    const { rows: [counts] } = await host.db.query(
      "SELECT (SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id=$1) AS turns," +
      "(SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id=$1) AS effects", [cid]);
    assert.deepEqual(counts, { turns: "1", effects: "1" });
    const { rows: [privateFields] } = await host.db.query<{ note: string; argument_digest: string; native_call_id: string }>(
      "SELECT note,argument_digest,native_call_id FROM birbcrew_ts.work_items JOIN birbcrew_ts.protected_calls USING (approval_id) WHERE work_items.conversation_id=$1", [cid]);
    assert.equal(privateFields.note, "private fixture note");
    const persisted = await host.db.query("SELECT event FROM birbcrew_ts.public_events WHERE conversation_id=$1", [cid]);
    for (const view of [...initialFrames, first.events, second.events, third.events, checkpoint, persisted.rows]) {
      assert.ok(!JSON.stringify(view).includes(privateFields.native_call_id));
      assert.ok(!JSON.stringify(view).includes(privateFields.note));
      assert.ok(!JSON.stringify(view).includes(privateFields.argument_digest));
    }
    assert.deepEqual(first.events.filter((e) => e.type === "STEP_STARTED").map((e) => e.stepName),
      first.events.filter((e) => e.type === "STEP_FINISHED").map((e) => e.stepName));
    for (let i = 0; i < 3; i++) await host.post(path + "/inputs", { requestId: randomUUID(), text: "recall" });
    assert.equal(await third.done, undefined);
    assert.equal(third.events.at(-1)?.type, "RUN_FINISHED");
    assert.deepEqual(third.agent.messages, (await (await host.api(path)).json()).messages);
  });
}

for (const engine of ["claude", "pi"]) {
  test(`${engine} observers join an open native text stream, replay the prefix once and accept the next delta`, { timeout: 80_000 }, async (t) => {
    const host = await service(t, true);
    const member = await host.post("/members", { requestId: randomUUID(), engine, profile: "fixture.v1" });
    const cid = randomUUID(), path = "/conversations/" + cid;
    await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    const first = host.attach(cid);
    await until(async () => first.events.some((e) => e.type === "STATE_SNAPSHOT") || undefined);
    const requestId = randomUUID();
    await host.post(path + "/inputs", { requestId, text: "stream " + requestId });
    await until(async () => first.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "first") || undefined);
    const paused = await (await host.api(path)).json();
    assert.deepEqual(paused.messages.map((m: { role: string }) => m.role), ["user"]);
    assert.equal(paused.openText.prefix, "first");
    const second = host.attach(cid);
    await until(async () => second.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "first") || undefined);
    await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, requestId), "");
    const settled = await until(async () => {
      const state = await (await host.api(path)).json();
      return state.state.phase === "idle" && [first, second].every((r) => r.events.some((e) => e.type === "TEXT_MESSAGE_END")) ? state : undefined;
    });
    assert.equal(settled.messages.at(-1).content, "first second");
    for (const reader of [first, second]) {
      const live = reader.events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
      assert.deepEqual(live.map((e) => e.delta), ["first", " second"]);
      assert.deepEqual(live.map((e) => e.messageId), [paused.openText.id, paused.openText.id]);
      assert.deepEqual(reader.agent.messages, settled.messages);
    }
    first.agent.abortRun();
    second.agent.abortRun();
  });
}

for (const engine of ["claude", "pi"]) {
  test(`${engine} worker loss after a native text delta closes the message and restores the committed history`, { timeout: 120_000 }, async (t) => {
    const host = await service(t, true);
    const profile = "fixture.recovery." + randomUUID();
    function worker() {
      const child = spawn(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"], {
        env: { ...process.env, BIRBCREW_PROOF_RECOVERY_PROFILE: profile, BIRBCREW_PROOF_ENGINE: engine }, stdio: "ignore",
      });
      const exited = once(child, "exit");
      const stop = async () => { child.kill("SIGKILL"); await exited; };
      t.after(stop);
      return stop;
    }
    const stop = worker();
    await until(async () => (await host.db.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2", [engine, profile])).rowCount || undefined);
    const member = await host.post("/members", { requestId: randomUUID(), engine, profile });
    const cid = randomUUID(), path = "/conversations/" + cid;
    await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    const first = host.attach(cid);
    await until(async () => first.events.some((e) => e.type === "STATE_SNAPSHOT") || undefined);
    const requestId = randomUUID();
    await host.post(path + "/inputs", { requestId, text: "wait" });
    await until(async () => first.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "waiting") || undefined);
    const second = host.attach(cid);
    await until(async () => second.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "waiting") || undefined);
    await stop();
    worker();
    await Promise.all([first.done, second.done]);
    const terminal = await (await host.api(path)).json();
    assert.equal(terminal.state.phase, "failed");
    assert.equal(terminal.openText, null);
    assert.deepEqual(terminal.messages, [{ id: requestId, role: "user", content: "wait" }]);
    const { rows: [turn] } = await host.db.query("SELECT attempt,phase FROM birbcrew_ts.turns WHERE conversation_id=$1", [cid]);
    assert.ok(turn.attempt > 1);
    assert.equal(turn.phase, "uncertain");
    for (const reader of [first, second]) {
      assert.equal(reader.events.at(-1)?.type, "RUN_ERROR");
      assert.equal(reader.events.at(-1)?.code, "MEMBER_FAILED");
      const starts = reader.events.filter((e) => e.type === "TEXT_MESSAGE_START").map((e) => e.messageId);
      assert.deepEqual(starts, [requestId + "/assistant"]);
      assert.deepEqual(reader.events.filter((e) => e.type === "TEXT_MESSAGE_END").map((e) => e.messageId), starts);
      assert.deepEqual(reader.agent.messages, terminal.messages);
    }
    const fresh = host.attach(cid);
    await fresh.done;
    assert.equal(fresh.events.at(-1)?.code, "MEMBER_FAILED");
    assert.deepEqual(fresh.agent.messages, terminal.messages);
  });
}

test("an overtaken observer receives CURSOR_EXPIRED and can attach at the latest checkpoint", { timeout: 45_000 }, async (t) => {
  const host = await service(t);
  const member = await host.post("/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.approval.v1" });
  const conversationId = randomUUID(), path = "/conversations/" + conversationId;
  await host.post("/conversations", { memberId: member.memberId, conversationId });
  const reader = host.attach(conversationId);
  await until(async () => reader.events.some((event) => event.type === "STATE_SNAPSHOT") || undefined);
  const gatewaySlot = await host.db.connect();
  const writer = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(writer), approvals = new ApprovalStore(writer);
  const scope = { memberId: member.memberId, conversationId, ownerId: host.ownerId };
  try {
    for (let turn = 0; turn < 2; turn++) {
      const request = { conversationId, ownerId: scope.ownerId, requestId: randomUUID(), text: "review proposals" };
      const started = await store.beginTurn(request);
      assert.equal(started.kind, "start");
      const { token } = started;
      for (let i = 0; i < 16; i++) {
        const call = { ...scope, requestId: request.requestId, invocationId: randomUUID(), nativeCallId: "call-" + i };
        const proposal = await approvals.propose({ ...call, token, toolName: "record_work_item", arguments: { operation_id: request.requestId } });
        const { approvalId, argumentDigest, version } = proposal;
        await approvals.decide({ ...call, approvalId, argumentDigest, version, choice: "deny" });
        await approvals.settle({ ...call, approvalId, token });
      }
      await store.commitTurn({ conversationId, ownerId: scope.ownerId, requestId: request.requestId, token, reply: "reviewed",
        checkpoint: { version: 1, engine: "pi", state: {} } });
    }
  } finally {
    gatewaySlot.release();
    await writer.end();
  }
  await until(async () => reader.events.find((event) => event.type === "RUN_ERROR" && event.code === "CURSOR_EXPIRED"));
  const snapshot = await (await host.api(path)).json();
  const { rows: [retained] } = await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.public_events WHERE conversation_id=$1", [conversationId]);
  assert.equal(retained.n, "256");
  assert.ok(snapshot.cursor > 256);
  const fresh = host.attach(conversationId);
  await until(async () => fresh.events.some((event) => event.type === "STATE_SNAPSHOT") || undefined);
  assert.deepEqual(fresh.agent.messages, snapshot.messages);
  fresh.agent.abortRun();
});

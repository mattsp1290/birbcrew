import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { MemberClient } from "../../src/service/client.ts";
import type { Engine } from "../../src/service/domain.ts";
import { MemberStore } from "../../src/service/store.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";

async function until(check: () => Promise<boolean>, name: string) {
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(name);
}

async function optionalFile(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function prove(t: TestContext, engine: Engine, exhaust = false) {
  const dir = await mkdtemp(join(tmpdir(), "birb-launch-"));
  const requests = join(dir, "requests.jsonl");
  const native = join(dir, "native");
  const marker = join(dir, "paused");
  const config = join(dir, "profile.mjs");
  const profile = "fence-" + randomUUID();
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import {profiles as p,close} from ${JSON.stringify(fixture)};\nexport {close};\nexport const profiles = new Map([[${JSON.stringify(profile)},p.get("fixture.v1")]]);\n`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const connection = await Connection.connect({address: process.env.BIRBCREW_TEMPORAL_ADDRESS});
  t.after(async () => { await connection.close(); await pool.end(); });
  const store = new MemberStore(pool);
  const client = new MemberClient(store, new Client({ connection }));
  const env = { ...process.env, BIRBCREW_DATABASE_URL: process.env.BIRBCREW_TEST_DATABASE_URL,
    BIRBCREW_STATE_DIR: native, BIRBCREW_PROOF_REQUESTS: requests, BIRBCREW_PROOF_ENGINE: engine };
  function worker(pause: boolean) {
    const args = pause || exhaust ? ["--import", "./tests/service/supervisor-pause.ts"] : [];
    const child = spawn(process.execPath, [...args, "src/service/cli.ts", "worker", config], {
      env: { ...env, BIRBCREW_PROOF_PAUSE: pause ? marker : "", BIRBCREW_PROOF_DROP_RETRIES: !pause && exhaust ? "1" : "" }, stdio: "ignore",
    });
    const exited = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      await exited;
    });
    return child;
  }
  const old = worker(true);
  const ownerId = randomUUID(), conversationId = randomUUID();
  const member = await store.spawn({engine, ownerId, profile, requestId: randomUUID()});
  await client.open({ ownerId, conversationId, memberId: member.memberId });
  const turn = { ownerId, conversationId, requestId: randomUUID(), text: "remember obsolete" };
  const result = assert.rejects(client.submit(turn));
  await until(async () => (await optionalFile(marker)).includes("reserved"), "First worker reserved the turn");
  await until(async () => /State:\s+T/.test(await optionalFile(`/proc/${old.pid}/status`)), "First worker suspended");
  worker(false);
  await result;
  const { rows: [revoked] } = await pool.query(
    "SELECT phase, attempt, token, workflow_run_id, activity_id FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",
    [conversationId, turn.requestId]);
  assert.equal(revoked.phase, "uncertain");
  assert.equal(revoked.attempt, exhaust ? 1 : 2);
  old.kill("SIGCONT");
  await until(async () => (await optionalFile(marker)).includes("denied"), "Original supervisor refused the resumed worker request");
  const supervisor = await startSupervisor(config, native);
  try {
    const launch = { ...turn, token: revoked.token,
      execution: {workflowRunId: revoked.workflow_run_id, activityId: revoked.activity_id, attempt: 1} };
    for (let i = 0; i < 2; i++) {
      await assert.rejects(supervisor.start(launch, t.signal), /denied|uncertain/);
    }
  } finally { await supervisor.close(); }
  const admitted = await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE token=$1", [revoked.token]);
  assert.equal(admitted.rowCount, 0, "Neither supervisor forked a native runner");
  assert.equal(await optionalFile(requests), "", "No SDK provider received the stale prompt");
  if (engine === "claude") assert.deepEqual(await readdir(native), [".birbcrew-volume"]);
}

for (const engine of ["pi", "claude"] as const) {
  test(`${engine} refuses a paused worker's stale native launch after actual Temporal takeover`,
    { timeout: 100_000 }, (t) => prove(t, engine));
}

test("exhausted Temporal retries revoke the original claim before workflow closure",
  { timeout: 100_000 }, (t) => prove(t, "pi", true));

test("supervisors deduplicate concurrent launches and confirm remote stops", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-idempotent-launch-"));
  const profile = "launch-" + randomUUID();
  const config = join(dir, "config.mjs");
  const log = join(dir, "requests.jsonl");
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `process.env.BIRBCREW_PROOF_ENGINE = "pi";
    process.env.BIRBCREW_PROOF_REQUESTS = ${JSON.stringify(log)};
    const original = await import(${JSON.stringify(fixture)});
    export const profiles = new Map([[${JSON.stringify(profile)},original.profiles.get("fixture.v1")]]);
    export const close = original.close;`);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(pool);
  const a = await startSupervisor(config, dir), b = await startSupervisor(config, dir);
  t.after(async () => { await Promise.all([a.close(), b.close()]); await pool.end(); await rm(dir, { recursive: true, force: true }); });
  const ownerId = randomUUID(), conversationId = randomUUID();
  const member = await store.spawn({ engine: "pi", ownerId, profile, requestId: randomUUID() });
  await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
  const workflowRunId = randomUUID();
  async function reserve(text: string) {
    const input = { ownerId, conversationId, requestId: randomUUID(), text };
    const execution = { workflowRunId, activityId: input.requestId, attempt: 1 };
    const turn = await store.beginTurn(input, execution);
    assert.equal(turn.kind, "start");
    return { ...input, token: turn.token, execution };
  }
  const first = await reserve("remember once");
  const expected = { kind: "complete", text: "stored once" };
  assert.deepEqual(await Promise.all([a.start(first, t.signal), b.start(first, t.signal)]), [expected, expected]);
  assert.deepEqual(await a.start(first, t.signal), expected);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);

  const waiting = await reserve("wait");
  const rejected = assert.rejects(a.start(waiting, t.signal));
  await until(async () => (await readFile(log, "utf8")).includes('"wait"'), "Pi provider began streaming");
  await b.stop(waiting);
  await rejected;
  await b.stop(waiting);
  await assert.rejects(a.start(waiting, t.signal));
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
  const { rows: [status] } = await pool.query("SELECT stopped FROM birbcrew_ts.native_launches WHERE token=$1", [waiting.token]);
  assert.equal(status.stopped, true);
});

test("a replacement recovers Claude's stopped native deferral without a second generation", { timeout: 100_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-stopped-proposal-"));
  const requests = join(dir, "requests.jsonl"), marker = join(dir, "lost"), config = join(dir, "profile.mjs");
  const profile = "recover-" + randomUUID();
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import {profiles as p,close} from ${JSON.stringify(fixture)};
    export {close}; export const profiles = new Map([[${JSON.stringify(profile)}, p.get("fixture.approval.v1")]]);`);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const connection = await Connection.connect({address: process.env.BIRBCREW_TEMPORAL_ADDRESS});
  const store = new MemberStore(pool);
  const client = new MemberClient(store, new Client({ connection }));
  t.after(async () => { await connection.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });
  function worker(drop: boolean) {
    const child = spawn(process.execPath, ["src/service/cli.ts", "worker", config], {
      env: { ...process.env, BIRBCREW_DATABASE_URL: process.env.BIRBCREW_TEST_DATABASE_URL,
        BIRBCREW_STATE_DIR: join(dir, "native"), BIRBCREW_PROOF_REQUESTS: requests, BIRBCREW_PROOF_ENGINE: "claude",
        ...(drop && { NODE_OPTIONS: "--import " + new URL("./supervisor-drop-proposal.ts", import.meta.url).href,
          BIRBCREW_LOST_PROPOSAL: marker }) }, stdio: "ignore",
    });
    const ended = once(child, "close");
    t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); await ended; });
    return ended;
  }
  const old = worker(true);
  const key = { ownerId: randomUUID(), conversationId: randomUUID() };
  const member = await store.spawn({ ownerId: key.ownerId, engine: "claude", profile, requestId: randomUUID() });
  await client.open({ ...key, memberId: member.memberId });
  const requestId = randomUUID(), text = "record " + requestId;
  const submitted = client.submit({ ...key, requestId, text });
  submitted.catch(() => {});
  await until(async () => Boolean(await optionalFile(marker)), "First worker observed the native Claude deferral");
  assert.equal((await old)[1], "SIGKILL");
  assert.deepEqual(await client.pending(key), []);
  worker(false);
  await until(async () => (await client.pending(key)).length === 1, "Replacement published the stopped Claude proposal");
  assert.equal((await readFile(requests, "utf8")).trim().split("\n").length, 1);
  const [approval] = await client.pending(key);
  const { summary, toolName, policyVersion, ...decision } = approval;
  await client.decide({ ...decision, choice: "approve" });
  const reply = await submitted;
  const { rows } = await pool.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE approval_id=$1", [approval.approvalId]);
  assert.equal(rows.length, 1);
  assert.equal(reply, "recorded " + rows[0].receipt_id);
  const generations = await pool.query("SELECT stopped FROM birbcrew_ts.native_launches WHERE conversation_id=$1", [key.conversationId]);
  assert.equal(generations.rowCount, 2);
  assert.equal((await readFile(requests, "utf8")).trim().split("\n").length, 2);
});

test("concurrent and revoked receipt submissions reach each native engine at most once", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-receipt-launch-"));
  const config = join(dir, "profile.mjs"), log = join(dir, "requests.jsonl");
  const profile = "receipt-" + randomUUID();
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `process.env.BIRBCREW_PROOF_REQUESTS = ${JSON.stringify(log)};
    const original = await import(${JSON.stringify(fixture)});
    export const profiles = new Map([[${JSON.stringify(profile)},original.profiles.get("fixture.approval.v1")]]);
    export const close = original.close;`);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(pool), ledger = new ApprovalStore(pool);
  const a = await startSupervisor(config, dir), b = await startSupervisor(config, dir);
  t.after(async () => { await Promise.all([a.close(), b.close()]); await pool.end(); await rm(dir, { recursive: true, force: true }); });
  for (const engine of ["pi", "claude"] as const) {
    const ownerId = randomUUID();
    const member = await store.spawn({ engine, ownerId, profile, requestId: randomUUID() });
    for (const revoke of [true, false]) {
      const conversationId = randomUUID(), requestId = randomUUID();
      await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
      const request = { ownerId, conversationId, requestId, text: "record " + requestId };
      const execution = { workflowRunId: randomUUID(), activityId: "initial", attempt: 1 };
      const claim = await store.beginTurn(request, execution);
      assert.equal(claim.kind, "start");
      const initial = { ...request, token: claim.token, execution };
      const first = await a.start(initial, t.signal);
      assert.equal(first.kind, "pending");
      const { approval } = first;
      const { summary, toolName, policyVersion, ...decision } = approval;
      await ledger.decide({ ...decision, choice: "approve" });
      const receipt = await ledger.settleConfirmed(approval);
      assert.equal(receipt.kind, "recorded");
      const next = { ...execution, activityId: "resume" };
      const resume = await store.beginResume(request, approval, next);
      assert.equal(resume.kind, "start");
      assert.notEqual(resume.token, claim.token);
      const launch = { ...request, token: resume.token, execution: next };
      await a.stop(initial);
      await b.stop(initial);
      const callsBefore = (await readFile(log, "utf8")).trim().split("\n").length;
      if (revoke) {
        await b.stop(launch);
        await assert.rejects(a.start(launch, t.signal));
      } else {
        const [one, two] = await Promise.all([a.start(launch, t.signal), b.start(launch, t.signal)]);
        assert.deepEqual(one, two);
        assert.equal(one.kind, "complete");
        assert.ok(one.text.includes(receipt.receipt.receiptId));
      }
      assert.equal((await readFile(log, "utf8")).trim().split("\n").length - callsBefore, revoke ? 0 : 1);
      const delivered = await pool.query("SELECT receipt_digest FROM birbcrew_ts.native_launches WHERE approval_id=$1", [approval.approvalId]);
      assert.equal(delivered.rowCount, revoke ? 0 : 1);
      if (!revoke) assert.deepEqual(delivered.rows[0].receipt_digest, createHash("sha256").update(JSON.stringify(receipt)).digest());
      const saved = await pool.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE approval_id=$1", [approval.approvalId]);
      assert.deepEqual(saved.rows, [{ receipt_id: receipt.receipt.receiptId }]);
    }
  }
});

test("a frozen supervisor cannot deliver a revoked command from a runner that was still configuring its SDK", { timeout: 100_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "birb-runner-gate-"));
  const config = join(dir, "config.mjs"), gate = join(dir, "hold"), atGate = join(dir, "at-gate"), log = join(dir, "requests.jsonl");
  const profile = "before-driver-" + randomUUID();
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import { existsSync,writeFileSync } from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    process.env.BIRBCREW_PROOF_REQUESTS = ${JSON.stringify(log)};
    const original = await import(${JSON.stringify(fixture)});
    if (existsSync(${JSON.stringify(gate)})) {
      writeFileSync(${JSON.stringify(atGate)}, JSON.stringify([process.ppid,process.pid]));
      while (existsSync(${JSON.stringify(gate)})) await delay(10);
    }
    export const profiles = new Map([[${JSON.stringify(profile)}, original.profiles.get("fixture.approval.v1")]]);
    export const close = original.close;`);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(pool), ledger = new ApprovalStore(pool);
  const host = await startSupervisor(config, dir);
  t.after(async () => { await host.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });
  for (const engine of ["claude", "pi"] as const) {
    const ownerId = randomUUID();
    const { memberId } = await store.spawn({ engine, ownerId, profile, requestId: randomUUID() });
    for (const resume of [false, true]) {
      const conversationId = randomUUID(), requestId = randomUUID();
      await store.openConversation({ ownerId, conversationId, memberId });
      const request = { ownerId, conversationId, requestId, text: "record " + requestId };
      const execution = { workflowRunId: randomUUID(), activityId: "initial", attempt: 1 };
      const claim = await store.beginTurn(request, execution);
      assert.equal(claim.kind, "start");
      let launch = { ...request, token: claim.token, execution };
      if (resume) {
        const proposal = await host.start(launch, t.signal);
        assert.equal(proposal.kind, "pending");
        const { approval } = proposal;
        const { toolName, policyVersion, summary, ...decision } = approval;
        await ledger.decide({ ...decision, choice: "approve" });
        const receipt = await ledger.settleConfirmed(approval);
        assert.equal(receipt.kind, "recorded");
        const continuation = { ...execution, activityId: "continue" };
        const next = await store.beginResume(request, approval, continuation);
        assert.equal(next.kind, "start");
        launch = { ...request, token: next.token, execution: continuation };
      }
      const before = await optionalFile(log);
      await writeFile(gate, "hold");
      const rejected = assert.rejects(host.start(launch, t.signal));
      await until(async () => Boolean(await optionalFile(atGate)), "Runner is preparing the selected SDK");
      const [supervisorPid, runnerPid] = JSON.parse(await readFile(atGate, "utf8")) as [number, number];
      process.kill(supervisorPid, "SIGSTOP");
      try {
        await store.reconcileTurn(request, execution.workflowRunId, resume, false);
        await rm(gate);
        await until(async () => (await readFile("/proc/" + runnerPid + "/stat", "utf8").catch(() => "")).match(/^$|\) Z /) !== null,
          "Runner exited without entering the revoked SDK");
        assert.equal(await optionalFile(log), before);
      } finally {
        process.kill(supervisorPid, "SIGCONT");
        await rm(gate, { force: true });
      }
      await rejected;
      await rm(atGate);
      const { rows: [stopped] } = await pool.query("SELECT stopped FROM birbcrew_ts.native_launches WHERE token=$1", [launch.token]);
      assert.equal(stopped.stopped, true);
    }
  }
});

test("forced termination confirms a reaped invocation for both native engines", { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "birb-reap-"));
  const config = join(dir, "config.mjs"), marker = join(dir, "runner"), log = join(dir, "calls");
  const profile = "force-" + randomUUID();
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    process.env.BIRBCREW_PROOF_REQUESTS = ${JSON.stringify(log)};
    const original = await import(${JSON.stringify(fixture)}); export const close=original.close;
    export const profiles=new Map([[${JSON.stringify(profile)}, original.profiles.get("fixture.v1")]]);`);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL }), store = new MemberStore(pool);
  const host = await startSupervisor(config, dir), replacement = await startSupervisor(config, dir);
  t.after(async () => { await Promise.all([host.close(), replacement.close()]); await pool.end(); await rm(dir, { recursive: true, force: true }); });
  for (const engine of ["pi", "claude"] as const) {
    const ownerId = randomUUID(), conversationId = randomUUID();
    const { memberId } = await store.spawn({ ownerId, engine, profile, requestId: randomUUID() });
    await store.openConversation({ memberId, ownerId, conversationId });
    const execution = { workflowRunId: randomUUID(), activityId: "blocked", attempt: 1 };
    const request = { ownerId, conversationId, requestId: randomUUID(), text: "wait" };
    const claim = await store.beginTurn(request, execution);
    assert.equal(claim.kind, "start");
    const launch = { ...request, execution, token: claim.token };
    const ended = assert.rejects(host.start(launch, t.signal));
    await until(async () => (await optionalFile(log)).includes(JSON.stringify({ engine, prompt: "wait" })), engine + " provider started");
    const pid = Number(await readFile(marker, "utf8"));
    process.kill(-pid, "SIGSTOP");
    try {
      await replacement.stop(launch);
      await ended;
      await replacement.stop(launch);
      assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
      const { rows: [row] } = await pool.query("SELECT stopped FROM birbcrew_ts.native_launches WHERE token=$1", [claim.token]);
      assert.equal(row.stopped, true);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { }
    }
  }
});

test("a worker exits when its native supervisor dies", { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "birb-supervisor-loss-"));
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  const config = join(dir, "config.mjs");
  const profile = "lost-" + randomUUID();
  await writeFile(config, `import { profiles as p, close } from ${JSON.stringify(fixture)};
    export {close}; export const profiles = new Map([[${JSON.stringify(profile)}, p.get("fixture.v1")]]);`);
  const worker = spawn(process.execPath, ["src/service/cli.ts", "worker", config], {
    stdio: "ignore",
    env: { ...process.env, BIRBCREW_STATE_DIR: dir, BIRBCREW_PROOF_ENGINE: "pi", BIRBCREW_DATABASE_URL: process.env.BIRBCREW_TEST_DATABASE_URL }
  });
  const closed = once(worker, "close");
  t.after(async () => { if (worker.exitCode === null && !worker.signalCode) worker.kill("SIGKILL"); await closed; await rm(dir, { recursive: true, force: true }); });
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const connection = await Connection.connect({ address: process.env.BIRBCREW_TEMPORAL_ADDRESS });
  t.after(async () => { await connection.close(); await pool.end(); });
  const store = new MemberStore(pool);
  const client = new MemberClient(store, new Client({ connection }));
  const ownerId = randomUUID(), conversationId = randomUUID();
  const {memberId} = await store.spawn({ownerId, engine:"pi", profile, requestId:randomUUID()});
  await client.open({memberId, ownerId, conversationId});
  const text = await client.submit({ownerId, conversationId, requestId:randomUUID(), text:"remember ready"});
  assert.equal(text, "stored ready");
  let hostPid: number | undefined;
  await until(async () => {
    const children = await optionalFile(`/proc/${worker.pid}/task/${worker.pid}/children`);
    for (const id of children.trim().split(/\s+/)) {
      if (id && (await optionalFile(`/proc/${id}/cmdline`)).includes("/supervisor-host.ts")) hostPid = Number(id);
    }
    return hostPid !== undefined;
  }, "Worker opened a native supervisor");
  assert.ok(hostPid);
  process.kill(hostPid, "SIGKILL");
  assert.notEqual((await closed)[0], 0);
});

test("revoking an admitted turn leaves its conversation available while the SDK drains", async () => {
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(pool);
  const ownerId = randomUUID(), conversationId = randomUUID();
  const { memberId } = await store.spawn({ ownerId, engine: "pi", profile: "fixture.v1", requestId: randomUUID() });
  await store.openConversation({ ownerId, conversationId, memberId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "remember drain" };
  const execution = { workflowRunId: randomUUID(), activityId: "drain", attempt: 1 };
  const claim = await store.beginTurn(request, execution);
  assert.equal(claim.kind, "start");
  const gate = await pool.connect();
  let reconciled;
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT 1 FROM birbcrew_ts.turns WHERE token=$1 FOR SHARE", [claim.token]);
    reconciled = store.reconcileTurn(request, execution.workflowRunId, false, false);
    await until(async () => Boolean((await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
        AND $1=ANY(pg_blocking_pids(pid))`, [(await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid])).rowCount),
      "Revocation waits for the admitted turn");
    await pool.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE NOWAIT", [conversationId]);
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    try { await reconciled; } finally { await pool.end(); }
  }
});

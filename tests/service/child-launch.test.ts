import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ChildStore, type ChildKey } from "../../src/service/children.ts";
import { MemberStore } from "../../src/service/store.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";

test("two Pi supervisors enforce each child's launch generation before and during model execution", { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "birb-child-launch-"));
  const config = join(dir, "profiles.mjs");
  const log = join(dir, "requests.jsonl");
  const profile = "crew-" + randomUUID();
  const gate = join(dir, "block-import"), blocked = join(dir, "blocked"), release = join(dir, "release");
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import {existsSync,writeFileSync} from "node:fs";
    import {setTimeout as delay} from "node:timers/promises";
    if (existsSync(${JSON.stringify(gate)})) {
      writeFileSync(${JSON.stringify(blocked)},JSON.stringify({runner:process.pid,supervisor:process.ppid}));
      while (!existsSync(${JSON.stringify(release)})) await delay(20);
    }
    process.env.BIRBCREW_PROOF_ENGINE = "pi";
    process.env.BIRBCREW_PROOF_REQUESTS = ${JSON.stringify(log)};
    const source = await import(${JSON.stringify(fixture)});
    export const profiles = new Map([[${JSON.stringify(profile)},source.profiles.get("fixture.crew.v1")]]);
    export const close = source.close;`);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(pool);
  const children = new ChildStore(pool);
  const first = await startSupervisor(config, dir);
  const replacement = await startSupervisor(config, dir);
  t.after(async () => {
    await Promise.all([first.close(), replacement.close()]);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  const ownerId = randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  async function delegate(tasks: string[]) {
    const conversationId = randomUUID();
    await store.openConversation({ ownerId, conversationId, memberId: member.memberId });
    const request = { ownerId, conversationId, requestId: randomUUID(), text: "delegate " + JSON.stringify(tasks.map(task => ({ role: "analyst", task }))) };
    const execution = { workflowRunId: randomUUID(), activityId: "root", attempt: 1 };
    const claim = await store.beginTurn(request, execution);
    assert.equal(claim.kind, "start");
    const result = await first.start({ ...request, execution, token: claim.token }, t.signal);
    assert.equal(result.kind, "delegated");
    return result.children;
  }
  async function begin(key: ChildKey) {
    const execution = { workflowRunId: randomUUID(), activityId: "child", attempt: 1 };
    const claim = await children.begin(key, execution);
    assert.equal(claim.kind, "start");
    const { ownerId, conversationId, requestId, childId } = key;
    return { ownerId, conversationId, requestId, childId, execution, token: claim.generation, text: claim.task };
  }
  async function calls(prompt: string) {
    return (await readFile(log, "utf8")).trim().split("\n").filter(line => JSON.parse(line).prompt === prompt).length;
  }
  const [completed, unlaunched] = await delegate(["remember one", "remember stale"]);
  const ready = await begin(completed);
  await assert.rejects(first.start({ ...ready, childId: unlaunched.childId }, t.signal));
  assert.deepEqual(await Promise.all([first.start(ready, t.signal), replacement.start(ready, t.signal)]),
    [{ kind: "childDone" }, { kind: "childDone" }]);
  assert.equal(await calls("remember one"), 1);
  const stale = await begin(unlaunched);
  const retry = await children.begin(unlaunched, { ...stale.execution, attempt: 2 });
  assert.equal(retry.kind, "revoked");
  for (const host of [first, replacement]) await assert.rejects(host.start(stale, t.signal));
  await children.reconcile(unlaunched, stale.execution.workflowRunId, false);
  assert.equal(await calls("remember stale"), 0);
  const unreserved = await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE token=$1", [stale.token]);
  assert.equal(unreserved.rowCount, 0);

  const [active] = await delegate(["child wait"]);
  const running = await begin(active);
  const submitted = first.start(running, t.signal);
  const settled = Promise.allSettled([submitted]);
  for (let i = 0; i < 120 && !await calls("child wait"); i++) await delay(100);
  assert.equal(await calls("child wait"), 1);
  const gateDb = await pool.connect();
  let revoke;
  try {
    await gateDb.query("BEGIN");
    const { rows: [blocker] } = await gateDb.query("SELECT pg_backend_pid() AS pid FROM birbcrew_ts.pi_children WHERE child_id=$1 FOR SHARE",
      [active.childId]);
    revoke = replacement.stop(running);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const locked = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [blocker.pid]);
      waiting = Boolean(locked.rowCount);
      if (!waiting) await delay(30);
    }
    assert.ok(waiting, "Stop is waiting to revoke the child SDK grant");
    const sibling = await pool.connect();
    try {
      await sibling.query("BEGIN");
      await sibling.query("SET LOCAL lock_timeout='1s'");
      await sibling.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE", [active.conversationId]);
    } finally {
      await sibling.query("ROLLBACK");
      sibling.release();
    }
  } finally {
    await gateDb.query("ROLLBACK");
    gateDb.release();
    await revoke;
  }
  await settled;
  await children.reconcile(active, running.execution.workflowRunId, false);
  const { rows: [record] } = await pool.query(`SELECT n.stopped,j.phase FROM birbcrew_ts.native_launches n
    JOIN birbcrew_ts.pi_children j USING(conversation_id,request_id,child_id) WHERE n.token=$1`, [running.token]);
  assert.deepEqual(record, { stopped: true, phase: "failed" });
  assert.deepEqual(await replacement.start(running, t.signal), { kind: "childDone" });
  assert.equal(await calls("child wait"), 1);

  const [delayed] = await delegate(["remember late"]);
  const delayedGrant = await begin(delayed);
  await writeFile(gate, "block");
  const dispatch = first.start(delayedGrant, t.signal);
  const dispatchSettled = Promise.allSettled([dispatch]);
  let blockedProcess: { runner: number; supervisor: number } | undefined;
  for (let i = 0; i < 120 && !blockedProcess; i++) {
    const value = await readFile(blocked, "utf8").catch(() => "");
    if (value) blockedProcess = JSON.parse(value);
    else await delay(50);
  }
  assert.ok(blockedProcess, "Runner reached profile registration");
  const { runner, supervisor } = blockedProcess;
  process.kill(supervisor, "SIGSTOP");
  try {
    const revoke = replacement.stop(delayedGrant);
    revoke.catch(() => { });
    let stopPublished = false;
    for (let i = 0; i < 100 && !stopPublished; i++) {
      const rows = await pool.query("SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE token=$1", [delayedGrant.token]);
      stopPublished = !!rows.rowCount;
      if (!stopPublished) await delay(20);
    }
    assert.ok(stopPublished, "Replacement durably revoked the blocked runner");
    await writeFile(release, "continue");
    let exited = false;
    for (let i = 0; i < 100 && !exited; i++) {
      const status = await readFile(`/proc/${runner}/status`, "utf8").catch(() => "");
      exited = !status || /^State:\s+Z/m.test(status);
      if (!exited) await delay(25);
    }
    assert.ok(exited, "Runner checked its own grant without its supervisor");
    assert.equal(await calls("remember late"), 0);
    process.kill(supervisor, "SIGCONT");
    await revoke;
  } finally {
    process.kill(supervisor, "SIGCONT");
    await writeFile(release, "continue");
  }
  await dispatchSettled;
  const { rows: [late] } = await pool.query("SELECT stopped FROM birbcrew_ts.native_launches WHERE token=$1", [delayedGrant.token]);
  assert.equal(late.stopped, true);

});

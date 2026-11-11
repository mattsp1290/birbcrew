import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { commands, decision, pendingSchema } from "./member-commands.mts";
import { until, type Services } from "./member-services.mts";

export async function verifyChildren(s: Services, stop: () => Promise<void>) {
  const { create, command } = commands(s);
  const member = await create("pi", "fixture.crew.v1");
  async function begin(tasks: { role: "analyst" | "recorder"; task: string }[], requestId = randomUUID()) {
    const key = await member.open(), request = { ...key, requestId, text: "delegate " + JSON.stringify(tasks) };
    const result = command("turn", request);
    void result.catch(() => {});
    const scope = " WHERE request_id='" + requestId + "' AND conversation_id='" + key.conversationId + "'";
    const children = async () => z.array(z.object({
      child_id: z.uuid(), phase: z.string(), native_call_id: z.string(), workflow_run_id: z.uuid().nullable(), outcome: z.unknown(),
    })).parse(JSON.parse(await s.sql("SELECT coalesce(json_agg(row_to_json(c) ORDER BY ordinal),'[]') FROM " +
      "(SELECT ordinal,child_id,phase,native_call_id,workflow_run_id,outcome FROM birbcrew_ts.pi_children" + scope + ") c")));
    async function phases(expected: string[]) {
      await until(async () => (await children()).map((c) => c.phase).join(",") === expected.join(",") || undefined, "Pi child phases " + expected.join(","));
    }
    async function finish() {
      const reply = z.object({ text: z.string().startsWith("delegated ") }).parse(await result);
      const outcomes = z.array(z.looseObject({ nativeCallId: z.string(), kind: z.string(), text: z.string().optional() }))
        .parse(JSON.parse(reply.text.slice(10)));
      const rows = await children();
      assert.deepEqual(outcomes, rows.map((r) => r.outcome));
      assert.deepEqual(outcomes.map((o) => o.nativeCallId), rows.map((r) => r.native_call_id));
      assert.ok(rows.every((r) => r.workflow_run_id));
      assert.equal(new Set(rows.map((r) => r.workflow_run_id)).size, rows.length);
      assert.deepEqual(await command("turn", request), reply);
      assert.deepEqual(await children(), rows);
      assert.deepEqual(await command("pending", key), []);
      return outcomes;
    }
    return { key, requestId, scope, children, phases, finish,
      items: () => s.sql("SELECT count(*) FROM birbcrew_ts.work_items" + scope) };
  }
  const gate = randomInt(1, 2 ** 30), id = randomUUID();
  const lock = " FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=" + gate;
  await s.sql(`CREATE FUNCTION birbcrew_ts.proof_hold_intent() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NULL; END; $$;
    CREATE CONSTRAINT TRIGGER proof_hold_intent AFTER INSERT ON birbcrew_ts.delegations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.request_id='${id}') EXECUTE FUNCTION birbcrew_ts.proof_hold_intent()`);
  const holder = s.sql("BEGIN; SELECT pg_advisory_xact_lock(" + gate + "); SELECT pg_sleep(120); COMMIT");
  void holder.catch(() => {});
  let crew: Awaited<ReturnType<typeof begin>>;
  try {
    await until(async () => await s.sql("SELECT count(*)" + lock + " AND granted") === "1" || undefined, "intent barrier");
    crew = await begin([{ role: "recorder", task: "record assigned first" }, { role: "recorder", task: "record assigned second" }], id);
    await until(async () => await s.sql("SELECT count(*)" + lock + " AND NOT granted") === "1" || undefined, "intent commit");
    await stop();
  } finally {
    await s.sql("SELECT pg_terminate_backend(pid)" + lock + " AND granted");
    await holder.catch(() => {});
    await s.sql("DROP TRIGGER proof_hold_intent ON birbcrew_ts.delegations; DROP FUNCTION birbcrew_ts.proof_hold_intent()");
  }
  await crew.phases(["ready", "ready"]);
  const intents = await crew.children();
  assert.ok(intents.every((i) => i.workflow_run_id === null));
  stop = await s.worker();
  await crew.phases(["waiting", "waiting"]);
  const before = await crew.children();
  assert.deepEqual(before.map((i) => i.child_id), intents.map((i) => i.child_id));
  assert.equal(await crew.items(), "0");
  await stop(); stop = await s.worker();
  const proposals = pendingSchema.parse(await command("pending", crew.key));
  assert.equal(proposals.length, 2);
  const [first, second] = before.map((child) => decision(proposals.find((p) => p.invocationId === child.child_id)!, "approve"));
  for (const forged of [{ ownerId: "stranger" }, { requestId: randomUUID() }, { invocationId: first.invocationId },
    { nativeCallId: first.nativeCallId }, { argumentDigest: first.argumentDigest }, { version: 2 }]) {
    await command("decide", { ...second, ...forged }, true);
  }
  await command("decide", second);
  await crew.phases(["waiting", "complete"]);
  assert.equal(await crew.items(), "1");
  await stop(); stop = await s.worker();
  await command("decide", second);
  await command("decide", first);
  const outcomes = (await crew.finish()).map((o) => JSON.parse(o.text!.replace(/^settled /, "")));
  assert.deepEqual(outcomes.map((o) => [o.nativeCallId, o.kind]), [[first.nativeCallId, "budget_exhausted"], [second.nativeCallId, "recorded"]]);
  assert.equal(outcomes[1].receipt.operationId, crew.requestId);
  assert.equal(await s.sql("SELECT receipt_id FROM birbcrew_ts.work_items" + crew.scope), outcomes[1].receipt.receiptId);
  assert.equal(await s.sql("SELECT note FROM birbcrew_ts.work_items" + crew.scope), "second");

  const failure = await begin([{ role: "analyst", task: "fail" }, { role: "recorder", task: "record assigned denied" }]);
  await failure.phases(["failed", "waiting"]);
  const [p] = pendingSchema.parse(await command("pending", failure.key));
  await command("decide", decision(p, "deny"));
  const [failed, denied] = await failure.finish();
  assert.equal(failed.code, "child_failed");
  assert.deepEqual(JSON.parse(denied.text!.replace(/^settled /, "")), { kind: "denied", nativeCallId: p.nativeCallId });
  assert.equal(await failure.items(), "0");

  for (const committed of [false, true]) {
    const cancel = await begin([{ role: "analyst", task: "child wait" }, { role: "recorder", task: "record assigned cancelled" }]);
    await cancel.phases(["running", "waiting"]);
    const [waiting] = pendingSchema.parse(await command("pending", cancel.key));
    if (committed) {
      await command("decide", decision(waiting, "approve"));
      await cancel.phases(["running", "complete"]);
    }
    for (let n = 0; n < 2; n++) assert.deepEqual(await command("cancel-pending", { ...cancel.key, requestId: cancel.requestId }), { cancelled: true });
    const [analyst, recorder] = await cancel.finish();
    assert.equal(analyst.kind, "cancelled");
    assert.equal(recorder.kind, committed ? "completed" : "cancelled");
    assert.equal(await cancel.items(), committed ? "1" : "0");
    if (committed) {
      const receipt = await s.sql("SELECT receipt_id FROM birbcrew_ts.work_items" + cancel.scope);
      assert.equal(JSON.parse(recorder.text!.replace(/^settled /, "")).receipt.receiptId, receipt);
    } else await command("decide", decision(waiting, "approve"), true);
  }
  const illegal = await begin([{ role: "analyst", task: "next step" }, { role: "recorder", task: "next step" }]);
  assert.deepEqual((await illegal.finish()).map((o) => o.kind), ["failed", "failed"]);
  assert.equal(await illegal.items(), "0");
  assert.equal(await s.sql("SELECT count(*) FROM birbcrew_ts.deferred_calls" + illegal.scope), "0");
  console.log("Verified Pi intent recovery, sibling decision ordering and shared effect budget, child failures and cancellation.");
  return stop;
}

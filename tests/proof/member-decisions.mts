import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { commands, decision, pendingSchema } from "./member-commands.mts";
import { run, until, type Engine, type Services } from "./member-services.mts";

export async function verifyDecisions(s: Services, engines: Engine[], stop: () => Promise<void>) {
  const { create, command } = commands(s);
  const cases = [];
  for (const engine of engines.filter((e) => e !== "codex")) {
    for (const tool of ["record_work_item", "choose_next_step"] as const) {
      const ordinary = tool === "choose_next_step";
      const member = await create(engine, ordinary ? "fixture.next-step.v1" : "fixture.approval.v1");
      for (const choice of ordinary ? [engine === "pi" ? "inspect" : "test", "cancel"] : ["approve", "deny", "cancel"]) {
        const key = await member.open();
        const request = { ...key, requestId: randomUUID() };
        const result = command("turn", { ...request, text: ordinary ? "next step" : "record " + request.requestId });
        void result.catch(() => {});
        cases.push({ engine, tool, choice, key, request, result });
      }
    }
  }
  if (!cases.length) return stop;
  const ids = cases.map((c) => "'" + c.key.conversationId + "'").join(",");
  const scope = " WHERE conversation_id IN (" + ids + ")";
  await until(async () => Number(await s.sql("SELECT count(*) FROM birbcrew_ts.paused_segments" + scope)) === cases.length || undefined, "all native proposals");
  assert.equal(await s.sql("SELECT count(*) FROM birbcrew_ts.work_items" + scope), "0");
  await stop();
  stop = await s.worker();
  await Promise.all(cases.map(async ({ engine, tool, key, choice, result, request }) => {
    const [p] = pendingSchema.parse(await command("pending", key));
    assert.equal(p.toolName, tool);
    assert.equal(p.requestId, request.requestId);
    const cmd = decision(p, choice);
    if (tool === "choose_next_step") {
      assert.deepEqual(p.choices, ["inspect", "test"]);
      await command("decide", { ...cmd, choice: "approve" }, true);
    }
    await command("decide", { ...cmd, ownerId: "stranger" }, true);
    await command("decide", { ...cmd, version: 2 }, true);
    await command("decide", { ...cmd, argumentDigest: "0".repeat(64) }, true);
    if (choice === "cancel") {
      assert.deepEqual(await command("cancel-pending", request), { cancelled: true });
      assert.deepEqual(await command("cancel-pending", request), { cancelled: true });
    } else {
      assert.deepEqual(await command("decide", cmd), { decision: choice });
      assert.deepEqual(await command("decide", cmd), { decision: choice });
      const opposite = tool === "record_work_item" ? (choice === "approve" ? "deny" : "approve") : (choice === "inspect" ? "test" : "inspect");
      await command("decide", { ...cmd, choice: opposite }, true);
    }
    const { text } = z.object({ text: z.string() }).parse(await result);
    const receipt = await s.sql("SELECT receipt_id FROM birbcrew_ts.work_items WHERE approval_id='" + p.approvalId + "'");
    if (tool === "choose_next_step") {
      assert.equal(text, choice === "cancel" ? "cancelled" : "selected " + choice);
      assert.equal(receipt, "");
    } else {
      const kind = choice === "approve" ? "recorded" : choice === "deny" ? "denied" : "cancelled";
      if (engine === "pi") {
        const output = JSON.parse(text.replace(/^settled /, ""));
        assert.equal(output.kind, kind);
        assert.equal(output.nativeCallId, p.nativeCallId);
      } else assert.equal(text, kind === "recorded" ? "recorded " + receipt : kind);
      if (choice === "approve") assert.ok(receipt && text.includes(receipt));
      else assert.equal(receipt, "");
    }
    assert.deepEqual(await command("pending", key), []);
  }));
  assert.equal(Number(await s.sql("SELECT count(*) FROM birbcrew_ts.work_items" + scope)), cases.filter((c) => c.choice === "approve").length);
  const overrides = [
    { BIRBCREW_PROOF_ACCOUNT: "another-account" },
    { BIRBCREW_PROOF_RECOVERY_PROFILE: "fixture.next-step.v1" },
    ...(engines.includes("claude") ? [{ BIRBCREW_STATE_DIR: join(s.directory, "wrong-volume") }] : []),
  ];
  for (const override of overrides) {
    await assert.rejects(run(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"],
      { env: { ...s.env, ...override }, timeout: 15_000 }),
      (e) => !!e && typeof e === "object" && "stderr" in e && String(e.stderr).includes("another account or native state volume"));
  }
  console.log("Verified protected approval, denial, ordinary next-step answers and cancellation after worker replacement.");
  return stop;
}

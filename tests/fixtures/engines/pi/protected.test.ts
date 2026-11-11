import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { contentText, type Context } from "@earendil-works/pi-ai";
import { runPiSegment } from "../../../../src/service/pi.ts";
import type { ToolOutcome } from "../../../../src/service/approvals.ts";
import { createPiFixtureOptions } from "./index.mts";

for (const decision of ["recorded", "denied"] as const) {
  test(`Pi resumes its native tool call with the host's ${decision} result`, async (t) => {
    const contexts: Context[] = [];
    const profile = () => createPiFixtureOptions((ctx) => contexts.push(structuredClone(ctx)));
    const threadId = randomUUID();
    const runId = randomUUID();
    const input = { threadId, runId, text: `record ${runId} private`, signal: t.signal, checkpoint: null };
    const pending = await runPiSegment(input, await profile());
    assert.equal(pending.kind, "pending");
    assert.deepEqual(pending.proposal.arguments, { operation_id: runId, note: "private" });
    assert.equal(pending.proposal.name, "record_work_item");
    const { nativeCallId } = pending.proposal;
    const result: ToolOutcome = decision === "denied" ? { kind: decision, nativeCallId } :
      { kind: decision, nativeCallId, receipt: { operationId: runId, receiptId: randomUUID() } };
    const next = { ...input, checkpoint: JSON.parse(JSON.stringify(pending.checkpoint)), continuation: { nativeCallId, result } };
    assert.equal(contexts.length, 1);
    assert.ok(!JSON.stringify(pending.checkpoint).includes('"role":"toolResult"'));
    await assert.rejects(runPiSegment({ ...next, text: "changed" }, await profile()));
    await assert.rejects(runPiSegment({ ...next, continuation: { nativeCallId: "wrong", result } }, await profile()));
    await assert.rejects(runPiSegment({ ...next, continuation: { nativeCallId,
      result: { kind: "recorded", nativeCallId, receipt: { receiptId: "invented", operationId: randomUUID() } },
    } }, await profile()));
    assert.equal(contexts.length, 1);

    const resumed = await runPiSegment(next, await profile());
    assert.equal(resumed.kind, "complete");
    assert.deepEqual(JSON.parse(resumed.text.slice("settled ".length)), result);
    const native = contexts.at(-1)!.messages;
    assert.deepEqual(native.filter((m) => m.role === "user").map((m) => contentText(m.content)), [input.text]);
    const calls = native.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((p) => p.type === "toolCall"));
    assert.deepEqual(calls.map((call) => call.id), [nativeCallId]);
    const results = native.filter((m) => m.role === "toolResult");
    assert.deepEqual(results.map((r) => [r.toolCallId, r.isError, JSON.parse(contentText(r.content))]),
      [[nativeCallId, decision !== "recorded", result]]);
    assert.equal(contexts.length, 2);
    const after = await runPiSegment({ ...input, runId: randomUUID(), text: "recall", checkpoint: resumed.checkpoint }, await profile());
    assert.equal(after.kind, "complete");
    const history = contexts.at(-1)!.messages.filter((m) => m.role === "toolResult");
    assert.deepEqual(history, results);
  });
}

test("Pi rejects a protected native call for a different operation", async (t) => {
  const runId = randomUUID();
  await assert.rejects(runPiSegment({
    runId, threadId: randomUUID(), text: "record " + randomUUID(), signal: t.signal, checkpoint: null,
  }, await createPiFixtureOptions()));
});

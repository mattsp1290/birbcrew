import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { contentText, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { runPiDelegatingSegment, runPiSegment, runPiTurn } from "../../../../src/service/pi.ts";
import { createPiFixtureOptions } from "./index.mts";

const tasks = [{ role: "analyst", task: "recall" }, { role: "recorder", task: "record assigned cedar" }];

test("a restored parent receives both actual sibling results once, in assistant order", async (t) => {
  const requests: { context: Context; sessionId?: string }[] = [];
  const profile = async () => ({ ...await createPiFixtureOptions((context, options) => {
    requests.push({ context: structuredClone(context), sessionId: options?.sessionId });
  }), allowRecordWorkItem: true });
  const parent = { threadId: randomUUID(), runId: randomUUID(), text: "delegate " + JSON.stringify(tasks), checkpoint: null, signal: t.signal };
  const first = await runPiDelegatingSegment(parent, await profile());
  assert.equal(first.kind, "delegated");
  assert.deepEqual(first.proposals.map((p) => p.task), tasks.map((p) => p.task));
  assert.deepEqual(getCurrentTools(requests[0].context.messages).map((t) => t.name).sort(), ["delegate_task", "record_work_item"]);
  assert.ok(!JSON.stringify(first.checkpoint).includes('"role":"toolResult"'));
  const outcomes = [];
  for (const proposal of first.proposals) {
    const child = { threadId: randomUUID(), runId: randomUUID(), checkpoint: null, signal: t.signal, text: proposal.task };
    const childProfile = { ...await profile(), instructions: proposal.profile.instructions };
    const response = proposal.profile.role === "analyst"
      ? { kind: "complete", ...await runPiTurn(child, childProfile) } as const
      : await runPiSegment(child, childProfile);
    const context = requests.at(-1)!.context;
    assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), proposal.profile.tools);
    assert.ok(getCurrentSystemPrompt(context.messages).includes(proposal.profile.instructions));
    assert.deepEqual(context.messages.filter((m) => m.role === "user").map((m) => contentText(m.content)), [proposal.task]);
    let text;
    if (response.kind === "pending") {
      const nativeCallId = response.proposal.nativeCallId;
      const resumed = await runPiSegment({ ...child, checkpoint: response.checkpoint,
        continuation: { nativeCallId, result: { kind: "denied", nativeCallId } } }, childProfile);
      assert.equal(resumed.kind, "complete");
      assert.equal(JSON.parse(resumed.text.slice("settled ".length)).kind, "denied");
      text = resumed.text;
    } else text = response.text;
    outcomes.push({ kind: "completed" as const, nativeCallId: proposal.nativeCallId, text });
  }
  const continuation = { ...parent, checkpoint: structuredClone(first.checkpoint), childResults: [...outcomes].reverse() };
  const before = requests.length;
  await assert.rejects(runPiDelegatingSegment({ ...continuation, childResults: outcomes.slice(1) }, await profile()));
  assert.equal(requests.length, before);
  const resumed = await runPiDelegatingSegment(continuation, await profile());
  assert.equal(resumed.kind, "complete");
  assert.deepEqual(JSON.parse(resumed.text.slice("delegated ".length)), outcomes);
  assert.ok(requests.every((r) => r.sessionId));
  assert.equal(new Set(requests.map((r) => r.sessionId)).size, 3);
  assert.equal(requests[0].sessionId, requests.at(-1)!.sessionId);
  const results = requests.at(-1)!.context.messages.filter((m) => m.role === "toolResult");
  assert.deepEqual(results.map((r) => [r.toolCallId, JSON.parse(contentText(r.content))]),
    outcomes.map((o) => [o.nativeCallId, o]));
  await runPiDelegatingSegment({ ...parent, runId: randomUUID(), text: "recall", checkpoint: resumed.checkpoint }, await profile());
  assert.equal(requests.at(-1)!.context.messages.filter((m) => m.role === "toolResult").length, 2);
});

test("a tool-free child cannot delegate, and a parent without record permission cannot create a recorder", async (t) => {
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "delegate " + JSON.stringify(tasks), checkpoint: null, signal: t.signal };
  await assert.rejects(runPiTurn(input, await createPiFixtureOptions()));
  await assert.rejects(runPiDelegatingSegment(input, await createPiFixtureOptions()));
});

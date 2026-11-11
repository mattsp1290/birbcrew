import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { runPiTurn } from "../../../../src/service/pi.ts";
import { createPiFixtureOptions } from "./index.mts";

test("Pi restores native messages and session identity before sending the next prompt", async (t) => {
  const requests: { context: Context; sessionId?: string }[] = [];
  const observe = (context: Context, options?: { sessionId?: string }) =>
    requests.push({ context: structuredClone(context), sessionId: options?.sessionId });
  const first = { threadId: randomUUID(), runId: randomUUID(), text: "remember cedar", signal: t.signal };
  const initial = await runPiTurn({ ...first, checkpoint: null }, await createPiFixtureOptions(observe));
  const next = { ...first, runId: randomUUID(), text: "recall", checkpoint: JSON.parse(JSON.stringify(initial.checkpoint)) };
  const freshProfile = await createPiFixtureOptions(observe);
  const restored = await runPiTurn(next, freshProfile);

  assert.equal(initial.text, "stored cedar");
  assert.equal(restored.text, "recalled cedar");
  assert.equal(requests.length, 2);
  assert.ok(requests[0]?.sessionId);
  assert.equal(requests[0].sessionId, requests[1]?.sessionId);
  const nativeReply = requests[1]?.context.messages.find((message) => message.role === "assistant");
  assert.ok(nativeReply?.responseId);
  assert.deepEqual(nativeReply, next.checkpoint.state.turns[0].assistant);
  assert.equal(next.checkpoint.state.turns[0].runId, first.runId);

  await assert.rejects(runPiTurn({ ...next, threadId: randomUUID() }, freshProfile), /checkpoint/);
  const broken = structuredClone(next.checkpoint);
  delete broken.state.turns[0].assistant;
  await assert.rejects(runPiTurn({ ...next, checkpoint: broken }, freshProfile));
  assert.equal(requests.length, 2);
});

test("Pi stops an in-flight provider stream and fails without a checkpoint", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const profile = await createPiFixtureOptions(() => setImmediate(() => controller.abort()));
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "wait", signal: controller.signal, checkpoint: null };
  await assert.rejects(runPiTurn(input, profile), { name: "AbortError" });
});

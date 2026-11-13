import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import test from "node:test";
import { Pool } from "pg";
import { z } from "zod";
import { runClaudeSegment, runClaudeTurn } from "../../src/service/claude.ts";
import { runCodexTurn } from "../../src/service/codex.ts";
import { ownerInitiator, type Checkpoint, type Engine } from "../../src/service/domain.ts";
import { runPiSegment, runPiTurn } from "../../src/service/pi.ts";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";
import { MemberStore } from "../../src/service/store.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";
import { claudeUsage, codexRolloutModel, codexRolloutTotal, codexUsage, piUsage } from "../../src/service/usage-capture.ts";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";
import { startProvider } from "../fixtures/engines/codex/provider.mts";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";

// The drivers run against the local fixture providers, as the service proofs do. Each provider
// request n reports distinct counts, so one call's figure, a running total and a sum all differ.
const reported = { state: "reported", costUsd: null } as const;

test("Codex reports a native thread's running total; each turn records only its own share", { timeout: 60_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-usage-codex-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const provider = await startProvider(undefined, undefined, undefined, n => ({ input_tokens: 100 * n,
    input_tokens_details: { cached_tokens: 10 * n }, output_tokens: 7 * n, output_tokens_details: { reasoning_tokens: 2 * n },
    total_tokens: 107 * n }));
  t.after(provider.close);
  const profile = { ownerId: randomUUID(), memberId: randomUUID(), model: "gpt-5.4", baseUrl: provider.url, stateDir };
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "remember usage", signal: t.signal, checkpoint: null };
  const first = await runCodexTurn(input, profile);
  const second = await runCodexTurn({ ...input, runId: randomUUID(), text: "recall", checkpoint: first.checkpoint }, profile);
  const third = await runCodexTurn({ ...input, runId: randomUUID(), text: "recall", checkpoint: second.checkpoint }, profile);
  // The model is the one each turn's turn_context entry in the rollout names.
  const share = (n: number) => ({ ...reported, model: "gpt-5.4", inputTokens: 100 * n, outputTokens: 7 * n, cachedInputTokens: 10 * n,
    cacheWriteTokens: 0, reasoningTokens: 2 * n });
  assert.deepEqual([first.usage, second.usage, third.usage], [share(1), share(2), share(3)]);
  assert.equal(provider.requests.length, 3);

  // A provider that sends no usage leaves Codex at zero: unknown, not a count of zero.
  const silent = await startProvider();
  t.after(silent.close);
  const quiet = await runCodexTurn({ ...input, threadId: randomUUID() }, { ...profile, baseUrl: silent.url });
  assert.deepEqual(quiet.usage, { state: "unknown", model: "gpt-5.4" });
});

test("a Codex rollout names its last turn's model only when that turn's entries agree", () => {
  const line = (value: object) => JSON.stringify(value);
  const started = line({ type: "event_msg", payload: { type: "task_started" } });
  const context = (model: unknown) => line({ type: "turn_context", payload: { turn_id: randomUUID(), model } });
  const done = line({ type: "event_msg", payload: { type: "task_complete" } });
  const earlier = [line({ type: "session_meta" }), started, context("gpt-old"), done];
  assert.equal(codexRolloutModel([...earlier, started, context("gpt-5.4"), done]), "gpt-5.4", "the last turn, not an earlier one");
  assert.equal(codexRolloutModel([...earlier, started, context("gpt-5.4"), context("gpt-5.4"), done]), "gpt-5.4");
  assert.equal(codexRolloutModel([...earlier, started, context("gpt-5.4"), context("gpt-5.5"), done]), null, "two models in one turn");
  assert.equal(codexRolloutModel([...earlier, started, done]), null, "a turn with no turn_context");
  assert.equal(codexRolloutModel([...earlier, started, context(7), done]), null);
  assert.equal(codexRolloutModel([...earlier, started, context("x".repeat(257)), done]), null, "longer than the ledger keeps");
  assert.equal(codexRolloutModel([context("gpt-5.4"), done]), null, "no task_started");
  assert.equal(codexRolloutModel([...earlier, started, "{not json", done]), null);
  assert.deepEqual(codexUsage({ input_tokens: 9, output_tokens: 1 }, null, "gpt-5.4"), { ...reported, model: "gpt-5.4", inputTokens: 9,
    outputTokens: 1, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null });
  assert.deepEqual(codexUsage({ input_tokens: 0, output_tokens: 0 }, null, "gpt-5.4"), { state: "unknown", model: "gpt-5.4" });
});

test("a Codex rollout that cannot be read, or a total that went backwards, is unknown", () => {
  const count = (total: object) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } });
  const lines = [JSON.stringify({ type: "session_meta" }), count({ input_tokens: 50, output_tokens: 5 }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }), count({ input_tokens: 80, output_tokens: 9 })];
  assert.deepEqual(codexRolloutTotal(lines), { input_tokens: 80, output_tokens: 9 });
  assert.equal(codexRolloutTotal([lines[0]]), null);
  assert.equal(codexRolloutTotal([...lines, "{not json"]), undefined);
  assert.equal(codexRolloutTotal([count({ input_tokens: "80" })]), undefined);
  const now = { input_tokens: 130, output_tokens: 20, cached_input_tokens: 4 };
  assert.deepEqual(codexUsage(now, { input_tokens: 80, output_tokens: 9 }), { ...reported, model: null, inputTokens: 50,
    outputTokens: 11, cachedInputTokens: 4, cacheWriteTokens: null, reasoningTokens: null });
  assert.equal(codexUsage(now, undefined).state, "unknown");
  // A part of the input that cannot be read is left out; the input and output counts stay.
  assert.deepEqual(codexUsage(now, { input_tokens: 80, output_tokens: 9, cached_input_tokens: 6 }), { ...reported, model: null,
    inputTokens: 50, outputTokens: 11, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null });
  assert.equal(codexUsage(now, { input_tokens: 200, output_tokens: 9 }).state, "unknown");
  assert.equal(codexUsage({ input_tokens: 1.5, output_tokens: 2 }, null).state, "unknown");
});

test("Claude records each query's own usage, for a chat turn, a proposal and its resumed answer", { timeout: 120_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-usage-claude-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const provider = await startClaudeFixtureProvider();
  t.after(provider.close);
  const profile = { ownerId: "owner", memberId: randomUUID(), stateDir, model: "claude-sonnet-4-6", apiKey: "synthetic", baseUrl: provider.url };
  // The fixture's every Messages response reports 10 input and 10 output tokens.
  const call = { ...reported, model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 10, cachedInputTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: null };
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "remember claude", signal: t.signal, checkpoint: null };
  const first = await runClaudeTurn(input, profile);
  const second = await runClaudeTurn({ ...input, runId: randomUUID(), text: "recall", checkpoint: first.checkpoint }, profile);
  assert.deepEqual([first.usage, second.usage], [call, call], "a resumed session does not carry the earlier query's usage");

  const operation = randomUUID();
  const record = { threadId: randomUUID(), runId: operation, text: "record " + operation, signal: t.signal, checkpoint: null };
  const proposed = await runClaudeSegment(record, profile);
  assert.equal(proposed.kind, "pending"); if (proposed.kind !== "pending") return;
  assert.deepEqual(proposed.usage, call);
  const nativeCallId = proposed.proposal.nativeCallId;
  const resumed = await runClaudeSegment({ ...record, checkpoint: proposed.checkpoint, continuation: { nativeCallId,
    result: { kind: "recorded", nativeCallId, receipt: { receiptId: randomUUID(), operationId: operation } } } }, profile);
  assert.equal(resumed.kind, "complete");
  assert.deepEqual(resumed.usage, call);
});

test("Claude's mapping counts cache reads and writes as input and never keeps the SDK's estimated cost", () => {
  assert.deepEqual(claudeUsage({ totalCostUsd: 0.5, usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100 } }, "claude-opus-4-7"), { ...reported, model: "claude-opus-4-7", inputTokens: 1003,
    outputTokens: 40, cachedInputTokens: 900, cacheWriteTokens: 100, reasoningTokens: null });
  assert.deepEqual(claudeUsage({ usage: {} }, "m"), { state: "unknown", model: "m" });
  assert.deepEqual(claudeUsage(undefined, 7), { state: "unknown", model: null });
});

/** A Chat Completions endpoint that reports usage the way OpenAI does: prompt_tokens includes the
 * cached tokens and completion_tokens the reasoning tokens. */
async function chatCompletions(model: string) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    const body = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })) }).parse(await json(req));
    const n = ++requests;
    const content = body.messages.findLast(m => m.role === "user")?.content;
    const prompt = typeof content === "string" ? content
      : z.array(z.looseObject({ text: z.string().optional() })).parse(content ?? []).map(part => part.text ?? "").join("");
    const call = prompt.includes("record") && body.messages.at(-1)?.role !== "tool";
    const frame = (value: object) => res.write("data: " + JSON.stringify({ id: "chatcmpl_usage", object: "chat.completion.chunk",
      created: 1, model, ...value }) + "\n\n");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    frame({ choices: [{ index: 0, delta: { role: "assistant", ...(call ? { tool_calls: [{ index: 0, id: "call_" + n, type: "function",
      function: { name: "record_work_item", arguments: JSON.stringify({ operation_id: prompt.slice(7), note: "usage" }) } }] }
      : { content: prompt.includes("record") ? "recorded" : "noted" }) }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] });
    frame({ choices: [], usage: { prompt_tokens: 100 * n, prompt_tokens_details: { cached_tokens: 30 * n },
      completion_tokens: 9 * n, completion_tokens_details: { reasoning_tokens: n }, total_tokens: 109 * n } });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}/chat/completions`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("Pi records each model call's usage from its assistant message, through a real provider adapter", { timeout: 60_000 }, async t => {
  const model = "fixture-chat";
  const endpoint = await chatCompletions(model);
  t.after(endpoint.close);
  const { profile, close } = await createProxyProfile({ engine: "pi", model, protocol: "openai-chat-completions",
    endpoint: endpoint.endpoint, accountId: "fixture-account", allowHttpLoopback: true, protectedTool: "record_work_item",
    resolveCredential: async () => ({ headers: { Authorization: "Bearer synthetic" }, expiresAt: Date.now() + 60_000 }) });
  t.after(close);
  const call = (n: number) => ({ ...reported, model, inputTokens: 100 * n, outputTokens: 9 * n, cachedInputTokens: 30 * n,
    cacheWriteTokens: 0, reasoningTokens: n });
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "hello", signal: t.signal, checkpoint: null as Checkpoint | null };
  const turn = await runPiTurn(input, profile.pi!);
  assert.deepEqual(turn.usage, call(1));

  const operation = randomUUID();
  const record = { ...input, threadId: randomUUID(), runId: operation, text: "record " + operation };
  const proposed = await runPiSegment(record, profile.pi!);
  assert.equal(proposed.kind, "pending"); if (proposed.kind !== "pending") return;
  assert.deepEqual(proposed.usage, call(2));
  const nativeCallId = proposed.proposal.nativeCallId;
  const resumed = await runPiSegment({ ...record, checkpoint: proposed.checkpoint as Checkpoint, continuation: { nativeCallId,
    result: { kind: "recorded", nativeCallId, receipt: { receiptId: randomUUID(), operationId: operation } } } }, profile.pi!);
  assert.equal(resumed.kind, "complete");
  assert.deepEqual(resumed.usage, call(3), "the resumed segment is its own model call, not the turn so far");

  // The scripted Pi fixture's faux messages carry all-zero usage: no provider reported anything.
  const faux = await runPiTurn({ ...input, threadId: randomUUID(), text: "remember zero" }, await createPiFixtureOptions());
  assert.deepEqual(faux.usage, { state: "unknown", model: "faux-1" });
});

test("the supervisor records one ledger row per launch for each engine, and a repeated start adds none", { timeout: 180_000 }, async t => {
  const url = process.env.BIRBCREW_TEST_DATABASE_URL;
  if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
  const dir = await mkdtemp(join(tmpdir(), "birb-usage-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "profile.mjs"), profile = "usage-" + randomUUID();
  const fixture = new URL("../proof/fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import {profiles as p,close} from ${JSON.stringify(fixture)};\nexport {close};\n` +
    `export const profiles = new Map([[${JSON.stringify(profile)},p.get("fixture.v1")]]);\n`);
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  const store = new MemberStore(pool);
  await store.migrate();
  // The supervisor host and its runners read the database and the trace file from the environment they inherit.
  process.env.BIRBCREW_DATABASE_URL = url;
  const traces = join(dir, "trace.jsonl");
  process.env.BIRBCREW_TRACE_FILE = traces;
  t.after(() => { delete process.env.BIRBCREW_TRACE_FILE; });
  const supervisor = await startSupervisor(config, join(dir, "native"));
  t.after(() => supervisor.close());
  const rows = new Map<Engine, unknown[]>();
  for (const engine of ["pi", "claude", "codex"] as const) {
    const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
    const member = await store.spawn({ ownerId, requestId: randomUUID(), engine, profile });
    await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
    const request = { ownerId, conversationId, requestId: randomUUID(), text: "remember " + engine };
    await store.recordAcceptance(request, ownerInitiator);
    const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
    const turn = await store.beginTurn(request, execution);
    assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
    const launch = { ...request, token: turn.token, execution };
    assert.deepEqual(await supervisor.start(launch, t.signal), { kind: "complete", text: "stored " + engine });
    assert.deepEqual(await supervisor.start(launch, t.signal), { kind: "complete", text: "stored " + engine });
    rows.set(engine, (await pool.query(`SELECT token, engine, state, model, input_tokens AS input, output_tokens AS output
      FROM birbcrew_ts.usage_ledger WHERE conversation_id=$1`, [conversationId])).rows.map(row => ({ ...row, token: row.token === turn.token })));
  }
  // The fixtures: Claude's Messages provider reports 10 and 10 tokens; Pi's faux messages and the
  // Codex Responses fixture report zero, which the capture treats as nothing reported.
  assert.deepEqual(Object.fromEntries(rows), {
    pi: [{ token: true, engine: "pi", state: "unknown", model: "faux-1", input: null, output: null }],
    claude: [{ token: true, engine: "claude", state: "reported", model: "claude-sonnet-4-6", input: 10, output: 10 }],
    codex: [{ token: true, engine: "codex", state: "unknown", model: "gpt-5.4", input: null, output: null }],
  });
  // Each model.invoke span carries the segment's usage state and, when reported, its two counts.
  const spans = (await readFile(traces, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .filter(span => span.name === "model.invoke");
  assert.deepEqual(spans.map(({ attributes: a }) => [a.engine, a["usage.state"], a["usage.input_tokens"], a["usage.output_tokens"]]),
    [["pi", "unknown", undefined, undefined], ["claude", "reported", 10, 10], ["codex", "unknown", undefined, undefined]]);
});

test("Pi keeps a cost only when every call's total is the provider's billed cost", () => {
  const message = (cost: object, extra: object = {}) => ({ role: "assistant", model: "m", usage: { input: 70, output: 9,
    cacheRead: 30, cacheWrite: 0, totalTokens: 109, cost, ...extra } });
  const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25, totalFromProvider: true };
  const estimate = { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 };
  assert.deepEqual(piUsage([message(billed), message(billed)]), { ...reported, model: "m", inputTokens: 200, outputTokens: 18,
    cachedInputTokens: 60, cacheWriteTokens: 0, reasoningTokens: null, costUsd: 0.5 });
  const mixed = piUsage([message(billed), message(estimate)]), thinking = piUsage([message(estimate, { reasoning: 3 })]);
  assert.equal(mixed.state === "reported" ? mixed.costUsd : "unknown", null);
  assert.equal(thinking.state === "reported" ? thinking.reasoningTokens : "unknown", 3);
  assert.deepEqual(piUsage([]), { state: "unknown", model: null });
  assert.deepEqual(piUsage([{ role: "assistant", model: "m", usage: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }]),
    { state: "unknown", model: "m" });
});

test("Pi names the model that answered, and no model when a segment's calls name different ones", () => {
  const message = (extra: object = {}) => ({ role: "assistant", model: "requested", usage: { input: 70, output: 9, cacheRead: 30,
    cacheWrite: 0, totalTokens: 109, cost: { total: 0.1 } }, ...extra });
  const model = (messages: object[]) => piUsage(messages).model;
  assert.equal(model([message(), message()]), "requested");
  // pi-ai sets responseModel when the provider names another model, as a router or a fallback does.
  assert.equal(model([message({ responseModel: "routed" }), message({ responseModel: "routed" })]), "routed");
  assert.equal(model([message(), message({ responseModel: "fallback" })]), null);
  assert.equal(model([message({ responseModel: 5 })]), "requested", "a malformed responseModel is not a model name");
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  contentText, getCurrentTools, createAssistantMessageEventStream, createProvider, fauxAssistantMessage, fauxProvider,
  fauxToolCall, InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import standaloneEntry, { createDelegationBatch, delegationToolResults } from "@birbcrew/pi-subagents";

const model = fauxProvider({ api: "birbcrew-extension-test" }).getModel();
const name = "delegate_task";
const policy = { model: model.id, allowRecordWorkItem: true };
const analyst = { role: "analyst", task: "Count the labels" };
const recorder = { role: "recorder", task: "Record the label count" };
const call = (id, args) => fauxToolCall(name, args, { id });

async function segment(t, { respond, prompt, extension, tools = [], history = [], customTools = [], instructions }) {
  const cwd = await mkdtemp(join(tmpdir(), "birbcrew-pi-session-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const requests = [];
  const stream = (_model, context, options) => {
    requests.push({ context: structuredClone(context), sessionId: options?.sessionId });
    const response = respond(context);
    const events = createAssistantMessageEventStream();
    events.push({ type: "start", partial: fauxAssistantMessage("") });
    events.push({ type: "done", reason: response.stopReason, message: response });
    return events;
  };
  runtime.registerNativeProvider(createProvider({
    id: model.provider, models: [model],
    auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noContextFiles: true, noThemes: true, systemPrompt: instructions ?? "Parent instructions",
    appendSystemPrompt: [], extensionFactories: extension ? [extension] : [],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(cwd);
  for (const message of history) sessionManager.appendMessage(message);
  const { session } = await createAgentSession({
    model, modelRuntime: runtime, resourceLoader, settingsManager, sessionManager, cwd, agentDir: cwd,
    tools, customTools, thinkingLevel: "off",
  });
  try {
    session.agent.finishTurn = () => ({ action: "end" });
    if (prompt) await session.prompt(prompt, { expandPromptTemplates: false });
    else await session.agent.continue();
    await session.waitForIdle();
    assert.equal(requests.length, 1, "each model segment ends after a single request");
    const messages = sessionManager.getEntries().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    return { request: requests[0], messages };
  } finally {
    session.dispose();
  }
}

function toolTurn(t, batch, calls) {
  return segment(t, { prompt: "Parent's private context", extension: batch.extension, tools: [name],
    respond: () => fauxAssistantMessage(calls, { stopReason: "toolUse" }) });
}
function confirm(batch, { messages }) {
  const assistant = messages.find((m) => m.role === "assistant");
  return batch.confirm(assistant.content.filter((part) => part.type === "toolCall"), messages.filter((m) => m.role === "toolResult"));
}
const advertised = (request) => getCurrentTools(request.context.messages).map((tool) => tool.name);

test("the manifest names the installed public entry", async () => {
  const entry = new URL(import.meta.resolve("@birbcrew/pi-subagents"));
  const pkg = new URL("../package.json", entry);
  const metadata = JSON.parse(await readFile(pkg, "utf8"));
  assert.ok(fileURLToPath(entry).startsWith(join(process.cwd(), "node_modules") + "/"));
  assert.equal(new URL(metadata.pi.extensions[0], pkg).href, entry.href);
  assert.match(await readFile(new URL("LICENSE", pkg), "utf8"), /MIT License/);
});

test("isolated child coding sessions settle their parent's native calls once in proposal order", async (t) => {
  const batch = createDelegationBatch(policy);
  const parent = await toolTurn(t, batch, [call("first", analyst), call("second", recorder)]);
  assert.deepEqual(advertised(parent.request), [name]);
  const proposals = confirm(batch, parent);
  assert.deepEqual(proposals.map((p) => [p.nativeCallId, p.task, p.profile.role, p.profile.tools, p.profile.version, p.profile.model]),
    [["first", analyst.task, "analyst", [], 1, model.id], ["second", recorder.task, "recorder", ["record_work_item"], 1, model.id]]);
  const children = await Promise.all(proposals.map((p) => segment(t, {
    prompt: p.task, instructions: p.profile.instructions, tools: p.profile.tools,
    customTools: p.profile.tools.map((tool) => ({
      name: tool, label: "Request record", description: "Request approval", parameters: { type: "object", properties: {} },
      async execute() { throw new Error("Unexpected execution"); },
    })),
    respond: () => fauxAssistantMessage("Outcome of " + p.task),
  })));
  const sessionIds = [parent, ...children].map(({ request }) => request.sessionId);
  assert.ok(sessionIds.every(Boolean));
  assert.equal(new Set(sessionIds).size, 3);
  const outcomes = children.map(({ request, messages }, i) => {
    const p = proposals[i];
    assert.deepEqual(advertised(request), p.profile.tools);
    assert.deepEqual(request.context.messages.filter((m) => m.role === "user").map((m) => contentText(m.content)), [p.task]);
    assert.ok(!JSON.stringify(request.context).includes("Parent's private context"));
    return { kind: "completed", nativeCallId: p.nativeCallId, text: contentText(messages.at(-1).content) };
  });
  const ordered = delegationToolResults(proposals, [...outcomes].reverse(), 123);
  const resumed = await segment(t, { history: [...parent.messages.filter((m) => m.role !== "toolResult"), ...ordered],
    respond: () => fauxAssistantMessage("Finished") });
  const results = resumed.request.context.messages.filter((m) => m.role === "toolResult");
  assert.deepEqual(results.map((r) => [r.toolCallId, JSON.parse(contentText(r.content)), r.isError]),
    outcomes.map((o) => [o.nativeCallId, o, false]));
  assert.equal(contentText(resumed.messages.at(-1).content), "Finished");
});

test("removing the factory removes the tool, and the manifest entry alone cannot accept a call", async (t) => {
  const absent = await segment(t, { prompt: "hello", respond: () => fauxAssistantMessage("Hello") });
  assert.deepEqual(advertised(absent.request), []);
  const isolated = await toolTurn(t, { extension: standaloneEntry }, [call("outside-host", analyst)]);
  assert.equal(isolated.messages.at(-1).isError, true);
});

test("unsafe proposals fail as a batch in the coding SDK", async (t) => {
  for (const [reason, args, enableRecorder] of [
    ["unknown role", [{ role: "operator", task: "Inspect" }], true],
    ["profile override", [{ ...analyst, model: "requested-model" }], true],
    ["path override", [{ ...analyst, cwd: "/private" }], true],
    ["permission override", [{ ...analyst, tools: ["bash"] }], true],
    ["UTF-8 size", [{ ...analyst, task: "🦜".repeat(1025) }], true],
    ["forbidden recorder", [recorder], false],
    ["third sibling", [analyst, recorder, analyst], true],
  ]) {
    const batch = createDelegationBatch({ ...policy, allowRecordWorkItem: enableRecorder });
    const response = await toolTurn(t, batch, args.map((arg, i) => call("c" + i, arg)));
    assert.throws(() => confirm(batch, response), undefined, reason);
  }
  const batch = createDelegationBatch(policy);
  const duplicated = await toolTurn(t, batch, [call("dup", analyst), call("dup", analyst)]);
  assert.throws(() => confirm(batch, duplicated));
});

test("confirmation requires the original arguments and a successful receipt for every registered call", async (t) => {
  const batch = createDelegationBatch(policy);
  const turn = await toolTurn(t, batch, [call("first", analyst), call("second", analyst)]);
  const calls = turn.messages.find((m) => m.role === "assistant").content;
  const receipts = turn.messages.filter((m) => m.role === "toolResult");
  assert.throws(() => batch.confirm(calls.slice(0, 1), receipts));
  assert.throws(() => batch.confirm([call("first", recorder), calls[1]], receipts));
  assert.throws(() => batch.confirm(calls, [receipts[0], receipts[0]]));
  assert.throws(() => batch.confirm(calls, [receipts[0], { ...receipts[1], isError: true }]));
});

test("resume requires one bounded, allowlisted outcome per original call", () => {
  const proposals = [{ nativeCallId: "one" }, { nativeCallId: "two" }];
  const failed = { kind: "failed", nativeCallId: "two", code: "budget_exhausted" };
  const cancelled = { kind: "cancelled", nativeCallId: "one" };
  const results = delegationToolResults(proposals, [failed, cancelled], 1);
  assert.deepEqual(results.map((r) => [r.isError, JSON.parse(contentText(r.content))]), [[true, cancelled], [true, failed]]);
  for (const invalid of [[failed], [failed, failed], [failed, { ...cancelled, context: "private" }],
    [cancelled, { kind: "completed", nativeCallId: "two", text: "x".repeat(16385) }],
    [cancelled, { ...failed, code: "raw exception" }]]) {
    assert.throws(() => delegationToolResults(proposals, invalid, 1));
  }
});

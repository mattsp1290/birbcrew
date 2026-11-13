import { conversationTurnLimit } from "./limits.ts";
import { nativeCheckpointBytes, assertNativeJsonBudget } from "./native-limits.ts";
import { toolPreviewReporter } from "./tool-preview.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createTranslator, toAguiMessages, type HistoryEntry } from "@ag-ui/pi";
import { createDelegationBatch, delegationToolName, delegationToolResults, type Delegation } from "@birbcrew/pi-subagents";
import { contentText, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DriverInput, DriverResult } from "./activities.ts";
import { nativeProposal, toolNameSchema, type DeferredTool } from "./deferral.ts";
import { continueSession, nativeCall, proposalTool, toolResult } from "./pi-tools.ts";
import { checkpointSchema } from "./domain.ts";
import { runPiWorker } from "./pi-launch.ts";
import { piUsage } from "./usage-capture.ts";

const textPart = z.object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() });
const thinkingPart = z.object({
  type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const tokens = {
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
};
const piToolName = z.enum([...toolNameSchema.options, delegationToolName]);
const systemMessage = z.strictObject({
  role: z.literal("system"), content: z.union([z.string(), z.array(textPart)]), timestamp: z.number(),
  sections: z.record(z.string(), z.string().nullable()).optional(),
  toolsAdded: z.array(z.looseObject({ name: piToolName, description: z.string(), parameters: z.object({}).passthrough() })).optional(),
  toolsRemoved: z.array(z.object({ name: piToolName })).optional(),
});
const userMessage = z.looseObject({
  role: z.literal("user"), timestamp: z.number(), content: z.union([z.string(), z.array(textPart)]),
});
const assistantMessage = z.looseObject({
  role: z.literal("assistant"), timestamp: z.number(), content: z.array(z.union([textPart, thinkingPart])),
  api: z.string(), provider: z.string(), model: z.string(), stopReason: z.literal("stop"),
  usage: z.looseObject({
    ...tokens, totalTokens: z.number(), cost: z.looseObject({ ...tokens, total: z.number() }),
  }),
});
const delegationCall = z.looseObject({
  type: z.literal("toolCall"), name: z.literal(delegationToolName), id: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.json()), argumentsError: z.never().optional(),
});
const proposalMessage = assistantMessage.extend({
  stopReason: z.literal("toolUse"), content: z.array(z.union([textPart, thinkingPart, nativeCall, delegationCall])),
});
const resultMessage = z.strictObject({
  role: z.literal("toolResult"), toolCallId: z.string(), toolName: piToolName,
  timestamp: z.number(), isError: z.boolean(), content: z.array(textPart).length(1),
});
const turnPrefix = z.strictObject({
  runId: z.string(), system: z.array(systemMessage).max(4), user: userMessage,
});
const pendingTurn = turnPrefix.extend({ proposal: proposalMessage });
const completedTurn = turnPrefix.extend({
  tool: z.union([
    z.strictObject({ proposal: proposalMessage, result: resultMessage, system: z.array(systemMessage).max(4) }),
    z.strictObject({ proposal: proposalMessage, results: z.array(resultMessage).min(1).max(2), system: z.array(systemMessage).max(4) }),
  ]).optional(),
  assistant: assistantMessage,
});
const stateSchema = z.strictObject({
  threadId: z.string(), sessionId: z.uuid(), turns: z.array(completedTurn).max(conversationTurnLimit), pending: pendingTurn.optional(),
}).refine((s) => s.turns.length || s.pending, "Pi checkpoint has no native history");

type PiState = z.infer<typeof stateSchema>;
type Pending = z.infer<typeof pendingTurn>;
export interface PiProfile {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  instructions?: string;
  allowRecordWorkItem?: boolean;
  /** Runs on the host. Its extension may register only provider request hooks (pi-launch.ts). */
  prepare?: () => Promise<{ extension: ExtensionFactory; verify: () => void }>;
  /** The supervised process group the confined worker joins; without it the worker gets its own group. */
  invocationGroup?: number;
}

function onlyCall(pending: Pending) {
  const calls = pending.proposal.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0].name === delegationToolName ||
      (calls[0].name === "record_work_item" && calls[0].arguments.operation_id !== pending.runId)) {
    throw new Error("Expected one Pi tool call for this input");
  }
  return calls[0];
}

function privateCheckpoint(state: PiState) {
  const data = stateSchema.parse(state);
  return checkpointSchema.parse({ engine: "pi", version: 1, state: JSON.parse(JSON.stringify(data)) });
}

export function runPiDelegatingSegment(input: DriverInput, profile: PiProfile) {
  return confinedSegment(input, profile, "delegating");
}

export async function runPiSegment(input: DriverInput, profile: PiProfile, tool: DeferredTool = "record_work_item") {
  const segment = await confinedSegment(input, profile, tool);
  if (segment.kind === "delegated") throw new Error("Unexpected Pi delegation in a protected session");
  return segment;
}

export async function runPiTurn(input: DriverInput, profile: PiProfile) {
  const segment = await confinedSegment(input, profile, "text");
  if (segment.kind !== "complete") throw new Error("Unexpected Pi tool proposal on a text turn");
  return { text: segment.text, checkpoint: segment.checkpoint, usage: segment.usage };
}

const piCheckpoint = z.strictObject({ version: z.literal(1), engine: z.literal("pi"), state: z.unknown() });
const workerSegment = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("complete"), text: z.string().min(1), checkpoint: piCheckpoint, usage: z.unknown() }),
  z.strictObject({ kind: z.literal("pending"), proposal: nativeProposal, checkpoint: piCheckpoint, usage: z.unknown() }),
  z.strictObject({ kind: z.literal("delegated"), proposals: z.array(z.unknown()), checkpoint: piCheckpoint, usage: z.unknown() }),
]);

// The child profiles come from pi-subagents' role table, as they did in process, never from the worker.
async function confirmDelegations(calls: AssistantMessage["content"], profile: PiProfile) {
  const batch = createDelegationBatch({ model: profile.model.id, allowRecordWorkItem: !!profile.allowRecordWorkItem });
  let tool: ToolDefinition | undefined;
  await batch.extension({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as unknown as ExtensionAPI);
  const execute = tool!.execute as unknown as (id: string, args: unknown) => Promise<unknown>;
  for (const call of calls) if (call.type === "toolCall") await execute(call.id, call.arguments);
  return batch.confirm(calls, calls.map((call) => ({ role: "toolResult", toolName: delegationToolName,
    toolCallId: call.type === "toolCall" ? call.id : "", isError: false, content: [] })));
}

/**
 * The worker made every check below too, but the host no longer trusts its answer: the result must extend
 * the prior checkpoint by exactly this request, and its reply or calls must be what the model sent through
 * this host. Usage comes from the replies the host relayed.
 */
async function confinedSegment(input: DriverInput, profile: PiProfile, mode: "text" | DeferredTool | "delegating") {
  const { threadId, runId, text, projectContext, childResults, continuation } = input;
  const tool = mode === "delegating" ? (profile.allowRecordWorkItem ? "record_work_item" : undefined) : mode === "text" ? undefined : mode;
  const { result, observed, streamed } = await runPiWorker({
    kind: "member", mode, instructions: profile.instructions, allowRecordWorkItem: profile.allowRecordWorkItem,
    input: { threadId, runId, text, checkpoint: input.checkpoint, projectContext, childResults, continuation },
  }, { profile, signal: input.signal, modelRequests: 1, onText: input.onText, onToolArgs: input.onToolArgs,
    previews: tool === "record_work_item" && !continuation && !childResults });
  const segment = workerSegment.parse(result);
  const state = stateSchema.parse(segment.checkpoint.state);
  const prior = input.checkpoint === null ? undefined : stateSchema.parse(input.checkpoint.state);
  const relayed = observed[0];
  const current = segment.kind === "complete" ? state.turns.at(-1) : state.pending;
  const message = current && ("proposal" in current ? current.proposal : current.assistant);
  const calls = relayed.content.filter((part) => part.type === "toolCall");
  const outside = () => new Error("Pi worker returned a result outside its segment");
  if (!current || !message || state.threadId !== threadId || current.runId !== runId || contentText(current.user.content) !== text ||
      (segment.kind === "complete") === Boolean(state.pending) ||
      state.turns.length !== (prior?.turns.length ?? 0) + Number(segment.kind === "complete") ||
      (prior && (state.sessionId !== prior.sessionId || !isDeepStrictEqual(state.turns.slice(0, prior.turns.length), prior.turns))) ||
      (prior?.pending && !("tool" in current && current.tool && isDeepStrictEqual(
        [current.system, current.user, current.tool.proposal], [prior.pending.system, prior.pending.user, prior.pending.proposal]))) ||
      !isDeepStrictEqual(message.content, relayed.content)) throw outside();
  let proposals: Delegation[] | undefined;
  if (segment.kind === "complete") {
    if (segment.text !== streamed || segment.text !== contentText(relayed.content, "") || calls.length) throw outside();
  } else if (segment.kind === "pending") {
    const { proposal } = segment;
    if (proposal.name !== tool || calls.length !== 1 || !isDeepStrictEqual([calls[0].id, calls[0].name, calls[0].arguments],
        [proposal.nativeCallId, proposal.name, proposal.arguments]) ||
        (proposal.name === "record_work_item" && proposal.arguments.operation_id !== runId)) throw outside();
  } else {
    if (mode !== "delegating") throw outside();
    proposals = await confirmDelegations(calls, profile);
  }
  const checkpoint = privateCheckpoint(state), usage = piUsage(observed);
  return segment.kind === "delegated" ? { ...segment, proposals: proposals!, checkpoint, usage } : { ...segment, checkpoint, usage };
}

/** Runs only inside the confined worker (pi-worker.ts); callers use the exported segment functions above. */
export async function runSegment(input: DriverInput, profile: PiProfile, mode: "text" | DeferredTool | "delegating") {
  input.signal.throwIfAborted();
  const prior = input.checkpoint;
  if (prior !== null) assertNativeJsonBudget(prior, nativeCheckpointBytes, "Pi checkpoint");
  if (prior !== null && (prior.engine !== "pi" || prior.version !== 1)) throw new Error("Invalid Pi checkpoint");
  const state: PiState = prior === null
    ? { threadId: input.threadId, sessionId: randomUUID(), turns: [] }
    : stateSchema.parse(prior.state);
  if (state.threadId !== input.threadId || state.turns.some((turn) => turn.runId === input.runId)) {
    throw new Error("Pi checkpoint does not match this turn");
  }
  if (state.turns.length >= conversationTurnLimit) throw new Error("Pi conversation input limit reached");
  const pending = state.pending;
  const toolName = mode === "text" ? undefined : mode === "delegating" ?
    (profile.allowRecordWorkItem ? "record_work_item" : undefined) : mode;
  const hasContinuation = input.continuation !== undefined || input.childResults !== undefined;
  if (Boolean(pending) !== hasContinuation || (input.childResults && input.continuation) ||
      (pending && (pending.runId !== input.runId || contentText(pending.user.content) !== input.text))) {
    throw new Error("Pi continuation does not match the pending turn");
  }
  const results = [];
  if (pending && input.continuation && toolName) {
    const call = onlyCall(pending);
    if (call.name !== toolName) throw new Error("Pending Pi call differs from the member profile");
    results.push(toolResult(call, input.continuation));
  }
  if (pending && input.childResults && mode === "delegating") {
    const calls = pending.proposal.content.filter((part) => part.type === "toolCall");
    if (calls.some((call) => call.name !== delegationToolName)) throw new Error("Expected pending Pi delegations");
    results.push(...delegationToolResults(calls.map((call) => ({ nativeCallId: call.id })), input.childResults, pending.proposal.timestamp));
  }
  if (pending && results.length === 0) throw new Error("Missing authorized Pi continuation");
  const tool = toolName ? proposalTool(input.runId, toolName) : undefined;
  const batch = mode === "delegating" ? createDelegationBatch({ model: profile.model.id, allowRecordWorkItem: toolName === "record_work_item" }) : undefined;
  const prepared = await profile.prepare?.();
  const factories = [...(prepared ? [prepared.extension] : []), ...(batch ? [batch.extension] : [])];
  const cwd = await mkdtemp(join(tmpdir(), "birb-pi-"));
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noContextFiles: true, noThemes: true, systemPrompt: profile.instructions ?? "You are a BirbCrew coworker.",
      appendSystemPrompt: input.projectContext ? [input.projectContext] : [], extensionFactories: factories,
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    const expectedPaths = factories.map((_, index) => `<inline:${index + 1}>`);
    if (extensions.errors.length || extensions.extensions.length !== expectedPaths.length ||
        extensions.extensions.some((extension, i) => extension.path !== expectedPaths[i])) {
      throw new Error("Unexpected Pi extensions");
    }
    const sessionManager = SessionManager.inMemory(cwd, { id: state.sessionId });
    const history: HistoryEntry[] = [];
    function append(id: string, message: Parameters<SessionManager["appendMessage"]>[0]) {
      sessionManager.appendMessage(message);
      history.push({ id, message });
    }
    for (const turn of [...state.turns, ...(pending ? [pending] : [])]) {
      for (const change of turn.system) sessionManager.appendMessage(change);
      append(turn.runId + ":user", turn.user);
      const toolHistory = "proposal" in turn
        ? { proposal: turn.proposal, results, system: [] }
        : turn.tool;
      if (toolHistory) {
        const calls = toolHistory.proposal.content.filter((part) => part.type === "toolCall");
        if (calls.some((call) => call.name !== delegationToolName)) onlyCall({ ...turn, proposal: toolHistory.proposal });
        const replies = "result" in toolHistory ? [toolHistory.result] : toolHistory.results;
        if (calls.length !== replies.length || new Set(calls.map((c) => c.id)).size !== calls.length ||
            calls.some((call, i) => call.id !== replies[i].toolCallId || call.name !== replies[i].toolName)) {
          throw new Error("Invalid Pi tool history");
        }
        append(turn.runId + ":assistant", toolHistory.proposal);
        for (const reply of replies) append(turn.runId + ":result:" + reply.toolCallId, reply);
        for (const change of toolHistory.system) sessionManager.appendMessage(change);
      }
      if ("assistant" in turn) append(turn.runId + (toolHistory ? ":resumed" : ":assistant"), turn.assistant);
    }
    const tools = [...(tool ? [tool.definition.name] : []), ...(batch ? [delegationToolName] : [])];
    const { session } = await createAgentSession({
      model: profile.model, modelRuntime: profile.modelRuntime, cwd, agentDir: cwd, resourceLoader, settingsManager, sessionManager,
      tools, customTools: tool ? [tool.definition] : [], thinkingLevel: "off",
    });
    const assistantId = input.runId + (pending ? ":resumed" : ":assistant");
    const translator = createTranslator({
      threadId: input.threadId, runId: input.runId, completion: "caller",
      messageId: () => assistantId, getMessages: () => toAguiMessages(history),
    });
    const abort = () => { void session.abort(); };
    let text = "";
    let bytes = 0;
    translator.start();
    const committedCallIds: string[] = [];
    const reportPreview = toolPreviewReporter(input.runId, input.onToolArgs);
    const unsubscribe = session.subscribe((event) => {
      if (toolName === "record_work_item" && !pending && event.type === "message_update") {
        const chunk = event.assistantMessageEvent;
        if (chunk.type === "toolcall_delta" && chunk.delta) {
          const call = chunk.partial.content[chunk.contentIndex];
          if (call?.type === "toolCall" && call.name === toolName && call.id) {
            reportPreview(call.id, call.arguments.operation_id);
          }
        }
      }
      if (event.type === "message_end" && event.message.role === "toolResult") return;
      for (const frame of translator.translate(event)) {
        if (frame.type === "TOOL_CALL_END") committedCallIds.push(frame.toolCallId);
        if (frame.type !== "TEXT_MESSAGE_CONTENT") continue;
        bytes += Buffer.byteLength(frame.delta);
        if (bytes > 65_536) abort();
        else { text += frame.delta; input.onText?.(frame.delta); }
      }
    });
    try {
      if (JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...tools].sort())) throw new Error("Unexpected Pi tools");
      session.agent.finishTurn = () => ({ action: "end" });
      const before = sessionManager.getEntries().length;
      input.signal.addEventListener("abort", abort, { once: true });
      input.signal.throwIfAborted();
      if (pending) await continueSession(session);
      else await session.prompt(input.text, { expandPromptTemplates: false });
      await session.waitForIdle();
      input.signal.throwIfAborted();

      const messages = sessionManager.getEntries().slice(before)
        .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      const usage = piUsage(messages.filter((message) => message.role === "assistant"));
      const last = messages.at(-1);
      if (last?.role === "toolResult") {
        if (pending || bytes > 65_536) throw new Error("Unexpected repeated Pi tool proposal");
        const at = messages.findIndex((message) => message.role === "assistant");
        const proposal = pendingTurn.parse({
          runId: input.runId, system: messages.slice(0, at - 1), user: messages[at - 1], proposal: messages[at],
        });
        const calls = proposal.proposal.content.filter((part) => part.type === "toolCall");
        if (calls.length !== committedCallIds.length || calls.some((call, i) => call.id !== committedCallIds[i])) {
          throw new Error("Pi did not confirm its native calls");
        }
        history.push({ id: input.runId + ":user", message: proposal.user }, { id: assistantId, message: proposal.proposal });
        translator.finish();
        prepared?.verify();
        const receipts = messages.slice(at + 1);
        if (batch && calls.every((call) => call.name === delegationToolName)) {
          const proposals = batch.confirm(calls, receipts);
          return { kind: "delegated" as const, proposals, checkpoint: privateCheckpoint({ ...state, pending: proposal }), usage };
        }
        const call = onlyCall(proposal);
        if (!tool || call.name !== toolName || receipts.length !== 1 || call.id !== last.toolCallId || !tool.accepted.has(call.id) || last.isError) {
          throw new Error("Pi did not confirm a permitted tool proposal");
        }
        return { kind: "pending" as const, proposal: nativeProposal.parse({ name: call.name, nativeCallId: call.id, arguments: call.arguments }),
          checkpoint: privateCheckpoint({ ...state, pending: proposal }), usage } satisfies DriverResult;
      }
      if (last?.role !== "assistant" || last.stopReason !== "stop" || committedCallIds.length) {
        throw new Error("Pi did not complete the text turn");
      }
      const turn = completedTurn.parse(pending ? {
        runId: input.runId, system: pending.system, user: pending.user, assistant: last,
        tool: { proposal: pending.proposal, ...(input.continuation ? { result: results[0] } : { results }),
          system: messages.slice(0, -1).filter((m) => m.role === "system") },
      } : {
        runId: input.runId, system: messages.slice(0, -2), user: messages.at(-2), assistant: last,
      });
      if (!pending) history.push({ id: input.runId + ":user", message: turn.user });
      history.push({ id: assistantId, message: turn.assistant });
      const snapshot = translator.finish().find((frame) => frame.type === "MESSAGES_SNAPSHOT");
      const reply = snapshot?.messages.at(-1);
      if (!text || bytes > 65_536 || reply?.id !== assistantId || reply.content !== text) {
        throw new Error("Pi stream did not match its committed reply");
      }
      prepared?.verify();
      const next = { threadId: state.threadId, sessionId: state.sessionId, turns: [...state.turns, turn] };
      return { kind: "complete" as const, text, checkpoint: privateCheckpoint(next), usage };
    } finally {
      input.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

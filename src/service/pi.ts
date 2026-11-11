import { toolPreviewReporter } from "./tool-preview.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator, toAguiMessages, type HistoryEntry } from "@ag-ui/pi";
import { createDelegationBatch, delegationToolName, delegationToolResults } from "@birbcrew/pi-subagents";
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DriverInput, DriverResult } from "./activities.ts";
import { continueSession, nativeCall, proposalTool, toolName, toolResult } from "./pi-tools.ts";
import { checkpointSchema } from "./domain.ts";

const textPart = z.object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() });
const thinkingPart = z.object({
  type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const tokens = {
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
};
const piToolName = z.enum([toolName, delegationToolName]);
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
  threadId: z.string(), sessionId: z.uuid(), turns: z.array(completedTurn).max(4), pending: pendingTurn.optional(),
}).refine((s) => s.turns.length || s.pending, "Pi checkpoint has no native history");

type PiState = z.infer<typeof stateSchema>;
type Pending = z.infer<typeof pendingTurn>;
export interface PiProfile {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  instructions?: string;
  allowRecordWorkItem?: boolean;
  prepare?: () => Promise<{ extension: ExtensionFactory; verify: () => void }>;
}

function onlyCall(pending: Pending) {
  const calls = pending.proposal.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0].name !== toolName || calls[0].arguments.operation_id !== pending.runId) {
    throw new Error("Expected one Pi tool call for this input");
  }
  return calls[0];
}

function privateCheckpoint(state: PiState) {
  const data = stateSchema.parse(state);
  return checkpointSchema.parse({ engine: "pi", version: 1, state: JSON.parse(JSON.stringify(data)) });
}

export function runPiDelegatingSegment(input: DriverInput, profile: PiProfile) {
  return runSegment(input, profile, "delegating");
}

export async function runPiSegment(input: DriverInput, profile: PiProfile) {
  const segment = await runSegment(input, profile, "protected");
  if (segment.kind === "delegated") throw new Error("Unexpected Pi delegation in a protected session");
  return segment;
}

export async function runPiTurn(input: DriverInput, profile: PiProfile) {
  const segment = await runSegment(input, profile, "text");
  if (segment.kind !== "complete") throw new Error("Unexpected Pi tool proposal on a text turn");
  return { text: segment.text, checkpoint: segment.checkpoint };
}

async function runSegment(input: DriverInput, profile: PiProfile, mode: "text" | "protected" | "delegating") {
  input.signal.throwIfAborted();
  const prior = input.checkpoint;
  if (prior !== null && (prior.engine !== "pi" || prior.version !== 1)) throw new Error("Invalid Pi checkpoint");
  const state: PiState = prior === null
    ? { threadId: input.threadId, sessionId: randomUUID(), turns: [] }
    : stateSchema.parse(prior.state);
  if (state.threadId !== input.threadId || state.turns.some((turn) => turn.runId === input.runId)) {
    throw new Error("Pi checkpoint does not match this turn");
  }
  if (state.turns.length >= 4) throw new Error("Pi conversation input limit reached");
  const pending = state.pending;
  const protectedTool = mode === "protected" || (mode === "delegating" && profile.allowRecordWorkItem === true);
  const hasContinuation = input.continuation !== undefined || input.childResults !== undefined;
  if (Boolean(pending) !== hasContinuation || (input.childResults && input.continuation) ||
      (pending && (pending.runId !== input.runId || contentText(pending.user.content) !== input.text))) {
    throw new Error("Pi continuation does not match the pending turn");
  }
  const results = [];
  if (pending && input.continuation && protectedTool) results.push(toolResult(onlyCall(pending), input.continuation));
  if (pending && input.childResults && mode === "delegating") {
    const calls = pending.proposal.content.filter((part) => part.type === "toolCall");
    if (calls.some((call) => call.name !== delegationToolName)) throw new Error("Expected pending Pi delegations");
    results.push(...delegationToolResults(calls.map((call) => ({ nativeCallId: call.id })), input.childResults, pending.proposal.timestamp));
  }
  if (pending && results.length === 0) throw new Error("Missing authorized Pi continuation");
  const tool = protectedTool ? proposalTool(input.runId) : undefined;
  const batch = mode === "delegating" ? createDelegationBatch({ model: profile.model.id, allowRecordWorkItem: protectedTool }) : undefined;
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
      appendSystemPrompt: [], extensionFactories: factories,
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
        if (calls.some((call) => call.name === toolName)) onlyCall({ ...turn, proposal: toolHistory.proposal });
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
      if (tool && !pending && event.type === "message_update") {
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
          return { kind: "delegated" as const, proposals, checkpoint: privateCheckpoint({ ...state, pending: proposal }) };
        }
        const call = onlyCall(proposal);
        if (!tool || receipts.length !== 1 || call.id !== last.toolCallId || !tool.accepted.has(call.id) || last.isError) {
          throw new Error("Pi did not confirm a permitted tool proposal");
        }
        return { kind: "pending" as const, proposal: { name: toolName, nativeCallId: call.id, arguments: call.arguments },
          checkpoint: privateCheckpoint({ ...state, pending: proposal }) } satisfies DriverResult;
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
      return { kind: "complete" as const, text, checkpoint: privateCheckpoint(next) };
    } finally {
      input.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

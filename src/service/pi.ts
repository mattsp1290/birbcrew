import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator, toAguiMessages, type HistoryEntry } from "@ag-ui/pi";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DriverInput } from "./activities.ts";
import { checkpointSchema } from "./domain.ts";

const textPart = z.object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() });
const thinkingPart = z.object({
  type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const tokens = {
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
};
const systemMessage = z.strictObject({
  role: z.literal("system"), content: z.union([z.string(), z.array(textPart)]), timestamp: z.number(),
  sections: z.record(z.string(), z.string().nullable()).optional(),
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
const stateSchema = z.strictObject({
  threadId: z.string(), sessionId: z.uuid(),
  turns: z.array(z.strictObject({
    runId: z.string(), system: z.array(systemMessage).max(4), user: userMessage, assistant: assistantMessage,
  })).min(1).max(4),
});

export async function runPiTurn(
  input: DriverInput,
  profile: {
    model: Model<Api>;
    modelRuntime: ModelRuntime;
    prepare?: () => Promise<{ extension: ExtensionFactory; verify: () => void }>;
  },
) {
  input.signal.throwIfAborted();
  const prior = input.checkpoint;
  if (prior !== null && (prior.engine !== "pi" || prior.version !== 1)) throw new Error("Invalid Pi checkpoint");
  const state = prior === null
    ? { threadId: input.threadId, sessionId: randomUUID(), turns: [] }
    : stateSchema.parse(prior.state);
  if (state.threadId !== input.threadId || state.turns.some((turn) => turn.runId === input.runId)) {
    throw new Error("Pi checkpoint does not match this turn");
  }
  if (state.turns.length >= 4) throw new Error("Pi conversation input limit reached");

  const prepared = await profile.prepare?.();
  const cwd = await mkdtemp(join(tmpdir(), "birb-pi-"));
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noContextFiles: true, noThemes: true, systemPrompt: "You are a BirbCrew coworker.",
      appendSystemPrompt: [], extensionFactories: prepared ? [prepared.extension] : [],
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    const expectedPaths = prepared ? ["<inline:1>"] : [];
    if (extensions.errors.length || extensions.extensions.length !== expectedPaths.length ||
        extensions.extensions.some((extension, i) => extension.path !== expectedPaths[i])) {
      throw new Error("Unexpected Pi extensions");
    }
    const sessionManager = SessionManager.inMemory(cwd, { id: state.sessionId });
    for (const turn of state.turns) {
      for (const change of turn.system) sessionManager.appendMessage(change);
      sessionManager.appendMessage(turn.user);
      sessionManager.appendMessage(turn.assistant);
    }
    const { session } = await createAgentSession({
      model: profile.model, modelRuntime: profile.modelRuntime, cwd, agentDir: cwd, resourceLoader, settingsManager, sessionManager,
      tools: [], thinkingLevel: "off",
    });
    const history = toAguiMessages(state.turns.flatMap((turn): HistoryEntry[] => [
      { id: turn.runId + ":user", message: turn.user }, { id: turn.runId + ":assistant", message: turn.assistant },
    ]));
    const assistantId = input.runId + ":assistant";
    const translator = createTranslator({
      threadId: input.threadId, runId: input.runId, completion: "caller",
      messageId: () => assistantId, getMessages: () => history,
    });
    const abort = () => { void session.abort(); };
    let text = "";
    let bytes = 0;
    translator.start();
    const unsubscribe = session.subscribe((event) => {
      for (const frame of translator.translate(event)) {
        if (frame.type !== "TEXT_MESSAGE_CONTENT") continue;
        bytes += Buffer.byteLength(frame.delta);
        if (bytes > 65_536) abort();
        else text += frame.delta;
      }
    });
    try {
      if (session.getActiveToolNames().length) throw new Error("Unexpected Pi tools");
      session.agent.finishTurn = () => ({ action: "end" });
      const before = sessionManager.getEntries().length;
      input.signal.addEventListener("abort", abort, { once: true });
      input.signal.throwIfAborted();
      await session.prompt(input.text, { expandPromptTemplates: false });
      await session.waitForIdle();
      input.signal.throwIfAborted();

      const messages = sessionManager.getEntries().slice(before)
        .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      const system = messages.slice(0, -2);
      const user = messages.at(-2);
      const assistant = messages.at(-1);
      if (system.some((message) => message.role !== "system") || user?.role !== "user" ||
          assistant?.role !== "assistant" || assistant.stopReason !== "stop") {
        throw new Error("Pi did not complete the text turn");
      }
      history.push(...toAguiMessages([{ id: input.runId + ":user", message: user }, { id: assistantId, message: assistant }]));
      const snapshot = translator.finish().find((frame) => frame.type === "MESSAGES_SNAPSHOT");
      const reply = snapshot?.messages.at(-1);
      if (!text || bytes > 65_536 || reply?.id !== assistantId || reply.content !== text) {
        throw new Error("Pi stream did not match its committed reply");
      }
      prepared?.verify();
      const turn = { runId: input.runId, system, user, assistant };
      const next = stateSchema.parse({ ...state, turns: [...state.turns, turn] });
      const checkpoint = checkpointSchema.parse({ engine: "pi", version: 1, state: JSON.parse(JSON.stringify(next)) });
      return { text, checkpoint };
    } finally {
      input.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { createTranslator, toAguiMessages } from "@ag-ui/pi";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  type Context,
  type JsonObject,
  contentText,
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  type ProviderStreams,
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Observable } from "rxjs";

const model = fauxProvider({ api: "birbcrew-fixture" }).getModel();

function scriptedStream(context: Context, signal: AbortSignal | undefined, onProviderFailure?: () => void) {
  const prompts = context.messages
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content));
  const latest = prompts.at(-1);
  const prefix = "remember ";
  const remembered = prompts.findLast((text) => text.startsWith(prefix))?.slice(prefix.length);
  const stream = createAssistantMessageEventStream();

  function fail(reason: "error" | "aborted") {
    const error = fauxAssistantMessage("", { stopReason: reason, errorMessage: "Pi fixture " + reason });
    stream.push({ type: "error", reason, error });
  }

  if (latest === "fail") {
    onProviderFailure?.();
    fail("error");
    return stream;
  }
  const last = context.messages.findLast((message) => message.role !== "system");
  if (latest?.startsWith("record ") && last?.role !== "toolResult") {
    const [, operation_id, ...words] = latest.split(" ");
    const args: JsonObject = { operation_id };
    if (words.length) args.note = words.join(" ");
    const call = fauxToolCall("record_work_item", args, { id: "call_" + randomUUID() });
    const message = fauxAssistantMessage([call], { stopReason: "toolUse", responseId: randomUUID() });
    stream.push({ type: "start", partial: fauxAssistantMessage("") });
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  }
  let text: string;
  if (latest?.startsWith("record ") && last?.role === "toolResult") text = "settled " + contentText(last.content);
  else if (latest === "recall") text = "recalled " + (remembered ?? "none");
  else if (latest?.startsWith(prefix)) text = "stored " + latest.slice(prefix.length);
  else if (latest === "wait") text = "waiting";
  else throw new Error("Unexpected Pi fixture prompt");

  const message = fauxAssistantMessage(text, { responseId: randomUUID() });
  stream.push({ type: "start", partial: fauxAssistantMessage("") });
  stream.push({ type: "text_delta", contentIndex: 0, partial: message, delta: text });
  if (latest === "wait") {
    if (!signal) throw new Error("Pi must supply a cancellation signal");
    if (signal.aborted) fail("aborted");
    else signal.addEventListener("abort", () => fail("aborted"), { once: true });
  } else {
    stream.push({ type: "done", reason: "stop", message });
  }
  return stream;
}

export async function createFixture(onProviderFailure: () => void) {
  const sessions = new Map<string, Agent>();
  const messageIds = new WeakMap<object, string>();

  return {
    run({ threadId, runId, messages }: RunAgentInput, signal: AbortSignal) {
      return new Observable<BaseEvent>((subscriber) => {
        const agent = sessions.get(threadId) ?? new Agent({
          sessionId: threadId,
          initialState: { model },
          streamFn: (_model, context, options) => scriptedStream(context, options?.signal, onProviderFailure),
        });
        sessions.set(threadId, agent);
        const assistantId = runId + ":assistant";
        const translator = createTranslator({
          threadId,
          runId,
          completion: "caller",
          messageId: () => assistantId,
          getMessages: () => toAguiMessages(agent.state.messages.flatMap((message) => {
            const id = messageIds.get(message);
            return id === undefined ? [] : [{ id, message }];
          })),
        });
        const emit = (events: BaseEvent[]) => events.forEach((event) => subscriber.next(event));
        emit(translator.start());
        const prompt = messages.at(-1);
        if (
          prompt?.role !== "user" || typeof prompt.content !== "string" ||
          agent.state.isStreaming || signal.aborted
        ) {
          emit(translator.error("Pi cannot start the requested turn"));
          subscriber.complete();
          return;
        }
        const unsubscribe = agent.subscribe((event) => {
          if (event.type === "message_end") {
            messageIds.set(event.message, event.message.role === "user" ? prompt.id : assistantId);
          }
          emit(translator.translate(event));
        });
        const abort = () => agent.abort();
        signal.addEventListener("abort", abort, { once: true });
        let settled = false;

        async function runTurn(text: string) {
          try {
            await agent.prompt(text);
            const last = agent.state.messages.at(-1);
            const reason = last?.role === "assistant" ? last.stopReason : undefined;
            if (reason === "stop") emit(translator.finish());
            else emit(translator.error(reason === "aborted" ? "Pi run aborted" : "Pi model request failed"));
          } catch {
            emit(translator.error("Pi model request failed"));
          } finally {
            settled = true;
            signal.removeEventListener("abort", abort);
            unsubscribe();
            subscriber.complete();
          }
        }
        void runTurn(prompt.content);
        return () => {
          if (!settled) abort();
        };
      });
    },
    async close() {
      for (const agent of sessions.values()) agent.abort();
      await Promise.all([...sessions.values()].map((agent) => agent.waitForIdle()));
      sessions.clear();
    },
  };
}

export async function createPiFixtureOptions(
  observe?: (context: Context, options?: { sessionId?: string }) => void,
) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const stream: ProviderStreams["stream"] = (_model, context, options) => {
    observe?.(context, options);
    return scriptedStream(context, options?.signal);
  };
  modelRuntime.registerNativeProvider(createProvider({
    id: model.provider, models: [model],
    auth: { apiKey: { name: "BirbCrew fixture", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return { model, modelRuntime };
}

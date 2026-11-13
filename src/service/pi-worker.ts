import {
  createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { forwardedOptions } from "./pi-launch.ts";
import { runSegment, type PiProfile } from "./pi.ts";
import { runTrustedSession } from "./trusted-pi.ts";
import type { DriverInput } from "./activities.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";

// Started only by pi-launch.ts through the member launcher: no credentials, no sockets, only this IPC channel.
type Command = { model: Model<Api>; instructions?: string; allowRecordWorkItem?: boolean } & (
  | { kind: "member"; mode: Parameters<typeof runSegment>[2]; input: Omit<DriverInput, "signal"> }
  | { kind: "trusted"; input: Pick<TrustedNativeInput, "text" | "context" | "checkpoint" | "tools"> });

// The host stops a worker by killing it, so the SDK's own signal never fires.
const signal = new AbortController().signal;
const streams = new Map<number, { events: AssistantMessageEventStream; release: () => void }>();
const calls = new Map<number, { resolve: (result: { text: string; isError: boolean }) => void; reject: (error: Error) => void }>();
let sequence = 0;
let started = false;
const send = (message: object) => { process.send?.(message); };
const forwarded = Object.keys(forwardedOptions.shape);

async function hostModels(model: Model<Api>) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  const stream: ProviderStreams["stream"] = (_model, context, options) => {
    const id = ++sequence;
    const events = createAssistantMessageEventStream();
    const cancel = () => send({ cancel: id });
    streams.set(id, { events, release: () => options?.signal?.removeEventListener("abort", cancel) });
    const values = options as Record<string, unknown> | undefined;
    send({ request: id, context, options: Object.fromEntries(forwarded.flatMap((key) => values?.[key] === undefined ? [] : [[key, values[key]]])) });
    if (options?.signal?.aborted) cancel();
    else options?.signal?.addEventListener("abort", cancel, { once: true });
    return events;
  };
  runtime.registerNativeProvider(createProvider({
    id: model.provider, models: [model],
    auth: { apiKey: { name: "Crew host", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return runtime;
}

function dispatch(call: { nativeCallId: string; toolName: string; args: unknown }) {
  return new Promise<{ text: string; isError: boolean }>((resolve, reject) => {
    const id = ++sequence;
    calls.set(id, { resolve, reject });
    send({ dispatch: id, nativeCallId: call.nativeCallId, toolName: call.toolName, args: call.args });
  });
}

async function run(command: Command) {
  const { model, instructions, allowRecordWorkItem } = command;
  const profile: PiProfile = { model, modelRuntime: await hostModels(model), ...(instructions && { instructions }), allowRecordWorkItem };
  const onText = (delta: string) => send({ delta });
  if (command.kind === "trusted") {
    return runTrustedSession({ ...command.input, signal, dispatch, onText,
      onToolDelivered: (delivered) => send({ delivered }) }, profile);
  }
  return runSegment({ ...command.input, signal, onText,
    onToolArgs: (toolArgs, matchedOperation) => send({ toolArgs, matchedOperation }) }, profile, command.mode);
}

process.once("disconnect", () => process.exit(1));
process.on("message", (message: unknown) => {
  if (!started) {
    started = true;
    run(message as Command).then((result) => ({ result }), (error: unknown) =>
      ({ error: (error instanceof Error ? error.message : "Pi worker failed").slice(0, 1024) }))
      .then((reply) => process.send?.(reply, () => process.exit(0)));
    return;
  }
  const value = message as { stream?: number; event?: AssistantMessageEvent; dispatch?: number; result?: { text: string; isError: boolean }; error?: string };
  if (value.stream !== undefined && value.event) {
    const entry = streams.get(value.stream);
    if (!entry) return;
    if (value.event.type === "done" || value.event.type === "error") {
      streams.delete(value.stream);
      entry.release();
    }
    entry.events.push(value.event);
  } else if (value.dispatch !== undefined) {
    const call = calls.get(value.dispatch);
    calls.delete(value.dispatch);
    if (value.result) call?.resolve(value.result);
    else call?.reject(new Error(value.error ?? "Trusted application tool failed"));
  }
});

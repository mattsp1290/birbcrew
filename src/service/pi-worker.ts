import {
  createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Socket } from "node:net";
import { readFrames, writeFrame } from "./pi-channel.ts";
import { forwardedOptions } from "./pi-launch.ts";
import { runSegment, type PiProfile } from "./pi.ts";
import { runTrustedSession } from "./trusted-pi.ts";
import type { DriverInput } from "./activities.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";

// Started only by pi-launch.ts through the member launcher: no credentials, no sockets, only descriptor 3.
type Command = { model: Model<Api>; instructions?: string; allowRecordWorkItem?: boolean } & (
  | { kind: "member"; mode: Parameters<typeof runSegment>[2]; input: Omit<DriverInput, "signal"> }
  | { kind: "trusted"; input: Pick<TrustedNativeInput, "text" | "context" | "checkpoint" | "tools"> });

// The host stops a worker by killing it, so the SDK's own signal never fires.
const signal = new AbortController().signal;
const streams = new Map<number, { events: AssistantMessageEventStream; release: () => void }>();
const calls = new Map<number, { resolve: (result: { text: string; isError: boolean }) => void; reject: (error: Error) => void }>();
let sequence = 0;
let started = false;
// Wrapping the inherited descriptor needs no socket call, which the launcher denies.
const channel = new Socket({ fd: 3, readable: true, writable: true });
const send = (message: object) => writeFrame(channel, message);
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

// The host runs the tool with the arguments the model sent through it.
function dispatch(call: { nativeCallId: string; toolName: string }) {
  return new Promise<{ text: string; isError: boolean }>((resolve, reject) => {
    const id = ++sequence;
    calls.set(id, { resolve, reject });
    send({ dispatch: id, nativeCallId: call.nativeCallId, toolName: call.toolName });
  });
}

async function run(command: Command) {
  const { model, instructions, allowRecordWorkItem } = command;
  const profile: PiProfile = { model, modelRuntime: await hostModels(model), ...(instructions !== undefined && { instructions }), allowRecordWorkItem };
  // Text and argument previews are published by the host from the events it relays.
  if (command.kind === "trusted") {
    return runTrustedSession({ ...command.input, signal, dispatch, onToolDelivered: (delivered) => send({ delivered }) }, profile);
  }
  return runSegment({ ...command.input, signal }, profile, command.mode);
}

function receive(message: unknown) {
  if (!started) {
    started = true;
    run(message as Command).then((result) => ({ result }), (error: unknown) =>
      ({ error: (error instanceof Error ? error.message : "Pi worker failed").slice(0, 1024) }))
      .then((reply) => writeFrame(channel, reply, () => process.exit(0)));
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
}

// Losing the host ends the worker.
channel.once("end", () => process.exit(1));
channel.once("error", () => process.exit(1));
readFrames(channel, receive, () => process.exit(1));

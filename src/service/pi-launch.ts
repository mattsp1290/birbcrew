import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_ATTRIBUTION, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Model, type ProviderResponse, type ToolCall } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { readFrames, writeFrame } from "./pi-channel.ts";
import type { PiProfile } from "./pi.ts";
import { toolPreviewReporter } from "./tool-preview.ts";

const source = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const launcher = join(source, ".proof/bin/member-launch");
const worker = fileURLToPath(new URL("./pi-worker.ts", import.meta.url));

/** The member launcher invocation of every Pi worker. Its private directory is its only writable state,
 * and descriptor 3 (a socket pair) is its only channel. */
export function piLaunch(directory: string, args: string[], invocationGroup?: number) {
  return {
    command: launcher,
    args: [String(process.pid), process.execPath, ...args],
    options: {
      cwd: directory, detached: !invocationGroup, stdio: ["ignore", "ignore", "ignore", "pipe"] as ("ignore" | "pipe")[],
      env: { HOME: directory, TMPDIR: directory, BIRBCREW_NATIVE_SOURCE: source },
    },
  };
}

/** The request options the worker's session may set. The host fixes retries and identity, and keeps
 * credentials, headers and callbacks; Crew runs Pi with thinking off, so reasoning never crosses. */
export const forwardedOptions = z.strictObject({
  sessionId: z.uuid().optional(),
  transport: z.enum(["sse", "websocket", "websocket-cached", "auto"]).optional(),
  timeoutMs: z.int().min(1).max(2_147_483_647).optional(),
  websocketConnectTimeoutMs: z.int().min(1).max(600_000).optional(),
  maxRetries: z.literal(0).optional(),
  maxRetryDelayMs: z.int().min(0).max(600_000).optional(),
});
const id = z.int().min(1);
const toolCall = z.strictObject({ nativeCallId: z.string().min(1).max(256), toolName: z.string().min(1).max(64) });
// The worker reports no text or previews: the host derives both from the events it relays.
const workerMessage = z.union([
  z.strictObject({ request: id, context: z.record(z.string(), z.unknown()), options: forwardedOptions }),
  z.strictObject({ cancel: id }),
  z.strictObject({ dispatch: id, ...toolCall.shape }),
  z.strictObject({ delivered: toolCall }),
  z.strictObject({ result: z.unknown() }),
  z.strictObject({ error: z.string().max(1024) }),
]);
const replyBytes = 65_536, unreadBytes = 64 * 1024 * 1024;

export type PiCommand =
  | { kind: "member"; mode: string; instructions?: string; allowRecordWorkItem?: boolean; input: Record<string, unknown> }
  | { kind: "trusted"; instructions?: string; input: Record<string, unknown> };

export interface PiHost {
  profile: PiProfile;
  signal: AbortSignal;
  /** A member segment ends after one model reply; a trusted turn adds one per registered tool call. */
  modelRequests: number;
  onText?: (delta: string) => void | Promise<void>;
  /** Also publish text a reply sent without deltas, as the member session's AG-UI translator does. */
  translatedText?: boolean;
  /** The request whose fresh record_work_item call may publish argument previews, as runSegment did. */
  previews?: string;
  onToolArgs?: (nativeCallId: string, matchedOperation: boolean) => void;
  /** Present only for trusted turns: the registered tools run here, with the call the model sent. */
  dispatch?: (call: ToolCall, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>;
  onToolDelivered?: (call: z.infer<typeof toolCall>) => void | Promise<void>;
}

export interface Delivered { toolCallId: string; toolName: string; text: string; isError: boolean }

// The identity the SDK's own session sends for this host (pi-coding-agent core/client-identity.js).
function identity() {
  const telemetry = process.env.PI_TELEMETRY;
  return { userAgent: "detailed" as const, version: VERSION,
    attribution: telemetry === undefined || ["1", "true", "yes"].includes(telemetry.toLowerCase()) ? PI_ATTRIBUTION : null };
}

const providerEvents = new Set(["before_provider_headers", "before_provider_request", "after_provider_response", "provider_stream_event"]);
type Handler = (event: object, context: never) => unknown;

// The worker never holds the profile's closures, so its extension runs here, limited to the provider request.
async function providerHooks(profile: PiProfile) {
  const prepared = await profile.prepare?.();
  const handlers = new Map<string, Handler[]>();
  const refuse = () => { throw new Error("A Pi profile extension may only observe the provider request"); };
  if (prepared) await prepared.extension(new Proxy({}, {
    get: (_, key) => key === "on" ? (event: string, handler: Handler) => {
      if (!providerEvents.has(event)) refuse();
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
    } : refuse(),
  }) as ExtensionAPI);
  const context = new Proxy({}, { get: refuse }) as never;
  const emit = async (type: string, event: object) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
  };
  return {
    verify: () => prepared?.verify(),
    options: {
      ...handlers.has("before_provider_headers") && {
        transformHeaders: async (headers: Record<string, string | null>) => { await emit("before_provider_headers", { headers }); return headers; },
      },
      ...handlers.has("before_provider_request") && {
        onPayload: async (payload: unknown) => {
          for (const handler of handlers.get("before_provider_request")!) {
            payload = await handler({ type: "before_provider_request", payload }, context) ?? payload;
          }
          return payload;
        },
      },
      ...handlers.has("after_provider_response") && {
        onResponse: async ({ status, headers }: ProviderResponse) => { await emit("after_provider_response", { status, headers }); },
      },
      ...handlers.has("provider_stream_event") && {
        onProviderStreamEvent: async (data: unknown, model: Model<Api>) => {
          await emit("provider_stream_event", { data, provider: model.provider, api: model.api, model: model.id });
        },
      },
    },
  };
}

function failed(model: Model<Api>, aborted: boolean): AssistantMessageEvent {
  const reason = aborted ? "aborted" : "error";
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { type: "error", reason, error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: reason,
    errorMessage: "Pi model request failed", timestamp: Date.now(),
  } };
}

/**
 * Runs one Pi command in a worker confined by the member launcher. The worker gets no credentials and no
 * sockets: this host makes each model request with the operator's profile and runs each tool dispatch.
 * Resolves with the worker's unvalidated result and what the host itself saw: the private directory, the
 * assistant messages it relayed, the text it published from them, and the tool results it delivered.
 */
export async function runPiWorker(command: PiCommand, host: PiHost) {
  host.signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "birb-pi-worker-"));
  try {
    return await supervise(directory, command, host);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function supervise(directory: string, command: PiCommand, host: PiHost) {
  const { profile, signal } = host;
  const { headers: _, ...model } = profile.model;
  const launch = piLaunch(directory, [worker], profile.invocationGroup);
  return new Promise<{ result: unknown; directory: string; observed: AssistantMessage[]; streamed: string; delivered: Delivered[] }>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, launch.options);
    const channel = child.stdio[3] as Duplex | null;
    const halted = new AbortController(), exited = new AbortController();
    const streams = new Map<number, AbortController>();
    const observed: AssistantMessage[] = [];
    // Trusted tool calls the model made, those dispatched, and the results not yet delivered to the model.
    const relayed = new Map<string, ToolCall>(), dispatched = new Set<string>(), undelivered = new Map<string, Delivered>();
    const delivered: Delivered[] = [];
    let reply: z.infer<typeof workerMessage> | undefined, failure: unknown, requests = 0, inflight = 0;
    let streamed = "", streamedBytes = 0;
    let hooks: ReturnType<typeof providerHooks> | undefined;
    let callbacks = Promise.resolve();
    const record = (error: unknown) => { if (!halted.signal.aborted) { failure = error; halted.abort(); } };
    const kill = (target: number) => {
      try { process.kill(target, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) record(error); }
    };
    // A worker in its own group is killed with the group, which lives while any process in it does.
    const stop = () => {
      if (!child.pid) return;
      if (!profile.invocationGroup) kill(-child.pid);
      else if (child.exitCode === null && child.signalCode === null) kill(child.pid);
    };
    // After a failure nothing the worker sent is acted on, and every request made for it is cancelled.
    const fail = (error: unknown) => { record(error); stop(); };
    const inOrder = (action: () => unknown) => {
      callbacks = callbacks.then(async () => { if (!halted.signal.aborted) await action(); }).catch(fail);
    };
    const post = (message: object) => {
      if (!channel?.writable || exited.signal.aborted) return;
      if (channel.writableLength > unreadBytes) return fail(new Error("Pi worker stopped reading its channel"));
      writeFrame(channel, message, (error) => { if (error) fail(error); });
    };
    const working = () => AbortSignal.any([signal, halted.signal, exited.signal]);
    const preview = host.previews === undefined ? undefined :
      toolPreviewReporter(host.previews, (callId, matched) => inOrder(() => host.onToolArgs?.(callId, matched)));
    // sent counts the characters published for each content part of the reply being relayed.
    function publish(event: AssistantMessageEvent, sent: Map<number, number>) {
      const text = (index: number, delta: string) => {
        if (!delta) return;
        sent.set(index, (sent.get(index) ?? 0) + delta.length);
        streamedBytes += Buffer.byteLength(delta);
        if (streamedBytes > replyBytes) throw new Error("Pi model reply exceeded its bound");
        streamed += delta;
        inOrder(() => host.onText?.(delta));
      };
      if (event.type === "text_delta") text(event.contentIndex, event.delta);
      else if (host.translatedText && event.type === "text_end") text(event.contentIndex, event.content.slice(sent.get(event.contentIndex) ?? 0));
      else if (host.translatedText && (event.type === "done" || event.type === "error")) {
        for (const [index, part] of (event.type === "done" ? event.message : event.error).content.entries()) {
          if (part.type === "text") text(index, part.text.slice(sent.get(index) ?? 0));
        }
      } else if (preview && event.type === "toolcall_delta" && event.delta) {
        const call = event.partial.content[event.contentIndex];
        if (call?.type === "toolCall" && call.name === "record_work_item" && call.id) preview(call.id, call.arguments.operation_id);
      }
    }

    // The SDK waits for each reply before it asks again, so a worker never needs two requests at once.
    async function serve(id: number, context: Context, options: z.infer<typeof forwardedOptions>) {
      if (streams.size || ++requests > host.modelRequests) throw new Error("Pi worker exceeded its model requests");
      const controller = new AbortController();
      streams.set(id, controller);
      let settled = false;
      const sent = new Map<number, number>();
      try {
        const extension = await (hooks ??= providerHooks(profile));
        const events = profile.modelRuntime.streamSimple(profile.model, context, {
          ...options, maxRetries: 0, identity: identity(), ...extension.options, signal: AbortSignal.any([working(), controller.signal]),
        });
        for await (const event of events) {
          publish(event, sent);
          if (event.type === "done" || event.type === "error") {
            observed.push(event.type === "done" ? event.message : event.error);
            // The agent runs tools only from a reply that ends to use them.
            if (event.type === "done" && event.reason === "toolUse") {
              for (const part of event.message.content) if (part.type === "toolCall") relayed.set(part.id, part);
            }
            settled = true;
          }
          post({ stream: id, event });
          if (settled) break;
        }
      } finally {
        streams.delete(id);
        if (!settled) post({ stream: id, event: failed(profile.model, controller.signal.aborted) });
      }
    }

    // The tool runs with the call the model sent, never with arguments from the worker. As in process, a
    // failed dispatch fails the turn.
    async function dispatch(id: number, { nativeCallId, toolName }: z.infer<typeof toolCall>) {
      const call = relayed.get(nativeCallId);
      if (!host.dispatch || call?.name !== toolName || dispatched.has(nativeCallId)) {
        throw new Error("Pi worker dispatched a tool call its model did not make");
      }
      dispatched.add(nativeCallId);
      inflight++;
      try {
        const { text, isError } = await host.dispatch(call, working());
        undelivered.set(nativeCallId, { toolCallId: nativeCallId, toolName, text, isError });
        post({ dispatch: id, result: { text, isError } });
      } finally {
        inflight--;
      }
    }

    function receive(value: unknown) {
      if (halted.signal.aborted) return;
      const parsed = workerMessage.safeParse(value);
      if (!parsed.success || reply) return fail(new Error("Unexpected Pi worker message"));
      const message = parsed.data;
      if ("request" in message) serve(message.request, message.context as unknown as Context, message.options).catch(fail);
      else if ("cancel" in message) streams.get(message.cancel)?.abort();
      else if ("dispatch" in message) {
        const { dispatch: id, ...call } = message;
        dispatch(id, call).catch(fail);
      } else if ("delivered" in message) {
        const result = undelivered.get(message.delivered.nativeCallId);
        if (result?.toolName !== message.delivered.toolName) return fail(new Error("Unpaired Pi tool result"));
        undelivered.delete(result.toolCallId);
        delivered.push(result);
        inOrder(() => host.onToolDelivered?.(message.delivered));
      } else if ("result" in message && (inflight || undelivered.size)) fail(new Error("Pi worker finished before its tool results"));
      else reply = message;
    }

    if (channel) {
      channel.on("error", fail);
      readFrames(channel, receive, fail);
    }
    child.once("error", (error) => {
      if (child.pid === undefined) reject(error);
      else fail(error);
    });
    child.once("exit", () => {
      exited.abort();
      if (!profile.invocationGroup) stop();
      // Settle even if something still holds the channel open.
      const grace = setTimeout(() => { fail(new Error("Pi worker left its channel open")); channel?.destroy(); }, 5_000);
      grace.unref();
      child.once("close", () => clearTimeout(grace));
    });
    // close, not exit: it follows the last frame on the channel.
    child.once("close", async (code) => {
      signal.removeEventListener("abort", stop);
      try {
        await callbacks;
        signal.throwIfAborted();
        if (code === 126) throw new Error("The native launcher refused to start the Pi worker");
        if (halted.signal.aborted) throw failure ?? new Error("Pi worker failed");
        if (code !== 0 || !reply || !("result" in reply || "error" in reply)) throw new Error("Pi worker exited without a result");
        if ("error" in reply) throw new Error(reply.error);
        if (!observed.length) throw new Error("Pi worker answered without a model request");
        if (profile.prepare) (await hooks!).verify();
        resolve({ result: reply.result, directory, observed, streamed, delivered });
      } catch (error) {
        reject(error);
      }
    });
    signal.addEventListener("abort", stop, { once: true });
    post({ ...command, model });
    if (signal.aborted) stop();
  });
}

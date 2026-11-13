import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ProviderResponse } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { PiProfile } from "./pi.ts";

const source = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const launcher = join(source, ".proof/bin/member-launch");
const worker = fileURLToPath(new URL("./pi-worker.ts", import.meta.url));

/** The member launcher invocation of every Pi worker. Its private directory is its only writable state. */
export function piLaunch(directory: string, args: string[], invocationGroup?: number) {
  return {
    command: launcher,
    args: [String(process.pid), process.execPath, ...args],
    options: {
      cwd: directory, detached: !invocationGroup, stdio: ["ignore", "ignore", "ignore", "ipc"] as ("ignore" | "ipc")[],
      env: { HOME: directory, TMPDIR: directory, BIRBCREW_NATIVE_SOURCE: source },
    },
  };
}

/** Request options that may cross from the worker. Credentials, headers and callbacks stay on the host. */
export const forwardedOptions = z.strictObject({
  sessionId: z.string().max(256).optional(),
  reasoning: z.string().max(32).optional(),
  thinkingBudgets: z.record(z.string(), z.int().min(0)).optional(),
  transport: z.enum(["sse", "websocket", "websocket-cached", "auto"]).optional(),
  identity: z.json().optional(),
  timeoutMs: z.int().min(0).optional(),
  websocketConnectTimeoutMs: z.int().min(0).optional(),
  maxRetries: z.int().min(0).optional(),
  maxRetryDelayMs: z.int().min(0).optional(),
});
const text = z.string().max(65_536);
const id = z.int().min(1);
const toolCall = z.strictObject({ nativeCallId: z.string().min(1).max(256), toolName: z.string().min(1).max(64) });
const workerMessage = z.union([
  z.strictObject({ delta: text }),
  z.strictObject({ toolArgs: toolCall.shape.nativeCallId, matchedOperation: z.boolean() }),
  z.strictObject({ request: id, context: z.record(z.string(), z.unknown()), options: forwardedOptions }),
  z.strictObject({ cancel: id }),
  z.strictObject({ dispatch: id, ...toolCall.shape, args: z.unknown() }),
  z.strictObject({ delivered: toolCall }),
  z.strictObject({ result: z.unknown() }),
  z.strictObject({ error: z.string().max(1024) }),
]);

export type PiCommand =
  | { kind: "member"; mode: string; instructions?: string; allowRecordWorkItem?: boolean; input: Record<string, unknown> }
  | { kind: "trusted"; instructions?: string; input: Record<string, unknown> };

export interface PiHost {
  profile: PiProfile;
  signal: AbortSignal;
  /** A member segment ends after one model reply; a trusted turn adds one per registered tool call. */
  modelRequests: number;
  onText?: (delta: string) => void | Promise<void>;
  onToolArgs?: (nativeCallId: string, matchedOperation: boolean) => void;
  dispatch?: (call: { nativeCallId: string; toolName: string; args: unknown; signal: AbortSignal }) => Promise<{ text: string; isError: boolean }>;
  onToolDelivered?: (call: z.infer<typeof toolCall>) => void | Promise<void>;
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
 * Resolves with the worker's unvalidated result and the assistant messages this host observed.
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
  return new Promise<{ result: unknown; observed: AssistantMessage[] }>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, launch.options);
    const gone = new AbortController();
    const streams = new Map<number, AbortController>();
    const observed: AssistantMessage[] = [];
    let reply: z.infer<typeof workerMessage> | undefined, failure: unknown, requests = 0;
    let hooks: ReturnType<typeof providerHooks> | undefined;
    let callbacks = Promise.resolve();
    const stop = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(profile.invocationGroup ? child.pid : -child.pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) failure ??= error; }
    };
    const fail = (error: unknown) => { failure ??= error; stop(); };
    const later = (action: () => unknown) => { callbacks = callbacks.then(async () => { await action(); }).catch(fail); };
    const post = (message: object) => { if (child.connected) child.send(message, (error) => { if (error) fail(error); }); };

    async function serve(id: number, context: Context, options: z.infer<typeof forwardedOptions>) {
      if (streams.has(id) || ++requests > host.modelRequests) throw new Error("Pi worker exceeded its model requests");
      const controller = new AbortController();
      streams.set(id, controller);
      let settled = false;
      try {
        const extension = await (hooks ??= providerHooks(profile));
        const events = profile.modelRuntime.streamSimple(profile.model, context, {
          ...options as object, ...extension.options, signal: AbortSignal.any([signal, gone.signal, controller.signal]),
        });
        for await (const event of events) {
          if (event.type === "done") observed.push(event.message);
          if (event.type === "error") observed.push(event.error);
          settled = event.type === "done" || event.type === "error";
          post({ stream: id, event });
          if (settled) break;
        }
      } finally {
        streams.delete(id);
        if (!settled) post({ stream: id, event: failed(profile.model, controller.signal.aborted) });
      }
    }

    async function dispatch(id: number, call: { nativeCallId: string; toolName: string; args: unknown }) {
      if (!host.dispatch) throw new Error("Unexpected Pi tool dispatch");
      try {
        const { text, isError } = await host.dispatch({ ...call, signal: AbortSignal.any([signal, gone.signal]) });
        post({ dispatch: id, result: { text, isError } });
      } catch (error) {
        post({ dispatch: id, error: error instanceof Error ? error.message : "Trusted application tool failed" });
      }
    }

    child.on("message", (value) => {
      const parsed = workerMessage.safeParse(value);
      if (!parsed.success || reply) return fail(new Error("Unexpected Pi worker message"));
      const message = parsed.data;
      if ("delta" in message) later(() => host.onText?.(message.delta));
      else if ("toolArgs" in message) later(() => host.onToolArgs?.(message.toolArgs, message.matchedOperation));
      else if ("request" in message) serve(message.request, message.context as unknown as Context, message.options).catch(fail);
      else if ("cancel" in message) streams.get(message.cancel)?.abort();
      else if ("dispatch" in message) {
        const { dispatch: id, ...call } = message;
        dispatch(id, call).catch(fail);
      } else if ("delivered" in message) later(() => host.onToolDelivered?.(message.delivered));
      else reply = message;
    });
    child.once("error", (error) => {
      if (child.pid === undefined) reject(error);
      else fail(error);
    });
    // close, not exit: it follows the last IPC message.
    child.once("close", async (code) => {
      signal.removeEventListener("abort", stop);
      gone.abort();
      try {
        await callbacks;
        signal.throwIfAborted();
        if (failure) throw failure;
        if (code !== 0 || !reply || !("result" in reply || "error" in reply)) throw new Error("Pi worker exited without a result");
        if ("error" in reply) throw new Error(reply.error);
        if (profile.prepare) {
          if (!hooks) throw new Error("Pi turn did not reach its model");
          (await hooks).verify();
        }
        resolve({ result: reply.result, observed });
      } catch (error) {
        reject(error);
      }
    });
    signal.addEventListener("abort", stop, { once: true });
    post({ ...command, model });
    if (signal.aborted) stop();
  });
}

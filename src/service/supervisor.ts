import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { approvalSchema } from "./approvals.ts";
import { commitSchema, executionSchema, submitSchema } from "./domain.ts";

export const launchSchema = submitSchema.extend({ token: z.uuid(), execution: executionSchema });
export type Launch = z.infer<typeof launchSchema>;
export const commandSchema = z.strictObject({
  id: z.uuid(), action: z.enum(["start", "stop"]), launch: launchSchema,
});
const segmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("complete"), text: commitSchema.shape.reply }),
  z.strictObject({ kind: z.literal("pending"), approval: approvalSchema }),
]);
type Segment = z.infer<typeof segmentSchema>;
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: z.uuid(), ok: z.literal(true), reply: segmentSchema.nullable() }),
  z.strictObject({ id: z.uuid(), ok: z.literal(false), error: z.string() }),
]);

export async function startSupervisor(configPath: string, stateDir: string) {
  const child = fork(new URL("./supervisor-host.ts", import.meta.url), [configPath, stateDir], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [],
  });
  const pending = new Map<string, { resolve: (reply: Segment | null) => void; reject: (error: Error) => void }>();
  const exited = new Promise<void>((resolve) => child.once("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("SDK supervisor stopped"));
    pending.clear();
    resolve();
  }));
  const ready = once(child, "message");
  try {
    if (await Promise.race([ready.then(([message]) => message), exited]) !== "ready") {
      throw new Error("SDK supervisor startup failed");
    }
  } catch (error) {
    child.kill();
    throw error;
  }
  child.on("message", (message) => {
    const response = responseSchema.parse(message);
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.reply);
    else waiter.reject(new Error(response.error));
  });
  function request(action: "start" | "stop", launch: Launch): Promise<Segment | null> {
    if (!child.connected) return Promise.reject(new Error("SDK supervisor unavailable"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      child.send({ action, id, launch }, (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }
  return {
    exited,
    async start(launch: Launch, signal: AbortSignal) {
      const stop = () => { void request("stop", launch).catch(() => {}); };
      if (signal.aborted) {
        await request("stop", launch);
        signal.throwIfAborted();
      }
      signal.addEventListener("abort", stop, { once: true });
      try {
        const reply = await request("start", launch);
        if (!reply) throw new Error("Missing native segment result");
        return reply;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
    stop: (launch: Launch) => request("stop", launch),
    async close() {
      if (child.connected) child.disconnect();
      await exited;
    },
  };
}

export type Supervisor = Awaited<ReturnType<typeof startSupervisor>>;

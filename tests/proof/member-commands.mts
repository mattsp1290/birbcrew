import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Engine, Services } from "./member-services.mts";

export function commands({ env, signal }: Services) {
  async function command(operation: string, input: object, fail = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ["src/service/cli.ts", operation], { env, signal, timeout: 200_000 }, (error, stdout) => {
        if (fail && error && !error.killed && error.code === 1) return resolve(undefined);
        if (error || fail) return reject(new Error("Unexpected member command outcome: " + operation));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(JSON.stringify(input));
    });
  }
  async function create(engine: Engine, profile = "fixture.v1", ownerId: string = randomUUID()) {
    const request = { engine, profile, ownerId, requestId: randomUUID() };
    const member = await command("spawn", request);
    assert.deepEqual(await command("spawn", request), member);
    const { memberId } = z.object({ memberId: z.uuid() }).parse(member);
    async function open() {
      const key = { ownerId, conversationId: randomUUID() };
      await command("open", { ...key, memberId });
      return key;
    }
    return { memberId, open };
  }
  return { command, create };
}
export const pendingSchema = z.array(z.looseObject({
  ownerId: z.string(), memberId: z.uuid(), conversationId: z.uuid(), requestId: z.uuid(), invocationId: z.uuid(),
  nativeCallId: z.string(), approvalId: z.uuid(), argumentDigest: z.string(), version: z.int(), toolName: z.string(),
}));
export const decision = (p: z.infer<typeof pendingSchema>[number], choice: string) => ({
  ownerId: p.ownerId, memberId: p.memberId, conversationId: p.conversationId, requestId: p.requestId,
  invocationId: p.invocationId, nativeCallId: p.nativeCallId, approvalId: p.approvalId,
  argumentDigest: p.argumentDigest, version: p.version, choice,
});

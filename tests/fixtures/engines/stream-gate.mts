import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function streamGate(prompt: string | undefined) {
  const dir = process.env.BIRBCREW_PROOF_STREAM_DIR;
  const match = /^stream ([0-9a-f-]{36})$/.exec(prompt ?? "");
  return dir && match ? join(dir, match[1]) : undefined;
}

export async function waitForGate(path: string) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try { await access(path); return; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(25);
  }
  throw new Error("Provider stream gate was never released");
}

export function holdResumedReceipt(prompt: string | undefined) {
  const path = streamGate(prompt?.replace(/^record /, "stream "));
  return !!path && existsSync(path + ".hold-receipt");
}

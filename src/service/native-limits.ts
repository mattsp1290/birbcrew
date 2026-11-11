import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
/** Finite native state budgets, independent of Temporal history rollover. */
export const nativeTranscriptBytes = 32 * 1024 * 1024;
export const nativeCheckpointBytes = 4 * 1024 * 1024;

export function assertNativeJsonBudget(value: unknown, bytes: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw new Error(`${label} exceeds native context budget`);
}

/** Check raw bytes before SDK transcript parsing; never follow filesystem links. */
export async function assertTranscriptFileBudget(root: string, sessionId: string): Promise<void> {
  let entries = 0, found = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 4096) throw new Error("Native transcript tree exceeds entry budget");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === `${sessionId}.jsonl`) throw new Error("Native transcript is a link");
        continue;
      }
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === `${sessionId}.jsonl`) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.nlink !== 1 || await realpath(path) !== path ||
            stat.size > nativeTranscriptBytes) throw new Error("Native transcript exceeds context budget or is invalid");
        found++;
      }
    }
  }
  await visit(root);
  if (found !== 1) throw new Error("Expected exactly one original native transcript");
}

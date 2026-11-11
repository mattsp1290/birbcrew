import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, truncate, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNativeJsonBudget, assertTranscriptFileBudget, nativeTranscriptBytes } from "../../src/service/native-limits.ts";

test("native state budgets reject oversized JSON and raw transcripts before parsing", async t => {
  assert.throws(() => assertNativeJsonBudget({ text: "abcdef" }, 3, "fixture"), /budget/);
  const root = await mkdtemp(join(tmpdir(), "native-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  const file = join(root, "project", "session.jsonl");
  await writeFile(file, "{}\n");
  await assertTranscriptFileBudget(root, "session");
  await truncate(file, nativeTranscriptBytes + 1);
  await assert.rejects(assertTranscriptFileBudget(root, "session"), /budget/);
  await rm(file);
  await symlink("/dev/null", file);
  await assert.rejects(assertTranscriptFileBudget(root, "session"), /link/);
});

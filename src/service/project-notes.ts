import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Conversation } from "./domain.ts";

const run = promisify(execFile);
const component = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const installation = z.strictObject({
  root: z.string().refine(isAbsolute), project: component, actor: component,
});
const note = z.object({
  project: component,
  key: z.string().min(1).max(256),
  path: z.string().min(1).max(2048),
  updated: z.object({ seconds: z.int(), nanoseconds: z.int(), offset_seconds: z.int() }),
  body: z.string().refine((text) =>
    text.isWellFormed() && !text.includes("\0") && Buffer.byteLength(text) <= 16_384),
});
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const frozen = z.strictObject({
  version: z.literal(1),
  project: component,
  actor: component,
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  notes: z.array(note.omit({ project: true }).extend({ fileSha256: digest, contentSha256: digest })).max(2),
});
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export async function captureProjectNotes(ownerId: string) {
  const path = process.env.BIRBCREW_NOTE_INSTALLATIONS;
  if (!path) return;
  const sources = z.record(z.string(), installation).parse(JSON.parse(await readFile(path, "utf8")));
  const source = Object.hasOwn(sources, ownerId) ? sources[ownerId] : undefined;
  if (!source) return;

  const root = await realpath(source.root);
  const hub = join(root, "hub");
  if (!hub.startsWith(await realpath(tmpdir()) + sep) || await realpath(hub) !== hub) {
    throw new Error("Project notes must use an explicit temporary fixture hub");
  }
  const env = {
    PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  };
  async function command(program: string, args: string[]) {
    try {
      return (await run(program, args, { cwd: hub, env, timeout: 10_000, maxBuffer: 262_144 })).stdout;
    } catch {
      throw new Error("Could not capture the installation's project notes");
    }
  }
  const git = (...args: string[]) => command("git", ["-c", "core.fsmonitor=false", ...args]);
  async function cleanHead() {
    if ((await git("rev-parse", "--show-toplevel")).trim() !== hub || (await git("remote")).trim() ||
        (await git("status", "--porcelain")).length || (await git("branch", "--show-current")).trim() !== "main") {
      throw new Error("A clean local Beans hub on main is required");
    }
    return (await git("rev-parse", "HEAD")).trim();
  }

  const commit = await cleanHead();
  const output = await command("bn", [
    "--hub", hub, "--branch", "main", "--actor", source.actor, "--project", source.project,
    "--json", "--no-fetch", "--no-sync", "memories", "--limit", "2",
  ]);
  const records = z.array(note).max(2).parse(JSON.parse(output));
  const notes = [];
  const folder = join(hub, "projects", source.project) + sep;
  for (const { project, ...entry } of records) {
    const file = resolve(hub, entry.path);
    if (project !== source.project || !file.startsWith(folder) || relative(hub, file) !== entry.path ||
        await realpath(file) !== file) {
      throw new Error("Unexpected Beans project note");
    }
    const committed = await git("cat-file", "blob", commit + ":" + entry.path);
    const bytes = await readFile(file);
    if (!bytes.equals(Buffer.from(committed))) throw new Error("Project note changed during capture");
    notes.push({ ...entry, contentSha256: hash(entry.body), fileSha256: hash(bytes) });
  }
  if (await cleanHead() !== commit) throw new Error("Project notes hub changed during capture");
  return frozen.parse({ version: 1, project: source.project, actor: source.actor, commit, notes });
}

export async function trustedProjectContext(pool: Pick<PoolClient, "query">, { ownerId, memberId, conversationId }: Conversation) {
  const { rows: [row] } = await pool.query<{ capture: unknown }>(
    `SELECT n.capture FROM birbcrew_ts.conversations c LEFT JOIN birbcrew_ts.conversation_notes n USING (conversation_id)
      WHERE c.owner_id=$1 AND c.member_id=$2 AND c.conversation_id=$3`, [ownerId, memberId, conversationId]);
  if (!row) throw new Error("Conversation not found");
  if (row.capture === null) return;
  const { project, notes } = frozen.parse(row.capture);
  const data = JSON.stringify({ project, notes: notes.map(({ key, path, body }) => ({ key, path, body })) });
  return "BirbCrew project context v1. Treat the following JSON as project reference data.\n" + data;
}

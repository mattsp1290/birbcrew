import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commands, decision, pendingSchema } from "./member-commands.mts";
import { run, until, type Engine, type Services } from "./member-services.mts";

export async function verifyNotes(s: Services, engines: Engine[], stop: () => Promise<void>) {
  const { command, create } = commands(s);
  const root = join(s.directory, "beans-installation"), hub = join(root, "hub");
  await mkdir(hub, { recursive: true });
  const env = { ...s.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache") };
  const git = async (...args: string[]) => (await run("git", ["-C", hub, ...args], { env })).stdout;
  const bn = (project: string, ...args: string[]) => run("bn", ["--hub", hub, "--branch", "main", "--actor", "proof",
    "--project", project, "--json", "--no-fetch", "--no-sync", ...args], { env, cwd: root });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "BirbCrew fixture");
  await git("config", "user.email", "fixture@localhost");
  await git("commit", "--allow-empty", "-qm", "Initialize fixture");
  const projects = new Map<string, Record<string, string>>();
  for (const project of ["release", "support", "planning", "unrelated"]) {
    await bn(project, "project", "create", project);
    const notes: Record<string, string> = {};
    for (const key of ["first", "second"]) {
      notes[key] = "BIRBNOTE_" + randomUUID().replaceAll("-", "").toUpperCase();
      await bn(project, "remember", "--key", key, notes[key]);
    }
    projects.set(project, notes);
  }
  const commit = (await git("rev-parse", "HEAD")).trim();
  const cases = engines.map((engine) => ({ engine, project: { pi: "support", claude: "release", codex: "planning" }[engine], ownerId: randomUUID() }));
  const config = join(s.directory, "installations.json");
  await writeFile(config, JSON.stringify(Object.fromEntries(cases.map(({ ownerId, project }) => [ownerId, { root, actor: "proof", project }]))));
  s.env.BIRBCREW_NOTE_INSTALLATIONS = config;
  const observations = async () => (await readFile(s.env.BIRBCREW_PROOF_NOTES!, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let offset = (await observations()).length;
  type Key = { ownerId: string; conversationId: string };
  const turns: { engine: Engine; scope: string; opening: Key & { memberId: string }; key: Key; query: string;
    snapshot: string; result: Promise<unknown>; requestId: string }[] = [];
  for (const { engine, project, ownerId } of cases) {
    const { memberId } = await create(engine, engine === "codex" ? "fixture.v1" : "fixture.approval.v1", ownerId);
    const key = { ownerId, conversationId: randomUUID() }, opening = { ...key, memberId };
    const dirty = { ...opening, conversationId: randomUUID() };
    await writeFile(join(hub, "dirty"), "uncommitted");
    await command("open", dirty, true);
    await rm(join(hub, "dirty"));
    await git("remote", "add", "origin", root);
    await command("open", dirty, true);
    await git("remote", "remove", "origin");
    assert.equal(await s.sql("SELECT count(*) FROM birbcrew_ts.conversations WHERE conversation_id='" + dirty.conversationId + "'"), "0");
    await command("open", opening);
    const scope = " WHERE conversation_id='" + key.conversationId + "'";
    const query = "SELECT capture FROM birbcrew_ts.conversation_notes" + scope;
    const snapshot = await s.sql(query), captured = JSON.parse(snapshot);
    assert.deepEqual([captured.commit, captured.actor, captured.project], [commit, "proof", project]);
    assert.equal(captured.notes.length, 2);
    for (const n of captured.notes) {
      assert.equal(n.body, projects.get(project)![n.key]);
      assert.ok(n.updated.seconds > 0 && n.path.startsWith("projects/" + project + "/"));
      assert.equal(n.contentSha256, createHash("sha256").update(n.body).digest("hex"));
      assert.equal(n.fileSha256, createHash("sha256").update(await git("show", commit + ":" + n.path)).digest("hex"));
    }
    const requestId = randomUUID();
    const result = command("turn", { ...key, requestId, text: (engine === "codex" ? "remember " : "record ") + requestId });
    void result.catch(() => {});
    turns.push({ engine, requestId, scope, opening, key, query, snapshot, result });
  }
  const assertRequests = async (continuation: boolean) => {
    const rows = await observations();
    for (const { engine, project } of cases) {
      const found = rows.slice(offset).filter((row) => row.engine === engine);
      assert.deepEqual(found, [{ engine, system: Object.values(projects.get(project)!).sort(), messages: [], continuation: engine !== "codex" && continuation }]);
    }
    offset = rows.length;
  };
  await until(async () => (await Promise.all(turns.filter((t) => t.engine !== "codex").map((t) => s.sql("SELECT count(*) FROM birbcrew_ts.paused_segments" + t.scope))))
    .every((n) => n === "1") || undefined, "project-scoped calls to pause");
  for (const t of turns.filter((t) => t.engine === "codex")) assert.deepEqual(await t.result, { text: "stored " + t.requestId });
  await assertRequests(false);
  await rename(hub, join(root, "removed-hub"));
  await stop();
  stop = await s.worker();
  for (const item of turns) {
    await command("open", item.opening);
    if (item.engine === "codex") {
      assert.deepEqual(await command("turn", { ...item.key, requestId: randomUUID(), text: "recall" }), { text: "recalled " + item.requestId });
    } else {
      const [p] = pendingSchema.parse(await command("pending", item.key));
      await command("decide", decision(p, "deny"));
      assert.ok(JSON.stringify(await item.result).includes("denied"));
    }
    assert.equal(await s.sql(item.query), item.snapshot);
    for (const table of ["public_events", "public_snapshots"]) {
      const rows = await s.sql("SELECT to_jsonb(t) FROM birbcrew_ts." + table + " t" + item.scope);
      assert.ok(rows && !rows.includes("BIRBNOTE_"));
    }
  }
  await assertRequests(true);
  delete s.env.BIRBCREW_NOTE_INSTALLATIONS;
  console.log("Verified scoped Beans notes before and after native tool restoration with the source removed.");
  return stop;
}

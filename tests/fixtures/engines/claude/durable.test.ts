import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runClaudeTurn } from "../../../../src/service/claude.ts";
import { startClaudeFixtureProvider } from "./index.mts";

test("Claude reopens the original transcript and fails closed if its files disappear", { timeout: 30_000 }, async (t) => {
  const observed: { prompt?: string; tools: string[] }[] = [];
  const provider = await startClaudeFixtureProvider(undefined, (request) => observed.push(request));
  t.after(() => provider.close());
  const stateDir = await mkdtemp(join(tmpdir(), "birb-claude-restart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const profile = {
    stateDir, ownerId: "owner", memberId: randomUUID(), model: "claude-sonnet-4-6",
    apiKey: "synthetic", baseUrl: provider.url,
  };
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "remember cedar", signal: t.signal };
  const first = await runClaudeTurn({ ...input, checkpoint: null }, profile);
  assert.equal(first.text, "stored cedar");
  const next = { ...input, runId: randomUUID(), text: "recall", checkpoint: first.checkpoint };
  const resumed = await runClaudeTurn(next, profile);
  assert.equal(resumed.text, "recalled cedar");
  assert.equal(resumed.checkpoint.state.binding.sessionId, first.checkpoint.state.binding.sessionId);
  assert.deepEqual(observed, [{ prompt: input.text, tools: [] }, { prompt: "recall", tools: [] }]);

  const files = await readdir(stateDir, { recursive: true });
  const transcripts = files.filter((file) => file.endsWith(`${first.checkpoint.state.binding.sessionId}.jsonl`));
  assert.equal(transcripts.length, 1);
  await unlink(join(stateDir, transcripts[0]!));
  await assert.rejects(runClaudeTurn({ ...next, runId: randomUUID(), checkpoint: resumed.checkpoint }, profile), /recovery failed/);
  assert.equal(observed.length, 2);
});


test("the native CLI cannot read a sibling owner's file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "birb-claude-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "conversation");
  await mkdir(cwd);
  const sibling = join(root, "other-owner.txt");
  await writeFile(sibling, "private fixture sentinel");
  const launcher = fileURLToPath(new URL("../../../../.proof/bin/member-launch", import.meta.url));
  const cli = fileURLToPath(new URL(
    `../../../../node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`, import.meta.url,
  ));
  await assert.rejects(promisify(execFile)(launcher, [
    String(process.pid), cli, "--bare", "-p", "probe", "--system-prompt-file", sibling,
  ], { cwd, timeout: 10_000, env: { HOME: cwd, CLAUDE_CONFIG_DIR: cwd, TMPDIR: cwd, ANTHROPIC_API_KEY: "synthetic" } }),
  (error: Error & { stderr?: string }) => {
    assert.ok(error.stderr?.includes("EACCES") && error.stderr.includes(sibling), error.stderr);
    return true;
  });
});

async function onlyChild(pid: number) {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/);
  assert.equal(children.length, 1);
  const id = Number(children[0]);
  assert.ok(id > 1);
  return id;
}

async function stopped(pid: number) {
  try {
    return /\) [ZX] /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return true;
    throw error;
  }
}

test("host loss stops the adapter and its active CLI", { timeout: 20_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-claude-death-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const requests = new EventEmitter();
  const waiting = once(requests, "wait");
  const provider = await startClaudeFixtureProvider(undefined, ({ prompt }) => {
    if (prompt === "wait") requests.emit("wait");
  });
  t.after(() => provider.close());
  const module = new URL("../../../../src/service/claude.ts", import.meta.url).href;
  const host = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runClaudeTurn } from ${JSON.stringify(module)};
    const [stateDir, baseUrl] = process.argv.slice(1);
    await runClaudeTurn({
      threadId: crypto.randomUUID(), runId: crypto.randomUUID(), checkpoint: null, text: "wait",
      signal: AbortSignal.timeout(15_000),
    }, { stateDir, ownerId: "owner", memberId: crypto.randomUUID(), model: "claude-sonnet-4-6", apiKey: "synthetic", baseUrl });
  `, stateDir, provider.url], { stdio: "ignore" });
  const exited = once(host, "exit");
  t.after(() => { host.kill("SIGKILL"); });
  await Promise.race([waiting, exited.then(() => { throw new Error("Turn exited before waiting"); })]);
  assert.ok(host.pid);
  const adapter = await onlyChild(host.pid);
  const cli = await onlyChild(adapter);
  host.kill("SIGKILL");
  await exited;
  for (let tries = 0; tries < 100; tries++) {
    if ((await stopped(cli)) && (await stopped(adapter))) return;
    await delay(20);
  }
  assert.fail("Orphaned Claude process survived host exit");
});

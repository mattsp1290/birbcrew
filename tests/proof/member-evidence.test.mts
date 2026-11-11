import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evidenceOutputs, fixtureReport } from "./member-report.mts";

test("release evidence stays outside the source and keeps fixture and replay reports distinct", async t => {
  const directory = await mkdtemp(join(tmpdir(), "birb-evidence-paths-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(process.cwd(), join(directory, "checkout"));
  await symlink(directory, join(directory, "alias"));
  const fixture = join(directory, "fixture.json");
  await assert.rejects(evidenceOutputs({BIRBCREW_REPLAY_EVIDENCE:join(directory, "checkout", "package.json")}), /outside/);
  await assert.rejects(evidenceOutputs({BIRBCREW_FIXTURE_EVIDENCE:fixture,
    BIRBCREW_REPLAY_EVIDENCE:join(directory, "alias", "fixture.json")}), /distinct/);
  assert.deepEqual(await evidenceOutputs({BIRBCREW_FIXTURE_EVIDENCE:fixture}), {fixture, replay:undefined});
});

test("published fixture evidence excludes ambient account credentials", async t => {
  const directory = await mkdtemp(join(tmpdir(), "birb-evidence-private-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const previous = process.env.OPENAI_API_KEY;
  const marker = "sk-proj-" + randomUUID().replaceAll("-", "");
  process.env.OPENAI_API_KEY = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const {fixture} = await evidenceOutputs({BIRBCREW_FIXTURE_EVIDENCE:join(directory, "fixture.json")});
  const report = await fixtureReport(["codex"], fixture);
  await report.finish(false);
  const published = await readFile(fixture!, "utf8");
  assert.equal(JSON.parse(published).status, "NOT VERIFIED");
  assert.ok(!published.includes(marker));
  assert.ok(!published.includes("OPENAI_API_KEY"));
});

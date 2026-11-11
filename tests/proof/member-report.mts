import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run, type Engine } from "./member-services.mts";

const roots = ["src/service", "native", "scripts", "tests/service", "tests/proof", "tests/fixtures/engines",
  "packages", "vendor/ag-ui", "clients"];
const files = [".gitattributes", "package.json", "package-lock.json", ".node-version", "tsconfig.json"];
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const revision = z.string().regex(/^[a-f0-9]{40}$/);
// git archive substitutes the commit hash; unpacked archives need no .git directory.
const archiveStamp = "$Format:%H:%T$";
async function archiveTreeMatches(expected: string) {
  const dir = await mkdtemp(join(tmpdir(), "birb-proof-tree-"));
  const gitDir = join(dir, "index.git");
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => run("git", ["--git-dir", gitDir, "--work-tree", process.cwd(), ...args], { env });
  try {
    await run("git", ["init", "-q", "--bare", gitDir], { env });
    await git("add", "--all", "--", ".");
    const report = "tests/proof/member-report.mts";
    const original = (await readFile(report, "utf8")).replace(archiveStamp, "$" + "Format:%H:%T$");
    const object = join(dir, "unexpanded-report");
    await writeFile(object, original);
    const { stdout } = await git("hash-object", "-w", object);
    await git("update-index", "--cacheinfo", "100644," + stdout.trim() + "," + report);
    return (await git("write-tree")).stdout.trim() === expected;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function sourceFingerprint() {
  const input: string[] = [...files];
  async function collect(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "__pycache__", ".git", "dist", ".proof"].includes(item.name)) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) await collect(path);
      else if (item.isFile()) input.push(path);
    }
  }
  for (const root of roots) await collect(root);
  const manifest = [];
  for (const path of input.sort()) {
    const bytes = await readFile(path);
    const normalized = path === "tests/proof/member-report.mts" && /^[a-f0-9]{40}:[a-f0-9]{40}$/.test(archiveStamp)
      ? bytes.toString("utf8").replace(archiveStamp, "$" + "Format:%H:%T$") : bytes;
    manifest.push({ path, sha256: hash(normalized) });
  }
  const sourceSha256 = hash(JSON.stringify(manifest));
  let gitRevision: string | undefined;
  try {
    if ((await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim() === process.cwd()) {
      gitRevision = revision.parse((await run("git", ["rev-parse", "HEAD"])).stdout.trim());
    }
  }
  catch { /* A source archive can be run without a Git checkout. */ }
  const external = process.env.BIRBCREW_SOURCE_REVISION;
  if (external) revision.parse(external);
  const archive = /^([0-9a-f]{40}):([0-9a-f]{40})$/.exec(archiveStamp);
  if (gitRevision) {
    const status = (await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...roots, ...files])).stdout.trim();
    if (external && external !== gitRevision) throw new Error("Supplied source revision differs from the checkout");
    return { revision: gitRevision, state: status ? "modified" : "clean", sourceSha256, manifest };
  }
  if (archive) {
    if (external && archive[1] !== external) throw new Error("Supplied source revision differs from archive");
    return { revision: archive[1], state: await archiveTreeMatches(archive[2]) ? "git-archive" : "modified", sourceSha256, manifest };
  }
  const attested = external && process.env.BIRBCREW_SOURCE_SHA256 === sourceSha256;
  return { revision: external ?? null, state: attested ? "external-attestation" : "unattributed", sourceSha256, manifest };
}

export function attributable(source: Awaited<ReturnType<typeof sourceFingerprint>>) {
  return source.revision !== null && !["modified", "unattributed"].includes(source.state);
}

export async function fixtureReport(engines: Engine[]) {
  const initial = await sourceFingerprint();
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const native = ["@temporalio/worker",
    ...(engines.includes("codex") ? ["@openai/codex-sdk", "@openai/codex", "@openai/codex-linux-" + process.arch] : []),
    ...(engines.includes("claude") ? ["@ag-ui/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-linux-" + process.arch] : []),
    ...(engines.includes("pi") ? ["@ag-ui/pi", "@earendil-works/pi-coding-agent", "@birbcrew/pi-subagents"] : [])];
  const packages = native.map((name) => {
    const { version, integrity } = z.object({ version: z.string(), integrity: z.string().startsWith("sha512-") })
      .parse(lock.packages["node_modules/" + name]);
    return { name, version, integrity };
  });
  const stages: { name: string; status: "VERIFIED" }[] = [];
  return {
    pass(name: string) { stages.push({ name, status: "VERIFIED" }); },
    async finish(passed: boolean) {
      const final = await sourceFingerprint();
      const reproducible = JSON.stringify(final) === JSON.stringify(initial) && attributable(final);
      const { manifest, ...sourceInfo } = final;
      const report = { mode: "fixture", engines, status: !passed ? "NOT VERIFIED" : reproducible ? "VERIFIED" : "INCONCLUSIVE",
        processExit: passed && (reproducible || !process.env.BIRBCREW_FIXTURE_EVIDENCE) ? 0 : 1, source: sourceInfo, stableDuringRun: initial.sourceSha256 === final.sourceSha256,
        node: process.version, architecture: process.arch, temporalCli: "1.10.0", packages,
        nativeLauncherSha256: hash(await readFile(".proof/bin/member-launch")), stages };
      const path = process.env.BIRBCREW_FIXTURE_EVIDENCE;
      if (path) {
        const tmp = path + "." + randomUUID() + ".tmp";
        try {
          await writeFile(tmp, JSON.stringify({ ...report, ...(reproducible && { sourceManifest: manifest }) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(tmp, path);
        } finally { await rm(tmp, { force: true }); }
      }
      console.log(JSON.stringify(report));
      if (passed && path && !reproducible) throw new Error("A release evidence file requires stable, attributable source");
    },
  };
}

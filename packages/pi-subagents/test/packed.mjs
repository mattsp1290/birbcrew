import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), "birbcrew-packed-pi-"));
const archive = "birbcrew-pi-subagents-0.1.0.tgz";
try {
  execFileSync("npm", ["pack", "--pack-destination", consumer], { cwd: pkg, stdio: "inherit" });
  assert.deepEqual(await readFile(join(consumer, archive)), await readFile(join(pkg, archive)),
    "Repack the committed archive after changing its contents");
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true, type: "module", dependencies: {
      "@birbcrew/pi-subagents": "file:./" + archive,
      "@earendil-works/pi-ai": "1.5.2", "@earendil-works/pi-coding-agent": "1.5.2",
    },
  }));
  execFileSync("npm", ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer, stdio: "inherit",
  });
  await copyFile(join(pkg, "test/session.test.mjs"), join(consumer, "session.test.mjs"));
  const home = join(consumer, "home");
  await mkdir(home);
  execFileSync(process.execPath, ["--test", "session.test.mjs"], {
    cwd: consumer, stdio: "inherit", env: { PATH: process.env.PATH, HOME: home },
  });
} finally {
  await rm(consumer, { recursive: true, force: true });
}

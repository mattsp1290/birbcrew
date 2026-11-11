import assert from "node:assert/strict";
import { test } from "node:test";
import { commandCredentialResolver } from "../../src/service/proxy-credential.ts";

test("fixed helper returns fresh private credentials without a shell", async () => {
  const resolve = commandCredentialResolver({ executable: process.execPath,
    args: ["-e", 'console.log(JSON.stringify({headers:{authorization:"Bearer synthetic"},expiresAt:Date.now()+60000}))'] });
  const result = await resolve(new AbortController().signal);
  assert.equal(result.headers.authorization, "Bearer synthetic");
  assert.ok(result.expiresAt > Date.now());
});

test("helper errors and unexpected output never surface secret output or arguments", async () => {
  for (const script of [
    'console.error("secret-stderr"); console.log("secret-stdout");process.exit(1)',
    'console.log("secret-invalid-json")',
    'console.log(JSON.stringify({headers:{authorization:"secret-expired"},expiresAt:0}))',
    'setTimeout(()=>{},60000)',
  ]) {
    const resolve = commandCredentialResolver({ executable: process.execPath, args: ["-e", script], timeoutMs: 100 });
    await assert.rejects(resolve(new AbortController().signal), /^Error: Proxy credential resolution failed$/);
  }
  assert.throws(() => commandCredentialResolver({ executable: "shell" }), /configuration/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(commandCredentialResolver({ executable: process.execPath })(controller.signal), /cancelled/);
});

for (const mode of ["timeout", "abort", "stdout", "stderr"] as const) {
  test(`helper ${mode} failure kills and reaps a process that ignores SIGTERM`, { timeout: 5000 }, async t => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "birb-credential-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "pid");
    const script = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync(process.argv[1], String(process.pid));
      ${mode === "stdout" || mode === "stderr" ? `process.${mode}.write("synthetic-private-canary".repeat(2000));` : ""}
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const began = performance.now();
    const outcome = commandCredentialResolver({ executable: process.execPath,
      args: ["-e", script, pidFile], timeoutMs: mode === "timeout" ? 500 : 2000 })(controller.signal);
    // Attach rejection handling immediately; output-overflow may happen before PID polling.
    const checked = assert.rejects(outcome, /^Error: Proxy credential resolution failed$/);
    let pid: number | undefined;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(pid, "helper started and recorded its PID");
    // Emergency cleanup is test-owned only, and should never find a live helper.
    t.after(() => { try { process.kill(pid!, "SIGKILL"); } catch {} });
    if (mode === "abort") controller.abort();
    await checked;
    assert.ok(performance.now() - began < (mode === "timeout" ? 1500 : 2000), "failure completed within bounded teardown window");
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "helper is reaped before the resolver rejects");
  });
}

test("cancellation terminates group-local helper descendants without signalling other processes", { timeout: 5000 }, async t => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "birb-credential-group-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pids");
  const script = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:"ignore"});
    fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, descendant.pid]));
    setInterval(()=>{},1000);
  `;
  const controller = new AbortController();
  const checked = assert.rejects(commandCredentialResolver({ executable: process.execPath,
    args: ["-e", script, pidFile], timeoutMs: 2000 })(controller.signal), /^Error: Proxy credential resolution failed$/);
  let pids: number[] = [];
  for (let i = 0; i < 100; i++) {
    try { pids = JSON.parse(await readFile(pidFile, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(pids.length, 2);
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  controller.abort();
  await checked;
  assert.throws(() => process.kill(pids[0], 0), { code: "ESRCH" });
  // The direct child is reaped by Node. An orphaned descendant is reaped by the
  // OS/subreaper; a zombie is already terminated and cannot retain credentials.
  let live = true;
  for (let i = 0; i < 100 && live; i++) {
    try { live = !/^State:\s+Z/m.test(await readFile(`/proc/${pids[1]}/status`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") live = false; else throw error; }
    if (live) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(live, false, "helper's group-local descendant has terminated");
  process.kill(process.pid, 0); // the test runner's unrelated process group is intact
});

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

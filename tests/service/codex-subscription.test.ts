import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readCodexSubscription } from "../../src/service/codex-subscription.ts";

async function isolatedLogin(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "birb-test-subscription-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, auth: join(home, "auth.json") };
}

function chatgpt(accountId: string, revision = "first") {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function token(kind: string) {
    const payload = {
      exp: Math.floor(Date.now() / 1000) + 3600, email: "offline@example.invalid", kind, revision,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
    };
    return [encode({ alg: "none", typ: "JWT" }), encode(payload), "eA"].join(".");
  }
  return {
    auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { account_id: accountId, id_token: token("id"), access_token: token("access"), refresh_token: "synthetic-refresh" },
  };
}

test("subscription reads follow the CLI login, return only access credentials, and pin the workspace across changes", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  const accountId = "807c7885-5f13-4c72-aac4-c6cc3d240aba";
  for (const revision of ["first", "renewed"]) {
    const login = chatgpt(accountId, revision);
    await writeFile(auth, JSON.stringify(login), { mode: 0o600 });
    const [subscription] = await Promise.all([
      readCodexSubscription(home, accountId),
      assert.rejects(readCodexSubscription(home, "another-workspace"), { message: /current ChatGPT Codex sign-in/ }),
    ]);
    assert.deepEqual(subscription, { accessToken: login.tokens.access_token, accountId });
    assert.deepEqual(JSON.parse(await readFile(auth, "utf8")), login);
  }
  await writeFile(auth, JSON.stringify(chatgpt("5ed40c50-f1bb-4dbd-8702-afc6af3b81c2")));
  await assert.rejects(readCodexSubscription(home, accountId), { message: /current ChatGPT Codex sign-in/ });
});

test("a Codex API key cannot satisfy a subscription login", async (t) => {
  const { home, auth } = await isolatedLogin(t);
  await writeFile(auth, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-private-api-key" }), { mode: 0o600 });
  await assert.rejects(readCodexSubscription(home), { message: /^A current ChatGPT Codex sign-in for the approved account is required$/ });
});

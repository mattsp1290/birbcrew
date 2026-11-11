import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { service, startWorker, until } from "./observer-host.ts";

test("one Codex member resumes two separate native conversations after a cold worker replacement", { timeout: 120_000 }, async (t) => {
  const host = await service(t);
  const profile = "codex-chat-" + randomUUID();
  const stop = startWorker(t, profile, "codex");
  await until(async () => (await host.db.query("SELECT 1 FROM birbcrew_ts.profiles WHERE name=$1 AND engine='codex'", [profile])).rows[0]);
  const spawn = { requestId: randomUUID(), engine: "codex", profile };
  const member = await host.post("/members", spawn);
  assert.deepEqual(await host.post("/members", spawn), member);
  const chats = await Promise.all([0, 1].map(async () => {
    const cid = randomUUID(), nonce = randomUUID(), path = "/conversations/" + cid;
    const opened = await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    assert.equal(opened.state.engine, "codex");
    assert.equal(opened.state.profile, profile);
    const reader = host.attach(cid);
    const input = { requestId: randomUUID(), text: "remember " + nonce };
    await host.post(path + "/inputs", input);
    await until(async () => reader.agent.state?.phase === "idle" && reader.agent.messages.at(-1)?.content === "stored " + nonce || undefined);
    return { cid, path, nonce, input, reader };
  }));
  await stop();
  startWorker(t, profile, "codex");
  await Promise.all(chats.map(async ({ cid, path, nonce, input, reader }) => {
    const reconnect = host.attach(cid);
    await host.post(path + "/inputs", input);
    await host.post(path + "/inputs", { requestId: randomUUID(), text: "recall" });
    for (const observer of [reader, reconnect]) {
      await until(async () => observer.agent.state?.phase === "idle" && observer.agent.messages.at(-1)?.content === "recalled " + nonce || undefined);
      assert.deepEqual(observer.agent.messages.map(({ role, content }) => [role, content]), [
        ["user", "remember " + nonce], ["assistant", "stored " + nonce], ["user", "recall"], ["assistant", "recalled " + nonce],
      ]);
    }
    assert.deepEqual(reader.agent.messages, reconnect.agent.messages);
    assert.equal((await host.api(path, undefined, host.stranger)).status, 404);
    const { rows } = await host.db.query(`SELECT checkpoint->>'engine' AS engine, phase
      FROM birbcrew_ts.turns WHERE conversation_id=$1 ORDER BY position`, [cid]);
    assert.deepEqual(rows, Array(2).fill({ engine: "codex", phase: "committed" }));
  }));
});

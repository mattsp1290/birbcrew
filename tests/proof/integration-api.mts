import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HttpAgent } from "@ag-ui/client";
import { commands, pendingSchema } from "./member-commands.mts";
import { services, until, type Engine } from "./member-services.mts";
import { startRestartFixtures } from "./proxy-restart-fixtures.mts";

// Public HTTP boundary + real Temporal/SQL/native worker fixtures. No live inference.
assert.equal(process.version, "v22.23.3");
const s = await services();
const ownerId = randomUUID(), token = randomUUID(), stranger = randomUUID();
const config = join(s.directory, "gateway.json");
await writeFile(config, JSON.stringify({ port: 0, tokenHashes: {
  [createHash("sha256").update(token).digest("hex")]: ownerId,
  [createHash("sha256").update(stranger).digest("hex")]: randomUUID(),
} }), { mode: 0o600 });
let endpoint = "";
let stopGateway: (() => Promise<void>) | undefined;
async function gateway() {
  const child = spawn(process.execPath, ["src/service/gateway.ts", config], { env: s.env, stdio: ["ignore", "pipe", "inherit"] });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const url = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line).url as string),
    exit.then(() => { throw new Error("Gateway exited before listening"); }),
  ]).finally(() => lines.close());
  endpoint = url;
  stopGateway = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  };
}
async function request(path: string, body?: unknown, auth = token) {
  return fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + auth, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function post(path: string, body: unknown, expected = 202) {
  const response = await request(path, body);
  assert.equal(response.status, expected, `${path}: ${response.status}`);
  return response.json();
}
function observe(conversationId: string) {
  const agent = new HttpAgent({ url: `${endpoint}/v1/conversations/${conversationId}/events`, threadId: conversationId,
    headers: { Authorization: "Bearer " + token } });
  const seen: string[] = [];
  const done = agent.runAgent({}, { onEvent({ event }) { seen.push(event.type); } }).catch(() => undefined);
  return { agent, seen, stop: async () => { agent.abortRun(); await done; } };
}
try {
  const fixtures = await startRestartFixtures();
  try {
    s.env.BIRBCREW_PROXY_FIXTURE_ENDPOINTS = JSON.stringify(fixtures.endpoints);
    const stopTemporal = await s.startTemporal();
    let stopWorker = await s.child(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/proxy-restart-profiles.mts"]);
    try {
      await until(async () => {
        try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='proxy.fixture.v1'") === "3" || undefined; }
        catch { return undefined; }
      }, "proxy worker registration");
      await gateway();
      const capabilities = await (await request("/v1/capabilities")).json();
      assert.equal(capabilities.apiVersion, "1");
      const health = await request("/v1/health");
      assert.equal(health.status, 200, "real PostgreSQL and Temporal frontend are ready");
      assert.equal((await health.json()).dependencies.temporal.status, "ready");
      for (const engine of ["claude", "codex", "pi"] as Engine[]) {
        const member = await post("/v1/members", { requestId: randomUUID(), engine, profile: "proxy.fixture.v1" }, 201);
        const conversationId = randomUUID();
        await post("/v1/conversations", { memberId: member.memberId, conversationId }, 201);
        const path = `/v1/conversations/${conversationId}/requests`;
        const marker = randomUUID(), submissions: { requestId: string; text: string }[] = [];
        let observer = observe(conversationId);
        try {
          await until(async () => observer.seen.includes("STATE_SNAPSHOT") || undefined, "independent official AG-UI snapshot");
          for (let i = 0; i < 6; i++) {
            const payload = { requestId: randomUUID(), text: i === 5 ? "recall" : "remember " + marker };
            submissions.push(payload);
            const receipt = await post(path, payload);
            assert.equal(receipt.requestId, payload.requestId);
            assert.equal(receipt.acceptance.boundary, "sql_admission_and_temporal_queue");
            if (i === 4) {
              // Lost completion connection/recreated HTTP process on the far side
              // of a Temporal generation boundary, not just a new JS client.
              await observer.stop();
              await stopGateway!(); await gateway();
              observer = observe(conversationId);
            }
            const status = await until(async () => {
              const response = await request(path + "/" + payload.requestId);
              assert.equal(response.status, 200);
              const value = await response.json();
              assert.ok(!["failed", "uncertain", "cancelled"].includes(value.status), JSON.stringify(value));
              return value.status === "completed" ? value : undefined;
            }, `${engine} completed turn ${i + 1}`);
            assert.equal(status.result.text, (i === 5 ? "recalled " : "stored ") + marker);
          }
          await until(async () => observer.agent.messages.filter(message => message.role === "assistant").length === 6 || undefined,
            "official observer independently projects all six results");
          assert.equal(fixtures.evidence()[engine].requests, 6);
          const counters = fixtures.evidence()[engine].requests;
          for (const payload of submissions) {
            const original = await (await request(path + "/" + payload.requestId)).json();
            assert.deepEqual(await post(path, payload), original);
            assert.deepEqual(await (await request(path + "/" + payload.requestId)).json(), original);
          }
          assert.equal((await request(path, { ...submissions[0], text: "changed" })).status, 409);
          assert.equal((await request(path + "/" + submissions[0].requestId, undefined, stranger)).status, 404);
          assert.equal(fixtures.evidence()[engine].requests, counters, "reconciliation cannot invoke provider");
          assert.ok(Number(await s.sql(`SELECT count(DISTINCT workflow_run_id) FROM birbcrew_ts.turns WHERE conversation_id='${conversationId}'`)) >= 2);
          const snapshot = await (await request(`/v1/conversations/${conversationId}`)).json();
          const runInput = { threadId: conversationId, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
          assert.ok(snapshot.cursor > 0);
          assert.equal((await request(`/v1/conversations/${conversationId}/events?after=0`, runInput)).status, 410);
          await observer.stop();
          assert.equal(fixtures.evidence()[engine].requests, counters, "observer disconnect does not execute work");
          console.log(`${engine}: v1 HTTP acceptance, six turns across rollover, gateway SIGKILL/restart, original results, official AG-UI observation and no-inference duplicate reconciliation passed`);
        } finally { await observer.stop(); }
      }
      await stopWorker();
      stopWorker = await s.worker();
      await until(async () => {
        try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "3" || undefined; }
        catch { return undefined; }
      }, "approval worker registration");
      const { command } = commands(s);
      for (const engine of ["claude", "codex", "pi"] as Engine[]) {
        const member = await post("/v1/members", { requestId: randomUUID(), engine, profile: "fixture.approval.v1" }, 201);
        const conversationId = randomUUID(), path = `/v1/conversations/${conversationId}/requests`;
        await post("/v1/conversations", { memberId: member.memberId, conversationId }, 201);
        const predecessor = randomUUID(), successor = randomUUID();
        await post(path, { requestId: predecessor, text: "record " + predecessor });
        await until(async () => pendingSchema.parse(await command("pending", { ownerId, conversationId }))[0], "pending protected request");
        // Reading and disconnecting the official observer cannot cancel the waiting operation.
        const observer = observe(conversationId);
        await until(async () => observer.seen.includes("STATE_SNAPSHOT") || undefined, "pending observation");
        await observer.stop();
        assert.equal(pendingSchema.parse(await command("pending", { ownerId, conversationId })).length, 1);
        await post(path, { requestId: successor, text: "remember never-run" });
        const receipt = await post(path + "/" + predecessor + "/cancel", {});
        assert.ok(receipt.cancellation.receiptId);
        // Restart before delivery acknowledgement is relied on by the consumer.
        await stopGateway!(); await gateway();
        const repeated = await post(path + "/" + predecessor + "/cancel", {});
        assert.equal(repeated.cancellation.receiptId, receipt.cancellation.receiptId);
        await until(async () => {
          const value = await (await request(path + "/" + predecessor)).json();
          return value.cancellation.delivery === "delivered" ? value : undefined;
        }, "durable cancellation intent delivery after gateway restart");
        const rejected = await until(async () => {
          const value = await (await request(path + "/" + successor)).json();
          return value.status === "cancelled" ? value : undefined;
        }, "queued request terminal cancellation receipt");
        assert.equal(rejected.reason, "predecessor_cancelled");
        assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${conversationId}'`), "0");
        assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id='${conversationId}' AND request_id='${successor}'`), "0");
        console.log(`${engine}: durable cancellation receipt, gateway restart/retry, queued successor terminal status and no effect passed`);
      }
    } finally { await stopGateway?.(); await stopWorker(); await stopTemporal(); }
  } finally { await fixtures.close(); }
} finally { await s.close(); }
console.log("Versioned integration API proof passed with actual service fixtures; no live inference.");

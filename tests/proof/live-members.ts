import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { authorizeLive, type LiveAccount } from "./live-account.ts";
import { proofInfrastructure, root, until } from "./live-infrastructure.ts";
import { openRelay } from "./live-relay.ts";

type Services = Awaited<ReturnType<typeof proofInfrastructure>>;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function journey(account: LiveAccount, services: Services, signal: AbortSignal,
  sessions: () => number, verified: (gate: string) => void) {
  const { bearer, gatewayUrl, pool } = services;
  const headers = { Authorization: "Bearer " + bearer, "Content-Type": "application/json" };
  const post = async (path: string, body: object) => {
    const response = await fetch(gatewayUrl + path, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error("Gateway rejected proof command");
    return response.json();
  };
  async function snapshot(path: string) {
    const response = await fetch(gatewayUrl + path, { headers, signal });
    if (!response.ok) throw new Error("Cannot read canonical snapshot");
    return response.json();
  }
  async function open(profile: string) {
    const { memberId } = await post("/members", { requestId: randomUUID(), profile, engine: account.engine });
    const cid = randomUUID();
    await post("/conversations", { memberId, conversationId: cid });
    return { cid, memberId, path: "/conversations/" + cid, reader: services.observe(cid) };
  }
  function completed(path: string, client: ReturnType<Services["observe"]>, required: string) {
    return until(async () => {
      const current = await snapshot(path);
      if (current.state.phase === "failed") throw new Error("Native turn failed");
      const messages = await client.messages();
      const last = messages.at(-1);
      return current.state.phase === "idle" &&
        isDeepStrictEqual(messages, current.messages) && last?.role === "assistant" && typeof last.content === "string" &&
        last.content.includes(required) ? last.content : undefined;
    }, signal);
  }
  const { cid, path, memberId, reader } = await open(account.profile);
  const requestId = randomUUID(), nonce = "BIRB-" + randomUUID();
  const first = `This is a disposable coding-agent regression check. Remember this test marker: ${nonce}. Call record_work_item once with operation_id ${requestId} and note "synthetic regression test". After approval, reply with the exact receipt UUID you received.`;
  await post(path + "/inputs", { requestId, text: first });
  const approval = await until(async () => {
    const current = await snapshot(path);
    if (current.state.phase === "failed") throw new Error("Native proposal failed");
    return current.state.pendingApprovals?.find((card: { requestId: string }) => card.requestId === requestId);
  }, signal);
  const second = services.observe(cid);
  for (const observer of [reader, second]) await until(async () => await observer.sawPending(approval.approvalId) || undefined, signal);
  const effects = () => pool.query<{ receipt_id: string }>("SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1", [cid]);
  assert.equal((await effects()).rowCount, 0);
  verified("two independent observers saw the pending action before any work-item effect");
  const { invocationId, approvalId, version } = approval;
  await post(path + "/human", { requestId, memberId, invocationId, approvalId, version, choice: "approve" });
  const receipt = await until(async () => (await effects()).rows[0]?.receipt_id, signal);
  const [reply] = await Promise.all([completed(path, reader, receipt), completed(path, second, receipt)]);
  assert.equal((await effects()).rowCount, 1);
  const tool = (await reader.messages()).find((message) => message.role === "tool" && message.toolCallId === approvalId);
  assert.ok(typeof tool?.content === "string" && tool.content.includes(receipt));
  verified("one approved work item and its provider-returned receipt");
  const history = await reader.messages();
  await services.replaceWorker();
  verified("worker container replaced with fresh writable home and scratch");
  const followup = "Reply with the exact test marker I asked you to remember. Use the earlier conversation and do not call a tool.";
  await post(path + "/inputs", { requestId: randomUUID(), text: followup });
  const [recall] = await Promise.all([completed(path, reader, nonce), completed(path, second, nonce)]);
  const messages = await reader.messages();
  assert.equal(messages.filter(m => m.role === "user").length, 2);
  assert.deepEqual(messages.slice(0, history.length), history);
  assert.deepEqual(messages, await second.messages());
  assert.equal((await effects()).rowCount, 1);
  verified("cold follow-up and both final message files match canonical history");
  if (account.engine === "codex") {
    const { rows } = await pool.query("SELECT checkpoint->'state' AS state FROM birbcrew_ts.turns WHERE conversation_id=$1 ORDER BY position", [cid]);
    assert.equal(rows.length, 2);
    const [a, b] = rows.map(row => z.object({ nativeId: z.uuid(), rollout: z.string().regex(/^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[\dT-]+-[a-f0-9-]{36}\.jsonl$/), ownerDigest: z.hash("sha256") }).parse(row.state));
    assert.deepEqual(a, b);
    const file = join(services.native, "codex", a.ownerDigest, memberId, cid, "home", a.rollout);
    const messages = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.type === "event_msg" && entry.payload?.type === "user_message").map(entry => entry.payload.message);
    assert.deepEqual(messages, [first, followup]);
    verified("same real Codex native ID and exactly the two expected native user messages");
  }
  if (account.engine === "pi") {
    assert.equal(sessions(), 1);
    const crew = await open(account.profile.replace(".approval.v1", ".crew.v1"));
    const marker = "CHILD-" + randomUUID();
    await post(crew.path + "/inputs", { requestId: randomUUID(),
      text: `Test delegation for a disposable code review. Use delegate_task once with role analyst and task "Reply exactly ${marker}". Echo the analyst's returned text in your final answer.` });
    await completed(crew.path, crew.reader, marker);
    const { rows } = await pool.query("SELECT phase,outcome FROM birbcrew_ts.pi_children WHERE conversation_id=$1", [crew.cid]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, "complete");
    assert.ok(rows[0].outcome?.text.includes(marker));
    assert.equal(sessions(), 3);
    verified("Go response model and session headers across cold resume, crew parent and child");
  }
  return { zeroBeforeApproval: true, committedWorkItems: 1, receiptId: receipt,
    answerHashes: [sha(reply), sha(recall)], recalledMarker: nonce,
    ...(account.engine === "codex" && { sameNativeThread: true, nativeUserTurnsVerified: 2 }),
    ...(account.engine === "pi" && { delegatedChild: true, returnedModelVerified: true }) };
}

export async function verifyLive(account: LiveAccount, signal: AbortSignal, controlledTransport?: typeof fetch, verified: (gate: string) => void = () => {}) {
  const cleanup: (() => Promise<unknown>)[] = [];
  let result;
  try {
    const relay = await openRelay(account, controlledTransport);
    cleanup.push(() => relay.close());
    const services = await proofInfrastructure(account, relay.url, signal, cleanup);
    verified("selected account, worker and gateway initialized");
    const outcome = await journey(account, services, signal, () => relay.stats().sessions, verified);
    const stats = relay.stats();
    assert.ok(stats.requests > 0 && stats.requests <= account.budget && !stats.rejected);
    const lock = await readFile(join(root, "package-lock.json"));
    const manifest = JSON.parse(lock.toString("utf8")).packages;
    const pkg = { pi: "@earendil-works/pi-coding-agent", claude: "@anthropic-ai/claude-agent-sdk", codex: "@openai/codex-sdk" }[account.engine];
    const tracked = (await promisify(execFile)("git", ["-C", root, "ls-files", "--", "src/service", "native", "clients",
      "tests/proof/live-*.ts", "scripts/build-native", "package-lock.json", "package.json"], { env: { PATH: process.env.PATH } })).stdout.trim().split("\n");
    const source = Object.fromEntries(await Promise.all(tracked.map(async path => [path, sha(await readFile(join(root, path)))])));
    result = { status: "VERIFIED", scope: controlledTransport ? "controlled rehearsal" : "approved API journey", liveProviderVerified: !controlledTransport, engine: account.engine, model: account.model,
      auth: account.auth, origin: account.origin, requests: stats.requests, maxRequests: account.budget,
      node: process.version, sdkVersion: manifest["node_modules/" + pkg].version, lockSha256: sha(lock), source,
      revision: (await promisify(execFile)("git", ["-C", root, "rev-parse", "HEAD"], { env: { PATH: process.env.PATH } })).stdout.trim(),
      workerContainerReplaced: true, ...outcome };
  } finally {
    let failed = false;
    for (const close of cleanup.reverse()) { try { await close(); } catch { failed = true; } }
    if (failed) throw new Error("Disposable resource cleanup failed");
  }
  verified("disposable services, private client outputs and native volume cleaned up");
  return { ...result, cleanup: "verified", billing: "owner-attested" };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const verifiedGates: string[] = [];
  let stage = "account preflight";
  try {
    const account = await authorizeLive(process.argv.slice(2), process.env);
    verifiedGates.push("fresh owner-authorized private account and model");
    stage = "provider journey or cleanup";
    const report = await verifyLive(account, AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]), undefined,
      (gate) => verifiedGates.push(gate));
    console.log(JSON.stringify({ ...report, verifiedGates }));
  } catch {
    console.error(JSON.stringify({ status: "NOT VERIFIED", stage, verifiedGates }));
    process.exitCode = 1;
  }
}

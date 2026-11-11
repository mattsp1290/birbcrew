import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { MemberClient } from "../../src/service/client.ts";
import { MemberStore } from "../../src/service/store.ts";

const database = process.env.BIRBCREW_TEST_DATABASE_URL;
const address = process.env.BIRBCREW_TEMPORAL_ADDRESS;
if (!database || !address) throw new Error("Run with the disposable member services and a fixture worker");

const pool = new Pool({ connectionString: database });
const connection = await Connection.connect({ address });
const temporal = new Client({ connection });
const store = new MemberStore(pool);
const members = new MemberClient(store, temporal);
after(async () => { await pool.end(); await connection.close(); });

async function conversation() {
  const ownerId = randomUUID();
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture.v1" });
  const conversationId = randomUUID();
  const binding = { ownerId, memberId, conversationId };
  await store.openConversation(binding);
  await pool.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1", [conversationId]);
  await members.open(binding);
  const handle = temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${conversationId}`);
  return { binding, handle, request: (text: string) => ({ ownerId, conversationId, requestId: randomUUID(), text }) };
}

test("legacy proof: all four Updates and a duplicate drain before completion and replay after closure", { timeout: 45_000 }, async () => {
  const { binding, handle, request } = await conversation();
  const inputs = Array.from({ length: 4 }, (_, n) => request(`remember ${n}`));
  const replies = await Promise.all([...inputs, inputs[0]].map((input) => members.submit(input)));
  assert.deepEqual(replies, ["stored 0", "stored 1", "stored 2", "stored 3", "stored 0"]);
  await handle.result();
  const closed = await handle.describe();
  assert.equal(closed.status.name, "COMPLETED");
  await members.open(binding);
  assert.equal((await handle.describe()).runId, closed.runId);
  for (const [n, input] of inputs.entries()) assert.equal(await members.submit(input), replies[n]);
  await assert.rejects(members.submit({ ...inputs[0], text: "changed" }), { code: "conflict" });
  await assert.rejects(members.submit({ ...inputs[0], ownerId: randomUUID() }), { code: "not_found" });
  await assert.rejects(members.submit(request("recall")));
});

test("generation failure closes the execution and preserves earlier committed replies", { timeout: 45_000 }, async () => {
  const { binding, handle, request } = await conversation();
  const committed = request("remember prior");
  const uncertain = request("fail");
  assert.equal(await members.submit(committed), "stored prior");
  await assert.rejects(members.submit(uncertain));
  await assert.rejects(handle.result());
  const closed = await handle.describe();
  assert.equal(closed.status.name, "FAILED");
  await members.open(binding);
  assert.equal((await handle.describe()).runId, closed.runId);
  assert.equal(await members.submit(committed), "stored prior");
  await assert.rejects(members.submit(uncertain), { code: "conflict" });
  await assert.rejects(members.submit(request("recall")));
});

/** Real public SDK/PG observation; no native engine, model or Temporal server. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { Client, Pool } from "pg";
import { MemberStore } from "../../src/service/store.ts";
import { integrationCapabilities } from "../../src/service/integration-api.ts";
import { TrustedContextStore, type Authorization, type TrustedApplication, type TrustedKey } from "../../src/service/trusted-context.ts";
const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url)
    throw Error("BIRBCREW_TEST_DATABASE_URL must name the owned disposable database");
const pool = new Pool({ connectionString: url, max: 16, connectionTimeoutMillis: 1000 }), members = new MemberStore(pool);
const code = (value: string) => ({ name: "TrustedContextError", code: value });
const signal = () => new AbortController().signal;
const snapshot = { scope: "private-original", version: "original-v1", text: "PRIVATE_CONTEXT_CANARY" };
before(async () => {
    await members.migrate();
    await pool.query("CREATE TABLE IF NOT EXISTS birbcrew_ts.test_receipt_effects(operation_id uuid PRIMARY KEY,note text NOT NULL)");
});
after(() => pool.end());
async function fixture() {
    const ownerId = randomUUID(), member = await members.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "receipt-fixture" });
    const key: TrustedKey = { ownerId, conversationId: randomUUID() };
    await members.openConversation({ ...key, memberId: member.memberId });
    const calls: Authorization[] = [], invoked: string[] = [];
    let allowRelease = true, allowOutput = true, denyOperation: string | null = null;
    let receiptPolicy: (value: Authorization) => Promise<boolean> = async (value) => value.operationId !== denyOperation;
    const app: TrustedApplication = { id: "observational-receipts-v1", authorize: async (value) => {
            calls.push(structuredClone(value));
            if (value.phase === "receipt")
                return receiptPolicy(value);
            return value.phase === "release" ? allowRelease : value.phase === "output" ? allowOutput : true;
        }, tools: [{ name: "record_effect", description: "Record a real owned test effect", kind: "effect",
                inputSchema: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", maxLength: 128 } } },
                maxArgumentBytes: 256, maxResultBytes: 512, deadlineMs: 1000, execute: async ({ operationId, args }) => {
                    invoked.push(operationId);
                    await pool.query("INSERT INTO birbcrew_ts.test_receipt_effects VALUES($1,$2) ON CONFLICT DO NOTHING", [operationId, (args as {
                            note: string;
                        }).note]);
                    return { operationId, body: "PRIVATE_RESULT_CANARY" };
                } }] };
    const store = new TrustedContextStore(pool, app);
    await store.open(key, snapshot);
    const requestId = randomUUID();
    await store.submit(key, requestId, "PRIVATE_PROMPT_CANARY");
    const turn = await store.begin(key);
    assert.ok(turn);
    const dispatch = (name = "one") => store.dispatch(turn.claim, name, "record_effect", { note: "ARGUMENT_CANARY_" + name }, signal());
    return { key, store, app, turn, requestId, dispatch, calls, invoked, release: (allow: boolean) => { allowRelease = allow; }, output: (allow: boolean) => { allowOutput = allow; },
        deny: (operationId: string | null) => { denyOperation = operationId; }, policy: (next: typeof receiptPolicy) => { receiptPolicy = next; } };
}
async function durable(key: TrustedKey) {
    const result: unknown[] = [];
    for (const table of ["trusted_sessions", "trusted_requests", "trusted_tool_calls", "trusted_generations"])
        result.push((await pool.query(`SELECT to_jsonb(t) AS row FROM birbcrew_ts.${table} t WHERE conversation_id=$1 ORDER BY to_jsonb(t)::text`, [key.conversationId])).rows);
    result.push((await pool.query("SELECT * FROM birbcrew_ts.test_receipt_effects WHERE operation_id IN (SELECT operation_id FROM birbcrew_ts.trusted_tool_calls WHERE conversation_id=$1) ORDER BY operation_id", [key.conversationId])).rows);
    return result;
}
test("lost release observes a committed effect while request remains RUNNING, with no body or durable mutation", async () => {
    const f = await fixture();
    f.release(false);
    await assert.rejects(f.dispatch(), code("denied"));
    await f.store.submit(f.key, randomUUID(), "QUEUED_PROMPT_CANARY");
    const before = await durable(f.key);
    f.calls.length = 0;
    const value = await f.store.readReceipts(f.key, f.requestId);
    assert.ok(value);
    assert.equal(value.phase, "running");
    assert.equal(value.requestId, f.requestId);
    assert.equal(value.receipts.length, 1);
    const receipt = value.receipts[0];
    assert.deepEqual(receipt, { operationId: f.invoked[0], toolName: "record_effect", outcome: "completed", released: false, acknowledged: false });
    assert.deepEqual(f.calls, [{ ...f.key, phase: "receipt", requestId: f.requestId, toolName: "record_effect", operationId: f.invoked[0], scope: snapshot.scope, version: snapshot.version }]);
    assert.equal(f.invoked.length, 1);
    assert.deepEqual(await durable(f.key), before);
    assert.deepEqual(await new TrustedContextStore(pool, f.app).readReceipts(f.key, f.requestId), value);
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.receipts) && Object.isFrozen(receipt));
    const serialized = JSON.stringify(value);
    assert.ok(!/CANARY|scope|version|argument|result|prompt|checkpoint|generation/.test(serialized));
    assert.ok(Buffer.byteLength(serialized) <= 8192);
});
test("original operation policy authorizes historical receipts without current output, and any denied operation fails the whole read", async () => {
    const f = await fixture();
    await f.dispatch("one");
    await f.dispatch("two");
    await f.store.commit(f.turn.claim, "PRIVATE_REPLY_CANARY", { private: "PRIVATE_CHECKPOINT_CANARY" });
    await f.store.invalidate(f.key, 1, { scope: "replacement", version: "replacement-v2", text: "REPLACEMENT_CONTEXT" });
    await f.store.finishRotation(f.key);
    f.output(false);
    f.calls.length = 0;
    const before = await durable(f.key);
    const value = await f.store.readReceipts(f.key, f.requestId);
    assert.ok(value);
    assert.equal(value.phase, "completed");
    assert.equal(value.receipts.length, 2);
    assert.ok(f.calls.every(call => call.phase === "receipt" && call.scope === snapshot.scope && call.version === snapshot.version));
    assert.deepEqual(new Set(f.calls.map(call => call.operationId)), new Set(f.invoked));
    f.deny(value.receipts[1].operationId);
    await assert.rejects(f.store.readReceipts(f.key, f.requestId), code("denied"));
    assert.deepEqual(await durable(f.key), before);
    assert.equal(f.invoked.length, 2);
});
test("a genuine shared native lease denies observation, wrong owners/archive fail before busy disclosure, and the lease is not cancelled", async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const active = f.store.admitted(f.turn.claim, signal(), async () => { await f.dispatch(); entered.resolve(); await finish.promise; });
    await entered.promise;
    try {
        await assert.rejects(f.store.readReceipts({ ...f.key, ownerId: randomUUID() }, f.requestId), code("not_found"));
        await assert.rejects(new TrustedContextStore(pool, { ...f.app, id: "changed-archive" }).readReceipts(f.key, f.requestId), code("conflict"));
        await assert.rejects(f.store.readReceipts(f.key, f.requestId), code("busy"));
        assert.equal(f.invoked.length, 1);
    }
    finally {
        finish.resolve();
        await active;
    }
    const before = await durable(f.key);
    assert.ok(await f.store.readReceipts(f.key, f.requestId));
    assert.deepEqual(await durable(f.key), before);
});
test("key and request capture precede awaits, and a late original receipt revocation rejects without classifying", async () => {
    const f = await fixture();
    await f.dispatch();
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<boolean>();
    f.policy(async () => { entered.resolve(); return finish.promise; });
    const key = { ...f.key }, pending = f.store.readReceipts(key, f.requestId);
    await entered.promise;
    key.ownerId = randomUUID();
    key.conversationId = randomUUID();
    finish.resolve(true);
    const value = await pending;
    assert.ok(value);
    assert.equal(value.requestId, f.requestId);
    assert.equal(value.phase, "running");
    const late = Promise.withResolvers<void>(), deny = Promise.withResolvers<boolean>();
    f.policy(async () => { late.resolve(); return deny.promise; });
    const revoked = f.store.readReceipts(f.key, f.requestId), rejected = assert.rejects(revoked, code("denied"));
    await late.promise;
    deny.resolve(false);
    await rejected;
    assert.equal(f.invoked.length, 1);
});
test("unknown, empty, erased and legacy unprovable requests are explicit, never guessed from a replacement scope", async () => {
    const f = await fixture();
    assert.equal(await f.store.readReceipts(f.key, f.requestId), null);
    await assert.rejects(f.store.readReceipts(f.key, randomUUID()), code("not_found"));
    await assert.rejects(f.store.readReceipts(f.key, "not-a-uuid"));
    await assert.rejects(f.store.readReceipts({ ...f.key, arbitrary: "authority" } as never, f.requestId));
    await f.dispatch();
    for (const [scope, version] of [[null, snapshot.version], [snapshot.scope, null], ["", snapshot.version], [snapshot.scope, ""]]) {
        await pool.query("UPDATE birbcrew_ts.trusted_tool_calls SET scope=$2,context_version=$3 WHERE conversation_id=$1", [f.key.conversationId, scope, version]);
        await assert.rejects(f.store.readReceipts(f.key, f.requestId), code("denied"));
    }
    await f.store.invalidate(f.key, 1, { scope: "erasure", version: "erasure-v2", text: "SAFE_ERASURE" });
    await f.store.erase(f.key);
    await assert.rejects(f.store.readReceipts(f.key, f.requestId), code("stale"));
});
test("actual cancelled request and admitted receipt remain exactly stored observations", async () => {
    const f = await fixture();
    await f.dispatch();
    // Upstream-owned corruption/legacy fixture only: admitted metadata is not fabricated as uncertainty by the reader.
    await pool.query("UPDATE birbcrew_ts.trusted_tool_calls SET outcome='admitted',released=false,acknowledged=false WHERE conversation_id=$1", [f.key.conversationId]);
    const before = await durable(f.key), value = await f.store.readReceipts(f.key, f.requestId);
    assert.ok(value);
    assert.equal(value.phase, "running");
    assert.equal(value.receipts[0].outcome, "admitted");
    assert.deepEqual(await durable(f.key), before);
    await f.store.invalidate(f.key, 1, { scope: "next", version: "v2", text: "SAFE_CONTEXT" });
    await f.store.finishRotation(f.key);
    const cancelled = await f.store.readReceipts(f.key, f.requestId);
    assert.ok(cancelled);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.receipts[0].outcome, "uncertain");
});
test("read metadata is bounded to16 operations and contains no canonical body SELECT or writes", async () => {
    const f = await fixture();
    await f.dispatch();
    const original = Client.prototype.query, statements: string[] = [];
    Client.prototype.query = function (this: Client, ...args: Parameters<Client["query"]>) {
        const first: unknown = args[0];
        statements.push(typeof first === "string" ? first : String((first as {
            text: string;
        }).text));
        return Reflect.apply(original, this, args);
    } as Client["query"];
    try {
        assert.ok(await f.store.readReceipts(f.key, f.requestId));
    }
    finally {
        Client.prototype.query = original;
    }
    assert.ok(statements.length > 0 && statements.every(sql => !/\b(INSERT|UPDATE|DELETE|prompt|reply|context_text|checkpoint|result)\b|s\.\*/i.test(sql)));
    assert.ok(statements.some(sql => sql.includes("FOR SHARE OF s")) && statements.some(sql => sql.includes("LIMIT 17")));
    // Only the upstream test owns this private SQL; consumer code has no such adapter.
    await pool.query(`INSERT INTO birbcrew_ts.trusted_tool_calls(conversation_id,request_id,native_call_id,generation,tool_name,argument_digest,operation_id,kind,outcome,scope,context_version)
    SELECT $1,$2,'overflow-'||n,1,'record_effect','digest',gen_random_uuid(),'effect','admitted',$3,$4 FROM generate_series(1,16) n`, [f.key.conversationId, f.requestId, snapshot.scope, snapshot.version]);
    await assert.rejects(f.store.readReceipts(f.key, f.requestId), code("limit"));
});
test("sixteen actual public dispatches fit the metadata ceiling without an empty or truncated receipt", async () => {
    const f = await fixture();
    for (let i = 0; i < 16; i++)
        await f.dispatch("bounded-" + i);
    const before = await durable(f.key), value = await f.store.readReceipts(f.key, f.requestId);
    assert.ok(value);
    assert.equal(value.receipts.length, 16);
    assert.equal(new Set(value.receipts.map(r => r.operationId)).size, 16);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192);
    assert.deepEqual(await durable(f.key), before);
    assert.equal(f.invoked.length, 16);
});
test("all receipt authorizers share one five-second budget rather than renewing it per operation", async () => {
    const f = await fixture();
    await f.dispatch("one");
    await f.dispatch("two");
    let calls = 0;
    f.policy(async () => { calls++; await pause(3000); return true; });
    const before = await durable(f.key), started = performance.now();
    await assert.rejects(f.store.readReceipts(f.key, f.requestId), code("denied"));
    assert.ok(performance.now() - started < 6500);
    assert.equal(calls, 2);
    await pause(1100);
    assert.deepEqual(await durable(f.key), before);
    assert.equal(f.invoked.length, 2);
});
test("row-lock contention is bounded by the observation deadline and leaves durable state unchanged", async () => {
    const f = await fixture();
    await f.dispatch();
    const before = await durable(f.key), lock = await pool.connect();
    try {
        await lock.query("BEGIN");
        await lock.query("SELECT 1 FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1 FOR UPDATE", [f.key.conversationId]);
        const started = performance.now();
        await assert.rejects(f.store.readReceipts(f.key, f.requestId));
        assert.ok(performance.now() - started < 7000);
    }
    finally {
        await lock.query("ROLLBACK");
        lock.release();
    }
    assert.deepEqual(await durable(f.key), before);
});
test("the additive capability describes only explicit bounded observational metadata", () => {
    assert.deepEqual(integrationCapabilities.trustedContext.receiptObservation, { version: 1, mode: "original-operation-metadata", maximumReceipts: 16, maximumBytes: 8192, readOnly: true, explicitRequest: true });
    assert.equal(integrationCapabilities.trustedContext.version, 1);
    assert.equal(integrationCapabilities.trustedContext.httpSubmission, false);
});
test("explicit password and password callback survive the dedicated connection without URL or environment masking", async () => {
    const f = await fixture();
    await f.dispatch();
    const parsed = new URL(url!);
    const connection = { host: parsed.hostname, port: Number(parsed.port || 5432), user: decodeURIComponent(parsed.username),
        database: decodeURIComponent(parsed.pathname.slice(1)), password: decodeURIComponent(parsed.password) };
    const script = `import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { TrustedContextStore } = await import(input.module);
const { password, ...connection } = input.connection;
let callbacks = 0;
const pool = new Pool({ ...connection, password: input.callback ? async () => { callbacks++; return password; } : password, connectionTimeoutMillis: 1000 });
try {
    if (Object.hasOwn(pool.options, 'connectionString'))
        throw Error('URL masking');
    if (Object.prototype.propertyIsEnumerable.call(pool.options, 'password'))
        throw Error('password must be hidden');
    await pool.query('SELECT 1');
    const application = { id: input.applicationId, tools: input.manifest.map(tool => ({ ...tool, execute: async () => { throw Error('handler invoked'); } })),
        authorize: async (a) => a.phase === 'receipt' && a.ownerId === input.key.ownerId && a.conversationId === input.key.conversationId && a.requestId === input.requestId && a.scope === input.scope && a.version === input.version };
    const result = await new TrustedContextStore(pool, application).readReceipts(input.key, input.requestId);
    if (!result || result.receipts.length !== 1 || result.receipts[0].operationId !== input.operationId)
        throw Error('wrong observation');
    process.stdout.write(JSON.stringify({ observed: true, callbacks }));
}
finally {
    await pool.end();
}
`;
    for (const callback of [false, true]) {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000,
            env: { ...process.env, PGPASSWORD: "ro00-invalid-environment-fallback" },
            input: JSON.stringify({ module: new URL("../../src/service/trusted-context.ts", import.meta.url).href, connection, callback,
                key: f.key, requestId: f.requestId, operationId: f.invoked[0], applicationId: f.app.id, manifest: f.store.manifest, scope: snapshot.scope, version: snapshot.version }) });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { observed: true, callbacks: callback ? 2 : 0 });
        assert.equal(result.stdout.includes(connection.password), false);
    }
});

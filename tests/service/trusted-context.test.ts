import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { MemberStore } from "../../src/service/store.ts";
import {
  canonical, TrustedContextStore, toolManifest,
  type Authorization, type RegisteredTool, type TrustedApplication, type TrustedClaim,
  type TrustedKey, type TrustedStart,
} from "../../src/service/trusted-context.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString:url, max:20 });
const members = new MemberStore(pool);
const noAbort = () => new AbortController().signal;
const snapshot = {scope:"private-a",version:"v1",text:"Only private A context."};
const nextSnapshot = {scope:"channel-b",version:"v2",text:"Only channel B context."};
const argSchema = {type:"object",additionalProperties:false,required:["note"],properties:{note:{type:"string",minLength:1,maxLength:80}}};
const errorCode = (code:string) => ({name:"TrustedContextError",code});
function gate<T = void>() {
  let resolve!: (value:T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise,resolve};
}

function application(options: {
  authorize?: (input:Authorization) => Promise<boolean>;
  read?: RegisteredTool["execute"];
  effect?: RegisteredTool["execute"];
} = {}): TrustedApplication {
  return {
    id:"trusted-fixture-v1",
    authorize:options.authorize ?? (async () => true),
    tools:[
      {name:"read_context",description:"Read one fixture value.",kind:"read",inputSchema:argSchema,
        maxArgumentBytes:128,maxResultBytes:256,deadlineMs:1000,
        execute:options.read ?? (async ({args,authority}) => ({scope:authority.scope,note:(args as {note:string}).note}))},
      {name:"record_effect",description:"Record one fixture effect with a durable receipt.",kind:"effect",inputSchema:argSchema,
        maxArgumentBytes:128,maxResultBytes:256,deadlineMs:1000,
        execute:options.effect ?? (async ({operationId,args}) => {
          const note = (args as {note:string}).note;
          await pool.query("INSERT INTO birbcrew_ts.test_trusted_effects (operation_id,note) VALUES ($1,$2) ON CONFLICT DO NOTHING",[operationId,note]);
          return {receipt:operationId,note};
        })},
    ],
  };
}
async function newKey(): Promise<TrustedKey> {
  const ownerId = randomUUID();
  const member = await members.spawn({ownerId,requestId:randomUUID(),engine:"pi",profile:"trusted-test"});
  const key = {ownerId,conversationId:randomUUID()};
  await members.openConversation({...key,memberId:member.memberId});
  return key;
}
async function fixture(options: Parameters<typeof application>[0] = {}) {
  const app = application(options), store = new TrustedContextStore(pool,app), key = await newKey();
  await store.open(key,snapshot);
  return {app,store,key};
}
async function start(store: TrustedContextStore,key:TrustedKey,text = "Fixture prompt"): Promise<TrustedStart> {
  await store.submit(key,randomUUID(),text);
  const turn = await store.begin(key);
  assert.ok(turn);
  return turn;
}
async function callRow(claim:TrustedClaim,id:string) {
  return (await pool.query("SELECT * FROM birbcrew_ts.trusted_tool_calls WHERE conversation_id=$1 AND request_id=$2 AND native_call_id=$3",[claim.conversationId,claim.requestId,id])).rows[0];
}

async function crashChild() {
  const claim = JSON.parse(process.env.TRUSTED_TEST_CLAIM!) as TrustedClaim;
  const mode = process.env.TRUSTED_TEST_CRASH_MODE!;
  const note = process.env.TRUSTED_TEST_NOTE!;
  const base = application();
  const normal = base.tools[1].execute;
  base.tools[1].execute = async input => {
    const receipt = await normal(input);
    if (mode === "after-effect") {
      process.send?.({ready:true});
      await new Promise(() => {});
    }
    return receipt;
  };
  const store = new TrustedContextStore(pool,base);
  await store.dispatch(claim,"crash-call","record_effect",{note},noAbort());
  process.send?.({ready:true});
  await new Promise(() => {});
}

if (process.argv.includes("--fixture-effect-child")) {
  await crashChild();
} else {
  before(async () => {
    await members.migrate();
    await pool.query("CREATE TABLE IF NOT EXISTS birbcrew_ts.test_trusted_effects (operation_id uuid PRIMARY KEY,note text NOT NULL)");
  });
  after(() => pool.end());

  test("registration requires bounded explicit schemas and a current authorization callback", async () => {
    const app = application();
    assert.deepEqual(toolManifest(app).map(x => x.name),["read_context","record_effect"]);
    assert.throws(() => new TrustedContextStore(pool,{...app,authorize:undefined as never}),errorCode("limit"));
    assert.throws(() => new TrustedContextStore(pool,{...app,tools:[app.tools[0],app.tools[0]]}),errorCode("conflict"));
    assert.throws(() => new TrustedContextStore(pool,{...app,tools:[{...app.tools[0],maxResultBytes:Infinity}]}),errorCode("limit"));
    assert.throws(() => new TrustedContextStore(pool,{...app,tools:[{...app.tools[0],deadlineMs:30_001}]}),errorCode("limit"));
    assert.throws(() => new TrustedContextStore(pool,{...app,tools:[{...app.tools[0],inputSchema:{type:"object"}}]}),errorCode("limit"));
    const key = await newKey();
    const deny = new TrustedContextStore(pool,application({authorize:async () => false}));
    await assert.rejects(deny.open(key,snapshot),errorCode("denied"));
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rowCount,0);
  });

  test("exact owner, scope, context version and tool manifest bind the application session", async () => {
    const {store,key} = await fixture();
    await store.open(key,snapshot);
    await assert.rejects(store.open(key,{...snapshot,text:"Changed without a new version"}),errorCode("conflict"));
    await assert.rejects(store.open(key,nextSnapshot),errorCode("conflict"));
    await assert.rejects(store.begin({...key,ownerId:randomUUID()}),errorCode("not_found"));
    const changed = new TrustedContextStore(pool,{...application(),id:"changed-policy"});
    await assert.rejects(changed.begin(key),errorCode("conflict"));
    await assert.rejects(members.beginTurn({...key,requestId:randomUUID(),text:"Cannot create a legacy parallel lane"}),{code:"conflict"});
    const legacyKey = await newKey();
    await members.beginTurn({...legacyKey,requestId:randomUUID(),text:"Existing legacy lane"});
    await assert.rejects(store.open(legacyKey,snapshot),errorCode("conflict"));
  });

  test("one durable turn order survives concurrency, duplicate submission and store recreation", async () => {
    const {store,key} = await fixture();
    const first = randomUUID(), second = randomUUID();
    assert.deepEqual(await Promise.all([store.submit(key,first,"first"),store.submit(key,first,"first")]),[1,1]);
    assert.equal(await store.submit(key,second,"second"),2);
    await assert.rejects(store.submit(key,first,"changed"),errorCode("conflict"));
    const starts = await Promise.allSettled([store.begin(key),store.begin(key)]);
    assert.equal(starts.filter(r => r.status === "fulfilled").length,1);
    const turn = starts.find(r => r.status === "fulfilled") as PromiseFulfilledResult<TrustedStart>;
    assert.equal(turn.value.claim.requestId,first);
    await store.commit(turn.value.claim,"first reply",{bound:turn.value.binding});
    const fresh = new TrustedContextStore(pool,application());
    const next = await fresh.begin(key); assert.ok(next);
    assert.equal(next.claim.requestId,second);
    assert.equal(next.threadId,turn.value.threadId);
    assert.deepEqual(next.checkpoint,{bound:turn.value.binding});
    await fresh.commit(next.claim,"second reply",{second:true});
    assert.equal(await fresh.begin(key),null);
    assert.deepEqual(await fresh.result(key,first),{phase:"completed",reply:"first reply"});
  });

  test("unregistered tools, invalid arguments and current policy deny before any effect admission", async () => {
    let allowDispatch = true;
    const {store,key} = await fixture({authorize:async input => allowDispatch || input.phase !== "dispatch"});
    const turn = await start(store,key);
    await assert.rejects(store.dispatch(turn.claim,"bad","shell",{},noAbort()),errorCode("denied"));
    await assert.rejects(store.dispatch(turn.claim,"bad","record_effect",{note:"ok",extra:true},noAbort()));
    await assert.rejects(store.dispatch(turn.claim,"bad","record_effect",{note:"a".repeat(200)},noAbort()),errorCode("limit"));
    allowDispatch = false;
    await assert.rejects(store.dispatch(turn.claim,"bad","record_effect",{note:"safe"},noAbort()),errorCode("denied"));
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.trusted_tool_calls WHERE conversation_id=$1",[key.conversationId])).rowCount,0);
  });

  test("read tool sees only its bound scope and durable effect replay does not execute twice", async () => {
    const {store,key} = await fixture(); const turn = await start(store,key);
    const read = await store.dispatch(turn.claim,"read-1","read_context",{note:"hello"},noAbort());
    assert.deepEqual(JSON.parse(read.text),{note:"hello",scope:"private-a"});
    const note = randomUUID();
    const result = await store.dispatch(turn.claim,"effect-1","record_effect",{note},noAbort());
    const row = await callRow(turn.claim,"effect-1");
    assert.equal(row.outcome,"completed"); assert.equal(row.released,true); assert.equal(row.acknowledged,false);
    assert.deepEqual(await store.dispatch(turn.claim,"effect-1","record_effect",{note},noAbort()),result);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.test_trusted_effects WHERE note=$1",[note])).rowCount,1);
    await assert.rejects(store.dispatch(turn.claim,"effect-1","record_effect",{note:"changed"},noAbort()),errorCode("conflict"));
    await assert.rejects(store.acknowledge(turn.claim,"effect-1","read_context"),errorCode("conflict"));
    await store.acknowledge(turn.claim,"effect-1","record_effect");
    assert.equal((await callRow(turn.claim,"effect-1")).acknowledged,true);
  });

  test("concurrent duplicate native calls cannot dispatch a second effect", async t => {
    const entered = gate(), release = gate(); let executions = 0;
    t.after(() => release.resolve());
    const {store,key} = await fixture({effect:async ({operationId}) => {
      executions++; entered.resolve(); await release.promise; return {receipt:operationId};
    }});
    const turn = await start(store,key);
    const first = store.dispatch(turn.claim,"concurrent-effect","record_effect",{note:"same"},noAbort());
    await entered.promise;
    try {
      await assert.rejects(store.dispatch(turn.claim,"concurrent-effect","record_effect",{note:"same"},noAbort()),errorCode("uncertain"));
      await assert.rejects(store.dispatch(turn.claim,"concurrent-effect","record_effect",{note:"changed"},noAbort()),errorCode("conflict"));
    } finally {release.resolve();}
    await first;
    assert.equal(executions,1);
  });

  test("revocation after prompt construction fences dispatch, output and checkpoint commitment", async () => {
    const {store,key} = await fixture(); const turn = await start(store,key);
    await store.invalidate(key,1,nextSnapshot);
    await assert.rejects(store.dispatch(turn.claim,"late","record_effect",{note:"late"},noAbort()),errorCode("stale"));
    await assert.rejects(store.commit(turn.claim,"stale reply",{secret:"old checkpoint"}),errorCode("stale"));
    await assert.rejects(store.admitted(turn.claim,noAbort(),async () => "must not run"),errorCode("stale"));
    await store.finishRotation(key);
    const next = await start(store,key);
    assert.equal(next.context,nextSnapshot.text); assert.equal(next.checkpoint,null);
    assert.notEqual(next.threadId,turn.threadId); assert.notEqual(next.binding,turn.binding);
    assert.equal(next.claim.conversationId,turn.claim.conversationId);
    assert.deepEqual(await store.result(key,turn.claim.requestId),{phase:"cancelled",reply:null});
  });

  test("rotation publishes generation before cancellation and waits for a surviving native lease", async () => {
    const {store,key} = await fixture(); const turn = await start(store,key);
    const entered = gate(), release = gate(), aborted = gate();
    const native = store.admitted(turn.claim,noAbort(),async signal => {
      signal.addEventListener("abort",()=>aborted.resolve(),{once:true});
      entered.resolve(); await release.promise; return "stopped";
    });
    await entered.promise;
    try {
      await assert.rejects(store.recover(key),errorCode("busy"));
      const generation = await store.invalidate(key,1,nextSnapshot,async () => {
        const s = (await pool.query("SELECT generation,phase FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rows[0];
        assert.deepEqual(s,{generation:2,phase:"draining"});
        await assert.rejects(store.begin(key),errorCode("busy"));
      });
      assert.equal(generation,2);
      await aborted.promise;
      await assert.rejects(store.finishRotation(key),errorCode("busy"));
    } finally {release.resolve(); await native;}
    await store.finishRotation(key);
    assert.equal((await pool.query("SELECT phase FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rows[0].phase,"active");
  });

  test("a failed cancellation notification cannot roll back the already committed generation fence", async () => {
    const {store,key} = await fixture(); const turn = await start(store,key);
    await assert.rejects(store.invalidate(key,1,nextSnapshot,async () => {throw new Error("notification lost");}),/notification lost/);
    const fresh = new TrustedContextStore(pool,application());
    await assert.rejects(fresh.dispatch(turn.claim,"late","read_context",{note:"late"},noAbort()),errorCode("stale"));
    await assert.rejects(fresh.invalidate(key,1,nextSnapshot),errorCode("conflict"));
    await fresh.finishRotation(key);
    assert.equal((await start(fresh,key)).claim.generation,2);
  });

  test("running, queued and concurrent submissions remain in one order across a rotation barrier", async () => {
    const {store,key} = await fixture(); const running = await start(store,key,"running");
    const queued = randomUUID(), concurrent = randomUUID();
    assert.equal(await store.submit(key,queued,"queued"),2);
    const [generation,position] = await Promise.all([
      store.invalidate(key,1,nextSnapshot),store.submit(key,concurrent,"concurrent"),
    ]);
    assert.equal(generation,2); assert.equal(position,3);
    await store.finishRotation(key);
    // Both submission lock orders must produce held work, never silently reuse old context.
    const rows = (await pool.query("SELECT request_id,position,phase FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1 ORDER BY position",[key.conversationId])).rows;
    assert.deepEqual(rows,[{request_id:running.claim.requestId,position:1,phase:"cancelled"},{request_id:queued,position:2,phase:"held"},{request_id:concurrent,position:3,phase:"held"}]);
    // Reauthorizing a later request first cannot let it overtake the earlier held turn.
    await store.releaseHeld(key,concurrent,"run");
    await assert.rejects(store.begin(key),errorCode("busy"));
    await store.releaseHeld(key,queued,"run");
    const second = await store.begin(key); assert.ok(second); assert.equal(second.claim.requestId,queued);
    await assert.rejects(store.begin(key),errorCode("busy"));
    await store.commit(second.claim,"second",{second:true});
    const third = await store.begin(key); assert.ok(third); assert.equal(third.claim.requestId,concurrent);
    await store.commit(third.claim,"third",{third:true});
    assert.equal(await store.begin(key),null);
    assert.equal(await store.submit(key,queued,"queued"),2);
  });

  test("a changed authorization blocks result release after an effect is durably complete", async () => {
    let releaseAllowed = false;
    const {store,key} = await fixture({authorize:async input => input.phase !== "release" || releaseAllowed});
    const turn = await start(store,key), note = randomUUID();
    await assert.rejects(store.dispatch(turn.claim,"effect","record_effect",{note},noAbort()),errorCode("denied"));
    const row = await callRow(turn.claim,"effect");
    assert.equal(row.outcome,"completed"); assert.equal(row.released,false); assert.equal(row.acknowledged,false);
    releaseAllowed = true;
    const result = await store.dispatch(turn.claim,"effect","record_effect",{note},noAbort());
    assert.equal(JSON.parse(result.text).receipt,row.operation_id);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.test_trusted_effects WHERE note=$1",[note])).rowCount,1);
  });

  test("invalidation between effect completion and result release retains outcome but rejects late native delivery", async t => {
    const afterEffect = gate(), finishEffect = gate();
    t.after(() => finishEffect.resolve());
    const app = application(); const ordinary = app.tools[1].execute;
    const {store,key} = await fixture({effect:async input => {
      const result = await ordinary(input); afterEffect.resolve(); await finishEffect.promise; return result;
    }});
    const turn = await start(store,key), note = randomUUID();
    const pending = store.dispatch(turn.claim,"effect","record_effect",{note},noAbort());
    // Attach the rejection handler before driving revocation to avoid unhandled rejection races.
    const rejected = assert.rejects(pending,(error:unknown) => error instanceof Error && "code" in error && ["stale","uncertain"].includes(String(error.code)));
    await afterEffect.promise;
    await store.invalidate(key,1,nextSnapshot);
    await assert.rejects(store.finishRotation(key),errorCode("busy"));
    finishEffect.resolve(); await rejected;
    const row = await callRow(turn.claim,"effect");
    assert.equal(row.released,false); assert.equal(row.acknowledged,false);
    assert.ok(["completed","uncertain"].includes(row.outcome));
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.test_trusted_effects WHERE note=$1",[note])).rowCount,1);
    await assert.rejects(store.acknowledge(turn.claim,"effect","record_effect"),errorCode("stale"));
    await store.finishRotation(key);
  });

  for (const mode of ["after-effect","after-dispatch"] as const) {
    test(`killing the execution ${mode} never repeats a committed fixture effect`, async () => {
      const {store,key} = await fixture(); const turn = await start(store,key), note = randomUUID();
      const child = fork(fileURLToPath(import.meta.url),["--fixture-effect-child"],{
        execArgv:[],stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,
          TRUSTED_TEST_CLAIM:JSON.stringify(turn.claim),TRUSTED_TEST_NOTE:note,TRUSTED_TEST_CRASH_MODE:mode},
      });
      let stderr = ""; child.stderr?.on("data",chunk => {stderr += chunk;});
      try {
        await Promise.race([
          once(child,"message"),
          once(child,"exit").then(([code]) => {throw new Error(`Fixture exited before crash boundary (${code}): ${stderr}`);}),
        ]);
        const exited = once(child,"exit"); child.kill("SIGKILL"); await exited;
      } finally {if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");}
      const fresh = new TrustedContextStore(pool,application());
      if (mode === "after-effect") {
        await assert.rejects(fresh.dispatch(turn.claim,"crash-call","record_effect",{note},noAbort()),errorCode("uncertain"));
        const recovery = await fresh.recover(key);
        assert.ok(recovery); assert.equal(recovery.requestId,turn.claim.requestId); assert.equal(recovery.outcome,"uncertain");
        assert.equal(recovery.receipts.length,1); assert.equal(recovery.receipts[0].outcome,"uncertain");
        assert.equal(recovery.receipts[0].acknowledged,false);
        assert.equal(recovery.receipts[0].operationId,(await callRow(turn.claim,"crash-call")).operation_id);
        assert.deepEqual(await fresh.recover(key,turn.claim.requestId),recovery);
        assert.deepEqual(await fresh.result(key,turn.claim.requestId),{phase:"uncertain",reply:null});
        await store.finishRotation(key);
        assert.equal((await callRow(turn.claim,"crash-call")).outcome,"uncertain");
      } else {
        const result = await fresh.dispatch(turn.claim,"crash-call","record_effect",{note},noAbort());
        assert.equal(JSON.parse(result.text).note,note);
        assert.equal((await callRow(turn.claim,"crash-call")).acknowledged,false);
        await fresh.acknowledge(turn.claim,"crash-call","record_effect");
      }
      assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.test_trusted_effects WHERE note=$1",[note])).rowCount,1);
    });
  }

  test("tool result bounds and deadlines leave explicit uncertain outcomes rather than retrying effects", async () => {
    const {store,key} = await fixture({read:async () => "x".repeat(300)});
    const turn = await start(store,key);
    await assert.rejects(store.dispatch(turn.claim,"large","read_context",{note:"ok"},noAbort()),errorCode("limit"));
    await assert.rejects(store.dispatch(turn.claim,"large","read_context",{note:"ok"},noAbort()),errorCode("uncertain"));
    assert.equal((await callRow(turn.claim,"large")).outcome,"uncertain");
    const app = application({read:async ({signal}) => {
      await new Promise<void>(resolve => signal.addEventListener("abort",()=>resolve(),{once:true}));
      return {late:true};
    }});
    app.tools[0].deadlineMs = 20;
    const deadlineStore = new TrustedContextStore(pool,app), deadlineKey = await newKey();
    await deadlineStore.open(deadlineKey,snapshot); const deadlineTurn = await start(deadlineStore,deadlineKey);
    await assert.rejects(deadlineStore.dispatch(deadlineTurn.claim,"late","read_context",{note:"ok"},noAbort()),errorCode("uncertain"));
    const deadlineRow = await callRow(deadlineTurn.claim,"late");
    assert.ok(["completed","uncertain"].includes(deadlineRow.outcome));
    assert.equal(deadlineRow.released,false); assert.equal(deadlineRow.acknowledged,false);
  });

  test("a noncooperative timed-out tool retains its durable lease until settlement", {timeout:10_000}, async t => {
    const entered = gate(), release = gate();
    t.after(() => release.resolve());
    const app = application({effect:async ({operationId}) => {entered.resolve(); await release.promise; return {receipt:operationId};}});
    // Include connection/admission latency without racing a 20ms budget on shared CI.
    app.tools[1].deadlineMs = 2_000;
    const store = new TrustedContextStore(pool,app), key = await newKey();
    await store.open(key,snapshot); const turn = await start(store,key);
    const pending = store.dispatch(turn.claim,"slow","record_effect",{note:"slow"},noAbort());
    const rejected = assert.rejects(pending,errorCode("uncertain"));
    await Promise.race([entered.promise,pending.then(
      () => {throw new Error("Fixture completed before its gate");},
      () => {throw new Error("Fixture deadline expired before callback admission");},
    )]);
    await rejected;
    await assert.rejects(store.recover(key),errorCode("busy"));
    await store.invalidate(key,1,nextSnapshot);
    await assert.rejects(store.finishRotation(key),errorCode("busy"));
    release.resolve();
    let drained = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {await store.finishRotation(key); drained = true; break;}
      catch (error) {if (!(error instanceof Error && "code" in error && error.code === "busy")) throw error;}
      await delay(10);
    }
    assert.equal(drained,true,"settled callback must eventually release its database lease");
    const row = await callRow(turn.claim,"slow");
    assert.equal(row.outcome,"completed"); assert.equal(row.released,false); assert.equal(row.acknowledged,false);
  });

  test("registered schemas and handlers are snapshotted against later application mutation", async () => {
    const app = application(); const store = new TrustedContextStore(pool,app), key = await newKey();
    app.tools[0].execute = async () => {throw new Error("mutated handler must not run");};
    app.tools[0].inputSchema = {type:"object"};
    app.tools[0].maxArgumentBytes = Infinity;
    await store.open(key,snapshot); const turn = await start(store,key);
    const result = await store.dispatch(turn.claim,"read","read_context",{note:"original"},noAbort());
    assert.deepEqual(JSON.parse(result.text),{scope:"private-a",note:"original"});
  });

  test("a callback surviving lease disconnect cannot repopulate erased tool contents", async t => {
    const entered = gate(), release = gate();
    t.after(() => release.resolve());
    const {store,key} = await fixture({effect:async () => {entered.resolve(); await release.promise; return {secret:"late private result"};}});
    const turn = await start(store,key);
    const pending = store.dispatch(turn.claim,"late-disconnected","record_effect",{note:"private"},noAbort());
    const rejected = assert.rejects(pending);
    await entered.promise;
    const {rows:leases} = await pool.query<{pid:number}>(`SELECT pid FROM pg_locks WHERE locktype='advisory'
      AND mode='ShareLock' AND granted AND objsubid=1
      AND ((classid::bigint << 32) | objid::bigint)=hashtextextended($1,71)`,[key.conversationId]);
    assert.equal(leases.length,1,"the effect must hold its standalone database admission lease");
    await pool.query("SELECT pg_terminate_backend($1)",[leases[0].pid]);
    await store.invalidate(key,1,nextSnapshot);
    let erased = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {await store.erase(key); erased = true; break;}
      catch (error) {if (!(error instanceof Error && "code" in error && error.code === "busy")) throw error;}
      await delay(10);
    }
    assert.equal(erased,true);
    release.resolve(); await rejected;
    // The callback settled, but cannot restore content after erasure's tombstone.
    const row = await callRow(turn.claim,"late-disconnected");
    assert.equal(row.result,null); assert.equal(row.released,false); assert.equal(row.acknowledged,false);
    const session = (await pool.query("SELECT phase,context_text,checkpoint FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rows[0];
    assert.deepEqual(session,{phase:"deleted",context_text:null,checkpoint:null});
  });

  test("erasure drains leases, removes stored contents and keeps replay tombstones", async () => {
    const {store,key} = await fixture(); const turn = await start(store,key,"secret prompt");
    await store.dispatch(turn.claim,"read","read_context",{note:"secret tool result"},noAbort());
    await store.commit(turn.claim,"secret reply",{secret:"private checkpoint"});
    await assert.rejects(store.erase(key),errorCode("conflict"));
    await store.invalidate(key,1,nextSnapshot);
    assert.deepEqual(await store.result(key,turn.claim.requestId),{phase:"completed",reply:null});
    const locations = await store.nativeStateForDeletion(key);
    assert.equal(locations.engine,"pi");
    assert.equal(locations.ownerId,key.ownerId);
    assert.deepEqual(locations.generations.map(g => g.generation),[1,2]);
    assert.equal(locations.generations[0].threadId,turn.threadId);
    assert.notEqual(locations.generations[1].threadId,turn.threadId);
    await store.erase(key);
    const s = (await pool.query("SELECT phase,context_text,checkpoint FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rows[0];
    assert.deepEqual(s,{phase:"deleted",context_text:null,checkpoint:null});
    const r = (await pool.query("SELECT phase,prompt,reply,prompt_digest FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1",[key.conversationId])).rows[0];
    assert.equal(r.phase,"cancelled"); assert.equal(r.prompt,null); assert.equal(r.reply,null);
    assert.equal(r.prompt_digest,createHash("sha256").update(canonical("secret prompt")).digest("hex"));
    assert.equal((await callRow(turn.claim,"read")).result,null);
    await assert.rejects(store.open(key,snapshot),errorCode("stale"));
    await assert.rejects(store.result(key,turn.claim.requestId),errorCode("stale"));
    await assert.rejects(store.submit(key,randomUUID(),"cannot resurrect"),errorCode("stale"));
  });
  test("application callback errors do not disclose credential-like diagnostics", async () => {
    const secret = "fixture-private-credential-" + randomUUID();
    const failed = await fixture({effect:async () => {throw new Error(secret);}});
    const turn = await start(failed.store,failed.key);
    await assert.rejects(failed.store.dispatch(turn.claim,"error","record_effect",{note:"ok"},noAbort()), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(secret));
      return (error as {code?:string}).code === "uncertain";
    });
    const denied = new TrustedContextStore(pool,application({authorize:async () => {throw new Error(secret);}}));
    await assert.rejects(denied.open(await newKey(),snapshot),errorCode("denied"));
    const row = await callRow(turn.claim,"error");
    assert.equal(row.outcome,"uncertain"); assert.equal(row.result,null);
  });

  test("native and effect leases cannot exhaust the single-slot control pool", {timeout:5_000}, async () => {
    const control = new Pool({connectionString:url,max:1});
    try {
      const store = new TrustedContextStore(control,application()), key = await newKey();
      await store.open(key,snapshot); const turn = await start(store,key);
      await store.admitted(turn.claim,noAbort(),async signal => {
        const result = await store.dispatch(turn.claim,"small-pool","read_context",{note:"ok"},signal);
        await store.acknowledge(turn.claim,"small-pool","read_context");
        await store.commit(turn.claim,result.text,{safe:true});
      });
      assert.equal((await store.result(key,turn.claim.requestId)).phase,"completed");
    } finally {await control.end();}
  });

}

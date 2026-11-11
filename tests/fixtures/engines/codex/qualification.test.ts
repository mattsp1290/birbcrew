import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { json } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { z } from "zod";
import { startProvider } from "./provider.mts";

const proposal = z.object({
  name:z.literal("record_work_item"),
  arguments:z.strictObject({operation_id:z.uuid(),note:z.literal("private fixture note")}),
  _meta:z.object({callId:z.string(),threadId:z.uuid()})
});

for (const decision of ["approve","deny","interrupt"] as const) {
  test("native Codex MCP " + decision, {timeout:45_000}, async t => {
    const root = await mkdtemp(join(tmpdir(),"birb-codex-tool-"));
    t.after(() => rm(root,{recursive:true,force:true}));
    const workspace = join(root,"workspace");
    await mkdir(workspace);
    const db = new DatabaseSync(join(root,"operations.sqlite"));
    t.after(() => db.close());
    db.exec("CREATE TABLE effects (operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)");
    const effects = () => db.prepare("SELECT receipt FROM effects").all().map(r => r.receipt);
    const provider = await startProvider();
    t.after(provider.close);
    const operation = randomUUID(), receipt = randomUUID();
    const pending = Promise.withResolvers<z.infer<typeof proposal>>();
    const answer = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
    let proposals = 0;
    const server = createServer(async (req,res) => {
      try {
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        const rpc = z.object({method:z.string(), id:z.union([z.string(),z.number()]).optional(),params:z.any().optional()}).parse(await json(req));
        const reply = (result:unknown) => res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
        if (rpc.id === undefined) { res.writeHead(202).end(); return; }
        if (rpc.method === "initialize") {
          reply({protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}); return;
        }
        if (rpc.method === "tools/list") {
          reply({tools:[{name:"record_work_item",description:"Record the proposed fixture work item",
            inputSchema:{type:"object",properties:{operation_id:{type:"string",enum:[operation]},note:{type:"string"}},
              additionalProperties:false,required:["operation_id","note"]}}]}); return;
        }
        if (rpc.method !== "tools/call") { reply({}); return; }
        const call = proposal.parse(rpc.params);
        assert.equal(call.arguments.operation_id,operation);
        proposals++;
        pending.resolve(call);
        res.once("close", () => disconnected.resolve());
        await Promise.race([answer.promise,disconnected.promise]);
        if (res.destroyed) return;
        if (decision === "approve") db.prepare("INSERT INTO effects VALUES (?,?)").run(operation,receipt);
        reply({content:[{type:"text",text:decision === "approve" ? String(effects()[0]) : "request denied"}],isError:decision !== "approve"});
      } catch (error) { pending.reject(error); res.destroy(); }
    });
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    t.after(async () => {
      const close = once(server,"close"); server.close(); server.closeAllConnections(); await close;
    });
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const endpoint = "http://127.0.0.1:" + addr.port;
    function worker(prompt:string, threadId?:string) {
      const child = fork(new URL("./qualification-worker.mts",import.meta.url),
        [root,workspace,provider.url,endpoint,prompt,...(threadId ? [threadId] : [])],
        {env:{PATH:process.env.PATH},detached:true,stdio:["ignore","ignore","inherit","ipc"]});
      const exit = once(child,"exit");
      const identity = once(child,"message").then(([value]) => z.object({threadId:z.uuid()}).parse(value).threadId);
      async function stop() {
        try { process.kill(-child.pid!, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
        await exit;
      }
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) await stop(); });
      return {exit,identity,stop,pid:child.pid!};
    }
    const first = worker("record " + operation);
    const [call,threadId] = await Promise.all([pending.promise,first.identity]);
    assert.equal(call._meta.threadId,threadId);
    assert.equal(call._meta.callId,"call_" + operation);
    assert.deepEqual(effects(),[]);
    if (decision === "interrupt") {
      await first.stop();
      await disconnected.promise;
      const second = worker("continue",threadId);
      assert.equal(await second.identity,threadId);
      assert.equal((await second.exit)[0],0);
    } else {
      answer.resolve();
      assert.equal((await first.exit)[0],0);
    }
    assert.equal(proposals,1);
    assert.deepEqual(effects(),decision === "approve" ? [receipt] : []);
    const outputs = provider.requests.flatMap(req => req.filter(i => i.type === "function_call_output" && i.call_id === call._meta.callId));
    assert.equal(outputs.length,1);
    assert.ok(JSON.stringify(outputs[0].output).includes(decision === "approve" ? receipt : decision === "deny" ? "request denied" : "aborted"));
    // The CLI and its worker share this fixture's process group.
    for (let i=0; i<50; i++) {
      try { process.kill(-first.pid,0); } catch { return; }
      await delay(20);
    }
    assert.fail("Codex process group is still present");
  });
}

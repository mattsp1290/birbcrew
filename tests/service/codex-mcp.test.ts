import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { serveNativeTool } from "../../src/service/codex-mcp.ts";
import { startProvider } from "../fixtures/engines/codex/provider.mts";

test("the native CLI authenticates and correlates its call at the invocation MCP endpoint", {timeout:30_000}, async t => {
  const id = randomUUID(), receipt = randomUUID();
  let threadId: string | undefined, calls = 0;
  const root = await mkdtemp(join(tmpdir(),"birb-codex-host-mcp-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const cwd = join(root,"workspace");
  await mkdir(cwd);
  const provider = await startProvider();
  t.after(provider.close);
  const server = await serveNativeTool("record_work_item",id,t.signal,async call => {
    assert.equal(call.nativeCallId,"call_" + id);
    assert.equal(call.threadId,threadId);
    assert.deepEqual(call.args,{operation_id:id,note:"private fixture note"});
    calls++;
    return {text:receipt,isError:false};
  });
  t.after(server.close);
  const {url,token} = server.endpoint;
  assert.equal((await fetch(url,{method:"POST",body:"{}"})).status,401);
  assert.equal((await fetch(url,{method:"POST",headers:{Authorization:"Bearer " + token,Origin:"https://example.invalid"},body:"{}"})).status,404);
  const codex = new Codex({env:{HOME:root,CODEX_HOME:root,PATH:process.env.PATH ?? "",BIRB_TOOL_TOKEN:token},
    config:{model_provider:"fixture", model_providers:{fixture:{name:"Fixture",base_url:provider.url,wire_api:"responses",supports_websockets:false}},
      mcp_servers:{birbcrew:{url,bearer_token_env_var:"BIRB_TOOL_TOKEN",enabled_tools:["record_work_item"],required:true,default_tools_approval_mode:"approve"}},
      features:{plugins:false}}});
  const thread = codex.startThread({workingDirectory:cwd,skipGitRepoCheck:true,sandboxMode:"read-only",approvalPolicy:"never"});
  const stream = await thread.runStreamed("record " + id,{signal:t.signal});
  let complete = false;
  for await (const event of stream.events) {
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "turn.completed") complete = true;
  }
  assert.equal(complete,true);
  const outputs = provider.requests.flat().filter(i => i.call_id === "call_" + id && i.type === "function_call_output");
  assert.equal(calls,1, JSON.stringify(outputs));
  assert.equal(outputs.length,1);
  assert.ok(JSON.stringify(outputs[0].output).includes(receipt));
});

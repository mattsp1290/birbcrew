import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTrustedNativeTurn } from "../../src/service/trusted-native.ts";
import type { TrustedNativeInput } from "../../src/service/trusted-native-types.ts";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";

test("trusted Claude pairs registered read/effect tools and fences changed native context",{timeout:120_000},async t=>{
  const observed:string[][]=[];
  const fixture=await startClaudeFixtureProvider(undefined,request=>{observed.push(request.tools);});
  t.after(fixture.close);
  const stateDir=await mkdtemp(join(tmpdir(),"birb-trusted-claude-"));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const tools=[
    {name:"choose_next_step",description:"Read the fixture recommendation",inputSchema:{type:"object",properties:{},additionalProperties:false},maxArgumentBytes:64,maxResultBytes:128,deadlineMs:3000},
    {name:"record_work_item",description:"Commit the fixture receipt",inputSchema:{type:"object",properties:{operation_id:{type:"string"},note:{type:"string"}},required:["operation_id"],additionalProperties:false},maxArgumentBytes:4096,maxResultBytes:1024,deadlineMs:3000},
  ];
  const acknowledgements:string[]=[],calls:string[]=[];
  const receiptId=randomUUID();
  const input:TrustedNativeInput={engine:"claude",threadId:randomUUID(),runId:randomUUID(),text:"next step",context:"PRIVATE-A",binding:"owner-a/scope-a/v1",checkpoint:null,signal:t.signal,tools,
    async dispatch(call) {
      calls.push(call.nativeCallId);
      if (call.toolName==="choose_next_step") {assert.deepEqual(call.args,{});return {text:"inspect",isError:false};}
      const args=call.args as {operation_id:string};
      return {text:JSON.stringify({kind:"recorded",nativeCallId:call.nativeCallId,receipt:{receiptId,operationId:args.operation_id}}),isError:false};
    },onToolDelivered(call){acknowledgements.push(call.nativeCallId);},
  };
  const profile={engine:"claude" as const,profile:{stateDir,memberId:randomUUID(),ownerId:"owner-a",model:"claude-sonnet-4-6",apiKey:"fixture",baseUrl:fixture.url}};
  const read=await runTrustedNativeTurn(input,profile);
  assert.equal(read.text,"selected inspect");
  assert.equal(calls.length,1);
  assert.deepEqual(acknowledgements,calls);
  const operationId=randomUUID();
  const effect=await runTrustedNativeTurn({...input,runId:operationId,text:"record "+operationId,checkpoint:read.checkpoint},profile);
  assert.equal(effect.text,"recorded "+receiptId);
  assert.equal(calls.length,2);
  assert.deepEqual(acknowledgements,calls);
  assert.ok(observed.length>=4);
  for (const names of observed) assert.deepEqual([...names].sort(),["mcp__ag_ui__choose_next_step","mcp__ag_ui__record_work_item"]);
  await assert.rejects(runTrustedNativeTurn({...input,runId:randomUUID(),context:"CHANNEL-B",binding:"owner-a/channel-b/v2",checkpoint:effect.checkpoint},profile),/scope or capabilities/);
});

import { assertOfflineNetwork } from "./offline-network.mts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { historyFromJSON, historyToJSON } from "@temporalio/common/proto-utils";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { MemberStore } from "../../src/service/store.ts";
import { MemberClient } from "../../src/service/client.ts";
import { progressActivity } from "../../src/service/progress-activity.ts";
import { activityQueue, memberTaskQueue } from "../../src/service/queues.ts";
import type { TurnRequest } from "../../src/service/domain.ts";
import { services, run, until } from "./member-services.mts";

const workflowsPath = fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url));
if (process.argv[2] === "offline-replay") {
  await assertOfflineNetwork();
  const manifest:{file:string;workflowId:string}[]=JSON.parse(await readFile(join(process.argv[3],"manifest.json"),"utf8"));
  assert.equal(manifest.length,4);
  for(const item of manifest) await Worker.runReplayHistory({workflowsPath},
    historyFromJSON(JSON.parse(await readFile(join(process.argv[3],item.file),"utf8"))),item.workflowId);
  console.log("Progress compatibility: old full-payload and new narrow-payload captured histories replayed offline.");
} else {
  const externalAddress=process.env.BIRBCREW_TEMPORAL_ADDRESS??process.env.TEMPORAL_ADDRESS;
  const externalDatabase=process.env.BIRBCREW_TEST_DATABASE_URL;
  if(Boolean(externalAddress)!==Boolean(externalDatabase))throw new Error("Provide both a disposable PostgreSQL URL and Temporal address, or neither");
  const directory=externalAddress?await mkdtemp(join(tmpdir(),"progress-compat-")):undefined;
  const s=externalAddress?{directory:directory!,env:{BIRBCREW_TEMPORAL_ADDRESS:externalAddress,BIRBCREW_DATABASE_URL:externalDatabase},
    startTemporal:async()=>{},close:async()=>{await rm(directory!,{recursive:true,force:true});}}:await services();
  const temporary=join(".proof","progress-compat-"+randomUUID());
  const running:{worker:Worker;done:Promise<void>}[]=[];
  let pool:Pool|undefined, connection:Connection|undefined, native:NativeConnection|undefined;
  const workflowIds:string[]=[];
  try {
    await s.startTemporal();
    pool=new Pool({connectionString:s.env.BIRBCREW_DATABASE_URL});
    const store=new MemberStore(pool); await store.migrate();
    connection=await Connection.connect({address:s.env.BIRBCREW_TEMPORAL_ADDRESS});
    native=await NativeConnection.connect({address:s.env.BIRBCREW_TEMPORAL_ADDRESS});
    const client=new Client({connection}), api=new MemberClient(store,client);
    let executions=0, oldFailures=0, compatibilityCalls=0;
    const profile="progress-compat.fixture";
    // A deterministic turn fixture, not an SDK simulation: real store begin/commit,
    // real Temporal activities and persisted receipts. No model/network inference.
    const executionWorker=await Worker.create({connection:native,taskQueue:activityQueue("pi",profile),activities:{
      executeTurn:async(request:TurnRequest)=>{
        const context=Context.current();
        const begin=await store.beginTurn(request,{workflowRunId:context.info.workflowExecution!.runId,
          activityId:context.info.activityId,attempt:context.info.attempt});
        if(begin.kind==="replay")return {kind:"complete",text:begin.reply};
        assert.equal(begin.kind,"start","Unexpected turn retry or uncertainty in progress-only fixture");
        if(begin.kind!=="start")throw new Error("Unexpected fixture turn state");
        executions++;
        const text="fixture reply "+request.requestId;
        await store.commitTurn({ownerId:request.ownerId,conversationId:request.conversationId,requestId:request.requestId,token:begin.token,reply:text,checkpoint:{version:1,engine:"pi",state:{fixture:true}}});
        return {kind:"complete",text};
      },
    }});
    const start=(worker:Worker)=>{const entry={worker,done:worker.run()};void entry.done.catch(()=>{});running.push(entry);return entry;};
    const stop=async(entry:typeof running[number])=>{if(entry.worker.getState()==="RUNNING")entry.worker.shutdown();await entry.done;};
    start(executionWorker);
    await mkdir(temporary,{recursive:true});
    // Exact pre-fix source from ea386e1196703aae21f2423d9b1e9d503a048774.
    // Only import paths change to materialize the immutable fixture in .proof.
    const oldSource=await readFile(new URL("./fixtures/legacy-progress-workflow.ts.txt",import.meta.url),"utf8");
    assert.ok(oldSource.includes("conversationProgress(conversation)"));
    assert.ok(!oldSource.includes("narrow-progress-key-v1"));
    const oldPath=join(temporary,"workflow.ts");
    await writeFile(oldPath,oldSource.replaceAll('from "./','from "../../src/service/'));
    const makeWorker=async(legacy:boolean)=>Worker.create({connection:native!,taskQueue:memberTaskQueue,
      workflowsPath:legacy?fileURLToPath(new URL("../../"+oldPath,import.meta.url)):workflowsPath,
      activities:{recordAcceptance:store.recordAcceptance.bind(store),rejectAccepted:store.rejectAccepted.bind(store),
        reconcileTurn:store.reconcileTurn.bind(store),
        conversationProgress:async(input:unknown)=>{
          if(legacy){
            try{return await store.conversationProgress(input as Parameters<MemberStore["conversationProgress"]>[0]);}
            catch(error){oldFailures++;throw error;}
          }
          if(typeof input==="object"&&input!==null&&"memberId" in input)compatibilityCalls++;
          return progressActivity(store)(input);
        },
      }});
    let workflowWorker=start(await makeWorker(true));
    const create=async()=>{
      const member=await store.spawn({ownerId:"progress-compat-owner",requestId:randomUUID(),engine:"pi",profile});
      const conversation=await api.open({ownerId:member.ownerId,memberId:member.memberId,conversationId:randomUUID()});
      const workflowId=`birbcrew-ts/member/${member.memberId}/conversation/${conversation.conversationId}`;
      workflowIds.push(workflowId);
      return {conversation,workflowId,runId:(await client.workflow.getHandle(workflowId).describe()).runId};
    };
    const submitFour=async(conversation:Awaited<ReturnType<typeof create>>["conversation"])=>{
      const requests=Array.from({length:4},()=>({ownerId:conversation.ownerId,conversationId:conversation.conversationId,
        requestId:randomUUID(),text:"progress fixture"}));
      for(const request of requests)assert.equal(await api.submit(request),"fixture reply "+request.requestId);
      return requests;
    };
    const legacy=await create(), prior=await submitFour(legacy.conversation);
    await until(async()=>oldFailures>0||undefined,"real strict-store rejection of historical full Conversation payload",20_000);
    assert.equal(executions,4);
    await stop(workflowWorker);
    workflowWorker=start(await makeWorker(false));
    await until(async()=>(await client.workflow.getHandle(legacy.workflowId,legacy.runId).describe()).status.name==="CONTINUED_AS_NEW"||undefined,
      "historical progress activity retry must succeed through compatibility adapter",45_000);
    assert.ok(compatibilityCalls>0,"Previously scheduled activity retained full payload on retry");
    assert.equal(executions,4,"Recovering progress must not re-run committed turns");
    for(const request of prior)assert.equal(await api.submit(request),"fixture reply "+request.requestId);
    assert.equal(executions,4,"Old request replay must not invoke the turn fixture again");
    const current=await create(); await submitFour(current.conversation);
    await until(async()=>(await client.workflow.getHandle(current.workflowId,current.runId).describe()).status.name==="CONTINUED_AS_NEW"||undefined,
      "new narrow progress key must pass the real PostgreSQL store",30_000);
    assert.equal(executions,8);
    const historyDir=join(s.directory,"progress-history");await mkdir(historyDir);
    const manifest:{file:string;workflowId:string}[]=[];
    for(const [index,item]of [legacy,current].entries()){
      const history=await client.workflow.getHandle(item.workflowId,item.runId).fetchHistory();
      const scheduled=history.events?.filter(event=>event.activityTaskScheduledEventAttributes?.activityType?.name==="conversationProgress")??[];
      assert.equal(scheduled.length,1,"Progress was retried, not replaced by new scheduling");
      const payload=scheduled[0].activityTaskScheduledEventAttributes!.input!.payloads![0];
      const actual=defaultPayloadConverter.fromPayload(payload) as Record<string,unknown>;
      assert.deepEqual(Object.keys(actual).sort(),index===0?["conversationId","engine","memberId","ownerId","profile"]:["conversationId","ownerId"]);
      const file=index+".json";await writeFile(join(historyDir,file),historyToJSON(history));manifest.push({file,workflowId:item.workflowId});
    }
    // A completed failure is a different recovery path: the adapter cannot revive it.
    // Reproduce the original60-second deadline, then exercise an explicit operator reset
    // at the workflow task that scheduled progress, retaining all completed turn events.
    for(const id of workflowIds)await client.workflow.getHandle(id).terminate("fixture parked generation cleanup");
    await stop(workflowWorker);
    workflowWorker=start(await makeWorker(true));
    const failed=await create(), failedRequests=await submitFour(failed.conversation);
    await until(async()=>(await client.workflow.getHandle(failed.workflowId,failed.runId).describe()).status.name==="FAILED"||undefined,
      "original progress schedule-to-close failure",85_000);
    assert.equal(executions,12);
    const failedHistory=await client.workflow.getHandle(failed.workflowId,failed.runId).fetchHistory();
    const progressEvent=failedHistory.events!.find(event=>event.activityTaskScheduledEventAttributes?.activityType?.name==="conversationProgress")!;
    const resetBoundary=progressEvent.activityTaskScheduledEventAttributes!.workflowTaskCompletedEventId!;
    assert.ok(resetBoundary,"Progress scheduling must reference a completed workflow task");
    await writeFile(join(historyDir,"failed.json"),historyToJSON(failedHistory));manifest.push({file:"failed.json",workflowId:failed.workflowId});
    await stop(workflowWorker);workflowWorker=start(await makeWorker(false));
    const reset=await connection.workflowService.resetWorkflowExecution({namespace:"default",
      workflowExecution:{workflowId:failed.workflowId,runId:failed.runId},workflowTaskFinishEventId:resetBoundary,
      requestId:randomUUID(),reason:"Fixture-only reviewed reset after completed progress failure",resetReapplyType:2});
    assert.ok(reset.runId);
    await until(async()=>(await client.workflow.getHandle(failed.workflowId,reset.runId!).describe()).status.name==="CONTINUED_AS_NEW"||undefined,
      "reset retains completed activities and reaches rollover",45_000);
    assert.equal(executions,12,"Operator reset must not repeat a committed execution");
    for(const request of failedRequests)assert.equal(await api.submit(request),"fixture reply "+request.requestId);
    assert.equal(executions,12);
    await writeFile(join(historyDir,"reset.json"),historyToJSON(await client.workflow.getHandle(failed.workflowId,reset.runId!).fetchHistory()));
    manifest.push({file:"reset.json",workflowId:failed.workflowId});
    await writeFile(join(historyDir,"manifest.json"),JSON.stringify(manifest));
    await stop(workflowWorker);await stop(running[0]);
    const replay=await run("unshare",["--user","--net",process.execPath,"tests/proof/progress-compatibility.mts","offline-replay",historyDir],
      {env:{PATH:process.env.PATH,HOME:s.directory,BIRBCREW_REPLAY_PARENT_NETNS:await readlink("/proc/self/ns/net")},timeout:180_000,maxBuffer:4*1024*1024});
    console.log(replay.stdout.trim());
    console.log(JSON.stringify({test:"progress-compatibility",oldStrictFailures:oldFailures,compatibilityCalls,committedTurns:executions,
      oldPayload:"full Conversation",newPayload:"strict conversationKey",closedFailureReset:true,reinference:0}));
  } catch(error){
    console.error("Progress compatibility failed. Expected4 committed turns before retry,8 after fresh run,12 after closed-run reset; no SDK/provider needed.");
    if(pool)console.error("Persisted fixture turns:",(await pool.query("SELECT position,phase,workflow_run_id FROM birbcrew_ts.turns ORDER BY conversation_id,position")).rows);
    throw error;
  } finally {
    for(const entry of running)if(entry.worker.getState()==="RUNNING")entry.worker.shutdown();
    await Promise.allSettled(running.map(entry=>entry.done));
    if(connection){const client=new Client({connection});for(const id of workflowIds)await client.workflow.getHandle(id).terminate("fixture cleanup").catch(()=>{});}
    await native?.close();await connection?.close();await pool?.end();await rm(temporary,{recursive:true,force:true});await s.close();
  }
}

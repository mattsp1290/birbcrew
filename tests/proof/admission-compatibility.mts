import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readlink, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { historyFromJSON, historyToJSON } from "@temporalio/common/proto-utils";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { MemberStore, ownerAdmissionActivity } from "../../src/service/store.ts";
import type { TurnRequest } from "../../src/service/domain.ts";
import { MemberClient } from "../../src/service/client.ts";
import { progressActivity } from "../../src/service/progress-activity.ts";
import { memberTaskQueue, activityQueue } from "../../src/service/queues.ts";
import { assertOfflineNetwork } from "./offline-network.mts";
import { services, run, until } from "./member-services.mts";

const workflowsPath=fileURLToPath(new URL("../../src/service/workflow.ts",import.meta.url));
if(process.argv[2]==="offline-replay"){
  await assertOfflineNetwork();
  const manifest:{file:string;workflowId:string}[]=JSON.parse(await readFile(join(process.argv[3],"manifest.json"),"utf8"));
  assert.equal(manifest.length,2);
  for(const item of manifest)await Worker.runReplayHistory({workflowsPath},historyFromJSON(JSON.parse(await readFile(join(process.argv[3],item.file),"utf8"))),item.workflowId);
  console.log("Admission acknowledgement-loss histories replayed without network or activities.");
}else{
  const address=process.env.BIRBCREW_TEMPORAL_ADDRESS??process.env.TEMPORAL_ADDRESS;
  const database=process.env.BIRBCREW_TEST_DATABASE_URL;
  if(Boolean(address)!==Boolean(database))throw new Error("Provide both disposable PostgreSQL and Temporal address, or neither");
  const directory=address?await mkdtemp(join(tmpdir(),"admission-compat-")):undefined;
  const s=address?{directory:directory!,env:{BIRBCREW_TEMPORAL_ADDRESS:address,BIRBCREW_DATABASE_URL:database},
    startTemporal:async()=>{},close:async()=>{await rm(directory!,{recursive:true,force:true});}}:await services();
  let pool:Pool|undefined,connection:Connection|undefined,native:NativeConnection|undefined;
  const running:{worker:Worker;done:Promise<void>}[]=[];
  const workflows:string[]=[];
  let executions=0;
  try{
    await s.startTemporal();pool=new Pool({connectionString:s.env.BIRBCREW_DATABASE_URL});
    const store=new MemberStore(pool);await store.migrate();
    connection=await Connection.connect({address:s.env.BIRBCREW_TEMPORAL_ADDRESS});
    native=await NativeConnection.connect({address:s.env.BIRBCREW_TEMPORAL_ADDRESS});
    const temporal=new Client({connection}),api=new MemberClient(store,temporal);
    const profile="admission-compat.fixture";
    const start=(worker:Worker)=>{const entry={worker,done:worker.run()};void entry.done.catch(()=>{});running.push(entry);return entry;};
    const stop=async(entry:typeof running[number])=>{if(entry.worker.getState()==="RUNNING")entry.worker.shutdown();await entry.done;};
    start(await Worker.create({connection:native,taskQueue:activityQueue("pi",profile),activities:{
      executeTurn:async()=>{executions++;throw new Error("BUG: unacknowledged admission invoked execution");},
    }}));
    const historyDir=join(s.directory,"admission-history");await mkdir(historyDir);
    const manifest:{file:string;workflowId:string}[]=[];
    for(const reconciliationOutage of [false,true]){
      let committedAdmissions=0,reconciliationAttempts=0;
      const worker=start(await Worker.create({connection:native,taskQueue:memberTaskQueue,workflowsPath,activities:{
        recordAcceptance:async(request:TurnRequest)=>{
          await ownerAdmissionActivity(store)(request);committedAdmissions++;
          // The write is real and durable. Only the activity acknowledgement is lost.
          // Retrying must not turn the durable accepted row into executable work.
          throw new Error("Injected loss after committed admission");
        },
        rejectUnstartedAdmission:async(...args:Parameters<MemberStore["rejectUnstartedAdmission"]>)=>{
          reconciliationAttempts++;
          if(reconciliationOutage)throw new Error("Injected final-reconciliation storage outage");
          return store.rejectUnstartedAdmission(...args);
        },
        rejectAccepted:store.rejectAccepted.bind(store),conversationProgress:progressActivity(store),
        reconcileTurn:store.reconcileTurn.bind(store),
      }}));
      const member=await store.spawn({ownerId:"admission-compat-owner",requestId:randomUUID(),engine:"pi",profile});
      const conversation=await api.open({ownerId:member.ownerId,memberId:member.memberId,conversationId:randomUUID()});
      const workflowId=`birbcrew-ts/member/${member.memberId}/conversation/${conversation.conversationId}`;workflows.push(workflowId);
      const firstRun=(await temporal.workflow.getHandle(workflowId).describe()).runId;
      const key={ownerId:conversation.ownerId,conversationId:conversation.conversationId,requestId:randomUUID()};
      const request={...key,text:"must never invoke a provider"};
      const rejected=assert.rejects(api.accept(request));void rejected.catch(()=>{});
      await until(async()=>committedAdmissions>0||undefined,"real admission committed before acknowledgement failure",20_000);
      assert.equal((await store.requestStatus(key)).phase,"accepted","Reproduce durable acceptance before lost acknowledgement");
      await until(async()=>(await temporal.workflow.getHandle(workflowId,firstRun).describe()).status.name==="FAILED"||undefined,
        "admission and terminal-reconciliation retry budgets must expire",160_000);
      await rejected;
      assert.ok(committedAdmissions>1,"Exercise real Temporal activity retries, not only a thrown callback");
      assert.ok(reconciliationAttempts>0,"Workflow attempted terminal reconciliation");
      assert.equal(executions,0);
      const raw=await store.requestStatus(key);
      assert.equal(raw.phase,reconciliationOutage?"accepted":"rejected");
      // New client and store instances, simulating gateway restart. In the outage
      // case this read must repair the retained admission only after observing the
      // terminal logical workflow and proving that no turn ever began.
      const fresh:MemberClient=new MemberClient(new MemberStore(pool),new Client({connection}));
      const status:Awaited<ReturnType<MemberClient["requestStatus"]>>=await fresh.requestStatus(key);
      assert.equal(status.phase,"rejected");
      assert.equal(status.reason,"admission_unconfirmed","Terminal rejection must explain why no execution happened");
      assert.deepEqual(await fresh.requestStatus(key),status,"Repeated status is stable");
      assert.deepEqual(await store.requestStatus(key),status,"Terminal repair is durable, not merely a projected response");
      await assert.rejects(fresh.accept(request),error=>Boolean(error&&typeof error==="object"&&"code"in error&&error.code==="request_rejected"));
      await assert.rejects(fresh.submit(request),error=>Boolean(error&&typeof error==="object"&&"code"in error&&error.code==="request_rejected"));
      const countResult:{rows:{count:number}[]}=await pool.query<{count:number}>("SELECT count(*)::integer AS count FROM birbcrew_ts.turns WHERE conversation_id=$1",[key.conversationId]);
      assert.equal(countResult.rows[0].count,0,"No native turn/effect exists for the lost admission");
      assert.equal(executions,0);
      assert.equal((await temporal.workflow.getHandle(workflowId).describe()).runId,firstRun,"Reads and duplicate submissions must not restart the workflow");
      const file=manifest.length+".json";await writeFile(join(historyDir,file),historyToJSON(await temporal.workflow.getHandle(workflowId,firstRun).fetchHistory()));manifest.push({file,workflowId});
      await stop(worker);
      console.log(JSON.stringify({test:"admission-ack-loss",reconciliationOutage,committedAdmissions,reconciliationAttempts,phase:status.phase,reason:status.reason,executions}));
    }
    await stop(running[0]);await writeFile(join(historyDir,"manifest.json"),JSON.stringify(manifest));
    const replay=await run("unshare",["--user","--net",process.execPath,"tests/proof/admission-compatibility.mts","offline-replay",historyDir],
      {env:{PATH:process.env.PATH,HOME:s.directory,BIRBCREW_REPLAY_PARENT_NETNS:await readlink("/proc/self/ns/net")},timeout:180_000,maxBuffer:4*1024*1024});
    console.log(replay.stdout.trim());
  }catch(error){console.error("Admission compatibility failed: expected accepted SQL row, exhausted acknowledgement retries, terminal rejection, and zero executeTurn calls.",{executions});throw error;
  }finally{
    for(const entry of running)if(entry.worker.getState()==="RUNNING")entry.worker.shutdown();await Promise.allSettled(running.map(entry=>entry.done));
    if(connection){const client=new Client({connection});for(const id of workflows)await client.workflow.getHandle(id).terminate("fixture cleanup").catch(()=>{});}
    await native?.close();await connection?.close();await pool?.end();await s.close();
  }
}

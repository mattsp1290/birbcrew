import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { service, until } from "./observer-host.ts";

test("three simultaneously streaming SDK members cancel independently and close both observers", {timeout:100_000}, async t => {
  const host = await service(t);
  const cases = await Promise.all(["claude","pi","codex"].map(async engine => {
    const {memberId} = await host.post("/members",{engine,profile:"fixture.v1",requestId:randomUUID()});
    const conversationId=randomUUID(), requestId=randomUUID(), path="/conversations/" + conversationId;
    await host.post("/conversations",{memberId,conversationId});
    const first=host.attach(conversationId);
    await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
    await host.post(path+"/inputs",{requestId,text:"wait"});
    await until(async () => first.events.some(e => e.type === "TEXT_MESSAGE_CONTENT") || undefined);
    const second=host.attach(conversationId);
    await until(async () => second.agent.messages.some(m => m.role === "assistant") || undefined);
    return {engine,path,conversationId,requestId,readers:[first,second]};
  }));
  for (const [index, member] of cases.entries()) {
    const {requestId,conversationId,path,readers} = member;
    await host.post(path+"/cancel",{requestId});
    await host.post(path+"/cancel",{requestId});
    await Promise.all(readers.map(r => r.done));
    const end = await (await host.api(path)).json();
    assert.equal(end.state.phase,"cancelled");
    for (const reader of readers) {
      assert.equal(reader.events.at(-1)?.type,"RUN_FINISHED");
      assert.deepEqual(reader.agent.messages,end.messages);
    }
    assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND NOT stopped",[conversationId])).rowCount,0);
    for (const other of cases.slice(index+1)) {
      assert.equal((await (await host.api(other.path)).json()).state.phase,"running");
      assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND NOT stopped",[other.conversationId])).rowCount,1);
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ApplicationFailure, WorkflowUpdateFailedError, type Client } from "@temporalio/client";
import { MemberClient } from "../../src/service/client.ts";
import type { MemberStore } from "../../src/service/store.ts";
import type { Conversation } from "../../src/service/domain.ts";

function fixture(reply?: string) {
  const conversation: Conversation = { ownerId:"owner", memberId:randomUUID(), conversationId:randomUUID(), engine:"pi", profile:"test" };
  const request = {ownerId:conversation.ownerId,conversationId:conversation.conversationId,requestId:randomUUID(),text:"hello"};
  const routes: unknown[][] = [];
  const calls: string[] = [];
  let failures = 0;
  const store = {getConversation:async () => conversation, workflowRunId:async () => "persisted-first-run", committedReply:async () => reply} as unknown as MemberStore;
  const temporal = { workflow:{ getHandle:(...args:unknown[]) => {
    routes.push(args);
    return {executeUpdate: async (name:string) => {
      calls.push(name);
      if (failures++ === 0) throw new WorkflowUpdateFailedError("rejected", ApplicationFailure.nonRetryable("rolling", "RolloverInProgress"));
      return name === "acceptTurn" ? request.requestId : "reply";
    }};
  }}} as unknown as Client;
  return {client:new MemberClient(store,temporal), request,routes,calls};
}

test("admission retries only rollover rejection and routes by logical workflow, never stored first run", async () => {
  const f=fixture();
  assert.deepEqual(await f.client.accept(f.request),{requestId:f.request.requestId});
  assert.deepEqual(f.calls,["acceptTurn","acceptTurn"]);
  assert.equal(f.routes.length,2);
  for (const args of f.routes) assert.equal(args.length,1);
});

test("synchronous submission follows rollover to latest run", async () => {
  const f=fixture();
  assert.equal(await f.client.submit(f.request),"reply");
  assert.deepEqual(f.calls,["submitTurn","submitTurn"]);
  for (const args of f.routes) assert.equal(args.length,1);
});

test("earlier generation committed requests never address a workflow", async () => {
  const f=fixture("committed");
  assert.equal(await f.client.submit(f.request),"committed");
  assert.deepEqual(await f.client.accept(f.request),{requestId:f.request.requestId});
  assert.deepEqual(f.routes,[]);
});

test("unknown accepted-update outcomes are not retried", async () => {
  const f=fixture();
  const store = {getConversation:async () => ({}), workflowRunId:async () => "run", committedReply:async () => undefined} as unknown as MemberStore;
  let calls=0;
  const error = new Error("transport lost after acceptance");
  const temporal={workflow:{getHandle:()=>({executeUpdate:async()=>{calls++;throw error;}})}} as unknown as Client;
  await assert.rejects(new MemberClient(store,temporal).accept(f.request),error);
  assert.equal(calls,1);
});

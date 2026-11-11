import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {EventType as E, type Event, type RunAgentInput} from "@ag-ui/core";
import { Observable } from "rxjs";
import { startProvider } from "./provider.mts";
import { fixtureThread } from "./sdk.mts";

export async function createFixture(onFailure: () => void) {
  const provider = await startProvider(onFailure);
  const root = await mkdtemp(join(tmpdir(), "birb-codex-chat-"));
  const sessions = new Map<string,string>();
  return {
    run({threadId,runId,messages}: RunAgentInput, signal: AbortSignal) {
      return new Observable<Event>(subscriber => {
        async function respond() {
          subscriber.next({type:E.RUN_STARTED,threadId,runId});
          const prompt = messages.at(-1)?.content;
          if (typeof prompt !== "string") throw new Error("Invalid fixture prompt");
          const home = join(root,threadId), workspace = join(home,"workspace");
          await mkdir(workspace,{recursive:true});
          const thread = fixtureThread(home,workspace,provider.url,sessions.get(threadId));
          let completed = false;
          for await (const e of (await thread.runStreamed(prompt,{signal})).events) {
            if (e.type === "thread.started") {
              const previous = sessions.get(threadId);
              if (previous && previous !== e.thread_id) throw new Error("Changed native thread");
              sessions.set(threadId,e.thread_id);
            }
            if (e.type === "item.completed" && e.item.type === "agent_message") {
              const messageId = runId + "/" + e.item.id;
              subscriber.next({type:E.TEXT_MESSAGE_START,messageId,role:"assistant"});
              subscriber.next({type:E.TEXT_MESSAGE_CONTENT,messageId,delta:e.item.text});
              subscriber.next({type:E.TEXT_MESSAGE_END,messageId});
            }
            if (e.type === "turn.completed") completed = true;
            if (e.type === "error" || e.type === "turn.failed") throw new Error("Native turn failed");
          }
          if (!completed) throw new Error("Incomplete Codex turn");
          subscriber.next({type:E.RUN_FINISHED,threadId,runId});
        }
        void respond().catch(() => subscriber.next({type:E.RUN_ERROR,message:signal.aborted ? "Cancelled" : "Native turn failed"}))
          .finally(() => subscriber.complete());
      });
    },
    async close() { await provider.close(); await rm(root,{recursive:true,force:true}); }
  };
}

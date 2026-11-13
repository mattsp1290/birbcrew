import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { PiProfile } from "./pi.ts";
import { runPiWorker } from "./pi-launch.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";

const stateSchema=z.strictObject({sessionId:z.uuid(),messages:z.array(z.json()).max(256)});
const workerTurn=z.strictObject({text:z.string().min(1).refine(text=>Buffer.byteLength(text)<=65536),checkpoint:stateSchema});

/** The SDK runs in a confined worker; registered tools still run here, through input.dispatch. */
export async function runTrustedPi(input:TrustedNativeInput,profile:PiProfile) {
  const {text,context,checkpoint,tools}=input;
  // trusted-native.ts allows 16 tool calls; each result and the final reply need a model request.
  const {result}=await runPiWorker({kind:"trusted",instructions:profile.instructions,input:{text,context,checkpoint,tools}},
    {profile,signal:input.signal,modelRequests:17,onText:input.onText,dispatch:input.dispatch,onToolDelivered:input.onToolDelivered});
  return workerTurn.parse(result);
}

type SessionInput=Pick<TrustedNativeInput,"text"|"context"|"checkpoint"|"tools"|"signal"|"dispatch"|"onText"|"onToolDelivered">;
/** Runs only inside the confined worker (pi-worker.ts). */
export async function runTrustedSession(input:SessionInput,profile:PiProfile) {
  const state=input.checkpoint === null ? {sessionId:randomUUID(),messages:[]} : stateSchema.parse(input.checkpoint);
  const cwd=await mkdtemp(join(tmpdir(),"birb-trusted-pi-"));
  const prepared=await profile.prepare?.();
  try {
    const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,provider:{maxRetries:0}},cacheWarming:"off"});
    const resourceLoader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,
      noPromptTemplates:true,noContextFiles:true,noThemes:true,systemPrompt:profile.instructions ?? "You are a BirbCrew coworker.",
      appendSystemPrompt:[input.context],extensionFactories:prepared?[prepared.extension]:[]});
    await resourceLoader.reload();
    const loaded=resourceLoader.getExtensions();
    if(loaded.errors.length || loaded.extensions.length !== Number(!!prepared) || loaded.extensions.some((e,i)=>e.path!==`<inline:${i+1}>`)) throw new Error("Unexpected trusted Pi extension");
    const sessionManager=SessionManager.inMemory(cwd,{id:state.sessionId});
    for(const message of state.messages) sessionManager.appendMessage(message as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    const completed=new Map<string,string>();
    const customTools:ToolDefinition[]=input.tools.map(tool=>({name:tool.name,label:tool.name,description:tool.description,
      parameters:tool.inputSchema as ToolDefinition["parameters"],
      async execute(id,args,_signal) {
        const result=await input.dispatch({nativeCallId:id,toolName:tool.name,args,signal:AbortSignal.any([input.signal,...(_signal?[_signal]:[])])});
        completed.set(id,tool.name);
        if(result.isError) throw new Error(result.text);
        return {content:[{type:"text",text:result.text}],details:{isError:result.isError}};
      }}));
    const {session}=await createAgentSession({model:profile.model,modelRuntime:profile.modelRuntime,cwd,agentDir:cwd,
      resourceLoader,settingsManager,sessionManager,tools:input.tools.map(t=>t.name),customTools,thinkingLevel:"off"});
    let failure:unknown;let text="";const publications:Promise<void>[]=[];
    const stop=()=>{void session.abort();};
    const publish=(action:()=>void|Promise<void>)=>publications.push(Promise.resolve().then(action).catch(error=>{failure=error;stop();}));
    const unsubscribe=session.subscribe(event=>{
      try {
        if(event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const delta=event.assistantMessageEvent.delta;text+=delta;
          if(Buffer.byteLength(text)>65536)throw new Error("Trusted Pi response exceeded bound");
          if(input.onText)publish(()=>input.onText!(delta));
        }
        if(event.type === "message_end" && event.message.role === "toolResult") {
          const name=completed.get(event.message.toolCallId);
          if(!name || name !== event.message.toolName)throw new Error("Unpaired trusted Pi result");
          completed.delete(event.message.toolCallId);
          if(input.onToolDelivered)publish(()=>input.onToolDelivered!({nativeCallId:(event.message as {toolCallId:string}).toolCallId,toolName:name}));
        }
      } catch(error) {failure=error;stop();}
    });
    try {
      const expected=input.tools.map(t=>t.name).sort();
      if(JSON.stringify(session.getActiveToolNames().sort())!==JSON.stringify(expected))throw new Error("Unexpected trusted Pi tool catalog");
      input.signal.addEventListener("abort",stop,{once:true});input.signal.throwIfAborted();
      await session.prompt(input.text,{expandPromptTemplates:false});await session.waitForIdle();
      await Promise.all(publications);input.signal.throwIfAborted();if(failure)throw failure;
      const messages=sessionManager.getEntries().flatMap(e=>e.type === "message"?[e.message]:[]);
      const last=messages.at(-1);
      if(!text || completed.size || last?.role !== "assistant" || last.stopReason !== "stop")throw new Error("Trusted Pi turn did not complete");
      prepared?.verify();
      return {text,checkpoint:stateSchema.parse({sessionId:state.sessionId,messages:JSON.parse(JSON.stringify(messages))})};
    } finally {input.signal.removeEventListener("abort",stop);unsubscribe();session.dispose();}
  } finally {await rm(cwd,{recursive:true,force:true});}
}

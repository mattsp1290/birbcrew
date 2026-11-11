import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runCodexTurn, type CodexProfile } from "./codex.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";

const hash = (value: string) => createHash("sha256").update(value).digest();
const correlation = z.object({callId:z.string().min(1).max(256),threadId:z.uuid()});
export async function runTrustedCodex(input: TrustedNativeInput, profile: CodexProfile) {
  const token = randomBytes(32).toString("base64url");
  const auth = hash("Bearer " + token);
  const nativeThread = Promise.withResolvers<string>();
  // Each result carries its native call identity inside the text envelope as
  // well as the MCP transport correlation. SDK item completion must match it.
  const pending = new Map<string,{nativeCallId:string;toolName:string}>();
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal,controller.signal]);
  const server = createServer(async (req,res) => {
    if (!timingSafeEqual(auth,hash(req.headers.authorization ?? ""))) {res.writeHead(401).end();return;}
    if (req.method !== "POST" || req.url !== "/mcp" || req.headers.origin) {res.writeHead(404).end();return;}
    const disconnected = new AbortController();
    res.once("close",() => {if (!res.writableFinished) disconnected.abort();});
    const mcp = new Server({name:"birbcrew",version:"1"},{capabilities:{tools:{}}});
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once("close",() => void mcp.close().catch(()=>{}));
    mcp.setRequestHandler(ListToolsRequestSchema,async () => ({tools:input.tools.map(t => ({name:t.name,description:t.description,inputSchema:t.inputSchema as {type:"object"}}))}));
    mcp.setRequestHandler(CallToolRequestSchema,async (request,extra) => {
      const meta = correlation.parse(extra._meta);
      const thread = await Promise.race([nativeThread.promise,new Promise<never>((_,reject)=>{
        const timer = setTimeout(()=>reject(new Error("Native thread not established")),5000); timer.unref();
      })]);
      if (meta.threadId !== thread || !input.tools.some(t => t.name === request.params.name)) throw new Error("Unregistered native call");
      const result = await input.dispatch({nativeCallId:meta.callId,toolName:request.params.name,args:request.params.arguments,
        signal:AbortSignal.any([signal,disconnected.signal,extra.signal])});
      // Plain-text payload remains JSON so the native application sees the
      // receipt plus explicit correlation without a provider-specific marker.
      const text = JSON.stringify({nativeCallId:meta.callId,toolName:request.params.name,result:result.text});
      pending.set(text,{nativeCallId:meta.callId,toolName:request.params.name});
      return {isError:result.isError,content:[{type:"text",text}]};
    });
    try {
      let length=0; const bytes:Buffer[]=[];
      for await (const chunk of req) {length+=chunk.length;if(length>131072){res.writeHead(413).end();return;}bytes.push(chunk);}
      await mcp.connect(transport);
      await transport.handleRequest(req,res,JSON.parse(Buffer.concat(bytes).toString("utf8")));
    } catch {controller.abort();if(!res.headersSent)res.writeHead(400);res.end();}
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address();if(!address||typeof address === "string")throw new Error("Native tool server failed");
  try {
    const result=await runCodexTurn({threadId:input.threadId,runId:input.runId,text:input.text,checkpoint:input.checkpoint,
      signal,projectContext:input.context,onText:input.onText,onThreadStarted:id=>{nativeThread.resolve(id);},
      ...(input.tools.length ? {mcp:{url:`http://127.0.0.1:${address.port}/mcp`,token,registeredTools:input.tools.map(t=>t.name)}} : {}),
      async onToolDelivered(text) {
        const call=pending.get(text);if(!call)throw new Error("Native result did not match its dispatch");
        await input.onToolDelivered?.(call);pending.delete(text);
      }},profile);
    if(pending.size)throw new Error("Native SDK did not confirm tool results");
    return result;
  } finally {controller.abort();const closed=once(server,"close");server.close();server.closeAllConnections();await closed;}
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DeferredTool } from "./deferral.ts";

export interface NativeToolEndpoint { url: string; token: string; tool: DeferredTool }
type NativeToolCall = {
  nativeCallId: string; threadId: string; toolName: DeferredTool; args: unknown; signal: AbortSignal;
};

const correlation = z.object({callId: z.string().min(1).max(256), threadId: z.uuid()});
const digest = (value: string) => createHash("sha256").update(value).digest();

export async function serveNativeTool(
  tool: DeferredTool, operationId: string, signal: AbortSignal,
  invoke: (call: NativeToolCall) => Promise<{text: string; isError: boolean}>,
) {
  const token = randomBytes(32).toString("base64url");
  const authorization = digest("Bearer " + token);
  const server = createServer(async (req, res) => {
    if (!timingSafeEqual(authorization, digest(req.headers.authorization ?? ""))) { res.writeHead(401).end(); return; }
    if (req.url !== "/mcp" || req.headers.origin) { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const disconnected = new AbortController();
    res.once("close", () => { if (!res.writableFinished) disconnected.abort(); });
    const mcp = new McpServer({name:"birbcrew",version:"1"});
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once("close", () => void mcp.close().catch(() => {}));
    try {
      const schema = tool === "record_work_item" ? z.strictObject({
        operation_id:z.literal(operationId), note:z.string().max(4096).optional(),
      }) : z.strictObject({});
      mcp.registerTool(tool, {description:tool === "record_work_item" ? "Ask the owner to record a work item." : "Ask the owner to choose the next step.",
        inputSchema:schema}, async (args, extra) => {
        const meta = correlation.safeParse(extra._meta);
        if (!meta.success) return {isError:true,content:[{type:"text",text:"Missing native tool correlation."}]};
        const result = await invoke({nativeCallId:meta.data.callId,threadId:meta.data.threadId,toolName:tool,args,
          signal:AbortSignal.any([signal,disconnected.signal,extra.signal])});
        return {isError:result.isError,content:[{type:"text",text:result.text}]};
      });
      const bytes: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 32_768) {res.writeHead(413).end(); return;}
        bytes.push(chunk);
      }
      await mcp.connect(transport);
      await transport.handleRequest(req,res,JSON.parse(Buffer.concat(bytes).toString("utf8")));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native tool endpoint could not start");
  return {
    endpoint:{url:"http://127.0.0.1:" + address.port + "/mcp",token,tool} satisfies NativeToolEndpoint,
    async close() {
      const closed = once(server,"close");
      server.close(); server.closeAllConnections(); await closed;
    }
  };
}

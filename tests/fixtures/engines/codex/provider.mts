import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { json } from "node:stream/consumers";
import { z } from "zod";

const providerInput = z.object({ tools: z.array(z.looseObject({type:z.string(),name:z.string().optional()})).default([]), input: z.array(z.looseObject({
  role: z.string().optional(), type: z.string(), call_id: z.string().optional(), output: z.unknown().optional(),
  content: z.unknown().optional(),
})) });
const textParts = z.array(z.object({ type: z.literal("input_text"), text: z.string() }));
type InputItem = z.infer<typeof providerInput>["input"][number];

function send(response: ServerResponse, type: string, value: Record<string, unknown>) {
  response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...value }) + "\n\n");
}

export async function startProvider(onFailure = () => {}) {
  const toolSurfaces: z.infer<typeof providerInput>["tools"][] = [];
  const requests: InputItem[][] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/responses") {
        response.writeHead(404).end(); return;
      }
      const {input,tools} = providerInput.parse(await json(request));
      toolSurfaces.push(tools);
      requests.push(input);
      const prompts = input.filter(i => i.role === "user").flatMap(i => {
        const parts = textParts.safeParse(i.content);
        return parts.success ? parts.data.map(p => p.text) : [];
      });
      const prompt = prompts.at(-1);
      const memory = prompts.findLast(text => text.startsWith("remember "))?.slice(9);
      const id = "resp_" + randomUUID();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      send(response, "response.created", { response: { id } });
      if (prompt === "fail") {
        onFailure();
        send(response, "response.failed", { response: { id, error: { code: "invalid_request_error", message: "Fixture failure" } } });
        response.end(); return;
      }
      const output = input.findLast(i => i.type === "function_call_output");
      if (prompt?.startsWith("record ") && !output) {
        const operation = prompt.slice(7);
        const namespace = tools.find(tool => tool.name?.startsWith("mcp__"))?.name;
        if (!namespace) throw new Error("Fixture MCP namespace missing");
        send(response, "response.output_item.done", { item: {
          type:"function_call", call_id:"call_" + operation, namespace,
          name:"record_work_item", arguments:JSON.stringify({operation_id:operation, note:"private fixture note"})
        } });
      } else {
        let text: string;
        if (output) text = "settled " + JSON.stringify(output.output);
        else if (prompt?.startsWith("remember ")) text = "stored " + memory;
        else if (prompt === "recall") text = "recalled " + (memory ?? "none");
        else if (prompt === "wait") text = "waiting";
        else throw new Error("Unexpected Codex fixture input");
        send(response, "response.output_item.done", { item: { type:"message", id:"msg_" + randomUUID(),
          role:"assistant", phase:prompt === "wait" ? "commentary" : "final_answer", content:[{type:"output_text", text}] } });
        if (prompt === "wait") return;
      }
      send(response, "response.completed", { response: { id, usage: { input_tokens:0, output_tokens:0, total_tokens:0 } } });
      response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider failed to bind");
  return {url:"http://127.0.0.1:" + address.port, requests, toolSurfaces, async close() {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  }};
}

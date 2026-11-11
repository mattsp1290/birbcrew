import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAgentInput } from "@ag-ui/core";
import { ClaudeAgentAdapter, type SessionBinding, type SessionRecoveryConfig } from "@ag-ui/claude-agent-sdk";
import { InMemorySessionStore, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { defer, finalize } from "rxjs";

const model = "claude-sonnet-4-6";

const providerRequest = z.object({
  tools: z.array(z.object({ name: z.string() })).default([]),
  messages: z.array(z.object({
    role: z.enum(["assistant", "user"]),
    content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
  })),
});

type ObserveRequest = (request: { prompt?: string; tools: string[] }) => void;

async function respond(
  request: IncomingMessage, response: ServerResponse, onProviderFailure: () => void, observe?: ObserveRequest,
) {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/v1/messages/count_tokens") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
    return;
  }
  if (request.method !== "POST" || path !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }

  const { messages, tools } = providerRequest.parse(await json(request));
  const prompts = messages.filter((message) => message.role === "user").flatMap(({ content }) =>
    typeof content === "string" ? [content] : content.flatMap((part) => part.type === "text" && part.text ? [part.text] : []),
  );
  const prompt = prompts.at(-1);
  observe?.({ prompt, tools: tools.map((tool) => tool.name) });
  const remembered = prompts.findLast((text) => text.startsWith("remember "))?.slice(9);
  let reply;
  if (prompt?.startsWith("remember ")) reply = `stored ${remembered}`;
  else if (prompt === "recall") reply = `recalled ${remembered ?? "none"}`;
  else if (prompt === "wait") reply = "waiting";
  else {
    if (prompt === "fail") onProviderFailure();
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
      type: "error", error: { type: "invalid_request_error", message: "Scripted provider failure" },
    }));
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
  if (prompt === "wait") return;
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", {});
  response.end();
}

export async function startClaudeFixtureProvider(onProviderFailure = () => {}, observe?: ObserveRequest) {
  const server = createServer((req, res) => {
    respond(req, res, onProviderFailure, observe).catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a localhost TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function createFixture(onProviderFailure: () => void) {
  const cwd = await mkdtemp(join(tmpdir(), "birb-claude-"));
  const provider = await startClaudeFixtureProvider(onProviderFailure);
  const exits: Promise<void>[] = [];
  const options: Options = {
    spawnClaudeCodeProcess({ command, args, env, signal }) {
      const cli = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "ignore"] });
      exits.push(new Promise((resolve) => cli.once("close", () => resolve())));
      return cli;
    },
    cwd,
    model,
    tools: [],
    settingSources: [],
    sessionStore: new InMemorySessionStore(),
    sessionStoreFlush: "eager",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      CLAUDE_CONFIG_DIR: join(cwd, "config"),
      ANTHROPIC_API_KEY: "synthetic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: provider.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    },
  };
  const bindings = new Map<string, SessionBinding>();
  const sessionRecovery: SessionRecoveryConfig = {
    profile: "fixture",
    resolveProfile: async () => options,
    store: {
      load: async (threadId) => bindings.get(threadId),
      save: async (threadId, binding) => { bindings.set(threadId, binding); },
    },
  };

  return {
    run(input: RunAgentInput, signal: AbortSignal) {
      return defer(() => {
        const abortController = new AbortController();
        const cancel = () => abortController.abort();
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const adapter = new ClaudeAgentAdapter({ abortController, sessionRecovery });
        return adapter.run(input).pipe(finalize(() => signal.removeEventListener("abort", cancel)));
      });
    },
    async close() {
      await Promise.all(exits);
      await provider.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { userAgent } from "../../src/service/accounts.ts";
import type { LiveAccount } from "./live-account.ts";

export async function openRelay(account: LiveAccount, signal: AbortSignal, transport: typeof fetch = fetch, onAttempt: (count: number) => void = () => {}) {
  const workerKey = randomBytes(32).toString("hex");
  const scope = "/" + randomBytes(32).toString("hex");
  const paths = { pi: ["/models", "/chat/completions"], claude: ["/v1/messages", "/v1/messages/count_tokens"], codex: ["/responses"] };
  const sessions = new Set<string>();
  let requests = 0, rejected = false;
  let claim: Promise<void> | undefined;
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  active.throwIfAborted();
  const server = createServer(async (req, res) => {
    try {
      active.throwIfAborted();
      const url = new URL(req.url ?? "", "http://localhost");
      const path = url.pathname.slice(scope.length);
      if (!url.pathname.startsWith(scope + "/")) { res.writeHead(404).end(); return; }
      if (!paths[account.engine].includes(path) || req.method !== (path === "/models" ? "GET" : "POST") ||
          (url.search && !(account.engine === "claude" && url.search === "?beta=true"))) throw new Error("route");
      const authenticated = account.engine === "claude" ? req.headers["x-api-key"] === workerKey :
        req.headers.authorization === "Bearer " + workerKey;
      if (!authenticated) throw new Error("Worker authentication required");
      const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
      if (account.engine === "claude") {
        headers.set("x-api-key", account.key);
        for (const name of ["anthropic-version", "anthropic-beta"]) {
          const value = req.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
      } else headers.set("Authorization", "Bearer " + account.key);
      if (account.engine === "pi") {
        if (req.headers["user-agent"] !== userAgent || req.headers["x-opencode-client"]) throw new Error("identity");
        headers.set("User-Agent", userAgent);
        if (path !== "/models") {
          const session = req.headers["x-opencode-session"];
          if (typeof session !== "string" || !session) throw new Error("session");
          headers.set("x-opencode-session", session);
          sessions.add(session);
        }
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) throw new Error("size");
        chunks.push(chunk);
      }
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      if (req.method === "POST" && (!body || JSON.parse(body).model !== account.model)) throw new Error("model");
      await account.recheck();
      active.throwIfAborted();
      await (claim ??= account.claim());
      active.throwIfAborted();
      if (requests >= account.budget || rejected) throw new Error("budget");
      onAttempt(++requests);
      const upstream = await transport(account.origin + path + url.search, { method: req.method, headers, body,
        redirect: "error", signal: AbortSignal.any([active, AbortSignal.timeout(120_000)]) });
      if (!upstream.ok || !upstream.body) throw new Error("provider");
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
      await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>), res);
    } catch {
      rejected = true;
      if (res.headersSent) res.destroy();
      else res.writeHead(403).end("Live proof request rejected");
    }
  });
  // The stock OpenAI Responses client negotiates WebSocket first and falls back to HTTP on 426.
  server.on("upgrade", (req, socket) => {
    const valid = !active.aborted && account.engine === "codex" && req.url === scope + "/responses" &&
      req.headers.authorization === "Bearer " + workerKey && req.headers.upgrade?.toLowerCase() === "websocket";
    socket.end("HTTP/1.1 " + (valid ? "426 Upgrade Required" : "403 Forbidden") + "\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay initialization failed");
  return { workerKey, url: "http://127.0.0.1:" + address.port + scope, stats: () => ({ requests, rejected, sessions: sessions.size }), async close() {
    controller.abort();
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  } };
}

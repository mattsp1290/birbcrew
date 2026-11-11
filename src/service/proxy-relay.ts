import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export type ProxyProtocol = "anthropic-messages" | "openai-responses" | "openai-chat-completions";
export interface ProxyCredential {
  /** Upstream credentials only. Never returned to the member SDK. */
  headers: Record<string, string>;
  expiresAt: number;
}
export interface ProxyRelayConfig {
  protocol: ProxyProtocol;
  /** Exact operator-owned upstream URL, including its API path. */
  endpoint: string;
  model: string;
  headers?: Record<string, string>;
  resolveCredential: (signal: AbortSignal) => Promise<ProxyCredential>;
  /** Only for an explicitly configured local proxy/qualification fixture. */
  allowHttpLoopback?: boolean;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}

const routes: Record<ProxyProtocol, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-responses": "/v1/responses",
  "openai-chat-completions": "/v1/chat/completions",
};
const forbiddenHeaders = /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|trailer|te|keep-alive)$/i;
function checkedHeaders(values: Record<string, string>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(values)) {
    if (forbiddenHeaders.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Invalid proxy headers");
    try { result.set(key, value); } catch { throw new Error("Invalid proxy headers"); }
  }
  return result;
}
function validToken(value: string | undefined, token: string) {
  if (!value) return false;
  const candidate = Buffer.from(value);
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function failure(response: ServerResponse, status: number) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json" });
  // Neither upstream bodies nor credential-helper errors are observable here.
  response.end(JSON.stringify({ error: { message: "AI proxy request failed", type: "proxy_error" } }));
}
class BodyLimitError extends Error {}
async function boundedBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { request.resume(); throw new BodyLimitError(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A process-local, fail-closed signing relay. It is not a wire-format translator. */
export async function startProxyRelay(config: ProxyRelayConfig) {
  const protocol = config.protocol;
  const route = routes[protocol];
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { throw new Error("Invalid proxy endpoint"); }
  if (!route || !config.model || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== "https:" && !(config.allowHttpLoopback && endpoint.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw new Error("Invalid proxy route configuration");
  // Snapshot the trusted configuration so mutation cannot retarget an active relay.
  const target = endpoint.href;
  const model = config.model;
  const resolver = config.resolveCredential;
  const staticHeaders = checkedHeaders(config.headers ?? {});
  const maxBodyBytes = config.maxBodyBytes ?? 16 * 1024 * 1024;
  const timeout = config.requestTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || !Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("Invalid proxy resource limits");
  }
  const apiKey = randomBytes(32).toString("hex");
  const active = new Set<AbortController>();
  let closed = false;
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => failure(response, 502));
  });
  server.requestTimeout = timeout;
  server.headersTimeout = Math.min(timeout, 30_000);
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (closed) return failure(response, 503);
    if (request.method !== "POST" || request.url !== route) return failure(response, 400);
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
    const key = request.headers["x-api-key"];
    if (!validToken(bearer, apiKey) && !validToken(typeof key === "string" ? key : undefined, apiKey)) return failure(response, 401);
    const controller = new AbortController();
    active.add(controller);
    const stopBody = () => {
      // An abort must also interrupt a client that never finishes sending JSON.
      if (!request.complete && !request.destroyed) request.destroy();
    };
    controller.signal.addEventListener("abort", stopBody, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    const cancel = () => { if (!response.writableFinished) controller.abort(); };
    response.once("close", cancel);
    request.once("aborted", cancel);
    let upstream: Response | undefined;
    try {
      const body = await boundedBody(request, maxBodyBytes);
      const data: unknown = JSON.parse(body);
      if (data === null || typeof data !== "object" || !("model" in data) || data.model !== model) return failure(response, 400);
      controller.signal.throwIfAborted();
      // Deliberately called at the HTTP boundary, including SDK-internal continuations.
      const credential = await Promise.race([
        resolver(controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Proxy cancelled")), { once: true })),
      ]);
      controller.signal.throwIfAborted();
      if (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) return failure(response, 502);
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream, application/json" });
      for (const name of ["anthropic-version", "anthropic-beta"]) {
        const value = request.headers[name];
        if (typeof value === "string" && protocol === "anthropic-messages") headers.set(name, value);
      }
      staticHeaders.forEach((value, name) => headers.set(name, value));
      checkedHeaders(credential.headers).forEach((value, name) => headers.set(name, value));
      upstream = await fetch(target, { method: "POST", headers, body, redirect: "error", signal: controller.signal });
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); return failure(response, 502); }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!/^(text\/event-stream|application\/json)(;|$)/i.test(contentType)) { await upstream.body.cancel(); return failure(response, 502); }
      // Do not copy arbitrary upstream headers (including cookies or credential echoes).
      response.writeHead(upstream.status, { "content-type": contentType.toLowerCase().startsWith("text/event-stream") ? "text/event-stream" : "application/json", "cache-control": "no-store" });
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!response.write(chunk.value)) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { response.off("drain", drained); response.off("close", disconnected); response.off("error", disconnected); };
            const drained = () => { cleanup(); resolve(); };
            const disconnected = () => { cleanup(); reject(new Error("Proxy cancelled")); };
            response.once("drain", drained);
            response.once("close", disconnected);
            response.once("error", disconnected);
          });
        }
        response.end();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) { failure(response, error instanceof BodyLimitError ? 413 : controller.signal.aborted ? 504 : 502); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", stopBody);
      response.off("close", cancel);
      request.off("aborted", cancel);
      active.delete(controller);
    }
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy relay did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: origin + (protocol === "anthropic-messages" ? "" : "/v1"),
    apiKey,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of active) controller.abort();
      const completion = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await completion;
    },
  };
}

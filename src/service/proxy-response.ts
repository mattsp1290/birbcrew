import type { ServerResponse } from "node:http";
import type { ProxyProtocol } from "./proxy-relay.ts";

// Bound one JSON body or SSE event, not the total successful stream.
export const proxyResponseLimit = 1024 * 1024;
const message = "AI proxy request failed";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function protocolError(value: unknown, event = "") {
  if (["error", "response.failed", "response.incomplete"].includes(event)) return true;
  if (!object(value)) return false;
  return ["error", "response.failed", "response.incomplete"].includes(String(value.type)) ||
    (value.error !== undefined && value.error !== null) ||
    (object(value.response) && ((value.response.error !== undefined && value.response.error !== null) ||
      ["failed", "incomplete"].includes(String(value.response.status))));
}
function genericFrame(protocol: ProxyProtocol) {
  if (protocol === "anthropic-messages") return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
  if (protocol === "openai-responses") return `event: error\ndata: ${JSON.stringify({ type: "error", code: "proxy_error", message })}\n\n`;
  return `data: ${JSON.stringify({ error: { type: "proxy_error", message } })}\n\n`;
}
async function write(response: ServerResponse, value: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (response.destroyed) throw new Error("Proxy disconnected");
  if (response.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { response.off("drain", drained); response.off("close", disconnected); response.off("error", disconnected); signal.removeEventListener("abort", disconnected); };
    const drained = () => { cleanup(); resolve(); };
    const disconnected = () => { cleanup(); reject(new Error("Proxy disconnected")); };
    response.once("drain", drained); response.once("close", disconnected); response.once("error", disconnected);
    signal.addEventListener("abort", disconnected, { once: true });
    if (signal.aborted) disconnected();
  });
}

/** Validate a whole JSON envelope before any diagnostic bytes cross the boundary. */
export async function proxyJson(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > proxyResponseLimit) throw new Error("Proxy response limit");
    parts.push(next.value);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  if (protocolError(JSON.parse(text))) throw new Error("Proxy protocol error");
  return text;
}

/** Release only complete, validated SSE events. Do not accumulate the whole stream. */
export async function proxySse(reader: ReadableStreamDefaultReader<Uint8Array>, response: ServerResponse, protocol: ProxyProtocol, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", lines: string[] = [], size = 0;
  const line = async (value: string) => {
    size += Buffer.byteLength(value) + 1;
    if (size > proxyResponseLimit) throw new Error("Proxy event limit");
    if (value !== "") { lines.push(value); return; }
    let event = "";
    const data: string[] = [];
    for (const raw of lines) {
      const colon = raw.indexOf(":");
      const field = colon < 0 ? raw : raw.slice(0, colon);
      const content = colon < 0 ? "" : raw.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = content;
      if (field === "data") data.push(content);
    }
    const payload = data.join("\n");
    if (protocolError(undefined, event)) throw new Error("Proxy protocol error");
    if (data.length) {
      if (payload !== "[DONE]" && protocolError(JSON.parse(payload), event)) throw new Error("Proxy protocol error");
      // Drop comments and non-protocol fields rather than carrying diagnostics in them.
      await write(response, (event ? `event: ${event}\n` : "") + data.map(value => `data: ${value}\n`).join("") + "\n", signal);
    }
    lines = []; size = 0;
  };
  const consume = async (text: string, final: boolean) => {
    pending += text;
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i] !== "\r" && pending[i] !== "\n") continue;
      if (!final && pending[i] === "\r" && i === pending.length - 1) break;
      await line(pending.slice(start, i));
      if (pending[i] === "\r" && pending[i + 1] === "\n") i++;
      start = i + 1;
    }
    pending = pending.slice(start);
    if (size + Buffer.byteLength(pending) > proxyResponseLimit) throw new Error("Proxy event limit");
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      // fetch chunks are bounded by the HTTP implementation; the parser retains at most one event.
      await consume(decoder.decode(next.value, { stream: true }), false);
    }
    await consume(decoder.decode(), true);
    // An unterminated data event is an interrupted protocol response, not success.
    if (pending || lines.length) throw new Error("Incomplete proxy event");
    response.end();
  } catch {
    if (signal.aborted) { response.destroy(); return; }
    if (!response.destroyed && !response.writableEnded) {
      await write(response, genericFrame(protocol), signal);
      response.end();
    }
  }
}

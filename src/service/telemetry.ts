import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter, type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { engineSchema, type Engine } from "./domain.ts";

const names = ["workflow.segment", "model.invoke", "tool.settle", "native.restore"] as const;
type Operation = (typeof names)[number];
type Scope = { engine: Engine; conversationId: string; requestId: string; workflowRunId: string; childId?: string };

const active = new AsyncLocalStorage<{ traceId: string; context: Context }>();
const uuid = z.uuid();
const output = process.env.BIRBCREW_TRACE_FILE;
const endpoint = otlpEndpoint(process.env);

// A typo must stop startup, not silently send spans elsewhere or drop them. Errors name the variable and never
// repeat its value, because a rejected URL may contain credentials. Plain http is allowed to 127.0.0.1, or to any
// host when the operator also sets BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true (an in-cluster agent). Collector headers
// from the OTLP environment variables ride on every request, so that opt-in refuses them: nothing secret crosses
// the network in the clear. IPv6 literals are refused outright, unlike in the proxy relay: the exporter passes the
// bracketed host to node:http, which cannot resolve it, so every export would fail unnoticed.
// The exporter sends only the path, so a query or fragment (often an ingest key) would be dropped silently.
function otlpEndpoint(env: NodeJS.ProcessEnv) {
  const value = env.BIRBCREW_OTLP_TRACES_ENDPOINT;
  if (!value) return undefined;
  const allowHttp = env.BIRBCREW_OTLP_TRACES_ALLOW_HTTP ?? "";
  if (!/^(true|false|)$/i.test(allowHttp)) throw new Error("BIRBCREW_OTLP_TRACES_ALLOW_HTTP must be true or false");
  const url = URL.parse(value);
  const plaintext = url?.protocol === "http:" && url.hostname !== "127.0.0.1";
  if (!url || url.username || url.password || url.search || url.hash || url.pathname === "/" ||
      url.hostname.startsWith("[") || !(url.protocol === "https:" || url.protocol === "http:") ||
      (plaintext && allowHttp.toLowerCase() !== "true")) {
    throw new Error("BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL with a path (plain http only to "
      + "127.0.0.1, or to any host with BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true), such as https://collector.example/v1/traces, "
      + "with no IPv6 literal, credentials, query or fragment");
  }
  if (plaintext && (env.OTEL_EXPORTER_OTLP_HEADERS?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim())) {
    throw new Error("BIRBCREW_OTLP_TRACES_ALLOW_HTTP sends spans without encryption, so OTEL_EXPORTER_OTLP_HEADERS and "
      + "OTEL_EXPORTER_OTLP_TRACES_HEADERS must be unset");
  }
  return url.href;
}

// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES as the OpenTelemetry specification defines them: comma-separated
// key=value entries with W3C Baggage keys and percent-encoded values. The SDK's own detector skips or silently
// discards malformed input and has no size bound. Here malformed input stops startup like a bad endpoint, so a
// typo cannot quietly drop the deployment environment or version, and the error names only the variable and entry.
const ows = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");
const baggageKey = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,255}$/;
const baggageValue = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const unprintable = /[\p{Cc}\p{Cf}]/u;
function otlpResource(env: NodeJS.ProcessEnv) {
  const text = env.OTEL_RESOURCE_ATTRIBUTES ?? "";
  const entries = text.length > 4_096 ? [] : text.split(",").map(ows).filter((entry) => entry !== "");
  if (text.length > 4_096 || entries.length > 32) {
    throw new Error("OTEL_RESOURCE_ATTRIBUTES must have at most 32 entries and 4096 characters");
  }
  const attributes = new Map<string, string>();
  entries.forEach((entry, index) => {
    const split = entry.indexOf("="), key = ows(entry.slice(0, split)), encoded = ows(entry.slice(split + 1));
    let value: string | undefined;
    try { value = decodeURIComponent(encoded); } catch {}
    if (split < 0 || !baggageKey.test(key) || attributes.has(key) || !baggageValue.test(encoded) ||
        value === undefined || value.length > 255 || unprintable.test(value)) {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES entry ${index + 1} is invalid: each entry must be key=value with a `
        + "unique W3C Baggage key and a non-empty percent-encoded value of at most 255 characters once decoded, "
        + "with no control characters");
    }
    attributes.set(key, value);
  });
  const service = ows(env.OTEL_SERVICE_NAME ?? "");
  if (service.length > 255 || unprintable.test(service)) {
    throw new Error("OTEL_SERVICE_NAME must be at most 255 characters with no control characters");
  }
  attributes.set("service.name", service || attributes.get("service.name") || "birbcrew");
  return Object.fromEntries(attributes);
}

const warningIntervalMs = 5 * 60_000;
// Export errors can carry the collector's address, its status text or its response body, so the warning names only
// an HTTP status or a Node error code.
function exportFailure(error: unknown) {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) return `HTTP ${code}`;
  if (typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code)) return code;
  if (message === "Request Timeout") return "timeout";
  if (message === "Export failed with retryable status") return "HTTP 429, 502, 503 or 504";
  return "unknown error";
}

/** Exported for tests. Reports failed exports in at most one line per interval and counts the ones it held back. */
export function exportWarning(write: (line: string) => void, now: () => number = Date.now) {
  let quietUntil = -Infinity, held = 0;
  return (error: unknown) => {
    if (now() < quietUntil) { held++; return; }
    quietUntil = now() + warningIntervalMs;
    write(`birbcrew: OTLP trace export failed (${exportFailure(error)}) and its spans were dropped`
      + (held ? `; ${held} more failed since the last warning` : "") + "; the next warning comes at least 5 minutes later\n");
    held = 0;
  };
}

const exporter: SpanExporter = {
  export(spans, done) {
    try {
      for (const span of spans) {
        const { traceId, spanId } = span.spanContext();
        appendFileSync(output!, JSON.stringify({
          name: span.name, traceId, spanId, parent: span.parentSpanContext?.spanId,
          start: span.startTime, duration: span.duration, status: span.status.code, attributes: span.attributes,
        }) + "\n", { mode: 0o600 });
      }
      done({ code: 0 });
    } catch { done({ code: 1 }); }
  },
  async shutdown() {},
};
const exportTimeoutMs = 2_000;
// The OTEL_* resource variables are read only when OTLP export is on, so they cannot stop any other process.
const resource = endpoint ? otlpResource(process.env) : { "service.name": "birbcrew" };
const processors: SpanProcessor[] = [];
if (output) processors.push(new SimpleSpanProcessor(exporter));
if (endpoint) {
  // Loaded only when configured: every native turn forks a runner that imports this module.
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const otlp = new OTLPTraceExporter({ url: endpoint, timeoutMillis: exportTimeoutMs });
  // A throw here would surface inside the exporter's promise chain as an unhandled rejection.
  const warn = exportWarning((line) => { try { process.stderr.write(line); } catch {} });
  // Ending a span only enqueues it. A full queue drops spans, and failed exports are discarded after a
  // rate-limited warning.
  processors.push(new BatchSpanProcessor({
    export: (spans, done) => otlp.export(spans, (result) => {
      if (result.code !== 0) warn(result.error);
      done(result);
    }),
    shutdown: () => otlp.shutdown(),
    forceFlush: () => otlp.forceFlush(),
  }, {
    maxQueueSize: 1_024, maxExportBatchSize: 256, scheduledDelayMillis: 1_000, exportTimeoutMillis: exportTimeoutMs,
  }));
}
const provider = processors.length ? new BasicTracerProvider({
  resource: resourceFromAttributes(resource),
  spanProcessors: processors,
  // Bounds only the flush wait. An export it abandons can still hold a returning process (the worker) open
  // until exportTimeoutMs; the turn runner ends it with process.exit.
  forceFlushTimeoutMillis: 1_000,
  idGenerator: {
    generateTraceId: () => active.getStore()?.traceId ?? randomBytes(16).toString("hex"),
    generateSpanId: () => randomBytes(8).toString("hex"),
  },
}) : undefined;
const tracer = provider?.getTracer("birbcrew");

// The host confirms a native turn only after its runner process closes, so the runner's flush is on
// every turn's critical path and gets a much smaller budget than a worker's exit flush.
export const turnFlushBudgetMs = 250;

export async function flushTelemetry(budgetMs = 1_000) {
  if (!provider) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    provider.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
  ]);
  clearTimeout(timer);
}

export function traced<T>(name: Operation, scope: Scope, work: () => Promise<T>): Promise<T> {
  if (!tracer) return work();
  // An activity can receive additional fields at runtime. Only validated correlation IDs enter the exporter.
  const { engine, conversationId, requestId, workflowRunId, childId } = scope;
  if (![conversationId, requestId, workflowRunId, ...(childId ? [childId] : [])].every((id) => uuid.safeParse(id).success)
      || !engineSchema.safeParse(engine).success) return work();
  const attributes = { engine, conversationId, requestId, workflowRunId, ...(childId && { childId }) };
  const traceId = createHash("sha256").update(conversationId + "/" + requestId).digest("hex").slice(0, 32);
  const current = active.getStore();
  const context = current?.traceId === traceId ? current.context : ROOT_CONTEXT;
  return active.run({ traceId, context }, async () => {
    const span = tracer.startSpan(name, { attributes }, context);
    try {
      const result = await active.run({ traceId, context: trace.setSpan(context, span) }, work);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

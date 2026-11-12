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
const endpoint = otlpEndpoint(process.env.BIRBCREW_OTLP_TRACES_ENDPOINT);

// A typo must stop startup, not silently send spans elsewhere or drop them. The value is not echoed
// because a rejected URL may contain credentials. Plain http is allowed only to 127.0.0.1, because collector
// headers from the OTLP environment variables ride on every request. IPv6 literals are refused outright, unlike
// in the proxy relay: the exporter passes the bracketed host to node:http, which cannot resolve it, so every
// export would fail unnoticed.
// The exporter sends only the path, so a query or fragment (often an ingest key) would be dropped silently.
function otlpEndpoint(value: string | undefined) {
  if (!value) return undefined;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.search || url.hash || url.pathname === "/" ||
      url.hostname.startsWith("[") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
    throw new Error("BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL with a path (plain http only "
      + "to 127.0.0.1), such as http://127.0.0.1:4318/v1/traces, with no IPv6 literal, credentials, query or fragment");
  }
  return url.href;
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
const processors: SpanProcessor[] = [];
if (output) processors.push(new SimpleSpanProcessor(exporter));
if (endpoint) {
  // Loaded only when configured: every native turn forks a runner that imports this module.
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  // Ending a span only enqueues it. A full queue drops spans, and failed exports are discarded.
  processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: exportTimeoutMs }), {
    maxQueueSize: 1_024, maxExportBatchSize: 256, scheduledDelayMillis: 1_000, exportTimeoutMillis: exportTimeoutMs,
  }));
}
const provider = processors.length ? new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "birbcrew" }),
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

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
// because a rejected URL may contain credentials.
function otlpEndpoint(value: string | undefined) {
  if (!value) return undefined;
  const url = URL.parse(value);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname === "/") {
    throw new Error("BIRBCREW_OTLP_TRACES_ENDPOINT must be an http or https OTLP traces URL with a path, "
      + "such as http://127.0.0.1:4318/v1/traces, and no embedded credentials");
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
const processors: SpanProcessor[] = [];
if (output) processors.push(new SimpleSpanProcessor(exporter));
if (endpoint) {
  // Loaded only when configured: every native turn forks a runner that imports this module.
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  // Ending a span only enqueues it. A full queue drops spans, and failed exports are discarded.
  processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: 5_000 }), {
    maxQueueSize: 1_024, maxExportBatchSize: 256, scheduledDelayMillis: 1_000, exportTimeoutMillis: 5_000,
  }));
}
const provider = processors.length ? new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "birbcrew" }),
  spanProcessors: processors,
  // Bounds flushTelemetry so an unreachable collector cannot hold a process open on its way out.
  forceFlushTimeoutMillis: 1_000,
  idGenerator: {
    generateTraceId: () => active.getStore()?.traceId ?? randomBytes(16).toString("hex"),
    generateSpanId: () => randomBytes(8).toString("hex"),
  },
}) : undefined;
const tracer = provider?.getTracer("birbcrew");

export async function flushTelemetry() {
  await provider?.forceFlush().catch(() => {});
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

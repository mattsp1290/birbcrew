import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { engineSchema, type Engine } from "./domain.ts";

const names = ["workflow.segment", "model.invoke", "tool.settle", "native.restore"] as const;
type Operation = (typeof names)[number];
type Scope = { engine: Engine; conversationId: string; requestId: string; workflowRunId: string; childId?: string };

const active = new AsyncLocalStorage<{ traceId: string; context: Context }>();
const uuid = z.uuid();
const output = process.env.BIRBCREW_TRACE_FILE;
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
const tracer = output && new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
  idGenerator: {
    generateTraceId: () => active.getStore()?.traceId ?? randomBytes(16).toString("hex"),
    generateSpanId: () => randomBytes(8).toString("hex"),
  },
}).getTracer("birbcrew");

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

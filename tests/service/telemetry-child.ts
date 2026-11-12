import { flushTelemetry, traced, turnFlushBudgetMs } from "../../src/service/telemetry.ts";

const [conversationId, requestId, workflowRunId, secret, flush] = process.argv.slice(2);
// Activities can receive extra runtime fields; they must never reach an exporter.
const scope = { engine: "claude", conversationId, requestId, workflowRunId, prompt: secret, apiKey: secret } as
  Parameters<typeof traced>[1];
const value = await traced("workflow.segment", scope, () => traced("model.invoke", scope, async () => "reply " + secret));
// The flush is what a process waits on before it exits; "turn" uses the native runner's budget.
const started = performance.now();
await (flush === "turn" ? flushTelemetry(turnFlushBudgetMs) : flushTelemetry());
const flushed = performance.now() - started;
console.log(JSON.stringify({ value: value === "reply " + secret, flushed }));
// Like the native runner, exit without waiting for an export still in flight.
process.exit(0);

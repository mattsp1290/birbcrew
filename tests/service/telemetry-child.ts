import { createRequire } from "node:module";
import { flushTelemetry, traced, turnFlushBudgetMs } from "../../src/service/telemetry.ts";

const [conversationId, requestId, workflowRunId, secret, flush, rounds = "1"] = process.argv.slice(2);
// Activities can receive extra runtime fields; they must never reach an exporter.
const scope = { engine: "claude", conversationId, requestId, workflowRunId, prompt: secret, apiKey: secret } as
  Parameters<typeof traced>[1];
let value = true, flushed = 0;
// Each round ends with a flush, so a failing collector sees one failed export per round.
for (let round = 0; round < Number(rounds); round++) {
  const reply = await traced("workflow.segment", scope, () => traced("model.invoke", scope, async () => "reply " + secret));
  value &&= reply === "reply " + secret;
  // The flush is what a process waits on before it exits; "turn" uses the native runner's budget.
  const started = performance.now();
  await (flush === "turn" ? flushTelemetry(turnFlushBudgetMs) : flushTelemetry());
  flushed = performance.now() - started;
}
// The exporter is CommonJS, so a static or dynamic import of it registers in the require cache.
const exporterLoaded = Object.keys(createRequire(import.meta.url).cache).some((path) => path.includes("exporter-trace-otlp-http"));
console.log(JSON.stringify({ value, flushed, exporterLoaded }));
// Like the native runner, exit without waiting for an export still in flight.
process.exit(0);

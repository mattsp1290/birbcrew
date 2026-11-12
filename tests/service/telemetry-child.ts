import { flushTelemetry, traced } from "../../src/service/telemetry.ts";

const [conversationId, requestId, workflowRunId, secret] = process.argv.slice(2);
// Activities can receive extra runtime fields; they must never reach an exporter.
const scope = { engine: "claude", conversationId, requestId, workflowRunId, prompt: secret, apiKey: secret } as
  Parameters<typeof traced>[1];
const started = performance.now();
const value = await traced("workflow.segment", scope, () => traced("model.invoke", scope, async () => "reply " + secret));
const elapsed = performance.now() - started;
await flushTelemetry();
console.log(JSON.stringify({ value: value === "reply " + secret, elapsed }));
// Like the native runner, exit without waiting for an export still in flight.
process.exit(0);

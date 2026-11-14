import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { routes, observerPath, errorSchema, healthSchema } from "../packages/client/src/contract.ts";

const schemaDefinitions = {};
let schemaNumber = 0;
const schema = value => {
  const { $schema, $defs, ...document } = z.toJSONSchema(value, { io: "input" });
  const prefix = `Schema${++schemaNumber}_`;
  function relocate(value) {
    if (Array.isArray(value)) return value.map(relocate);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) =>
      [key, key === "$ref" && typeof nested === "string" && nested.startsWith("#/$defs/")
        ? "#/components/schemas/" + prefix + nested.slice(8) : relocate(nested)]));
  }
  for (const [name, definition] of Object.entries($defs ?? {})) schemaDefinitions[prefix + name] = relocate(definition);
  return relocate(document);
};
const content = value => ({ "application/json": { schema: schema(value) } });
const errors = Object.fromEntries([400, 401, 404, 405, 409, 413, 503].map(status => [status, {
  description: status === 503 ? "Unavailable. retry_same_request means the command outcome is unknown. Reconcile the original identity." : "Bounded public error code.", content: content(errorSchema),
}]));
const paths = {};
const parameters = path => [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } }));
for (const [operationId, route] of Object.entries(routes)) {
  const operation = { operationId, parameters: parameters(route.path),
    responses: { ...errors, [route.status]: { description: "Success", content: content(route.response) } } };
  if (route.body) operation.requestBody = { required: true, content: content(route.body) };
  if (route.query) operation.parameters.push(...Object.entries(schema(route.query).properties).map(([name, value]) => ({ name, in: "query", schema: value })));
  if (operationId === "health") operation.responses[503] = { description: "Database or Temporal unavailable", content: content(healthSchema) };
  if (operationId === "submit") operation.description = "One admission attempt. Preserve requestId and exact UTF-8 text for reconciliation. Acceptance does not prove completion or effects.";
  if (operationId === "cancel") operation.description = "Durable cancellation intent. Delivery, native termination and effects are independent facts. This does not claim rollback.";
  (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
}
paths[observerPath] = { post: {
  operationId: "observe", description: "Official AG-UI snapshot and bounded event tail. threadId must match conversationId. messages, tools and context must be empty, state and forwardedProps empty or null, and resume absent or empty. Reconnect with a fresh snapshot after cursor expiry. This route never submits work.",
  parameters: [...parameters(observerPath), { name: "after", in: "query", schema: { type: "string" }, description: "If supplied, must equal the current snapshot cursor as a decimal string." }],
  requestBody: { required: true, content: content(RunAgentInputSchema.extend({ messages: z.tuple([]), tools: z.tuple([]), context: z.tuple([]), resume: z.tuple([]).optional(), state: z.strictObject({}).nullable().optional(), forwardedProps: z.strictObject({}).nullable().optional() })) },
  responses: { ...errors, 410: { description: "CURSOR_EXPIRED. Establish a fresh snapshot.", content: content(errorSchema) },
    200: { description: "AG-UI Server-Sent Events encoded by @ag-ui/encoder 1.0.4. Each data frame is an official AG-UI event; optional id is the persisted cursor.",
      content: { "text/event-stream": { schema: { type: "string" } } } } },
} };
const document = {
  openapi: "3.1.0", info: { title: "Crew core integration API", version: "1.0.0", description: "Bounded core integration surface. This document is not the complete Crew API. See x-excluded-routes for the current v1 routes outside its scope. UTF-8 byte bounds and control-character restrictions are enforced by the shared runtime schemas and described with x- extensions." },
  security: [{ bearerAuth: [] }], components: { schemas: schemaDefinitions, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }, paths,
  "x-excluded-routes": ["GET /v1/conversations", "/v1/audit", "/v1/routines and descendants", "/v1/memories and descendants", "/v1/instruction-packs and descendants", "/v1/webhooks and descendants", "/v1/usage and descendants", "/v1/members/{memberId}/grants and descendants", "/v1/members/{memberId}/instructions", "/v1/conversations/{conversationId}/handoff", "/v1/conversations/{conversationId}/handoffs", "/v1/conversations/{conversationId}/inputs (legacy admission)", "/v1/conversations/{conversationId}/cancel (legacy cancellation)"],
};
const target = new URL("../packages/client/openapi.json", import.meta.url), generated = JSON.stringify(document, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== generated) throw new Error("OpenAPI is stale. Run npm run build:client && npm run openapi.");
} else await writeFile(target, generated);
console.log(process.argv.includes("--check") ? "OpenAPI is current" : "Generated core OpenAPI 3.1");

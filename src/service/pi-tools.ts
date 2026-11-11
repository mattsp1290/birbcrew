import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { recordWorkItemArguments, type ToolOutcome } from "./approvals.ts";

export const toolName = "record_work_item";
export const nativeCall = z.looseObject({
  type: z.literal("toolCall"), id: z.string().min(1).max(256), name: z.literal(toolName),
  arguments: recordWorkItemArguments, argumentsError: z.never().optional(),
});
type NativeCall = z.infer<typeof nativeCall>;

export function proposalTool(requestId: string) {
  const accepted = new Set<string>();
  const definition: ToolDefinition = {
    name: toolName, label: "Record work item", description: "Propose one work item for owner approval.",
    parameters: {
      type: "object", additionalProperties: false, required: ["operation_id"],
      properties: { operation_id: { type: "string", const: requestId }, note: { type: "string", maxLength: 4096 } },
    },
    async execute(id, args) {
      const data = recordWorkItemArguments.parse(args);
      if (data.operation_id !== requestId || accepted.size) throw new Error("Invalid Pi tool proposal");
      accepted.add(id);
      return { content: [], details: {}, terminate: true };
    },
  };
  return { definition, accepted };
}

const correlation = { nativeCallId: z.string() };
const outcome = z.discriminatedUnion("kind", [
  z.strictObject({ ...correlation, kind: z.literal("recorded"), receipt: z.strictObject({
    receiptId: z.uuid(), operationId: z.uuid(),
  }) }),
  z.strictObject({ ...correlation, kind: z.enum(["denied", "cancelled", "budget_exhausted"]) }),
]);

export function toolResult(call: NativeCall, answer: { nativeCallId: string; result: ToolOutcome }) {
  const result = outcome.parse(answer.result);
  if (call.id !== answer.nativeCallId || call.id !== result.nativeCallId ||
      (result.kind === "recorded" && result.receipt.operationId !== call.arguments.operation_id)) {
    throw new Error("Pi tool result does not match the pending call");
  }
  return {
    role: "toolResult" as const, toolName, toolCallId: call.id, timestamp: Date.now(),
    content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: result.kind !== "recorded",
  };
}

const resumeMarker = "birbcrew-tool-continuation";

export async function continueSession(session: AgentSession) {
  const convert = session.agent.convertToLlm;
  session.agent.convertToLlm = (history) =>
    convert(history.filter((message) => message.role !== "custom" || message.customType !== resumeMarker));
  await session.sendCustomMessage({
    customType: resumeMarker, content: "", display: false, details: {},
  }, { triggerTurn: true });
}

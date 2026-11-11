import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { emptyToolArguments, matchesTool, nativeResult, outcomeSchema, recordWorkItemArguments, type DeferredTool, type ToolOutcome } from "./deferral.ts";

const call = z.looseObject({
  type: z.literal("toolCall"), id: z.string().min(1).max(256), argumentsError: z.never().optional(),
});
export const nativeCall = z.discriminatedUnion("name", [
  call.extend({ name: z.literal("record_work_item"), arguments: recordWorkItemArguments }),
  call.extend({ name: z.literal("choose_next_step"), arguments: emptyToolArguments }),
]);
type NativeCall = z.infer<typeof nativeCall>;

export function proposalTool(requestId: string, toolName: DeferredTool) {
  const accepted = new Set<string>();
  const definition: ToolDefinition = {
    name: toolName, label: toolName === "choose_next_step" ? "Choose next step" : "Record work item",
    description: toolName === "choose_next_step" ? "Ask the owner whether to inspect or test next." : "Propose one work item for owner approval.",
    parameters: toolName === "choose_next_step" ? { type: "object", additionalProperties: false, properties: {} } : {
      type: "object", additionalProperties: false, required: ["operation_id"],
      properties: { operation_id: { type: "string", const: requestId }, note: { type: "string", maxLength: 4096 } },
    },
    async execute(id, args) {
      if (toolName === "choose_next_step") emptyToolArguments.parse(args);
      else if (recordWorkItemArguments.parse(args).operation_id !== requestId) throw new Error("Invalid Pi operation");
      if (accepted.size) throw new Error("Invalid Pi tool proposal");
      accepted.add(id);
      return { content: [], details: {}, terminate: true };
    },
  };
  return { definition, accepted };
}

export function toolResult(call: NativeCall, answer: { nativeCallId: string; result: ToolOutcome }) {
  const result = outcomeSchema.parse(answer.result);
  if (call.id !== answer.nativeCallId || call.id !== result.nativeCallId ||
      !matchesTool(call.name, result, call.name === "record_work_item" ? call.arguments.operation_id : undefined)) {
    throw new Error("Pi tool result does not match the pending call");
  }
  return {
    role: "toolResult" as const, toolName: call.name, toolCallId: call.id, timestamp: Date.now(),
    content: [{ type: "text" as const, text: nativeResult(result) }], isError: result.kind !== "recorded" && result.kind !== "answered",
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

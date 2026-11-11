import { EventType as E, type Event, type Message, type ToolMessage, type SubagentStartedEvent } from "@ag-ui/core";

interface ChildSummary {
  childId: string;
  role: "analyst" | "recorder";
}
export interface ObservedChild extends ChildSummary {
  requestId: string;
  openStep?: string;
  phase: "ready" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
}
export type ChildChange =
  | { kind: "delegation"; requestId: string; children: ChildSummary[] }
  | { kind: "childStarted"; requestId: string; childId: string }
  | { kind: "childResumed"; requestId: string; childId: string }
  | { kind: "childEnded"; requestId: string; childId: string; outcome: "completed" | "failed" | "cancelled"; text?: string };

function callId(childId: string) { return childId + "/delegate"; }

// HttpAgent places each result alongside the assistant message that issued its call.
export function insertToolResult(messages: Message[], result: ToolMessage) {
  const issuer = messages.findIndex(message => message.role === "assistant" &&
    message.toolCalls?.some(call => call.id === result.toolCallId));
  if (issuer < 0) throw new Error("Missing public tool call");
  let index = issuer + 1;
  while (messages[index]?.role === "tool") index++;
  messages.splice(index, 0, result);
}

export function childOpener(child: ObservedChild): SubagentStartedEvent {
  return {
    type: E.SUBAGENT_STARTED, subagentRunId: child.childId, name: child.role,
    parentToolCallId: callId(child.childId), parentMessageId: child.requestId + "/delegation"
  };
}

export function endChildStep(child: ObservedChild): Event[] {
  if (!child.openStep) return [];
  const stepName = child.openStep;
  delete child.openStep;
  return [{ type: E.STEP_FINISHED, stepName, subagentRunId: child.childId }];
}

export function applyChild(children: ObservedChild[], messages: Message[], change: ChildChange, streamedMessageId?: string): Event[] {
  const frames: Event[] = [];
  if (change.kind === "delegation") {
    const parentMessageId = change.requestId + "/delegation";
    const calls = change.children.map(({ childId, role }) => {
      children.push({ childId, role, requestId: change.requestId, phase: "ready" });
      const id = callId(childId);
      const args = JSON.stringify({ role });
      frames.push({ type: E.TOOL_CALL_START, toolCallId: id, toolCallName: "delegate_task", parentMessageId },
        { type: E.TOOL_CALL_ARGS, toolCallId: id, delta: args }, { type: E.TOOL_CALL_END, toolCallId: id });
      return { id, type: "function" as const, function: { name: "delegate_task", arguments: args } };
    });
    messages.push({ role: "assistant", id: parentMessageId, toolCalls: calls });
    return frames;
  }
  const child = children.find(entry => entry.childId === change.childId && entry.requestId === change.requestId);
  if (!child) throw new Error("Missing public Pi delegation");
  const subagentRunId = child.childId;
  if (change.kind === "childStarted" || change.kind === "childResumed") {
    child.phase = "running";
    child.openStep = child.childId + (change.kind === "childStarted" ? "/initial" : "/continue");
    if (change.kind === "childStarted") frames.push(childOpener(child));
    frames.push({ type: E.STEP_STARTED, stepName: child.openStep, subagentRunId });
    return frames;
  }
  if (child.phase === "running") {
    if (change.outcome === "completed") {
      if (change.text) {
        const messageId = streamedMessageId ?? child.childId + "/assistant";
        messages.push({ id: messageId, role: "assistant", content: change.text, subagentRunId });
        if (!streamedMessageId) frames.push({ type: E.TEXT_MESSAGE_START, messageId, role: "assistant", subagentRunId },
          { type: E.TEXT_MESSAGE_CONTENT, messageId, delta: change.text, subagentRunId },
          { type: E.TEXT_MESSAGE_END, messageId, subagentRunId });
      }
      frames.push(...endChildStep(child), { type: E.SUBAGENT_FINISHED, subagentRunId });
    } else {
      frames.push(...endChildStep(child), {
        type: E.SUBAGENT_ERROR, subagentRunId, code: change.outcome, message:
          change.outcome === "cancelled" ? "Child task cancelled" : "Child task failed"
      });
    }
  }
  child.phase = change.outcome;
  const toolCallId = callId(child.childId);
  const messageId = child.childId + "/result";
  const content = JSON.stringify({ kind: change.outcome, ...(change.text && { text: change.text }) });
  insertToolResult(messages, { id: messageId, role: "tool", toolCallId, content });
  frames.push({ type: E.TOOL_CALL_RESULT, messageId, toolCallId, content });
  return frames;
}

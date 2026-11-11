import { allHandlersFinished, ApplicationFailure, condition, defineUpdate, proxyActivities, setHandler } from "@temporalio/workflow";
import { submitSchema, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberActivities } from "./activities.ts";

import { activityQueue } from "./queues.ts";

export const submitTurn = defineUpdate<string, [TurnRequest]>("submitTurn");

export async function memberConversation(conversation: Conversation): Promise<void> {
  const { executeTurn } = proxyActivities<MemberActivities>({
    taskQueue: activityQueue(conversation.engine, conversation.profile),
    startToCloseTimeout: "3 minutes",
    scheduleToCloseTimeout: "10 minutes",
    heartbeatTimeout: "15 seconds",
    retry: { maximumAttempts: 3 },
  });
  const turns = new Map<string, { text: string; result: Promise<string> }>();
  let previous = Promise.resolve();
  let failed = false;

  function validate(value: TurnRequest): TurnRequest {
    const parsed = submitSchema.safeParse(value);
    if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid turn request");
    const request = parsed.data;
    if (request.ownerId !== conversation.ownerId || request.conversationId !== conversation.conversationId) {
      throw ApplicationFailure.nonRetryable("Conversation not found");
    }
    const existing = turns.get(request.requestId);
    if (existing) {
      if (existing.text !== request.text) throw ApplicationFailure.nonRetryable("Request payload conflict");
      return request;
    }
    if (failed || turns.size >= 4) throw ApplicationFailure.nonRetryable("Conversation closed to new turns");
    return request;
  }

  setHandler(submitTurn, (value) => {
    const request = validate(value);
    const existing = turns.get(request.requestId);
    if (existing) return existing.result;
    const result = previous.then(async () => {
      if (failed) throw ApplicationFailure.nonRetryable("Previous turn failed");
      return executeTurn(request);
    });
    turns.set(request.requestId, { text: request.text, result });
    previous = result.then(() => {}, () => { failed = true; });
    return result;
  }, { validator: validate });

  await condition(() => (failed || turns.size === 4) && allHandlersFinished());
  if (failed) throw ApplicationFailure.nonRetryable("Member conversation failed");
}

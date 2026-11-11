import { allHandlersFinished, ApplicationFailure, condition, defineUpdate, proxyActivities, setHandler } from "@temporalio/workflow";
import { submitSchema, type Conversation, type TurnRequest } from "./domain.ts";
import type { Approval, Decision } from "./approvals.ts";
import type { MemberActivities } from "./activities.ts";

import { activityQueue } from "./queues.ts";

export const submitTurn = defineUpdate<string, [TurnRequest]>("submitTurn");

export async function memberConversation(conversation: Conversation): Promise<void> {
  const { executeTurn, decideApproval, settleApproval, cancelPending } = proxyActivities<MemberActivities>({
    taskQueue: activityQueue(conversation.engine, conversation.profile),
    startToCloseTimeout: "3 minutes",
    scheduleToCloseTimeout: "10 minutes",
    heartbeatTimeout: "15 seconds",
    retry: { maximumAttempts: 3 },
  });
  const turns = new Map<string, { text: string; result: Promise<string> }>();
  let previous = Promise.resolve();
  let failed = false;

  let pending: Approval | undefined;
  let answered = false;

  async function waitForPublishedCall(requestId: string) {
    const turn = turns.get(requestId);
    if (!pending && turn) {
      await Promise.race([condition(() => pending?.requestId === requestId), turn.result]);
    }
  }

  function matches(value: Decision) {
    return pending && ["approve", "deny"].includes(value.choice) &&
      value.ownerId === pending.ownerId && value.memberId === pending.memberId &&
      value.conversationId === pending.conversationId && value.requestId === pending.requestId &&
      value.invocationId === pending.invocationId && value.nativeCallId === pending.nativeCallId &&
      value.approvalId === pending.approvalId && value.version === pending.version &&
      value.argumentDigest === pending.argumentDigest;
  }

  setHandler(defineUpdate<string, [Decision]>("decide"), async (value) => {
    if (value.ownerId !== conversation.ownerId) throw ApplicationFailure.nonRetryable("Conversation not found");
    await waitForPublishedCall(value.requestId);
    if (!matches(value)) throw ApplicationFailure.nonRetryable("Unknown or stale approval");
    const decision = await decideApproval(value);
    answered = true;
    return decision;
  });

  setHandler(defineUpdate<void, [{ ownerId: string; conversationId: string; requestId: string }]>("cancelPending"),
    async (value) => {
      if (value.ownerId !== conversation.ownerId) throw ApplicationFailure.nonRetryable("Conversation not found");
      await waitForPublishedCall(value.requestId);
      if (!pending || value.ownerId !== conversation.ownerId || value.conversationId !== conversation.conversationId ||
          value.requestId !== pending.requestId) throw ApplicationFailure.nonRetryable("No matching pending turn");
      await cancelPending(pending);
      answered = true;
    });

  async function run(request: TurnRequest) {
    const first = await executeTurn(request);
    if (first.kind === "complete") return first.text;
    pending = first.approval;
    answered = false;
    await condition(() => answered);
    const outcome = await settleApproval(first.approval);
    const resumed = await executeTurn(request, { approval: first.approval, outcome });
    pending = undefined;
    if (resumed.kind !== "complete") throw ApplicationFailure.nonRetryable("Expected a completed continuation");
    return resumed.text;
  }

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
      return run(request);
    });
    turns.set(request.requestId, { text: request.text, result });
    previous = result.then(() => {}, () => { failed = true; });
    return result;
  }, { validator: validate });

  await condition(() => (failed || turns.size === 4) && allHandlersFinished());
  if (failed) throw ApplicationFailure.nonRetryable("Member conversation failed");
}

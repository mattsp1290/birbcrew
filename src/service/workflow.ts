import {
  allHandlersFinished, ApplicationFailure, CancellationScope, workflowInfo, condition, defineSignal, defineUpdate,
  executeChild, getExternalWorkflowHandle, isCancellation, proxyActivities, setHandler
} from "@temporalio/workflow";
import { submitSchema, type Conversation, type TurnRequest } from "./domain.ts";
import type { Approval, Decision } from "./approvals.ts";
import type { ChildKey, ChildStore } from "./children.ts";
import type { MemberActivities, Resume } from "./activities.ts";

import type { MemberStore } from "./store.ts";
import { activityQueue, memberTaskQueue } from "./queues.ts";

export const submitTurn = defineUpdate<string, [TurnRequest]>("submitTurn");

const childDecision = defineSignal("childDecision");

function actions(queue: string) {
  return proxyActivities<MemberActivities>({
    taskQueue: queue, startToCloseTimeout: "3 minutes", scheduleToCloseTimeout: "10 minutes",
    heartbeatTimeout: "15 seconds", retry: { maximumAttempts: 3 }, cancellationType: "WAIT_CANCELLATION_COMPLETED",
  });
}

export async function piChildWorkflow(key: ChildKey, profile: string): Promise<void> {
  const { executeChildSegment, settleApproval, cancelChild } = actions(activityQueue("pi", profile));
  const {reconcileChild} = proxyActivities<{reconcileChild:ChildStore["reconcile"]}>({
    taskQueue:memberTaskQueue,startToCloseTimeout:"20 seconds",scheduleToCloseTimeout:"2 minutes",
  });
  async function segment(resume?: Resume) {
    try {
      return await executeChildSegment(key,resume);
    } catch (error) {
      if (isCancellation(error)) throw error;
      return reconcileChild(key,workflowInfo().runId,!!resume);
    }
  }
  let answered = false;
  setHandler(childDecision, () => { answered = true; });
  try {
    const first = await segment();
    if (first.kind === "complete") return;
    await condition(() => answered);
    const outcome = await settleApproval(first.approval);
    const last = await segment({ approval: first.approval, outcome });
    if (last.kind !== "complete") throw ApplicationFailure.nonRetryable("Repeated child approval");
  } catch (error) {
    if (!isCancellation(error)) throw error;
    await CancellationScope.nonCancellable(() => cancelChild(key));
    throw error;
  }
}

export async function memberConversation(conversation: Conversation): Promise<void> {
  const { executeTurn, decideApproval, settleApproval, cancelPending, cancelChild } = actions(activityQueue(conversation.engine, conversation.profile));
  const { reconcileTurn } = proxyActivities<Pick<MemberStore, "reconcileTurn">>({
    taskQueue: memberTaskQueue, startToCloseTimeout: "20 seconds",
  });
  const { recoverPending } = proxyActivities<MemberActivities>({
    taskQueue: activityQueue(conversation.engine, conversation.profile),
    startToCloseTimeout: "20 seconds", scheduleToCloseTimeout: "60 seconds", retry: { maximumAttempts: 2 },
  });
  const turns = new Map<string, { text: string; result: Promise<string> }>();
  let previous = Promise.resolve();
  let failed = false;

  let pending: Approval | undefined;
  let answered = false;
  let batch: { requestId: string; children: ChildKey[]; scope: CancellationScope } | undefined;

  async function waitForPublishedCall(requestId: string) {
    const turn = turns.get(requestId);
    if (!pending && !batch && turn) {
      await Promise.race([condition(() => pending?.requestId === requestId || batch?.requestId === requestId), turn.result]);
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
    const child = batch?.requestId === value.requestId && batch.children.find(({ childId }) => childId === value.invocationId);
    if (child) {
      const choice = await decideApproval(value);
      await getExternalWorkflowHandle(`birbcrew-ts/child/${child.childId}`).signal(childDecision);
      return choice;
    }
    if (!matches(value)) throw ApplicationFailure.nonRetryable("Unknown or stale approval");
    const decision = await decideApproval(value);
    answered = true;
    return decision;
  });

  setHandler(defineUpdate<void, [{ ownerId: string; conversationId: string; requestId: string }]>("cancelPending"),
    async (value) => {
      if (value.ownerId !== conversation.ownerId) throw ApplicationFailure.nonRetryable("Conversation not found");
      await waitForPublishedCall(value.requestId);
      const active = batch;
      if (active && active.requestId === value.requestId && value.conversationId === conversation.conversationId) {
        await cancelPending({ ...value, memberId: conversation.memberId });
        active.scope.cancel();
        return;
      }
      if (!pending || value.ownerId !== conversation.ownerId || value.conversationId !== conversation.conversationId ||
          value.requestId !== pending.requestId) throw ApplicationFailure.nonRetryable("No matching pending turn");
      await cancelPending(pending);
      answered = true;
    });

  async function segment(request: TurnRequest, resume?: Resume | {children:true}) {
    try {
      return await executeTurn(request, resume);
    } catch (error) {
      const run = workflowInfo().runId;
      const result = await CancellationScope.nonCancellable(() => reconcileTurn(request, run, Boolean(resume)));
      if (result?.kind === "recover") {
        try {
          const pending = await recoverPending(request, run);
          if (pending) return pending;
        } catch {
          // The final database check also handles a lost recovery acknowledgement.
        }
        const final = await CancellationScope.nonCancellable(() => reconcileTurn(request, run, false, false));
        if (final?.kind === "pending" || final?.kind === "complete") return final;
      } else if (result) {
        return result;
      }
      throw error;
    }
  }

  async function run(request: TurnRequest) {
    const first = await segment(request);
    if (first.kind === "complete") return first.text;
    if (first.kind === "delegated") {
      const scope = new CancellationScope();
      batch = { requestId: request.requestId, children: first.children, scope };
      try {
        const operations = first.children.map(key => scope.run(() => executeChild(piChildWorkflow, {
          workflowId: `birbcrew-ts/child/${key.childId}`, workflowIdReusePolicy: "REJECT_DUPLICATE",
          cancellationType: "WAIT_CANCELLATION_COMPLETED", args: [key, conversation.profile],
        })));
        const results = await Promise.allSettled(operations);
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") continue;
          if (!isCancellation(result.reason)) throw result.reason;
          await CancellationScope.nonCancellable(() => cancelChild(first.children[index]));
        }
      } finally {
        batch = undefined;
      }
      const resumed = await segment(request, { children: true });
      if (resumed.kind !== "complete") throw ApplicationFailure.nonRetryable("Expected a completed delegation");
      return resumed.text;
    }
    pending = first.approval;
    answered = false;
    await condition(() => answered);
    const outcome = await settleApproval(first.approval);
    const resumed = await segment(request, { approval: first.approval, outcome });
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

import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/client";
import { ApprovalStore, recordWorkItemArguments, type Approval, type Decision, type ToolOutcome } from "./approvals.ts";
import { checkpointSchema, MemberStoreError, type Checkpoint, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberStore } from "./store.ts";

export interface DriverInput {
  threadId: string;
  runId: string;
  text: string;
  checkpoint: Checkpoint | null;
  signal: AbortSignal;
  continuation?: { nativeCallId: string; result: ToolOutcome };
}

export type DriverResult =
  | { kind: "complete"; text: string; checkpoint: unknown }
  | { kind: "pending"; proposal: { nativeCallId: string; name: "record_work_item"; arguments: unknown }; checkpoint: unknown };
export type TurnDriver = (input: DriverInput, member: Conversation) => Promise<DriverResult>;
export type MemberProfiles = ReadonlyMap<string, Readonly<Partial<Record<Conversation["engine"], TurnDriver>>>>;
type PublicSegment = { kind: "complete"; text: string } | { kind: "pending"; approval: Approval };
type Resume = { approval: Approval; outcome: ToolOutcome };

export function memberActivities(store: MemberStore, profiles: MemberProfiles) {
  const ledger = new ApprovalStore(store.pool);
  return {
    async decideApproval(input: Decision) {
      try {
        return await ledger.decide(input);
      } catch (error) {
        if (error instanceof MemberStoreError) throw ApplicationFailure.nonRetryable(error.code);
        throw error;
      }
    },
    async cancelPending(approval: Approval) {
      const { ownerId, memberId, conversationId, requestId } = approval;
      await ledger.cancelTurn({ ownerId, memberId, conversationId, requestId });
    },
    async settleApproval(approval: Approval) {
      return await ledger.settleConfirmed(approval);
    },
    async executeTurn(request: TurnRequest, resume?: Resume): Promise<PublicSegment> {
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat(), 2000);
      try {
        const workflow = ctx.info.workflowExecution;
        if (!workflow) throw ApplicationFailure.nonRetryable("Member turn requires a conversation workflow");
        const identity = { workflowRunId: workflow.runId, activityId: ctx.info.activityId, attempt: ctx.info.attempt };
        const turn = resume ? await store.beginResume(request, resume.approval, identity) : await store.beginTurn(request, identity);
        if (turn.kind === "replay") return { kind: "complete", text: turn.reply };
        if (turn.kind === "pending") return turn;
        if (turn.kind === "uncertain") throw ApplicationFailure.nonRetryable("Native turn outcome unknown");
        const { conversation, token } = turn;
        const { ownerId, conversationId, requestId } = request;
        const claim = { ownerId, conversationId, requestId, token };
        let result;
        let proposal;
        try {
          const driver = profiles.get(conversation.profile)?.[conversation.engine];
          if (!driver) throw new Error("Unsupported member profile");
          ctx.cancellationSignal.throwIfAborted();
          result = await driver({
            threadId: conversationId, runId: requestId, text: request.text,
            checkpoint: turn.checkpoint, signal: ctx.cancellationSignal,
            ...(resume && { continuation: { nativeCallId: resume.approval.nativeCallId, result: resume.outcome } }),
          }, conversation);
          ctx.cancellationSignal.throwIfAborted();
          if (result.kind === "pending") {
            if (resume) throw new Error("Unexpected second protected call");
            const { nativeCallId, name: toolName } = result.proposal;
            const args = recordWorkItemArguments.parse(result.proposal.arguments);
            const checkpoint = checkpointSchema.parse(result.checkpoint);
            if (checkpoint.engine !== conversation.engine || args.operation_id !== requestId) throw new Error("Unbound proposal");
            proposal = { input: {
              ...claim, memberId: conversation.memberId, invocationId: requestId, nativeCallId, toolName, arguments: args,
            }, checkpoint };
          }
        } catch {
          await store.markUncertain(claim);
          throw ApplicationFailure.nonRetryable(`${conversation.engine} turn failed before a confirmed checkpoint`);
        }
        if (proposal) return { kind: "pending", approval: await ledger.propose(proposal.input, proposal.checkpoint) };
        if (result.kind !== "complete") throw ApplicationFailure.nonRetryable("Missing protected proposal");
        const text = await store.commitTurn({ ...claim, reply: result.text, checkpoint: result.checkpoint });
        return { kind: "complete", text };
      } catch (error) {
        if (error instanceof MemberStoreError) throw ApplicationFailure.nonRetryable(error.code);
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  };
}
export type MemberActivities = ReturnType<typeof memberActivities>;

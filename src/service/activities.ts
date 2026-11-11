import type { Supervisor } from "./supervisor.ts";
import type { MemberProfile } from "./profiles.ts";
import { recoverClaudeProposal } from "./claude.ts";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/client";
import { ApprovalStore, recordWorkItemArguments, type Approval, type Decision, type ToolOutcome } from "./approvals.ts";
import { MemberStoreError, type Checkpoint, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberStore } from "./store.ts";

export interface DriverInput {
  threadId: string;
  runId: string;
  text: string;
  checkpoint: Checkpoint | null;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  continuation?: { nativeCallId: string; result: ToolOutcome };
}

export type DriverResult =
  | { kind: "complete"; text: string; checkpoint: unknown }
  | { kind: "pending"; proposal: { nativeCallId: string; name: "record_work_item"; arguments: unknown }; checkpoint: unknown };
export type TurnDriver = (input: DriverInput, member: Conversation) => Promise<DriverResult>;
export type MemberProfiles = ReadonlyMap<string, Readonly<Partial<Record<Conversation["engine"], TurnDriver>>>>;
export type PublicSegment = { kind: "complete"; text: string } | { kind: "pending"; approval: Approval };
export type Resume = { approval: Approval; outcome: ToolOutcome };

export function memberActivities(store: MemberStore, supervisor: Supervisor, profiles: ReadonlyMap<string, MemberProfile>, stateDir: string) {
  const ledger = new ApprovalStore(store.pool);
  return {
    async recoverPending(request: TurnRequest, workflowRunId: string): Promise<PublicSegment | null> {
      const signal = Context.current().cancellationSignal;
      for (let count = 0; count < 30; count++) {
        const recovery = await store.stoppedProposal(request, workflowRunId);
        if (!recovery) return null;
        if (recovery.kind === "pending") return recovery;
        if (recovery.kind === "stopping") {
          await delay(200, undefined, { signal });
          continue;
        }
        const { conversation: member, token, checkpoint } = recovery;
        const profile = profiles.get(member.profile);
        if (!profile?.claude || profile.protectedTool !== "record_work_item") return null;
        const result = await recoverClaudeProposal({
          threadId: request.conversationId, runId: request.requestId, text: request.text, checkpoint, signal,
        }, { ...profile.claude, ownerId: member.ownerId, memberId: member.memberId, stateDir });
        const approval = await ledger.propose({ ownerId: request.ownerId, conversationId: request.conversationId,
          requestId: request.requestId, memberId: member.memberId, token, invocationId: request.requestId,
          nativeCallId: result.proposal.nativeCallId, toolName: result.proposal.name,
          arguments: recordWorkItemArguments.parse(result.proposal.arguments) }, result.checkpoint, true);
        return { kind: "pending", approval };
      }
      return null;
    },
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
        return await supervisor.start({ ...request, token: turn.token, execution: identity }, ctx.cancellationSignal);
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

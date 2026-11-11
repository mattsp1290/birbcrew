import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/client";
import { MemberStoreError, type Checkpoint, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberStore } from "./store.ts";

export interface DriverInput {
  threadId: string;
  runId: string;
  text: string;
  checkpoint: Checkpoint | null;
  signal: AbortSignal;
}

export type TurnDriver = (input: DriverInput, member: Conversation) => Promise<{ text: string; checkpoint: unknown }>;
export type MemberProfiles = ReadonlyMap<string, Readonly<Partial<Record<Conversation["engine"], TurnDriver>>>>;

export function memberActivities(store: MemberStore, profiles: MemberProfiles) {
  return {
    async executeTurn(request: TurnRequest): Promise<string> {
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat(), 2000);
      try {
        const workflow = ctx.info.workflowExecution;
        if (!workflow) throw ApplicationFailure.nonRetryable("Member turn requires a conversation workflow");
        const turn = await store.beginTurn(request, {
          workflowRunId: workflow.runId,
          activityId: ctx.info.activityId,
          attempt: ctx.info.attempt,
        });
        if (turn.kind === "replay") return turn.reply;
        if (turn.kind === "uncertain") throw ApplicationFailure.nonRetryable("Native turn outcome unknown");
        const { conversation, token } = turn;
        const { ownerId, conversationId, requestId } = request;
        const claim = { ownerId, conversationId, requestId, token };
        let result;
        try {
          const driver = profiles.get(conversation.profile)?.[conversation.engine];
          if (!driver) throw new Error("Unsupported member profile");
          ctx.cancellationSignal.throwIfAborted();
          result = await driver({
            threadId: conversationId, runId: requestId, text: request.text,
            checkpoint: turn.checkpoint, signal: ctx.cancellationSignal,
          }, conversation);
          ctx.cancellationSignal.throwIfAborted();
        } catch {
          await store.markUncertain(claim);
          throw ApplicationFailure.nonRetryable(`${conversation.engine} turn failed before a confirmed checkpoint`);
        }
        return await store.commitTurn({ ...claim, reply: result.text, checkpoint: result.checkpoint });
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

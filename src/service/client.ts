import { ApprovalStore, decisionSchema } from "./approvals.ts";
import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { MemberStoreError, openSchema, submitSchema, conversationKey, turnKey, type Conversation } from "./domain.ts";
import type { MemberStore } from "./store.ts";
import type { memberConversation } from "./workflow.ts";

import { memberTaskQueue } from "./queues.ts";

export class MemberClient {
  private readonly store: MemberStore;
  private readonly temporal: Client;

  constructor(store: MemberStore, temporal: Client) {
    this.store = store;
    this.temporal = temporal;
  }

  private async workflow(conversation: Conversation) {
    const workflowId = `birbcrew-ts/member/${conversation.memberId}/conversation/${conversation.conversationId}`;
    const runId = await this.store.workflowRunId(conversation);
    if (runId) return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId, runId);
    try {
      return await this.temporal.workflow.start<typeof memberConversation>("memberConversation", {
        taskQueue: memberTaskQueue,
        workflowId,
        workflowIdConflictPolicy: "USE_EXISTING",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        args: [conversation],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
    }
  }

  async open(input: unknown) {
    const conversation = await this.store.openConversation(openSchema.parse(input));
    await this.workflow(conversation);
    return conversation;
  }

  async pending(input: unknown) {
    const key = conversationKey.parse(input);
    const { memberId } = await this.store.getConversation(key);
    return new ApprovalStore(this.store.pool).pending({ ...key, memberId });
  }

  async decide(input: unknown) {
    const value = decisionSchema.parse(input);
    const key = { ownerId: value.ownerId, conversationId: value.conversationId };
    const conversation = await this.store.getConversation(key);
    if (conversation.memberId !== value.memberId) throw new MemberStoreError("not_found");
    const ledger = new ApprovalStore(this.store.pool);
    const prior = await ledger.previousDecision(value);
    if (prior) return prior;
    const handle = await this.workflow(conversation);
    try {
      return await handle.executeUpdate<string, [typeof value]>("decide", { args: [value] });
    } catch (error) {
      const recorded = await ledger.previousDecision(value);
      if (recorded) return recorded;
      throw error;
    }
  }

  async cancelPending(input: unknown) {
    const key = turnKey.parse(input);
    const conversation = await this.store.getConversation({ ownerId: key.ownerId, conversationId: key.conversationId });
    const ledger = new ApprovalStore(this.store.pool);
    if (await ledger.isCancelled({ ...key, memberId: conversation.memberId })) return;
    const handle = await this.workflow(conversation);
    return handle.executeUpdate<void, [typeof key]>("cancelPending", { args: [key] });
  }

  async accept(input: unknown) {
    const request = submitSchema.parse(input);
    const conversation = await this.store.getConversation({ ownerId: request.ownerId, conversationId: request.conversationId });
    if (await this.store.committedReply(request) === undefined) {
      const handle = await this.workflow(conversation);
      try {
        await handle.startUpdate("submitTurn", { args: [request], waitForStage: "ACCEPTED" });
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        if (await this.store.committedReply(request) === undefined) throw new MemberStoreError("conflict");
      }
    }
    return { requestId: request.requestId };
  }

  async submit(input: unknown): Promise<string> {
    const request = submitSchema.parse(input);
    const conversation = await this.store.getConversation({ ownerId: request.ownerId, conversationId: request.conversationId });
    const reply = await this.store.committedReply(request);
    if (reply !== undefined) return reply;
    const handle = await this.workflow(conversation);
    try {
      return await handle.executeUpdate<string, [typeof request]>("submitTurn", { args: [request] });
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      const settled = await this.store.committedReply(request);
      if (settled !== undefined) return settled;
      throw new MemberStoreError("conflict");
    }
  }
}

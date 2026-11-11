import { EventType as E, type Event, type Message } from "@ag-ui/core";
import type { Pool, PoolClient } from "pg";
import type { Approval, ToolOutcome } from "./approvals.ts";
import { MemberStoreError, type Conversation } from "./domain.ts";

const retainedEvents = 256;

type PublicApproval = Omit<Approval, "argumentDigest" | "ownerId"> & { choices: ["approve", "deny"] };
type Phase = "idle" | "running" | "waiting" | "complete" | "failed";
type Projection = {
  conversationId: string;
  memberId: string;
  engine: Conversation["engine"];
  profile: string;
  phase: Phase;
  openStep: string | null;
  pendingApprovals: PublicApproval[];
};

type Change =
  | { kind: "input" | "reply"; requestId: string; text: string }
  | { kind: "call"; approval: Approval }
  | { kind: "answered" | "resume"; approvalId: string }
  | { kind: "cancelled"; requestId: string }
  | { kind: "result"; approvalId: string; outcome: ToolOutcome }
  | { kind: "failed"; requestId: string };

export interface PublicSnapshot {
  cursor: number;
  state: Projection;
  messages: Message[];
}

type StoredSnapshot = PublicSnapshot & { complete: boolean };

const selection = `SELECT COALESCE(s.history_complete, true) AS complete, COALESCE(s.cursor, 0) AS cursor, COALESCE(s.messages, '[]'::jsonb) AS messages,
  COALESCE(s.state, jsonb_build_object('conversationId', c.conversation_id, 'memberId', m.member_id,
  'engine', m.engine, 'profile', m.profile, 'phase', 'idle', 'openStep', NULL, 'pendingApprovals', '[]'::jsonb)) AS state
  FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING (owner_id, member_id)
  LEFT JOIN birbcrew_ts.public_snapshots s USING (conversation_id)`;

export async function readSnapshot(db: Pool, owner: string, id: string): Promise<PublicSnapshot> {
  const { rows: [snapshot] } = await db.query<StoredSnapshot>(selection + " WHERE c.owner_id=$1 AND c.conversation_id=$2", [owner, id]);
  if (!snapshot) throw new MemberStoreError("not_found");
  if (!snapshot.complete) throw new MemberStoreError("history_unavailable");
  return { state: snapshot.state, cursor: snapshot.cursor, messages: snapshot.messages };
}

function logicalKey(change: Change) {
  switch (change.kind) {
    case "call": return "call/" + change.approval.approvalId;
    case "answered":
    case "resume":
    case "result": return change.kind + "/" + change.approvalId;
    default: return change.kind + "/" + change.requestId;
  }
}

function apply({ messages, state }: PublicSnapshot, change: Change): Event[] {
  const frames: Event[] = [];
  function startStep(name: string) {
    state.openStep = name;
    frames.push({ type: E.STEP_STARTED, stepName: name });
  }
  function finishStep() {
    if (state.openStep) frames.push({ type: E.STEP_FINISHED, stepName: state.openStep });
    state.openStep = null;
  }
  switch (change.kind) {
    case "input":
      messages.push({ id: change.requestId, role: "user", content: change.text });
      state.phase = "running";
      startStep(change.requestId);
      break;
    case "call": {
      const { memberId, conversationId, requestId, invocationId, nativeCallId, approvalId, version, policyVersion,
        toolName, summary } = change.approval;
      state.pendingApprovals.push({ memberId, conversationId, requestId, invocationId, nativeCallId,
        approvalId, version, policyVersion, toolName, summary, choices: ["approve", "deny"] });
      state.phase = "waiting";
      const args = JSON.stringify({ operation_id: requestId });
      const messageId = approvalId + "/assistant";
      messages.push({ id: messageId, role: "assistant", toolCalls: [
        { id: approvalId, type: "function", function: { name: toolName, arguments: args } },
      ] });
      frames.push({ type: E.TOOL_CALL_START, toolCallId: approvalId, toolCallName: toolName, parentMessageId: messageId },
        { type: E.TOOL_CALL_ARGS, toolCallId: approvalId, delta: args },
        { type: E.TOOL_CALL_END, toolCallId: approvalId });
      finishStep();
      break;
    }
    case "answered":
      state.pendingApprovals = state.pendingApprovals.filter((p) => p.approvalId !== change.approvalId);
      state.phase = state.pendingApprovals.length ? "waiting" : "running";
      break;
    case "cancelled":
      state.pendingApprovals = state.pendingApprovals.filter((p) => p.requestId !== change.requestId);
      state.phase = state.pendingApprovals.length ? "waiting" : "running";
      break;
    case "resume":
      startStep(change.approvalId + "/continue");
      break;
    case "result": {
      const id = change.approvalId + "/result";
      const content = JSON.stringify(change.outcome.kind === "recorded" ?
        { kind: "recorded", receiptId: change.outcome.receipt.receiptId } : { kind: change.outcome.kind });
      messages.push({ id, role: "tool", toolCallId: change.approvalId, content });
      frames.push({ type: E.TOOL_CALL_RESULT, messageId: id, toolCallId: change.approvalId, content });
      break;
    }
    case "reply": {
      const id = change.requestId + "/assistant";
      messages.push({ id, role: "assistant", content: change.text });
      frames.push({ type: E.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
        { type: E.TEXT_MESSAGE_CONTENT, messageId: id, delta: change.text }, { type: E.TEXT_MESSAGE_END, messageId: id });
      finishStep();
      state.phase = messages.filter((m) => m.role === "user").length >= 4 ? "complete" : "idle";
      break;
    }
    case "failed":
      finishStep();
      state.phase = "failed";
      state.pendingApprovals = [];
      break;
  }
  if (change.kind !== "resume" && change.kind !== "answered" && change.kind !== "cancelled" && change.kind !== "failed") {
    frames.push({ type: E.MESSAGES_SNAPSHOT, messages });
  }
  frames.push({ type: E.STATE_SNAPSHOT, snapshot: state });
  return frames;
}

// The caller holds the conversation lock in the transaction that committed this change.
export async function publishObservation(db: PoolClient, id: string, change: Change) {
  const { rows: [snapshot] } = await db.query<StoredSnapshot>(selection + " WHERE c.conversation_id=$1 FOR UPDATE OF c", [id]);
  if (!snapshot) throw new MemberStoreError("not_found");
  if (!snapshot.complete) return;
  await db.query(`INSERT INTO birbcrew_ts.public_snapshots (conversation_id,state) VALUES ($1,$2)
    ON CONFLICT DO NOTHING`, [id, JSON.stringify(snapshot.state)]);
  const admitted = await db.query(`INSERT INTO birbcrew_ts.public_publications (conversation_id,logical_key)
    VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, logicalKey(change)]);
  if (!admitted.rowCount) return;
  const frames = apply(snapshot, change);
  await db.query(`INSERT INTO birbcrew_ts.public_events (conversation_id,cursor,event)
    SELECT $1,$2::integer+ordinality,value FROM jsonb_array_elements($3) WITH ORDINALITY`,
    [id, snapshot.cursor, JSON.stringify(frames)]);
  const cursor = snapshot.cursor + frames.length;
  await db.query("UPDATE birbcrew_ts.public_snapshots SET cursor=$2,messages=$3,state=$4 WHERE conversation_id=$1",
    [id, cursor, JSON.stringify(snapshot.messages), JSON.stringify(snapshot.state)]);
  await db.query("DELETE FROM birbcrew_ts.public_events WHERE conversation_id=$1 AND cursor<=$2", [id, cursor - retainedEvents]);
}

export async function readEvents(db: Pool, owner: string, id: string, cursor: number) {
  const { rows } = await db.query<{ cursor: number; event: Event }>(
    `SELECT e.cursor,e.event FROM birbcrew_ts.public_events e JOIN birbcrew_ts.conversations c USING (conversation_id)
     WHERE c.owner_id=$1 AND e.conversation_id=$2 AND e.cursor>$3 ORDER BY e.cursor LIMIT 32`, [owner, id, cursor]);
  return rows;
}

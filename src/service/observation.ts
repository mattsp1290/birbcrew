import { createHash } from "node:crypto";
import { EventType as E, type Event, type Message } from "@ag-ui/core";
import type { Pool, PoolClient } from "pg";
import type { Approval, ToolOutcome } from "./approvals.ts";
import { MemberStoreError, type Conversation } from "./domain.ts";

const retainedEvents = 256;

type PublicApproval = Omit<Approval, "argumentDigest" | "ownerId" | "nativeCallId"> & { choices: ["approve", "deny"] };
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
  | { kind: "toolValue"; invocationId: string; publicId: string; requestId: string }
  | { kind: "toolPreview"; invocationId: string; publicId: string }
  | { kind: "call"; approval: Approval }
  | { kind: "answered" | "resume"; approvalId: string }
  | { kind: "cancelled"; requestId: string }
  | { kind: "result"; approvalId: string; outcome: ToolOutcome }
  | { kind: "text"; messageId: string; index: number; delta: string }
  | { kind: "failed"; requestId: string };

export interface PublicSnapshot {
  cursor: number;
  state: Projection;
  messages: Message[];
  openTools: Record<string, OpenTool>;
  openText: { id: string; prefix: string; count: number } | null;
}

type OpenTool = { invocationId: string; publicId: string; prefix: string };

export function toolBootstrap(tool: OpenTool): Event[] {
  return [
    { type: E.TOOL_CALL_START, toolCallId: tool.publicId, toolCallName: "record_work_item", parentMessageId: tool.publicId + "/assistant" },
    { type: E.TOOL_CALL_ARGS, toolCallId: tool.publicId, delta: tool.prefix },
  ];
}

type StoredSnapshot = PublicSnapshot & { complete: boolean };

const selection = `SELECT COALESCE(s.open_tools,'{}'::jsonb) AS "openTools", s.open_text AS "openText", COALESCE(s.history_complete, true) AS complete, COALESCE(s.cursor, 0) AS cursor, COALESCE(s.messages, '[]'::jsonb) AS messages,
  COALESCE(s.state, jsonb_build_object('conversationId', c.conversation_id, 'memberId', m.member_id,
  'engine', m.engine, 'profile', m.profile, 'phase', 'idle', 'openStep', NULL, 'pendingApprovals', '[]'::jsonb)) AS state
  FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING (owner_id, member_id)
  LEFT JOIN birbcrew_ts.public_snapshots s USING (conversation_id)`;

export async function readSnapshot(db: Pool, owner: string, id: string): Promise<PublicSnapshot> {
  const { rows: [snapshot] } = await db.query<StoredSnapshot>(selection + " WHERE c.owner_id=$1 AND c.conversation_id=$2", [owner, id]);
  if (!snapshot) throw new MemberStoreError("not_found");
  if (!snapshot.complete) throw new MemberStoreError("history_unavailable");
  return { state: snapshot.state, cursor: snapshot.cursor, messages: snapshot.messages, openText: snapshot.openText, openTools: snapshot.openTools };
}

function logicalKey(change: Change) {
  switch (change.kind) {
    case "text": return "text/" + change.messageId + "/" + change.index;
    case "toolValue": return change.kind + "/" + change.publicId;
    case "toolPreview": return "toolPreview/" + change.publicId;
    case "call": return "call/" + change.approval.approvalId;
    case "answered":
    case "resume":
    case "result": return change.kind + "/" + change.approvalId;
    default: return change.kind + "/" + change.requestId;
  }
}

function apply(snapshot: PublicSnapshot, change: Change): Event[] {
  const { messages, state } = snapshot;
  const frames: Event[] = [];
  function startStep(name: string) {
    state.openStep = name;
    frames.push({ type: E.STEP_STARTED, stepName: name });
  }
  function finishStep() {
    if (state.openStep) frames.push({ type: E.STEP_FINISHED, stepName: state.openStep });
    state.openStep = null;
  }
  function finishText() {
    if (snapshot.openText) frames.push({ type: E.TEXT_MESSAGE_END, messageId: snapshot.openText.id });
    snapshot.openText = null;
  }
  switch (change.kind) {
    case "text": {
      if (!snapshot.openText) {
        snapshot.openText = { id: change.messageId, prefix: "", count: 0 };
        frames.push({ type: E.TEXT_MESSAGE_START, messageId: change.messageId, role: "assistant" });
      }
      const text = snapshot.openText;
      if (!state.openStep || text.id !== change.messageId || text.count !== change.index) throw new MemberStoreError("stale");
      if (text.count >= 1024 || !change.delta || change.delta.includes("\0") || !change.delta.isWellFormed() ||
          Buffer.byteLength(text.prefix) + Buffer.byteLength(change.delta) > 65_536) throw new MemberStoreError("input_limit");
      text.count++;
      text.prefix += change.delta;
      frames.push({ type: E.TEXT_MESSAGE_CONTENT, messageId: text.id, delta: change.delta });
      return frames;
    }
    case "input":
      messages.push({ id: change.requestId, role: "user", content: change.text });
      state.phase = "running";
      startStep(change.requestId);
      break;
    case "toolValue": {
      const tool = snapshot.openTools[change.invocationId];
      if (tool?.publicId !== change.publicId) throw new MemberStoreError("stale");
      const delta = JSON.stringify(change.requestId);
      tool.prefix += delta;
      return [{ type: E.TOOL_CALL_ARGS, toolCallId: tool.publicId, delta }];
    }
    case "toolPreview": {
      if (!state.openStep || snapshot.openTools[change.invocationId]) throw new MemberStoreError("stale");
      finishText();
      const tool = { invocationId: change.invocationId, publicId: change.publicId, prefix: '{"operation_id":' };
      snapshot.openTools[tool.invocationId] = tool;
      frames.push(...toolBootstrap(tool));
      return frames;
    }
    case "call": {
      const { memberId, conversationId, requestId, invocationId, approvalId, version, policyVersion,
        toolName, summary } = change.approval;
      finishText();
      state.pendingApprovals.push({ memberId, conversationId, requestId, invocationId,
        approvalId, version, policyVersion, toolName, summary, choices: ["approve", "deny"] });
      state.phase = "waiting";
      const args = JSON.stringify({ operation_id: requestId });
      const messageId = approvalId + "/assistant";
      messages.push({ id: messageId, role: "assistant", toolCalls: [
        { id: approvalId, type: "function", function: { name: toolName, arguments: args } },
      ] });
      const preview = snapshot.openTools[invocationId];
      if (preview) {
        if (preview.publicId !== approvalId || !args.startsWith(preview.prefix)) throw new MemberStoreError("conflict");
        frames.push({ type: E.TOOL_CALL_ARGS, toolCallId: approvalId, delta: args.slice(preview.prefix.length) });
        delete snapshot.openTools[invocationId];
      } else {
        frames.push({ type: E.TOOL_CALL_START, toolCallId: approvalId, toolCallName: toolName, parentMessageId: messageId },
          { type: E.TOOL_CALL_ARGS, toolCallId: approvalId, delta: args });
      }
      frames.push({ type: E.TOOL_CALL_END, toolCallId: approvalId });
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
      if (Object.keys(snapshot.openTools).length) throw new MemberStoreError("conflict");
      const id = snapshot.openText?.id ?? change.requestId + "/assistant";
      if (snapshot.openText) {
        if (snapshot.openText.prefix !== change.text) throw new MemberStoreError("conflict");
        finishText();
      } else {
        frames.push({ type: E.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
          { type: E.TEXT_MESSAGE_CONTENT, messageId: id, delta: change.text }, { type: E.TEXT_MESSAGE_END, messageId: id });
      }
      messages.push({ id, role: "assistant", content: change.text });
      finishStep();
      state.phase = messages.filter((m) => m.role === "user").length >= 4 ? "complete" : "idle";
      break;
    }
    case "failed":
      for (const tool of Object.values(snapshot.openTools)) {
        frames.push({ type: E.TOOL_CALL_END, toolCallId: tool.publicId });
      }
      snapshot.openTools = {};
      finishText();
      finishStep();
      state.phase = "failed";
      state.pendingApprovals = [];
      break;
  }
  if (change.kind !== "resume" && change.kind !== "answered" && change.kind !== "cancelled") {
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
  const key = logicalKey(change);
  const digest = change.kind === "text" ? createHash("sha256").update(change.delta).digest() : null;
  const admitted = await db.query(`INSERT INTO birbcrew_ts.public_publications (conversation_id,logical_key,payload_digest)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, key, digest]);
  if (!admitted.rowCount) {
    if (digest) {
      const same = await db.query(`SELECT 1 FROM birbcrew_ts.public_publications
        WHERE conversation_id=$1 AND logical_key=$2 AND payload_digest=$3`, [id, key, digest]);
      if (!same.rowCount) throw new MemberStoreError("conflict");
    }
    return;
  }
  const frames = apply(snapshot, change);
  await db.query(`INSERT INTO birbcrew_ts.public_events (conversation_id,cursor,event)
    SELECT $1,$2::integer+ordinality,value FROM jsonb_array_elements($3) WITH ORDINALITY`,
    [id, snapshot.cursor, JSON.stringify(frames)]);
  const cursor = snapshot.cursor + frames.length;
  if (change.kind === "text" || change.kind === "toolPreview" || change.kind === "toolValue") {
    await db.query("UPDATE birbcrew_ts.public_snapshots SET cursor=$2,open_text=$3,open_tools=$4 WHERE conversation_id=$1",
      [id, cursor, snapshot.openText && JSON.stringify(snapshot.openText), JSON.stringify(snapshot.openTools)]);
    return;
  }
  await db.query("UPDATE birbcrew_ts.public_snapshots SET cursor=$2,messages=$3,state=$4,open_text=$5,open_tools=$6 WHERE conversation_id=$1",
    [id, cursor, JSON.stringify(snapshot.messages), JSON.stringify(snapshot.state), snapshot.openText && JSON.stringify(snapshot.openText), JSON.stringify(snapshot.openTools)]);
  await db.query("DELETE FROM birbcrew_ts.public_events WHERE conversation_id=$1 AND cursor<=$2", [id, cursor - retainedEvents]);
}

export async function readEvents(db: Pool, owner: string, id: string, cursor: number) {
  const { rows } = await db.query<{ cursor: number; event: Event }>(
    `SELECT e.cursor,e.event FROM birbcrew_ts.public_events e JOIN birbcrew_ts.conversations c USING (conversation_id)
     WHERE c.owner_id=$1 AND e.conversation_id=$2 AND e.cursor>$3 ORDER BY e.cursor LIMIT 32`, [owner, id, cursor]);
  return rows;
}

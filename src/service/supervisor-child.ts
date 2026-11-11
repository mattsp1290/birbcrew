import type { ChildOutcome, Delegation } from "@birbcrew/pi-subagents";
import type { Pool, PoolClient } from "pg";
import { confirmedApproval, type Approval } from "./approvals.ts";
import type { Checkpoint, Conversation } from "./domain.ts";
import type { Launch } from "./supervisor.ts";

export interface ReadySegment {
  kind: "ready";
  conversation: Conversation;
  checkpoint: Checkpoint | null;
  parentToken: string;
  approval?: Approval;
  childProfile?: Delegation["profile"];
  childResults?: ChildOutcome[];
}

export async function inspectChild(db: PoolClient, launch: Launch): Promise<ReadySegment |
{ kind: "childDone" } | { kind: "pending"; approval: Approval }> {
  const { rows: [row] } = await db.query<{
    ownerId: string;
    memberId: string;
    conversationId: string;
    profile: string;
    role_profile: Delegation["profile"];
    phase: string;
    native_checkpoint: Checkpoint | null;
    approved_id: string | null;
    parent_token: string;
    outcome: ChildOutcome | null;
    launch_revoked: boolean;
    parent_phase: string;
    cancelled: boolean;
    stop_requested: boolean;
  }>(`SELECT c.owner_id AS "ownerId", c.member_id AS "memberId", c.conversation_id AS "conversationId", m.profile,
      j.phase,j.role_profile,j.native_checkpoint,j.approval_id AS approved_id,t.token AS parent_token,
      j.outcome,j.launch_revoked,t.phase AS parent_phase,x.request_id IS NOT NULL AS cancelled,
      EXISTS(SELECT 1 FROM birbcrew_ts.native_stop_requests s
        WHERE (s.conversation_id,s.request_id,s.token)=(j.conversation_id,j.request_id,j.generation)) AS stop_requested
    FROM birbcrew_ts.pi_children j JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
    JOIN birbcrew_ts.conversations c USING(conversation_id) JOIN birbcrew_ts.members m USING(owner_id,member_id)
    LEFT JOIN birbcrew_ts.tool_cancellations x USING(conversation_id,request_id)
    WHERE c.owner_id=$1 AND j.conversation_id=$2 AND j.request_id=$3 AND j.child_id=$4 AND j.generation=$5
      AND j.workflow_run_id=$6 AND j.activity_id=$7 AND j.attempt=$8 AND j.task=$9 AND m.engine='pi'
    FOR UPDATE OF c`, [launch.ownerId, launch.conversationId, launch.requestId, launch.childId, launch.token,
  launch.execution.workflowRunId, launch.execution.activityId, launch.execution.attempt, launch.text]);
  if (!row) throw new Error("Invalid child generation");
  if (row.outcome) return { kind: "childDone" };
  if (row.launch_revoked || row.stop_requested || row.parent_phase !== "started" || row.cancelled) throw new Error("Child admission revoked");
  const { ownerId, memberId, conversationId, profile } = row;
  const conversation: Conversation = { ownerId, memberId, conversationId, profile, engine: "pi" };
  const approval = row.approved_id ? await confirmedApproval(db, {
    ...conversation, requestId: launch.requestId,
    invocationId: launch.childId!, approvalId: row.approved_id
  }) : undefined;
  if (approval && row.phase === "waiting") return { kind: "pending", approval };
  if (row.phase !== (approval ? "resuming" : "running")) throw new Error("Child is not executable");
  return {
    kind: "ready", conversation, checkpoint: row.native_checkpoint, parentToken: row.parent_token, approval,
    childProfile: row.role_profile
  };
}

type ChildStopScope = Pick<Launch, "ownerId" | "conversationId" | "requestId"> & { childId: string; memberId?: string; text?: string };
type ChildStopGrant = { workflowRunId?: string; activityId?: string; token?: string; beforeAttempt?: number; attempt?: number };

// The stop must commit before taking an exclusive lock on the row held by the running SDK.
export async function requestChildStop(pool: Pool | PoolClient, key: ChildStopScope, grant: ChildStopGrant = {}) {
  await pool.query(`INSERT INTO birbcrew_ts.native_stop_requests (conversation_id,request_id,token)
    SELECT j.conversation_id,j.request_id,j.generation FROM birbcrew_ts.pi_children j
    JOIN birbcrew_ts.conversations c USING(conversation_id)
    WHERE c.owner_id=$1 AND j.conversation_id=$2 AND j.request_id=$3 AND j.child_id=$4
      AND j.phase IN ('running','resuming') AND j.generation IS NOT NULL
      AND ($5::text IS NULL OR j.workflow_run_id=$5) AND ($6::text IS NULL OR j.activity_id=$6)
      AND ($7::uuid IS NULL OR j.generation=$7) AND ($8::integer IS NULL OR j.attempt<$8)
      AND ($9::integer IS NULL OR j.attempt=$9) AND ($10::text IS NULL OR j.task=$10)
      AND ($11::uuid IS NULL OR c.member_id=$11)
    ON CONFLICT DO NOTHING`, [key.ownerId, key.conversationId, key.requestId, key.childId,
  grant.workflowRunId ?? null, grant.activityId ?? null, grant.token ?? null, grant.beforeAttempt ?? null,
  grant.attempt ?? null, key.text ?? null, key.memberId ?? null]);
}

export async function lockChildAdmission(db: PoolClient, launch: Launch) {
  return db.query(`SELECT 1 FROM birbcrew_ts.pi_children j
    JOIN birbcrew_ts.turns t USING(conversation_id,request_id) JOIN birbcrew_ts.conversations c USING(conversation_id)
    JOIN birbcrew_ts.native_launches n ON (n.conversation_id,n.request_id,n.child_id,n.token)=
      (j.conversation_id,j.request_id,j.child_id,j.generation)
    WHERE c.owner_id=$1 AND j.conversation_id=$2 AND j.request_id=$3 AND j.child_id=$4 AND j.generation=$5
      AND j.workflow_run_id=$6 AND j.activity_id=$7 AND j.attempt=$8 AND j.task=$9
      AND n.workflow_run_id=j.workflow_run_id AND n.activity_id=j.activity_id AND n.attempt=j.attempt
      AND t.phase='started' AND j.phase IN ('running','resuming') AND NOT j.launch_revoked AND NOT n.stopped
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests s
        WHERE (s.conversation_id,s.request_id,s.token)=(n.conversation_id,n.request_id,n.token))
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.tool_cancellations x WHERE (x.conversation_id,x.request_id)=(t.conversation_id,t.request_id))
    FOR SHARE OF j`, [launch.ownerId, launch.conversationId, launch.requestId, launch.childId, launch.token,
  launch.execution.workflowRunId, launch.execution.activityId, launch.execution.attempt, launch.text]);
}

export async function revokeChild(db: PoolClient, launch: Launch) {
  const result = await db.query(`UPDATE birbcrew_ts.pi_children j SET launch_revoked=true
    FROM birbcrew_ts.conversations c WHERE c.owner_id=$1 AND c.conversation_id=$2 AND j.conversation_id=c.conversation_id
      AND j.request_id=$3 AND j.child_id=$4 AND j.generation=$5 AND j.workflow_run_id=$6
      AND j.activity_id=$7 AND j.attempt=$8 AND j.task=$9 AND j.phase IN ('running','resuming')`,
    [launch.ownerId, launch.conversationId, launch.requestId, launch.childId, launch.token,
    launch.execution.workflowRunId, launch.execution.activityId, launch.execution.attempt, launch.text]);
  if (result.rowCount) return;
  const prior = await db.query(`SELECT 1 FROM birbcrew_ts.native_launches n JOIN birbcrew_ts.conversations c USING(conversation_id)
    JOIN birbcrew_ts.pi_children j USING(conversation_id,request_id,child_id)
    WHERE c.owner_id=$1 AND n.conversation_id=$2 AND n.request_id=$3 AND n.child_id=$4 AND n.token=$5
      AND n.workflow_run_id=$6 AND n.activity_id=$7 AND n.attempt=$8 AND j.task=$9`,
    [launch.ownerId, launch.conversationId, launch.requestId, launch.childId, launch.token,
    launch.execution.workflowRunId, launch.execution.activityId, launch.execution.attempt, launch.text]);
  if (!prior.rowCount) throw new Error("Invalid child stop");
}

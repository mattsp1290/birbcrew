import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { TurnRequest } from "./domain.ts";
import type { Launch } from "./supervisor.ts";

type Stop =
  | { token: string; workflowRunId?: string; activityId?: string; attempt?: number; beforeAttempt?: never }
  | { workflowRunId: string; activityId?: string; beforeAttempt?: number; token?: never; attempt?: never };
type StopRequest = Pick<TurnRequest, "ownerId" | "requestId" | "conversationId"> & { text?: string };

// Publish before retiring the generation so an admitted SDK can release its shared lock.
export async function requestNativeStop(pool: Pool, request: StopRequest, stop: Stop) {
  const { rows: [claim] } = await pool.query<{ token: string }>(`WITH generation AS (
    SELECT t.conversation_id,t.request_id,t.token FROM birbcrew_ts.turns t
    JOIN birbcrew_ts.conversations c USING (conversation_id)
    WHERE c.owner_id=$1 AND t.conversation_id=$2 AND t.request_id=$3 AND t.phase='started'
      AND ($4::text IS NULL OR t.workflow_run_id=$4) AND ($5::text IS NULL OR t.activity_id=$5)
      AND ($6::integer IS NULL OR t.attempt<$6) AND ($7::uuid IS NULL OR t.token=$7)
      AND ($8::bytea IS NULL OR t.prompt_digest=$8) AND ($9::int IS NULL OR t.attempt=$9)
  ), mark AS (
    INSERT INTO birbcrew_ts.native_stop_requests (conversation_id,request_id,token)
    SELECT conversation_id,request_id,token FROM generation ON CONFLICT DO NOTHING
  ) SELECT token FROM generation`, [request.ownerId, request.conversationId, request.requestId, stop.workflowRunId ?? null,
    stop.activityId ?? null, stop.beforeAttempt ?? null, stop.token ?? null,
    request.text === undefined ? null : createHash("sha256").update(request.text).digest(), stop.attempt ?? null]);
  if (!claim) return;
  // Drain before the caller takes the conversation lock. A suspended SDK cannot block sibling publications.
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout='8s'");
    await db.query(`SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2 AND token=$3
      FOR NO KEY UPDATE`, [request.conversationId, request.requestId, claim.token]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function withNativeAdmission<T>(
  pool: Pool, launch: Launch, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  const controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal]);
  const { conversationId, requestId, token, execution } = launch;
  const ids = [conversationId, requestId, token];
  let polling = false;
  try {
    await db.query("BEGIN");
    const admitted = await db.query(`SELECT 1 FROM birbcrew_ts.turns t
      JOIN birbcrew_ts.conversations c USING (conversation_id)
      JOIN birbcrew_ts.native_launches n USING (conversation_id,request_id,token)
      WHERE t.conversation_id=$1 AND t.request_id=$2 AND t.token=$3 AND t.phase='started'
        AND c.owner_id=$4 AND t.workflow_run_id=$5 AND t.activity_id=$6 AND t.attempt=$7 AND t.prompt_digest=$8
        AND NOT n.stopped AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests s
          WHERE (s.conversation_id,s.request_id,s.token)=(n.conversation_id,n.request_id,n.token))
      FOR SHARE OF t`, [...ids, launch.ownerId, execution.workflowRunId, execution.activityId, execution.attempt, createHash("sha256").update(launch.text).digest()]);
    if (!admitted.rowCount) throw new Error("Native admission revoked");
    // A backend disconnect also releases its locks. Stop this SDK if that happens.
    const disconnected = () => controller.abort();
    db.once("error", disconnected);
    db.once("end", disconnected);
    const timer = setInterval(async () => {
      if (polling || bounded.aborted) return;
      polling = true;
      try {
        const stopped = await pool.query("SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3", ids);
        if (stopped.rowCount) controller.abort();
      } catch { controller.abort(); }
      finally { polling = false; }
    }, 100);
    try {
      bounded.throwIfAborted();
      return await run(bounded);
    } finally {
      clearInterval(timer);
      db.off("error", disconnected);
      db.off("end", disconnected);
    }
  } finally {
    try { await db.query("ROLLBACK"); }
    finally { db.release(); }
  }
}

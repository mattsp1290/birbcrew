import { progressActivity } from "./progress-activity.ts";
import { answerLive, cancelLive } from "./codex-calls.ts";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ChildStore } from "./children.ts";
import { startSupervisor } from "./supervisor.ts";
import { engineSchema } from "./domain.ts";
import type { MemberProfile } from "./profiles.ts";
import { memberActivities } from "./activities.ts";
import { memberTaskQueue, activityQueue } from "./queues.ts";
import { ownerAdmissionActivity, type MemberStore } from "./store.ts";
import { temporalConnectionOptions, type TemporalSettings } from "./temporal-config.ts";

async function touch(path: string) {
  const file = await open(path, "a");
  try { const now = new Date(); await file.utimes(now, now); } finally { await file.close(); }
}

export async function runMemberWorker(store: MemberStore, temporal: TemporalSettings, profiles: ReadonlyMap<string, MemberProfile>,
  configPath: string, stateDir: string, heartbeat?: string) {
  const connection = await NativeConnection.connect(await temporalConnectionOptions(temporal));
  const { namespace } = temporal;
  const workers: Worker[] = [];
  let supervisor;
  try {
    const children = new ChildStore(store.pool);
    workers.push(await Worker.create({
      connection, namespace, taskQueue: memberTaskQueue,
      activities: { rejectUnstartedAdmission:store.rejectUnstartedAdmission.bind(store), recordAcceptance:ownerAdmissionActivity(store), rejectAccepted:store.rejectAccepted.bind(store), conversationProgress:progressActivity(store), cancelGenerating:store.cancelGenerating.bind(store), decideLive:answerLive.bind(null,store.pool), cancelLive:cancelLive.bind(null,store.pool),
        reconcileTurn: store.reconcileTurn.bind(store), reconcileChild:children.reconcile.bind(children),
        closeExitedChild: children.closeExitedChild.bind(children), quarantineDelegation: children.quarantineDelegation.bind(children) },
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    }));
    supervisor = await startSupervisor(configPath, stateDir);
    for (const [profile, engines] of profiles) {
      for (const engine of engineSchema.options) {
        if (!engines[engine]) continue;
        const activities = memberActivities(store, supervisor, profiles, stateDir, engine);
        workers.push(await Worker.create({
          connection, namespace, activities, taskQueue: activityQueue(engine, profile),
          ...(engine === "codex" && { maxConcurrentActivityTaskExecutions: 2 }),
        }));
      }
    }
    if (workers.length === 1) throw new Error("No member engines configured");
    const running = workers.map((worker) => worker.run());
    let reported = false;
    const beat = () => {
      if (heartbeat === undefined || !workers.every((worker) => worker.getState() === "RUNNING")) return;
      void touch(heartbeat).catch(() => {
        if (!reported) console.error("Cannot update BIRBCREW_WORKER_HEARTBEAT_FILE");
        reported = true;
      });
    };
    beat();
    const beats = heartbeat === undefined ? undefined : setInterval(beat, 5000);
    try {
      await Promise.race([Promise.all(running), supervisor.exited.then(() => { throw new Error("SDK supervisor stopped"); })]);
    } finally {
      clearInterval(beats);
      for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
      await Promise.allSettled(running);
    }
  } finally {
    await supervisor?.close();
    await connection.close();
  }
}

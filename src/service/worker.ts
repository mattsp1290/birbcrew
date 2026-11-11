import { progressActivity } from "./progress-activity.ts";
import { answerLive, cancelLive } from "./codex-calls.ts";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ChildStore } from "./children.ts";
import { startSupervisor } from "./supervisor.ts";
import { engineSchema } from "./domain.ts";
import type { MemberProfile } from "./profiles.ts";
import { memberActivities } from "./activities.ts";
import { memberTaskQueue, activityQueue } from "./queues.ts";
import type { MemberStore } from "./store.ts";

export async function runMemberWorker(store: MemberStore, address: string, profiles: ReadonlyMap<string, MemberProfile>,
  configPath: string, stateDir: string) {
  const connection = await NativeConnection.connect({ address });
  const workers: Worker[] = [];
  let supervisor;
  try {
    const children = new ChildStore(store.pool);
    workers.push(await Worker.create({
      connection, taskQueue: memberTaskQueue,
      activities: { rejectUnstartedAdmission:store.rejectUnstartedAdmission.bind(store), recordAcceptance:store.recordAcceptance.bind(store), rejectAccepted:store.rejectAccepted.bind(store), conversationProgress:progressActivity(store), cancelGenerating:store.cancelGenerating.bind(store), decideLive:answerLive.bind(null,store.pool), cancelLive:cancelLive.bind(null,store.pool),
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
          connection, activities, taskQueue: activityQueue(engine, profile),
          ...(engine === "codex" && { maxConcurrentActivityTaskExecutions: 2 }),
        }));
      }
    }
    if (workers.length === 1) throw new Error("No member engines configured");
    const running = workers.map((worker) => worker.run());
    try {
      await Promise.race([Promise.all(running), supervisor.exited.then(() => { throw new Error("SDK supervisor stopped"); })]);
    } finally {
      for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
      await Promise.allSettled(running);
    }
  } finally {
    await supervisor?.close();
    await connection.close();
  }
}

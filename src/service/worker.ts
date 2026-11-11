import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { startSupervisor } from "./supervisor.ts";
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
    workers.push(await Worker.create({
      connection, taskQueue: memberTaskQueue,
      activities: { reconcileTurn: store.reconcileTurn.bind(store) },
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    }));
    supervisor = await startSupervisor(configPath, stateDir);
    const activities = memberActivities(store, supervisor, profiles, stateDir);
    for (const [profile, engines] of profiles) {
      for (const engine of ["claude", "pi"] as const) {
        if (!engines[engine]) continue;
        workers.push(await Worker.create({ connection, activities, taskQueue: activityQueue(engine, profile) }));
      }
    }
    if (workers.length === 1) throw new Error("No member engines configured");
    const running = workers.map((worker) => worker.run());
    try {
      await Promise.all(running);
    } finally {
      for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
      await Promise.allSettled(running);
    }
  } finally {
    await supervisor?.close();
    await connection.close();
  }
}

import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { memberActivities, type MemberProfiles } from "./activities.ts";
import { memberTaskQueue, activityQueue } from "./queues.ts";
import type { MemberStore } from "./store.ts";

export async function runMemberWorker(store: MemberStore, address: string, profiles: MemberProfiles) {
  const connection = await NativeConnection.connect({ address });
  const workers: Worker[] = [];
  try {
    workers.push(await Worker.create({
      connection, taskQueue: memberTaskQueue,
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    }));
    const activities = memberActivities(store, profiles);
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
    await connection.close();
  }
}

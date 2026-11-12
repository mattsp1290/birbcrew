import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "node:stream/consumers";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { MemberClient } from "./client.ts";
import { MemberStore } from "./store.ts";
import { spawnSchema } from "./domain.ts";
import { flushTelemetry } from "./telemetry.ts";

async function main() {
  const [operation, configPath] = process.argv.slice(2);
  if (!["spawn", "open", "turn", "pending", "decide", "cancel-pending", "worker"].includes(operation)) {
    throw new Error("Use spawn, open, turn, pending, decide, cancel-pending, or worker <trusted-profile-module>");
  }
  const url = process.env.BIRBCREW_DATABASE_URL;
  if (!url) throw new Error("Set BIRBCREW_DATABASE_URL to the private TypeScript application database");
  const address = process.env.BIRBCREW_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const pool = new Pool({ connectionString: url });
  const store = new MemberStore(pool);
  try {
    await store.migrate();
    if (operation === "worker") {
      const stateDir = process.env.BIRBCREW_STATE_DIR;
      if (!stateDir || !configPath) throw new Error("Supply BIRBCREW_STATE_DIR and the trusted provider module path");
      const { runMemberWorker } = await import("./worker.ts");
      const { registerProfiles } = await import("./deployment.ts");
      const { profiles, close } = await import(pathToFileURL(resolve(configPath)).href);
      try {
        await registerProfiles(pool, profiles, stateDir);
        await runMemberWorker(store, address, profiles, resolve(configPath), stateDir);
      } finally {
        try {
          await close?.();
        } finally {
          await flushTelemetry();
        }
      }
      return;
    }
    const input: unknown = await json(process.stdin);
    if (operation === "spawn") {
      const spawn = spawnSchema.parse(input);
      const registered = await pool.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2",
        [spawn.engine, spawn.profile]);
      if (!registered.rowCount) throw new Error("Start a worker with this engine and profile before spawning a member");
      console.log(JSON.stringify(await store.spawn(spawn)));
      return;
    }
    const connection = await Connection.connect({ address });
    try {
      const members = new MemberClient(store, new Client({ connection }));
      let result;
      switch (operation) {
        case "open": result = await members.open(input); break;
        case "pending": result = await members.pending(input); break;
        case "decide": result = { decision: await members.decide(input) }; break;
        case "cancel-pending":
          await members.cancelPending(input);
          result = { cancelled: true };
          break;
        default: result = { text: await members.submit(input) };
      }
      console.log(JSON.stringify(result));
    } finally {
      await connection.close();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Member command failed");
  process.exitCode = 1;
});

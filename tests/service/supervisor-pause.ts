import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Worker } from "@temporalio/worker";
import { MemberStore } from "../../src/service/store.ts";

const marker = process.env.BIRBCREW_PROOF_PAUSE;
if (marker) {
  let host: ChildProcess | undefined;
  childProcess.fork = new Proxy(childProcess.fork, {
    apply(target, receiver, args) {
      const child = Reflect.apply(target, receiver, args);
      if (String(args[0]).endsWith("/supervisor-host.ts")) host = child;
      return child;
    },
  });
  syncBuiltinESMExports();
  const create = Worker.create.bind(Worker);
  Worker.create = (options) => create({ ...options, maxConcurrentActivityTaskExecutions: 1, maxConcurrentActivityTaskPolls: 1 });
  const begin = MemberStore.prototype.beginTurn;
  MemberStore.prototype.beginTurn = async function (...args) {
    const turn = await begin.apply(this, args);
    if (turn.kind === "start") {
      const supervisor = host;
      if (!supervisor) throw new Error("Expected an independent supervisor");
      appendFileSync(marker, "reserved\n");
      process.kill(process.pid, "SIGSTOP");
      const id = randomUUID();
      const launch = { ...args[0], execution: args[1], token: turn.token };
      await new Promise<void>((resolve, reject) => {
        supervisor.once("message", (reply) => {
          if (reply && typeof reply === "object" && "id" in reply && reply.id === id && "ok" in reply && !reply.ok) resolve();
          else reject(new Error("Supervisor admitted a revoked generation"));
        });
        supervisor.send({ id, action: "start", launch });
      });
      appendFileSync(marker, "denied\n");
    }
    return turn;
  };
}
if (process.env.BIRBCREW_PROOF_DROP_RETRIES) {
  MemberStore.prototype.beginTurn = async () => {
    throw new Error("Injected activity loss before SQL claim");
  };
}

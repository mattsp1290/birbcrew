import { writeFileSync } from "node:fs";
import { ApprovalStore } from "../../src/service/approvals.ts";

// The native runner has exited and its checkpoint exists. Lose the worker before SQL receives its proposal.
if (process.argv[1]?.endsWith("/supervisor-host.ts")) {
  ApprovalStore.prototype.propose = async function () {
    writeFileSync(process.env.BIRBCREW_LOST_PROPOSAL!, "native deferral received");
    process.kill(process.ppid, "SIGKILL");
    throw new Error("Injected loss before proposal persistence");
  };
}

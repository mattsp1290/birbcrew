import assert from "node:assert/strict";
import { readFile, readlink } from "node:fs/promises";

/** Prove replay has a fresh Linux network namespace with no external interface. */
export async function assertOfflineNetwork(): Promise<void> {
  const parent = process.env.BIRBCREW_REPLAY_PARENT_NETNS;
  assert.match(parent ?? "", /^net:\[\d+\]$/, "Replay requires the parent's namespace identity");
  assert.notEqual(await readlink("/proc/self/ns/net"), parent, "Replay must enter a different network namespace");
  // libuv interface enumeration may be denied in an unprivileged user namespace.
  // procfs still exposes the namespace's actual interfaces; only loopback is allowed.
  const devices = (await readFile("/proc/net/dev", "utf8")).trim().split("\n").slice(2)
    .map(line => line.split(":")[0].trim());
  assert.ok(devices.every(name => name === "lo"), "Replay namespace has an external network interface");
  const routes = (await readFile("/proc/net/route", "utf8")).trim().split("\n").filter(Boolean);
  assert.ok(routes.length <= 1, "Replay namespace has an IPv4 route");
}

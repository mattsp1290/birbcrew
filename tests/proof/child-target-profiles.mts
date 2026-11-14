import { appendFileSync } from "node:fs";
import { contentText } from "@earendil-works/pi-ai";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";
import { close, profiles as fixtures } from "./fixture-profiles.mts";
import type { MemberProfile } from "../../src/service/profiles.ts";

// The profiles tests/service/child-target-workflow.test.ts runs: fixture.crew.v1, and
// fixture.crew-target.v1, a delegating Pi target that runs the same fixture model, so the model its
// parent pins on a child matches. The target logs its own prompts to BIRBCREW_PROOF_TARGET_REQUESTS,
// so a test can tell which profile's driver ran a child.
const crew = fixtures.get("fixture.crew.v1");
if (!crew) throw new Error("fixture.crew.v1 needs the Pi fixture: leave BIRBCREW_PROOF_ENGINE unset or set it to pi");
const pi = await createPiFixtureOptions((context) => {
  const log = process.env.BIRBCREW_PROOF_TARGET_REQUESTS;
  const last = context.messages.findLast((message) => message.role === "user");
  if (log && last?.role === "user") appendFileSync(log, JSON.stringify({ prompt: contentText(last.content) }) + "\n");
});
export const profiles = new Map<string, MemberProfile>([["fixture.crew.v1", crew], ["fixture.crew-target.v1", { ...crew, pi }]]);
export { close };

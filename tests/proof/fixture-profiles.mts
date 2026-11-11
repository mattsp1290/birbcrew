import { appendFileSync } from "node:fs";
import { contentText } from "@earendil-works/pi-ai";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";
import type { MemberProfile } from "../../src/service/profiles.ts";

function observed(engine: string, prompt?: string) {
  const path = process.env.BIRBCREW_PROOF_REQUESTS;
  if (path) appendFileSync(path, JSON.stringify({ engine, prompt }) + "\n");
}

const provider = await startClaudeFixtureProvider(undefined, ({ prompt }) => observed("claude", prompt));
export const profiles = new Map<string, MemberProfile>([["fixture.v1", {
  accountId: process.env.BIRBCREW_PROOF_ACCOUNT ?? "local-fixture",
  pi: process.env.BIRBCREW_PROOF_ENGINE === "claude" ? undefined : await createPiFixtureOptions((context) => {
    const last = context.messages.findLast((message) => message.role === "user");
    if (last?.role === "user") observed("pi", contentText(last.content));
  }),
  claude: process.env.BIRBCREW_PROOF_ENGINE === "pi" ? undefined : { model: "claude-sonnet-4-6", apiKey: "synthetic", baseUrl: provider.url },
}]]);
export const close = provider.close;

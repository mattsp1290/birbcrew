// Test-only operator module loaded by real workers/supervisors. No real account access.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";
import type { MemberProfile } from "../../src/service/profiles.ts";

const endpoints = z.strictObject({ claude: z.url(), codex: z.url(), pi: z.url() })
  .parse(JSON.parse(process.env.BIRBCREW_PROXY_FIXTURE_ENDPOINTS ?? "null"));
const engines = ["claude", "codex", "pi"] as const;
const models = { claude: "claude-sonnet-4-6", codex: "gpt-5.4", pi: "fixture-chat" } as const;
const protocols = { claude: "anthropic-messages", codex: "openai-responses", pi: "openai-chat-completions" } as const;
const configured: Awaited<ReturnType<typeof createProxyProfile>>[] = [];
const profile: MemberProfile = { accountId: "synthetic-restart-account" };
try {
  for (const engine of engines) {
    const entry = await createProxyProfile({ engine, protocol: protocols[engine], model: models[engine],
      endpoint: endpoints[engine], accountId: profile.accountId, allowHttpLoopback: true,
      headers: { "x-fixture-engine": engine }, resolveCredential: async () => {
        const expiresAt = Date.now() + 5000;
        return { headers: { authorization: `Bearer synthetic-${randomUUID()}-${expiresAt}` }, expiresAt };
      } });
    configured.push(entry);
    Object.assign(profile, { [engine]: entry.profile[engine] });
  }
} catch (error) {
  await Promise.all(configured.map(entry => entry.close()));
  throw error;
}
export const profiles = new Map([["proxy.fixture.v1", profile]]);
export const close = () => Promise.all(configured.map(entry => entry.close()));

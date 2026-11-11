import { appendFileSync } from "node:fs";
import { contentText, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { startProvider } from "../fixtures/engines/codex/provider.mts";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";
import type { MemberProfile } from "../../src/service/profiles.ts";

function observed(engine: string, prompt?: string) {
  const path = process.env.BIRBCREW_PROOF_REQUESTS;
  if (path) appendFileSync(path, JSON.stringify({ engine, prompt }) + "\n");
}

function noteEvidence(engine: string, system: string, messages: string, continuation: boolean) {
  const path = process.env.BIRBCREW_PROOF_NOTES;
  if (!path) return;
  const markers = (value: string) => [...new Set(value.match(/BIRBNOTE_[A-Z0-9_]+/g) ?? [])].sort();
  appendFileSync(path, JSON.stringify({ engine, system: markers(system), messages: markers(messages), continuation }) + "\n");
}

const engine = process.env.BIRBCREW_PROOF_ENGINE;
const codexProvider = !engine || engine === "codex" ? await startProvider() : undefined;
const provider = !engine || engine === "claude" ? await startClaudeFixtureProvider(undefined, ({ prompt }) => observed("claude", prompt),
  (system, messages, continuation) => noteEvidence("claude", system, messages, continuation)) : undefined;
export const profiles = new Map<string, MemberProfile>([["fixture.v1", {
  accountId: process.env.BIRBCREW_PROOF_ACCOUNT ?? "local-fixture",
  pi: !engine || engine === "pi" ? await createPiFixtureOptions((context) => {
    const messages = context.messages.filter((message) => message.role !== "system");
    noteEvidence("pi", getCurrentSystemPrompt(context.messages), JSON.stringify(messages), messages.at(-1)?.role === "toolResult");
    const last = context.messages.findLast((message) => message.role === "user");
    if (last?.role === "user") observed("pi", contentText(last.content));
  }) : undefined,
  claude: provider && { model: "claude-sonnet-4-6", apiKey: "synthetic", baseUrl: provider.url },
  codex: codexProvider && { model: "gpt-5.4", baseUrl: codexProvider.url },
}]]);
const chat = profiles.get("fixture.v1")!;
profiles.set("fixture.next-step.v1", { ...chat, humanTool: "choose_next_step" });
profiles.set("fixture.approval.v1", { ...chat, protectedTool: "record_work_item" });
if (chat.pi) profiles.set("fixture.crew.v1", { pi: chat.pi, accountId: chat.accountId, delegateTask: true, protectedTool: "record_work_item" });
if (process.env.BIRBCREW_PROOF_RECOVERY_PROFILE) {
  profiles.clear();
  profiles.set(process.env.BIRBCREW_PROOF_RECOVERY_PROFILE, {
    ...chat,
    ...(process.env.BIRBCREW_PROOF_PROTECTED && { protectedTool: "record_work_item" as const }),
    ...(process.env.BIRBCREW_PROOF_NEXT_STEP && { humanTool: "choose_next_step" as const }),
  });
}
export const close = () => Promise.all([provider?.close(), codexProvider?.close()]);

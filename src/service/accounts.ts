import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const goEndpoint = "https://opencode.ai/inference/go/openai/v1";
export const goModel = "glm-5.3-flash";
export const userAgent = "birbcrew-coding-proof/0.1.0";
const account = z.object({
  checked_at: z.iso.datetime({ offset: true }),
  evidence: z.string().trim().min(1),
  account_path: z.string().trim().min(1),
});
export const goApproval = account.extend({
  provider: z.literal("opencode-go"),
  eligible_coding_use: z.literal(true),
  extra_usage_disabled: z.literal(true),
});
export const claudeApproval = account.extend({
  provider: z.literal("anthropic-api"),
  approved_sdk_use: z.literal(true),
  model: z.string().regex(/^claude-[a-z0-9-]+$/).max(90),
});
export const codexApproval = account.extend({
  provider: z.literal("openai-api"), approved_sdk_use: z.literal(true),
  model: z.string().regex(/^gpt-[a-z0-9.-]+$/).max(90),
});

export async function readApproval<T extends { checked_at: string }>(path: string, schema: z.ZodType<T>) {
  if (!isAbsolute(path)) throw new Error("Use an absolute path to the private account attestation");
  const file = await realpath(path);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  if (!relative(repo, file).startsWith("../")) throw new Error("Keep account attestations outside the checkout");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) || metadata.size > 16_384 ||
        metadata.uid !== process.getuid?.()) throw new Error("Use a private owner-readable account attestation");
    parsed = schema.safeParse(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
  if (!parsed.success) throw new Error("Invalid account attestation");
  const age = Date.now() - Date.parse(parsed.data.checked_at);
  if (age < 0 || age > 12 * 60 * 60 * 1000) throw new Error("Account attestation must be from the past 12 hours");
  return parsed.data;
}

export function credential(value: string | undefined, variable: string) {
  if (!value?.trim()) throw new Error(`Set ${variable} for the approved account`);
  return value;
}

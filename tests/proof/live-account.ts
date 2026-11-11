import { mkdir, lstat, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { claudeApproval, codexApproval, codexSubscriptionApproval, codexSubscriptionEndpoint, codexSubscriptionHome, credential, goApproval, goEndpoint, goModel, readApproval } from "../../src/service/accounts.ts";
import { readCodexSubscription } from "../../src/service/codex-subscription.ts";
import { engineSchema, type Engine } from "../../src/service/domain.ts";

const approved = {
  approval_id: z.uuid(),
  approved_live_proof: z.literal(true),
  max_requests: z.number().int().min(1).max(24),
};
const go = goApproval.extend({ ...approved, endpoint: z.literal(goEndpoint), model: z.literal(goModel) }).strict();
const claude = claudeApproval.extend({ ...approved, endpoint: z.literal("https://api.anthropic.com") }).strict();
const codex = z.discriminatedUnion("provider", [
  codexApproval.extend({ ...approved, endpoint: z.literal("https://api.openai.com/v1") }).strict(),
  codexSubscriptionApproval.extend({ ...approved, endpoint: z.literal(codexSubscriptionEndpoint) }).strict(),
]);
const accounts = { pi: go, claude, codex };
export const accountKey = { pi: "OPENCODE_GO_API_KEY", claude: "BIRBCREW_CLAUDE_API_KEY", codex: "BIRBCREW_CODEX_API_KEY" } as const;
export const attestationEnv = { pi: "BIRBCREW_PI_ATTESTATION", claude: "BIRBCREW_CLAUDE_ATTESTATION", codex: "BIRBCREW_CODEX_ATTESTATION" } as const;

export async function authorizeLive(args: string[], env: NodeJS.ProcessEnv,
  claims = join(userInfo().homedir, ".local", "state", "birbcrew", "live-proof-claims"), subscriptionCredential = readCodexSubscription) {
  const { values } = parseArgs({ args, options: { engine: { type: "string", multiple: true }, attestation: { type: "string", multiple: true } } });
  const engine = engineSchema.parse(z.array(z.string()).length(1).parse(values.engine)[0]);
  const path = z.array(z.string()).length(1).parse(values.attestation)[0];
  const schema: z.ZodType<z.infer<(typeof accounts)[Engine]>> = accounts[engine];
  const approval = await readApproval(path, schema);
  const subscription = approval.provider === "chatgpt-subscription" ? approval : undefined;
  const prefix = { "chatgpt-subscription": "chatgpt-", "openai-api": "openai-", "anthropic-api": "anthropic-", "opencode-go": "pi-go-" };
  function signingHeaders() {
    if (subscription) {
      const expected = subscription.account_id;
      return async () => {
        const { accessToken, accountId } = await subscriptionCredential(codexSubscriptionHome(env), expected);
        if (!accessToken || accountId !== expected) throw new Error("Codex subscription account changed");
        return new Headers({ Authorization: "Bearer " + accessToken, "ChatGPT-Account-Id": accountId });
      };
    }
    const key = credential(env[accountKey[engine]], accountKey[engine]);
    return async () => new Headers(engine === "claude" ? { "x-api-key": key } : { Authorization: "Bearer " + key });
  }
  const providerHeaders = signingHeaders();
  if (subscription) await providerHeaders();
  return {
    engine, path, providerHeaders, origin: approval.endpoint, model: approval.model, budget: approval.max_requests,
    profile: prefix[approval.provider] + approval.model + ".approval.v1", auth: approval.provider,
    async claim() {
      await mkdir(claims, { recursive: true, mode: 0o700 });
      const dir = await lstat(claims);
      if (await realpath(claims) !== claims || !dir.isDirectory() || dir.uid !== process.getuid!() || (dir.mode & 0o077)) {
        throw new Error("A private owner-controlled live claim directory is required");
      }
      // An exclusive, permanent claim spends this approval, including after a verifier crash.
      const reservation = await open(join(claims, approval.approval_id), "wx", 0o600);
      await reservation.close();
    },
    async recheck() {
      const current = await readApproval(path, schema);
      if (current.provider !== approval.provider ||
          (current.provider === "chatgpt-subscription" && current.account_id !== subscription?.account_id) ||
          current.approval_id !== approval.approval_id || current.account_path !== approval.account_path || current.model !== approval.model ||
          current.max_requests !== approval.max_requests) throw new Error("Live authorization changed");
    },
  };
}

export type LiveAccount = Awaited<ReturnType<typeof authorizeLive>>;

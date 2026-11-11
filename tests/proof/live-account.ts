import { parseArgs } from "node:util";
import { z } from "zod";
import { claudeApproval, codexApproval, credential, goApproval, goEndpoint, goModel, readApproval } from "../../src/service/accounts.ts";
import { engineSchema, type Engine } from "../../src/service/domain.ts";

const approved = {
  approved_live_proof: z.literal(true),
  max_requests: z.number().int().min(1).max(24),
};
const go = goApproval.extend({ ...approved, endpoint: z.literal(goEndpoint), model: z.literal(goModel) }).strict();
const claude = claudeApproval.extend({ ...approved, endpoint: z.literal("https://api.anthropic.com") }).strict();
const codex = codexApproval.extend({ ...approved, endpoint: z.literal("https://api.openai.com/v1") }).strict();
const accounts = { pi: go, claude, codex };
export const accountKey = { pi: "OPENCODE_GO_API_KEY", claude: "BIRBCREW_CLAUDE_API_KEY", codex: "BIRBCREW_CODEX_API_KEY" } as const;
export const attestationEnv = { pi: "BIRBCREW_PI_ATTESTATION", claude: "BIRBCREW_CLAUDE_ATTESTATION", codex: "BIRBCREW_CODEX_ATTESTATION" } as const;

export async function authorizeLive(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({ args, options: { engine: { type: "string", multiple: true }, attestation: { type: "string", multiple: true } } });
  const engine = engineSchema.parse(z.array(z.string()).length(1).parse(values.engine)[0]);
  const path = z.array(z.string()).length(1).parse(values.attestation)[0];
  const schema: z.ZodType<z.infer<(typeof accounts)[Engine]>> = accounts[engine];
  const approval = await readApproval(path, schema);
  const key = credential(env[accountKey[engine]], accountKey[engine]);
  const profile = engine === "pi" ? "pi-go-" : engine === "codex" ? "openai-" : "anthropic-";
  return {
    engine, path, key, origin: approval.endpoint, model: approval.model, budget: approval.max_requests,
    profile: profile + approval.model + ".approval.v1", auth: approval.provider,
    async recheck() {
      const current = await readApproval(path, schema);
      if (current.account_path !== approval.account_path || current.model !== approval.model ||
          current.max_requests !== approval.max_requests) throw new Error("Live authorization changed");
    },
  };
}

export type LiveAccount = Awaited<ReturnType<typeof authorizeLive>>;

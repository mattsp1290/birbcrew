import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider, InMemoryCredentialStore, InMemoryModelsStore, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { MemberProfile } from "./profiles.ts";

const goEndpoint = "https://opencode.ai/inference/go/openai/v1";
const goModel = "glm-5.3-flash";
const userAgent = "birbcrew-coding-proof/0.1.0";
const account = z.object({
  checked_at: z.iso.datetime({ offset: true }),
  evidence: z.string().trim().min(1),
  account_path: z.string().trim().min(1),
});
const goApproval = account.extend({
  provider: z.literal("opencode-go"),
  eligible_coding_use: z.literal(true),
  extra_usage_disabled: z.literal(true),
});
const claudeApproval = account.extend({
  provider: z.literal("anthropic-api"),
  approved_sdk_use: z.literal(true),
  model: z.string().regex(/^claude-[a-z0-9-]+$/).max(90),
});
const modelsResponse = z.object({ data: z.array(z.object({ id: z.string() })) });

async function readApproval<T extends { checked_at: string }>(path: string, schema: z.ZodType<T>) {
  if (!isAbsolute(path)) throw new Error("Use an absolute path to the private account attestation");
  const file = await realpath(path);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  if (!relative(repo, file).startsWith("../")) throw new Error("Keep account attestations outside the checkout");
  const parsed = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error("Invalid account attestation");
  const age = Date.now() - Date.parse(parsed.data.checked_at);
  if (age < 0 || age > 12 * 60 * 60 * 1000) throw new Error("Account attestation must be from the past 12 hours");
  return parsed.data;
}

function credential(value: string | undefined, variable: string) {
  if (!value?.trim()) throw new Error(`Set ${variable} for the approved account`);
  return value;
}

async function configureGo(key: string, path: string, accountPath: string, transport: typeof fetch) {
  const model = OPENCODE_GO_MODELS[goModel];
  if (model.provider !== "opencode-go" || model.api !== "openai-completions" ||
      model.id !== goModel || model.baseUrl !== goEndpoint) throw new Error("Pi's Go model route changed");

  const guardedFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url !== goEndpoint + "/chat/completions" || req.method !== "POST") {
      throw new Error("Unexpected OpenCode Go request destination");
    }
    if (req.headers.get("authorization") !== "Bearer " + key ||
        req.headers.get("user-agent") !== userAgent || req.headers.has("x-opencode-client") ||
        !req.headers.get("x-opencode-session")) throw new Error("Missing BirbCrew request identity");
    const body = await req.text();
    if (JSON.parse(body).model !== goModel) throw new Error("Unexpected OpenCode Go model");
    const headers = new Headers();
    for (const name of ["authorization", "content-type", "accept", "user-agent", "x-opencode-session"]) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return transport(req.url, { method: "POST", headers, body, signal: req.signal, redirect: "error" });
  };
  const api = withOpenCodeSessionHeader(openAICompletionsApi());
  const options = (opts?: StreamOptions) => ({
    ...opts, apiKey: key, fetch: guardedFetch, maxRetries: 0, maxTokens: 1200,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(createProvider({
    id: model.provider, models: [model], auth: { apiKey: {
      name: "Approved Go credential", resolve: async () => ({ auth: { apiKey: key } }),
    } },
    api: {
      stream: (m, ctx, opts) => api.stream(m, ctx, options(opts)),
      streamSimple: (m, ctx, opts) => api.streamSimple(m, ctx, options(opts)),
    },
  }));

  async function prepare() {
    if ((await readApproval(path, goApproval)).account_path !== accountPath) throw new Error("Go attestation changed account");
    const response = await transport(goEndpoint + "/models", {
      headers: { Authorization: "Bearer " + key, "User-Agent": userAgent },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200 || !modelsResponse.parse(await response.json()).data.some(({ id }) => id === goModel)) {
      throw new Error("Go preflight did not confirm the approved model");
    }
    let confirmed = false;
    let mismatch = false;
    const extension: ExtensionFactory = (pi) => {
      pi.on("before_provider_headers", (event) => {
        event.headers["User-Agent"] = userAgent;
        event.headers["x-opencode-client"] = null;
      });
      pi.on("provider_stream_event", (event) => {
        const frame = z.object({ model: z.string() }).safeParse(event.data);
        if (!frame.success) return;
        if (frame.data.model === goModel) confirmed = true;
        else mismatch = true;
      });
    };
    return { extension, verify() {
      if (mismatch || !confirmed) throw new Error("Go stream did not confirm the approved response model");
    } };
  }
  return { model, modelRuntime, prepare };
}

export async function loadLiveProfiles(env: NodeJS.ProcessEnv, transport: typeof fetch = fetch) {
  const configured = new Map<string, MemberProfile>();
  const piPath = env.BIRBCREW_PI_ATTESTATION;
  if (piPath) {
    const approval = await readApproval(piPath, goApproval);
    configured.set("pi-go-glm-5.3-flash.v1", {
      accountId: approval.account_path,
      pi: await configureGo(credential(env.OPENCODE_GO_API_KEY, "OPENCODE_GO_API_KEY"), piPath, approval.account_path, transport),
    });
  }
  const claudePath = env.BIRBCREW_CLAUDE_ATTESTATION;
  if (claudePath) {
    const { model, account_path } = await readApproval(claudePath, claudeApproval);
    const authorize = async () => {
      const current = await readApproval(claudePath, claudeApproval);
      if (current.account_path !== account_path) throw new Error("Claude attestation changed account");
      if (current.model !== model) {
        throw new Error("Claude attestation changed model");
      }
    };
    const claude = { model, authorize, baseUrl: "https://api.anthropic.com",
      apiKey: credential(env.BIRBCREW_CLAUDE_API_KEY, "BIRBCREW_CLAUDE_API_KEY") };
    configured.set(`anthropic-${model}.v1`, { accountId: account_path, claude });
  }
  for (const [name, profile] of [...configured]) {
    if (profile.pi) configured.set(name.replace(/\.v1$/, ".crew.v1"), { ...profile, delegateTask: true, protectedTool: "record_work_item" });

    configured.set(name.replace(/\.v1$/, ".next-step.v1"), { ...profile, humanTool: "choose_next_step" });
    configured.set(name.replace(/\.v1$/, ".approval.v1"), { ...profile, protectedTool: "record_work_item" });
  }
  return configured;
}

export const profiles = await loadLiveProfiles(process.env);

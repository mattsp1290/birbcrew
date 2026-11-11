import { claudeApproval, codexApproval, credential, goApproval, goEndpoint, goModel, readApproval, userAgent } from "./accounts.ts";
import { createProvider, InMemoryCredentialStore, InMemoryModelsStore, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { MemberProfile } from "./profiles.ts";

const modelsResponse = z.object({ data: z.array(z.object({ id: z.string() })) });

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
  const codexPath = env.BIRBCREW_CODEX_ATTESTATION;
  if (codexPath) {
    const { model, account_path } = await readApproval(codexPath, codexApproval);
    const authorize = async () => {
      const current = await readApproval(codexPath, codexApproval);
      if (current.account_path !== account_path || current.model !== model) throw new Error("Codex account or model changed");
    };
    configured.set(`openai-${model}.v1`, { accountId: account_path,
      codex: { model, authorize, apiKey: credential(env.BIRBCREW_CODEX_API_KEY, "BIRBCREW_CODEX_API_KEY") } });
  }
  for (const [name, profile] of [...configured]) {
    if (profile.pi) configured.set(name.replace(/\.v1$/, ".crew.v1"), { ...profile, delegateTask: true, protectedTool: "record_work_item" });

    configured.set(name.replace(/\.v1$/, ".next-step.v1"), { ...profile, humanTool: "choose_next_step" });
    configured.set(name.replace(/\.v1$/, ".approval.v1"), { ...profile, protectedTool: "record_work_item" });
  }
  return configured;
}

export const profiles = await loadLiveProfiles(process.env);

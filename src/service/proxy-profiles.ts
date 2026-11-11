import { createProvider, InMemoryCredentialStore, InMemoryModelsStore, type Model, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { MemberProfile } from "./profiles.ts";
import { startProxyRelay } from "./proxy-relay.ts";

type RelayOptions = Parameters<typeof startProxyRelay>[0];
export type ProxyProfileOptions = RelayOptions & {
  engine: "claude" | "codex" | "pi";
  accountId: string;
  protectedTool?: "record_work_item";
  humanTool?: "choose_next_step";
};

/** Trusted operator configuration only. Never construct this from an AG-UI request. */
export async function createProxyProfile(options: ProxyProfileOptions) {
  const protocols = { claude: "anthropic-messages", codex: "openai-responses", pi: "openai-chat-completions" } as const;
  if (options.protocol !== protocols[options.engine] || !options.accountId?.trim() ||
      !options.model?.trim() || (options.protectedTool && options.humanTool)) {
    throw new Error("Invalid proxy engine, protocol, model, account or tool configuration");
  }
  const relay = await startProxyRelay(options);
  try {
    const profile: MemberProfile = {
      accountId: options.accountId,
      ...(options.protectedTool && { protectedTool: options.protectedTool }),
      ...(options.humanTool && { humanTool: options.humanTool }),
    };
    if (options.engine === "claude") {
      profile.claude = { model: options.model, baseUrl: relay.baseUrl, apiKey: relay.apiKey };
    } else if (options.engine === "codex") {
      // The scoped relay, not a user login or global auth file, owns upstream authorization.
      profile.codex = { model: options.model, baseUrl: relay.baseUrl, apiKey: relay.apiKey, authorize: async () => {} };
    } else {
      const model: Model<"openai-completions"> = {
        id: options.model, name: options.model, provider: "birbcrew-proxy", api: "openai-completions",
        baseUrl: relay.baseUrl, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false },
      };
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
        modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      });
      const api = openAICompletionsApi();
      const guardedFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== relay.baseUrl + "/chat/completions" || request.method !== "POST") {
          throw new Error("Unexpected proxy request destination");
        }
        return fetch(request, { redirect: "error" });
      };
      const streamOptions = (opts?: StreamOptions) => ({ ...opts, apiKey: relay.apiKey, fetch: guardedFetch, maxRetries: 0, maxTokens: 4096 });
      runtime.registerNativeProvider(createProvider({
        id: model.provider, models: [model],
        auth: { apiKey: { name: "Local proxy relay", resolve: async () => ({ auth: { apiKey: relay.apiKey } }) } },
        api: { stream: (m, ctx, opts) => api.stream(m, ctx, streamOptions(opts)),
          streamSimple: (m, ctx, opts) => api.streamSimple(m, ctx, streamOptions(opts)) },
      }));
      profile.pi = { model, modelRuntime: runtime };
    }
    return { profile, close: relay.close };
  } catch {
    await relay.close();
    throw new Error("Proxy profile initialization failed");
  }
}

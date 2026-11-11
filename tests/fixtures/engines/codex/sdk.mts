import { Codex } from "@openai/codex-sdk";

export function fixtureThread(home: string, workspace: string, url: string, threadId?: string, endpoint?: string) {
  const sdk = new Codex({
    env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH ?? "" },
    config: {
      model_provider:"fixture",
      model_providers:{ fixture:{ name:"BirbCrew fixture", base_url:url, wire_api:"responses", requires_openai_auth:false,
        supports_websockets:false, request_max_retries:0, stream_max_retries:0 } },
      features:{ plugins:false }, analytics:{enabled:false}, feedback:{enabled:false},
      ...(endpoint && { mcp_servers:{ fixture:{ url:endpoint, enabled_tools:["record_work_item"], required:true,
        startup_timeout_sec:8, tool_timeout_sec:25, default_tools_approval_mode:"approve" } } }),
    }
  });
  const options = {workingDirectory:workspace, skipGitRepoCheck:true, sandboxMode:"read-only",
    approvalPolicy:"never", webSearchMode:"disabled"} as const;
  return threadId ? sdk.resumeThread(threadId, options) : sdk.startThread(options);
}

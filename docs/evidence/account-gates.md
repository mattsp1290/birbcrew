# Account gates

Observed November 6, 2026 before any review model invocation.

Claude CLI 2.1.309 help advertises safe mode, tool allowlists, and subscription
auth. With ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, and ANTHROPIC_BASE_URL removed,
`claude auth status` returned loggedIn true, authMethod claude.ai, apiProvider
firstParty, and subscriptionType max. Personal identifiers are omitted here.
The owner confirmed both Claude Max and OpenCode Go ready in response to the
question about disabled Extra Usage. The owner separately stated that Extra
Usage is disabled in Claude. No persistent settings were changed by the agent.

The first fresh review used safe mode, Read/Glob/Grep only, plan permissions,
strict MCP configuration, and no session persistence. No fallback model was
configured. The returned modelUsage key was `claude-opus-5-5`.

The owner identified `OPENCODE_GO_API_KEY` in `~/.profile` as the Go credential.
The live checker reads only that literal assignment. It does not source the
profile or export unrelated credentials. Account-setting evidence is an owner
attestation. No independent billing API or current balance check is claimed.
The live journey remains separate from these pre-call gates.

The inspected [Go documentation](https://opencode.ai/v2/docs/console/go/) allows
coding-agent traffic with the client's own User-Agent and a stable session
header. This proof submits a synthetic coding task. The selected compatible
endpoint is `https://opencode.ai/inference/go/openai/v1` and the selected model
is `glm-5.3-flash`. A live response is still needed to verify account eligibility.

The November 6 preflight returned HTTP 401 with error code `api_key_expired`.
The provider explicitly says a new Console API key is needed and that signing
in again does not renew this key. No model request was made. The owner was asked
to replace the local key and confirm Go Extra Usage is disabled.

The existing Pi alternative does not repair this failure. The current
[OpenCode harness guide](https://opencode.ai/v2/docs/console/harnesses) lists Pi
using the same Console account and Go endpoint. Changing runtime would retain
the expired credential problem. Keep the approved runtime while the owner
replaces the key. No paid API fallback is authorized.

## Continuation on November 6

The owner explicitly confirmed that their Go subscription has Extra Usage disabled.
The continuation recorded a fresh private attestation outside Git with mode 0600.
It rechecked the official Go documentation before the live call and used the
existing coding-agent identity, stable session header, endpoint, and selected model.
The documented live verifier passed with the current key and returned
`glm-5.3-flash`. See [live acceptance](live-acceptance.json).
The older expired-key failure remains historical evidence.
No account setting was changed. No billing API or balance check was performed.

For fresh Claude review, process-local removal of the three Anthropic overrides
again selected loggedIn true, authMethod claude.ai, apiProvider firstParty,
and subscriptionType max. Personal identifiers are omitted from repository evidence.
The review uses safe mode, Read/Glob/Grep only, plan permissions, strict MCP
configuration, no session persistence, and no fallback model.

The owner's exact continuation statement was "Go subscription has extra usage disabled. I just did so earlier".
It arrived before the private attestation was recorded at 2026-11-06T12:37:39.293532Z.
No separate message timestamp was supplied to the agent. The account row was
logged afterward and is a retrospective record, not a later authorization.
The owner supplied the subscription and disabled-usage facts. Eligibility of
this synthetic coding-agent request is inferred from the current published Go
requirements, the request content, and the configured client headers.
It is not a separate claim that the owner obtained provider approval.

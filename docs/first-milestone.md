# First milestone for Birbcrew

## Current status, November 8, 2026

The bounded runtime proof is implemented at
`88b219c18adeb352d2f291f099ede990a3190a58`. The
[deterministic acceptance report](evidence/final-acceptance.json) verifies eleven
journeys. The separate [live report](evidence/live-acceptance.json) verifies the
subscription journey and nine overlapping journeys. Together they cover all
twelve required scenarios. The [source manifest](evidence/continuation-source-manifest.json)
binds those records to the delivered source. The
[final independent Claude review](evidence/continuation-final-review.json)
records no material findings and states its source-only review limits.
[Verification instructions](verification.md) describe the implemented commands.

On November 8, the owner authorized the coordinator to merge birb* PRs that it
has reviewed and approved, including fixing findings. That authorization
supersedes the earlier instruction to wait for a separate human review before
merging this bounded proof. It does not claim that an independent human source
review happened. Production identity, persistent deployment and live factory
actions remain separate work. No production deployment is implied by acceptance
or merge.

The original November 5 implementation brief follows as historical scope.
Its statements that implementation, commands and acceptance are still pending
describe the starting point, not the current result.

## Original implementation brief

Status: ready for the owner to launch the bounded implementation milestone. Prepared November 5, 2026.
The owner selected Birbcrew as the first repository and approved Pydantic AI
with Temporal as the first integration to validate. The current session prepares
the handoff. Execution starts when the owner launches the repository agent with
this milestone. This file does not claim that any product code already exists.

## Outcome

One persistent coworker conversation survives client disconnection and worker
restart. Two AG-UI clients observe the same conversation. A test tool records
one durable effect even when its reply is interrupted. A human-input request
can be answered after reconnect without repeating the completed tool effect.

This is a working runtime proof that later repositories can consume. Keep the
result small enough to review as one milestone. Use Python, Pydantic AI's
existing AG-UI adapter, and its Temporal integration. Do not build a general
agent framework or implement both Python and pi paths.

## Scope

Implement an authenticated conversation API, durable execution, persistent
finalized messages, reconnect state, explicit cancellation, and a repeatable
verification journey. For this isolated proof, use a local Temporal development
service and local PostgreSQL. Bind listeners to loopback by default. Test
credentials are generated locally and excluded from Git. This local proof is
not a production deployment or the Birbparty staging acceptance gate.

Use two small AG-UI test clients. They establish protocol behavior, not phone
UI acceptance. Birbforge owns the eventual Expo phone and browser interface.
Use existing SDK clients and encoders rather than inventing a second event
protocol. A2UI and CopilotKit Intelligence are not dependencies.

Instrument the journey with existing OpenTelemetry support and correlated logs.
Prove telemetry emission with a local collector or test exporter. Birbhomes
later connects the deployed services to Datadog. Do not report local telemetry
capture as a verified Datadog installation.

## State and authority

Choose concrete types before implementation. The domain contains these records.

- A coworker has a stable identity and a versioned definition of instructions,
  eligible models and available tools.
- A conversation belongs to a coworker and an authenticated installation owner.
- An accepted input has a stable client request ID and payload identity.
- A run attempt identifies the workflow execution and its observable outcome.
- A human-input request has an ID, version, expected responder and resolution.
- A tool operation has a stable operation ID and a durable outcome.
- A finalized message preserves the chosen framework's message representation.

Temporal owns durable execution and waits. The conversation store owns finalized
messages needed beyond an individual workflow history. Application records do
not become another scheduler. Prefer the framework's supported persistence
facilities where suitable. Keep application migrations separate from Temporal's
database schema. Never query Temporal's internal database as an application API.

Ensure one active writer per conversation through the selected workflow design.
Document how workflow replacement or Continue-As-New preserves identity and
ordering. Do not assume an in-memory lock provides ownership across processes.

Requests can be resent. The same client request ID and payload refer to the
same accepted input. A different payload with that ID is a conflict. Reconnect
does not submit another prompt. Disconnect does not cancel a run. Cancellation
requires an explicit authorized request and an observable acknowledgement.

Retain authoritative message state separately from temporary streamed text.
Reconnect must return a coherent snapshot plus subsequent events, or a proven
replay mechanism. Handle overlap without duplicate finalized messages. A client
must know when an old cursor cannot be replayed and a fresh snapshot is required.
Do not promise indefinite token-by-token history unless the selected mechanism
actually supports it.

## Shared repository knowledge

Use Beans for shared repository notes. Keep separate conversations per goal
under a stable coworker identity. Add one bounded read from a disposable Beans
fixture hub, with explicit project and actor selection. Record the note keys
and paths, updated timestamps, content digests and the clean fixture hub commit
supplied to the conversation. The commit identifies a captured fixture snapshot,
not a revision field that Beans already returns with each note. Read from a
quiescent clean fixture and verify its commit and content stay stable during
capture. The note context must survive
reconnect without copying unrelated project knowledge into the conversation.

Use the installed `bn` CLI's documented machine-readable interface.
Create the fixture under a temporary directory with isolated configuration.
Confirm the hub-selection flag from installed help and pass it explicitly to
every invocation. Before seeding, assert that the resolved hub is inside that
directory and has no remote or only a local bare remote. Fail closed otherwise. Never read
the owner's entire private hub as test data. Beans mutations commit and push
their hub. Do not issue real-hub writes as a side effect of this proof.
The first milestone reads shared notes. Automated note writes require a later
proof of retry reconciliation and stale-write protection in Beans.

## Test tool and human input

Use one benign tool that records a synthetic work item in a local fixture store.
The tool accepts an operation ID and returns the existing result on duplicate
delivery. It never creates real issues, PRs, messages or deployments.

Inject interruption after the fixture effect is committed but before its result
reaches the workflow. Recovery must reconcile that operation rather than repeat
the effect. A read-only tool alone cannot prove this behavior.

Use a human-input pause to choose a synthetic next step. The request survives
restart. An unauthorized client, an obsolete request version, or a second
conflicting response cannot resolve it. This is not a real PR approval. Birbforge
will own revision-bound approvals and merge authorization.

## Provider boundary

Start deterministic recovery tests with the framework's test-model facilities.
Then run a separate live model journey using one eligible existing subscription.
Keep the live acceptance check explicit. Mock success cannot establish account
compatibility or production model behavior.

Select one eligible approved subscription for the live journey. OpenCode Go is
the current candidate, subject to whether the actual journey fits its supported
use. The provider documentation inspected November 5, 2026 reports compatible
APIs, client identification and a stable session header. It also describes an
Extra Usage setting that can permit pay-as-you-go fallback. Recheck those
requirements, the actual account configuration and the selected endpoint before
a live call. Do not enable overage or infer that an API-shaped endpoint is
necessarily metered outside the subscription.
[OpenCode Go documentation](https://opencode.ai/v2/docs/console/go/)

Use Pydantic AI's supported compatible-provider implementation where appropriate.
Validate tool calling and streaming for the selected model. Do not forge another
client's identity or create a token broker. If no approved subscription path
works, record that failed gate and evaluate the existing pi alternative before
proposing a runtime change. Do not silently switch to paid API access.
[Compatible providers](https://pydantic.dev/docs/ai/models/compatible-apis/)

Codex and Claude coding execution remain external factory integrations. This
milestone does not have to implement their cloud dispatch or turn their CLIs
into general model endpoints.

## Work sequence

1. Inspect current repository instructions and state. Verify supported Python,
   Pydantic AI, AG-UI and Temporal versions. Pin compatible dependencies.
2. Establish project checks and one runnable deterministic conversation journey.
3. Add the benign effect and human-input wait using supported framework APIs.
4. Add persistence and client reconnection. Prove them against a real local
   Temporal service and PostgreSQL, not only mocked workflow histories.
5. Inject process failures and verify idempotent recovery and cancellation.
6. Run the separate approved-subscription journey and preserve redacted evidence.
7. Perform independent review and verify the documented clean-start procedure.
   Deliver the milestone as a reviewable change with explicit remaining gaps.

The implementation agent may decompose these into smaller PRs if each ends in
a runnable check. Do not introduce unrelated features to fill a phase.

## Acceptance evidence

| Scenario | Required observation |
| --- | --- |
| Normal interaction | An authenticated client receives text, tool progress and finalized messages through AG-UI |
| Duplicate submission | Repeating an accepted request produces one logical input and one resulting operation |
| Reconnect | Client B recovers the same conversation without starting another run or duplicating finalized messages |
| Gateway restart | Finalized history persists and a reconnect finds the authoritative current state |
| Worker interruption | The synthetic operation appears once after interruption between effect commit and acknowledgement |
| Human wait | Client B resolves the same pending request by ID and version after restart through an authorized action independent of the original stream |
| Conflicting response | An obsolete or conflicting resolution cannot mutate the accepted decision |
| Explicit cancellation | Work stops or reports unresolved termination accurately. A disconnected client does not trigger it |
| Isolation | Another test principal cannot read, resume or cancel the owner's conversation |
| Shared context | A conversation uses only the selected Beans project notes and retains their keys, paths, timestamps, content digests and captured clean fixture commit across reconnect |
| Telemetry | Related run, tool and recovery observations carry the expected correlation IDs without secrets |
| Real subscription | A real model completes the journey through the approved account path, with billing-mode evidence and any usage-visibility limitations stated |

Deliver one documented verification entry point that reproduces the deterministic
scenarios and a separate opt-in live-account check. These commands do not exist
yet. The implementation must supply their actual names and prerequisites.
Record process termination points, workflow identifiers, fixture outcomes and
redacted event captures. Label each gate VERIFIED, NOT VERIFIED or INCONCLUSIVE.

## Completion and human decisions

The live-account check is opt-in for ordinary test runs, but required for this
milestone's acceptance. The milestone is complete only when every required gate
is VERIFIED, independent review is resolved, and the clean-start instructions
have been exercised. A failed or unavailable account check is a reported
blocker with evidence. It is not a successful milestone or permission to use
an unapproved paid provider.

The authenticated API uses generated local test credentials. It does not select
the installation's production login system. Authentication and permissions
changes still require human review before merge under the agreed factory policy.
Implementing a local proof does not waive that gate.

Escalate changes to account settings or paid usage, a proposed runtime switch,
material scope expansion, or any action outside this milestone's authorization.
Report the observed failure and the smallest proposed remedy. Choose routine
test libraries and local test-authentication details without asking the owner
to design them. Missing credentials may require the owner's supported login
flow. Never ask them to paste secrets into a public document.

## Boundaries for the owning agent

Use the installed poteto-mode skill and the host's supported execution tools.
Read its routed skills when triggered. State any tool or model adaptation.
Do not claim Cursor-specific tools are available in Codex.

Own Birbcrew changes. Propose cross-repository contract changes to the coordinator
instead of editing another owner's repository without coordination. Protocol
fixtures and agent-side conversation contracts belong here. Birbforge owns
factory actions and approvals. Birbverify owns verification requests and results.

No production access, real repository merge, cloud author dispatch, Slack send,
cluster deployment, or secret migration belongs to this milestone. Do not add
the full Birbforge app, a new scheduler, a custom model transport, or a permanent
message broker solely to finish this proof.

## Remaining readiness work

The owner agreed the design, Beans authored-work ownership and Codex with Claude
CLI review. The canonical launch gate is in Birbforge's
`docs/start-repository-owner.md`. HTML inspection and independent readiness
review are complete. Product acceptance checks in this milestone remain unverified.

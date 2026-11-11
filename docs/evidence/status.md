# Milestone evidence status

## TypeScript members

Claude, Codex and Pi have passed controlled-provider chat, protected approval, denial, ordinary human input, and authenticated observer checks with their native SDKs. The Codex interruption checks cover zero effect, a committed receipt with unknown native delivery, and a confirmed delivery. The live subscription runs and permissions sign-off for the TypeScript implementation are pending.

## Historical Python milestone

All twelve required runtime journeys are verified across the final clean
deterministic and live reports. The final live run returned glm-5.3-flash through
the selected Go endpoint after native identity checks, replay, and telemetry.
Fresh independent Claude review found no remaining material findings.
First-milestone runtime acceptance is complete. Human authentication and
permissions review remains required before merge.

| Required gate | Status | Evidence |
| --- | --- | --- |
| Normal interaction | VERIFIED | Two official AG-UI clients receive text, tool progress, and authoritative finalized messages. |
| Duplicate submission | VERIFIED | One accepted input and one effect. A changed payload under the same request ID returns 409. |
| Reconnect | VERIFIED | Deterministic proof includes mid-run attachment. Live proof attaches during the human wait. One Client B process attaches during the committed-effect wait while the phase stays running. A second Client B attaches during the human wait using the current snapshot cursor and converges with Client A on the finalized messages. |
| Gateway restart | VERIFIED | Finalized native messages, AG-UI messages, human request, and scoped context survive process replacement. |
| Worker interruption | VERIFIED | A SIGKILL follows the committed fixture effect. Temporal records a HEARTBEAT timeout and attempt 2. One effect row remains. |
| Human wait | VERIFIED | A separate Client B action resolves the same request after worker and gateway restart. |
| Conflicting response | VERIFIED | Version 0 and conflicting decisions return 409. An identical response is accepted without another effect. |
| Explicit cancellation | VERIFIED | Cancellation is acknowledged and reaches a terminal state during a tool and a human wait. The SDK observer exits cleanly. |
| Isolation | VERIFIED | Another principal cannot read, submit, observe, resolve, or cancel. Invalid credentials return 401. |
| Shared context | VERIFIED | Only two selected project notes enter the conversation. File and body digests, paths, timestamps, and the clean fixture commit survive reconnect. |
| Telemetry | VERIFIED | Local OpenTelemetry captures framework and application spans with conversation and run correlation. Credential checks pass. Datadog delivery is outside scope. |
| Real subscription | VERIFIED | The documented live entry point completed through Go and returned glm-5.3-flash. Current owner attestation records Extra Usage disabled. See live-acceptance.json. |
| Temporal history replay | VERIFIED | Temporal Replayer accepts all three captured workflow histories. Canonical framework message parts and timestamps survive forced replay. |
| Clean start | VERIFIED | A separate temporary source copy runs setup and verification. Source hashes match the implementation. |
| Independent fix review | VERIFIED | Fresh claude-opus-5-5 review covers the four corrections, final verifier fix, clean deterministic/live evidence, and audit trail. No material findings remain. The review predates commit. See [the review disposition](../review-resolution.md). |
| Authentication and permissions merge review | NOT VERIFIED | Human review is required before merge. No merge or real PR action was performed. |

The detailed [deterministic report](final-acceptance.json) records workflow IDs,
activity retries, process termination points, fixture effects, framework
messages, note provenance, and telemetry. [The clean-start manifest](clean-start.json)
records exact source hashes. [The setup log](clean-setup.log) and
[verification log](clean-verify.log) preserve the exercised commands' output.
The AG-UI captures are [Client A](client-a.jsonl), [Client B during the active tool](client-b-midrun.jsonl),
[Client B during the human wait](client-b.jsonl), and
[the cancellation observer](cancel-client.jsonl).

Python is 3.13.12. Pydantic AI is 2.66.0. Pydantic is 2.14.3. The Python AG-UI
protocol is 1.0.0 and the JavaScript client is 1.0.4. Temporal SDK is 1.35.0.
Temporal CLI is 1.10.0 with server 1.32.2. PostgreSQL is 17.6. Beans is 0.3.0.
The lockfiles and reports contain the remaining dependency versions.

[The live report](live-acceptance.json) records ten verified live gates and one
accepted Temporal history replay. Worker fault injection and explicit cancellation
remain NOT VERIFIED in that live report because those scenarios run in the
separate deterministic proof. Its three replays and eleven verified deterministic
gates remain in final-acceptance.json from the corrected clean source copy.
The earlier report remains in inherited-final-acceptance.json.

The expired-key [preflight](go-preflight.json) and the later read-only
[key recheck](go-key-recheck.json) are historical. The live report supersedes them
for current account-path acceptance. It does not establish independent billing-console
verification. The private owner attestation stays outside Git.

[The continuation source manifest](continuation-source-manifest.json) binds both
reports to the delivered source hashes. All 24 hashes match the final clean
source copy. The earlier manifest and reports are retained under inherited-* names.
The continuation changed only the verifier identity and completion checks.

The provider_url check confirms configured client metadata, not independent
server-origin attestation. The returned model identity is provider supplied.
Billing and Extra Usage settings rely on the owner's current explicit attestation.
See [the final independent review](continuation-final-review.json) for limitations
and low observations. Review-branch packaging does not authorize merge.

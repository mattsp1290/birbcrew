# Bounded continuation handoff

The authorized delivery branch is `review/first-milestone-subscription-proof`.
The inherited base is `7c27e2c72a499b5db1179ed91570647797159a63`.
The continuation preserved all uncommitted implementation and redacted evidence.

## Pickup checklist

1. Locate the prior trail. Completed from docs/decisions.tsv and the evidence supplied by the owner. No unrelated session was read.
2. Reconstruct operational state. Completed from Git, checkout process inspection, repository instructions, and milestone documentation.
3. Diff done vs pending. Completed. All 24 inherited source hashes matched at pickup. The earlier deterministic report is retained as inherited-final-acceptance.json. Final source received a narrow verifier correction and a new clean deterministic run.
4. Route the remaining work to the matching playbook and pick the verdict. The bounded live-account proof and fresh review are complete. Deliver the selected source and redacted evidence on the review branch. No PR or merge is authorized.
5. Verify the inherited claims against the original goal on the real artifact. Hash comparison completed. Fresh lint and seven boundary tests passed. The live verification entry point completed successfully.

## Throughput checkpoint

Account readiness and source review are independent. One Codex owner controls this checkout.
Claude reviews through the documented CLI host mapping with subscription authentication, safe mode, and read-only tools.
The existing verifier owns disposable PostgreSQL, loopback Temporal, and explicit disposable Beans selection.
No new architecture or runtime transport is needed.

## Account gate

On November 6 the owner explicitly confirmed that their Go subscription has Extra Usage disabled.
The continuation recorded a current private SubscriptionEvidence file outside Git with mode 0600.
It contains no key. The key stays in the literal assignment in the owner's local profile.
The official [Go documentation](https://opencode.ai/v2/docs/console/go/) was rechecked before the live journey.
It permits coding-agent traffic with the client's own User-Agent and a stable conversation session header.
It lists `glm-5.3-flash` at the existing compatible endpoint and describes Extra Usage as pay-as-you-go fallback.
Eligibility for this synthetic coding task follows those published requirements and the owner's subscription confirmation.
Billing settings remain an owner attestation. No billing-console API or balance inspection is claimed.
No settings were changed and no paid fallback was selected.

## Tool adaptation

Cursor-only Task roles are replaced by the approved Codex implementation and independent Claude CLI review mapping.
The cursor-team-kit deslop and control-cli skills are unavailable in the installed skill locations.
No successful invocation is claimed. Source inspection, lint, boundary tests, the real verification entry point, and fresh Claude review provide the available checks.
No changes to shared skills or other repositories are included in this bounded proof.

## Commands exercised

- `uv run --locked ruff check src tests` passed.
- `uv run --locked python -I -m pytest -q` passed seven boundary tests.
- `scripts/verify --mode live --attestation <private absolute path>` passed. It repeated lint and seven tests, then ran real services and the subscription journey.
- All 24 source SHA-256 values were recomputed. The clean temporary copy matches the final checkout. One source file changed after pickup, src/birbcrew/proof.py.
- `claude --help` and process-local `claude auth status` established the supported review controls and Max subscription authentication.
- `gh auth status` and `gh repo view --json viewerPermission -q .viewerPermission` established repository push authorization. Origin uses SSH and GitHub returned ADMIN.

## Runtime coverage

The final clean deterministic report verifies eleven acceptance gates and three history replays. Historical originals remain under inherited-* names.
The initial live report verifies ten gates and one history replay, including real subscription streaming and tool behavior. The final live rerun also passed against the same clean source copy after the verifier correction.
Its worker-interruption and explicit-cancellation gates stay NOT VERIFIED because live mode does not execute those fault scenarios.
Those two requirements are verified by the separate deterministic report. Final source and evidence hashes are recorded in continuation-source-manifest.json.
The returned live model is `glm-5.3-flash`.
The real subscription uses the Go endpoint and current owner attestation. There is no independent billing API verification.
All required runtime journeys now have evidence. Fresh final review resolved all material findings.

## Attention

Reviewed by `claude-opus-5-5`. The final independent review found no material findings.
Authentication and permissions require human review before any merge.
No PR, merge, deployment, private Beans hub access, or real notification action was performed.

## Principles applied

Prove It Works required actual live responses and clean reruns after the source correction.
Model the Domain kept returned model and endpoint identities in the existing completed-gate evidence record.
Fix Root Causes moved live acceptance after replay and telemetry and required the native returned identities.
The existing Python, Pydantic AI, Temporal, and AG-UI design remains intact.

## Final clean verification

After the verifier correction, `scripts/setup`, `scripts/verify`, and the live
verification entry point ran from a separate clean source copy.
Setup, lint, and seven boundary tests passed. Eleven deterministic gates and
three history replays passed. Ten live gates and one history replay passed.
The live gate checked native model identity and provider URL after replay and
telemetry. The final returned model was `glm-5.3-flash`.
All twelve required journeys have verified evidence across the two reports.
The continuation manifest records all 24 source hashes and hashes of the final
reports, logs, and client captures. It was computed after the runs and matches
the clean copy and checkout. It does not claim in-process Git instrumentation.
Earlier artifacts are retained under inherited-* and live-initial-* names.
The final independent review is recorded in continuation-final-review.json. Source and evidence are selected for the authorized review-branch commit.

## Remaining gates and review limits

First-milestone runtime acceptance is complete. Human authentication and
permissions review is still NOT VERIFIED and required before merge.
Billing settings are owner attested. Eligibility follows the published coding-agent
requirements. The configured provider URL is framework metadata, not independent
server-origin attestation. The returned model identity is provider supplied.
Evidence timestamps distinguish source capture from later status reconciliation.
Some decision rows were logged retrospectively and are not authorization records.
The final Claude review did not execute tests or recompute hashes and predates commit.
Low maintenance observations are retained in the review and disposition.
No material runtime or packaging blocker remains before the authorized Git operation.

Resolve the exact delivery revision with `git rev-parse HEAD` on the delivery
branch. The source, redacted evidence, and manifest are committed together.
For that revision, verify each source_hashes and evidence_hashes entry by hashing
`git show <revision>:<path>`. The final response supplies the actual revision and
push result. No final-commit review or merge authorization is implied.

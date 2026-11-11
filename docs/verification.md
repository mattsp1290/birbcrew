# Verify the local conversation proof

Use Linux with Docker access, Git, curl, sha256sum, ripgrep, uv, and `bn` 0.3.0.
The setup uses pinned PostgreSQL and Node container images. It downloads Temporal
CLI 1.10.0 and verifies its published checksum. Python 3.13.12 and Python packages
are pinned. The JavaScript lockfile pins the AG-UI clients.

1. Run `scripts/setup` from the repository.
2. Run `scripts/verify`.
3. Read `report.json` in the printed temporary evidence directory.

The command runs lint and focused boundary checks before the real-service
journey. All listeners bind to loopback. Each run uses a fresh PostgreSQL
container, Temporal development database, credentials, and Beans hub. The
verifier removes its container and stops its processes. Evidence and disposable
fixture files remain in the printed temporary directory for inspection. They
include test credentials and must not be committed wholesale.

Python runs in isolated mode to prevent the host's automatic Datadog injection
from changing workflow behavior. The proof records OpenTelemetry locally.
Local capture does not verify Datadog installation or delivery.

## Run the subscription journey

Before model calls, verify that the chosen account is an eligible OpenCode Go
subscription and that Extra Usage is disabled. If it is enabled or unknown, stop
and ask the owner to check or change it. Do not enable paid fallback.

The proof reads the literal `OPENCODE_GO_API_KEY` assignment from `~/.profile`.
It never prints that value or sources the profile. Use the owner's supported
credential flow to provision it. Do not put a credential in this repository.

Write a local account-evidence file outside Git. The schema is defined by
`SubscriptionEvidence` in `src/birbcrew/provider.py`. Record provider
`opencode-go`, a nonsecret account-path label, boolean `extra_usage_disabled`
and `eligible_coding_use`, a current UTC `checked_at`, and the evidence source.
Evidence older than twelve hours is rejected. This is an explicit owner
attestation, not an automated billing-console check.

Run `scripts/verify --mode live --attestation /absolute/path/to/account.json`.
It uses the same conversation runtime with the compatible OpenAI provider and
`glm-5.3-flash`. The request identifies Birbcrew and supplies a stable conversation
session header. It performs only the synthetic coding journey. The account
preflight and returned model identity appear in the report. This live journey
is opt-in for routine runs and required for milestone acceptance.

## Inspect the evidence

The report records package and service versions, workflow IDs, process
termination points, fixture results, finalized messages, scoped note provenance,
and gate results. Client JSONL files contain AG-UI events. Worker logs and local
telemetry files correlate conversation, workflow, request, and operation IDs.
The raw Temporal histories stay in the disposable evidence directory.

Treat missing, failed, or inconclusive gates as unresolved. Source review cannot
replace a live integration run. Human review of authentication and permissions
is required before merge, even when all automated proof checks pass.

### TypeScript history replay and traces

Run `node tests/proof/replay-traces.mts` from the checkout against disposable
PostgreSQL and Temporal instances using `BIRBCREW_DATABASE_URL` and
`BIRBCREW_TEMPORAL_ADDRESS`. The probe uses local Claude, Codex and Pi providers and
requires Linux `unshare --user --net`. It replaces the worker while a Claude and a Pi call await approval. It settles a Codex call on its live connection before the restart. It completes all three conversations and the Pi child, then exports four private histories into a temporary directory. It replays them with
Temporal’s TypeScript Worker in a separate process with no network interfaces,
checks that the provider request log and receipt ledger are unchanged, and
removes the histories when it exits. To retain the redacted report with span
correlations, history hashes, package integrity values and source revision, set
`BIRBCREW_REPLAY_EVIDENCE` to an output file outside the checkout.

Set `BIRBCREW_TRACE_FILE` on a member worker to write local OpenTelemetry
spans to a private JSONL file. Model invocations, workflow segments, native
restores and tool settlement carry the conversation, request, engine and
Temporal run IDs. A Pi child also carries its child ID. Completed spans from
the same conversation and request share a trace ID across processes and worker
replacements. The exporter only records correlation IDs, span relationships,
timing and status.

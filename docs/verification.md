# Verify the local conversation proof

Use Linux with Docker access, Git, curl, sha256sum, ripgrep, uv, and `bn` 0.3.0.
The setup uses pinned PostgreSQL and Node container images. It downloads Temporal
CLI 1.10.0 and verifies its published checksum. Python 3.13.12 and Python packages
are pinned. The JavaScript lockfile pins the AG-UI clients.

1. Run `scripts/setup` from the repository.
2. Run `scripts/verify`.
3. Read `report.json` in the printed temporary evidence directory.

For the historical Python journey, use `scripts/verify` or
`scripts/verify-legacy --mode test`. Its report and private temporary files
belong to that run. To reproduce the historical hosted proof, invoke
`scripts/verify-legacy` explicitly with its approved attestation.

### TypeScript fixture verification

Run `scripts/setup --mode fixture` on Linux with Docker, Git, curl,
sha256sum, a C compiler and Linux development headers. Claude needs Landlock ABI
3 or newer and Codex needs ABI 4. Install Beans (`bn`) for the project-note
cases. Setup installs the pinned Node and Temporal executables, both npm
lockfiles, and the native launcher. The member fixture path requires no Python
interpreter. Offline replay also needs Linux user and network namespaces.

Run `scripts/verify --mode fixture` for the combined matrix, or add
`--engine pi`, `--engine claude`, or `--engine codex` for one member SDK.
`scripts/verify-members` and `npm run test:integration` use the same Node
entrypoint. Each run starts disposable PostgreSQL and Temporal on loopback,
checks two distinct conversations per member before and after cold replacement,
and cleans up its processes, containers, and native transcripts. Two separate
`clients/observe.mjs` processes use the client lockfile. One watches throughout
the conversation and the other attaches to a pending call. The verifier compares
both saved `.messages.json` files with the complete ordered PostgreSQL and HTTP
snapshots after the owner approves the call. Engine-specific
tests cover native calls, approvals, isolation, cancellation and observers.
The combined run also exercises simultaneous cancellation and offline replay.

Set `BIRBCREW_FIXTURE_EVIDENCE` to an output file outside the checkout for the
redacted JSON report. Use separate files for fixture and replay evidence. It records selected engines, passed stages, pinned package
integrities, launcher checksum, source fingerprint, and result. Release evidence
requires a clean checkout or a verified `git archive`. For an independently
attested source copy set both `BIRBCREW_SOURCE_REVISION` and
`BIRBCREW_SOURCE_SHA256` to the revision and source fingerprint established
from the original checkout.

### Live member verification

The opt-in member entrypoint is `scripts/verify --mode live --engine ENGINE
--attestation /absolute/private/account.json`. Each provider needs its own
approved account and credential. Fixture results apply only to the controlled
local providers. See the [account and profile guide](member-profiles.md).

## Run the Python subscription journey

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

Set `BIRBCREW_OTLP_TRACES_ENDPOINT` to also send the same spans over OTLP/HTTP
JSON to a collector. Give the full traces URL, such as
`https://collector.example/v1/traces`. It must use `https`, except that plain
`http` is allowed to `127.0.0.1`, such as `http://127.0.0.1:4318/v1/traces`,
and to any other host when `BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true` is also set
(see the Datadog Agent recipe below). IPv6 literal hosts such as `[::1]` are
rejected because the exporter cannot connect to them. It must have a path and must not embed a
user name, password, query string or fragment; the exporter sends only the
path, so a query string would otherwise be dropped. Either sink, both or
neither may be set. Spans come from the member worker and its native turn
runners, but every process that loads the store also reads the setting: the
gateway, every `members` command, the worker, the supervisor host and the turn
runners. Each of them fails at startup when the value breaks these rules, so
a malformed value stops the whole service, not only tracing. The error names
the variable and does not repeat the value. Each span carries only its name,
trace and span IDs, parent, timing, status and the same correlation IDs as the
file. Prompts, replies, tool arguments and credentials are never span data.
Spans are batched in a bounded queue and
dropped when the queue is full or the collector fails; export never fails a
turn. It can slow one, though: the host confirms a native turn only after its
runner exits, and the runner first waits up to 250 milliseconds to flush its
spans. A slow, stalled or unreachable collector therefore adds up to a quarter
second to every native turn, and spans not flushed in time are dropped. The
worker waits up to one second to flush when it stops. An export still in
flight can then keep it up longer: about two seconds when the collector
accepts the connection and stays silent, but until the operating system gives
up on the connection attempt, about two minutes on Linux, when nothing answers
the collector's address, and for as long as a collector keeps trickling an
answer. The orchestrator's stop timeout ends it in those cases. The exporter also
honours the standard `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_EXPORTER_OTLP_TRACES_HEADERS`, certificate, client key and compression
variables. The generic `OTEL_EXPORTER_OTLP_*` forms apply to every OTLP
exporter, so a header or certificate set for another service on the same host
is sent to this collector too. Prefer the `OTEL_EXPORTER_OTLP_TRACES_*` forms
and keep the generic ones unset for Crew. The exporter sends JSON only:
`OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` is ignored, gRPC is not used, and the
standard `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
do nothing on their own. The Python worker writes only the JSONL file.

The resource carries `service.name` and any attributes from
`OTEL_RESOURCE_ATTRIBUTES`. Both variables are read only when
`BIRBCREW_OTLP_TRACES_ENDPOINT` is set; no host, process or container
attributes are detected. The service name is `OTEL_SERVICE_NAME` when set and
not empty, otherwise `service.name` from `OTEL_RESOURCE_ATTRIBUTES`, otherwise
`birbcrew`. `OTEL_RESOURCE_ATTRIBUTES` follows the OpenTelemetry format:
comma-separated `key=value` entries such as
`deployment.environment.name=production,service.version=1.2.3`. Whitespace
around the whole value, such as the final newline of a YAML block, is ignored,
as are spaces and tabs around keys, values and commas. Empty entries are
skipped. Each key is a W3C Baggage token (letters, digits and
``!#$%&'*+-.^_`|~``) of at most 255 characters and appears once. Keys that
plain JavaScript objects inherit, such as `constructor`, `toString` or
`__proto__`, are refused because the OpenTelemetry SDK would drop them. Each
value is not empty and uses printable ASCII other than space, `"`, `,`, `;`
and `\`; percent-encode anything else, such as `%20` for a space or `%2C` for
a comma. Decoded, a value must be valid UTF-8, not only whitespace, and at
most 255 characters, counted as Unicode code points. It must not contain
control characters, invisible formatting characters, or line or paragraph
separators (Unicode categories Cc, Cf, Zl and Zp). At most 32 entries and 4096
characters are accepted. `OTEL_SERVICE_NAME` follows the same length and
character limits as a decoded value, after surrounding whitespace is removed.
Unlike the OpenTelemetry SDK, which drops malformed input silently, Crew
refuses to start when either variable breaks these rules, so a typo cannot
quietly remove the environment or version. The error names the variable and,
for an attribute, the entry's position among the comma-separated parts
(counting from 1, empty parts included), never its content.

When an export fails, the process writes one line to standard error, such as
`birbcrew: OTLP trace export failed (ECONNREFUSED) and its spans were dropped;
the next warning comes at least 5 minutes later`. The reason in parentheses is
one of these:

- an HTTP status, such as `HTTP 404`;
- `HTTP 429, 502, 503 or 504`, when retries on one of those statuses ran out;
- a fixed Node or OpenSSL error code, such as `ENOTFOUND`, `EPROTO` or
  `DEPTH_ZERO_SELF_SIGNED_CERT`;
- `timeout`, when no answer came within two seconds, including a connection
  attempt that is never answered;
- `unknown error`.

The line never contains the endpoint, a header, the collector's status text or
response body, or span data. Each process writes at most one such line every
five minutes and counts the failures it held back in the next one. A failed
write, such as to a closed pipe, is ignored. Native turn runners discard
standard error, so the line comes from the worker. Crew registers no
OpenTelemetry diagnostic logger.

#### Datadog Agent

To send spans to a Datadog Agent's OTLP receiver inside a Kubernetes cluster,
set these on the worker container. Its supervisor host and turn runners inherit
them. The gateway also reads them but emits no spans.

```sh
BIRBCREW_OTLP_TRACES_ENDPOINT=http://datadog-agent.default.svc:4318/v1/traces
BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true
OTEL_SERVICE_NAME=crew-worker
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.version=1.2.3
```

The Agent must run APM with its OTLP HTTP receiver listening beyond
loopback, for example `DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318`.
The receiver speaks plain HTTP, so an `https` endpoint fails every export with
`EPROTO`. Whenever `BIRBCREW_OTLP_TRACES_ENDPOINT` is set,
`BIRBCREW_OTLP_TRACES_ALLOW_HTTP` must be `true` or `false`, in any case, or
empty, which means `false`; any other value stops startup. The opt-in changes
only whether the connection is encrypted, not where spans may go: an `https`
endpoint may already name any host. When the endpoint is plain `http` to a
host other than `127.0.0.1`, Crew refuses to start if
`OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_TRACES_HEADERS` holds
anything other than whitespace, because those headers usually hold
credentials. Everything else in each request is readable on the network: the
host and path, the resource attributes (service name, environment, version and
anything else in `OTEL_RESOURCE_ATTRIBUTES`), and every span's name, timing,
status, `engine`, and conversation, request, workflow run and child IDs. Use
the opt-in only where the path to the Agent stays inside the cluster network.
The exporter reads the collector's response without a size limit, as it does
over `https`, so whoever can answer in the collector's place can grow the
process's memory; without encryption that includes anyone able to intercept
or impersonate the Agent's Service inside the cluster.

The Agent maps `service.name` to the Datadog service,
`deployment.environment.name` to `env` and `service.version` to `version`.
The span name (`workflow.segment`, `model.invoke`, `tool.settle` or
`native.restore`) becomes the Datadog resource name. Every span's operation
name is `Internal`, because Crew sets no `operation.name` attribute: spans
carry only correlation IDs and the engine. An Agent started with
`DD_OTLP_CONFIG_TRACES_SPAN_NAME_AS_RESOURCE_NAME=true` uses the span name as
the operation name too, but that setting applies to every service sending OTLP
to that Agent.

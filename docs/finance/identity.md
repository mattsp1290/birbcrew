# Private finance identity

The dedicated Python listener exposes initialization and finalized snapshots for synthetic finance conversations. It requires Go's service certificate. It runs only with `mode="test"`, an empty `token_hashes` mapping, and a task queue whose name starts with `finance-`. It has no command, event, decision, or cancellation routes.

## Caller contract

The prefix is `/internal/v1/finance/owners/{owner}`. The owner must match Go's canonical lowercase UUIDv4 format, including the RFC variant. The certificate identifies the Go service. Go derives the delegated owner from its authenticated caller.

| Method and suffix | Body | Result |
| --- | --- | --- |
| `POST /thread` | Exactly `{}` | The stored conversation snapshot, including `id`, `owner`, `revision`, and finalized `cursor`. |
| `GET /threads/{id}/snapshot` | None | The same snapshot contract for the canonical owner/thread pair. |

Initialization accepts no supplied thread, context, or owner override. Repeated and concurrent initialization returns the stored winning UUID. A foreign owner/thread pair returns the same 404 as an absent pair. Ordinary Crew owners remain opaque strings and can own multiple conversations.

Initialization commits the binding and revision-zero conversation before it starts `ConversationWorkflow` under the existing `birbcrew-{id}` workflow ID. Retries after a failed start or lost acknowledgement use that same ID. Temporal duplicate rejection prevents a second execution. A retained workflow is required for an advanced snapshot. If that workflow is absent, initialization returns 503 and requires recovery.

The snapshot cursor comes from `conversations.snapshot_cursor`, paired with the stored snapshot in one query. It is not the latest provisional event cursor. Initialization may return revision zero before the worker's first persistence completes.

## Transport policy

`python -I -B -m birbcrew.finance.server` is the private entrypoint. `BIRBCREW_FINANCE_CONFIG` names an absolute protected JSON file. No general bearer routes are mounted.

The listener requires TLS 1.3 and a verified client chain under only the configured client CA. The accepted leaf must have exactly one URI SAN matching `service_uri`. The adapter checks current validity, the exact server SSL context, required certificate verification, and absence of session reuse. Session tickets are disabled. Authorization headers and forwarded certificate headers never establish service identity.

Each connection owns an immutable principal. A timer closes the connection at the earlier of certificate expiry and `max_connection_age`. Request and response-send guards enforce the same bounds. A private app served without this adapter rejects requests. Rotation requires process replacement. Existing connections do not revalidate changed trust roots.

## Configuration reference

The listener configuration forbids unknown fields. There are no implicit host, port, TLS, or connection-age defaults.

```json
{
  "host": "127.0.0.1",
  "port": 8443,
  "certificate": "/run/crew-finance/server.crt",
  "private_key": "/run/crew-finance/server.key",
  "client_ca": "/run/crew-finance/client-ca.crt",
  "runtime_config": "/run/crew-finance/runtime.json",
  "service_uri": "spiffe://synthetic.invalid/service/go-finance",
  "max_connection_age": 300.0
}
```

The URI above is a synthetic example, not a production identity. The runtime file uses the existing `Settings` schema. It requires `database_url`, `temporal_address`, `task_queue`, `token_hashes`, `context`, `evidence_dir`, and explicit `mode`. Test mode needs no provider credential. Project modes, project service credentials, nonempty bearer mappings, and the interrupt switch are rejected by this entrypoint. Unknown runtime fields are also rejected.

All referenced paths are absolute regular files. Symlinks are rejected. Files and every parent directory must belong to root or the running service UID. Group-writable or world-writable paths are rejected. Configuration files and private keys must also have no group or world access. Certificate and CA files may be readable by others. Mount these inputs read-only. The image's default UID is 10001.

The listener validates configuration, certificate/key compatibility, and the required PostgreSQL schema before it opens its port. Missing or invalid inputs have no plaintext fallback. Startup errors omit configuration contents. `SSLKEYLOGFILE` is forbidden. The runtime's optional Temporal TLS files receive the same protected-file checks.

## Persistence and rollout

`store.migrate()` owns the finance DDL. The shared transaction advisory lock `8801290` serializes core, finance, and execution journal migrations. The journal acquires the lock inside its own transaction before schema or table creation, including direct journal callers. `finance_threads.owner` is the primary key, its conversation ID is unique and non-null, and a deferred composite foreign key requires the same conversation owner. Allocation retries UUID collisions in a fresh transaction. Losing owner inserts select the committed winner in a separate READ COMMITTED statement.

Both public owner-list branches and the public snapshot query exclude every finance binding. Public create-with-existing-UUID reaches that exclusion before workflow access. The binding is not changed or deleted by these APIs. Future deletion must preserve isolation for surviving conversation rows.

The rollout order is mandatory.

1. Run the existing Python migration with the intended database configuration.
2. Replace every old public Python process with a version containing the finance exclusions.
3. Enable the private listener and its dedicated test worker.

An old public process lacks these exclusions. This is route isolation within a shared database, not protection from a compromised database client.

## Image and qualification

`packaging/finance.Dockerfile` uses the locked Python dependencies and requires explicit immutable `PYTHON_IMAGE` and `UV_IMAGE` build inputs. Build with a source-only context containing `pyproject.toml`, `uv.lock`, the Python `src/birbcrew` tree, and this Dockerfile. Do not send the whole working directory, ignored files, runtime configurations, or identity mounts as build context.

The standalone qualifier requires Python 3.13.12 with the locked development dependencies, Docker, OpenSSL, the pinned PostgreSQL image, a built candidate image, and an explicitly supplied verified Temporal CLI 1.10.0 executable.

```sh
FINANCE_PYTHON=/absolute/locked/python scripts/verify-finance-identity \
  --image candidate-image-id \
  --temporal-cli /absolute/verified/temporal \
  --evidence-dir /absolute/new-owned-evidence-directory
```

The evidence directory must not exist. The qualifier compares the complete actual image `birbcrew` Python tree with the selected source. Missing, additional, or changed modules fail qualification. It starts only owned loopback resources and emits a per-case JSON ledger. Most instrumented listeners use the caller's UID to read caller-owned synthetic files beneath a protected container path. The default-image replacement case separately exercises UID10001 with service-owned read-only mounts. Crash and timer controls exist only in test code.

The qualifier registers an exact name, ownership label, and private receipt before every container creation, including one-shot utilities. Cleanup uses validated full IDs and the original child process handles. Each bounded cleanup attempt retains its error and independently checks absence. A creation timeout receives bounded receipt reconciliation. An unresolved acquisition, survivor, unobservable resource, or failed cleanup attempt makes qualification fail. Bounded observation cannot prove that an arbitrary daemon will never complete a delayed request afterward.

The final ledger includes its exit status before atomic persistence. Cleanup continues through individual failures, and a failed final write emits the complete final document to stderr. Repeated finalization returns the same result. The qualifier also creates the worker's private evidence directory before startup and checks that worker's exact telemetry file and log after shutdown. Missing activity spans, mismatched conversation/workflow identifiers, or exporter errors fail qualification separately from the original cases.

Focused cleanup controls run with `python -m unittest discover -s tests/finance -p test_resources.py`. Set `FINANCE_TEST_DOCKER_IMAGE` to the candidate image ID to include real Docker creation timeouts, name collision, and daemon-unavailable controls. Those controls use only their own labeled containers. Their injected failures must produce a failed qualification while later cleanup and final evidence still complete.

The qualification covers real TLS, PostgreSQL races and collisions, retained Temporal startup and recovery, strict startup refusal, the public app's authorization paths, deadlines with deliberately incorrect timer controls, and image replacement. Public-route negatives use the actual ASGI app. They are not network deployment evidence. Session reuse may remain unestablished because tickets are disabled. A suspended streaming generator is not proof of socket write backpressure.

## Remaining delivery

The next unit owns inputs, decisions, cancellation, events, finalized-cursor reconnect and expiry, and command retry contracts through this private listener. This unit does not alter the retained workflow's input cap or content-bearing history. Reference-only payload and history work remains required before private finance data can enter the runtime. Production credentials, rotation, worker confinement, deployment, and release acceptance remain separate work. Synthetic identity qualification does not complete those requirements.

The focused journal migration regression uses `FINANCE_MIGRATION_DSN` for an owned disposable PostgreSQL server. Run `pytest tests/execution/test_journal_migration.py`. Each test creates and removes its own database. The overlap test pauses the first actual migration after DDL and confirms the second is blocked by that transaction before release. It also checks repeat migration, exact columns and primary key, retained claims, terminal state, and receipts. A separate test starts eight independent cold migrators.

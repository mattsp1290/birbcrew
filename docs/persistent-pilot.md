# Approved documentation delivery pilot

Birbforge owns approval and the delivery workflow. Birbcrew runs three versioned Temporal activities on the subscription-authenticated executor host. The activities author an approved documentation change, obtain an independent Claude review, and publish the reviewed commit as a draft GitHub PR. They do not merge or deploy it.

The public contract is generated from `execution/contract.py` into `contracts/execution.v1/schema.json`. Approval binds an immutable goal record, its content digest, repository, base commit, installed policy revision, exact documentation paths and trusted acceptance identifier. Birbforge computes the offer digest and clients echo it. Digests use UTF-8 JSON with sorted object keys, no insignificant whitespace and unescaped Unicode. Contract offers contain no floating-point values. The installation selects one record from a dedicated Beans hub; it must not read the owner's default hub or reuse `FixtureHub` as a live adapter.

## Persistent processes

Run the idempotent migration once with the database migration identity.

```sh
BIRBCREW_CONFIG=/private/crew.json python -m birbcrew.migrate
```

Run the API alongside Birbforge's loopback gateway. Set `mode` to `approved-goal`. This mode stores owner-scoped conversations without starting the synthetic conversation workflow or invoking an OpenCode model. Existing proof modes remain separate.

```sh
BIRBCREW_CONFIG=/private/crew.json python -m uvicorn birbcrew.api:app --host 127.0.0.1 --port 8000
```

Run the activity worker on the host containing the existing managed Codex daemon and Claude subscription login.

```sh
BIRBCREW_CONFIG=/private/executor-store.json BIRBCREW_EXECUTION_CONFIG=/private/execution.json python -m birbcrew.execution.worker
```

The worker registers activities only. It does not start another scheduler or manage the Codex daemon lifecycle. `Settings` supports an explicit Temporal namespace and optional mTLS CA, client certificate, private key and server name. The executor database role needs only SELECT, INSERT and UPDATE on `execution.operations`. API storage and Temporal persistence use separate roles.

`ExecutionSettings` is the private installation contract. All binary, checkout, artifact and worktree paths are absolute. The one repository binding contains the exact GitHub remote, base branch, allowed Markdown paths and acceptance command. The client cannot submit a shell command or choose an execution host. Acceptance runs the installed command, never a script from the candidate. Set the command to a trusted check for the intended document, including its length and required topics. Its output is retained privately.

## Recovery and cancellation

Each activity claims `(kind, operation_id)` before effects. A changed payload conflicts. A repeat reconciles the same identity. Author checkpoints use whole-record compare-and-swap, so two attempts cannot both freeze the candidate or overwrite a terminal result. The claim, known thread and turn remain durable in PostgreSQL.

A lost turn-start reply is reconciled only against the new, owned thread. Exactly one turn can be adopted. Zero or several turns leave uncertainty; the activity never blindly submits a replacement turn. A worker shutdown is not a cancellation request and must not interrupt the daemon. Interrupted preparation or candidate freezing also leaves uncertainty instead of repeating an ambiguous mutation.

A daemon `interrupted` turn is insufficient evidence of stop. The implementation additionally observes no open file or working-directory handles under the owned worktree and unchanged file bytes over a second. Cancellation waits up to 60 seconds for that condition. The same check gates candidate freezing. If it cannot be confirmed, the result stays uncertain. This is a trusted-owner documentation pilot, not hostile-code isolation. The executor's subscription credentials are not suitable for arbitrary untrusted workloads.

The trusted worker checks exact changed paths, regular nonexecutable files, no symlink traversal and the unchanged base, then creates the candidate commit with hooks disabled. Independent review receives the exact diff with text conversion and external diff disabled. Claude has no tools or MCP servers, hooks are disabled, and API/provider environment overrides are removed so the normal subscription login is used. Its structured verdict is persisted once. A lost review reply never causes another reviewer invocation.

Publication verifies the stored author and review receipts, clean candidate SHA, explicit installed remote, deterministic branch and ownership marker. It uses a normal push. Existing PR lookup includes closed PRs. A foreign or closed PR blocks publication. A lost create reply reconciles the matching open draft rather than creating another. User-visible review summaries contain bounded findings; full evidence stays private.

After restoring a database, keep dispatch disabled until an operator reconciles known worktrees, daemon threads and remote branches/PRs. Do not treat an absent restored journal row as proof that no external work happened. Existing work without a matching record stays uncertain. Storage backup and restoration are installation gates, not claims made by these local tests.

## Verification

Run `uv run --group dev pytest` and `uv run --group dev ruff check src tests`. The execution tests exercise actual temporary Git repositories, PostgreSQL concurrent claims, Temporal activity-worker restart, strict receipt binding, lost turn and publication acknowledgements, and a live shell that writes after a simulated terminal label. The PostgreSQL and lsof checks require local binaries. The Temporal test uses `TEMPORAL_TEST_SERVER` or `/opt/homebrew/bin/temporal`.

Injected daemon and GitHub responses establish failure handling, not live provider or device acceptance. The persistent installation must separately prove the actual Codex and Claude subscription journey, exact draft PR, service recovery, and shared physical-phone/Mac controls. Fixture checks do not establish k3s candidate verification or native candidate isolation.

Build the container with digest-pinned `PYTHON_IMAGE` (Python 3.13 Debian slim) and `UV_IMAGE` build arguments. The Dockerfile installs the frozen dependency lock under `/venv` and runs as UID/GID 10001. Runtime configuration and credentials are mounted privately and excluded from the build context.

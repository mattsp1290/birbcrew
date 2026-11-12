# In-cluster executor

The approved-goal activity worker (`python -m birbcrew.execution.worker`) can run in a container without Claude. Codex still authors through the ChatGPT subscription and its app-server. OpenCode Go reviews through `birbcrew.provider`. The [pilot contract](persistent-pilot.md) still applies. This page covers only what changes in a container.

## Select the reviewer

`ExecutionSettings.reviewer` selects one review engine. It has no fallback.

```json
{
  "reviewer": {
    "kind": "opencode-go",
    "subscription_evidence": "/etc/crew/opencode-go-evidence.json",
    "api_key_file": "/run/crew/opencode-go.key"
  },
  "codex": "/usr/local/bin/codex",
  "git": "/usr/bin/git",
  "gh": "/usr/bin/gh"
}
```

Merge these fields into the existing installation file. The remaining fields are the same as before.

- When `reviewer` is absent, the Claude reviewer is selected. Configurations written before this field existed keep their behavior.
- `{"kind": "claude"}` requires `claude`. Any other reviewer rejects `claude`. The worker refuses to load a configuration that violates either rule.
- All configured paths must be absolute.
- `subscription_evidence` uses the existing OpenCode Go attestation format. Every review checks it before contacting the provider. It must be at most 12 hours old, so refresh it on that schedule. If it is missing, stale or ineligible, the review is inconclusive with `subscription_evidence_rejected` and makes no request.
- `api_key_file` must be a regular file, not a symbolic link. It must be owned by the worker's UID with no group or other permission bits, and it must contain one token with an optional trailing newline. Without `api_key_file`, the key comes from the `OPENCODE_GO_API_KEY` assignment in `$HOME/.profile`, as before. Crew never writes the key to evidence, receipts or logs.

The reviewer receives the unchanged prompt as one Chat Completions request. That request offers one tool, the `Verdict` schema, and requires the model to call it. If the reply is missing, malformed or contradictory, the review is inconclusive with `review_output_invalid`. If the request fails, the code is `provider_request_failed`. Neither case is retried, and the owner can request a numbered retry as before.

## Compatibility with stored records

Receipts gain one `reviewer` value, `opencode-go`. Stored Claude receipts and their evidence are unchanged and still validate. New evidence files record `reviewer`. Each `diagnostics` entry keeps the shape `{model, outcome, reported_models?}`. For OpenCode Go, `model` is `glm-5.3-flash` and `reported_models` holds the model name the provider returned. Legacy recovery only accepts Claude-era evidence that predates `schema_version`, so OpenCode Go receipts can never take that path.

Forge reads receipts with Crew's contract module, and its web client has its own copy of the schema. Both currently accept only `claude-cli`. Upgrade Crew first, then update and redeploy Forge. Select `opencode-go` only after both are updated.

## Build the image

`packaging/executor.Dockerfile` takes the same digest-pinned `PYTHON_IMAGE` (Python 3.13 Debian slim) and `UV_IMAGE` build arguments as the root Dockerfile. It installs the locked Python dependencies under `/venv` and adds Debian `git`, `gh`, `openssh-client` and `tini`. Codex is installed from the npm platform package that `package-lock.json` pins for `@openai/codex` 0.167.1. The build checks the package against the lock file's sha512 value. Node is not installed. The image runs as UID/GID 10001 (`crew`, home `/home/crew`) with `tini` as its entrypoint. Its default command is the activity worker. The build context excludes everything except `pyproject.toml`, `uv.lock` and `src/birbcrew`.

```sh
docker build --platform linux/arm64 \
  --build-arg PYTHON_IMAGE="$PYTHON_IMAGE" --build-arg UV_IMAGE="$UV_IMAGE" \
  -f packaging/executor.Dockerfile -t "$EXECUTOR_IMAGE" .
```

Use `--platform linux/amd64` for x86-64 nodes.

## Run Codex beside the worker

Run two containers from this image in one pod, both as UID 10001.

| Container | Command |
| --- | --- |
| Codex app-server | `codex app-server --listen unix://` |
| Activity worker | default (`python -m birbcrew.execution.worker`) |

Run the Codex app-server in the foreground as its container's main process. Do not use `codex app-server daemon start` in a pod. That command detaches, copies a managed Codex release into `CODEX_HOME` and runs a self-updater.

Each activity starts `codex app-server proxy`. Without `codex_socket`, the proxy uses `$CODEX_HOME/app-server-control/app-server-control.sock`. That path is a symbolic link into `/tmp/codex-daemon-10001/`. Both containers therefore need the same `/tmp` volume, the same `CODEX_HOME` mount path and the same UID. Mount the shared volume at `/tmp`. The server rejects a volume mounted directly at `/tmp/codex-daemon-10001`. Set `codex_socket` only when the socket is somewhere else. Crew passes it as `--sock`.

`CODEX_HOME` (`/home/crew/.codex`) must exist before the server starts. Codex offers headless sign-in through `codex login --device-auth`. Without a keyring, it stores the credential in `$CODEX_HOME/auth.json`. Before submitting work, an operator can call `account/read`. While signed out, it reports `"account": null` and `"requiresOpenaiAuth": true`.

## Mounts

The root filesystem can be read-only.

| Path | Containers | Purpose |
| --- | --- | --- |
| `/tmp` | both, shared, writable | Codex control socket directory. |
| `/home/crew/.codex` | both, shared, writable, persistent | `CODEX_HOME`, including the Codex login. |
| `worktree_root`, `repository.checkout` | both, same paths, writable, persistent | The author edits its worktree through Codex. The worker creates and verifies worktrees and commits. |
| `artifact_root` | worker, writable, persistent | Private review and acceptance evidence. |
| `BIRBCREW_CONFIG`, `BIRBCREW_EXECUTION_CONFIG` files | worker, read-only | Store, Temporal and execution settings. Include Temporal mTLS files if configured. |
| `subscription_evidence` file | worker, read-only | OpenCode Go attestation. |
| `api_key_file` | worker | A private copy owned by UID 10001 with mode 0400 or 0600. |
| `/home/crew/.ssh/` | worker, read-only | Deploy key and a `known_hosts` entry for `github.com`. OpenSSH reads this directory from the passwd entry, not `$HOME`. |
| `gh` credentials | worker | `GH_TOKEN`, or `GH_CONFIG_DIR` pointing at a mounted `hosts.yml`. |

Keep the OpenCode Go key, SSH key and GitHub credentials out of the Codex container. Kubernetes Secret volumes usually expose keys as root-owned symbolic links, which `api_key_file` rejects. Copy the key into a private file before the worker starts. This repository has no Kubernetes manifests, and that copy step has not been tested.

## What was verified

- `uv run --group dev pytest` covers reviewer selection, `claude` path rules, absolute paths, key-file permissions and contents, the existing `$HOME/.profile` reader, and `--sock` reaching the proxy argv. Review tests use a local scripted model and a local HTTP stub. They cover approved, changes requested, malformed or missing verdicts, provider failure, expired or invalid evidence, a single request with no retry, and heartbeats while the request is pending.
- The image was built for linux/arm64 and linux/amd64 (emulated). With `--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp`, both report `codex-cli 0.167.1`, git, gh and OpenSSH versions and import `birbcrew.execution.worker`.
- On linux/arm64, a foreground `codex app-server --listen unix://` container served Crew's `Daemon` client from a second container. The client used the default socket and `--sock`. The containers shared `/tmp` and `CODEX_HOME`. `account/read` returned the signed-out state. The server exited 0 on SIGTERM.
- With `HOME` pointed elsewhere, OpenSSH in the image still looked for identities under `/home/crew/.ssh`.
- A separate Codex 0.167.1 container prototype established three facts: what `daemon start` does, that the server rejects a volume mounted at `/tmp/codex-daemon-10001`, and where device sign-in stores its credential.

## What is not verified

- A live OpenCode Go review. In particular, it is unproven that `glm-5.3-flash` honours the required tool choice through OpenCode Go.
- A live Codex subscription turn in a container, including `codex login --device-auth`.
- Whether Codex's bundled bubblewrap sandbox can run tool commands with all capabilities dropped. The server logs that bubblewrap is not on `PATH` and uses its bundled copy.
- Kubernetes scheduling, volume ownership, and Secret handling.

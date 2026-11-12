# Run the TypeScript member service persistently

This guide covers the container image for the TypeScript gateway and worker,
their configuration, storage, database role and kernel requirements. It is a
packaging contract, not production authentication: the gateway still
authenticates each request with an operator-configured bearer token digest and
binds only to `127.0.0.1`. A consumer such as Forge reaches it from another
container in the same pod.

Statements marked **verified** were exercised for this change on a linux/arm64
Docker 29.2.1 host (Ubuntu 24.04 VM, kernel 6.8.0) with disposable PostgreSQL 17.6,
Temporal CLI 1.10.0's development server and synthetic credentials. Statements
marked **unverified** have not been run against a Kubernetes cluster or a real
provider account.

## Build the image

`packaging/service.Dockerfile` has no default base image. Pass a digest-pinned
Node 22.23.3 Debian bookworm image; the build stops for a tag without a digest,
another Node version or another Debian release.

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packaging/service.Dockerfile \
  --build-arg NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 \
  -t REGISTRY/crew-service:COMMIT --push .
```

The digest above is the `node:22.23.3-bookworm-slim` index resolved on
2026-11-12. Use BuildKit: the build context is limited by
`packaging/service.Dockerfile.dockerignore` to the lockfiles, vendored packages,
`scripts/build-native`, `native/member-launch.c` and `src/service`. Each platform
runs `npm ci --omit=dev` and compiles the native launcher against the same
bookworm glibc into `/app/.proof/bin/member-launch`, the path the source
resolves. The image runs as `10001:10001` under `tini` and contains no
credentials. The `Service image` workflow rebuilds it for amd64 on relevant pull
requests and runs it read-only with the flags below. **Verified:** the command above without `--push` built both
platforms, arm64 natively and amd64 under QEMU. The amd64 image completed the Pi
fixture path below under emulation; Codex was exercised on arm64 only.

## Processes

Both commands run from `/app`. Every process applies the `birbcrew_ts`
migrations at startup (see [Database role](#database-role)).

| Process | Command | Notes |
| --- | --- | --- |
| Gateway | `node src/service/gateway.ts /etc/crew/gateway.json` | JSON `{ "port": 8080, "tokenHashes": { "<sha256 hex>": "<owner id>" } }` as in the [gateway guide](member-gateway.md). Listens on `127.0.0.1:<port>` and prints `{"url": ...}`. |
| Worker | `node src/service/cli.ts worker src/service/providers.ts` | Registers the profiles enabled by the attestation variables below. |

Run one container per process with the hardening below. `tini` is the image
entrypoint and reaps orphaned SDK descendants, so do not add Docker's `--init`.
In Kubernetes pass the command as `args:`; setting `command:` replaces `tini`.

**Verified** with these flags for the gateway, the fixture worker and the members CLI:

```sh
--read-only --cap-drop ALL --security-opt no-new-privileges \
--tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 \
--mount type=volume,src=crew-state,dst=/var/lib/birbcrew/native
```

## Configuration

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `BIRBCREW_DATABASE_URL` | both | none | PostgreSQL connection string for the Crew database. TLS settings belong in the URL, for example `?sslmode=verify-full&sslrootcert=/etc/crew/postgres/ca.pem`. |
| `BIRBCREW_TEMPORAL_ADDRESS` | both | `127.0.0.1:7233` | Temporal frontend `host:port`. |
| `BIRBCREW_TEMPORAL_NAMESPACE` | both | `default` | Existing Temporal namespace. A worker exits with status 1 if it is missing; the gateway does not check it at startup. |
| `BIRBCREW_TEMPORAL_TLS_CA_PATH` | both | unset | Absolute path to the PEM CA that signs the Temporal frontend certificate. |
| `BIRBCREW_TEMPORAL_TLS_CERTIFICATE_PATH` | both | unset | Absolute path to the PEM client certificate. |
| `BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH` | both | unset | Absolute path to the PEM client private key. |
| `BIRBCREW_TEMPORAL_TLS_SERVER_NAME` | both | unset | Name checked against the frontend certificate and sent as SNI. |
| `BIRBCREW_STATE_DIR` | worker | `/var/lib/birbcrew/native` | Native state directory. Keep the image default. |
| `HOME` | both | `/tmp` | Writable home for SDK caches. |
| `BIRBCREW_PI_ATTESTATION`, `OPENCODE_GO_API_KEY` | worker | unset | Pi on OpenCode Go. See [Provider accounts](#provider-accounts). |
| `BIRBCREW_CODEX_ATTESTATION`, `BIRBCREW_CODEX_AUTH_HOME` | worker | unset | Codex with a ChatGPT subscription. |

Temporal TLS is all or nothing: set all four TLS variables, or none for the
previous plaintext connection. A partial set, a relative path or an unreadable
file stops the process before it connects. The error names only the variables
(and the file error code), never their values or file contents. The
gateway, the worker, the CLI and the Codex live-call signal sent from SDK child
processes all use these settings. Certificate and key files are read when a
connection opens; restart the gateway and worker after rotating them.

**Verified:** the gateway, the worker, its SDK child processes and the members
CLI reached Temporal only through an nginx mTLS terminator
(`ssl_verify_client on`) in front of the development server, used a non-default
namespace, and completed Pi and Codex fixture turns through `/v1` and a CLI
turn. Every accepted session presented the configured SNI and client
certificate, and no member workflow appeared in `default`. A gateway without
TLS settings or with a wrong server name exited with status 1, as did a worker
with a missing namespace. `npm run test:temporal:tls` repeats this in CI with a
separate Node TLS terminator, which also refuses a handshake without a client
certificate; it needs Docker, OpenSSL, Node 22.23.3 and the pinned Temporal CLI
1.10.0. **Unverified:** a real Temporal 1.32
frontend with server-side mTLS, its authorizer or claim mapper, and certificate
rotation.

`BIRBCREW_DATABASE_URL` reaches node-postgres 8.23.1 unchanged in every process,
including SDK child processes. **Verified:** with PostgreSQL accepting only
`hostssl` TCP connections, `sslmode=verify-full&sslrootcert=<CA path>` worked for
the gateway, worker and CLI, and a plaintext connection was refused.

## Storage

| Path | Mount | Requirements |
| --- | --- | --- |
| `/var/lib/birbcrew/native` | Persistent volume, worker only | Writable by uid 10001. The worker creates `.birbcrew-volume` identity files, at the root for Claude and under `codex/` for Codex. Those profiles are registered to that identity, so a replacement worker must mount the same volume. Pi context lives in PostgreSQL. |
| `/tmp` | tmpfs | Writable, exec allowed, mode `1777`. |
| `/etc/crew/...` | Read-only secrets | Gateway configuration and Temporal TLS files, readable by uid 10001. |
| Attestation directory | Private writable volume | See below. Must not be under `/app`. |

Keep the state directory at the same absolute path for the life of the
installation. Codex records absolute session paths and the worker validates
them; [quiesced recovery](coordinated-recovery.md) restores the tree at the same
logical path. **Verified:** a replacement worker container with the same volume
recalled an earlier Pi conversation, and a Codex fixture turn wrote its session
to this volume.

`/tmp` needs exec and the sticky bit because the Temporal worker bundles its
workflow code at startup with `@swc/core`, which unpacks its native addon under
`$HOME/.cache` and refuses a parent directory that other users can replace.
**Verified:** with `/tmp` mode `0777` or `noexec` the worker cannot start;
`1777` with exec works. In Kubernetes use `emptyDir: {medium: Memory}`, which
is a tmpfs with mode `1777`; a disk-backed `emptyDir` is `0777` and is expected
to fail (**unverified** on a cluster).

## Database role

Each gateway, worker and CLI process calls `MemberStore.migrate()` at startup
with the `BIRBCREW_DATABASE_URL` role. That role runs the `birbcrew_ts`
migrations, under an advisory lock, and owns the schema it creates. Give Crew
its own database and role, separate from Temporal persistence.

The role needs `CONNECT`, `CREATE` and `TEMPORARY` on the database:

```sql
CREATE ROLE crew_service LOGIN PASSWORD '...';
CREATE DATABASE crew;
REVOKE ALL ON DATABASE crew FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crew TO crew_service;
```

**Verified** with PostgreSQL 17.6 and a role without superuser, `CREATEDB` or
`CREATEROLE`: the first start created `birbcrew_ts` owned by `crew_service`.
With only `CONNECT` and `CREATE`, the first start failed with
`permission denied to create temporary tables` and created nothing (migration
006 uses `pg_temp` functions); after `GRANT TEMPORARY` it applied all 20
migrations. `CREATE SCHEMA IF NOT EXISTS` checks database `CREATE` even after
the schema exists, so a role with only `CONNECT` cannot start. The current code
therefore cannot run with separate migration and runtime roles.

## Provider accounts

Claude is not covered here. The worker loads profiles from
`src/service/providers.ts` as described in [member profiles](member-profiles.md).

Attestation files are checked on every turn. Each must be a regular file of at
most 16 KiB, owned by the worker's uid (10001), with no group or other
permission bits, outside `/app`, and with `checked_at` from the past 12 hours.
Kubernetes Secret volumes present files owned by root, so copy the attestation
into a private volume owned by 10001 and renew it before it expires
(**unverified** on a cluster).

- **Pi (OpenCode Go):** set `BIRBCREW_PI_ATTESTATION` to the attestation path
  and `OPENCODE_GO_API_KEY` to the eligible key. Profiles:
  `pi-go-glm-5.3-flash.v1`, `.approval.v1`, `.next-step.v1` and `.crew.v1`.
- **Codex (ChatGPT subscription):** set `BIRBCREW_CODEX_ATTESTATION` with
  provider `chatgpt-subscription` and `BIRBCREW_CODEX_AUTH_HOME` to an absolute
  directory holding a Codex CLI ChatGPT login. Each turn starts the bundled
  `codex app-server` with that directory as `CODEX_HOME` and reads the current
  access token without refreshing it. Without `BIRBCREW_CODEX_AUTH_HOME` the
  worker falls back to `CODEX_HOME`, then `$HOME/.codex`, which is the tmpfs
  `/tmp/.codex` in this image, so set it explicitly. Keep the login current with the Codex
  CLI against the same directory. How that refresh runs in the cluster is
  **unverified**.

## Kernel

Codex members run through the native launcher, which requires Linux Landlock
ABI 4 or newer and exits with status 126 otherwise (`native/member-launch.c`).
Claude needs ABI 3. Pi does not use the launcher. Landlock ABI 4 shipped in
Linux 6.7; the node must also list `landlock` in `/sys/kernel/security/lsm`, and
the container seccomp profile must allow the `landlock_*` syscalls.

**Verified:** on kernel 6.8.0 with `landlock` enabled, Docker's default seccomp
profile, `--cap-drop ALL` and `no-new-privileges`, the Codex fixture approval
turn ran through the launcher. **Unverified:** the k3s node's LSM list and
containerd's `RuntimeDefault` seccomp profile.

## Health

The gateway listens on loopback only, so kubelet `httpGet` and `tcpSocket`
probes, which target the pod IP, cannot reach it. There is no unauthenticated
health route. **Verified:** a gateway that cannot open its Temporal connection
and a worker whose namespace is missing exit with status 1, so the restart
policy handles those failed starts.

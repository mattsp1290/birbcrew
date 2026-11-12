# Quiesced installation recovery (v1)

This is an operator-controlled **stop-the-world** recovery protocol, not live
snapshots, arbitrary-clone detection, or exactly-once external effects after
restoring old state. It deliberately holds the entire installation until the
operator has reconciled possible effects and lost acknowledgements.

## State inventory: one generation, not one database

Keep all of the following at the same quiesced boundary:

| Artifact | Required contents |
| --- | --- |
| `application-postgres` | Entire Crew application database: schema/version table, members/profiles, volume identities and account digests, conversation mappings, native checkpoints, admissions/turns, effect and delivery receipts, decisions, observation snapshots/events/cursors, append-only audit events, trusted sessions/generations and historical receipt authority, and recovery control row. |
| `native-volumes` | Full private Claude and Codex native session trees, SQLite indexes and sidecars (after teardown), rollout/transcript bytes, identity markers, and any consumer-owned native stores. A checkpoint digest is not the underlying file. Pi context normally lives in application checkpoints. |
| `temporal-persistence` | Supported consistent backup of the actual self-hosted Temporal persistence, visibility and required cluster/configuration state. Include all relevant stores in one opaque archive or provider snapshot export. A workflow-history export is insufficient to recreate the service's execution identities, queues and cluster persistence. |
| `configuration` | Non-secret deployment configuration, application commit, lockfile, image/package/native pins, profile identities, models/tool schemas, logical native mount paths, PostgreSQL/Temporal server versions and store layout. |
| `consumer-state` | Optional only if no consumer-owned durable records exist. Otherwise include consumer receipts/policy/records at the same boundary via the hooks. |

The public manifest contains artifact basenames, sizes and SHA-256 checksums,
compatibility pins, generation/installation/instance IDs, aggregate table counts,
and the policy `hold-until-reconciled`. It does **not** contain prompts, native
contents, endpoint URLs, credential headers, secrets, or the database connection
string. Artifacts themselves are private and may contain sensitive application
state: encrypt/access-control them in operator storage. Provision credentials,
private keys, proxy credential helpers and secret configuration separately on the
target. Do not put a secret-bearing environment file in `configuration` or copy an
engine's global authentication file as a recovery mechanism.

A checksum detects corruption, not a maliciously replaced bundle. Keep the
manifest checksum in an independently trusted backup catalog; authenticate and
verify the bundle before invoking restore. Never extract an untrusted archive.

## Operator interface

`src/service/recovery.ts` exports `InstallationRecovery`, `RecoveryPins`,
`RecoveryHooks`, and `readRecoveryManifest`. `src/service/recovery-cli.ts` provides
scheduler-friendly JSON receipts and exit codes. An operator module exports:

```ts
export const operator = {
  recovery: new InstallationRecovery(pool, externalFence),
  pins: {
    applicationCommit: "<exact 40-character commit>",
    lockfileSha256: "<sha256 of package-lock.json>",
    temporal: {
      serverVersion: "<installed server version>",
      persistenceFormat: "<matching documented store/configuration version>",
      mode: "persistent", // 'development-fixture' is not production acceptance
    },
    logicalNativeRoot: "/var/lib/birbcrew/native",
  },
  hooks: {
    async quiesce() {
      // Stop admission at consumer ingress; stop/drain consumers and all worker,
      // supervisor, SDK descendant processes. Await termination, then stop the
      // Temporal server. Throw if teardown or the consumer boundary is uncertain.
    },
    async snapshot(directory) {
      // Run supported PostgreSQL/Temporal backup tools and archive stopped native
      // volumes into this new private directory. Await success and durable output.
      // No live copying, no private Temporal table rewriting. Return exactly one
      // artifact per required kind, with safe basename (no absolute paths).
      return [
        {kind: "application-postgres", file: "application.dump"},
        {kind: "temporal-persistence", file: "temporal.tar"},
        {kind: "native-volumes", file: "native.tar"},
        {kind: "configuration", file: "configuration.tar"},
        // {kind: "consumer-state", file: "consumer.dump"},
      ];
    },
    async reconcile(manifest) {
      // Explicitly verify source isolation, pending/uncertain effects and delivery
      // acknowledgements with external systems/consumer records. Throw if not safe
      // to resume. Never simply return success for an unreconciled restored copy.
    },
  },
  async close() { await pool.end(); },
};
```

This is a contract example, **not** a ready-to-run no-op deployment module. The
hooks are trusted local operator code and must actually perform the indicated
steps. They are deliberately not shell strings, request fields or AG-UI input.
They must not emit secrets in their own logs. Crew neither guesses systemd /
Kubernetes service names nor fabricates database/provider backup success.

```
npm run recovery -- initialize-fence /absolute/operator.ts
npm run recovery -- capture /absolute/operator.ts /private/new-generation-directory
npm run recovery -- verify /absolute/operator.ts /private/generation-directory
npm run recovery -- status /absolute/operator.ts 24
```

Create the destination directory with mode 0700 under a pre-provisioned durable backup root first. `capture` never overwrites
manifest files: interrupted attempts use a fresh destination. The source remains
held after capture; explicitly `resume` it only if it is not being relocated.
`status 24` returns exit 2 if no successful backup exists or the latest completed
backup is older than 24 hours. Commands return exit 1 on failure without printing
raw provider/DB errors. The operator owns scheduling, missed-backup alert delivery,
retention, off-host replication, encryption and RPO/RTO. A local successful capture
is not proof that an off-host copy exists.

## Stable boundary and failure recovery

The authority distinguishes `preparing` from `held`: a crash before database
freeze/teardown cannot authorize transfer to a restored copy. Only completed
capture or explicit `hold-for-restore` seals that transfer permission.

1. Initialize the external authority once for the active installation. Never
   initialize a fresh authority from a restored backup to bypass a source fence.
2. `capture` durably assigns a generation and atomically changes its application
   database to `frozen`, then prepares the external authority. A failed authority
   call leaves the durable generation available for a safe retry.
3. A statement trigger rejects INSERT/UPDATE/DELETE/TRUNCATE on every domain table.
   The transition waits for already admitted writer transactions to commit.
   All supported native admission lanes check the recovery phase, poll it to
   cancel, and retain a shared native lifetime lease. New native launches fail.
4. The operator quiesces external writers and services. Crew additionally waits
   for its instrumented native lifetime leases before snapshotting. Running work
   that cannot finish after the barrier retains its started/pending/uncertain
   record; it is not silently marked successful or replayed. Consumer activity
   outside Crew must be stopped by the consumer hook.
5. Operator snapshots all state, including **stopped** Temporal persistence. The
   manifest pins the schema and version. Capture flushes artifacts and manifest files, fsyncs the bundle directory and its parent,
   and verifies checksums/the fence before recording success. New domain tables without the barrier are
   rejected, so schema upgrades need recovery integration, not implicit coverage.
6. Failed/interrupted maintenance stays held, with no success receipt. Fix the
   failing hook and retry in a new directory. Native teardown and backup hooks
   must be idempotent. If a writer times out during freeze, stop services and retry; never call
   this a snapshot boundary. If authority preparation fails after the database
   freeze, the database stays held and retry uses its durable generation. In-flight external effects may be uncertain.

The protocol assumes trusted database administrators. Runtime roles must not
alter/drop triggers, use replication-role bypass, change recovery control rows,
or create unfenced tables. Keep migration/recovery credentials operator-only;
provision ordinary runtime privileges separately. This is not protection against
a malicious database owner or a process writing native files outside the protocol.

## Source fencing and restore

Use a linearizable external fencing authority shared by source and destination.
`RecoveryFence` makes this explicit. The included `FileRecoveryFence` requires a
private shared POSIX filesystem with atomic mkdir/rename semantics. Its state is
**outside all backup artifacts** and must never be rolled back alongside a
snapshot. Transitions flush both the state file and containing directory before acknowledging ownership. Its crash lock fails closed, without lease timeout/stealing. Only remove
lock debris after independently establishing there is no running controller.
A filesystem copy local to each host is not a shared authority. For a multi-host
installation, supply a real shared authority or enforce operator isolation before
moving state. Independent restored databases cannot discover arbitrary clones.

`RecoveryFence.transfer` returns the authority's epoch: a counter that each
transfer to a new instance raises by one, that a retried transfer returns
unchanged, and that is never lowered or reset. Restored audit event IDs are
ordered by it, and acceptance refuses a fence that returns none. This changes the
interface: a fence implemented before audit IDs existed must add the epoch.
`FileRecoveryFence` keeps it in its state file, where state written without it
starts at 0.

1. Stop/fence the source and keep it held. Disable source service auto-restart and
   ingress, and isolate it from effect destinations when relocating. A backup
   previously followed by source resume cannot be restored while the authority
   is active. For an older generation, stop the source again and call
   `holdForRestore(manifest.generation, hooks)` (or CLI `hold-for-restore`)
   through the operator interface before restore;
   reconcile all changes/effects since that recovery point.
2. Verify the complete trusted bundle. Use supported database restore tooling into
   an isolated, stopped target; restore every artifact from **one** generation.
   Install matching application/lockfile/schema/Temporal versions, public config,
   profile identities, and separate credentials. Do not auto-migrate during this
   process. Keep the source database frozen and retain the external authority.
3. For a different physical host root, bind-mount the restored native tree at the
   **same logical absolute path** inside the target container. For example,
   `/srv/host-a/birbcrew/native` and `/mnt/host-b/restore/native` both mount at
   `/var/lib/birbcrew/native`. Preserve volume markers, owner IDs and permissions.
   Do not symlink the runtime root or rewrite Codex SQLite indexes: native paths
   and digests are validated. Arbitrary in-process absolute path rewriting is
   unsupported. This protocol relocates storage with a stable mount contract.
4. With services still stopped:

   ```
   npm run recovery -- accept-restore /absolute/target-operator.ts /private/generation <new-instance-uuid>
   ```

   For a retained backup made on A after the installation moved A→B, first
   quiesce B with `hold-for-restore <backup-generation>`, then pass B’s current
   instance UUID as the optional final `accept-restore` argument. The manifest
   remains unchanged: A identifies artifact provenance, while B is the owner that
   must actually be fenced. An active B, stale A identity or second concurrent
   target is rejected.

   This verifies artifacts/pins and the restored database generation, then
   atomically transfers authority to the new instance. Source resume and another
   clone's transfer are rejected. The target remains `restored`, blocking writes
   and native execution. Read-only committed receipt/history queries can work.
   Acceptance also moves the audit event identity to the fence epoch times 2^44.
   Audit events committed after the recovery point are gone from the trail. New
   event IDs are larger than any ID an earlier timeline issued, including an
   earlier restore of this generation, whatever the database clocks say, so an
   audit consumer's saved cursor never skips a new event. This holds while the
   fence's state is never reset, replaced or rolled back, no timeline draws 2^44
   IDs and fewer than 2^19 transfers are made. If the restored identity has already
   reached the epoch's first ID, acceptance fails with a message saying so and the
   installation stays held. See [the audit trail](audit-trail.md) for the details
   and what consumers see.
5. Reconcile effects/decisions first, then explicitly resume:

   ```
   npm run recovery -- resume /absolute/target-operator.ts /private/generation
   ```

   After successful reconciliation and activation, restart matching Temporal
   services/workers **with consumer ingress still disabled**. Let recovery
   reconcile lost native processes and verify the required held/interrupted/
   uncertain outcomes before enabling consumer ingress or accepting old approval
   cards. Activation alone does not reconstruct a process-bound native callback. A failed reconciliation keeps the
   target held. Activation retains its generation in the external authority, so
   interruption between authority activation and database activation is safely
   retryable. Reconciliation hooks must be idempotent. Do not resume a process-bound approval just because its durable
   row survived. Its native process no longer exists; retain a safe hold or use
   the supported cancellation/uncertain recovery procedure for that engine.

An acknowledgement may have been delivered **after** the backup recovery point.
The restored database cannot know that. An external operation ledger/idempotency
key may prove an effect already happened; otherwise retain hold/uncertainty and
ask the consumer/operator to reconcile. Never treat missing restored receipts as
permission to execute the effect again. Backup tooling never resets effect,
decision, delivery, generation or native launch identity rows.

## Temporal responsibilities and qualification

Production uses a persistent self-hosted Temporal deployment with explicit server
image/version, SQL or Cassandra persistence, visibility store and namespace/cluster
configuration. Stop all Temporal writers and use the backing store's supported
consistent backup/restore procedure. See the [Temporal self-hosted guide](https://docs.temporal.io/self-hosted-guide).
Do not query or rewrite private Temporal tables or substitute exported workflow
histories for a persistence backup. Crew validates the operator's declared
pins and artifact checksums; the operator owns the service/store restore itself.

The existing proxy restart proof uses Temporal CLI 1.10.0 development SQLite
persistence. That is **development fixture evidence only**, not support for using
`start-dev` as production persistence, nor an in-flight multi-store restore proof.

## Reproduce checks

Use Node 22.23.3 and disposable PostgreSQL 17, with permission to create/drop test
databases. `BIRBCREW_PG_BIN` may name the directory containing matching `pg_dump`
and `pg_restore`, or `BIRBCREW_RECOVERY_POSTGRES_CONTAINER` may name the PostgreSQL
17 container for `docker exec`. These tools operate only on randomly named test
DBs. Full native coverage additionally needs Docker, Linux Landlock ABI 4+ and the
repository's C build prerequisites.

```
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/disposable
npm run test:recovery
npm run test:recovery:native
# Also needs Temporal CLI 1.10.0 on PATH (or TEMPORAL_CLI):
npm run test:recovery:coordinated
```

The database suite exercises actual dump/restore to a second database, preserved
conversation/checkpoint/observation state, completed replay and held pending work,
write/native fences, interrupted capture, checksums, version mismatch and source /
clone overlap, and that audit event IDs are never reissued, even when one generation
is restored twice and the first target drew its whole ID range, and that a restore
whose identity already reaches its fence epoch is refused. The native fixture archives stopped Claude/Codex/Pi session state,
restores it under a different host root mounted at `/native`, and performs actual
SDK follow-ups with fresh synthetic proxy credentials. It makes no live requests.
The coordinated proof additionally backs up and restores one actual generation
across PostgreSQL, stopped Temporal development SQLite, and native archives into
a second isolated service. It checks all three engines’ completed replay, native
recall and committed observations. Claude/Pi durable paused decisions remain
cancellable without effects. Codex live process-bound decisions are not resumed:
the required safe outcome is an interrupted callback, uncertain turn, no pending
actionable card, rejection of the stale approval and no effects. This follows the
existing `reconcileTurn`/`interruptLiveLocked` contract, rather than claiming
that a process-bound pending decision was recovered. This is not persistent production Temporal
installation disaster-recovery certification. Qualify the deployment's real
backup hooks, Temporal backend, consumer state and all engine pending-decision
outcomes before declaring production acceptance. Keep the Beans request open
until that deployment-specific evidence exists.

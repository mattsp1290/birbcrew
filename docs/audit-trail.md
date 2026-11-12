# Append-only audit trail

Crew stores approval decisions, admissions, cancellation intents and committed
results, but those rows say what the state is, not who changed it or when. The
public AG-UI tail keeps only the last 256 events per conversation. Migration 21
adds a durable record of each action, readable and exportable by its owner
through `GET /v1/audit`.

## Contract

Each row in `birbcrew_ts.audit_events` records one fact:

- `event_id`: a database identity that increases with every row. It is the only
  ordering and pagination key. IDs are shared by all owners and are not
  contiguous. Gaps reflect other owners' events, rolled-back writes and suppressed
  duplicates.
- `owner_id`: the tenant whose state changed. A foreign key binds the member, and
  the conversation when present, to that owner.
- `occurred_at`: the database clock (`clock_timestamp()`) when the row was
  inserted, inside the state change's transaction. It is not the commit time.
- `actor_kind`/`actor_id`: who performed the action. Today this is `owner` (with
  the owner ID) or `system` (with no ID) for work Crew carries out itself.
- `initiator_kind`/`initiator_id`: what started the request the action belongs to.
  Today this is always recorded as the owner. A named CHECK constraint
  (`audit_events_initiator_check`) allows only that. Scheduled routines, member
  handoff or standing approvals must widen it in their own migration. No operator
  or application kind exists yet. Operator CLI commands (`npm run members`) act as
  the owner they name, and trusted-context effects are attributed to the owning
  tenant.
- `event_type`, `member_id`, `conversation_id`, `request_id` and a small
  `payload` object.

The audit row is written in the **same transaction** as the change it records, so
a rolled-back change leaves no row and a committed change cannot lack one. Every
event type has a natural key: a partial unique index, which the insert names as
its `ON CONFLICT` target. Temporal activity retries, replayed idempotent requests,
concurrent duplicates and repeated cancellation deliveries append nothing new. Any
other conflict, such as a duplicate primary key, still fails the transaction. A
database trigger rejects every `UPDATE`, `DELETE` and `TRUNCATE` on the table,
including zero-row statements.

Payloads contain identifiers, SHA-256 digests, choices and statuses only. They
never contain prompt or reply text, tool arguments or results, notes, tokens or
credentials. `src/service/audit.ts` validates each payload against a strict schema
before insert, so extra fields are refused. The prompt digest is the hex SHA-256 of
the exact UTF-8 text, the same digest that admission already stores. The argument
digest is the one shown on the public approval card.

## Event types

The registry is the `auditEvents` object in `src/service/audit.ts`.
`audit_events_type_check` in `src/service/sql/021-audit.sql` lists the same types.
A test checks that the two lists match. `GET /v1/capabilities` lists them under
`audit.eventTypes`.

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `member.spawned` | owner | `spawn` inserts a member | member | `spawnRequestId`, `engine`, `profile` |
| `conversation.opened` | owner | `openConversation` inserts a conversation | conversation | `{}` |
| `request.accepted` | owner | `recordAcceptance` commits the durable admission | conversation + request | `promptDigest` |
| `approval.decided` | owner | `decideLocked` stores a choice: Claude/Pi cards, Pi child cards and Codex live calls | `approvalId` | `approvalId`, `invocationId`, `toolName`, `argumentDigest`, `choice` |
| `work_item.committed` | system | `settleLocked` inserts the work-item receipt, including Codex live dispatch | `receiptId` | `receiptId`, `approvalId` |
| `request.cancellation_requested` | owner | First durable cancellation fact: the v1 intent, or the cancellation marker written by the legacy cancel route | conversation + request | `receiptId` when the v1 intent came first |
| `request.finished` | system | `commitTurn` (`completed`), `rejectAccepted` (`cancelled`/`failed`), `rejectUnstartedAdmission` (`failed`), final `reconcileTurn` or delegation quarantine (`uncertain`) | conversation + request | `status`, optional `reason` |
| `trusted_effect.completed` | system | The trusted-context lane records that an `effect` tool completed | `operationId` | `operationId`, `toolName` |

`approval.decided` names the deciding owner as its actor. Through the gateway, the
owner comes from the bearer token at `POST .../human`. The operator CLI names the
owner directly. `request.finished` statuses match the integration
API statuses. A Claude turn that becomes uncertain and is then recovered to a
pending decision is not finished. The row is written only when reconciliation
closes recovery, or when a later commit completes the request.

## Route

`GET /v1/audit` requires the bearer token like every other route. The owner comes
only from that token. Rows of other owners are never returned. A `conversationId`
filter for another owner's conversation returns an empty page, not `404`.

| Parameter | Meaning |
| --- | --- |
| `after` | Return events with a larger `eventId`. Decimal, default `0`. |
| `limit` | Default 100 in both formats. At most 1000 for JSON and 10000 for CSV (the hard row cap). |
| `conversationId` | Only events for this conversation. |
| `format` | `json` (default) or `csv`. |

Query validation is strict. An unknown or repeated parameter, or a malformed or
out-of-range value, returns `400 invalid_input`. Other methods return `405`.

```json
{
  "apiVersion": "1",
  "events": [
    {
      "eventId": "42",
      "occurredAt": "2026-11-12T08:15:30.123456Z",
      "type": "approval.decided",
      "actor": { "kind": "owner", "id": "local" },
      "initiator": { "kind": "owner", "id": "local" },
      "memberId": "UUID", "conversationId": "UUID", "requestId": "UUID",
      "payload": { "approvalId": "UUID", "invocationId": "UUID", "toolName": "record_work_item",
        "argumentDigest": "64 hex", "choice": "approve" }
    }
  ],
  "nextAfter": "42",
  "hasMore": false
}
```

Event IDs are decimal strings because they are 64-bit. Pass `nextAfter` as the
next `after`. It is the last returned ID, or your own `after` for an empty page.
`hasMore` is true when more rows already existed at read time. To tail the trail,
keep the last `nextAfter` and poll.

`format=csv` returns as `text/csv` the same rows that JSON returns for the same
parameters. It uses RFC 4180 quoting and CRLF line endings, with a header row:
`eventId,occurredAt,type,actorKind,actorId,initiatorKind,initiatorId,memberId,conversationId,requestId,payload`.
The payload cell is its JSON. Empty cells are nulls. The `Audit-Next-After` and
`Audit-Has-More` headers carry the cursor. To export more than one page, pass
`limit=10000` and loop on `Audit-Next-After` while `Audit-Has-More` is `true`.
Cells are not escaped for spreadsheet formulas. Owner IDs come from the operator's
gateway configuration.

### Pages never skip a late commit

An identity value is allocated at insert, before commit. A transaction holding a
lower ID can therefore commit after a higher ID is already visible. A reader that
had paged past that higher ID would never see the lower one.

To prevent this, a statement trigger (`audit_events_append_order`) takes a shared
advisory lock before any insert draws its ID. The writer holds that lock until
commit. This applies to every writer, including direct SQL.

A read polls for the same lock exclusively with `pg_try_advisory_xact_lock`. It
gets the lock only when no allocated ID is still uncommitted. It then records the
largest committed ID as a horizon and returns rows only up to it.

A read never queues ahead of writers. It holds the lock for one index lookup,
which is the most it can delay a writer. It can wait for an in-flight state change
to commit. If audited writes overlap continuously for 5 s,
the read fails with `503 retry_same_request`. It never returns a page that a later
commit can fill in behind the cursor.

## Retention, upgrade and recovery

Rows are retained with the database. There is no TTL and no deletion API.
Trusted-context erasure removes content but leaves audit rows, which hold none.
Migration 21 does not backfill history: members, admissions and decisions made
before it have no audit rows. Code without migration 21 writes none either, so run
the migration before any upgraded instance serves traffic, as the gateway and
workers already do.

The table carries the `recovery_write_barrier` trigger, so held installations
refuse audit writes and recovery capture accepts the table. The manifest
inventory counts its rows. `pg_dump`/`pg_restore` keep the rows and the identity
position. Restore creates the append-only trigger after it loads the data, so the
trigger does not interfere and still protects the restored copy. Reads, including
`GET /v1/audit`, work while an installation is held or restored, because they take
only an advisory lock. Like the recovery protocol, this assumes trusted database
administrators. The trigger does not stop a database owner who drops it or uses
replication-role bypass.

Restoring a generation rewinds the trail to that recovery point. New events then
reuse IDs above the restored maximum. A consumer whose cursor is past that point
must treat the restore like any other post-restore reconciliation. Re-read from the
last ID it holds that is at or below the restored maximum, and discard its copies
of later IDs. The response carries no recovery epoch, because recovery state is
never exposed through the gateway.

## Not covered

- The trusted-context lane's own request lifecycle (submit, dispatch, rotation,
  held/release, recovery to uncertain, erasure) is not audited. Only completed
  `effect` tool calls are. Its requests are submitted by the operator's trusted
  application, not through an owner HTTP action. Modelling it needs an application
  initiator, which this migration does not allow yet. Its read-tool calls are not
  audited. An effect whose completion is never recorded has no audit row. This
  happens after process death, a deadline, or erasure before settlement. The
  effect stays `uncertain` in the trusted receipts.
- Operator CLI actions are indistinguishable from the same owner's gateway
  actions.
- Requests admitted by workflow histories older than `bounded-conversations-v1` have
  no durable admission and so no `request.accepted`. The v1 cancel backfill does not
  invent one.
- If a workflow is terminated externally before `reconcileTurn` runs, its started
  turn has no `request.finished` row.
- Reads are not audited: status, snapshots, observation and audit reads.
  Previews, text deltas, native launches and stops, and child launches are not
  audited either.
- Only the first cancellation fact is kept. If the legacy route cancels first, a
  later v1 intent's `receiptId` is not added to the trail. The request status still
  returns that receipt.

## Validation

Use Node 22.23.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump`/`pg_restore`, or
set `BIRBCREW_RECOVERY_POSTGRES_CONTAINER`.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:audit
npm run test:api
node --test tests/service/store.test.ts tests/service/rollover-client.test.ts
npm run test:recovery
node --test tests/service/approvals.test.ts tests/service/codex-calls.test.ts \
  tests/service/trusted-context.test.ts tests/service/codex-registration.test.ts
```

`audit.test.ts` runs against real PostgreSQL. Through the HTTP gateway and
`GET /v1/audit` it checks:

- the rows that appear after each action (spawn, open, submit, decision,
  work-item effect, completion, cancellation, rejection), with actor and
  initiator;
- that prompts, notes, replies and tokens are absent from JSON and CSV;
- owner isolation, including conversation filters;
- keyset paging, CSV/JSON row equivalence and quoting, and query validation;
- a reader that waits for a late commit instead of skipping it, while other
  writers proceed.

By direct SQL it checks:

- one row per fact across concurrent duplicates, retries and replays, including
  reconciliation and quarantine;
- rejection of `UPDATE`, `DELETE` and `TRUNCATE`, unknown types, other
  initiators, misattributed conversations, null natural keys and extra payload
  fields;
- that the TypeScript and SQL registries match.

Run the suites one after another, as above. Gateway-starting suites
(`audit.test.ts`, `integration-api.test.ts`) each run the background cancellation
flush. Run concurrently against one database, they can deliver each other's
pending intents.

`trusted-context.test.ts` checks the single `trusted_effect.completed` row for a
replayed effect. The recovery suite restores a real `pg_dump` archive and compares the audit rows.
It confirms the restored copy stays append-only and readable while held, and that
new IDs continue past the restored ones.

Not claimed: these suites call the store, approval and child-store functions the
way Temporal activities do. They do not run a Temporal worker or native SDK. The
Temporal service proofs (`npm run test:api:service`, `scripts/verify-members`) do
not assert audit rows. Codex live answers and dispatch share the audited
`decideLocked`/`settleLocked` paths, but no test drives them through `answerLive`
or `settleLive` and then reads the trail.

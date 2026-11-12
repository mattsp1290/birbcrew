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
  contiguous. Gaps reflect other owners' events, rolled-back writes, suppressed
  duplicates and the jump at each restore (see below).
- `owner_id`: the tenant whose state changed. A foreign key binds the member to
  that owner. When a conversation is present, a row trigger
  (`audit_events_conversation_binding`) looks it up as the row is inserted and
  refuses the row with `23503` unless it finds the conversation with that owner
  and member. A conversation the lookup cannot see is refused even if it commits
  before the insert ends: one not yet committed when the trigger runs, or, under
  REPEATABLE READ, one committed after the transaction's snapshot. A conversation
  the trigger finds keeps its owner and member until commit, because the binding
  columns are immutable and a foreign key stops the conversation from being
  deleted. So every committed row names a conversation of its own owner and
  member, whoever wrote it, including direct SQL, unless an administrator disables
  the triggers. Crew's writers append after creating or reading the conversation
  in the same transaction.
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
digest is the one shown on the public approval card: a SHA-256 over the tool name,
operation ID and note.

Both digests are unsalted fingerprints of the text, not secrets. Anyone holding an
export can confirm a guess, and can recover short or predictable text ("yes", "run
the tests", a templated prompt) by trying candidates. Identical text has the same
digest for every owner, so pooled exports link those requests across owners. Treat
an exported trail with the same care as the prompts and notes themselves. A later
audit version may switch to a keyed per-owner digest.

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

Spreadsheets run a cell that starts with `=`, `+`, `-`, `@`, tab or carriage return
as a formula. Owner IDs are free text from the operator's gateway configuration and
appear in the `actorId` and `initiatorId` cells. Any cell that starts with one of
those characters, or with `'`, is written with one extra leading `'`, the usual
mitigation, so a spreadsheet shows it as text. The file stays plain RFC 4180. A
program reading the CSV recovers each exact value by removing one leading `'` from
any cell that starts with it. No other column can start with these characters.
JSON responses are not changed.

### Pages never skip a late commit

An identity value is allocated at insert, before commit. A transaction holding a
lower ID can therefore commit after a higher ID is already visible. A reader that
had paged past that higher ID would never see the lower one.

To prevent this, a statement trigger (`audit_events_append_order`) takes a shared
advisory lock before any insert draws its ID. The writer holds that lock until
commit. This applies to every writer, including direct SQL. The identity is
declared `CACHE 1`, because the argument needs IDs drawn in order and a session's
cached IDs would not be.

A read polls for the same lock exclusively with `pg_try_advisory_xact_lock`. It
gets the lock only when no allocated ID is still uncommitted. It then records the
largest committed ID as a horizon and returns rows only up to it.

A read never queues ahead of writers. It holds the lock for one index lookup,
which is the most it can delay a writer. It can wait for an in-flight state change
to commit, polling with a backoff that grows from 10 ms to 200 ms (about 30
attempts). If it cannot get the lock within 5 s, it answers `503` with
`{"error":"audit_unsettled"}` and `Retry-After: 1`. Retry the same read. Nothing was
skipped. It never returns a page that a later commit can fill in behind the cursor.

The lock is shared by all owners. Every audited transaction in Crew appends its row
as its last step, then runs only database statements and commits. None waits for the
application, Temporal or a native turn after appending. A read therefore waits out
its 5 s window only while audited writes overlap continuously, or while a writer
process has stalled between its insert and its commit: frozen, paused, or cut off
from the database. Until PostgreSQL ends that session, every owner's read answers
`audit_unsettled`. PostgreSQL notices a vanished client only through TCP keepalives,
so set the server's `tcp_keepalives_idle`, `tcp_keepalives_interval` and
`tcp_keepalives_count` well below the usual two-hour system default. A frozen process
whose host still answers keepalives holds the lock until it resumes or is killed. Do
not set `idle_in_transaction_session_timeout` for the application role. Native
admission keeps a transaction open for a whole native turn by design, and the timeout
would end it.

## Retention, upgrade and recovery

Rows are retained with the database. There is no TTL and no deletion API.
Trusted-context erasure removes content but leaves audit rows, which hold none.
Migration 21 does not backfill history: members, admissions and decisions made
before it have no audit rows. Code without migration 21 writes none either, so run
the migration before any upgraded instance serves traffic, as the gateway and
workers already do.

Migration 21 creates the table and only references existing ones. Its foreign keys
take `SHARE ROW EXCLUSIVE` and `ACCESS SHARE` on `members` and `conversations` until
the migration commits. Of Crew's own statements, only writes to those two tables
conflict: the inserts of a spawn or a conversation open. The migration waits for
those in flight, and new ones wait for the migration. Reads, row locks and the
transaction a running native turn holds do not conflict, so a live upgrade does not
stall conversation traffic. Like migrations 014 and 017, which also reference
`conversations`, it sets no `lock_timeout`. No conflicting holder waits for anything
that queues behind the migration, so every wait ends. Spawns and opens are short,
except that an open with project-note capture configured runs its `git` and `bn`
commands, each limited to 10 s, before it commits.

The table carries the `recovery_write_barrier` trigger, so held installations
refuse audit writes and recovery capture accepts the table. The manifest
inventory counts its rows. `pg_dump`/`pg_restore` keep the rows and the identity
position. Restore creates the append-only trigger after it loads the data, so the
trigger does not interfere and still protects the restored copy. Reads, including
`GET /v1/audit`, work while an installation is held or restored, because they take
only an advisory lock. Like the recovery protocol, this assumes trusted database
administrators. The trigger does not stop a database owner who drops it or uses
replication-role bypass.

Restoring a generation rewinds the trail to that recovery point. Events committed
after it on the previous timeline are gone from the trail, along with the state
changes they recorded. The dump saves the identity's position, so on its own the
restored identity would reissue IDs that the previous timeline had already handed
out, and a consumer whose cursor had passed them would skip the new events. A
fixed jump from the restored maximum would not help when one generation is
restored to two targets in turn: both would jump to the same place. A jump to the
database clock would depend on every target's clock running ahead of every
earlier one's.

Accepting the restore (`npm run recovery -- accept-restore`) therefore moves the
identity to `epoch × 2^44`. The epoch comes from the recovery fence, which is
never restored: each transfer of authority to a new instance raises it by one, and
a retried acceptance gets the same epoch and sets the same value again. Timeline
`e` draws its IDs from `e × 2^44` up to `(e + 1) × 2^44 - 1`. The original
timeline, before any restore, is epoch 0 and starts at 1. Every restored timeline
therefore starts above every ID an earlier timeline drew, whichever target or
generation it came from, whatever the database clocks say. This holds while:

- the fence's state is never reset, replaced or rolled back;
- no timeline draws 2^44 IDs (about 1.8 × 10^13);
- the installation makes fewer than 2^19 (524,288) transfers, so the last range
  ends at 2^63 - 1, the largest `bigint`.

Acceptance refuses the restore when the restored identity has already drawn an
ID at or past the new epoch's first ID, or when the epoch reaches 2^19. Either
means a condition above was broken. The command fails with a message naming the ID
and the epoch. Neither the source nor the target can resume then: the fence has
moved to the target, whose database is still held. Find out how the fence lost its
state before going further. A reset fence is caught only when its new epoch does
not pass the restored identity, so never reset it.

Across a restore, a consumer sees this:

- Its saved `after` cursor stays valid and never skips a new event.
- Events it holds with IDs above the restored maximum no longer exist, and no page
  returns them. Once the operator reports a restore, a consumer that keeps copies
  should re-read from an earlier cursor and drop the copies the trail no longer
  returns.
- IDs jump to a multiple of 2^44 (17592186044416). They have 14 digits after the
  first restore and at most 19. From the 512th restore on they are at least 2^53,
  more than a JavaScript number or a double holds exactly. Keep them as strings,
  and compare them as 64-bit integers: as strings, IDs of different lengths sort
  wrongly.

The response does not carry the epoch, because recovery state is never exposed
through the gateway.

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
  writers proceed;
- a writer left open past the read window: `503 audit_unsettled` with
  `Retry-After`, after about 30 polls.

By direct SQL it checks:

- one row per fact across concurrent duplicates, retries and replays, including
  reconciliation and quarantine;
- that appending a sample of every registered type twice leaves one row each,
  so every `ON CONFLICT` key matches its index;
- that a Claude turn handed to recovery records no `request.finished` until its
  recovered decision commits, and then only `completed`. The native session
  restore is replaced by a given proposal;
- rejection of `UPDATE`, `DELETE` and `TRUNCATE`, unknown types, other
  initiators, conversations of another owner or member, null natural keys and
  extra payload fields;
- rejection of a conversation that another owner commits after the binding
  trigger looked for it but before the foreign key check. A test-only trigger,
  rolled back afterwards, holds the insert on an advisory lock until that commit;
- spreadsheet formula prefixes in CSV cells, and that a plain RFC 4180 reader
  recovers the exact values;
- migration 21 on a version-20 database with members and conversations: the locks
  it takes on existing tables, and that it completes while a native turn holds its
  admission and that turn still writes to its conversation;
- that the TypeScript and SQL registries match.

Run the suites one after another, as above. Gateway-starting suites
(`audit.test.ts`, `integration-api.test.ts`) each run the background cancellation
flush. Run concurrently against one database, they can deliver each other's
pending intents.

`trusted-context.test.ts` checks the single `trusted_effect.completed` row for a
replayed effect. The recovery suite restores a real `pg_dump` archive and compares the audit rows.
It confirms the restored copy stays append-only and readable while held. Another
test lets the source run past the recovery point, restores the generation, lets
the target draw its whole range of 2^44 IDs, then restores the same generation
again. The second target's IDs pass all of the first one's, which a clock-based
jump would allow only if that target's clock were about 203 days ahead. A saved
cursor returns each new event, every transfer raises the epoch by one, a retried
acceptance does not, and each target starts at its epoch times 2^44. A third test
refuses a restore whose identity already reaches its epoch and leaves it held.

Not claimed: these suites call the store, approval and child-store functions the
way Temporal activities do. They do not run a Temporal worker or native SDK. The
Temporal service proofs (`npm run test:api:service`, `scripts/verify-members`) do
not assert audit rows. Codex live answers and dispatch share the audited
`decideLocked`/`settleLocked` paths, but no test drives them through `answerLive`
or `settleLive` and then reads the trail. A trusted effect whose conversation has
vanished fails rather than commit without its row, but the foreign key from
trusted sessions makes that unreachable, so no test drives it.

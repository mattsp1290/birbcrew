# Bounded durable conversations

This change implements `birbcrew-r-qjvc`. It is the existing member-service lane,
not a new Temporal wrapper for the trusted-context API.

## Contract

New conversations retain their logical member/conversation IDs for at most 128
application turns. Each Temporal execution admits at most 4 distinct request IDs,
then drains accepted work, Update handlers, approvals and child workflows before
Continue-As-New. The same drain begins at 2,000 history events or Temporal's
Continue-As-New recommendation, even with fewer distinct turns. This event
threshold is a soft drain trigger, not a hard bound while a human decision or
in-flight handler still needs to finish; pending work is never abandoned merely
to force a rollover. New requests at a full generation receive a typed rejection;
the client retries that rejection against the logical workflow ID for up to 30s.
A busy response is not acceptance. Arbitrary network errors are not retried as
new work. Native checkpoint identity is retained across generations.

Admission is separately durably recorded before `accept()` acknowledges. Exact
request IDs bind a SHA-256 prompt digest; changed duplicates conflict. Earlier
committed requests return their stored result without provider/tool execution.
If an earlier request cancels or fails, already-accepted queued successors are
recorded as `rejected` with `predecessor_cancelled` or `predecessor_failed`, before
the execution closes. They cannot later start. If storage is unavailable, an
accepted-but-unsettled receipt remains visible; it is not evidence that retrying
the effect is safe.

`GET /conversations/:conversationId/requests/:requestId` reads tenant-scoped
status directly from PostgreSQL: accepted, started, committed, uncertain or
rejected. Committed status includes the stored reply; rejected status includes
the reason. It does not route to a historical Temporal run. Decisions and
cancellation also address the logical workflow ID; first-turn `workflow_run_id`
is audit evidence only. Pending work never transfers across a rollover boundary:
rollover waits for it, including human decisions.

## Migration and retention

Migration 16 preserves existing proof conversations' four-turn limit; it does
not resurrect previously completed/failed workflows. Only newly created
conversations receive the 128-turn budget. Patched workflow code preserves old
captured history behavior. Migration 17 backfills request admissions for existing
turns without inventing prompt text or native state.

Keep request admission identities, prompt digests, terminal turn results and
side-effect receipts for the lifetime of the logical conversation, including
closed conversations. There is no automatic TTL or reuse of expired request IDs.
The count is bounded per conversation, not globally across all user-created
conversations. PostgreSQL receipts are authoritative even after Temporal's
history retention expires. An operator must not purge them independently and
then reuse the conversation ID. A future coordinated retention/erasure API must
retain a denial tombstone or permanently retire that identity.

Public AG-UI snapshots preserve final messages across generations; the event
tail remains 256 events and an expired cursor requires a new snapshot. Native
context and model budgets are separate: see [native bounds](native-conversation-bounds.md).
No native summarization, cross-engine conversion or unlimited retention is added.

## Reproduce

Requires Linux with Landlock ABI 4+, Node 22.23.3, a C compiler, Docker and Temporal
CLI 1.10.0 on PATH (or `TEMPORAL_CLI` pointing at it). No paid inference or personal
credentials are required. Tests use disposable local fixture credentials.

```sh
npm ci
npm run build
node --test tests/service/native-limits.test.ts tests/service/rollover-client.test.ts
npm run test:proxy
npm run test:rollover
```

The rollover proof creates disposable PostgreSQL/Temporal services, runs twelve
turns through each real pinned SDK, kills/restarts the worker on both sides of a
rollover, verifies duplicate replay and AG-UI history, and replays captured
Temporal histories in a network-isolated child with no activity implementations.
It also tests fourth-turn decisions/cancellation and accepted queue rejection.
Use `BIRBCREW_TEST_DATABASE_URL` with a disposable PostgreSQL 17 database to run
`node --test tests/service/store.test.ts` separately.

Live model token windows, paid spend, forced native compaction, arbitrary
in-flight side-effect recovery and worker-container replacement are not implied
by this fixture. Codex live approval callbacks are not resumable after native
process loss; that remains an explicit uncertain outcome, not an automatic retry.

### History-pressure drain boundary

New workflow generations also stop admitting updates when the history reaches
2,000 events or Temporal recommends Continue-As-New, even if fewer than four
unique turns arrived. This prevents repeated duplicate submissions from keeping
an otherwise idle generation alive indefinitely. Known completed requests remain
readable from the database without addressing Temporal. Other submissions receive
`RolloverInProgress`; the client retries for at most 30 seconds, then returns busy
without claiming acceptance.

The event threshold is a **drain trigger, not a hard history-size guarantee**.
Pending human decisions, active SDK work, child workflows and already-accepted
updates must finish or be cancelled before rollover. Decision and cancellation
handlers remain serviceable past the threshold so they can release that work.
An operator must still rate-limit untrusted traffic and monitor Temporal history
limits: sustained invalid decision/signal traffic while a decision is pending can
grow history. The implementation does not discard or falsely complete accepted
work merely to force a history boundary.

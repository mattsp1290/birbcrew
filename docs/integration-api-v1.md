# Integration API v1: durable handoff, not a distributed transaction

This is the stable consumer-facing HTTP contract. Consumers do not import the
store, native SDKs, or Temporal workflows. Start the normal gateway described in
[member-gateway.md](member-gateway.md); its operator-configured token hash maps to
one owner. All routes below require that bearer token. Never send proxy credentials,
trusted scopes, tool registries, or engine configuration in a turn request.

## Discovery and routes

`GET /v1/capabilities` returns `apiVersion: "1"`, request and cancellation contract
identifiers, proxy protocol versions, conversation/generation limits, trusted-context
transport availability, observation limits, receipt retention semantics, and the
audit contract (event types, page limits, formats). Additive
response fields are compatible; consumers must reject an unsupported major version.
Trusted context is currently an operator-configured local runtime, **not** a public
HTTP context/tool injection endpoint. Capabilities are implementation contracts, not
proof of the operator's provider access or configured profile availability.

| Route | Purpose |
| --- | --- |
| `POST /v1/members` | Existing member creation contract (`requestId`, `engine`, `profile`) |
| `POST /v1/conversations` | Open an owned conversation (`conversationId`, `memberId`) |
| `POST /v1/conversations/{conversationId}/requests` | Submit `{ "requestId": "UUID", "text": "exact input" }` |
| `GET /v1/conversations/{conversationId}/requests/{requestId}` | Reconcile status and original committed result; never invokes inference |
| `POST /v1/conversations/{conversationId}/requests/{requestId}/cancel` | Persist cancellation intent, body `{}` |
| `GET /v1/conversations/{conversationId}` | Current public snapshot |
| `POST /v1/conversations/{conversationId}/events` | Independent, read-only AG-UI observation |
| `POST /v1/conversations/{conversationId}/human` | Existing explicit human-decision contract |
| `GET /v1/audit` | Owner-scoped, append-only audit events; keyset pages as JSON or CSV export |

Authentication is required even for capabilities. Other owners get `404`, not a
confirmation of a request's existence. Versioned request bodies are strict: unknown
fields (including an attempted `ownerId` override) fail `400`.

### Identity and equivalence

The identity is **(authenticated owner, conversation UUID, request UUID)**.
UUIDs are normalized to lowercase. Payload equivalence is exact UTF-8 text equality:
whitespace and Unicode normalization are not changed. The 16 KiB text limit and valid
Unicode rules of the existing input contract apply. Reusing an identity with changed
text returns `409 conflict`; it never creates a second turn.

A consumer with owner-scoped event identities must durably record their mapping to
**both** conversation and request UUID before sending. Use a deterministic UUID
scheme scoped to that application/owner, or generate UUIDs once inside the consumer's
inbound-event/outbox transaction. Retrying the same event in a different conversation
is a different request and can execute twice. Crew does not deduplicate across
conversations or databases.

## Acceptance, lookup, and failures

A successful submit returns `202` with a receipt:

```json
{
  "apiVersion": "1",
  "conversationId": "UUID",
  "requestId": "UUID",
  "acceptance": { "boundary": "sql_admission_and_temporal_queue" },
  "status": "accepted"
}
```

The successful boundary means the admission identity/payload digest is committed in
Crew PostgreSQL and the Temporal workflow owns the queued work. It does **not**
mean native execution started or completed, a tool effect happened, or the consumer
recorded the reply. A request can complete before the submit response arrives; its
receipt then already contains `status: "completed"` and `result: { "text": "..." }`.
Repeated successful submissions preserve identity and eventual result, not a frozen
snapshot of the old status. A previously accepted request rejected because an earlier
turn failed/cancelled is discoverable through GET even though resubmission returns
`409 request_rejected`.

| Status | Meaning |
| --- | --- |
| `accepted` | Durable admission, waiting for execution |
| `running` | A turn has started; not a claim that a native process is currently live |
| `waiting` | A published human decision is unresolved |
| `completed` | Original reply committed; available as `result.text` |
| `cancellation_requested` | Intent recorded, no terminal execution conclusion yet |
| `cancelled` | Accepted queued request rejected due to predecessor cancellation; no turn executed |
| `failed` | Accepted queued request rejected due to predecessor failure or unconfirmed admission in a closed workflow; see `reason` |
| `uncertain` | Existing native execution reconciliation cannot establish a safe final result; do not replay as new work |

`completed` and `uncertain` are never overwritten by a cancellation intent. A native
cancellation can leave an uncertain outcome or a committed cancellation reply; use
the cancellation fields, not an assumption that `completed` means a tool succeeded.

- `400`: invalid input; fix it before submitting.
- `401`: authentication required; no acceptance claim.
- `404`: no owned request currently discoverable. After an ambiguous send this is
  **not** proof it can never appear; retry the same identity/payload.
- `409`: explicit conflict, capacity limit, or rejected request. Inspect the error and
  reconcile that identity. Never silently generate a replacement UUID.
- `503 retry_same_request`, connection loss, timeout: the outcome may be ambiguous.
  GET the same identity, then retry the exact submission if needed. Do not infer a
  rejection from a lost acknowledgement. A validation/explicit rejected submission
  is not reported with an accepted response.

If the SQL admission committed but its activity acknowledgement was lost and retries
were exhausted, a no-turn receipt is reconciled against the logical workflow. The
workflow's guarded cleanup or a subsequent status read records `failed` with
`reason: "admission_unconfirmed"` when that workflow is terminal. It never starts a
replacement workflow or replays effects. Running/continued workflows and any request
with a begun or committed turn are not rejected by this recovery. Status reads may
persist this terminal reconciliation, but never invoke inference. Temporal observation
has a ten-second RPC deadline; failure returns retryable error instead of falsely
asserting the request is still accepted.

Receipts and results are retained with the database, across gateway/client restarts
and supported Continue-As-New rollover. There is no automatic receipt TTL in v1;
operator deletion/restoration of storage has its own recovery contract. Native
checkpoints, credentials, and storage paths are never returned.

## Cancellation is durable intent, not rollback

The cancellation POST commits a deduplicated PostgreSQL intent before returning
`202`. The receipt includes a stable `cancellation.receiptId`, `delivery` (`pending`
or `delivered`), `nativeTermination` (`unconfirmed` or `confirmed`), and
`effects: "not_assessed"`. Gateway background delivery retries intents after process
restart; GET never triggers delivery. Each Temporal delivery RPC has a 10-second
deadline; an ambiguous timeout leaves the intent pending and eligible for retry.
Attempts are ordered by least-recent attempt so permanently unavailable requests
do not starve later intents. The existing cancellation handler is idempotent. Multiple gateway replicas can
attempt delivery, but one SQL intent is retained.

`delivered` means the cancellation handler acknowledged, or the request was already
terminal and needed no delivery. It does not mean the native SDK stopped. Native
termination is confirmed only when a cancellation marker exists and all recorded
native launches for that request are stopped. A completed result remains the winner
even if a cancellation arrives later. Effects may already have committed: v1 does not
claim to undo them or infer their outcome from process exit.

Cancellation is best effort, not preemption of an already committed reply. Queued
cancellation can race the start or completion of work. If the workflow is unavailable,
intent remains pending; operations must restore the service or investigate, not treat
that as confirmed termination. Disconnecting an AG-UI observer only closes observation
and never writes a cancellation intent.

## Consumer transaction and reconciliation algorithm

1. In the consumer's database transaction, insert the inbound event and its unique
   handoff row `(event identity, conversation UUID, request UUID, exact payload)`.
2. A dispatcher reads unacknowledged handoffs and submits them. There is no cross-system
   transaction. If it dies before send, the row is still pending locally.
3. On restart or ambiguous transport failure, GET the recorded identity. If missing,
   resend the identical payload/identity. A lost acceptance reply cannot create a new
   logical turn. Record an observed receipt in a separate local transaction.
4. Poll GET for terminal status. Record the original result durably in the consumer
   database. If this acknowledgement is lost, retrieve the same result again.
5. Treat explicit rejection/uncertainty as an application reconciliation case, not
   permission to repeat effects under a fresh identity.

The maintained fixture commits both rows in its own disposable database, actually SIGKILLs the
consumer before send, after acceptance, and after completion, then recreates the
gateway/consumer and reconciles. Those focused tests use a real PostgreSQL store and
an instrumented transport. The portable service proof additionally exercises the
real Temporal worker/native fixtures and AG-UI observation; neither needs paid inference.

## AG-UI observation

An official `@ag-ui/client` HttpAgent observes `/v1/conversations/{id}/events` with
empty messages, tools, context, state and forwardedProps. Observation is independent
of the consumer's request identities and does not submit work. A new connection
starts from a current messages/state snapshot plus a bounded live tail (256 events).
The optional `?after=` must equal the current snapshot cursor; otherwise the gateway
returns `410 CURSOR_EXPIRED`. A gap during streaming emits `CURSOR_EXPIRED`; reconnect
without the old cursor for a fresh snapshot. Do not promise arbitrary historic token
replay, including across rollover. Committed per-request results use the separate
request lookup above, not the event cursor.

## Audit trail

`GET /v1/audit` returns the authenticated owner's durable record of who acted and
when. It covers member spawn, conversation open, request admission, approval and
question decisions, committed work-item and trusted effects, cancellation requests
and terminal request status. Unlike the AG-UI tail, it is not truncated. Each fact
is written in the same transaction as the change it records, appears once despite
retries, and cannot be updated or deleted.

| Parameter | Meaning |
| --- | --- |
| `after` | Decimal event ID; return later events only. Default `0`. |
| `limit` | Default 100 in both formats. At most 1000 for JSON and 10000 for CSV (the hard row cap). |
| `conversationId` | Restrict to one conversation. Another owner's ID yields an empty page. |
| `format` | `json` (default) or `csv`. |

Unknown, repeated or malformed parameters fail `400`, as strict bodies do. JSON
responses are `{ apiVersion, events, nextAfter, hasMore }`. CSV responses carry the
same rows, with `Audit-Next-After` and `Audit-Has-More` headers. Pass `nextAfter`
as the next `after`. Event IDs are global across owners and not contiguous. Pages
never skip an event that commits late. A read waits for in-flight writes without
delaying them. If writes overlap continuously for 5 s, it returns
`503 retry_same_request`. A restore removes the events after its recovery point,
and new event IDs jump past every earlier ID, so a saved cursor never skips a new
event.
Payloads hold identifiers, digests, choices and statuses only, never prompt or
reply text, tool arguments or credentials. See [the audit trail](audit-trail.md)
for the event registry, field semantics and limits.

## Validation

Use Node 22.23.3 and a disposable PostgreSQL 17 database. The test role needs
CREATEDB so the fixture can create and remove its separate consumer database:

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:api
```

The full portable proof additionally needs Linux Landlock ABI 4+, Docker, a C
compiler, and Temporal CLI 1.10.0:

```sh
npm run test:api:service
```

The fixtures use synthetic credentials and local protocol servers. Record the exact
commit and each command result. Live application/proxy-provider acceptance is separate
and requires existing authorized access and any required spend approval. Do not print
real credentials, publish test tokens, or claim production identity-provider coverage.

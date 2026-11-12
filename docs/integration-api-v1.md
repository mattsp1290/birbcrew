# Integration API v1: durable handoff, not a distributed transaction

This is the stable consumer-facing HTTP contract. Consumers do not import the
store, native SDKs, or Temporal workflows. Start the normal gateway described in
[member-gateway.md](member-gateway.md); its operator-configured token hash maps to
one owner. All routes below require that bearer token. Never send proxy credentials,
trusted scopes, tool registries, or engine configuration in a turn request.

## Discovery and routes

`GET /v1/capabilities` returns `apiVersion: "1"`, request and cancellation contract
identifiers, proxy protocol versions, conversation/generation limits, trusted-context
transport availability, observation limits, health dependencies, listing limits, and
receipt retention semantics. Additive
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
| `GET /v1/health` | Readiness of PostgreSQL and Temporal; `200` ready, `503` not ready |
| `GET /v1/members` | The owner's members, keyset-paginated |
| `GET /v1/conversations` | The owner's conversations with coarse phase, optional `memberId` filter, keyset-paginated |

Authentication is required even for capabilities and health. Other owners get `404`, not a
confirmation of a request's existence. Versioned request bodies are strict: unknown
fields (including an attempted `ownerId` override) fail `400`. Query parameters on the
health and listing routes are strict too: unknown or repeated parameters fail `400`.

## Health and listing

These routes exist only under `/v1`; `/health` and `GET /members` or
`GET /conversations` without the prefix are not served.

`GET /v1/health` takes no parameters. It probes both dependencies concurrently, each
bounded to 2 seconds: a PostgreSQL round trip that reads the highest applied schema
version, and a Temporal frontend `GetSystemInfo` call on the gateway's connection. The
probe never starts, signals or describes a workflow, and a ready Temporal frontend does
not show that workers are polling. It returns `200` when every dependency is ready and
`503` with the same body shape otherwise:

```json
{
  "apiVersion": "1",
  "status": "ready",
  "dependencies": {
    "database": { "status": "ready", "schemaVersion": 20 },
    "temporal": { "status": "ready" }
  }
}
```

The top-level `status` is `ready` or `not_ready`. Each dependency reports `ready` or
`unavailable` (failed or exceeded its bound); `schemaVersion` is `null` when the
database is unavailable. Driver errors, addresses and connection strings are never
returned. The gateway applies its migrations at startup, so compare `schemaVersion`
with the release you deployed.

`GET /v1/members` and `GET /v1/conversations` return only the authenticated owner's
rows:

```json
{ "apiVersion": "1", "members": [{ "memberId": "UUID", "engine": "pi", "profile": "name" }], "next": "opaque" }
```

```json
{
  "apiVersion": "1",
  "conversations": [
    { "conversationId": "UUID", "memberId": "UUID", "engine": "claude", "profile": "name", "phase": "idle" }
  ],
  "next": null
}
```

| Parameter | Routes | Meaning |
| --- | --- | --- |
| `limit` | both | Decimal page size from 1 to 100; default 50 |
| `after` | both | The previous page's `next`, unchanged |
| `memberId` | conversations | Only that member's conversations |

Pages follow a stable ascending identifier order. Neither table records creation time,
so the order is not chronological. `next` is `null` on the last page. Treat it as
opaque: it is bound to its listing, and a malformed, altered or other-listing value
fails `400`. A row that exists throughout pagination appears exactly once; a row
created meanwhile appears only if it sorts after the current position.

`phase` uses the snapshot vocabulary (`idle`, `running`, `waiting`, `complete`,
`cancelled`, `failed`). It is `null` for a conversation that predates the public event
ledger, whose snapshot returns `409 history_unavailable`. Listings never include
messages, prompts or results; read the snapshot or request receipts for those. A
`memberId` that is not the owner's, whether another owner's or nonexistent, returns an
empty `200` page, exactly like an owned member without conversations.

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

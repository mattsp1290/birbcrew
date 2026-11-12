# Usage metering

Crew used to record no token count and no cost, so an owner could not see or bound
what a member consumed, even though routines now run with nobody watching. Migration
31 adds a usage ledger: one row for each native segment, with the token counts the
engine's SDK reported. An owner reads totals for themselves, for each member and for
each conversation, and can give a member a daily token budget. When a member has used
its budget, admission refuses its new requests.

Crew never estimates cost. It keeps a cost only when the provider billed it and the
SDK passed that figure on. Today that can happen only on Pi, with a provider such as
OpenRouter. Claude and Codex segments never have a cost.

## What each engine reports

Crew reads what the pinned SDKs return for a finished segment. These figures come from
the type definitions in `node_modules`, the drivers, and runs against the local
fixture providers (`tests/service/usage-capture.test.ts`).

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| SDK | `@earendil-works/pi-ai` 1.5.2 | `@anthropic-ai/claude-agent-sdk` 0.3.306 (CLI 2.1.306) through the vendored AG-UI adapter 0.0.8 | `@openai/codex-sdk` and CLI 0.167.1 |
| Where Crew sees it | `usage` and `model` on each assistant message the segment added to the session (`pi.ts`) | `result.usage` on the adapter's `RUN_FINISHED` event, and `model` on its `system:init` event (`claude-worker.ts`) | `usage` on the `turn.completed` event (`codex.ts`) |
| Input tokens | `input` + `cacheRead` + `cacheWrite` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `input_tokens`, which already includes cached tokens |
| Cached input | `cacheRead` | `cache_read_input_tokens` | `cached_input_tokens` |
| Cache writes | `cacheWrite` | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| Output tokens | `output` | `output_tokens` | `output_tokens` |
| Reasoning tokens | `reasoning` when the provider reports it | not reported | `reasoning_output_tokens` |
| Model | as the message reports it | as the CLI's `init` message reports it | not reported (null) |
| Cost | `cost.total` only when `cost.totalFromProvider` is true; otherwise pi-ai computed it from its model catalog, and Crew drops it | never: `total_cost_usd` is the SDK's estimate from a price lookup | never: nothing reported |
| Granularity | one model call per assistant message, summed over the segment | the one `query()` call that runs the segment | the native thread's running total |
| A worker replaced mid-segment | the call in flight is lost | the query in flight is lost | the turn in flight is lost |

Two of these needed a correction:

- **Codex reports a running total, not the turn's usage.** The SDK's type comment
  says the usage is "during the turn", but CLI 0.167.1 reports the total for the whole
  native thread, carried across resumed turns. Against a fixture whose calls used 100,
  200 and 300 input tokens, three turns reported 100, 300 and 600. The rollout that the
  Codex checkpoint pins by SHA-256 holds the same total in its last `token_count`
  event. So before a turn, Crew reads that total from the prior rollout, and after the
  turn it records the new total minus the old one. If the prior rollout cannot be read,
  or any count goes down, the segment is `unknown`.
- **A count of zero input means nothing was reported.** pi-ai and the Codex CLI fill
  usage with zeros when a provider sends none. A model call always reads some input, so
  a segment whose input total is zero is recorded as `unknown`, never as zero. Pi's
  fixture (faux messages) and the Codex Responses fixture both report zeros and are
  recorded as `unknown`. Claude's fixture reports 10 input and 10 output tokens per call.

Each Claude segment is a separate `query()` call in a new CLI process. A resumed
session reported only its own query's usage (10 and 10), not the session's. The
`usage` in the result covers the main agent loop. Crew's Claude members have no tools
that start subagents, so the main loop is every call Crew asks for. The SDK's
`modelUsage`, which would also count internal calls, does not reach the adapter's
events.

None of the three keeps usage for work that did not return. If a worker is replaced or
killed mid-segment, the segment's turn becomes `uncertain` and is never run again, so
its tokens are never recorded. A Claude proposal that `recoverPending` rebuilds from
the transcript makes no model call and records nothing, and the call that first
produced it is lost too.

## The ledger

`usage_ledger` has one row for each native launch, keyed by the launch's
`(conversation_id, request_id, token)`. That is the primary key of `native_launches`,
and a foreign key binds the two. The supervisor reserves a launch's generation once,
in a committed transaction, before it starts the SDK process. So:

- A Temporal replay runs no activity, and so starts no launch.
- An activity retry of a turn either replays the committed reply or turns the turn
  `uncertain`. Neither starts a new launch. A resumed segment (after a decision or a
  delegation) gets a new generation, because it is new model work.
- A repeated `start` for a generation that already ran only observes it.
- The insert repeats the launch's execution identity (run, activity, attempt) and does
  nothing on conflict, so a retried write adds no row.

This follows the receipts (`codex_item_receipts`, work-item receipts): the row is keyed
by the identity that already makes the effect happen once.

The supervisor host writes the row after the runner returns a confirmed result and
before it commits that result (the reply, the card, the delegation or the child's
outcome). The model work has happened even if the commit then fails. A segment whose
driver returned no usage gets an `unknown` row, and so does one whose counts the
ledger's CHECKs would refuse: metering never costs a segment its result. A segment that failed, was cancelled
or whose runner died gets no row.

**Per segment, not per request.** Each SDK reports usage per invocation: Pi per
assistant message, Claude per `query()`, Codex per turn. A Crew segment is exactly one
such invocation. A request can span several segments (a proposal, the resumed answer,
Pi children), and some of them may never finish. Summing per request would need the
request to end first. Per-segment rows are written once, as each segment returns.

| Column | Meaning |
| --- | --- |
| `usage_id` | Identity, newest highest |
| `owner_id`, `member_id`, `conversation_id`, `request_id` | Whose segment it was |
| `token`, `child_id` | The launch generation, and the Pi child it ran for, if any |
| `engine` | `pi`, `claude` or `codex` |
| `state` | `reported`, or `unknown` when the SDK reported nothing usable |
| `model` | As the engine reported it, at most 256 bytes; null for Codex |
| `input_tokens`, `output_tokens` | Integers; both set exactly when `state` is `reported` |
| `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens` | Integers when the SDK reports them, else null |
| `cost_usd` | A provider-billed cost, else null |
| `recorded_at` | The database clock when the row was written |

CHECKs keep `unknown` rows free of counts and cost. A statement trigger refuses every
`UPDATE`, `DELETE` and `TRUNCATE`. Like every table, both new tables carry the
recovery write barrier.

## Routes

All routes need the bearer token. The owner comes only from it. Query parameters are
strict: an unknown or repeated parameter, or a malformed value, fails
`400 invalid_input`. `from` and `to` are optional instants such as
`2026-11-12T00:00:00Z`; a row counts when `from <= recorded_at < to`, and `from` must
come before `to`. A `memberId` or `conversationId` the owner does not have fails
`404 not_found`.

| Route | Purpose |
| --- | --- |
| `GET /v1/usage?from=&to=` | The owner's totals, and the part routines started |
| `GET /v1/usage/members?from=&to=&after=&limit=` | Every member of the owner, ordered by `memberId`, with totals and its budget |
| `GET /v1/usage/conversations?from=&to=&memberId=&after=&limit=` | Conversations with at least one row in range, ordered by `conversationId` |
| `GET /v1/usage/records?from=&to=&memberId=&conversationId=&before=&limit=` | Ledger rows, newest first |
| `GET /v1/usage/budgets/{memberId}` | The member's budget and its current window |
| `PUT /v1/usage/budgets/{memberId}` | Set the budget, body `{ "tokenLimit": 500000 }` |
| `DELETE /v1/usage/budgets/{memberId}` | Clear the budget |

Every total has this shape. `totalTokens` is input plus output, the number the budget
counts. `costUsd` is a decimal string summing the reported costs, or null when no row
in the set has one; `costReportedSegments` says how many did.

```json
{
  "segments": 4, "unknownSegments": 1, "inputTokens": 1350, "outputTokens": 135,
  "totalTokens": 1485, "cachedInputTokens": 400, "cacheWriteTokens": 0,
  "reasoningTokens": 10, "costUsd": "0.25", "costReportedSegments": 1
}
```

The summary is `{ apiVersion, from, to, total, routine }`. A member entry is
`{ memberId, engine, total, routine, budget }`, and a conversation entry
`{ conversationId, memberId, total, routine }`. `routine` counts only the segments of
requests whose admission recorded a routine as initiator. A request with no admission
row, from a workflow history older than durable admission, counts as the owner's, as
it does in the audit trail. A member's `budget` is null or
`{ tokenLimit, period, revision, changedAt, windowStart, usedTokens }`.

A record is:

```json
{
  "usageId": "42", "recordedAt": "2026-11-12T08:03:12.421Z", "memberId": "UUID",
  "conversationId": "UUID", "requestId": "UUID", "childId": null, "engine": "claude",
  "state": "reported", "model": "claude-sonnet-4-6", "inputTokens": 10, "outputTokens": 10,
  "cachedInputTokens": 0, "cacheWriteTokens": 0, "reasoningTokens": null, "costUsd": null,
  "initiator": { "kind": "owner" }
}
```

`limit` defaults to 100. It is at most 100 for members and conversations and 1000 for
records. Pass `nextAfter` as the next `after`, or `nextBefore` as the next `before`;
`hasMore` says whether another page exists. `usageId` is a decimal string. IDs are
drawn before a row commits, so a row can commit after a later one. A records page you
have already read past does not gain that row; the totals always include it. A
coordinated restore reissues the IDs drawn after its recovery point to new rows (see
[below](#upgrade-and-recovery)), so a consumer that mirrors records must read the
restored installation's newest `usageId` while it is still held, before it resumes and
draws new IDs, then drop the rows it holds above that ID and read again.

`GET /v1/capabilities` describes the feature under `usage`: the states, the token and
cost rules, what each engine reports, the budget period and refusal code, and that a
restore rewinds the ledger and reissues record IDs.

## Budgets

An owner can give each member one token budget. The window is the current UTC
calendar day of the database clock, from midnight to midnight. A budget counts input
plus output tokens of the member's `reported` rows recorded in the window. Input
includes cache reads and writes, so a long Codex or Claude conversation that rereads
its context counts that context every time. `unknown` rows count nothing. A budget
applies to one member across all its conversations, the owner's requests and its
routines alike. The limit is a whole number from 1 to 10^12.

`PUT` with the limit the budget already has changes nothing and writes no audit row.
Any other `PUT` sets the limit and raises the budget's revision by one. `DELETE`
clears it, and clearing a member without a budget changes nothing. A cleared budget
keeps its row, so revisions keep rising. A database trigger refuses a deleted row, a
changed member and any revision step other than one.

```json
{
  "apiVersion": "1", "memberId": "UUID",
  "budget": { "tokenLimit": 500000, "period": "utc_day", "revision": 1, "changedAt": "2026-11-12T08:03:12.421Z" },
  "window": { "start": "2026-11-12T00:00:00.000Z", "end": "2026-11-13T00:00:00.000Z" },
  "usedTokens": 1234, "remainingTokens": 498766, "admitting": true
}
```

### Admission

When a member's used tokens are at or over its limit, a new request is refused with
`409 usage_limit`. Nothing is admitted: the request has no receipt, and the same
request can be sent again later. The check runs twice:

1. `MemberClient`, before it sends the request to the workflow. This is the check that
   answers in practice. The workflow never sees the request, and the conversation
   stays open.
2. `recordAcceptance`, the admission transaction, after it has locked the
   conversation. This is the enforcing check. It catches usage recorded, or a budget
   set or lowered, between the two checks. Its refusal fails the admission activity
   without retries. Like any refused admission, that closes the conversation to new
   turns, so `MemberClient` reports it as `409 usage_limit_closed`: send the request
   again in a new conversation. A routine firing fails `usage_limit` either way.

The first check reads nothing more for a member without a budget, and leaves a
trusted-context conversation to admission, which refuses it as before.

A request that already has an admission row or a turn is never refused, so a retry
gets the answer it got before. A request already running is never interrupted, and its
usage is recorded when its segments return. Usage arrives only after a segment, so the
budget is a soft cap: every request admitted while the member was under its limit runs
to the end, and the member can end the day above its limit by what those requests use.

A routine firing goes through the same admission. When its member is over budget, the
firing fails with reason `usage_limit`. That counts as a failure, so the tenth
consecutive one disables the routine as the
[scheduled routines](scheduled-routines.md) switch-off does. The firing has already
opened its conversation and started its idle workflow, as every firing does.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `usage.budget_set` | owner | a budget is set or its limit changes | member + revision | `revision`, `tokenLimit`, `period` |
| `usage.budget_cleared` | owner | a budget is cleared | member + revision | `revision` |
| `usage.request_refused` | system | admission refuses a request under the budget | conversation + request | `tokenLimit`, `usedTokens`, `period`, `windowStart`, `budgetRevision`, optional `routineId` |

Refused HTTP calls left no audit row before this. A budget refusal is the first that
does, for three reasons. It is Crew's own decision under a policy the owner set, not a
malformed or unauthenticated call. The owner needs to see it, because a routine stopped
by the budget runs with nobody watching. And it has a natural key: it names a request
identity in a conversation the owner already has, so retrying the same request adds no
row. A client that sends new request IDs in a loop adds one row per ID. The refused
request has no admission, so the row names the owner as initiator, and `routineId`
names the firing that submitted it, as `conversation.opened` does.

## Telemetry

The `model.invoke` span gains `usage.state` and, when the segment reported counts,
`usage.input_tokens` and `usage.output_tokens`. It carries no model name and no cost.

## Upgrade and recovery

Migration 31 creates the two tables and replaces two CHECK constraints NOT VALID:
`audit_events_type_check` (adding the three types) and the routine firings' reason
CHECK, which 025 left unnamed as `routine_firings_check4` and which becomes
`routine_firings_reason_check` (adding the failure reason `usage_limit`). Existing
rows are neither rewritten nor checked. Each replacement repeats the whole predicate,
so `migrate()` now refuses to apply a migration numbered 27 or above whose version is
below one already applied: applied later, it would silently drop what the newer one
allowed. Releases up to 26 shipped migration 22 after 26, so earlier gaps still apply. Until `migrate()` commits it holds `SHARE ROW EXCLUSIVE` on `members` and
`native_launches` for the foreign keys, and `ACCESS EXCLUSIVE` on `audit_events` and
`routine_firings`. As in migration 25, it takes all four with `NOWAIT` and retries, so
it never waits in a lock queue. A running native turn's admission transaction holds
only `ACCESS SHARE` and row share locks, which these modes allow, so a live upgrade
never waits for a turn. After 60 s without the locks it fails with `55P03` and applies
nothing. Turns that started before the upgrade are metered when their segments return.

A coordinated restore rewinds the ledger and the budgets with the rest of the
database, and Crew changes neither when the restored installation resumes:

- **Ledger.** Rows recorded after the recovery point are gone. Those tokens were spent,
  so until the window ends the budget counts less than the member used. Crew cannot
  rebuild them: the native sessions do not hold reliable counts. The provider's own
  bill stays the source of truth. The ledger's identity resumes at the recovery point,
  so new rows get `usageId`s the discarded rows had. Unlike the audit trail, whose
  identity a restore moves past every earlier ID, the ledger keeps no fence epoch.
- **Budgets.** A budget set, changed or cleared after the recovery point returns to its
  earlier state, so a restore can bring back a higher limit or none at all. A standing
  grant restored that way is revoked on resume, because revoking is always safe. A
  budget has no safe value to fall back to: Crew cannot know the newer limit, and
  inventing one could stop work the owner allowed. So it leaves budgets as restored.
  After a restore, check each member's budget with `GET /v1/usage/budgets/{memberId}`
  and set it again.

## Not covered

- Cost for Claude and Codex, and for Pi providers that do not report a billed cost.
  Crew has no price table and never will estimate one.
- The trusted-context lane: its requests are neither metered nor checked against a
  budget.
- Tokens of segments that fail, are cancelled or lose their worker. The budget
  undercounts them.
- Calls the Claude CLI makes outside the main agent loop, if any.
- Budgets per owner, money budgets, other windows, and a warning before the limit.
- A Pi child's own admission: children run under their parent's admitted request, so
  the budget is checked once, for the parent. Their segments are metered.
- Retention or deletion of ledger rows.

## Validation

Use Node 22.23.3 on Linux, a C compiler for `scripts/build-native`, and a disposable
PostgreSQL 17 database whose role may create databases.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
node --test tests/service/usage.test.ts tests/service/usage-capture.test.ts
npm run test:recovery
```

`usage-capture.test.ts` runs the real drivers against the local fixture providers. It
checks that Codex records each turn's share of the running total over three resumed
turns, and `unknown` when the provider sends no usage; that Claude records each query's
own usage for a chat turn, a proposal and its resumed answer; and that Pi records each
call through pi-ai's Chat Completions adapter, including a proposal and its resumed
answer, and `unknown` for the faux fixture. It starts the real supervisor host and
runners, with no Temporal, and checks one ledger row per launch for all three engines,
no second row for a repeated start, and the `model.invoke` attributes. It also checks
the mapping rules: cost kept only when billed, counts that go down or cannot be read.

`usage.test.ts` runs against PostgreSQL. It checks one row per launch, bound to the
launch's execution, the CHECKs on `reported` and `unknown` rows, a refused row kept as
`unknown`, and the append-only ledger; the totals, routine subtotal, pages,
time ranges and strict queries of every route, with another owner seeing nothing and
getting 404 for this owner's IDs; setting, repeating, changing and clearing a budget
and their audit rows; refusal at both checks and through the gateway, one audit row
per refused request, no refusal of an admitted or running request, the soft cap, the
UTC day window, and the mapping of the admission activity's failure; a routine firing
failing `usage_limit` until the routine is disabled; migration 31 on a version-26
database, its locks, no rewrite, NOT VALID CHECKs, a reason CHECK a sibling migration
already renamed, and no wait for a running turn; `migrate()` refusing to apply a
migration below one already applied, while a database that lacks migration 22, as
releases before 27 left some, still upgrades; every firing reason the dispatcher names
being one the reason CHECK allows; and a held installation refusing usage writes.

`recovery.test.ts` (it needs PostgreSQL 17 `pg_dump`, as the other recovery tests do)
restores a real dump taken after a budget and a segment were recorded. It checks that
capture counts both tables, that a held source refuses a budget change, and that after
more usage and a tighter limit on the source the restored installation has the earlier
limit and the earlier total, unchanged by resume, and admits the request the source
refused.

Not run: the service proofs with Temporal. So these are not exercised end to end: a
refusal by the admission activity inside a real workflow (the mapping is tested with a
constructed failure), the workflow closing that conversation, and a gateway's
dispatcher firing a routine on Temporal. A Pi child's segment is recorded by the same
insert with its `childId`, but no test runs a delegation. Real providers were not
called, so the field mappings rest on the SDK types and the fixtures.

# Conversation ownership

## TypeScript members

An owner spawns a member with a fixed engine and execution profile. Each conversation under that member has its own Temporal workflow, native session and PostgreSQL checkpoints. The authenticated gateway submits commands and serves the committed AG-UI event stream to independent observers.

Pi and Claude release the inference worker during a confirmed human wait. Pi can delegate to two child workflows with separate native sessions and one shared write budget. Codex keeps its invocation-scoped MCP call open until the owner responds or the deadline expires. SQL records the decision, effect receipt and confirmation of native delivery separately. On interruption, clients can distinguish a proven zero-effect call from a committed receipt with unknown delivery. See the [gateway contract](member-gateway.md).

### Internal: child targets

A delegated child can carry a target: the engine and registered profile it runs on, stored as `target` in its `pi_children.role_profile` JSON. A child without one runs on its parent's Pi profile, and that is still every child a member can start, because nothing a runner returns sets a target yet. The child workflow schedules its activities on the target's queue, the supervisor runs the target profile's driver, and the child's usage row records that engine under its parent member. The child activity refuses to run on any queue but the one its row names. Replay does not compare task queues, so without that check a workflow worker from before targets would quietly run a targeted child on its parent's queue. Only a registered delegating Pi profile that holds every tool its child gets can be a target: `ChildStore.delegate` refuses any other with a `ChildTargetError`, and the Claude and Codex drivers refuse a child. Depth stays one: a delegation needs the parent turn's token, a child runs its profile's child branch, and the supervisor refuses a delegation from a child launch. `npm run test:child-targets` covers this, including replay of histories recorded with the workflow source from before targets.

## Historical Python proof

One Temporal workflow owns each conversation. Its stable ID derives from the
conversation UUID. Durable Updates accept and deduplicate input, validate human
decisions, and request cancellation. The main workflow loop processes inputs in
order. It never depends on a process-local lock.

A conversation carries a versioned coworker definition, its owner, selected
Beans notes, accepted inputs, agent run attempts, a versioned human request,
resolved decisions, and finalized framework messages. The four-input limit
bounds the proof. Workflow IDs cannot be reused. Continue-As-New, workflow reset,
and replacement are unsupported. A future implementation must preserve accepted
request identities and ordering across those operations before lifting the limit.

## Execution and storage

Pydantic AI's `TemporalDurability` routes model and tool calls into activities.
`AgentEventStream` publishes native events and stays open for the conversation's
entire lifetime. The benign tool inserts a synthetic work item under a unique
operation ID derived from the conversation and accepted request. A retry reads
the existing result. The failpoint waits after commit and before return so the
verifier can kill the worker at that boundary.

`CallDeferred` produces a framework human-input request. The workflow stores its
ID, version, expected principal, and tool-call ID, then waits durably. The HTTP
human endpoint supplies the authenticated principal to a Temporal Update. A
matching repeated decision is a no-op. Another version or conflicting decision
is rejected. The resumed agent receives `DeferredToolResults`.

Application tables live in their own PostgreSQL database. Temporal's development
service uses its own SQLite file. No application code reads Temporal's database.
PostgreSQL stores finalized Pydantic AI messages without converting them back
from client data. It also stores the AG-UI rendering with stable finalized IDs.
Temporary streamed content never replaces that history. The persistence activity
returns canonical message fields through Temporal history, so workflow replay
does not rewrite prior framework timestamps.

## Observation and reconnect

A retryable projection activity consumes the supported Temporal native event
stream and passes it through `AGUIAdapter.transform_stream`. PostgreSQL stores
each projected event under a unique segment and ordinal key. The projector
normalizes generated message IDs and omits optional wall-clock event timestamps
so a retry can finish a partially published stream. The workflow awaits projection before publishing the finalized snapshot.

An AG-UI observation connection starts with `RUN_STARTED`, then sends messages
and state snapshots. Internal agent segments appear as standard AG-UI steps.
The observation endpoint never submits a prompt. Two SDK clients can observe it
independently. A disconnect closes that HTTP stream without cancelling work.

A snapshot and its finalized-state cursor come from one PostgreSQL row.
The live publication cursor is separate. Subsequent events start after the
finalized-state cursor, so a mid-run reconnect replays the unfinished segment. A finalized message snapshot replaces the client's
provisional messages, avoiding duplicate finalized history. The store keeps a
bounded tail of 256 events when saving authoritative state. A supplied cursor must equal the current snapshot cursor. Any other cursor
returns HTTP 410 before streaming. Arbitrary token-cursor resume is unsupported. A cursor that expires during a stream
produces a `CURSOR_EXPIRED` run error and closes the stream. Reconnect then requires a fresh snapshot.
Terminal conversations close their observation stream with an AG-UI terminal event.
The proof does not promise indefinite token replay. Model activity retries may
repeat provisional token text. Finalized snapshots remain authoritative.

## Cancellation and trust

Cancellation is an authorized command with a requested acknowledgement followed
by a persisted outcome. It does not roll back an effect that already committed.
The synthetic effect store remains the record of that effect. Cancellation is
never inferred from HTTP disconnection.

Generated local bearer credentials map to two test principals. Configuration
stores their hashes. The fixture client file holds the local tokens with mode
0600. Every conversation read or command checks ownership. These credentials do
not choose a production login system. Temporal and PostgreSQL are trusted local
services bound to loopback for the proof.

No route accepts a provider endpoint, credential, coworker instructions, or tool
registry from an AG-UI client. The selected Beans context is captured by setup,
from a clean temporary hub with no remotes, and retained with the conversation.

Framework timestamps describe the values captured when history is first
finalized. A workflow replay before that first save can generate a request
timestamp later than its recorded model response. These timestamps are not an
execution-order clock. Temporal history and stable input ordinals establish
ordering. Finalized timestamp values remain unchanged after later replay.

The HTTP stale-cursor rejection and PostgreSQL event pruning are exercised.
The defensive in-stream CURSOR_EXPIRED branch is not exercised by this proof.
Worker OpenTelemetry emissions may include framework replay emissions. Offline
Temporal Replayer telemetry is stored separately and excluded from live-worker
telemetry checks. Span counts are emission counts, not model-request counts.

# Observe a durable Claude or Pi conversation

Start the worker and its registered fixture or approved account profile as described in the [member profile guide](member-profiles.md). The gateway uses the same PostgreSQL database and Temporal endpoint as that worker.

Create a local gateway configuration with an unused port and a mapping from SHA-256 bearer-token digests to owner IDs. Use high-entropy tokens. For example, this script writes an ephemeral token and configuration to owner-readable files in your current directory. Run it in a private directory outside the repository.

```sh
node --input-type=module <<'JS'
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const token = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(token).digest("hex");
writeFileSync("owner.token", token, { mode: 0o600, flag: "wx" });
writeFileSync("gateway.json", JSON.stringify({ port: 0, tokenHashes: { [digest]: "local" } }), { mode: 0o600, flag: "wx" });
JS
npm --prefix /path/to/birbcrew run --silent gateway -- /absolute/path/to/gateway.json
```

The gateway prints its loopback URL. Send the token as an `Authorization: Bearer <token>` header on every request. All command bodies use JSON. Run the npm command from the repository with the path to the generated gateway configuration.

| Method and path | Body or response |
| --- | --- |
| POST /members | Send a new `requestId` (UUID), `engine` (`claude` or `pi`) and a registered `profile`. Returns the member identity. Reuse the same body for retries. |
| POST /conversations | Send `memberId` and a new `conversationId` (UUID). Returns the initial public snapshot. |
| GET /conversations/{id} | Returns `messages`, `state` and the committed `cursor`. State includes the member, engine, profile, phase and pending approvals. |
| POST /conversations/{id}/inputs | Send a new `requestId` and `text`. A 202 response acknowledges the input. Retry ambiguous acknowledgements with the same ID and text. |
| POST /conversations/{id}/human | Copy `memberId`, `requestId`, `invocationId`, `nativeCallId`, `approvalId` and `version` from the pending card. Add `choice` with `approve` or `deny`. |
| POST /conversations/{id}/cancel | Send the `requestId` of a pending protected call. Acknowledges cancellation. The native continuation can then report the cancelled result. |
| POST /conversations/{id}/events | Attach a read-only AG-UI observer using the route's conversation ID as its thread ID. |

Each fresh observer receives a committed message and state snapshot, followed by frames after its cursor. Each protected call has a public ID used for the tool call, result and decision card. The stream stays open at ordinary input completion and while a decision is pending. After the fourth completed input it emits `RUN_FINISHED`. A failed native turn emits `RUN_ERROR`. Disconnecting an observer releases its connection while the workflow continues.

To attach the official client, construct an empty client each time. Input submission and human decisions use their separate HTTP routes.

```js
import { HttpAgent } from "@ag-ui/client";
const agent = new HttpAgent({
  url: baseUrl + "/conversations/" + conversationId + "/events",
  threadId: conversationId,
  headers: { Authorization: "Bearer " + token },
});
await agent.runAgent({}, {
  onMessagesChanged({ messages }) { console.log(messages); },
});
```

An explicit `?after=<cursor>` must match the current snapshot. A stale value returns HTTP 410 before streaming. A live observer that falls more than 256 frames behind receives `RUN_ERROR` with `CURSOR_EXPIRED`. In either case a fresh observer without `after` receives the latest snapshot. Conversations whose turns predate the public event ledger report HTTP 409 `history_unavailable`; their old prompt digests cannot reconstruct their public messages.

The fixture suite exercises two official observers during a protected approval on each engine, gateway restart, argument redaction, cursor expiry and terminal message equality. This gateway currently publishes assistant text at committed replies. Native partial text/tool argument streaming, active-generation cancellation and Pi child runs have separate implementation and proof gates.

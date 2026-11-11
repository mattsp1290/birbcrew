# Run a member with a live model

The worker reads its provider configuration from a trusted module on the server.
The built-in module supports Pi on OpenCode Go, Claude on the Anthropic API, and Codex on the OpenAI API.
The member's spawn request selects one of the configured profile names. Create a
new member to select a different model or engine.

## Configure an approved account

1. Use a private JSON file outside the checkout for each account. Record
   `checked_at` as an ISO 8601 timestamp with a timezone from the past 12 hours.
   Use `account_path` to identify the approved account without a secret. In
   `evidence`, record how the operator verified its settings and permitted use.
   Keep the API key in the worker's environment.
2. For Pi, set `BIRBCREW_PI_ATTESTATION` to the absolute path of the file and
   provide the eligible Go credential in `OPENCODE_GO_API_KEY`. Include
   `provider` set to `opencode-go`, `eligible_coding_use` set to `true`, and
   `extra_usage_disabled` set to `true`. Spawn with engine `pi` and profile
   `pi-go-glm-5.3-flash.v1`. Each turn checks eligibility and model availability
   before inference. The worker checks the returned model identity before saving
   a result. [OpenCode Go model routes](https://opencode.ai/docs/console/go/)
3. For Claude, set `BIRBCREW_CLAUDE_ATTESTATION` to the absolute path of its
   separate file. Provide the approved Anthropic API key in
   `BIRBCREW_CLAUDE_API_KEY`. Include `provider` set to `anthropic-api`,
   `approved_sdk_use` set to `true`, and `model` set to the exact approved API
   model ID. Spawn with engine `claude` and profile `anthropic-<model>.v1`.
   For example, model `claude-sonnet-4-6` gives profile
   `anthropic-claude-sonnet-4-6.v1`.
4. For Codex, set `BIRBCREW_CODEX_ATTESTATION` to its own attestation and
   `BIRBCREW_CODEX_API_KEY` to its approved OpenAI API key. Use provider
   `openai-api`, `approved_sdk_use` set to `true`, and the exact approved
   GPT model. Spawn with engine `codex` and profile `openai-<model>.v1`.
5. Start the worker with the service database, Temporal address, and absolute
   durable state directory configured. Supply only the attestations for the
   engines this worker will serve.

   ```sh
   npm run members -- worker src/service/providers.ts
   ```

Renew the operator evidence before its 12-hour window ends. Each live turn
rereads the corresponding file. Restart the worker when rotating a provider key.
All three engines require independent live-account acceptance using the intended
account and model.

## Verify the profiles offline

With the project's Node version and dependencies installed, run
`node --test tests/service/providers.test.ts` with the three attestation variables
unset. The suite uses temporary files, synthetic keys, and a loopback HTTP
server. It checks credential selection and expiry, the model ID in both
directions, redirect refusal, and Pi's session headers across checkpoint restore.

## Approve a protected work item

Profiles ending in `.approval.v1` add the host-owned `record_work_item` tool.
For example, select `fixture.approval.v1` for a local test or
`pi-go-glm-5.3-flash.approval.v1` for an approved Pi account. Each member
retains the account, tools and native storage associated with its selected
profile. A worker registering different settings for that name is rejected.

For the fixture, submit `record <request UUID>` as the turn text. While the
turn waits, use `npm run --silent members -- pending` in another terminal.
Supply the owner ID and conversation ID as a JSON object on standard input.
The returned approval includes the native call ID, a public summary, and a
digest of the private arguments.

To submit a decision, pass its ownerId, memberId, conversationId, requestId,
invocationId, nativeCallId, approvalId, version and argumentDigest to
`members -- decide` with `choice` set to `approve` or `deny`. To cancel while
waiting, pass ownerId, conversationId and requestId to `members -- cancel-pending`.
Each command reads a single JSON object on standard input. The original turn
finishes after the same SDK receives its native tool result. A retry of the
same decision returns the recorded choice.

## Delegate tasks from a Pi member

Spawn a Pi member with the `fixture.crew.v1` profile to try delegation locally.
For example, submit the following text as a turn.

```text
delegate [{"role":"analyst","task":"recall"},{"role":"recorder","task":"record assigned cedar"}]
```

The parent may assign up to two tasks in one turn. Each child runs in its own
Pi coding session with a pinned role, model and tool list. An analyst receives
only its task. A recorder can request the same work-item approval as the parent.
Use the invocation and approval IDs from the pending list to answer the intended
child. The entire turn has one work-item budget. The parent receives both
results in its original call order, even when the second child finishes first.

Use `members -- cancel-pending` with the parent request ID to cancel active and
waiting children. The production profile for separately authorized Pi use is
`pi-go-glm-5.3-flash.crew.v1`.

## Answer a next-step question

Profiles ending in `.next-step.v1` give the member the `choose_next_step`
tool. For the local fixture, spawn a Claude or Pi member with
`fixture.next-step.v1`, open a conversation and submit `next step`. The turn
waits while the worker releases the SDK process. Another worker can continue
it from the saved native call.

Use the same `members -- pending` and `members -- decide` commands above.
Copy the pending call's identity fields and set `choice` to `inspect` or
`test`. The SDK receives that word as the tool result. A repeated answer
returns the recorded choice. A different answer conflicts. Cancellation
while waiting returns a cancelled tool result. Neither path creates a work item.

## Run the account acceptance proof

After `scripts/setup --mode fixture`, run the following command on a supported Linux host with Docker and the pinned Node and Temporal binaries. Select one account per run. The ten-minute deadline covers service startup and the provider journey.

```sh
.proof/bin/node tests/proof/live-members.ts --engine pi --attestation /absolute/private/pi-proof.json
```

With the pinned Node on `PATH`, `npm run test:live -- --engine pi --attestation /absolute/private/pi-proof.json` runs the same entry. The runner uses `.proof/bin/temporal` unless `TEMPORAL_CLI` names the pinned executable elsewhere.

Use a private file owned by the invoking user outside the checkout (`chmod 600`). Give each newly approved journey its own `approval_id` UUID. The file must contain the current `checked_at`, `account_path`, and `evidence` fields described above. Also specify `approved_live_proof: true`, `max_requests` as an integer from 1 through 24, and the exact endpoint and model. The first provider submission permanently reserves the approval in the invoking OS user's private `~/.local/state/birbcrew/live-proof-claims` directory. Use each approval on the machine where it was granted. Concurrent or repeated invocations, including after an interruption, require a fresh owner-approved UUID. Keep this directory across restarts. The request limit covers provider model discovery, token counts and SDK retries as well as inference. The credential belongs in the selected environment variable only.

| Engine | Provider and credential | Endpoint and model | Additional attestation fields |
|---|---|---|---|
| `pi` | `opencode-go` / `OPENCODE_GO_API_KEY` | `https://opencode.ai/inference/go/openai/v1` / `glm-5.3-flash` | `eligible_coding_use: true` and `extra_usage_disabled: true` |
| `claude` | `anthropic-api` / `BIRBCREW_CLAUDE_API_KEY` | `https://api.anthropic.com` / exact approved Claude model ID | `approved_sdk_use: true` |
| `codex` | `openai-api` / `BIRBCREW_CODEX_API_KEY` | `https://api.openai.com/v1` / exact approved GPT model ID | `approved_sdk_use: true` |

The verifier creates a disposable database, Temporal server, authenticated gateway and worker. Two independent observation clients compare their histories with the gateway. The verifier approves one synthetic work item, checks the provider's returned receipt, replaces the worker container and asks the member to recall a random marker. Pi also delegates to a separate analyst. Codex checks the native rollout contains exactly the two submitted user messages on the same thread.

A private loopback relay holds the selected key, rechecks the account file before each upstream request and enforces the model, official route and request limit. The worker presents a disposable credential to that endpoint. Codex uses the stock authenticated OpenAI provider and its HTTP Responses fallback. Billing eligibility comes from the account owner's evidence. The command emits one redacted JSON result and removes its private transcripts and service state. A nonzero exit marks an incomplete gate. To rehearse all three journeys with synthetic accounts and local responses, run `PATH="$PWD/.proof/bin:$PATH" node --test tests/proof/live-controlled.test.ts tests/proof/live-native-controlled.test.ts`.

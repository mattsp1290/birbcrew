# Run a member with a live model

The worker reads its provider configuration from a trusted module on the server.
The built-in module supports Pi on OpenCode Go and Claude on the Anthropic API.
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
4. Start the worker with the service database, Temporal address, and absolute
   durable state directory configured. Supply only the attestations for the
   engines this worker will serve.

   ```sh
   npm run members -- worker src/service/providers.ts
   ```

Renew the operator evidence before its 12-hour window ends. Each live turn
rereads the corresponding file. Restart the worker when rotating a provider key.
Both engines require independent live-account acceptance using the intended
account and model.

## Verify the profiles offline

With the project's Node version and dependencies installed, run
`node --test tests/service/providers.test.ts` with the two attestation variables
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

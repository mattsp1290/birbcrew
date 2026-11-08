# Independent review disposition

The fresh design review and first code review both returned model identity
`claude-opus-5-5`. The review processes used subscription auth with the three
Anthropic override variables removed, safe mode, and Read/Glob/Grep only.
[The code review](evidence/code-review.json) contains the original findings.
No code comments needed removal. Tool descriptions remain because the model
uses them. No comment restoration or constraint suppression was needed.

This record tracks fixes. The final independent review found no remaining
material deterministic findings. Its four low-severity observations are addressed
below. Live subscription acceptance and human merge review remain open.

| Finding | Disposition |
| --- | --- |
| H1, mid-run reconnect | Added an authoritative snapshot cursor separate from the live event cursor. Every observation starts from a snapshot and replays its unfinished segment. One Client B process attaches during the committed-effect wait. A separate Client B process attaches during the later human wait and converges with Client A on the finalized snapshot. |
| H2, replayed message timestamps | Persistence now returns the canonical stored Conversation through a recorded activity result. The workflow restores only canonical message fields from that result. Other mutable workflow state stays under its own authority. The proof forces worker replay, compares prior message parts and timestamps after human resolution, and runs Temporal Replayer against captured histories. |
| H3, storage and projection failures | Idempotent storage and projection activities retry transient failures without a three-attempt limit. Projection has a thirty-minute activity deadline and a heartbeat timeout. Deterministic event conflicts fail explicitly. The API maps unavailable workflow RPCs to 409 or 503. Projection remains ordered before snapshot publication, since bypassing it could publish stale events after a finalized snapshot. |
| M1, interruption cause | The tool deadline is now five minutes with a three-second heartbeat timeout. The injected wait applies only to each conversation's first input. Final evidence shows the heartbeat timeout and retry attempt from Temporal history. |
| M2, telemetry | Added run, request, and workflow IDs to the commit-boundary observation. Framework telemetry is checked through its standard gen_ai correlation attributes. Secret checks cover test credentials, the database password, and the selected Go key when live mode is used. |
| M3, cursor semantics | Arbitrary token-cursor resume is not offered. Reconnect always supplies a snapshot. A supplied cursor must match the current authoritative snapshot or HTTP 410 requests a fresh one. The cursor is available from the snapshot API. |
| M4, observation termination | A stream reuses one PostgreSQL connection and polls at 100 ms. Terminal conversations emit one AG-UI terminal event and close. A native run error also closes the observation stream. |
| M5, account gate | The Go credential preflight returned api_key_expired. Go remains blocked pending key replacement and explicit current overage confirmation. Claude Max Extra Usage was explicitly confirmed disabled by the owner. The trail supersedes the earlier broader claim. |
| M6, human resolution | A separate Client B JavaScript action resolves the request using the same owner principal credential as Client A. The independent boundary is the process and authorized action. Version 1 is immutable for this bounded proof. Version 0 tests rejection of an older version; no request replacement mechanism is claimed. |
| M7, cancellation coverage | The proof observes explicit cancellation during the committed-effect wait. Additional cancellation during a human wait and terminal SDK stream checks are tracked in final evidence. No effect rollback is claimed. |
| L1, note digests | Each note has separate file_sha256 and content_sha256 fields. The latter hashes the exact UTF-8 body supplied to the agent. Installed bn help established the explicit --hub selection flag. |
| L2, Update rejection history | Added Temporal Update validators for inputs, human responses, and cancellation. Handlers also check before mutation. |
| L3, actor field | HumanReply no longer accepts actor. The authenticated API creates the internal Resolution with the authenticated principal. |
| L4, stream parsing | Moved the AG-UI Event TypeAdapter and imports out of the polling loop. |
| L5, eligible models | Worker construction rejects models outside the versioned coworker definition. |
| L6, provider headers | The inspected official Go guide requires the client's own User-Agent and x-opencode-session. The proof uses birbcrew-coding-proof/0.1.0 and the stable conversation ID. See account-gates.md. |
| L7, decision trail | Added superseding account and verification rows and recorded service, runtime, retention, and failure-injection decisions. Failure excerpts are preserved in repository evidence. |
| L8, prerequisites | The setup guide lists ripgrep. A clean setup has been exercised in a separate temporary copy. |

The suggested merge gate remains human review of authentication and permissions.
A 404 on a conflicting create does not establish an enumeration-resistant API.
Rate limiting and production identity remain outside this local proof.

## Fresh fix-review follow-up

[The fresh fix review](evidence/fix-review.json) found no new runtime correctness
bugs. It correctly rejected the earlier mid-run attachment claim. The final
proof now starts Client B after the synthetic effect commits, while the tool
still waits for acknowledgement. It asserts the running phase before and after
attachment, receives STEP_STARTED and TOOL_CALL_START through the official SDK,
and confirms the client is still alive before the worker is killed.

[The final acceptance report](evidence/final-acceptance.json) records that step
under `mid_run_reconnect`. Its source matches [the clean-start manifest](evidence/clean-start.json).
The final clean source copy passed setup, seven boundary checks, all eleven
deterministic acceptance journeys, and three Temporal history replays.

Offline replay telemetry now uses a separate directory. Runtime emission counts
exclude it. The stale-cursor API check is named precisely, and a direct store
check verifies that retention removed the old cursor. In-stream expiry remains
a documented unexercised defensive path. Framework timestamp ordering limits
are documented. Model activities explicitly use a thirty-second heartbeat.
The request-version gate is named `wrong_version_http`.

[The final independent review](evidence/final-review.json), returned by
`claude-opus-5-5`, resolved every material deterministic finding. It did not
rerun commands or independently recompute source hashes.

Four low-severity follow-ups were accepted. The two Client B attachments now
have separate event logs, so the later connection wait cannot pass on old events.
Secret scanning includes offline replay telemetry without adding those spans
to runtime emission counts. The attachment descriptions distinguish the two
processes. Append-only corrections in the decision trail identify which clean
run evidence is retained and preserve the source behind the TestModel choice.
The affected deterministic proof passed after these changes, including seven
boundary tests, eleven acceptance journeys, and three Temporal history replays.
The review inspected [the preserved report](evidence/reviewed-acceptance.json)
and [source manifest](evidence/reviewed-clean-start.json). The current report
and manifest record the subsequent clean rerun with these low-severity fixes.

## Continuation review

[The fresh continuation review](evidence/continuation-review.json) returned
`claude-opus-5-5`. It confirmed that all four post-review corrections appear
resolved. It used read-only tools and did not rerun tests or recompute hashes.
It reviewed an uncommitted checkout, not a final commit.

The review began before the owner supplied the explicit Go confirmation and
before the live journey. Its missing-attestation and stale-status findings
reflect that earlier snapshot. The owner subsequently confirmed Go Extra Usage
disabled. A private attestation checked at 2026-11-06T12:37:39.293532Z supported
the successful [initial live journey](evidence/live-initial-acceptance.json).
Current status distinguishes those events from historical expired-key evidence.
The 12:34 key recheck has no retained generating command and is not used as
authoritative acceptance evidence. The documented live verifier supplies the
current account preflight instead.

The verifier finding is accepted. Live acceptance now checks the returned model identity and the native message
metadata for the configured provider endpoint. It publishes the live
gate after history replay and telemetry succeed. A failure keeps the live gate
NOT VERIFIED and records the run failure. No provider or runtime changed.
The data shape is the existing completed-gate evidence record, with sets of
native returned model identities and provider URLs. No new state or API is needed.
Clean setup, seven boundary tests, eleven deterministic gates, three deterministic replays, ten live gates, and one live replay passed after this change. The fresh final review found no remaining material findings.

Low observations about repeated context assertions, Client A append behavior,
isolation label completeness, and local error details do not invalidate the
observed journeys. No production identity, rate limiting, token rotation, or
enumeration-resistance claim is made. Client A finalized-state convergence is
asserted independently of connection-log reuse. Public packaging additionally
scans the selected report and client captures for current credentials and
common secret patterns. The actor credential description above is corrected.
The historical key recheck is a diagnostic record, not SubscriptionEvidence.
No comments or suppression directives required changes. Tool docstrings remain
because the model consumes them. Cursor-specific comment and deslop roles are
unavailable; the approved independent Claude mapping performed the available
comment and maintainability review.

[The independent initial live-evidence review](evidence/live-initial-review.json)
returned `claude-opus-5-5`. It found no material runtime blocker using the two
reports together. Its packaging observations are accepted. The final source
and evidence are selected for one authorized review-branch commit. The continuation
manifest includes evidence hashes. This continuation section supersedes the historical
open-live language above. Owner-attestation timing and the source of eligibility
are clarified in account-gates.md. Worker span counts may include workflow replay
emissions and must not be treated as provider-call counts, as architecture.md
already documents. The final clean reruns and final independent review substantiate runtime acceptance.

## Final continuation disposition

[The final continuation review](evidence/continuation-final-review.json) returned
`claude-opus-5-5` and found no remaining material findings. It confirmed resolution
of all prior material findings and the four historical post-review corrections.
It substantiated all twelve runtime journeys using the final deterministic and
live reports. It inspected source and evidence before commit. It did not execute
the proof, recompute hashes, inspect private account settings, or review a final commit.

The timestamp notes are accepted. clean-start.json now names the scope of its
original checked_at and separately records when the later live status was added.
The verifier decision row was written retrospectively after implementation and
a clean run had started. It is a decision record, not a pre-run authorization.
The user's original bounded continuation already authorized the fix and reruns.

The URL limitation is accepted. Pydantic AI derives provider_url from the client
configuration. The check confirms that configured endpoint in native metadata.
It is not independent attestation of the response server's origin. The model
identity is returned by the provider. All observed final model responses contain
the selected model identity. Missing names on some future response are not
separately rejected by the bounded set-based helper. That low observation does
not invalidate the final captured responses.

Other low observations remain bounded maintenance items. No comment deletion,
restoration, suppression, or constraint encoding was required. Human review of
authentication and permissions remains mandatory before merge. Runtime acceptance
is complete. Merge approval is not granted by automated or Claude review.

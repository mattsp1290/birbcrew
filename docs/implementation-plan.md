# Bounded runtime proof plan

The completion predicate is all twelve acceptance journeys VERIFIED, a resolved
fresh Claude review, and an exercised clean start. Missing account evidence is
a blocker, never a passing live check.

## Playbook

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] Phase D: Keep the audit trail
- [x] Phase E: Verify and hand back

## Throughput checkpoint

- [x] Blocking first steps. Read instructions, inspect tools and provider gates,
  and resolve framework versions before implementation.
- [x] Independent workstreams. Account readiness can proceed alongside local
  implementation. Fresh Claude review follows the host mapping and billing gate.
- [x] Shared mutable state. One workflow owns each conversation. PostgreSQL
  transactions own effect deduplication and authoritative snapshot publication.
  Beans uses an isolated temporary hub with explicit project and actor.
- [x] Smallest safe decomposition. One Codex implementation owner keeps the
  workflow, event adapter, and recovery experiment consistent. Claude independently
  reviews the result. Cursor Task APIs and model slugs are unavailable here.

## Concrete units

- [x] Pin dependencies and establish repeatable setup.
- [x] Capture bounded Beans context with clean-commit provenance.
- [x] Implement typed records and the authenticated API.
- [x] Run the durable Pydantic AI agent with AG-UI event publication.
- [x] Prove retries, process interruption, human wait, reconnect, and cancellation.
- [x] Capture local telemetry and exact service versions.
- [x] Run the opt-in subscription journey after billing gates pass.
- [x] Review through sanitized Claude CLI and resolve findings.
- [x] Exercise clean start and publish evidence with explicit remaining checks.

## Design choices

The data shape is a coworker definition, a conversation, accepted inputs keyed
by client request ID, run attempts, versioned human decisions, idempotent tool
operations, and Pydantic AI finalized message history. AG-UI events are transient
observations with a bounded replay cursor. They do not own message history.

Two designs were considered locally. A workflow per turn would require another
cross-process owner to order concurrent turns and human decisions. A workflow
per conversation provides that owner directly. The latter is selected. The
fresh Claude design review accepted the conversation workflow and identified
stream lifetime and identity constraints. No parallel Cursor exploration is claimed.

Temporal executes model and tool activities through Pydantic AI's supported
integration. HTTP handlers only issue workflow commands and read PostgreSQL.
They never execute the agent. Disconnect therefore cannot cancel execution.
The framework's AG-UI adapter translates native agent events and finalized
messages. Application snapshots and SSE cursors handle reconnection.

The proof has a finite input bound. It does not replace workflows or perform
Continue-As-New. Workflow IDs cannot be reused. Reopening a completed conversation
requires a new conversation ID. A later long-lived service must carry request
deduplication and ordering across Continue-As-New before removing this bound.

The author handles implementation under the agreed host mapping. Claude supplies
independent architecture, comments, code, and audit-trail review when the account
gate allows it. No production deployment, PR action, or notification is included.

The deterministic loop and clean start passed. The continuation completed the live-account unit after the owner confirmed Go Extra Usage disabled. See docs/evidence/live-acceptance.json. Fresh continuation review and authorized review-branch packaging are recorded in docs/evidence/continuation-handoff.md. No PR opening, merge, or production deployment is included.

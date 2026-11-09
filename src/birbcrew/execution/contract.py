"""Producer-owned, credential-free delivery activity contract."""

import json
from hashlib import sha256
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Commit = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
Identity = Annotated[str, Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$")]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def digest(value: object) -> str:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    return sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


class GoalRef(Record):
    project: Identity
    record_id: Identity
    revision: str = Field(min_length=1, max_length=200)
    content_sha256: Digest


class GoalOffer(Record):
    offer_id: Identity
    goal_ref: GoalRef
    title: str = Field(min_length=1, max_length=200)
    goal_text: str = Field(min_length=1, max_length=16000)
    repository_id: Identity
    base_commit: Commit
    policy_revision: Digest
    allowed_paths: tuple[str, ...] = Field(min_length=1, max_length=20)
    acceptance_id: Identity

    @model_validator(mode="after")
    def content_matches(self):
        if sha256(self.goal_text.encode()).hexdigest() != self.goal_ref.content_sha256:
            raise ValueError("goal_content_mismatch")
        return self


class ApprovedGoal(Record):
    delivery_id: UUID
    conversation_id: UUID
    owner_principal: Identity
    approval_command_id: UUID
    offer: GoalOffer
    offer_sha256: Digest

    @model_validator(mode="after")
    def offer_matches(self):
        if digest(self.offer) != self.offer_sha256:
            raise ValueError("offer_digest_mismatch")
        return self


class ExecutionInput(Record):
    schema_version: Literal["birbcrew.execution.v1"] = "birbcrew.execution.v1"
    operation_id: UUID
    approved_goal: ApprovedGoal


class Acceptance(Record):
    acceptance_id: Identity
    outcome: Literal["passed"]
    evidence_digest: Digest
    evidence_ref: Identity


class Candidate(Record):
    repository_id: Identity
    base_commit: Commit
    head_commit: Commit
    branch: str = Field(pattern=r"^birbforge/pilot/[0-9a-f-]{36}$")
    changed_paths: tuple[str, ...]
    acceptance: Acceptance


class CandidateResult(Record):
    status: Literal["candidate"] = "candidate"
    candidate: Candidate


class HaltedResult(Record):
    status: Literal["blocked", "uncertain", "cancelled"]
    reason: Identity


ExecutionResult = Annotated[CandidateResult | HaltedResult, Field(discriminator="status")]
EXECUTION_RESULT = TypeAdapter(ExecutionResult)


class ReviewInput(ExecutionInput):
    candidate: Candidate


class ReviewReceipt(Record):
    candidate_commit: Commit
    reviewer: Literal["claude-cli"] = "claude-cli"
    disposition: Literal["approved", "changes_requested", "inconclusive"]
    findings_digest: Digest
    evidence_ref: Identity
    summary: str = Field(default="Review details unavailable.", min_length=1, max_length=2000)


class PublicationInput(ReviewInput):
    review: ReviewReceipt

    @model_validator(mode="after")
    def matched_approval(self):
        if (
            self.review.disposition != "approved"
            or self.review.candidate_commit != self.candidate.head_commit
        ):
            raise ValueError("review_not_approved_for_candidate")
        return self


class DraftReceipt(Record):
    status: Literal["draft_ready"] = "draft_ready"
    repository_id: Identity
    head_commit: Commit
    base_branch: str
    provider: Literal["github"] = "github"
    number: int = Field(gt=0)
    url: str = Field(pattern=r"^https://github.com/[^/]+/[^/]+/pull/[0-9]+$")
    draft: Literal[True] = True


PublicationResult = Annotated[DraftReceipt | HaltedResult, Field(discriminator="status")]
PUBLICATION_RESULT = TypeAdapter(PublicationResult)

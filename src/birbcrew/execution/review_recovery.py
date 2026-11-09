"""Read-only proof of the legacy approval/findings classification defect."""

import os
import stat
from hashlib import sha256
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StrictBool, StrictInt, StrictStr, ValidationError
from temporalio import activity

from birbcrew.execution import journal
from birbcrew.execution.contract import (
    Commit,
    ExecutionInput,
    Record,
    ReviewRecoveryDenied,
    ReviewRecoveryEligible,
    ReviewRecoveryInput,
    digest,
)
from birbcrew.execution.policy import ExecutionSettings, installation


class LegacyVerdict(Record):
    approved: StrictBool
    findings: tuple[Annotated[StrictStr, Field(max_length=10000)], ...] = Field(max_length=30)


class LegacyDiagnostic(Record):
    model: Literal["default", "sonnet"]
    outcome: Literal["verdict", "provider_usage_unavailable", "installed_command_failed"]
    reported_models: tuple[StrictStr, ...] | None = None


class LegacyEvidence(Record):
    operation_id: UUID
    candidate_commit: Commit
    review_attempt: StrictInt = Field(ge=0)
    version: StrictStr
    diagnostics: tuple[LegacyDiagnostic, ...] = Field(min_length=1, max_length=2)
    error_code: None
    verdict: LegacyVerdict


def read_evidence(config: ExecutionSettings, filename: str) -> bytes:
    directory = os.open(config.artifact_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        descriptor = os.open(
            filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1_048_576:
                raise ValueError("evidence_not_bounded_regular_file")
            data = stream.read(1_048_577)
            if len(data) > 1_048_576:
                raise ValueError("evidence_too_large")
            return data
    finally:
        os.close(directory)


async def inspect_legacy_recovery(request: ReviewRecoveryInput, config: ExecutionSettings):
    previous, receipt = request.previous, request.receipt
    denied = ReviewRecoveryDenied(kind="not_eligible")
    try:
        config.authorize(previous)
        if (
            previous.operation_id != previous.approved_goal.delivery_id
            or receipt.disposition != "changes_requested"
            or receipt.findings_digest == "0" * 64
            or receipt.candidate_commit != previous.candidate.head_commit
            or receipt.review_attempt != previous.review_attempt
        ):
            return denied
        candidate, offer = previous.candidate, previous.approved_goal.offer
        if (
            candidate.repository_id != offer.repository_id
            or candidate.base_commit != offer.base_commit
            or candidate.acceptance.acceptance_id != offer.acceptance_id
            or candidate.branch != f"birbforge/pilot/{previous.operation_id}"
            or not set(candidate.changed_paths).issubset(offer.allowed_paths)
        ):
            return denied
        author_input = ExecutionInput(
            operation_id=previous.operation_id, approved_goal=previous.approved_goal
        )
        author = await journal.receipt(
            "author", str(previous.operation_id), author_input.model_dump(mode="json")
        )
        original = await journal.receipt(
            "review", previous.review_identity, previous.model_dump(mode="json")
        )
        if (
            not author
            or author.get("status") != "candidate"
            or author.get("candidate") != candidate.model_dump(mode="json")
            or original != receipt.model_dump(mode="json")
        ):
            return denied
        kind = "review" if previous.review_attempt == 0 else f"review-{previous.review_attempt}"
        if receipt.evidence_ref != f"execution/{previous.operation_id}/{kind}":
            return denied
        data = read_evidence(config, f"{previous.operation_id}-{kind}.txt")
        if sha256(data).hexdigest() != receipt.findings_digest:
            return ReviewRecoveryDenied(kind="evidence_unconfirmed")
        evidence = LegacyEvidence.model_validate_json(data)
        if (
            evidence.operation_id != previous.operation_id
            or evidence.candidate_commit != candidate.head_commit
            or evidence.review_attempt != previous.review_attempt
            or evidence.diagnostics[-1].outcome != "verdict"
            or any(d.outcome != "provider_usage_unavailable" for d in evidence.diagnostics[:-1])
            or evidence.verdict.approved is not True
            or not evidence.verdict.findings
        ):
            return denied
    except (OSError, ValueError, ValidationError):
        return ReviewRecoveryDenied(kind="evidence_unconfirmed")
    return ReviewRecoveryEligible(
        kind="legacy_approval_misclassified",
        operation_id=previous.operation_id,
        candidate_commit=candidate.head_commit,
        review_attempt=previous.review_attempt,
        receipt_sha256=digest(receipt),
        evidence_sha256=receipt.findings_digest,
    )


@activity.defn(name="birbcrew.check_review_recovery.v1")
async def check_review_recovery(raw: dict) -> dict:
    request = ReviewRecoveryInput.model_validate(raw)
    return (await inspect_legacy_recovery(request, installation())).model_dump(mode="json")

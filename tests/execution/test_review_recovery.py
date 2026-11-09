import asyncio
import json
import sys

import pytest
import test_execution
from pydantic import ValidationError

from birbcrew.execution import author, publish, review
from birbcrew.execution.contract import PublicationInput, ReviewInput, ReviewReceipt, digest
from birbcrew.execution.process import CommandFailure, command

setup = test_execution.setup
daemon = test_execution.daemon


def prepare(setup, monkeypatch):
    config, request, records = setup
    candidate = asyncio.run(author.author_goal(request.model_dump(mode="json")))["candidate"]
    monkeypatch.setattr(review, "installation", lambda: config)
    return config, ReviewInput(**request.model_dump(), candidate=candidate), records


def provider(monkeypatch, responses):
    calls = []

    async def run(argv, cwd, **kwargs):
        if "--version" in argv:
            return "2.1.312 (Claude Code)"
        calls.append(argv)
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return json.dumps(response)

    monkeypatch.setattr(review, "command", run)
    return calls


def verdict(approved=True):
    return {
        "is_error": False,
        "structured_output": {
            "decision": "approved" if approved else "changes_requested",
            "blocking_findings": [] if approved else ["Misleading claim."],
            "notes": [],
        },
        "modelUsage": {"claude-sonnet-5-5": {}},
    }


def test_usage_failure_falls_back_once_and_replay_preserves_receipt(setup, daemon, monkeypatch):
    config, request, records = prepare(setup, monkeypatch)
    calls = provider(monkeypatch, [CommandFailure(True), verdict()])
    result = asyncio.run(review.review_candidate(request.model_dump(mode="json")))
    assert result["disposition"] == "approved"
    assert result["summary"] == (
        "Claude CLI reported model: claude-sonnet-5-5. No blocking findings."
    )
    assert len(calls) == 2
    assert "--model" not in calls[0]
    assert calls[1][-2:] == ["--model", "sonnet"]
    assert asyncio.run(review.review_candidate(request.model_dump(mode="json"))) == result
    evidence = json.loads((config.artifact_root / f"{request.operation_id}-review.txt").read_text())
    assert evidence["diagnostics"][0]["outcome"] == "provider_usage_unavailable"
    assert evidence["diagnostics"][1]["reported_models"] == ["claude-sonnet-5-5"]
    assert "review_attempt" not in request.model_dump(mode="json")
    assert "review_attempt" not in result
    assert daemon.starts == 1


@pytest.mark.parametrize(
    "response,disposition",
    [
        (verdict(False), "changes_requested"),
        (CommandFailure(), "inconclusive"),
    ],
)
def test_no_fallback_for_verdict_or_other_error(setup, daemon, monkeypatch, response, disposition):
    _, request, _ = prepare(setup, monkeypatch)
    calls = provider(monkeypatch, [response])
    result = asyncio.run(review.review_candidate(request.model_dump(mode="json")))
    assert result["disposition"] == disposition
    assert len(calls) == 1
    if disposition == "changes_requested":
        with pytest.raises(ValueError, match="prior_inconclusive_review_required"):
            asyncio.run(
                review.review_candidate(
                    request.model_copy(update={"review_attempt": 1}).model_dump(mode="json")
                )
            )


def test_retry_preserves_legacy_receipt_and_only_reviews_same_candidate(setup, daemon, monkeypatch):
    config, request, records = prepare(setup, monkeypatch)
    old = ReviewReceipt(
        candidate_commit=request.candidate.head_commit,
        disposition="inconclusive",
        findings_digest="a" * 64,
        evidence_ref="execution/old/review",
    ).model_dump(mode="json")
    legacy_raw = {
        key: value
        for key, value in request.model_dump(mode="json").items()
        if key != "review_attempt"
    }
    records[("review", str(request.operation_id))] = (
        digest(legacy_raw),
        {"phase": "terminal", "result": old},
    )
    calls = provider(monkeypatch, [verdict()])
    retry = request.model_copy(update={"review_attempt": 1})
    changed = retry.model_copy(
        update={"candidate": retry.candidate.model_copy(update={"head_commit": "f" * 40})}
    )
    with pytest.raises(ValueError, match="prior_inconclusive_review_required"):
        asyncio.run(review.review_candidate(changed.model_dump(mode="json")))
    result = asyncio.run(review.review_candidate(retry.model_dump(mode="json")))
    assert result["review_attempt"] == 1
    assert result["disposition"] == "approved"
    assert asyncio.run(review.review_candidate(retry.model_dump(mode="json"))) == result
    assert records[("review", str(request.operation_id))][1]["result"] == old
    assert (config.artifact_root / f"{request.operation_id}-review-1.txt").is_file()
    assert daemon.starts == 1 and len(calls) == 1
    publication = PublicationInput(**retry.model_dump(), review=result)
    with pytest.raises(ValidationError, match="review_not_approved"):
        PublicationInput(**request.model_dump(), review=result)
    forged = publication.model_copy(
        update={"review": publication.review.model_copy(update={"findings_digest": "e" * 64})}
    )
    rejected = asyncio.run(publish.publish_draft(forged.model_dump(mode="json")))
    assert rejected["status"] == "blocked"
    assert rejected["reason"] == "publication_identity_conflict"


def test_command_retains_only_allowlisted_failure_classification(tmp_path):
    message = {
        "is_error": True,
        "result": "You’re out of usage credits. Switch to another model. SECRET",
    }
    script = tmp_path / "failure.py"
    script.write_text("import sys\nprint(" + repr(json.dumps(message)) + ")\nsys.exit(1)\n")
    with pytest.raises(CommandFailure) as caught:
        asyncio.run(command([sys.executable, str(script)], tmp_path, subscription=True))
    assert caught.value.usage_unavailable
    assert str(caught.value) == "provider_usage_unavailable"
    assert "SECRET" not in str(caught.value)
    with pytest.raises(CommandFailure) as caught:
        asyncio.run(command([sys.executable, str(script)], tmp_path))
    assert not caught.value.usage_unavailable


@pytest.mark.parametrize("selected_attempt", [1, 2])
def test_publication_requires_selected_attempt_receipt(
    setup, daemon, monkeypatch, selected_attempt
):
    _, request, records = prepare(setup, monkeypatch)
    receipt = ReviewReceipt(
        candidate_commit=request.candidate.head_commit,
        review_attempt=1,
        disposition="approved",
        findings_digest="c" * 64,
        evidence_ref="execution/one/review-1",
    )
    attempt = request.model_copy(update={"review_attempt": 1})
    records[("review", attempt.review_identity)] = (
        digest(attempt.model_dump(mode="json")),
        {"phase": "terminal", "result": receipt.model_dump(mode="json")},
    )
    selected = attempt.model_copy(update={"review_attempt": selected_attempt})
    claimed = receipt.model_copy(update={"review_attempt": selected_attempt})
    publication = PublicationInput(**selected.model_dump(), review=claimed)
    original = publish.git
    network = []

    async def git(config, work, *args):
        if args[0] == "ls-remote":
            network.append(args)
            return request.candidate.head_commit + " refs/heads/" + request.candidate.branch
        return await original(config, work, *args)

    async def existing(config, value):
        return {
            "status": "draft_ready",
            "repository_id": request.candidate.repository_id,
            "head_commit": request.candidate.head_commit,
            "base_branch": "main",
            "provider": "github",
            "number": 1,
            "url": "https://github.com/example/factory/pull/1",
            "draft": True,
        }

    monkeypatch.setattr(publish, "git", git)
    monkeypatch.setattr(publish, "existing_pr", existing)
    result = asyncio.run(publish.publish_draft(publication.model_dump(mode="json")))
    assert result["status"] == ("draft_ready" if selected_attempt == 1 else "blocked")
    assert len(network) == (1 if selected_attempt == 1 else 0)


def test_claimed_review_remains_unconfirmed_and_cannot_start_another_review(
    setup, daemon, monkeypatch
):
    _, request, records = prepare(setup, monkeypatch)
    claimed = (digest(request.model_dump(mode="json")), {"phase": "claimed"})
    records[("review", request.review_identity)] = claimed
    calls = provider(monkeypatch, [])
    result = asyncio.run(review.review_candidate(request.model_dump(mode="json")))
    receipt = ReviewReceipt.model_validate(result)
    assert receipt.disposition == "inconclusive"
    assert not receipt.can_retry
    assert "Supervisor recovery" in receipt.summary
    assert records[("review", request.review_identity)] == claimed
    with pytest.raises(ValueError, match="prior_inconclusive_review_required"):
        asyncio.run(
            review.review_candidate(
                request.model_copy(update={"review_attempt": 1}).model_dump(mode="json")
            )
        )
    assert calls == []
    assert ("review", f"{request.operation_id}/review-1") not in records
    assert daemon.starts == 1


def test_legacy_review_receipt_wire_and_retryability():
    legacy = {
        "candidate_commit": "a" * 40,
        "reviewer": "claude-cli",
        "disposition": "inconclusive",
        "findings_digest": "b" * 64,
        "evidence_ref": "execution/old/review",
        "summary": "Review details unavailable.",
    }
    assert ReviewReceipt.model_validate(legacy).can_retry
    assert ReviewReceipt.model_validate(legacy).model_dump(mode="json") == legacy
    interrupted = {**legacy, "findings_digest": "0" * 64}
    assert not ReviewReceipt.model_validate(interrupted).can_retry

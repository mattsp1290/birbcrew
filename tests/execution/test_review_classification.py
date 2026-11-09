import asyncio
import json
from hashlib import sha256
from uuid import uuid4

import pytest
import test_execution
from test_review_recovery import prepare as prepare_author
from test_review_recovery import provider, verdict

from birbcrew.execution import review
from birbcrew.execution.contract import ReviewReceipt, ReviewRecoveryInput, digest
from birbcrew.execution.review_recovery import inspect_legacy_recovery

setup = test_execution.setup
daemon = test_execution.daemon


def prepare(setup, monkeypatch):
    config, request, records = setup
    request = request.model_copy(update={"operation_id": request.approved_goal.delivery_id})
    return prepare_author((config, request, records), monkeypatch)


def legacy(config, request, records, *, approved=True, findings=None, changes=None):
    evidence = {
        "operation_id": str(request.operation_id),
        "candidate_commit": request.candidate.head_commit,
        "review_attempt": request.review_attempt,
        "version": "2.1.312 (Claude Code)",
        "diagnostics": [
            {"model": "default", "outcome": "verdict", "reported_models": ["claude-opus-5-5"]}
        ],
        "error_code": None,
        "verdict": {
            "approved": approved,
            "findings": ["Scope is correct. Nonblocking note."] if findings is None else findings,
        },
        **(changes or {}),
    }
    raw = json.dumps(evidence, sort_keys=True)
    kind = "review" if request.review_attempt == 0 else f"review-{request.review_attempt}"
    checksum, ref = config.evidence(str(request.operation_id), kind, raw)
    receipt = ReviewReceipt(
        candidate_commit=request.candidate.head_commit,
        review_attempt=request.review_attempt,
        disposition="changes_requested",
        findings_digest=checksum,
        evidence_ref=ref,
        summary="Scope is correct. Nonblocking note.",
    )
    records[("review", request.review_identity)] = (
        digest(request.model_dump(mode="json")),
        {"phase": "terminal", "result": receipt.model_dump(mode="json")},
    )
    return ReviewRecoveryInput(
        previous=request, receipt=receipt
    ), config.artifact_root / f"{request.operation_id}-{kind}.txt"


def test_bound_legacy_bytes_permit_only_fresh_review_and_terminal_replay(
    setup, daemon, monkeypatch
):
    config, request, records = prepare(setup, monkeypatch)
    request = request.model_copy(update={"review_attempt": 2})
    check, path = legacy(config, request, records)
    before = path.read_bytes()
    old = records[("review", request.review_identity)]
    proof = asyncio.run(inspect_legacy_recovery(check, config))
    assert proof.kind == "legacy_approval_misclassified"
    assert proof.evidence_sha256 == sha256(before).hexdigest()
    assert proof.receipt_sha256 == digest(check.receipt)
    calls = provider(monkeypatch, [verdict()])
    next_input = request.model_copy(update={"review_attempt": 3})
    receipt = asyncio.run(review.review_candidate(next_input.model_dump(mode="json")))
    assert receipt["disposition"] == "approved" and receipt["review_attempt"] == 3
    assert records[("review", request.review_identity)] == old
    assert path.read_bytes() == before
    path.unlink()
    assert asyncio.run(review.review_candidate(next_input.model_dump(mode="json"))) == receipt
    assert len(calls) == 1 and daemon.starts == 1
    evidence = json.loads(
        (config.artifact_root / f"{request.operation_id}-review-3.txt").read_text()
    )
    assert evidence["schema_version"] == "birbcrew.review-evidence.v2"


@pytest.mark.parametrize(
    "case",
    [
        "false",
        "empty",
        "bool_coercion",
        "v2",
        "error",
        "bad_diagnostic",
        "wrong_candidate",
        "wrong_attempt",
        "wrong_operation",
        "tamper",
        "missing",
        "oversized",
        "symlink",
        "wrong_ref",
        "zero_digest",
        "forged_receipt",
        "missing_review",
        "wrong_input_digest",
        "missing_author",
        "wrong_author",
        "operation_delivery_mismatch",
    ],
)
def test_legacy_denials_never_call_provider_or_change_receipts(setup, daemon, monkeypatch, case):
    config, request, records = prepare(setup, monkeypatch)
    changes = {
        "v2": {"schema_version": "birbcrew.review-evidence.v2"},
        "error": {"error_code": "failure"},
        "bad_diagnostic": {
            "diagnostics": [{"model": "default", "outcome": "installed_command_failed"}]
        },
        "wrong_candidate": {"candidate_commit": "f" * 40},
        "wrong_attempt": {"review_attempt": 2},
        "wrong_operation": {"operation_id": str(uuid4())},
    }.get(case)
    check, path = legacy(
        config,
        request,
        records,
        approved=False if case == "false" else "true" if case == "bool_coercion" else True,
        findings=[] if case == "empty" else None,
        changes=changes,
    )
    if case == "tamper":
        path.write_text(path.read_text() + " ")
    if case == "missing":
        path.unlink()
    if case == "oversized":
        path.write_bytes(b" " * 1_048_577)
    if case == "symlink":
        other = path.with_suffix(".original")
        path.rename(other)
        path.symlink_to(other)
    if case in {"wrong_ref", "zero_digest", "forged_receipt"}:
        updates = {
            "wrong_ref": {"evidence_ref": "execution/other/review"},
            "zero_digest": {"findings_digest": "0" * 64},
            "forged_receipt": {"summary": "forged"},
        }[case]
        check = check.model_copy(update={"receipt": check.receipt.model_copy(update=updates)})
        if case != "forged_receipt":
            records[("review", request.review_identity)][1]["result"] = check.receipt.model_dump(
                mode="json"
            )
    if case == "missing_review":
        records.pop(("review", request.review_identity))
    if case == "wrong_input_digest":
        records[("review", request.review_identity)] = (
            "f" * 64,
            records[("review", request.review_identity)][1],
        )
    if case == "missing_author":
        records.pop(("author", str(request.operation_id)))
    if case == "wrong_author":
        records[("author", str(request.operation_id))][1]["result"]["candidate"]["head_commit"] = (
            "f" * 40
        )
    if case == "operation_delivery_mismatch":
        request = request.model_copy(update={"operation_id": uuid4()})
        check = check.model_copy(update={"previous": request})
    before = json.dumps({str(key): value for key, value in records.items()}, sort_keys=True)
    calls = provider(monkeypatch, [])
    assert (
        asyncio.run(inspect_legacy_recovery(check, config)).kind != "legacy_approval_misclassified"
    )
    # A forged supplied receipt is denied by the read-only check; the admission boundary
    # only ever loads its own genuine receipt.
    if case != "forged_receipt":
        with pytest.raises(ValueError, match="prior_inconclusive_review_required"):
            asyncio.run(
                review.review_candidate(
                    request.model_copy(update={"review_attempt": 1}).model_dump(mode="json")
                )
            )
    assert calls == [] and daemon.starts == 1
    assert json.dumps({str(key): value for key, value in records.items()}, sort_keys=True) == before


def test_new_rejection_never_qualifies_for_legacy_route(setup, daemon, monkeypatch):
    config, request, _ = prepare(setup, monkeypatch)
    calls = provider(monkeypatch, [verdict(False)])
    receipt = asyncio.run(review.review_candidate(request.model_dump(mode="json")))
    check = ReviewRecoveryInput(previous=request, receipt=receipt)
    assert (
        asyncio.run(inspect_legacy_recovery(check, config)).kind != "legacy_approval_misclassified"
    )
    with pytest.raises(ValueError, match="prior_inconclusive_review_required"):
        asyncio.run(
            review.review_candidate(
                request.model_copy(update={"review_attempt": 1}).model_dump(mode="json")
            )
        )
    assert len(calls) == 1


def test_approval_with_notes_and_contradiction_at_provider_boundary(setup, daemon, monkeypatch):
    config, request, _ = prepare(setup, monkeypatch)
    response = verdict()
    response["structured_output"]["notes"] = ["Nonblocking observation."]
    calls = provider(monkeypatch, [response])
    result = asyncio.run(review.review_candidate(request.model_dump(mode="json")))
    assert result["disposition"] == "approved"
    assert "Nonblocking observation." in result["summary"]
    assert len(calls) == 1


@pytest.mark.parametrize(
    "decision,blockers,notes,expected",
    [
        ("approved", ["Blocking defect."], [], "inconclusive"),
        ("changes_requested", [], [], "inconclusive"),
        ("changes_requested", ["Blocking defect."], ["Nonblocking note."], "changes_requested"),
        ("approved", [], [123], "inconclusive"),
    ],
)
def test_invalid_provider_contract_never_approves_or_falls_back(
    setup, daemon, monkeypatch, decision, blockers, notes, expected
):
    config, request, _ = prepare(setup, monkeypatch)
    response = verdict()
    response["structured_output"] = dict(decision=decision, blocking_findings=blockers, notes=notes)
    calls = provider(monkeypatch, [response])
    result = asyncio.run(review.review_candidate(request.model_dump(mode="json")))
    assert result["disposition"] == expected
    evidence = json.loads((config.artifact_root / f"{request.operation_id}-review.txt").read_text())
    assert evidence["schema_version"] == "birbcrew.review-evidence.v2"
    if expected == "inconclusive":
        assert evidence["verdict"] is None
    assert len(calls) == 1 and daemon.starts == 1

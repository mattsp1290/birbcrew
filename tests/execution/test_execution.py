import asyncio
import copy
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from birbcrew.execution import author, journal, publish
from birbcrew.execution.contract import (
    ApprovedGoal,
    Candidate,
    ExecutionInput,
    GoalOffer,
    PublicationInput,
    ReviewReceipt,
    digest,
)
from birbcrew.execution.policy import ExecutionSettings, Repository


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


@pytest.fixture
def setup(tmp_path, monkeypatch):
    checkout = tmp_path / "repo"
    checkout.mkdir()
    git(checkout, "init", "-b", "main")
    git(
        checkout,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "base",
    )
    git(checkout, "remote", "add", "origin", "git@github.com:example/factory.git")
    repo = Repository(
        repository_id="example/factory",
        checkout=checkout,
        remote="git@github.com:example/factory.git",
        base_branch="main",
        allowed_paths=("docs/guide.md",),
        acceptance_id="docs-v1",
        acceptance_command=("/usr/bin/true",),
    )
    config = ExecutionSettings(
        repository=repo,
        worktree_root=tmp_path / "work",
        artifact_root=tmp_path / "artifacts",
        codex=Path("/bin/false"),
        claude=Path("/bin/false"),
        git=Path(shutil.which("git")),
        gh=Path("/bin/false"),
        task_queue="test",
        binding_revision=repo.revision,
    )
    config.artifact_root.mkdir()
    text = "Write docs/guide.md."
    offer = GoalOffer(
        offer_id="test-goal",
        goal_ref={
            "project": "factory",
            "record_id": "request-1",
            "revision": "1",
            "content_sha256": hashlib.sha256(text.encode()).hexdigest(),
        },
        title="Document pilot",
        goal_text=text,
        repository_id=repo.repository_id,
        base_commit=git(checkout, "rev-parse", "HEAD"),
        policy_revision=repo.revision,
        allowed_paths=repo.allowed_paths,
        acceptance_id=repo.acceptance_id,
    )
    request = ExecutionInput(
        operation_id=uuid4(),
        approved_goal=ApprovedGoal(
            delivery_id=uuid4(),
            conversation_id=uuid4(),
            owner_principal="owner",
            approval_command_id=uuid4(),
            offer=offer,
            offer_sha256=digest(offer),
        ),
    )
    records = {}

    async def claim(kind, identity, value):
        key = (kind, identity)
        fresh = key not in records
        if fresh:
            records[key] = (digest(value), {"phase": "claimed"})
        checksum, state = records[key]
        if checksum != digest(value):
            raise ValueError("operation_payload_conflict")
        return fresh, copy.deepcopy(state)

    async def save(kind, identity, state):
        key = (kind, identity)
        if records[key][1]["phase"] != "terminal":
            records[key] = (records[key][0], copy.deepcopy(state))

    async def replace(kind, identity, expected, state):
        key = (kind, identity)
        if records[key][1] != expected:
            return False
        records[key] = (records[key][0], copy.deepcopy(state))
        return True

    async def receipt(kind, identity, expected):
        row = records.get((kind, identity))
        return copy.deepcopy(row[1].get("result")) if row and row[0] == digest(expected) else None

    monkeypatch.setattr(journal, "receipt", receipt)
    monkeypatch.setattr(journal, "claim", claim)
    monkeypatch.setattr(journal, "save", save)
    monkeypatch.setattr(journal, "replace", replace)
    monkeypatch.setattr(author, "installation", lambda: config)
    monkeypatch.setattr(publish, "installation", lambda: config)
    monkeypatch.setattr(author.activity, "heartbeat", lambda *args: None)
    return config, request, records


class OwnedDaemon:
    starts = 0
    turns = []
    lose_ack = False
    work = None

    def __init__(self, *_):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def call(self, method, params):
        if method == "thread/start":
            self.__class__.work = Path(params["cwd"])
            return {"thread": {"id": "owned-thread"}}
        if method == "turn/start":
            self.__class__.starts += 1
            assert not params["sandboxPolicy"]["networkAccess"]
            (self.work / "docs").mkdir(exist_ok=True)
            (self.work / "docs/guide.md").write_text("# Approved guide\n")
            self.__class__.turns = [{"id": "owned-turn", "status": "completed"}]
            if self.lose_ack:
                raise ConnectionError("lost_reply")
            return {"turn": self.turns[0]}
        if method == "thread/turns/list":
            assert params["threadId"] == "owned-thread"
            assert params["itemsView"] == "notLoaded"
            return {"data": self.turns}
        if method == "thread/resume":
            assert params["excludeTurns"] is True
            return {}
        raise AssertionError(method)


@pytest.fixture
def daemon(monkeypatch):
    OwnedDaemon.starts = 0
    OwnedDaemon.turns = []
    OwnedDaemon.lose_ack = False
    monkeypatch.setattr(author, "Daemon", OwnedDaemon)
    return OwnedDaemon


def test_real_git_candidate_and_replay_without_second_writer(setup, daemon):
    config, request, _ = setup
    result = asyncio.run(author.author_goal(request.model_dump(mode="json")))
    assert result["status"] == "candidate"
    candidate = Candidate.model_validate(result["candidate"])
    assert (
        git(config.worktree(request), "show", f"{candidate.head_commit}:docs/guide.md")
        == "# Approved guide"
    )
    assert candidate.base_commit == request.approved_goal.offer.base_commit
    assert asyncio.run(author.author_goal(request.model_dump(mode="json"))) == result
    assert daemon.starts == 1


def test_lost_turn_reply_recovers_only_known_thread(setup, daemon):
    _, request, _ = setup
    daemon.lose_ack = True
    raw = request.model_dump(mode="json")
    assert asyncio.run(author.author_goal(raw))["status"] == "uncertain"
    assert asyncio.run(author.author_goal(raw))["status"] == "candidate"
    assert daemon.starts == 1


def test_empty_known_thread_does_not_resubmit(setup, daemon):
    _, request, records = setup
    raw = request.model_dump(mode="json")
    records[("author", str(request.operation_id))] = (
        digest(raw),
        {"phase": "submitting", "thread_id": "owned-thread"},
    )
    assert asyncio.run(author.author_goal(raw))["status"] == "uncertain"
    assert daemon.starts == 0


def test_scope_rejection_cannot_freeze_extra_file(setup, daemon, monkeypatch):
    config, request, _ = setup
    original = daemon.call

    async def call(self, method, params):
        value = await original(self, method, params)
        if method == "turn/start":
            (self.work / "outside.txt").write_text("not approved")
        return value

    monkeypatch.setattr(daemon, "call", call)
    result = asyncio.run(author.author_goal(request.model_dump(mode="json")))
    assert result["status"] == "blocked"
    assert (
        git(config.worktree(request), "rev-parse", "HEAD")
        == request.approved_goal.offer.base_commit
    )


def test_changed_approval_or_execution_payload_rejected(setup, daemon):
    _, request, _ = setup
    raw = request.model_dump(mode="json")
    raw["approved_goal"]["offer"]["goal_text"] = "Changed"
    with pytest.raises(ValidationError):
        ExecutionInput.model_validate(raw)
    raw = request.model_dump(mode="json")
    asyncio.run(author.author_goal(raw))
    raw["approved_goal"]["owner_principal"] = "other"
    with pytest.raises(ValueError, match="operation_payload_conflict"):
        asyncio.run(author.author_goal(raw))


def publication_request(request, candidate):
    review = ReviewReceipt(
        candidate_commit=candidate.head_commit,
        disposition="approved",
        findings_digest="a" * 64,
        evidence_ref="execution/test/review",
    )
    return PublicationInput(**request.model_dump(), candidate=candidate, review=review)


def test_publication_lost_reply_reconciles_without_second_create(setup, daemon, monkeypatch):
    config, request, records = setup
    candidate = Candidate.model_validate(
        asyncio.run(author.author_goal(request.model_dump(mode="json")))["candidate"]
    )
    publication = publication_request(request, candidate)
    raw = publication.model_dump(mode="json")
    review_raw = {k: v for k, v in raw.items() if k != "review"}
    records[("review", str(request.operation_id))] = (
        digest(review_raw),
        {"phase": "terminal", "result": publication.review.model_dump(mode="json")},
    )
    writes = []
    pr = []
    original_git = publish.git

    async def fake_git(config, work, *args):
        if args[0] == "ls-remote":
            return candidate.head_commit + "\trefs/heads/" + candidate.branch if writes else ""
        if args[0] == "push":
            writes.append("push")
            return ""
        return await original_git(config, work, *args)

    async def fake_command(argv, cwd, **kwargs):
        if "list" in argv:
            return json.dumps(pr)
        writes.append("create")
        pr.append(
            {
                "number": 1,
                "url": "https://github.com/example/factory/pull/1",
                "isDraft": True,
                "headRefOid": candidate.head_commit,
                "baseRefName": "main",
                "state": "OPEN",
                "body": publish.marker(publication),
            }
        )
        raise RuntimeError("lost_reply")

    monkeypatch.setattr(publish, "git", fake_git)
    monkeypatch.setattr(publish, "command", fake_command)
    assert asyncio.run(publish.publish_draft(raw))["status"] == "uncertain"
    assert asyncio.run(publish.publish_draft(raw))["status"] == "draft_ready"
    assert writes == ["push", "create"]


def test_changed_candidate_cannot_use_prior_review(setup, daemon):
    _, request, _ = setup
    candidate = Candidate.model_validate(
        asyncio.run(author.author_goal(request.model_dump(mode="json")))["candidate"]
    )
    raw = publication_request(request, candidate).model_dump(mode="json")
    raw["candidate"]["head_commit"] = "f" * 40
    with pytest.raises(ValidationError, match="review_not_approved"):
        PublicationInput.model_validate(raw)


def test_installer_cannot_allow_arbitrary_code(setup):
    config, _, _ = setup
    raw = config.repository.model_dump()
    raw["allowed_paths"] = ("scripts/run.sh",)
    with pytest.raises(ValidationError, match="documentation_paths"):
        Repository.model_validate(raw)


def test_stale_checkpoint_cannot_overwrite_candidate_receipt(setup):
    _, request, records = setup
    raw = request.model_dump(mode="json")
    identity = str(request.operation_id)
    asyncio.run(journal.claim("author", identity, raw))
    starting = {"phase": "claimed"}
    terminal = {"phase": "terminal", "result": {"status": "cancelled", "reason": "confirmed"}}
    assert asyncio.run(journal.replace("author", identity, starting, terminal))
    with pytest.raises(RuntimeError, match="checkpoint_owned_elsewhere"):
        asyncio.run(author.advance(identity, starting, phase="running"))
    assert records[("author", identity)][1] == terminal


def test_interrupted_turn_with_delayed_absolute_writer_stays_uncertain(setup, daemon):
    config, request, _ = setup
    work = config.worktree(request)
    work.mkdir(parents=True)
    target = work / "late.txt"
    daemon.turns = [{"id": "owned-turn", "status": "interrupted"}]
    process = subprocess.Popen(
        ["/bin/sh", "-c", 'cd /; sleep 3; printf late > "$1"', "probe", str(target)],
        cwd=work,
    )
    try:
        state = {"thread_id": "owned-thread", "turn_id": "owned-turn"}
        result = asyncio.run(author.interrupt(config, state, work))
        assert result == {"status": "uncertain", "reason": "cancellation_stop_unconfirmed"}
        assert process.poll() is None
        assert not target.exists()
        process.wait(timeout=5)
        assert target.read_text() == "late"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def test_generated_contract_matches_committed_schema():
    from birbcrew.execution.schema import schemas

    path = Path(__file__).parents[2] / "contracts/execution.v1/schema.json"
    assert json.loads(path.read_text()) == schemas()


def test_subscription_command_strips_api_override(tmp_path, monkeypatch):
    import sys

    from birbcrew.execution.process import command

    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-pass")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "must-not-pass")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    text = asyncio.run(
        command(
            [
                sys.executable,
                "-c",
                (
                    "import os; assert not any(k.startswith('ANTHROPIC_') or "
                    "k.startswith('CLAUDE_CODE_USE_') for k in os.environ); print('subscription')"
                ),
            ],
            tmp_path,
            subscription=True,
        )
    )
    assert text.strip() == "subscription"



def test_existing_document_modification_keeps_porcelain_leading_column(setup, daemon):
    config, request, _ = setup
    checkout = config.repository.checkout
    (checkout / "docs").mkdir()
    (checkout / "docs/guide.md").write_text("Old guide\n")
    git(checkout, "add", "docs/guide.md")
    git(
        checkout,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "existing document",
    )
    raw = request.model_dump(mode="json")
    raw["approved_goal"]["offer"]["base_commit"] = git(checkout, "rev-parse", "HEAD")
    raw["approved_goal"]["offer_sha256"] = digest(raw["approved_goal"]["offer"])
    result = asyncio.run(author.author_goal(raw))
    assert result["status"] == "candidate", result
    assert result["candidate"]["changed_paths"] == ["docs/guide.md"]

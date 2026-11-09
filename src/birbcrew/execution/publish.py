import asyncio
import json

from temporalio import activity

from birbcrew.execution import journal
from birbcrew.execution.contract import DraftReceipt, PublicationInput
from birbcrew.execution.policy import installation
from birbcrew.execution.process import command, git


def marker(request):
    return (
        f"<!-- birbforge-delivery:{request.approved_goal.delivery_id} "
        f"offer:{request.approved_goal.offer_sha256} -->"
    )


async def existing_pr(config, request):
    repo = config.repository.remote.removeprefix("git@github.com:").removesuffix(".git")
    rows = json.loads(
        await command(
            [
                str(config.gh),
                "pr",
                "list",
                "--repo",
                repo,
                "--head",
                request.candidate.branch,
                "--state",
                "all",
                "--json",
                "number,url,isDraft,headRefOid,baseRefName,state,body",
            ],
            config.artifact_root,
        )
    )
    if not rows:
        return None
    if len(rows) != 1:
        raise ValueError("publication_identity_conflict")
    row = rows[0]
    if marker(request) not in row.get("body", ""):
        raise ValueError("publication_ownership_conflict")
    if (row["headRefOid"], row["baseRefName"], row["isDraft"], row["state"]) != (
        request.candidate.head_commit,
        config.repository.base_branch,
        True,
        "OPEN",
    ):
        raise ValueError("publication_identity_conflict")
    return DraftReceipt(
        repository_id=request.candidate.repository_id,
        head_commit=request.candidate.head_commit,
        base_branch=row["baseRefName"],
        number=row["number"],
        url=row["url"],
    ).model_dump(mode="json")


async def validate_base_branch(config, request):
    checkout = config.repository.checkout
    remote = await git(
        config,
        checkout,
        "ls-remote",
        config.repository.remote,
        f"refs/heads/{config.repository.base_branch}",
    )
    rows = remote.splitlines()
    if len(rows) != 1:
        raise ValueError("base_branch_unconfirmed")
    tip, ref = rows[0].split()
    if ref != f"refs/heads/{config.repository.base_branch}":
        raise ValueError("base_branch_unconfirmed")
    await git(config, checkout, "fetch", "--no-tags", config.repository.remote, tip)
    try:
        await git(
            config, checkout, "merge-base", "--is-ancestor", request.candidate.base_commit, tip
        )
    except RuntimeError as error:
        raise ValueError("candidate_base_not_on_target_branch") from error


@activity.defn(name="birbcrew.publish_draft.v1")
async def publish_draft(raw: dict) -> dict:
    request = PublicationInput.model_validate(raw)
    config = installation()
    config.authorize(request)
    identity = str(request.operation_id)
    fresh, state = await journal.claim("publish", identity, raw)
    if "result" in state:
        return state["result"]
    work = config.worktree(request)
    effects_started = not fresh
    try:
        if await git(
            config, work, "rev-parse", "HEAD"
        ) != request.candidate.head_commit or await git(config, work, "status", "--porcelain"):
            raise ValueError("candidate_changed_after_review")
        author = await journal.receipt(
            "author",
            identity,
            {k: v for k, v in raw.items() if k not in {"candidate", "review", "review_attempt"}},
        )
        if not author or author.get("candidate") != request.candidate.model_dump(mode="json"):
            raise ValueError("candidate_not_author_receipt")
        review = await journal.receipt(
            "review", request.review_identity, {k: v for k, v in raw.items() if k != "review"}
        )
        if review != request.review.model_dump(mode="json"):
            raise ValueError("review_not_producer_receipt")
        remote = await git(
            config,
            config.repository.checkout,
            "ls-remote",
            config.repository.remote,
            f"refs/heads/{request.candidate.branch}",
        )
        if remote and remote.split()[0] != request.candidate.head_commit:
            raise ValueError("remote_candidate_conflict")
        result = await existing_pr(config, request)
        if result is not None and not remote:
            raise ValueError("published_branch_missing")
        if result is None:
            if not fresh:
                return {
                    "status": "uncertain",
                    "reason": "publication_intent_requires_reconciliation",
                }
            await validate_base_branch(config, request)
            await journal.save("publish", identity, {"phase": "submitting"})
            effects_started = True
            if not remote:
                await git(
                    config,
                    config.repository.checkout,
                    "push",
                    config.repository.remote,
                    f"{request.candidate.head_commit}:refs/heads/{request.candidate.branch}",
                )
            repo = config.repository.remote.removeprefix("git@github.com:").removesuffix(".git")
            body = (
                marker(request) + "\n\n"
                f"Approved documentation goal {request.approved_goal.offer.goal_ref.record_id}.\n\n"
                f"Candidate `{request.candidate.head_commit}` passed the installed "
                "documentation check "
                "and an independent Claude review. This is a draft for owner review.\n\n"
                "No staging, native candidate verification, merge or deployment was performed."
            )
            await command(
                [
                    str(config.gh),
                    "pr",
                    "create",
                    "--repo",
                    repo,
                    "--draft",
                    "--head",
                    request.candidate.branch,
                    "--base",
                    config.repository.base_branch,
                    "--title",
                    request.approved_goal.offer.title,
                    "--body-file",
                    "-",
                ],
                config.artifact_root,
                text=body,
            )
            result = await existing_pr(config, request)
            if result is None:
                return {"status": "uncertain", "reason": "draft_readback_missing"}
    except asyncio.CancelledError:
        return {"status": "uncertain", "reason": "publication_cancellation_needs_readback"}
    except ValueError:
        if effects_started:
            return {"status": "uncertain", "reason": "publication_readback_requires_reconciliation"}
        result = {"status": "blocked", "reason": "publication_identity_conflict"}
    except Exception:
        return {"status": "uncertain", "reason": "publication_reply_missing"}
    await journal.save("publish", identity, {"phase": "terminal", "result": result})
    return result

import asyncio
import hashlib
import secrets
from contextlib import asynccontextmanager
from datetime import timedelta
from uuid import UUID

from ag_ui.core import (
    Event,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
)
from ag_ui.encoder import EventEncoder
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import (
    WorkflowUpdateFailedError,
    WorkflowUpdateRPCTimeoutOrCancelledError,
)
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from birbcrew import store
from birbcrew.config import settings, temporal_client
from birbcrew.domain import (
    Conversation,
    CreateConversation,
    CreateProjectConversation,
    HumanReply,
    ProjectCoworker,
    ProjectPrompt,
    Prompt,
    Resolution,
    workflow_id,
)


@asynccontextmanager
async def lifespan(app):
    app.state.temporal = await temporal_client(plugins=[PydanticAIPlugin()])
    yield


app = FastAPI(lifespan=lifespan)
EVENT_ADAPTER = TypeAdapter(Event)


def owner(authorization: str = Header(default="")) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "authentication_required")
    digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
    for principal, expected in settings().token_hashes.items():
        if secrets.compare_digest(digest, expected):
            return principal
    raise HTTPException(401, "authentication_required")


def project_service(x_birbforge_project_token: str = Header(default="")) -> None:
    expected = settings().project_service_token_sha256
    digest = hashlib.sha256(x_birbforge_project_token.encode()).hexdigest()
    if not expected or not secrets.compare_digest(digest, expected):
        raise HTTPException(403, "trusted_project_service_required")


async def authorized(cid: UUID, principal: str) -> dict:
    result = await store.snapshot(str(cid), principal)
    if result is None:
        raise HTTPException(404, "conversation_not_found")
    return result


@app.get("/health")
async def health():
    return {"status": "ready"}


@app.post("/conversations")
async def create(body: CreateConversation, principal: str = Depends(owner)):
    state = Conversation(id=str(body.id), owner=principal, context=settings().context)
    await store.create(state)
    existing = await authorized(body.id, principal)
    if existing.get("kind") == "project":
        raise HTTPException(409, "project_conversation_requires_trusted_route")
    if settings().mode == "approved-goal":
        return {**existing, "mode": "approved-goal"}
    if existing["revision"] > 0:
        return existing
    state = Conversation.model_validate({k: v for k, v in existing.items() if k != "cursor"})
    try:
        await app.state.temporal.start_workflow(
            "ConversationWorkflow",
            args=[state, settings().interrupt_after_effect],
            id=workflow_id(state.id),
            task_queue=settings().task_queue,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )
    except WorkflowAlreadyStartedError:
        pass
    return existing


@app.post("/internal/project-conversations", dependencies=[Depends(project_service)])
async def create_project(body: CreateProjectConversation, principal: str = Depends(owner)):
    state = Conversation(
        id=str(body.id),
        owner=principal,
        context=body.context.notes,
        kind="project",
        coworker=ProjectCoworker(),
        project_context=body.context,
    )
    await store.create(state)
    existing = await authorized(body.id, principal)
    if existing.get("kind") != "project" or existing.get("context_sha256") != body.context.digest:
        raise HTTPException(409, "conversation_context_conflict")
    if existing["revision"] == 0:
        try:
            await app.state.temporal.start_workflow(
                "ProjectConversationWorkflow",
                state,
                id=workflow_id(state.id),
                task_queue=settings().project_task_queue or settings().task_queue + "-projects",
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
        except WorkflowAlreadyStartedError:
            pass
    return existing


@app.post("/internal/project-conversations/{cid}/inputs", dependencies=[Depends(project_service)])
async def submit_project(cid: UUID, prompt: ProjectPrompt, principal: str = Depends(owner)):
    state = await authorized(cid, principal)
    if state.get("kind") != "project" or state.get("context_sha256") != prompt.context_sha256:
        raise HTTPException(409, "project_context_conflict")
    for accepted in state["inputs"]:
        if accepted["request_id"] == str(prompt.request_id):
            if accepted["digest"] != prompt.digest:
                raise HTTPException(409, "request_payload_conflict")
            return accepted
    return await update(cid, principal, "submit", prompt)


@app.post(
    "/internal/project-conversations/{cid}/reconcile", dependencies=[Depends(project_service)]
)
async def reconcile_project(cid: UUID, prompt: ProjectPrompt, principal: str = Depends(owner)):
    state = await authorized(cid, principal)
    if state.get("kind") != "project" or state.get("context_sha256") != prompt.context_sha256:
        raise HTTPException(409, "project_context_conflict")
    accepted = next(
        (item for item in state["inputs"] if item["request_id"] == str(prompt.request_id)), None
    )
    if accepted is None:
        try:
            handle = app.state.temporal.get_workflow_handle(workflow_id(str(cid)))
            accepted = await handle.query(
                "accepted_input", str(prompt.request_id), rpc_timeout=timedelta(seconds=15)
            )
        except RPCError as error:
            raise HTTPException(503, "project_receipt_observation_unavailable") from error
    if accepted is None:
        return {"accepted": False}
    if accepted["digest"] != prompt.digest:
        raise HTTPException(409, "request_payload_conflict")
    return {"accepted": True, "input": accepted}


@app.get("/conversations/{cid}")
async def get_state(cid: UUID, principal: str = Depends(owner)):
    value = await authorized(cid, principal)
    return (
        {**value, "mode": settings().mode}
        if settings().mode == "approved-goal" and value.get("kind") != "project"
        else value
    )


@app.get("/conversations")
async def list_conversations(project_id: str | None = None, principal: str = Depends(owner)):
    return await store.conversations_for_owner(principal, project_id=project_id)


async def update(cid: UUID, principal: str, name: str, value):
    state = await authorized(cid, principal)
    if settings().mode == "approved-goal" and state.get("kind") != "project":
        raise HTTPException(409, "approved_goal_mode_requires_delivery_command")
    if state["phase"] in {"cancelled", "failed"}:
        raise HTTPException(409, "conversation_closed")
    try:
        handle = app.state.temporal.get_workflow_handle(workflow_id(str(cid)))
        return await handle.execute_update(name, value, rpc_timeout=timedelta(seconds=30))
    except RPCError as error:
        status = 409 if error.status == RPCStatusCode.NOT_FOUND else 503
        raise HTTPException(status, "workflow_unavailable_retry_same_request") from error
    except WorkflowUpdateRPCTimeoutOrCancelledError as error:
        raise HTTPException(503, "acknowledgement_pending_retry_same_request") from error
    except WorkflowUpdateFailedError as error:
        raise HTTPException(409, str(error.cause)) from error


@app.post("/conversations/{cid}/inputs")
async def submit(cid: UUID, prompt: Prompt, principal: str = Depends(owner)):
    state = await authorized(cid, principal)
    if state.get("kind") == "project":
        raise HTTPException(403, "trusted_project_service_required")
    for accepted in state["inputs"]:
        if accepted["request_id"] == str(prompt.request_id):
            if accepted["digest"] != prompt.digest:
                raise HTTPException(409, "request_payload_conflict")
            return accepted
    return await update(cid, principal, "submit", prompt)


@app.post("/conversations/{cid}/human")
async def resolve(cid: UUID, response: HumanReply, principal: str = Depends(owner)):
    if (await authorized(cid, principal)).get("kind") == "project":
        raise HTTPException(409, "project_chat_has_no_synthetic_human_tool")
    command = Resolution(**response.model_dump(), actor=principal)
    return await update(cid, principal, "resolve", command)


@app.post("/conversations/{cid}/cancel", status_code=202)
async def cancel(cid: UUID, principal: str = Depends(owner)):
    state = await authorized(cid, principal)
    if state["phase"] in {"cancelled", "failed"}:
        return {"acknowledgement": state["phase"], "conversation_id": str(cid)}
    return await update(cid, principal, "cancel", principal)


@app.post("/conversations/{cid}/events")
async def events(
    cid: UUID, body: RunAgentInput, after: int | None = None, principal: str = Depends(owner)
):
    initial = await authorized(cid, principal)
    if body.thread_id != str(cid):
        raise HTTPException(409, "thread_mismatch")
    if after is not None:
        if after != initial["cursor"]:
            raise HTTPException(410, "cursor_expired_get_fresh_snapshot")
        try:
            await store.events_after(str(cid), after)
        except ValueError as error:
            raise HTTPException(410, "cursor_expired_get_fresh_snapshot") from error
    encoder = EventEncoder()

    async def stream():
        cursor = initial["cursor"] if after is None else after
        yield encoder.encode(RunStartedEvent(thread_id=str(cid), run_id=body.run_id))
        yield encoder.encode(MessagesSnapshotEvent(messages=initial["messages"]))
        yield f"id: {cursor}\n" + encoder.encode(
            StateSnapshotEvent(
                snapshot={
                    **(
                        {"mode": "approved-goal"}
                        if settings().mode == "approved-goal" and initial.get("kind") != "project"
                        else {}
                    ),
                    **{
                        k: v
                        for k, v in initial.items()
                        if k not in {"messages", "native_messages", "owner"}
                    },
                }
            )
        )
        phase = initial["phase"]
        async with await store.connect() as db:
            while True:
                if phase in {"cancelled", "failed"}:
                    terminal = (
                        RunFinishedEvent(
                            thread_id=str(cid), run_id=body.run_id, outcome={"type": "cancelled"}
                        )
                        if phase == "cancelled"
                        else RunErrorEvent(message="conversation_failed")
                    )
                    yield encoder.encode(terminal)
                    return
                try:
                    _, rows = await store.read_events(db, str(cid), cursor)
                except ValueError:
                    yield encoder.encode(
                        RunErrorEvent(
                            message="cursor_expired_get_fresh_snapshot", code="CURSOR_EXPIRED"
                        )
                    )
                    return
                for row in rows:
                    event = EVENT_ADAPTER.validate_python(row["payload"])
                    if event.type == "RUN_STARTED":
                        event = StepStartedEvent(step_name=event.run_id)
                    elif event.type == "RUN_FINISHED":
                        event = StepFinishedEvent(step_name=event.run_id)
                    elif event.type == "STATE_SNAPSHOT":
                        phase = event.snapshot.get("phase", phase)
                        event.snapshot["cursor"] = row["cursor"]
                    yield f"id: {row['cursor']}\n" + encoder.encode(event)
                    cursor = row["cursor"]
                    if event.type == "RUN_ERROR":
                        return
                await asyncio.sleep(0.1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

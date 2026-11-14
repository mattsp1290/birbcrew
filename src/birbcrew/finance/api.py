from datetime import timedelta
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from birbcrew.config import settings
from birbcrew.domain import Conversation, workflow_id
from birbcrew.finance import thread_store
from birbcrew.finance.identity import EXTENSION, GoService


class Initialize(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def owner(value: str) -> thread_store.FinanceOwner:
    try:
        return thread_store.FinanceOwner(value)
    except ValueError as error:
        raise HTTPException(422, "invalid_finance_owner") from error


async def ensure_workflow(state: dict, temporal) -> None:
    wid = workflow_id(state["id"])
    try:
        if state["revision"] > 0:
            try:
                await temporal.get_workflow_handle(wid).describe(rpc_timeout=timedelta(seconds=10))
            except RPCError as error:
                if error.status == RPCStatusCode.NOT_FOUND:
                    raise HTTPException(503, "finance_workflow_recovery_required") from error
                raise
        else:
            initial = Conversation.model_validate({k: v for k, v in state.items() if k != "cursor"})
            await temporal.start_workflow(
                "ConversationWorkflow",
                args=[initial, False],
                id=wid,
                task_queue=settings().task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                rpc_timeout=timedelta(seconds=10),
            )
    except WorkflowAlreadyStartedError:
        pass
    except RPCError as error:
        raise HTTPException(503, "finance_start_pending_retry_initialize") from error


def create_app(temporal) -> FastAPI:
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def provenance(request: Request, call_next):
        if not isinstance(request.scope.get("extensions", {}).get(EXTENSION), GoService):
            from fastapi.responses import JSONResponse

            return JSONResponse({"detail": "verified_go_service_required"}, status_code=403)
        return await call_next(request)

    prefix = "/internal/v1/finance/owners/{owner_id}"

    @app.post(prefix + "/thread")
    async def initialize(owner_id: str, body: Initialize):
        thread = await thread_store.initialize(owner(owner_id))
        state = await thread_store.snapshot(thread)
        await ensure_workflow(state, temporal)
        return state

    @app.get(prefix + "/threads/{cid}/snapshot")
    async def snapshot(owner_id: str, cid: UUID):
        result = await thread_store.require(owner(owner_id), cid)
        if result is None:
            raise HTTPException(404, "conversation_not_found")
        return result[1]

    return app

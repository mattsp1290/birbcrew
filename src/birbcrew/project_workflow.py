import asyncio
import hashlib
import json
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from pydantic_ai.durable_exec.temporal import AgentEventStream, PydanticAIWorkflow
    from pydantic_ai.messages import (
        ModelMessagesTypeAdapter,
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )
    from pydantic_ai.usage import UsageLimits
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from birbcrew.domain import (
        MAX_PROJECT_INPUT_BYTES,
        MAX_PROJECT_NATIVE_BYTES,
        MAX_PROJECT_TURNS,
        AcceptedInput,
        Conversation,
        Phase,
        Projection,
        ProjectPrompt,
        RunAttempt,
        RunDeps,
    )
    from birbcrew.project_runtime import (
        agent,
        project_conversation_events,
        save_project_conversation,
        validate_project_provider,
    )
    from birbcrew.provider import project_model_settings


MAX_PROJECT_RECEIPTS = 20
MAX_PROJECT_REJECTED_RECEIPTS = 4
MAX_PROJECT_RETAINED_INPUT_BYTES = 65536
PROJECT_RESPONSE_RESERVE = 65536
PROJECT_MESSAGE_RESERVE = 4096


def native_bytes(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


@workflow.defn
class ProjectConversationWorkflow(PydanticAIWorkflow):
    __pydantic_ai_agents__ = [agent]

    @workflow.init
    def __init__(self, state: Conversation):
        if state.kind != "project" or state.project_context is None:
            raise ValueError("project_context_required")
        self.state = state
        self.events = AgentEventStream(drain_timeout=timedelta(seconds=2))
        self.cancel_requested = False
        self.agent_task = None
        self.offset = 0

    @workflow.update
    def submit(self, prompt: ProjectPrompt) -> dict:
        self.validate_submit(prompt)
        for accepted in self.state.inputs:
            if accepted.request_id == str(prompt.request_id):
                return accepted.model_dump(mode="json")
        accepted = AcceptedInput(
            request_id=str(prompt.request_id),
            digest=prompt.digest,
            text=prompt.text,
            ordinal=len(self.state.inputs),
            outcome="accepted",
        )
        self.state.inputs.append(accepted)
        return accepted.model_dump(mode="json")

    @submit.validator
    def validate_submit(self, prompt: ProjectPrompt) -> None:
        if prompt.context_sha256 != self.state.project_context.digest:
            raise ApplicationError("project_context_conflict", non_retryable=True)
        for accepted in self.state.inputs:
            if accepted.request_id == str(prompt.request_id):
                if accepted.digest != prompt.digest:
                    raise ApplicationError("request_payload_conflict", non_retryable=True)
                return
        if self.cancel_requested or self.state.phase in {Phase.CANCELLED, Phase.FAILED}:
            raise ApplicationError("conversation_closed", non_retryable=True)
        if (
            len(self.state.inputs) >= MAX_PROJECT_RECEIPTS
            or len(self.state.inputs) - len(self.usable_inputs()) >= MAX_PROJECT_REJECTED_RECEIPTS
            or sum(len(item.text.encode()) for item in self.state.inputs)
            + len(prompt.text.encode())
            > MAX_PROJECT_RETAINED_INPUT_BYTES
            or len(self.usable_inputs()) >= MAX_PROJECT_TURNS
            or sum(len(item.text.encode()) for item in self.usable_inputs())
            + len(prompt.text.encode())
            > MAX_PROJECT_INPUT_BYTES
            or native_bytes(self.state.native_messages) > MAX_PROJECT_NATIVE_BYTES // 2
        ):
            raise ApplicationError("new_chat_required", non_retryable=True)

    @workflow.query
    def accepted_input(self, request_id: str) -> dict | None:
        for accepted in self.state.inputs:
            if accepted.request_id == request_id:
                return accepted.model_dump(mode="json")
        return None

    def usable_inputs(self):
        attempted = {attempt.request_id for attempt in self.state.attempts}
        return [
            item
            for item in self.state.inputs
            if item.outcome in {"accepted", "running", "waiting", "completed"}
            or item.request_id in attempted
        ]

    @workflow.update
    def cancel(self, actor: str) -> dict:
        if actor != self.state.owner:
            raise ApplicationError("forbidden", non_retryable=True)
        self.cancel_requested = True
        if self.agent_task and not self.agent_task.done():
            self.agent_task.cancel()
        return {"acknowledgement": "requested", "conversation_id": self.state.id}

    async def persist(self):
        self.state.revision += 1
        canonical = await workflow.execute_activity(
            save_project_conversation,
            self.state.model_copy(deep=True),
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(non_retryable_error_types=["ValueError"]),
        )
        self.state.native_messages = canonical.native_messages
        self.state.messages = canonical.messages

    async def segment(self, accepted: AcceptedInput):
        required = (
            native_bytes(self.state.native_messages)
            + native_bytes(accepted.text)
            + PROJECT_RESPONSE_RESERVE
            + PROJECT_MESSAGE_RESERVE
        )
        if required > MAX_PROJECT_NATIVE_BYTES:
            accepted.outcome = "failed"
            self.state.failure = "project_history_headroom_exhausted_not_dispatched"
            self.state.phase = Phase.IDLE
            await self.persist()
            return False
        try:
            await workflow.execute_activity(
                validate_project_provider,
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
        except Exception:
            accepted.outcome = "failed"
            self.state.failure = "provider_preflight_rejected_not_dispatched"
            self.state.phase = Phase.IDLE
            await self.persist()
            return False
        if self.cancel_requested:
            accepted.outcome = "cancelled"
            return False
        run_id = str(uuid5(NAMESPACE_URL, f"project/{self.state.id}/{accepted.request_id}"))
        attempt = RunAttempt(
            id=run_id,
            workflow_id=workflow.info().workflow_id,
            workflow_run_id=workflow.info().run_id,
            request_id=accepted.request_id,
            outcome="prepared",
        )
        self.state.attempts.append(attempt)
        self.state.phase = Phase.RUNNING
        accepted.outcome = "running"
        await self.persist()
        if self.cancel_requested:
            attempt.outcome = "not_dispatched"
            accepted.outcome = "cancelled"
            return False
        projection = workflow.start_activity(
            project_conversation_events,
            Projection(
                conversation_id=self.state.id,
                workflow_id=workflow.info().workflow_id,
                run_id=run_id,
                offset=self.offset,
            ),
            start_to_close_timeout=timedelta(minutes=10),
            heartbeat_timeout=timedelta(seconds=3),
            retry_policy=RetryPolicy(non_retryable_error_types=["ValueError"]),
            cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        )
        attempt.outcome = "running"
        self.agent_task = asyncio.create_task(
            agent.run(
                accepted.text,
                message_history=ModelMessagesTypeAdapter.validate_python(
                    self.state.native_messages
                ),
                deps=RunDeps(
                    run_id=run_id,
                    conversation_id=self.state.id,
                    request_id=accepted.request_id,
                    operation_id=f"{self.state.id}/{accepted.request_id}",
                    text=accepted.text,
                ),
                conversation_id=self.state.id,
                run_id=run_id,
                instructions="Frozen project context.\n"
                + self.state.project_context.model_dump_json(),
                model_settings=project_model_settings(self.state.id),
                usage_limits=UsageLimits(request_limit=1, tool_calls_limit=0),
            )
        )
        try:
            if self.cancel_requested:
                self.agent_task.cancel()
            result = await self.agent_task
            self.offset = await projection
            native = ModelMessagesTypeAdapter.dump_python(result.all_messages(), mode="json")
            for message in native:
                if message.get("kind") == "request":
                    message["instructions"] = None
            if native_bytes(native) > MAX_PROJECT_NATIVE_BYTES:
                digest = hashlib.sha256(
                    json.dumps(native, ensure_ascii=False, separators=(",", ":")).encode()
                ).hexdigest()
                text = "\n".join(
                    part.get("content", "")
                    for message in native[len(self.state.native_messages) :]
                    if message.get("kind") == "response"
                    for part in message.get("parts", [])
                    if part.get("part_kind") == "text"
                )
                preview = text.encode()[:16000].decode("utf8", errors="ignore")
                confirmed = [
                    ModelRequest(
                        parts=[UserPromptPart(accepted.text, timestamp=workflow.now())],
                        timestamp=workflow.now(),
                    ),
                    ModelResponse(
                        timestamp=workflow.now(),
                        parts=[
                            TextPart(
                                "Confirmed response exceeded this chat's history budget. "
                                "The bounded preview follows. "
                                f"Full native response SHA-256 {digest}.\n" + preview
                            )
                        ],
                    ),
                ]
                self.state.native_messages.extend(
                    ModelMessagesTypeAdapter.dump_python(confirmed, mode="json")
                )
                attempt.outcome = "completed"
                accepted.outcome = "completed"
                self.state.phase = Phase.FAILED
                self.state.failure = "provider_response_confirmed_history_budget_exceeded"
                return True
            self.state.native_messages = native
            attempt.outcome = "completed"
            return True
        except BaseException:
            projection.cancel()
            try:
                await projection
            except BaseException:
                pass
            attempt.outcome = "unconfirmed"
            raise
        finally:
            self.agent_task = None

    @workflow.run
    async def run(self, state: Conversation) -> str:
        try:
            await self.persist()
            while not self.cancel_requested:
                await workflow.wait_condition(
                    lambda: (
                        self.cancel_requested
                        or any(item.outcome == "accepted" for item in self.state.inputs)
                    )
                )
                if self.cancel_requested:
                    break
                accepted = next(item for item in self.state.inputs if item.outcome == "accepted")
                completed = await self.segment(accepted)
                if completed:
                    accepted.outcome = "completed"
                    terminal_budget = (
                        self.state.failure == "provider_response_confirmed_history_budget_exceeded"
                    )
                    if not terminal_budget:
                        self.state.phase = Phase.IDLE
                        self.state.failure = None
                    await self.persist()
                    self.events.stream.truncate(self.offset)
                    if terminal_budget:
                        for pending in self.state.inputs:
                            if pending.outcome == "accepted":
                                pending.outcome = "failed"
                        break
        except asyncio.CancelledError:
            if not self.cancel_requested:
                raise
        except Exception:
            self.state.phase = Phase.FAILED
            dispatched = any(item.outcome == "unconfirmed" for item in self.state.attempts)
            self.state.failure = (
                "provider_turn_unconfirmed_no_replacement_dispatched"
                if dispatched
                else "conversation_persistence_failed_not_dispatched"
            )
            for attempt in self.state.attempts:
                if attempt.outcome == "prepared":
                    attempt.outcome = "not_dispatched"
            for item in self.state.inputs:
                if item.outcome != "completed":
                    item.outcome = "failed"
        if self.cancel_requested:
            self.state.phase = Phase.CANCELLED
            self.state.failure = "read_only_provider_cancellation_requested"
            for item in self.state.inputs:
                if item.outcome != "completed":
                    item.outcome = "cancelled"
        await self.persist()
        await self.events.close()
        return self.state.phase.value

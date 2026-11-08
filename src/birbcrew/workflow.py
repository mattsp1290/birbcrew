import asyncio
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from pydantic_ai import DeferredToolRequests, DeferredToolResults
    from pydantic_ai.durable_exec.temporal import AgentEventStream, PydanticAIWorkflow
    from pydantic_ai.messages import ModelMessagesTypeAdapter
    from pydantic_ai.usage import UsageLimits
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from birbcrew.domain import (
        AcceptedInput,
        Conversation,
        HumanRequest,
        Phase,
        Projection,
        Prompt,
        Resolution,
        RunAttempt,
        RunDeps,
    )
    from birbcrew.provider import model_settings
    from birbcrew.runtime import agent, project_events, save_conversation


@workflow.defn
class ConversationWorkflow(PydanticAIWorkflow):
    __pydantic_ai_agents__ = [agent]

    @workflow.init
    def __init__(self, state: Conversation, interrupt_after_effect: bool):
        self.state = state
        self.interrupt = interrupt_after_effect
        self.events = AgentEventStream(drain_timeout=timedelta(seconds=2))
        self.cancel_requested = False
        self.agent_task = None
        self.offset = 0

    @workflow.update
    def submit(self, prompt: Prompt) -> dict:
        self.validate_submit(prompt)
        rid = str(prompt.request_id)
        for accepted in self.state.inputs:
            if accepted.request_id == rid:
                return accepted.model_dump(mode="json")
        accepted = AcceptedInput(
            request_id=rid,
            digest=prompt.digest,
            text=prompt.text,
            ordinal=len(self.state.inputs),
            outcome="accepted",
        )
        self.state.inputs.append(accepted)
        return accepted.model_dump(mode="json")

    @submit.validator
    def validate_submit(self, prompt: Prompt) -> None:
        for accepted in self.state.inputs:
            if accepted.request_id == str(prompt.request_id):
                if accepted.digest != prompt.digest:
                    raise ApplicationError("request_payload_conflict", non_retryable=True)
                return
        if self.cancel_requested or self.state.phase in {Phase.CANCELLED, Phase.FAILED}:
            raise ApplicationError("conversation_closed", non_retryable=True)
        if len(self.state.inputs) >= 4:
            raise ApplicationError("proof_input_limit", non_retryable=True)

    def human_request(self, response: Resolution) -> HumanRequest:
        candidates = self.state.decisions + ([self.state.human] if self.state.human else [])
        request = next((r for r in candidates if r.id == response.request_id), None)
        if (
            request is None
            or response.actor != request.expected_responder
            or response.version != request.version
        ):
            raise ApplicationError("human_request_conflict", non_retryable=True)
        return request

    @workflow.update
    def resolve(self, response: Resolution) -> dict:
        self.validate_resolution(response)
        request = self.human_request(response)
        request.resolution = response.choice
        return request.model_dump(mode="json")

    @resolve.validator
    def validate_resolution(self, response: Resolution) -> None:
        request = self.human_request(response)
        if request.resolution is not None:
            if request.resolution != response.choice:
                raise ApplicationError("human_response_conflict", non_retryable=True)
            return
        if self.cancel_requested or self.state.phase != Phase.WAITING:
            raise ApplicationError("human_request_closed", non_retryable=True)

    @workflow.update
    def cancel(self, actor: str) -> dict:
        self.validate_cancel(actor)
        self.cancel_requested = True
        if self.agent_task and not self.agent_task.done():
            self.agent_task.cancel()
        return {"acknowledgement": "requested", "conversation_id": self.state.id}

    @cancel.validator
    def validate_cancel(self, actor: str) -> None:
        if actor != self.state.owner:
            raise ApplicationError("forbidden", non_retryable=True)

    async def persist(self):
        self.state.revision += 1
        canonical = await workflow.execute_activity(
            save_conversation,
            self.state.model_copy(deep=True),
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(non_retryable_error_types=["ValueError"]),
        )

        self.state.native_messages = canonical.native_messages
        self.state.messages = canonical.messages

    async def segment(self, accepted: AcceptedInput, deferred=None):
        segment = len(self.state.attempts)
        run_id = str(uuid5(NAMESPACE_URL, f"{self.state.id}/{accepted.request_id}/{segment}"))
        attempt = RunAttempt(
            id=run_id,
            workflow_id=workflow.info().workflow_id,
            workflow_run_id=workflow.info().run_id,
            request_id=accepted.request_id,
            outcome="running",
        )
        self.state.attempts.append(attempt)
        self.state.phase = Phase.RUNNING
        accepted.outcome = "running"
        await self.persist()
        projection = workflow.start_activity(
            project_events,
            Projection(
                conversation_id=self.state.id,
                workflow_id=workflow.info().workflow_id,
                run_id=run_id,
                offset=self.offset,
            ),
            start_to_close_timeout=timedelta(minutes=30),
            heartbeat_timeout=timedelta(seconds=3),
            retry_policy=RetryPolicy(non_retryable_error_types=["ValueError"]),
            cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        )
        deps = RunDeps(
            run_id=run_id,
            conversation_id=self.state.id,
            request_id=accepted.request_id,
            operation_id=f"{self.state.id}/{accepted.request_id}",
            text=accepted.text,
            interrupt_after_effect=self.interrupt and accepted.ordinal == 0,
        )
        history = ModelMessagesTypeAdapter.validate_python(self.state.native_messages)
        self.agent_task = asyncio.create_task(
            agent.run(
                accepted.text if deferred is None else None,
                message_history=history,
                deferred_tool_results=deferred,
                deps=deps,
                conversation_id=self.state.id,
                run_id=run_id,
                instructions="Selected repository notes.\n" + self.state.context.model_dump_json(),
                model_settings=model_settings(self.state.id),
                usage_limits=UsageLimits(request_limit=6, tool_calls_limit=4),
            )
        )
        try:
            if self.cancel_requested:
                self.agent_task.cancel()
            result = await self.agent_task
            self.offset = await projection
            self.state.native_messages = ModelMessagesTypeAdapter.dump_python(
                result.all_messages(), mode="json"
            )
            attempt.outcome = (
                "waiting" if isinstance(result.output, DeferredToolRequests) else "completed"
            )
            return result.output
        except BaseException:
            projection.cancel()
            try:
                await projection
            except BaseException:
                pass
            attempt.outcome = "cancelled" if self.cancel_requested else "failed"
            raise
        finally:
            self.agent_task = None

    @workflow.run
    async def run(self, state: Conversation, interrupt_after_effect: bool) -> str:
        try:
            await self.persist()
            while not self.cancel_requested:
                await workflow.wait_condition(
                    lambda: (
                        self.cancel_requested
                        or any(i.outcome == "accepted" for i in self.state.inputs)
                    )
                )
                if self.cancel_requested:
                    break
                accepted = next(i for i in self.state.inputs if i.outcome == "accepted")
                output = await self.segment(accepted)
                if isinstance(output, DeferredToolRequests):
                    if len(output.calls) != 1 or output.calls[0].tool_name != "choose_next_step":
                        raise ApplicationError("unexpected_deferred_request", non_retryable=True)
                    call = output.calls[0]
                    self.state.human = HumanRequest(
                        id=f"{self.state.id}/{accepted.request_id}/next-step",
                        expected_responder=self.state.owner,
                        tool_call_id=call.tool_call_id,
                    )
                    self.state.phase = Phase.WAITING
                    accepted.outcome = "waiting"
                    await self.persist()
                    await workflow.wait_condition(
                        lambda: self.cancel_requested or self.state.human.resolution is not None
                    )
                    if self.cancel_requested:
                        break
                    human = self.state.human
                    self.state.decisions.append(human)
                    self.state.human = None
                    output = await self.segment(
                        accepted, DeferredToolResults(calls={human.tool_call_id: human.resolution})
                    )
                    if isinstance(output, DeferredToolRequests):
                        raise ApplicationError("repeated_human_request", non_retryable=True)
                accepted.outcome = "completed"
                self.state.phase = Phase.IDLE
                await self.persist()
                self.events.stream.truncate(self.offset)
        except asyncio.CancelledError:
            if not self.cancel_requested:
                raise
        except Exception as error:
            if not self.cancel_requested:
                workflow.logger.exception("Conversation failed")
                self.state.phase = Phase.FAILED
                self.state.failure = type(error).__name__
                for item in self.state.inputs:
                    if item.outcome not in {"completed", "cancelled"}:
                        item.outcome = "failed"
        if self.cancel_requested:
            self.state.phase = Phase.CANCELLED
            for item in self.state.inputs:
                if item.outcome not in {"completed", "failed"}:
                    item.outcome = "cancelled"
        await self.persist()
        await self.events.close()
        return self.state.phase.value

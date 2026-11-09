import asyncio
import os
from datetime import timedelta
from uuid import uuid4

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

with workflow.unsafe.imports_passed_through():
    from test_execution import daemon, setup  # noqa: F401

    from birbcrew.execution import author


@workflow.defn
class AuthorProof:
    @workflow.run
    async def run(self, raw: dict) -> dict:
        return await workflow.execute_activity(
            "birbcrew.author_goal.v1",
            raw,
            start_to_close_timeout=timedelta(minutes=2),
            heartbeat_timeout=timedelta(seconds=3),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(milliseconds=50), maximum_attempts=3
            ),
        )


def test_production_author_activity_worker_restart_retains_one_daemon_turn(
    setup,
    daemon,
    monkeypatch,  # noqa: F811
):
    _, request, _ = setup
    original = daemon.call
    running = asyncio.Event()
    finish = asyncio.Event()

    async def call(self, method, params):
        if method == "turn/start":
            result = await original(self, method, params)
            self.__class__.turns[0]["status"] = "inProgress"
            running.set()
            return result
        if method == "thread/turns/list" and finish.is_set():
            self.__class__.turns[0]["status"] = "completed"
        return await original(self, method, params)

    monkeypatch.setattr(daemon, "call", call)

    async def exercise():
        async with await WorkflowEnvironment.start_local(
            dev_server_existing_path=os.environ.get(
                "TEMPORAL_TEST_SERVER", "/opt/homebrew/bin/temporal"
            ),
            dev_server_log_level="error",
        ) as env:
            queue = "author-proof-" + str(uuid4())
            options = dict(
                task_queue=queue,
                workflows=[AuthorProof],
                activities=[author.author_goal],
                workflow_runner=SandboxedWorkflowRunner(),
                max_heartbeat_throttle_interval=timedelta(milliseconds=50),
                default_heartbeat_throttle_interval=timedelta(milliseconds=50),
            )
            worker = Worker(env.client, **options)
            await worker.__aenter__()
            handle = await env.client.start_workflow(
                AuthorProof.run, request.model_dump(mode="json"), id=queue, task_queue=queue
            )
            try:
                await asyncio.wait_for(running.wait(), 10)
            finally:
                await worker.__aexit__(None, None, None)
            assert daemon.starts == 1
            assert daemon.turns == [{"id": "owned-turn", "status": "inProgress"}]
            finish.set()
            async with Worker(env.client, **options):
                result = await asyncio.wait_for(handle.result(), 20)
            assert result["status"] == "candidate", result
            assert daemon.starts == 1

    asyncio.run(exercise())

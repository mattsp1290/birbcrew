import asyncio

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.worker import Worker

from birbcrew.config import settings, temporal_client
from birbcrew.telemetry import configure


async def main():
    configure()
    from birbcrew.project_runtime import (
        project_conversation_events,
        save_project_conversation,
        validate_project_provider,
    )
    from birbcrew.project_workflow import ProjectConversationWorkflow

    config = settings()
    client = await temporal_client(plugins=[PydanticAIPlugin()])
    async with Worker(
        client,
        task_queue=config.project_task_queue or config.task_queue + "-projects",
        workflows=[ProjectConversationWorkflow],
        activities=[
            project_conversation_events,
            save_project_conversation,
            validate_project_provider,
        ],
    ):
        print("project-worker-ready", flush=True)
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())

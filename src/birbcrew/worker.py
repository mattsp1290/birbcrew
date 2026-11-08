import asyncio

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import Client
from temporalio.worker import Worker

from birbcrew.config import settings
from birbcrew.telemetry import configure


async def main():
    configure()
    from birbcrew.runtime import project_events, save_conversation
    from birbcrew.workflow import ConversationWorkflow

    config = settings()
    client = await Client.connect(config.temporal_address, plugins=[PydanticAIPlugin()])
    async with Worker(
        client,
        task_queue=config.task_queue,
        workflows=[ConversationWorkflow],
        activities=[project_events, save_conversation],
    ):
        print("worker-ready", flush=True)
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())

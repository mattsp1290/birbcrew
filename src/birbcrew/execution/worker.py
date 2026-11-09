import asyncio

from temporalio.worker import Worker

from birbcrew.config import temporal_client
from birbcrew.execution.author import author_goal
from birbcrew.execution.policy import installation
from birbcrew.execution.publish import publish_draft
from birbcrew.execution.review import review_candidate


async def main():
    config = installation()
    config.artifact_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    client = await temporal_client()
    async with Worker(
        client,
        task_queue=config.task_queue,
        activities=[author_goal, review_candidate, publish_draft],
        max_concurrent_activities=1,
    ):
        print("execution-worker-ready", flush=True)
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())

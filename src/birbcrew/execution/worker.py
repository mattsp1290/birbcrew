import asyncio
import signal
from datetime import timedelta

from temporalio.worker import Worker

from birbcrew.config import temporal_client
from birbcrew.execution.author import author_goal
from birbcrew.execution.daemon import wait_for_socket
from birbcrew.execution.policy import installation
from birbcrew.execution.publish import publish_draft
from birbcrew.execution.review import REVIEW_TIMEOUT_SECONDS, preflight_reviewer, review_candidate
from birbcrew.execution.review_recovery import check_review_recovery

SHUTDOWN_GRACE = timedelta(seconds=REVIEW_TIMEOUT_SECONDS + 60)


async def main():
    config = installation()
    preflight_reviewer(config)
    if config.codex_socket:
        await wait_for_socket(config.codex_socket, 120)
    config.artifact_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    client = await temporal_client()
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    async with Worker(
        client,
        task_queue=config.task_queue,
        activities=[author_goal, review_candidate, check_review_recovery, publish_draft],
        max_concurrent_activities=1,
        graceful_shutdown_timeout=SHUTDOWN_GRACE,
    ):
        print("execution-worker-ready", flush=True)
        await stop.wait()


if __name__ == "__main__":
    asyncio.run(main())

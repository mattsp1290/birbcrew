import asyncio
import os
from pathlib import Path

import uvicorn
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

from birbcrew.config import temporal_client
from birbcrew.finance import thread_store
from birbcrew.finance.api import create_app
from birbcrew.finance.config import load
from birbcrew.finance.identity import protocol_for


async def main():
    policy, context = load(Path(os.environ["BIRBCREW_FINANCE_CONFIG"]))
    await thread_store.ready()
    temporal = await temporal_client(plugins=[PydanticAIPlugin()])

    def factory(config, default_factory):
        return context

    config = uvicorn.Config(
        create_app(temporal),
        host=policy.host,
        port=policy.port,
        http=protocol_for(policy, context),
        ssl_context_factory=factory,
        loop="asyncio",
        ws="none",
        http2=False,
        proxy_headers=False,
        access_log=False,
        lifespan="off",
        timeout_graceful_shutdown=1,
    )
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        raise SystemExit("finance listener startup failed") from None

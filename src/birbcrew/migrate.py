import asyncio

from birbcrew import store
from birbcrew.execution.journal import migrate


async def main():
    await store.migrate()
    await migrate()


if __name__ == "__main__":
    asyncio.run(main())

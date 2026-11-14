import asyncio
import os
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from birbcrew.execution import journal


@pytest.fixture
def migration_dsn():
    value = os.environ.get("FINANCE_MIGRATION_DSN")
    if not value:
        pytest.skip("set FINANCE_MIGRATION_DSN to an owned disposable PostgreSQL server")
    name = "journal_" + uuid4().hex
    with psycopg.connect(value, autocommit=True) as db:
        db.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield psycopg.conninfo.make_conninfo(value, dbname=name)
    finally:
        with psycopg.connect(value, autocommit=True) as db:
            db.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def test_concurrent_cold_journal_migrations(migration_dsn, monkeypatch):
    async def exercise():
        ready = asyncio.Event()
        release = asyncio.Event()
        pids = []

        class Connection:
            def __init__(self, db, first):
                self.db = db
                self.first = first

            async def __aenter__(self):
                await self.db.__aenter__()
                return self

            async def __aexit__(self, *args):
                return await self.db.__aexit__(*args)

            async def execute(self, query, *args, **kwargs):
                result = await self.db.execute(query, *args, **kwargs)
                if self.first and "CREATE SCHEMA" in query:
                    ready.set()
                    await asyncio.wait_for(release.wait(), 10)
                return result

        async def connect():
            db = await psycopg.AsyncConnection.connect(migration_dsn, row_factory=dict_row)
            pids.append(db.info.backend_pid)
            return Connection(db, len(pids) == 1)

        monkeypatch.setattr(journal, "connect", connect)
        first = asyncio.create_task(journal.migrate())
        second = None
        observation = None
        try:
            await asyncio.wait_for(ready.wait(), 10)
            second = asyncio.create_task(journal.migrate())
            async with await psycopg.AsyncConnection.connect(
                migration_dsn, autocommit=True
            ) as observer:
                for _ in range(200):
                    if len(pids) == 2:
                        row = await (
                            await observer.execute(
                                "SELECT pg_blocking_pids(%s), wait_event_type, wait_event, query "
                                "FROM pg_stat_activity WHERE pid=%s",
                                (pids[1], pids[1]),
                            )
                        ).fetchone()
                        if row and pids[0] in row[0]:
                            observation = row
                            break
                    await asyncio.sleep(0.01)
            assert observation is not None, "second actual migrator did not block on the first"
            print("actual_overlap", repr(observation), flush=True)
        finally:
            release.set()
            results = await asyncio.gather(
                *([first, second] if second else [first]), return_exceptions=True
            )
        assert results == [None, None], repr(results)

        async def plain_connect():
            return await psycopg.AsyncConnection.connect(migration_dsn, row_factory=dict_row)

        monkeypatch.setattr(journal, "connect", plain_connect)
        await journal.migrate()
        async with await plain_connect() as db:
            schema = await (
                await db.execute(
                    "SELECT table_name,column_name,data_type,is_nullable "
                    "FROM information_schema.columns WHERE table_schema='execution' "
                    "ORDER BY ordinal_position"
                )
            ).fetchall()
            assert [
                (r["table_name"], r["column_name"], r["data_type"], r["is_nullable"])
                for r in schema
            ] == [
                ("operations", "kind", "text", "NO"),
                ("operations", "operation_id", "text", "NO"),
                ("operations", "input_digest", "text", "NO"),
                ("operations", "state", "jsonb", "NO"),
            ]
            constraints = await (
                await db.execute(
                    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint "
                    "WHERE conrelid='execution.operations'::regclass"
                )
            ).fetchall()
            assert [r["definition"] for r in constraints] == ["PRIMARY KEY (kind, operation_id)"]
        payload = {"goal": "approved"}
        assert await journal.claim("migration", "existing", payload) == (True, {"phase": "claimed"})
        await journal.migrate()
        assert await journal.claim("migration", "existing", payload) == (
            False,
            {"phase": "claimed"},
        )
        await journal.save("migration", "existing", {"phase": "terminal", "result": {"ok": True}})
        await journal.save("migration", "existing", {"phase": "running"})
        assert await journal.receipt("migration", "existing", payload) == {"ok": True}

    asyncio.run(exercise())


def test_several_independent_cold_migrators(migration_dsn, monkeypatch):
    async def connect():
        return await psycopg.AsyncConnection.connect(migration_dsn, row_factory=dict_row)

    monkeypatch.setattr(journal, "connect", connect)

    async def exercise():
        await asyncio.gather(*(journal.migrate() for _ in range(8)))
        await journal.migrate()

    asyncio.run(exercise())

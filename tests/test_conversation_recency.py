import asyncio
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from birbcrew import store
from birbcrew.domain import Conversation, NoteContext


@pytest.fixture
def isolated_postgres(monkeypatch):
    postgres = shutil.which("postgres")
    if not postgres:
        pytest.skip("requires local PostgreSQL for isolated conversation recency proof")
    binaries = Path(postgres).resolve().parent
    with tempfile.TemporaryDirectory(prefix="birbcrew-recency-", dir="/tmp") as directory:
        root = Path(directory)
        subprocess.run(
            [
                str(binaries / "initdb"),
                "-D",
                str(root / "data"),
                "-A",
                "trust",
                "--no-locale",
                "--encoding=UTF8",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        process = subprocess.Popen(
            [postgres, "-D", str(root / "data"), "-k", str(root), "-h", ""],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(100):
                try:
                    with psycopg.connect(host=str(root), dbname="postgres"):
                        break
                except psycopg.OperationalError:
                    time.sleep(0.1)
            else:
                raise AssertionError("isolated PostgreSQL failed to start")

            async def connect():
                return await psycopg.AsyncConnection.connect(
                    host=str(root), dbname="postgres", row_factory=dict_row
                )

            monkeypatch.setattr(store, "connect", connect)
            yield
        finally:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def conversation(identity, owner="owner"):
    return Conversation(
        id=identity,
        owner=owner,
        context=NoteContext(project="proof", actor=owner, commit="fixture", notes=[]),
    )


async def activity_times():
    async with await store.connect() as db:
        rows = await (
            await db.execute("SELECT id, last_activity_at FROM conversations ORDER BY id")
        ).fetchall()
    return {row["id"]: row["last_activity_at"] for row in rows}


def test_existing_conversations_migrate_once_with_stable_ties(isolated_postgres):
    async def exercise():
        async with await store.connect() as db:
            await db.execute(
                "CREATE TABLE conversations (id text PRIMARY KEY, owner text NOT NULL, "
                "revision bigint NOT NULL, snapshot jsonb NOT NULL, "
                "cursor bigint NOT NULL DEFAULT 0, snapshot_cursor bigint NOT NULL DEFAULT 0)"
            )
            for identity in ["z-legacy", "a-legacy"]:
                state = conversation(identity)
                await db.execute(
                    "INSERT INTO conversations (id,owner,revision,snapshot) VALUES (%s,%s,0,%s)",
                    (identity, state.owner, Jsonb(state.model_dump(mode="json"))),
                )
        await store.migrate()
        original_times = await activity_times()
        assert original_times["z-legacy"] == original_times["a-legacy"]
        assert await store.conversations_for_owner("owner") == [
            {"id": "a-legacy", "revision": 0},
            {"id": "z-legacy", "revision": 0},
        ]
        await store.migrate()
        assert await activity_times() == original_times
        assert (await store.snapshot("z-legacy", "owner"))["id"] == "z-legacy"

    asyncio.run(exercise())


def test_recent_activity_excludes_observers_and_replayed_writes(isolated_postgres):
    async def exercise():
        await store.migrate()
        older = conversation("a-older")
        newer = conversation("z-newer")
        await store.create(older)
        await store.create(newer)
        await store.create(conversation("other-owner", "someone-else"))
        assert await store.conversations_for_owner("owner") == [
            {"id": "z-newer", "revision": 0},
            {"id": "a-older", "revision": 0},
        ]
        before_reads = await activity_times()
        await store.snapshot(older.id, older.owner)
        await store.events_after(older.id, 0)
        await store.operation_rows(older.id)
        await store.conversations_for_owner("owner")
        assert await activity_times() == before_reads

        event = {"type": "TEXT_MESSAGE_CONTENT", "messageId": "first", "delta": "Hello"}
        await store.publish(older.id, "first-event", event)
        assert (await store.conversations_for_owner("owner"))[0]["id"] == older.id
        after_publish = await activity_times()
        assert after_publish[older.id] > before_reads[older.id]
        await store.publish(older.id, "first-event", event)
        assert not await store.create(older)
        await store.save(older)
        assert await activity_times() == after_publish

        newer.revision = 1
        await store.save(newer)
        assert await store.conversations_for_owner("owner") == [
            {"id": "z-newer", "revision": 1},
            {"id": "a-older", "revision": 0},
        ]
        after_save = await activity_times()
        assert after_save[newer.id] > after_publish[newer.id]
        await store.save(newer)
        assert await activity_times() == after_save
        assert await store.conversations_for_owner("nobody") == []

        for index in range(101):
            await store.create(conversation(f"bulk-{index:03}", "bulk"))
        recent = await store.conversations_for_owner("bulk")
        assert len(recent) == 100
        assert [row["id"] for row in recent[:5]] == [
            "bulk-100",
            "bulk-099",
            "bulk-098",
            "bulk-097",
            "bulk-096",
        ]
        assert "bulk-000" not in [row["id"] for row in recent]

    asyncio.run(exercise())

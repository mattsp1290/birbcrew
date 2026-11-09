import asyncio
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from birbcrew.execution import journal


def test_postgres_operation_claim_and_terminal_compare_exchange(monkeypatch):
    postgres = shutil.which("postgres")
    if not postgres:
        pytest.skip("requires a local PostgreSQL binary for the isolated journal proof")
    binaries = Path(postgres).resolve().parent
    with tempfile.TemporaryDirectory(prefix="birbcrew-journal-", dir="/tmp") as directory:
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

            monkeypatch.setattr(journal, "connect", connect)

            async def exercise():
                await journal.migrate()
                identity = str(uuid4())
                payload = {"goal": "approved"}
                claims = await asyncio.gather(
                    *(journal.claim("author", identity, payload) for _ in range(8))
                )
                assert sum(fresh for fresh, _ in claims) == 1
                initial = {"phase": "claimed"}
                running = {"phase": "running", "thread_id": "owned"}
                assert await journal.replace("author", identity, initial, running)
                assert not await journal.replace("author", identity, initial, {"phase": "freezing"})
                terminal = {"phase": "terminal", "result": {"status": "candidate"}}
                assert await journal.replace("author", identity, running, terminal)
                await journal.save("author", identity, {"phase": "running"})
                assert await journal.receipt("author", identity, payload) == terminal["result"]
                assert await journal.receipt("author", identity, {"goal": "changed"}) is None
                with pytest.raises(ValueError, match="operation_payload_conflict"):
                    await journal.claim("author", identity, {"goal": "changed"})

            asyncio.run(exercise())
        finally:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

from psycopg.types.json import Jsonb

from birbcrew.execution.contract import digest
from birbcrew.store import MIGRATION_LOCK, connect


async def migrate():
    async with await connect() as db:
        await db.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
        await db.execute("""
            CREATE SCHEMA IF NOT EXISTS execution;
            CREATE TABLE IF NOT EXISTS execution.operations (
                kind text NOT NULL, operation_id text NOT NULL, input_digest text NOT NULL,
                state jsonb NOT NULL, PRIMARY KEY (kind, operation_id)
            )
        """)


async def claim(kind: str, operation_id: str, value: dict) -> tuple[bool, dict]:
    checksum = digest(value)
    async with await connect() as db:
        inserted = await (
            await db.execute(
                "INSERT INTO execution.operations VALUES (%s,%s,%s,%s) "
                "ON CONFLICT DO NOTHING RETURNING operation_id",
                (kind, operation_id, checksum, Jsonb({"phase": "claimed"})),
            )
        ).fetchone()
        row = await (
            await db.execute(
                "SELECT input_digest,state FROM execution.operations "
                "WHERE kind=%s AND operation_id=%s",
                (kind, operation_id),
            )
        ).fetchone()
        if row["input_digest"] != checksum:
            raise ValueError("operation_payload_conflict")
        return inserted is not None, row["state"]


async def save(kind: str, operation_id: str, state: dict) -> None:
    async with await connect() as db:
        await db.execute(
            "UPDATE execution.operations SET state=%s WHERE kind=%s AND operation_id=%s "
            "AND state->>'phase' != 'terminal'",
            (Jsonb(state), kind, operation_id),
        )


async def replace(kind: str, operation_id: str, expected: dict, state: dict) -> bool:
    async with await connect() as db:
        row = await (
            await db.execute(
                "UPDATE execution.operations SET state=%s WHERE kind=%s AND operation_id=%s "
                "AND state=%s RETURNING operation_id",
                (Jsonb(state), kind, operation_id, Jsonb(expected)),
            )
        ).fetchone()
        return row is not None


async def receipt(kind: str, operation_id: str, expected_input: dict) -> dict | None:
    async with await connect() as db:
        row = await (
            await db.execute(
                "SELECT state FROM execution.operations WHERE kind=%s AND operation_id=%s "
                "AND input_digest=%s",
                (kind, operation_id, digest(expected_input)),
            )
        ).fetchone()
        return row["state"].get("result") if row else None

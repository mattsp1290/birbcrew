import re
from dataclasses import dataclass
from uuid import UUID, uuid4

from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from birbcrew import store
from birbcrew.config import settings
from birbcrew.domain import Conversation


@dataclass(frozen=True)
class FinanceOwner:
    value: str

    def __post_init__(self):
        if not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", self.value
        ):
            raise ValueError("canonical Go UUIDv4 owner required")


@dataclass(frozen=True)
class FinanceThread:
    owner: FinanceOwner
    conversation_id: UUID


async def ready() -> None:
    expected = {
        "conversations_id_owner_unique": "UNIQUE (id, owner)",
        "finance_threads_pkey": "PRIMARY KEY (owner)",
        "finance_threads_conversation_id_key": "UNIQUE (conversation_id)",
        "finance_threads_owner_thread_fkey": (
            "FOREIGN KEY (conversation_id, owner) REFERENCES conversations(id, owner) "
            "DEFERRABLE INITIALLY DEFERRED"
        ),
    }
    async with await store.connect() as db:
        rows = await (
            await db.execute(
                "SELECT conname,conrelid::regclass::text AS relation,"
                "pg_get_constraintdef(oid) AS definition,convalidated "
                "FROM pg_constraint WHERE conrelid IN "
                "('conversations'::regclass,'finance_threads'::regclass)"
            )
        ).fetchall()
        actual = {
            row["conname"]: row["definition"]
            for row in rows
            if row["convalidated"]
            and row["relation"]
            == (
                "conversations"
                if row["conname"] == "conversations_id_owner_unique"
                else "finance_threads"
            )
        }
        if any(actual.get(key) != value for key, value in expected.items()):
            raise ValueError("finance schema is not ready")
        columns = await (
            await db.execute(
                "SELECT attname,attnotnull,atttypid::regtype::text AS type FROM pg_attribute "
                "WHERE attrelid='finance_threads'::regclass AND attnum>0 AND NOT attisdropped"
            )
        ).fetchall()
        if {row["attname"]: (row["attnotnull"], row["type"]) for row in columns} != {
            "owner": (True, "text"),
            "conversation_id": (True, "text"),
        }:
            raise ValueError("finance schema is not ready")
        await db.execute("SELECT snapshot,snapshot_cursor FROM conversations LIMIT 0")


async def initialize(owner: FinanceOwner) -> FinanceThread:
    for _ in range(5):
        cid = str(uuid4())
        try:
            async with await store.connect() as db:
                await db.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                row = await (
                    await db.execute(
                        "INSERT INTO finance_threads(owner,conversation_id) VALUES (%s,%s) "
                        "ON CONFLICT(owner) DO NOTHING RETURNING conversation_id",
                        (owner.value, cid),
                    )
                ).fetchone()
                if row:
                    state = Conversation(id=cid, owner=owner.value, context=settings().context)
                    await db.execute(
                        "INSERT INTO conversations(id,owner,revision,snapshot) VALUES (%s,%s,0,%s)",
                        (cid, owner.value, Jsonb(state.model_dump(mode="json"))),
                    )
                else:
                    row = await (
                        await db.execute(
                            "SELECT conversation_id FROM finance_threads WHERE owner=%s",
                            (owner.value,),
                        )
                    ).fetchone()
                    cid = row["conversation_id"]
            return FinanceThread(owner, UUID(cid))
        except UniqueViolation:
            continue
    raise RuntimeError("finance allocation collisions exhausted")


async def snapshot(thread: FinanceThread) -> dict | None:
    async with await store.connect() as db:
        row = await (
            await db.execute(
                "SELECT c.snapshot,c.snapshot_cursor AS cursor FROM conversations c "
                "JOIN finance_threads f ON f.conversation_id=c.id AND f.owner=c.owner "
                "WHERE f.owner=%s AND f.conversation_id=%s",
                (thread.owner.value, str(thread.conversation_id)),
            )
        ).fetchone()
    return {**row["snapshot"], "cursor": row["cursor"]} if row else None


async def require(owner: FinanceOwner, cid: UUID) -> tuple[FinanceThread, dict] | None:
    thread = FinanceThread(owner, cid)
    state = await snapshot(thread)
    return (thread, state) if state else None

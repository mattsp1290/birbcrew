from uuid import NAMESPACE_URL, uuid5

from ag_ui.core import MessagesSnapshotEvent, StateSnapshotEvent
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic_ai.messages import ModelMessagesTypeAdapter
from pydantic_ai.ui.ag_ui import AGUIAdapter

from birbcrew.config import settings
from birbcrew.domain import Conversation, RunDeps

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id text PRIMARY KEY, owner text NOT NULL, revision bigint NOT NULL,
    snapshot jsonb NOT NULL, cursor bigint NOT NULL DEFAULT 0,
    snapshot_cursor bigint NOT NULL DEFAULT 0,
    last_activity_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS
    last_activity_at timestamptz NOT NULL DEFAULT statement_timestamp();
CREATE TABLE IF NOT EXISTS events (
    conversation_id text NOT NULL REFERENCES conversations(id),
    cursor bigint NOT NULL, event_key text NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY (conversation_id, cursor), UNIQUE (conversation_id, event_key)
);
CREATE TABLE IF NOT EXISTS operations (
    operation_id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id),
    payload text NOT NULL, result jsonb NOT NULL, deliveries integer NOT NULL DEFAULT 1
);
"""
RETAIN_EVENTS = 256


async def connect():
    return await AsyncConnection.connect(settings().database_url, row_factory=dict_row)


async def migrate() -> None:
    async with await connect() as db:
        await db.execute(SCHEMA)


async def create(state: Conversation) -> bool:
    async with await connect() as db:
        result = await db.execute(
            "INSERT INTO conversations (id,owner,revision,snapshot) VALUES (%s,%s,0,%s) "
            "ON CONFLICT DO NOTHING RETURNING id",
            (state.id, state.owner, Jsonb(state.model_dump(mode="json"))),
        )
        return await result.fetchone() is not None


async def snapshot(cid: str, owner: str) -> dict | None:
    async with await connect() as db:
        row = await (
            await db.execute(
                "SELECT snapshot,snapshot_cursor AS cursor FROM conversations "
                "WHERE id=%s AND owner=%s",
                (cid, owner),
            )
        ).fetchone()
        return {**row["snapshot"], "cursor": row["cursor"]} if row else None


async def append_locked(db, cid: str, key: str, payload: dict) -> None:
    prior = await (
        await db.execute(
            "SELECT payload FROM events WHERE conversation_id=%s AND event_key=%s", (cid, key)
        )
    ).fetchone()
    if prior:
        if prior["payload"] != payload:
            fields = [
                field
                for field in set(prior["payload"]) | set(payload)
                if prior["payload"].get(field) != payload.get(field)
            ]
            raise ValueError(
                f"event_replay_conflict key={key} type={payload.get('type')} fields={fields}"
            )
        return
    row = await (
        await db.execute(
            "UPDATE conversations SET cursor=cursor+1, last_activity_at=clock_timestamp() "
            "WHERE id=%s RETURNING cursor",
            (cid,),
        )
    ).fetchone()
    await db.execute(
        "INSERT INTO events VALUES (%s,%s,%s,%s)", (cid, row["cursor"], key, Jsonb(payload))
    )


async def publish(cid: str, key: str, event: dict) -> None:
    async with await connect() as db:
        await db.execute("SELECT id FROM conversations WHERE id=%s FOR UPDATE", (cid,))
        await append_locked(db, cid, key, event)


async def save(state: Conversation) -> Conversation:
    native = ModelMessagesTypeAdapter.validate_python(state.native_messages)
    messages = AGUIAdapter.dump_messages(native)
    state.messages = [m.model_dump(mode="json", by_alias=True, exclude_none=True) for m in messages]
    for i, message in enumerate(state.messages):
        message["id"] = str(uuid5(NAMESPACE_URL, f"{state.id}/finalized/{i}"))
    async with await connect() as db:
        row = await (
            await db.execute(
                "SELECT revision,snapshot FROM conversations WHERE id=%s FOR UPDATE", (state.id,)
            )
        ).fetchone()
        if row["revision"] >= state.revision:
            return Conversation.model_validate(row["snapshot"])
        await db.execute(
            "UPDATE conversations SET snapshot=%s,revision=%s,last_activity_at=clock_timestamp() "
            "WHERE id=%s",
            (Jsonb(state.model_dump(mode="json")), state.revision, state.id),
        )
        for suffix, event in [
            ("messages", MessagesSnapshotEvent(messages=state.messages)),
            ("state", StateSnapshotEvent(snapshot=public_state(state))),
        ]:
            await append_locked(
                db,
                state.id,
                f"state/{state.revision}/{suffix}",
                event.model_dump(mode="json", by_alias=True, exclude_none=True),
            )
        await db.execute("UPDATE conversations SET snapshot_cursor=cursor WHERE id=%s", (state.id,))
        await db.execute(
            "DELETE FROM events WHERE conversation_id=%s AND cursor <= "
            "(SELECT cursor-%s FROM conversations WHERE id=%s)",
            (state.id, RETAIN_EVENTS, state.id),
        )

    return state


def public_state(state: Conversation) -> dict:
    return state.model_dump(mode="json", exclude={"native_messages", "messages", "owner"})


async def events_after(cid: str, after: int) -> tuple[int, list[dict]]:
    async with await connect() as db:
        return await read_events(db, cid, after)


async def read_events(db, cid: str, after: int) -> tuple[int, list[dict]]:
    async with db.transaction():
        await db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        bounds = await (
            await db.execute(
                "SELECT cursor, COALESCE((SELECT min(cursor) FROM events "
                "WHERE conversation_id=%s),cursor+1) AS first "
                "FROM conversations WHERE id=%s",
                (cid, cid),
            )
        ).fetchone()
        if after < bounds["first"] - 1 or after > bounds["cursor"]:
            raise ValueError("cursor_expired")
        rows = await (
            await db.execute(
                "SELECT cursor,payload FROM events WHERE conversation_id=%s AND cursor>%s "
                "ORDER BY cursor",
                (cid, after),
            )
        ).fetchall()
        return bounds["cursor"], rows


async def record_effect(deps: RunDeps) -> tuple[dict, bool]:
    result = {"operation_id": deps.operation_id, "kind": "synthetic-work-item", "text": deps.text}
    async with await connect() as db:
        inserted = await (
            await db.execute(
                "INSERT INTO operations (operation_id,conversation_id,payload,result) "
                "VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING operation_id",
                (deps.operation_id, deps.conversation_id, deps.text, Jsonb(result)),
            )
        ).fetchone()
        row = await (
            await db.execute(
                "SELECT * FROM operations WHERE operation_id=%s FOR UPDATE", (deps.operation_id,)
            )
        ).fetchone()
        if row["conversation_id"] != deps.conversation_id or row["payload"] != deps.text:
            raise ValueError("operation_payload_conflict")
        if not inserted:
            await db.execute(
                "UPDATE operations SET deliveries=deliveries+1 WHERE operation_id=%s",
                (deps.operation_id,),
            )
        return row["result"], bool(inserted)


async def operation_rows(cid: str) -> list[dict]:
    async with await connect() as db:
        return await (
            await db.execute(
                "SELECT * FROM operations WHERE conversation_id=%s ORDER BY operation_id", (cid,)
            )
        ).fetchall()


async def conversations_for_owner(owner: str) -> list[dict]:
    async with await connect() as db:
        rows = await (
            await db.execute(
                "SELECT id, revision FROM conversations WHERE owner=%s "
                "ORDER BY last_activity_at DESC, id LIMIT 100",
                (owner,),
            )
        ).fetchall()
        return rows

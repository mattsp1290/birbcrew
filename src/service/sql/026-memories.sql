-- Owner-written member memory (docs/memories.md). An owner saves short facts for one member
-- through the API. A conversation records, when it opens, references to the member's active
-- entries, and each native launch of that conversation gives the model those still active.
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members and
-- conversations for the two new foreign keys, and ACCESS EXCLUSIVE on audit_events to replace
-- its type CHECK (dropped and re-added NOT VALID, so no row is scanned) and to build one empty
-- partial unique index, which reads audit_events once. As in 025 they are taken together with
-- NOWAIT and retried, so the migration never waits in a lock queue, never joins a deadlock and
-- never holds sessions up while it waits. A native turn's admission transaction holds only
-- ACCESS SHARE on members and conversations, which these modes allow, and nothing on
-- audit_events, so a running turn never delays it. After 60 s without the locks it fails with
-- 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members, birbcrew_ts.conversations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

CREATE TABLE birbcrew_ts.member_memories (
    memory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    member_id uuid NOT NULL,
    create_request_id uuid NOT NULL,
    -- memoryLimits.textBytes in memories.ts. Deletion erases the text and keeps the row.
    body text CHECK (octet_length(body) BETWEEN 1 AND 1024),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    changed_at timestamptz,
    UNIQUE (owner_id, create_request_id),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    CHECK ((state = 'deleted') = (body IS NULL)),
    CHECK ((state = 'active') = (changed_at IS NULL))
);
-- The snapshot a conversation takes when it opens, oldest first.
CREATE INDEX member_memories_active ON birbcrew_ts.member_memories (member_id, created_at, memory_id) WHERE state = 'active';
CREATE INDEX member_memories_owner_page ON birbcrew_ts.member_memories (owner_id, memory_id);

-- At most 32 active entries per member (memoryLimits.activePerMember in memories.ts). Only an
-- insert makes an entry active. The advisory lock serialises creates per member until commit;
-- under READ COMMITTED the count, a later statement, then sees every create committed before
-- it. A replayed create skips its own request so it never counts against itself.
CREATE FUNCTION birbcrew_ts.limit_active_memories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('birbcrew_ts.member_memories/' || NEW.member_id::text, 0));
    IF (SELECT count(*) FROM birbcrew_ts.member_memories WHERE member_id = NEW.member_id AND state = 'active'
          AND memory_id <> NEW.memory_id AND create_request_id <> NEW.create_request_id) >= 32 THEN
        RAISE EXCEPTION 'A member may have at most 32 active memories'
            USING ERRCODE = '23514', CONSTRAINT = 'member_memories_active_limit';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER member_memories_active_limit BEFORE INSERT ON birbcrew_ts.member_memories
    FOR EACH ROW WHEN (NEW.state = 'active') EXECUTE FUNCTION birbcrew_ts.limit_active_memories();

-- An entry is never edited and never re-activated: it can be suspended once, then deleted, and a
-- deleted entry is a tombstone whose text is gone. Nothing can bring text back.
CREATE FUNCTION birbcrew_ts.guard_member_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Member memories are kept as tombstones' USING ERRCODE = '23514';
    END IF;
    IF (OLD.memory_id, OLD.owner_id, OLD.member_id, OLD.create_request_id, OLD.created_at)
        IS DISTINCT FROM (NEW.memory_id, NEW.owner_id, NEW.member_id, NEW.create_request_id, NEW.created_at) THEN
        RAISE EXCEPTION 'A member memory identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = NEW.state THEN
        IF OLD IS DISTINCT FROM NEW THEN
            RAISE EXCEPTION 'A member memory changes only its state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT ((OLD.state = 'active' AND NEW.state IN ('suspended', 'deleted')) OR (OLD.state = 'suspended' AND NEW.state = 'deleted')) THEN
        RAISE EXCEPTION 'A member memory moves only from active to suspended or deleted, or from suspended to deleted'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.body IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body THEN
        RAISE EXCEPTION 'A member memory text can only be erased' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER member_memories_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.member_memories
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_member_memory();

-- A conversation's snapshot: the entries it may show the model, in the order it shows them.
CREATE TABLE birbcrew_ts.conversation_memories (
    conversation_id uuid NOT NULL REFERENCES birbcrew_ts.conversations (conversation_id),
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 32),
    memory_id uuid NOT NULL REFERENCES birbcrew_ts.member_memories (memory_id),
    PRIMARY KEY (conversation_id, position),
    UNIQUE (conversation_id, memory_id)
);

-- As bind_audit_conversation (021-audit.sql) does for audit rows: a reference must name an entry
-- of the conversation's own owner and member, whoever writes it. Both sides' owner and member
-- are immutable and neither row can be deleted, so the binding holds until commit. No UNIQUE
-- constraint on conversations: adding one would take ACCESS EXCLUSIVE there and queue behind a
-- native turn. Entry state is not checked: a delete that commits while a conversation opens
-- would otherwise fail the open; each launch reads only entries still active.
CREATE FUNCTION birbcrew_ts.bind_conversation_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM birbcrew_ts.conversations c JOIN birbcrew_ts.member_memories m USING (owner_id, member_id)
     WHERE c.conversation_id = NEW.conversation_id AND m.memory_id = NEW.memory_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conversation memory is missing or belongs to another owner or member' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_memories_binding BEFORE INSERT ON birbcrew_ts.conversation_memories
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.bind_conversation_memory();
CREATE FUNCTION birbcrew_ts.reject_conversation_memory_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'A conversation memory snapshot never changes' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER conversation_memories_fixed BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.conversation_memories
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_conversation_memory_change();
CREATE FUNCTION birbcrew_ts.reject_member_memory_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Member memories are kept as tombstones' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER member_memories_kept BEFORE TRUNCATE ON birbcrew_ts.member_memories
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_member_memory_truncate();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_memories
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.conversation_memories
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- 021's recipe. This constraint replaces 025's, so it repeats every type 025 lists. Keep it in
-- step with auditEvents in src/service/audit.ts. Memory rows belong to no conversation or request,
-- and never carry text: only the entry's id.
ALTER TABLE birbcrew_ts.audit_events
    DROP CONSTRAINT audit_events_type_check,
    ADD CONSTRAINT audit_events_type_check CHECK (
        (event_type = 'member.spawned' AND conversation_id IS NULL AND request_id IS NULL)
        OR (event_type = 'conversation.opened' AND conversation_id IS NOT NULL AND request_id IS NULL)
        OR (event_type IN ('request.accepted', 'request.cancellation_requested', 'request.finished')
            AND conversation_id IS NOT NULL AND request_id IS NOT NULL)
        OR (event_type = 'approval.decided' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string') IS TRUE)
        OR (event_type = 'work_item.committed' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'receiptId') = 'string') IS TRUE)
        OR (event_type = 'trusted_effect.completed' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'operationId') = 'string') IS TRUE)
        OR (event_type IN ('approval.auto_approved', 'grant.created') AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string' AND jsonb_typeof(payload->'grantId') = 'string') IS TRUE)
        OR (event_type = 'grant.revoked' AND request_id IS NULL
            AND (jsonb_typeof(payload->'grantId') = 'string' AND NOT payload ? 'approvalId') IS TRUE)
        OR (event_type IN ('routine.created', 'routine.enabled', 'routine.disabled', 'routine.deleted')
            AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'routineId') = 'string') IS TRUE
            AND (jsonb_typeof(payload->'revision') = 'number') IS TRUE)
        OR (event_type = 'routine.firing_settled' AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'routineId') = 'string') IS TRUE
            AND (jsonb_typeof(payload->'scheduledFor') = 'string') IS TRUE)
        OR (event_type IN ('memory.created', 'memory.deleted', 'memory.suspended')
            AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'memoryId') = 'string') IS TRUE)) NOT VALID;

-- One natural key for the three memory facts: each happens at most once per entry. No existing
-- row matches the predicate, so the index is empty, but building it reads audit_events once
-- while the lock above is held.
CREATE UNIQUE INDEX audit_events_memory_fact ON birbcrew_ts.audit_events ((payload->>'memoryId'), event_type)
    WHERE event_type IN ('memory.created', 'memory.deleted', 'memory.suspended');

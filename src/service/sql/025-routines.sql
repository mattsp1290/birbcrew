-- Scheduled routines: an owner's UTC cron schedule, member and fixed prompt, and one row per
-- window the gateway's dispatcher (src/service/routines.ts) fired or skipped. Each fired window
-- opens a new conversation whose UUIDs the claim stores, so a retried firing reuses them.
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members for
-- the routines foreign key; ACCESS EXCLUSIVE on request_admissions and audit_events to widen
-- their CHECKs as 021 and 023 describe (dropped and re-added NOT VALID, so no row is scanned)
-- and to build two empty partial unique indexes on audit_events, which read audit_events once.
-- Crew takes request_admissions and audit_events in both orders: an admission inserts its row
-- and then its audit row, while a commit's audit insert locks audit_events before it reads the
-- admission. A migration holding one while it queued for the other could deadlock with such a
-- transaction, and the loser could be a running turn's commit. So all three are taken together
-- with NOWAIT and retried: the migration never waits in a lock queue, never joins a deadlock and
-- never holds sessions up while it waits. A native turn's admission transaction holds only
-- ACCESS SHARE on members (compatible) and nothing on the other two, so a running turn never
-- delays it. After 60 s without the locks it fails with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.request_admissions, birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

CREATE TABLE birbcrew_ts.routines (
    routine_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    create_request_id uuid NOT NULL,
    member_id uuid NOT NULL,
    schedule text NOT NULL CHECK (octet_length(schedule) BETWEEN 9 AND 128),
    prompt text NOT NULL CHECK (octet_length(prompt) BETWEEN 1 AND 16384),
    approval_policy text NOT NULL CHECK (approval_policy IN ('wait', 'fail_closed')),
    created_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('enabled', 'disabled', 'deleted')),
    disabled_reason text CHECK (disabled_reason IN ('owner', 'consecutive_failures')),
    consecutive_failures smallint NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 10),
    -- The first window not yet fired or skipped; only an enabled routine has one.
    next_window timestamptz,
    -- Raised by every lifecycle change; with routine_id it keys that change's audit row.
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (owner_id, create_request_id),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    CHECK ((state = 'disabled') = (disabled_reason IS NOT NULL)),
    CHECK ((state = 'enabled') = (next_window IS NOT NULL))
);
CREATE INDEX routines_due ON birbcrew_ts.routines (next_window) WHERE state = 'enabled';

-- At most 20 enabled routines per owner (routineLimits in routines.ts). The advisory lock
-- serialises enabling per owner until commit; under READ COMMITTED the count, a later
-- statement, then sees every enable committed before it. A replayed create skips its own
-- request so it never counts against itself.
CREATE FUNCTION birbcrew_ts.limit_enabled_routines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.state = 'enabled' THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('birbcrew_ts.routines/' || NEW.owner_id, 0));
    IF (SELECT count(*) FROM birbcrew_ts.routines WHERE owner_id = NEW.owner_id AND state = 'enabled'
          AND routine_id <> NEW.routine_id AND create_request_id <> NEW.create_request_id) >= 20 THEN
        RAISE EXCEPTION 'An owner may have at most 20 enabled routines'
            USING ERRCODE = '23514', CONSTRAINT = 'routines_enabled_limit';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER routines_enabled_limit BEFORE INSERT OR UPDATE OF state ON birbcrew_ts.routines
    FOR EACH ROW WHEN (NEW.state = 'enabled') EXECUTE FUNCTION birbcrew_ts.limit_enabled_routines();

-- A definition never changes (a new schedule is a new routine), and a deleted routine is a
-- tombstone that keeps its id and history.
CREATE FUNCTION birbcrew_ts.guard_routine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Routines are kept as tombstones' USING ERRCODE = '23514';
    END IF;
    IF (OLD.routine_id, OLD.owner_id, OLD.create_request_id, OLD.member_id, OLD.schedule, OLD.prompt,
        OLD.approval_policy, OLD.created_at) IS DISTINCT FROM (NEW.routine_id, NEW.owner_id, NEW.create_request_id,
        NEW.member_id, NEW.schedule, NEW.prompt, NEW.approval_policy, NEW.created_at) THEN
        RAISE EXCEPTION 'A routine definition is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'deleted' AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'A deleted routine never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER routines_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.routines
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_routine();

-- One row per window. No foreign key to conversations: the claim stores the conversation
-- before it exists. recordAcceptance binds them instead, refusing an admission whose
-- conversation is not the routine's owner and member or whose text is not its prompt.
CREATE TABLE birbcrew_ts.routine_firings (
    routine_id uuid NOT NULL REFERENCES birbcrew_ts.routines,
    scheduled_for timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('claimed', 'admitted', 'waiting', 'succeeded', 'failed', 'skipped')),
    reason text,
    conversation_id uuid,
    request_id uuid,
    recorded_at timestamptz NOT NULL,
    lease_until timestamptz,
    observed_at timestamptz,
    settled_at timestamptz,
    PRIMARY KEY (routine_id, scheduled_for),
    UNIQUE (conversation_id, request_id),
    CHECK ((status = 'skipped') = (conversation_id IS NULL)),
    CHECK ((conversation_id IS NULL) = (request_id IS NULL)),
    CHECK ((status = 'claimed') = (lease_until IS NOT NULL)),
    CHECK ((status IN ('succeeded', 'failed', 'skipped')) = (settled_at IS NOT NULL)),
    -- IS TRUE: a NULL reason makes IN yield NULL, which a CHECK would otherwise accept.
    CHECK ((CASE status
        WHEN 'skipped' THEN reason IN ('missed', 'overlap', 'owner_unavailable')
        WHEN 'failed' THEN reason IN ('rejected', 'approval_required', 'turn_failed', 'turn_cancelled', 'turn_uncertain')
        WHEN 'admitted' THEN reason IS NULL OR reason = 'approval_required'
        WHEN 'waiting' THEN reason IS NULL OR reason = 'approval_required'
        ELSE reason IS NULL END) IS TRUE)
);
-- An open firing (claimed, admitted or waiting) blocks the routine's next window.
CREATE UNIQUE INDEX routine_firings_one_open ON birbcrew_ts.routine_firings (routine_id)
    WHERE status IN ('claimed', 'admitted', 'waiting');
CREATE INDEX routine_firings_leases ON birbcrew_ts.routine_firings (lease_until) WHERE status = 'claimed';
CREATE INDEX routine_firings_observed ON birbcrew_ts.routine_firings (observed_at NULLS FIRST)
    WHERE status IN ('admitted', 'waiting');

-- A firing's identity never changes, so a retry reuses its conversation and request, and a
-- settled firing is history.
CREATE FUNCTION birbcrew_ts.guard_routine_firing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Routine firings are kept' USING ERRCODE = '23514';
    END IF;
    IF (OLD.routine_id, OLD.scheduled_for, OLD.conversation_id, OLD.request_id, OLD.recorded_at)
        IS DISTINCT FROM (NEW.routine_id, NEW.scheduled_for, NEW.conversation_id, NEW.request_id, NEW.recorded_at) THEN
        RAISE EXCEPTION 'A routine firing identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('succeeded', 'failed', 'skipped') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'A settled routine firing never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER routine_firings_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.routine_firings
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_routine_firing();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.routines
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.routine_firings
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- 023's recipe: drop and re-add NOT VALID in one ALTER TABLE. A routine names itself by id.
ALTER TABLE birbcrew_ts.request_admissions
    DROP CONSTRAINT request_admissions_initiator_kind_check,
    ADD CONSTRAINT request_admissions_initiator_kind_check CHECK (initiator_kind IN ('owner', 'routine')) NOT VALID;

-- 021's recipe. Only request-tied rows copy an admission's initiator, so only they can name a
-- routine. Keep the type list in step with auditEvents in src/service/audit.ts.
ALTER TABLE birbcrew_ts.audit_events
    DROP CONSTRAINT audit_events_initiator_check,
    ADD CONSTRAINT audit_events_initiator_check CHECK (
        (initiator_kind = 'owner' AND initiator_id = owner_id)
        OR (initiator_kind = 'routine' AND initiator_id IS NOT NULL AND request_id IS NOT NULL)) NOT VALID,
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
        -- The standing-grant types 024 added; this constraint replaces 024's, so it repeats them.
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
            AND (jsonb_typeof(payload->'scheduledFor') = 'string') IS TRUE)) NOT VALID;

-- Natural keys for the new facts. No existing row matches either predicate, so each index is
-- empty, but building it reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_routine_fact ON birbcrew_ts.audit_events ((payload->>'routineId'), (payload->>'revision'))
    WHERE event_type IN ('routine.created', 'routine.enabled', 'routine.disabled', 'routine.deleted');
CREATE UNIQUE INDEX audit_events_firing_fact ON birbcrew_ts.audit_events ((payload->>'routineId'), (payload->>'scheduledFor'))
    WHERE event_type = 'routine.firing_settled';

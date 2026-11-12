-- Append-only, owner-scoped record of who acted and when. Payloads carry
-- identifiers, digests, choices and statuses only: never prompt or reply text,
-- tool arguments, tokens or credentials.
-- Lets an audit row prove its conversation really belongs to its owner and member.
ALTER TABLE birbcrew_ts.conversations
    ADD CONSTRAINT conversations_owner_binding UNIQUE (conversation_id, owner_id, member_id);

CREATE TABLE birbcrew_ts.audit_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_kind text NOT NULL,
    actor_id text,
    initiator_kind text NOT NULL,
    initiator_id text NOT NULL,
    event_type text NOT NULL,
    member_id uuid NOT NULL,
    conversation_id uuid,
    request_id uuid,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1024),
    CONSTRAINT audit_events_actor_check CHECK (
        (actor_kind = 'owner' AND actor_id = owner_id) OR (actor_kind = 'system' AND actor_id IS NULL)),
    -- Later non-human initiators (routines, member handoff, standing approvals) widen this.
    CONSTRAINT audit_events_initiator_check CHECK (initiator_kind = 'owner' AND initiator_id = owner_id),
    -- The closed registry; keep in step with auditEvents in src/service/audit.ts.
    CONSTRAINT audit_events_type_check CHECK (
        (event_type = 'member.spawned' AND conversation_id IS NULL AND request_id IS NULL)
        OR (event_type = 'conversation.opened' AND conversation_id IS NOT NULL AND request_id IS NULL)
        OR (event_type IN ('request.accepted', 'request.cancellation_requested', 'request.finished')
            AND conversation_id IS NOT NULL AND request_id IS NOT NULL)
        -- IS TRUE: a missing key yields NULL, which a CHECK would otherwise accept.
        OR (event_type = 'approval.decided' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string') IS TRUE)
        OR (event_type = 'work_item.committed' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'receiptId') = 'string') IS TRUE)
        OR (event_type = 'trusted_effect.completed' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'operationId') = 'string') IS TRUE)),
    CHECK (request_id IS NULL OR conversation_id IS NOT NULL),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    FOREIGN KEY (conversation_id, owner_id, member_id)
        REFERENCES birbcrew_ts.conversations (conversation_id, owner_id, member_id)
);

-- One row per fact: retried activities and replayed requests hit these and append nothing.
CREATE UNIQUE INDEX audit_events_member_fact ON birbcrew_ts.audit_events (member_id)
    WHERE event_type = 'member.spawned';
CREATE UNIQUE INDEX audit_events_conversation_fact ON birbcrew_ts.audit_events (conversation_id)
    WHERE event_type = 'conversation.opened';
CREATE UNIQUE INDEX audit_events_request_fact ON birbcrew_ts.audit_events (event_type, conversation_id, request_id)
    WHERE event_type IN ('request.accepted', 'request.cancellation_requested', 'request.finished');
CREATE UNIQUE INDEX audit_events_approval_fact ON birbcrew_ts.audit_events ((payload->>'approvalId'))
    WHERE event_type = 'approval.decided';
CREATE UNIQUE INDEX audit_events_receipt_fact ON birbcrew_ts.audit_events ((payload->>'receiptId'))
    WHERE event_type = 'work_item.committed';
CREATE UNIQUE INDEX audit_events_operation_fact ON birbcrew_ts.audit_events ((payload->>'operationId'))
    WHERE event_type = 'trusted_effect.completed';

CREATE INDEX audit_events_owner_page ON birbcrew_ts.audit_events (owner_id, event_id);
CREATE INDEX audit_events_conversation_page ON birbcrew_ts.audit_events (owner_id, conversation_id, event_id)
    WHERE conversation_id IS NOT NULL;

-- Every writer holds this shared lock from before its identity value is drawn until
-- commit. A reader that briefly obtains it exclusively knows no lower ID is still
-- uncommitted, so keyset pages cannot skip a late commit. Statement triggers fire
-- before column defaults are evaluated.
CREATE FUNCTION birbcrew_ts.order_audit_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('birbcrew_ts.audit_events', 0));
    RETURN NULL;
END;
$$;
CREATE TRIGGER audit_events_append_order BEFORE INSERT ON birbcrew_ts.audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.order_audit_append();

CREATE FUNCTION birbcrew_ts.reject_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '23514';
END;
$$;
-- Statement level so even a zero-row UPDATE/DELETE and TRUNCATE are refused.
-- pg_restore creates triggers after loading data, so restore is unaffected.
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_audit_change();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

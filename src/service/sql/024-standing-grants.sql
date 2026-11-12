-- Standing approval grants (docs/standing-grants.md). An owner who answers a real
-- record_work_item card with allow_conversation or allow_always creates a grant, and a
-- later top-level call of the same member that the grant covers is inserted already
-- approved, naming the grant. Grants are revoked by setting a timestamp, never deleted.
--
-- Locks, all held until migrate() commits (PostgreSQL 17): ACCESS EXCLUSIVE on
-- deferred_calls and audit_events, SHARE ROW EXCLUSIVE on members and conversations
-- (foreign keys). They are taken in the order Crew's transactions use these tables
-- (deferred_calls before audit_events, which every writer appends to last), so the
-- migration cannot deadlock with them. The new columns have no default, and every new
-- constraint on an existing table is NOT VALID, so neither table is rewritten or scanned
-- to check them. The one scan is the unique index build on audit_events below. A native
-- turn's admission transaction (native-admission.ts) touches none of these tables in a
-- conflicting mode, and the Codex live path holds them only in short transactions, so a
-- running turn does not hold up the migration.
ALTER TABLE birbcrew_ts.deferred_calls
    -- The standing choice the owner made on this card. The decision stays 'approve'; the
    -- reported choice is derived from both (allow_conversation or allow_always).
    ADD COLUMN grant_scope text,
    -- The grant that approved this call when it was proposed. Such a call has no card.
    ADD COLUMN grant_id uuid,
    -- Only an approved top-level record_work_item call can carry either, and never both. IS NOT
    -- DISTINCT FROM: an undecided call's NULL decision would otherwise pass the CHECK.
    ADD CONSTRAINT deferred_calls_grant_scope_check CHECK (grant_scope IS NULL OR (grant_scope IN ('conversation', 'member')
        AND decision IS NOT DISTINCT FROM 'approve' AND grant_id IS NULL AND tool_name = 'record_work_item'
        AND invocation_id = request_id)) NOT VALID,
    ADD CONSTRAINT deferred_calls_grant_id_check CHECK (grant_id IS NULL OR (decision IS NOT DISTINCT FROM 'approve'
        AND tool_name = 'record_work_item' AND invocation_id = request_id)) NOT VALID;

CREATE TABLE birbcrew_ts.tool_grants (
    grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    member_id uuid NOT NULL,
    -- NULL covers every conversation of the member (allow_always).
    conversation_id uuid REFERENCES birbcrew_ts.conversations (conversation_id),
    tool_name text NOT NULL CHECK (tool_name = 'record_work_item'),
    -- A change to the tool's arguments raises the policy version, which no grant matches.
    policy_version smallint NOT NULL CHECK (policy_version = 1),
    -- Grants cover only requests whose admission names this initiator.
    initiator_kind text NOT NULL CHECK (initiator_kind = 'owner'),
    -- The card whose answer created the grant.
    approval_id uuid NOT NULL UNIQUE REFERENCES birbcrew_ts.deferred_calls (approval_id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    revocation_reason text CHECK (revocation_reason IN ('owner', 'recovery_restore')),
    CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
    -- No composite key to conversations: adding the unique constraint it needs would take
    -- ACCESS EXCLUSIVE on conversations and queue behind a native turn. The trigger below
    -- binds the conversation instead.
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id)
);
-- One active grant per key: two concurrent allow_always answers create one grant.
CREATE UNIQUE INDEX tool_grants_active_key ON birbcrew_ts.tool_grants
    (owner_id, member_id, conversation_id, tool_name, policy_version, initiator_kind) NULLS NOT DISTINCT
    WHERE revoked_at IS NULL;
CREATE INDEX tool_grants_member ON birbcrew_ts.tool_grants (owner_id, member_id);

ALTER TABLE birbcrew_ts.deferred_calls
    ADD CONSTRAINT deferred_calls_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES birbcrew_ts.tool_grants NOT VALID;

-- The card must be visible to this lookup, belong to the grant's owner and member, and have
-- been answered with this grant's scope (deferred_calls_grant_scope_check limits that to an
-- approved top-level work item), and a conversation grant must name the card's conversation.
-- As in bind_audit_conversation
-- (021-audit.sql), a card or conversation the lookup cannot see is refused here rather than
-- left to the foreign keys, whose later check could accept one another owner committed in
-- between. A grant changes only when it is revoked, once, so the binding columns never
-- change after this check.
CREATE FUNCTION birbcrew_ts.guard_tool_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE card record;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
           OR (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason') IS DISTINCT FROM (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason') THEN
            RAISE EXCEPTION 'A grant changes only when it is revoked, once' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    SELECT c.owner_id, c.member_id, c.conversation_id, p.grant_scope INTO card FROM birbcrew_ts.deferred_calls p
      JOIN birbcrew_ts.conversations c USING (conversation_id) WHERE p.approval_id = NEW.approval_id;
    IF NOT FOUND OR (card.owner_id, card.member_id) IS DISTINCT FROM (NEW.owner_id, NEW.member_id)
       OR card.grant_scope IS DISTINCT FROM (CASE WHEN NEW.conversation_id IS NULL THEN 'member' ELSE 'conversation' END)
       OR (NEW.conversation_id IS NOT NULL AND NEW.conversation_id <> card.conversation_id) THEN
        RAISE EXCEPTION 'Grant card is missing, was not answered with this scope, or belongs to another owner, member or conversation'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tool_grants_binding BEFORE INSERT OR UPDATE ON birbcrew_ts.tool_grants
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_tool_grant();
CREATE FUNCTION birbcrew_ts.reject_grant_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Grants are revoked, never deleted' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER tool_grants_kept BEFORE DELETE OR TRUNCATE ON birbcrew_ts.tool_grants
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_grant_removal();
-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.tool_grants
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- Widen the closed audit registry as 021-audit.sql documents: drop and re-add in one ALTER
-- TABLE with the new constraint NOT VALID, so existing rows are not scanned under the lock.
-- Keep in step with auditEvents in src/service/audit.ts.
ALTER TABLE birbcrew_ts.audit_events DROP CONSTRAINT audit_events_type_check,
    ADD CONSTRAINT audit_events_type_check CHECK (
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
            AND (jsonb_typeof(payload->'operationId') = 'string') IS TRUE)
        OR (event_type IN ('approval.auto_approved', 'grant.created') AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string' AND jsonb_typeof(payload->'grantId') = 'string') IS TRUE)
        OR (event_type = 'grant.revoked' AND request_id IS NULL
            AND (jsonb_typeof(payload->'grantId') = 'string' AND NOT payload ? 'approvalId') IS TRUE)) NOT VALID;
-- One index for the three new types, so the migration scans audit_events once. A grant
-- event is one row per grant (revocations name no call), an auto-approval one per call.
CREATE UNIQUE INDEX audit_events_grant_fact ON birbcrew_ts.audit_events
    (event_type, (payload->>'grantId'), (payload->>'approvalId')) NULLS NOT DISTINCT
    WHERE event_type IN ('approval.auto_approved', 'grant.created', 'grant.revoked');

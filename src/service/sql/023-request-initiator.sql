-- What started each request, recorded once when it is admitted. The owner's identity is
-- the conversation's owner_id, so an owner admission stores no initiator_id.
-- This migration locks request_admissions only, ACCESS EXCLUSIVE until migrate() commits.
-- The constant default fills existing rows from the catalog without a rewrite or scan, and
-- NOT VALID skips the constraints' scan, so the lock is held briefly. It waits only for
-- transactions already touching request_admissions: admissions, rejections, cancellation
-- intents, turn starts, reconciliation, status reads and request-tied audit appends. None
-- of them waits for application work while holding it. A native turn's admission
-- transaction (native-admission.ts) and the trusted-context lease never touch
-- request_admissions, so a running turn does not hold up the migration.
ALTER TABLE birbcrew_ts.request_admissions
    ADD COLUMN initiator_kind text NOT NULL DEFAULT 'owner',
    ADD COLUMN initiator_id text,
    -- Later initiators (scheduled routines, member handoff) widen this in their own migration,
    -- with audit_events_initiator_check and RequestInitiator in domain.ts. appendAudit copies
    -- whatever the admission recorded and needs no change. As for 021-audit.sql, drop and
    -- re-add it in one ALTER TABLE with the new constraint NOT VALID: existing rows satisfy a
    -- wider predicate, and NOT VALID skips the full-table scan under ACCESS EXCLUSIVE.
    -- VALIDATE, if wanted, runs outside migrate() under SHARE UPDATE EXCLUSIVE.
    ADD CONSTRAINT request_admissions_initiator_kind_check CHECK (initiator_kind IN ('owner')) NOT VALID,
    -- Every kind but the owner names its initiator, so widening leaves this one alone.
    ADD CONSTRAINT request_admissions_initiator_id_check CHECK ((initiator_kind = 'owner') = (initiator_id IS NULL)) NOT VALID;
-- Existing rows keep 'owner'. With no default, an insert that does not name its initiator fails.
ALTER TABLE birbcrew_ts.request_admissions ALTER COLUMN initiator_kind DROP DEFAULT;

-- Audit rows and policy read the initiator long after admission, so it never changes.
CREATE FUNCTION birbcrew_ts.reject_initiator_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'A request initiator is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_request_initiator
    BEFORE UPDATE OF initiator_kind, initiator_id ON birbcrew_ts.request_admissions FOR EACH ROW
    WHEN ((OLD.initiator_kind, OLD.initiator_id) IS DISTINCT FROM (NEW.initiator_kind, NEW.initiator_id))
    EXECUTE FUNCTION birbcrew_ts.reject_initiator_change();

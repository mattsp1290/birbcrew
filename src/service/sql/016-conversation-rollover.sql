-- Preserve existing proof conversations' admission contract. Old closed runs are
-- not resurrected; new conversations use the bounded long-lived contract.
ALTER TABLE birbcrew_ts.conversations ADD COLUMN turn_limit smallint NOT NULL DEFAULT 4
    CHECK (turn_limit IN (4, 128));
ALTER TABLE birbcrew_ts.conversations ALTER COLUMN turn_limit SET DEFAULT 128;
ALTER TABLE birbcrew_ts.turns DROP CONSTRAINT turns_position_check;
ALTER TABLE birbcrew_ts.turns ADD CONSTRAINT turns_position_check CHECK (position BETWEEN 1 AND 128);
CREATE OR REPLACE FUNCTION birbcrew_ts.enforce_turn_budget() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.position > (SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id=NEW.conversation_id) THEN
            RAISE EXCEPTION 'Conversation turn budget exhausted' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $$;
CREATE TRIGGER bounded_turn_position BEFORE INSERT OR UPDATE OF position ON birbcrew_ts.turns
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.enforce_turn_budget();

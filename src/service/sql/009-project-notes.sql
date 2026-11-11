CREATE TABLE birbcrew_ts.conversation_notes (
    conversation_id uuid PRIMARY KEY REFERENCES birbcrew_ts.conversations,
    capture jsonb NOT NULL
);

CREATE TRIGGER immutable_note_capture BEFORE UPDATE ON birbcrew_ts.conversation_notes
    FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION birbcrew_ts.reject_rebind();

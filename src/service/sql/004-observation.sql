CREATE TABLE IF NOT EXISTS birbcrew_ts.public_snapshots (
    conversation_id uuid PRIMARY KEY REFERENCES birbcrew_ts.conversations,
    history_complete boolean NOT NULL DEFAULT true,
    cursor integer NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    messages jsonb NOT NULL DEFAULT '[]',
    state jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.public_events (
    conversation_id uuid NOT NULL REFERENCES birbcrew_ts.public_snapshots,
    cursor integer NOT NULL,
    event jsonb NOT NULL,
    PRIMARY KEY (conversation_id, cursor)
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.public_publications (
    conversation_id uuid NOT NULL REFERENCES birbcrew_ts.public_snapshots,
    logical_key text NOT NULL,
    PRIMARY KEY (conversation_id, logical_key)
);

-- Earlier turns kept prompt digests only. An empty transcript would misrepresent that history.
INSERT INTO birbcrew_ts.public_snapshots (conversation_id, history_complete, state)
    SELECT DISTINCT conversation_id, false, '{}'::jsonb FROM birbcrew_ts.turns
    ON CONFLICT DO NOTHING;

CREATE TABLE birbcrew_ts.codex_item_receipts (
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 127),
    bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 65536),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    PRIMARY KEY (conversation_id, request_id, ordinal),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns (conversation_id, request_id)
);

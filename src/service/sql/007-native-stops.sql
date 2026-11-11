CREATE TABLE IF NOT EXISTS birbcrew_ts.native_stop_requests (
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    token uuid NOT NULL,
    PRIMARY KEY (conversation_id, request_id, token),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns
);

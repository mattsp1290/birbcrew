CREATE TABLE IF NOT EXISTS birbcrew_ts.native_launches (
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    token uuid NOT NULL,
    workflow_run_id text NOT NULL,
    activity_id text NOT NULL,
    attempt integer NOT NULL CHECK (attempt > 0),
    approval_id uuid UNIQUE,
    receipt_digest bytea,
    CHECK ((approval_id IS NULL AND receipt_digest IS NULL)
        OR (approval_id IS NOT NULL AND receipt_digest IS NOT NULL AND octet_length(receipt_digest) = 32)),
    FOREIGN KEY (conversation_id, request_id, approval_id)
        REFERENCES birbcrew_ts.protected_calls (conversation_id, request_id, approval_id),
    recovery_closed boolean NOT NULL DEFAULT false,
    stopped boolean NOT NULL DEFAULT false,
    PRIMARY KEY (conversation_id, request_id, token),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns
);

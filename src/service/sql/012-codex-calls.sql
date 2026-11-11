CREATE TABLE birbcrew_ts.codex_live_calls (
    approval_id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    token uuid NOT NULL,
    thread_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    phase text NOT NULL DEFAULT 'waiting' CHECK (phase IN ('waiting','dispatching','delivered','interrupted')),
    FOREIGN KEY (conversation_id,request_id,approval_id) REFERENCES birbcrew_ts.deferred_calls (conversation_id,request_id,approval_id),
    FOREIGN KEY (conversation_id,request_id,token) REFERENCES birbcrew_ts.native_launches (conversation_id,request_id,token)
);
CREATE INDEX codex_live_calls_turn ON birbcrew_ts.codex_live_calls (conversation_id,request_id,token);
CREATE INDEX codex_live_calls_deadline ON birbcrew_ts.codex_live_calls (expires_at,conversation_id)
    WHERE phase IN ('waiting','dispatching');

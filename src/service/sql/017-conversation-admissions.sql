-- Durable admission identity outlives a Temporal execution and its Update history.
CREATE TABLE birbcrew_ts.request_admissions (
    conversation_id uuid NOT NULL REFERENCES birbcrew_ts.conversations,
    request_id uuid NOT NULL,
    prompt_digest bytea NOT NULL CHECK (octet_length(prompt_digest)=32),
    phase text NOT NULL DEFAULT 'accepted' CHECK (phase IN ('accepted','rejected')),
    reason text CHECK (reason IN ('predecessor_failed','predecessor_cancelled')),
    PRIMARY KEY(conversation_id,request_id),
    CHECK ((phase='rejected') = (reason IS NOT NULL))
);
INSERT INTO birbcrew_ts.request_admissions(conversation_id,request_id,prompt_digest)
    SELECT conversation_id,request_id,prompt_digest FROM birbcrew_ts.turns;

CREATE TABLE birbcrew_ts.tool_previews (
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    native_call_id text NOT NULL CHECK (octet_length(native_call_id) BETWEEN 1 AND 256),
    public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    generation uuid NOT NULL,
    PRIMARY KEY (conversation_id,request_id,invocation_id),
    FOREIGN KEY (conversation_id,request_id) REFERENCES birbcrew_ts.turns
);
ALTER TABLE birbcrew_ts.public_snapshots ADD COLUMN open_tools jsonb NOT NULL DEFAULT '{}';

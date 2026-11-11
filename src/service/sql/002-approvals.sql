CREATE TABLE IF NOT EXISTS birbcrew_ts.protected_calls (
    approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    native_call_id text NOT NULL CHECK (octet_length(native_call_id) BETWEEN 1 AND 256),
    tool_name text NOT NULL CHECK (tool_name = 'record_work_item'),
    arguments jsonb NOT NULL CHECK (
        jsonb_typeof(arguments) = 'object' AND arguments ? 'operation_id'
        AND arguments->>'operation_id' = request_id::text
    ),
    argument_digest text NOT NULL CHECK (argument_digest ~ '^[a-f0-9]{64}$'),
    policy_version smallint NOT NULL CHECK (policy_version = 1),
    decision_version smallint NOT NULL CHECK (decision_version = 1),
    budget_exhausted boolean NOT NULL DEFAULT false CHECK (NOT budget_exhausted OR decision IS NOT DISTINCT FROM 'approve'),
    decision text CHECK (decision IN ('approve', 'deny')),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns,
    UNIQUE (conversation_id, request_id, invocation_id, native_call_id),
    UNIQUE (conversation_id, request_id, approval_id)
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.work_items (
    receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    note text,
    UNIQUE (conversation_id, request_id),
    FOREIGN KEY (conversation_id, request_id, approval_id)
        REFERENCES birbcrew_ts.protected_calls (conversation_id, request_id, approval_id)
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.tool_cancellations (
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    PRIMARY KEY (conversation_id, request_id),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.paused_segments (
    approval_id uuid PRIMARY KEY REFERENCES birbcrew_ts.protected_calls (approval_id),
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    checkpoint jsonb NOT NULL,
    resume_activity_id text,
    UNIQUE (conversation_id, request_id),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns
);

ALTER TABLE birbcrew_ts.profiles ADD COLUMN IF NOT EXISTS protected_tool text
    CHECK (protected_tool = 'record_work_item');

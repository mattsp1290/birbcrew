CREATE TABLE IF NOT EXISTS birbcrew_ts.delegations (
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    parent_checkpoint jsonb NOT NULL,
    resume_activity_id text,
    PRIMARY KEY (conversation_id, request_id),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.pi_children (
    child_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    native_call_id text NOT NULL,
    ordinal smallint NOT NULL CHECK (ordinal IN (0,1)),
    task text NOT NULL,
    role_profile jsonb NOT NULL,
    phase text NOT NULL DEFAULT 'ready' CHECK (phase IN ('ready','running','waiting','resuming','complete','failed','cancelled')),
    generation uuid,
    launch_revoked boolean NOT NULL DEFAULT false,
    workflow_run_id text,
    activity_id text,
    attempt integer,
    native_checkpoint jsonb,
    approval_id uuid REFERENCES birbcrew_ts.protected_calls,
    outcome jsonb,
    UNIQUE (conversation_id, request_id, native_call_id),
    UNIQUE (conversation_id, request_id, ordinal),
    UNIQUE (conversation_id, request_id, child_id),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.delegations,
    CHECK ((phase IN ('complete','failed','cancelled')) = (outcome IS NOT NULL))
);

ALTER TABLE birbcrew_ts.profiles ADD COLUMN delegate_task boolean NOT NULL DEFAULT false
    CHECK (NOT delegate_task OR engine = 'pi');


ALTER TABLE birbcrew_ts.native_launches ADD COLUMN child_id uuid,
    ADD FOREIGN KEY (conversation_id, request_id, child_id)
        REFERENCES birbcrew_ts.pi_children (conversation_id, request_id, child_id);

ALTER TABLE birbcrew_ts.public_snapshots ADD COLUMN child_open_text jsonb NOT NULL DEFAULT '{}';

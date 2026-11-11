CREATE SCHEMA IF NOT EXISTS birbcrew_ts;

CREATE TABLE IF NOT EXISTS birbcrew_ts.members (
    member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL CHECK (octet_length(owner_id) BETWEEN 1 AND 256),
    spawn_request_id uuid NOT NULL,
    engine text NOT NULL CHECK (engine IN ('pi', 'claude')),
    profile text NOT NULL CHECK (octet_length(profile) BETWEEN 1 AND 128),
    UNIQUE (owner_id, spawn_request_id),
    UNIQUE (owner_id, member_id)
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.conversations (
    conversation_id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    member_id uuid NOT NULL,
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id)
);

CREATE TABLE IF NOT EXISTS birbcrew_ts.turns (
    conversation_id uuid NOT NULL REFERENCES birbcrew_ts.conversations,
    request_id uuid NOT NULL,
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 4),
    prompt_digest bytea NOT NULL CHECK (octet_length(prompt_digest) = 32),
    token uuid NOT NULL DEFAULT gen_random_uuid(),
    workflow_run_id text,
    activity_id text,
    attempt integer NOT NULL CHECK (attempt > 0),
    CHECK ((workflow_run_id IS NULL) = (activity_id IS NULL)),
    phase text NOT NULL CHECK (phase IN ('started', 'uncertain', 'committed')),
    reply text CHECK (octet_length(reply) BETWEEN 1 AND 65536),
    checkpoint jsonb,
    PRIMARY KEY (conversation_id, request_id),
    UNIQUE (conversation_id, position),
    CHECK (
        (phase = 'committed' AND reply IS NOT NULL AND checkpoint IS NOT NULL) OR
        (phase <> 'committed' AND reply IS NULL AND checkpoint IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_turn
    ON birbcrew_ts.turns (conversation_id) WHERE phase <> 'committed';

CREATE OR REPLACE FUNCTION birbcrew_ts.reject_rebind() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'Member and conversation bindings are immutable' USING ERRCODE = '23514';
    END;
    $$;

CREATE OR REPLACE TRIGGER immutable_member
    BEFORE UPDATE ON birbcrew_ts.members FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION birbcrew_ts.reject_rebind();

CREATE OR REPLACE TRIGGER immutable_conversation_binding
    BEFORE UPDATE OF conversation_id, owner_id, member_id ON birbcrew_ts.conversations FOR EACH ROW
    WHEN ((OLD.conversation_id, OLD.owner_id, OLD.member_id)
          IS DISTINCT FROM (NEW.conversation_id, NEW.owner_id, NEW.member_id))
    EXECUTE FUNCTION birbcrew_ts.reject_rebind();

CREATE TABLE IF NOT EXISTS birbcrew_ts.profiles (
    name text NOT NULL,
    engine text NOT NULL CHECK (engine IN ('pi', 'claude')),
    account_digest bytea NOT NULL,
    volume uuid,
    PRIMARY KEY (name, engine),
    CHECK ((engine = 'claude') = (volume IS NOT NULL))
);

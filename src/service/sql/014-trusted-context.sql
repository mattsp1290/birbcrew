-- Isolated backend-owned application seam. Observer requests cannot select this mode.
CREATE TABLE birbcrew_ts.trusted_sessions (
 conversation_id uuid PRIMARY KEY REFERENCES birbcrew_ts.conversations,
 owner_id text NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
 native_thread_id uuid NOT NULL DEFAULT gen_random_uuid(),
 phase text NOT NULL DEFAULT 'active' CHECK (phase IN ('active','draining','deleted')),
 scope text NOT NULL CHECK (octet_length(scope) BETWEEN 1 AND 256),
 context_version text NOT NULL CHECK (octet_length(context_version) BETWEEN 1 AND 256),
 context_text text CHECK (octet_length(context_text) <= 65536),
 application_digest text NOT NULL,
 checkpoint jsonb
);
CREATE TABLE birbcrew_ts.trusted_requests (
 conversation_id uuid NOT NULL REFERENCES birbcrew_ts.trusted_sessions,
 request_id uuid NOT NULL,
 position integer NOT NULL CHECK (position BETWEEN 1 AND 1024),
 generation integer NOT NULL,
 prompt text CHECK (octet_length(prompt) <= 16384),
 prompt_digest text NOT NULL,
 phase text NOT NULL CHECK (phase IN ('queued','held','running','completed','cancelled','uncertain')),
 token uuid,
 reply text CHECK (octet_length(reply) <= 65536),
 PRIMARY KEY (conversation_id,request_id), UNIQUE (conversation_id,position)
);
CREATE UNIQUE INDEX trusted_one_running ON birbcrew_ts.trusted_requests(conversation_id) WHERE phase='running';
CREATE TABLE birbcrew_ts.trusted_tool_calls (
 conversation_id uuid NOT NULL,
 request_id uuid NOT NULL,
 native_call_id text NOT NULL,
 generation integer NOT NULL,
 tool_name text NOT NULL,
 argument_digest text NOT NULL,
 operation_id uuid NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('read','effect')),
 outcome text NOT NULL DEFAULT 'admitted' CHECK (outcome IN ('admitted','completed','uncertain')),
 result jsonb,
 released boolean NOT NULL DEFAULT false,
 acknowledged boolean NOT NULL DEFAULT false CHECK (NOT acknowledged OR released),
 PRIMARY KEY (conversation_id,request_id,native_call_id),
 FOREIGN KEY (conversation_id,request_id) REFERENCES birbcrew_ts.trusted_requests
);

-- Keep opaque native locations across rotations for explicit private-volume deletion.
CREATE TABLE birbcrew_ts.trusted_generations (
 conversation_id uuid NOT NULL REFERENCES birbcrew_ts.trusted_sessions,
 generation integer NOT NULL,
 native_thread_id uuid NOT NULL,
 PRIMARY KEY (conversation_id,generation)
);
CREATE FUNCTION birbcrew_ts.record_trusted_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO birbcrew_ts.trusted_generations VALUES (NEW.conversation_id,NEW.generation,NEW.native_thread_id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER trusted_generation_location AFTER INSERT OR UPDATE OF generation ON birbcrew_ts.trusted_sessions
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.record_trusted_generation();

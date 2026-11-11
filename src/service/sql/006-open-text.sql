ALTER TABLE birbcrew_ts.public_snapshots ADD COLUMN open_text jsonb;
ALTER TABLE birbcrew_ts.public_publications ADD COLUMN payload_digest bytea;

CREATE FUNCTION pg_temp.redact_approval_ids(state jsonb) RETURNS jsonb
LANGUAGE sql AS $$
    SELECT CASE WHEN state ? 'pendingApprovals' THEN jsonb_set(state, '{pendingApprovals}', COALESCE((
        SELECT jsonb_agg(card - 'nativeCallId' ORDER BY ordinal)
        FROM jsonb_array_elements(state->'pendingApprovals') WITH ORDINALITY AS pending(card, ordinal)
    ), '[]'::jsonb)) ELSE state END
$$;
UPDATE birbcrew_ts.public_snapshots SET state = pg_temp.redact_approval_ids(state);
UPDATE birbcrew_ts.public_events SET event = jsonb_set(event, '{snapshot}', pg_temp.redact_approval_ids(event->'snapshot'))
    WHERE event->>'type' = 'STATE_SNAPSHOT';

CREATE FUNCTION pg_temp.redact_generated_text(cid uuid, original text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    protected_id text;
BEGIN
    FOR protected_id IN SELECT DISTINCT native_call_id FROM birbcrew_ts.protected_calls WHERE conversation_id = cid
    LOOP
        original := replace(original, protected_id, '[tool call]');
    END LOOP;
    RETURN original;
END
$$;

CREATE FUNCTION pg_temp.redact_generated_messages(cid uuid, messages jsonb) RETURNS jsonb
LANGUAGE sql AS $$
    SELECT COALESCE(jsonb_agg(CASE WHEN message->>'role' = 'assistant' AND jsonb_typeof(message->'content') = 'string'
        THEN jsonb_set(message, '{content}', to_jsonb(pg_temp.redact_generated_text(cid, message->>'content')))
        ELSE message END ORDER BY ordinal), '[]'::jsonb)
    FROM jsonb_array_elements(messages) WITH ORDINALITY AS history(message, ordinal)
$$;
UPDATE birbcrew_ts.public_snapshots SET messages = pg_temp.redact_generated_messages(conversation_id, messages);
UPDATE birbcrew_ts.public_events SET event = jsonb_set(event, '{messages}', pg_temp.redact_generated_messages(conversation_id, event->'messages'))
    WHERE event->>'type' = 'MESSAGES_SNAPSHOT';
UPDATE birbcrew_ts.public_events SET event = jsonb_set(event, '{delta}', to_jsonb(pg_temp.redact_generated_text(conversation_id, event->>'delta')))
    WHERE event->>'type' = 'TEXT_MESSAGE_CONTENT';

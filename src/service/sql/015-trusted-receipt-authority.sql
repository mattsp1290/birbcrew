-- Retain only the historical authority identifiers required for receipt policy.
-- Older rotated calls cannot be safely attributed: leave NULL and deny readback.
ALTER TABLE birbcrew_ts.trusted_tool_calls ADD COLUMN scope text;
ALTER TABLE birbcrew_ts.trusted_tool_calls ADD COLUMN context_version text;
UPDATE birbcrew_ts.trusted_tool_calls c SET scope=s.scope,context_version=s.context_version
 FROM birbcrew_ts.trusted_sessions s
 WHERE c.conversation_id=s.conversation_id AND c.generation=s.generation AND s.phase='active';

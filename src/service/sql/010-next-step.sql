ALTER TABLE birbcrew_ts.protected_calls RENAME TO deferred_calls;
ALTER TABLE birbcrew_ts.deferred_calls
    DROP CONSTRAINT protected_calls_tool_name_check,
    DROP CONSTRAINT protected_calls_check,
    DROP CONSTRAINT protected_calls_decision_check,
    ADD CHECK (
        (tool_name = 'record_work_item' AND jsonb_typeof(arguments) = 'object'
            AND arguments ? 'operation_id' AND arguments->>'operation_id' = request_id::text
            AND (decision IS NULL OR decision IN ('approve', 'deny')))
        OR (tool_name = 'choose_next_step' AND arguments = '{}'::jsonb
            AND (decision IS NULL OR decision IN ('inspect', 'test')))
    ),
    ADD UNIQUE (approval_id, tool_name);

-- A receipt can reference only a protected call, even if inserted by another writer.
ALTER TABLE birbcrew_ts.work_items
    ADD COLUMN tool_name text GENERATED ALWAYS AS ('record_work_item'::text) STORED,
    ADD FOREIGN KEY (approval_id, tool_name) REFERENCES birbcrew_ts.deferred_calls (approval_id, tool_name);

ALTER TABLE birbcrew_ts.pi_children
    ADD COLUMN approval_tool text GENERATED ALWAYS AS ('record_work_item'::text) STORED,
    ADD FOREIGN KEY (approval_id, approval_tool) REFERENCES birbcrew_ts.deferred_calls (approval_id, tool_name);

CREATE VIEW birbcrew_ts.protected_calls AS SELECT * FROM birbcrew_ts.deferred_calls
    WHERE tool_name = 'record_work_item' WITH LOCAL CHECK OPTION;

ALTER TABLE birbcrew_ts.profiles ADD COLUMN human_tool text
    CHECK (human_tool IS NULL OR (human_tool = 'choose_next_step' AND protected_tool IS NULL AND NOT delegate_task));

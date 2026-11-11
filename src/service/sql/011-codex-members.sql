ALTER TABLE birbcrew_ts.members
    DROP CONSTRAINT members_engine_check,
    ADD CONSTRAINT members_engine_check CHECK (engine IN ('pi', 'claude', 'codex'));

ALTER TABLE birbcrew_ts.profiles
    DROP CONSTRAINT profiles_engine_check,
    DROP CONSTRAINT profiles_check,
    ADD CONSTRAINT profiles_engine_check CHECK (engine IN ('pi', 'claude', 'codex')),
    ADD CONSTRAINT profiles_native_volume_check CHECK ((engine IN ('claude', 'codex')) = (volume IS NOT NULL));

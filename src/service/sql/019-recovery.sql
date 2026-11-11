-- Recovery state is private operator control, never exposed through the gateway.
CREATE TABLE birbcrew_ts.recovery_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 installation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
 phase text NOT NULL DEFAULT 'active' CHECK(phase IN ('active','frozen','restored')),
 generation uuid,
 CHECK((phase='active')=(generation IS NULL))
);
INSERT INTO birbcrew_ts.recovery_control(singleton) VALUES(true);
CREATE TABLE birbcrew_ts.recovery_runs (
 generation uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 manifest_sha256 text CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION birbcrew_ts.require_active_installation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Held until the writer transaction commits. Freeze waits for all such writers.
 PERFORM 1 FROM birbcrew_ts.recovery_control WHERE singleton AND phase='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Installation is held for recovery' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END;
$$;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='birbcrew_ts'
   AND tablename NOT IN ('recovery_control','recovery_runs')
 LOOP
  EXECUTE format('CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.%I FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation()',t.tablename);
 END LOOP;
END $$;

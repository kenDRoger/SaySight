-- A refresh check is evidence of what a maintainer observed at a point in time.
-- It is appended once and never rewritten; a new observation is a new row.
CREATE TABLE release_checks (
  id UUID PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES dataset_releases(id),
  status TEXT NOT NULL CHECK (status IN ('unchanged', 'changed', 'unreachable')),
  source_checksum TEXT,
  previous_checksum TEXT,
  drift JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX release_checks_release_created_idx ON release_checks (release_id, created_at);

CREATE TRIGGER release_checks_append_only
  BEFORE UPDATE OR DELETE ON release_checks
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER release_checks_no_truncate
  BEFORE TRUNCATE ON release_checks
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

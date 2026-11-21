-- Every connector check is recorded, including the ones that fail: a portal that
-- cannot be read is reported as unavailable, never silently skipped and never
-- faked. A failed read is recorded as a row, never swallowed.
CREATE TABLE connector_checks (
  id UUID PRIMARY KEY,
  connector TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  http_status INTEGER,
  dataset_count INTEGER,
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connector_checks_connector_created_idx ON connector_checks (connector, created_at);

CREATE TRIGGER connector_checks_append_only
  BEFORE UPDATE OR DELETE ON connector_checks
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER connector_checks_no_truncate
  BEFORE TRUNCATE ON connector_checks
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

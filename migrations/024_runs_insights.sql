-- One run bundles the insights from one dataset/join selection and filter set,
-- so a reviewer can accept or reject each insight separately (S6).
CREATE TABLE runs (
  id UUID PRIMARY KEY,
  connector_ids JSONB NOT NULL DEFAULT '[]',
  release_ids JSONB NOT NULL DEFAULT '[]',
  filters JSONB NOT NULL DEFAULT '{}',
  selection JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE insights (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id),
  recipe TEXT NOT NULL,
  dataset_release_id TEXT REFERENCES dataset_releases(id),
  recipe_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  evidence_id UUID REFERENCES analysis_runs(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An insight with status = 'ok' references evidence created only when the user
-- saves it (S12), so evidence_id stays null until then.
CREATE INDEX insights_run_recipe_idx ON insights (run_id, recipe);

CREATE TRIGGER runs_append_only
  BEFORE UPDATE OR DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER runs_no_truncate
  BEFORE TRUNCATE ON runs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER insights_append_only
  BEFORE UPDATE OR DELETE ON insights
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER insights_no_truncate
  BEFORE TRUNCATE ON insights
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

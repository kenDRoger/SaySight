-- One curated relationship between two cataloged releases. The keys are data,
-- never user-supplied SQL, and the relationship can be retired without editing
-- any already-published evidence.
CREATE TABLE dataset_relationships (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  primary_release_id TEXT NOT NULL REFERENCES dataset_releases(id),
  related_release_id TEXT NOT NULL REFERENCES dataset_releases(id),
  join_keys JSONB NOT NULL CHECK (
    jsonb_typeof(join_keys) = 'array' AND jsonb_array_length(join_keys) > 0
  ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (primary_release_id <> related_release_id)
);

-- Diagnostics and the joined result are evidence, not workflow state: they are
-- written once with a new analysis run and never updated.
CREATE TABLE joined_evidence (
  id UUID PRIMARY KEY,
  relationship_id UUID NOT NULL REFERENCES dataset_relationships(id),
  analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id),
  recipe_version TEXT NOT NULL,
  filters JSONB NOT NULL,
  diagnostics JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX joined_evidence_relationship_idx ON joined_evidence (relationship_id, created_at);

CREATE TRIGGER joined_evidence_append_only
  BEFORE UPDATE OR DELETE ON joined_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER joined_evidence_no_truncate
  BEFORE TRUNCATE ON joined_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

-- Explanations are derived text stored beside the evidence; each generation is a
-- new row so a reader can see which provider and template produced the wording.
CREATE TABLE explanations (
  id UUID PRIMARY KEY,
  finding_id UUID NOT NULL REFERENCES findings(id),
  text TEXT NOT NULL CHECK (length(btrim(text)) > 0),
  source TEXT NOT NULL CHECK (source IN ('llm', 'template')),
  provider TEXT,
  model TEXT,
  template_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX explanations_finding_idx ON explanations (finding_id, created_at DESC);

CREATE TRIGGER explanations_append_only
  BEFORE UPDATE OR DELETE ON explanations
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER explanations_no_truncate
  BEFORE TRUNCATE ON explanations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

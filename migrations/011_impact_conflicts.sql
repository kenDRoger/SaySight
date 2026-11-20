-- Review depth follows the breadth of the claim, and disagreements between
-- reviewers are stored instead of being settled silently.
ALTER TABLE findings ADD COLUMN impact TEXT NOT NULL DEFAULT 'standard' CHECK (impact IN ('low', 'standard', 'high'));

CREATE TABLE review_conflicts (
  id UUID PRIMARY KEY,
  finding_id UUID NOT NULL REFERENCES findings(id),
  statuses JSONB NOT NULL,
  positions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX review_conflicts_finding_idx ON review_conflicts (finding_id, created_at);

CREATE TRIGGER review_conflicts_append_only
  BEFORE UPDATE OR DELETE ON review_conflicts
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER review_conflicts_no_truncate
  BEFORE TRUNCATE ON review_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

-- Every status change is a new row; the history itself is immutable.
CREATE TABLE finding_transitions (
  id UUID PRIMARY KEY,
  finding_id UUID NOT NULL REFERENCES findings(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX finding_transitions_finding_idx ON finding_transitions (finding_id, created_at);

CREATE TRIGGER finding_transitions_append_only
  BEFORE UPDATE OR DELETE ON finding_transitions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER finding_transitions_no_truncate
  BEFORE TRUNCATE ON finding_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

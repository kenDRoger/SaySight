CREATE TRIGGER analysis_runs_no_truncate
  BEFORE TRUNCATE ON analysis_runs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER dataset_releases_no_truncate
  BEFORE TRUNCATE ON dataset_releases
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

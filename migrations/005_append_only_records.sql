CREATE FUNCTION prevent_immutable_record_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; create a new version instead', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER analysis_runs_append_only
  BEFORE UPDATE OR DELETE ON analysis_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER dataset_releases_append_only
  BEFORE UPDATE OR DELETE ON dataset_releases
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

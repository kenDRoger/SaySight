-- The analysis path reads metadata.schema, and migration 018 created the fixture without
-- one, so a two-release run refused a key that plainly exists in the data. dataset_releases
-- is append-only for application writes; this migration is the canonical writer, so it
-- disables that guard for the statement and re-enables it inside the same transaction.
ALTER TABLE dataset_releases DISABLE TRIGGER dataset_releases_append_only;

UPDATE dataset_releases
SET metadata = jsonb_set(metadata, '{schema}', '{
  "columns": [
    {"name": "fiscal_year", "type": "integer"},
    {"name": "population", "type": "number"}
  ]
}'::jsonb, true)
WHERE id = 'join-fixture-2026-11-07'
  AND metadata->'schema' IS NULL;

ALTER TABLE dataset_releases ENABLE TRIGGER dataset_releases_append_only;

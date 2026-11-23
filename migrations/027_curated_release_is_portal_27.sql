-- The curated BetterGov release IS portal dataset 27, but it was created through the
-- coverage importer, which did not record that. Without it the catalog listed the same
-- dataset twice: once as the curated release, once as the catalog-only entry the sync
-- created for a dataset it could not pin.
ALTER TABLE dataset_releases DISABLE TRIGGER dataset_releases_append_only;

UPDATE dataset_releases
SET connector_id = 'bettergov', source_dataset_id = '27'
WHERE id = 'bettergov-gaa-coverage-2026-11-07'
  AND source_dataset_id IS NULL;

-- That duplicate entry is a catalog-only row with no analysis rows behind it.
DELETE FROM dataset_releases WHERE id = 'catalog-bettergov-27';

SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE dataset_releases ENABLE TRIGGER dataset_releases_append_only;

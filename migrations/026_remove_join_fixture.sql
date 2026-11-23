-- Remove the synthetic join fixture: it was named after the delivery stage that needed it
-- ("MVP-D synthetic join fixture"), so it described our process rather than data, and a
-- reader cannot tell what it holds.
--
-- dataset_releases is append-only for application writes; a migration is the canonical
-- writer, so the guard is suspended for the statements below and restored inside this
-- transaction. `SET CONSTRAINTS ALL IMMEDIATE` is required first: the row table's foreign
-- key is deferred, so its pending trigger events would otherwise block the ALTER TABLE.
ALTER TABLE dataset_releases DISABLE TRIGGER dataset_releases_append_only;

-- The relationship is ordinary workflow data, not an immutable record.
DELETE FROM dataset_relationships
WHERE primary_release_id = 'join-fixture-2026-11-07'
   OR related_release_id = 'join-fixture-2026-11-07';

-- Derived rows are ordinary data and can be deleted directly.
DELETE FROM release_rows WHERE release_id = 'join-fixture-2026-11-07';
DELETE FROM coverage_records WHERE dataset_release_id = 'join-fixture-2026-11-07';
DELETE FROM dataset_releases WHERE id = 'join-fixture-2026-11-07';

SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE dataset_releases ENABLE TRIGGER dataset_releases_append_only;

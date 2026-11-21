-- A pinned release records where its bytes came from and what its licence state
-- was at pin time. S10a requires an unconfirmed licence to be visible on the
-- catalog entry and evidence page, not to block publication.
ALTER TABLE dataset_releases
  ADD COLUMN connector_id TEXT,
  ADD COLUMN source_dataset_id TEXT,
  ADD COLUMN attribution TEXT NOT NULL DEFAULT '',
  ADD COLUMN licence_status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (licence_status IN ('confirmed', 'unconfirmed', 'not-stated'));

CREATE INDEX dataset_releases_pinned_lookup_idx
  ON dataset_releases (connector_id, source_dataset_id, checksum)
  WHERE connector_id IS NOT NULL;

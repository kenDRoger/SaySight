-- Rows read back from the immutable bytes of a pinned release. They are derived
-- input, re-importable from those bytes, and therefore not append-only: a
-- re-import may replace them without creating a new release.
-- The reference is deferred so a pin can write rows before the release row is
-- visible; both land in one transaction, so no half-pinned release is readable.
CREATE TABLE release_rows (
  release_id TEXT NOT NULL REFERENCES dataset_releases(id) DEFERRABLE INITIALLY DEFERRED,
  row_number INTEGER NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (release_id, row_number)
);

CREATE INDEX release_rows_release_id_idx ON release_rows (release_id);

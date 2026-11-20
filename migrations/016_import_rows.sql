-- One normalized JSONB row per imported source row. Derived input is
-- re-importable, so unlike evidence it is not append-only.
CREATE TABLE import_rows (
  draft_id UUID NOT NULL REFERENCES import_drafts(id),
  row_number INTEGER NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (draft_id, row_number)
);

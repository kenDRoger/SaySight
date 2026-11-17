CREATE TABLE coverage_records (
  dataset_release_id TEXT NOT NULL REFERENCES dataset_releases(id),
  fiscal_year INTEGER NOT NULL,
  coverage_status TEXT NOT NULL,
  source_row_count INTEGER NOT NULL,
  amount_pesos NUMERIC,
  scopes JSONB,
  grains JSONB,
  notes JSONB NOT NULL,
  source_path TEXT,
  PRIMARY KEY (dataset_release_id, fiscal_year)
);

CREATE INDEX coverage_records_status_year_idx ON coverage_records (coverage_status, fiscal_year);

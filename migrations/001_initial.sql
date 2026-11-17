CREATE TABLE dataset_releases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  source_url TEXT NOT NULL,
  release_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  reuse_terms TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE analysis_runs (
  id UUID PRIMARY KEY,
  dataset_release_id TEXT NOT NULL REFERENCES dataset_releases(id),
  recipe TEXT NOT NULL,
  recipe_version TEXT NOT NULL,
  filters JSONB NOT NULL,
  result JSONB,
  validation JSONB NOT NULL,
  reproducibility_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

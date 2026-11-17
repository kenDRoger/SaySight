CREATE TABLE findings (
  id UUID PRIMARY KEY,
  analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id),
  status TEXT NOT NULL DEFAULT 'Unverified',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

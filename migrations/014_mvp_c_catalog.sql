-- MVP-C catalog and import records. Public evidence stays append-only; drafts,
-- validation reports, and workflow state remain mutable by design.
CREATE TABLE agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Source, dataset, and release are separate records so a source update can be
-- observed without silently changing an already-published release.
CREATE TABLE sources (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  url TEXT NOT NULL,
  license TEXT NOT NULL DEFAULT '',
  last_checked_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE datasets (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES sources(id),
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dataset_releases
  ADD COLUMN dataset_id UUID REFERENCES datasets(id),
  ADD COLUMN agency_id TEXT REFERENCES agencies(id),
  ADD COLUMN region TEXT NOT NULL DEFAULT '',
  ADD COLUMN last_checked_at TIMESTAMPTZ,
  ADD COLUMN source_published_at TIMESTAMPTZ,
  ADD COLUMN source_updated_at TIMESTAMPTZ,
  ADD COLUMN freshness_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (freshness_status IN ('unknown', 'current', 'possibly_stale', 'stale'));

CREATE TABLE import_drafts (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  format TEXT NOT NULL CHECK (format IN ('csv', 'json', 'xlsx', 'parquet')),
  status TEXT NOT NULL DEFAULT 'private-draft'
    CHECK (status IN ('private-draft', 'validated', 'quarantined', 'published')),
  submitted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE import_validations (
  id UUID PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES import_drafts(id),
  status TEXT NOT NULL CHECK (status IN ('Pass', 'Fail')),
  checks JSONB NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A quarantined file keeps a machine-readable reason for the maintainer.
CREATE TABLE quarantine_records (
  id UUID PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES import_drafts(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER quarantine_records_append_only
  BEFORE UPDATE OR DELETE ON quarantine_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER quarantine_records_no_truncate
  BEFORE TRUNCATE ON quarantine_records
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

-- Publication is a maintainer decision, not a side effect of validation.
CREATE TABLE publication_decisions (
  id UUID PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES import_drafts(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('publish', 'reject')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER publication_decisions_append_only
  BEFORE UPDATE OR DELETE ON publication_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER publication_decisions_no_truncate
  BEFORE TRUNCATE ON publication_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();

-- Saved views reproduce a filtered view without changing the underlying release.
CREATE TABLE saved_views (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  dataset_release_id TEXT NOT NULL REFERENCES dataset_releases(id),
  filters JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

#!/bin/sh
set -eu

export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${POSTGRES_USER:-saysayt}"
export PGPASSWORD="${POSTGRES_PASSWORD:-saysayt-dev-only}"
export PGDATABASE="${POSTGRES_DB:-saysayt}"

until pg_isready -q; do sleep 1; done
migration_table=$(psql -Atqc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")
if [ "$migration_table" != "t" ]; then
  existing_schema=$(psql -Atqc "SELECT
    to_regclass('public.dataset_releases') IS NOT NULL AND
    to_regclass('public.analysis_runs') IS NOT NULL AND
    to_regclass('public.findings') IS NOT NULL AND
    to_regclass('public.coverage_records') IS NOT NULL AND
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='analysis_runs' AND column_name IN ('input_rows','output_rows','release_checksum','calculation')) = 4 AND
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='analysis_runs_append_only') AND
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='dataset_releases_append_only')")
  psql -v ON_ERROR_STOP=1 -c 'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  if [ "$existing_schema" = "t" ]; then
    for migration in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations (version) VALUES ('$(basename "$migration")')"; done
  fi
fi

for migration in /migrations/*.sql; do
  [ -f "$migration" ] || continue
  version=$(basename "$migration")
  applied=$(psql -Atqc "SELECT 1 FROM schema_migrations WHERE version = '$version'")
  [ "$applied" = "1" ] && continue
  {
    printf 'BEGIN;\n'
    cat "$migration"
    printf "\nINSERT INTO schema_migrations (version) VALUES ('%s');\nCOMMIT;\n" "$version"
  } | psql -v ON_ERROR_STOP=1
 done

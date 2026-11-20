-- Synthetic test data, not a real government dataset: it exists only so the
-- curated join can be exercised end to end with an explicit shared key.
INSERT INTO dataset_releases (
  id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata,
  agency_id, region, freshness_status
) VALUES (
  'join-fixture-2026-11-07',
  'MVP-D synthetic join fixture (test data)',
  'SaySight test fixture',
  'https://example.org/mvp-d-join-fixture',
  'saysight/join-fixture@2026-11-07',
  'test-only-checksum',
  'CC0 1.0 Universal',
  'current',
  '{"coverage":{"fiscalYears":[2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026]},"fields":[{"name":"fiscal_year","type":"integer","description":"Shared join key"}],"limitations":["Synthetic fixture for MVP-D join verification; not a real government dataset."]}'::jsonb,
  'bettergov', 'Philippines', 'current'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO coverage_records (dataset_release_id, fiscal_year, coverage_status, source_row_count, scopes, notes)
SELECT 'join-fixture-2026-11-07', year, 'synthetic_related', 1, '{}'::jsonb, '[]'::jsonb
FROM generate_series(2000, 2026) AS year
ON CONFLICT (dataset_release_id, fiscal_year) DO NOTHING;

INSERT INTO dataset_relationships (id, name, primary_release_id, related_release_id, join_keys, status)
VALUES (
  '11111111-2222-3333-4444-555555555555',
  'mvp-d-gaa-to-synthetic-fixture',
  'bettergov-gaa-coverage-2026-11-07',
  'join-fixture-2026-11-07',
  '["fiscal_year"]'::jsonb,
  'validated'
) ON CONFLICT (id) DO NOTHING;

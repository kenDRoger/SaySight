import assert from 'node:assert/strict';
import test from 'node:test';
import { csvFilename, rowColumns, toCsv } from '../src/export.ts';
import type { Evidence } from '../src/store.ts';

const evidence: Evidence = {
  id: 'evidence-1',
  datasetReleaseId: 'bettergov-gaa-coverage-2026-11-07',
  recipe: 'rank',
  recipeVersion: 'v1',
  filters: { year: 2024 },
  result: [{ rank: 1, year: 2024, amount_pesos: null, status: 'partial_historical_coverage' }],
  inputRows: 4,
  outputRows: 1,
  releaseChecksum: 'abc123',
  calculation: 'rank the reported amounts',
  validation: { status: 'Pass', checks: [] },
  warnings: [],
  limitations: [],
  reproducibilityStatus: 'Passed',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('rowColumns returns the ordered columns of uniform rank and change_over_time rows', () => {
  assert.deepEqual(rowColumns(evidence.result), ['rank', 'year', 'amount_pesos', 'status']);
  assert.deepEqual(rowColumns([
    { year: 2023, amount_pesos: 1, status: 'full', change_from_previous_pesos: null, percent_change_from_previous: 2 },
    { year: 2024, amount_pesos: 2, status: 'full', change_from_previous_pesos: 1, percent_change_from_previous: 50 },
  ]), ['year', 'amount_pesos', 'status', 'change_from_previous_pesos', 'percent_change_from_previous']);
});

test('rowColumns returns the group columns of a distribution result', () => {
  assert.deepEqual(rowColumns({ field: 'status', groups: [
    { value: 'full', count: 2, percentage: 50 },
    { value: 'partial', count: 2, percentage: 50 },
  ] }), ['value', 'count', 'percentage']);
});

test('rowColumns rejects summary, compare, join diagnostics and non-uniform rows', () => {
  assert.equal(rowColumns({ year_count: 1, source_rows: 20, status_counts: { full: 1 } }), undefined);
  assert.equal(rowColumns({ year_a: 2023, year_b: 2024, difference_pesos: 1 }), undefined);
  assert.equal(rowColumns({ unmatched_rows: 1, duplicate_keys: [] }), undefined);
  assert.equal(rowColumns([{ rank: 1 }, { year: 2024 }]), undefined);
  assert.equal(rowColumns([]), undefined);
});

test('toCsv writes metadata in order, then a blank line, header and one row per record', () => {
  assert.equal(toCsv(evidence), [
    'release,bettergov-gaa-coverage-2026-11-07',
    'release_checksum,abc123',
    'recipe,rank',
    'recipe_version,v1',
    'filters,"{""year"":2024}"',
    'input_rows,4',
    'output_rows,1',
    'validation_status,Pass',
    'reproducibility,Passed',
    '',
    'rank,year,amount_pesos,status',
    '1,2024,,partial_historical_coverage',
    '',
  ].join('\n'));
});

test('toCsv quotes commas, quotes and newlines and leaves null as an empty cell', () => {
  const csv = toCsv({ ...evidence, result: [{ value: 'a,b', count: null, percentage: 'say "hi"\nnext' }] });
  assert.ok(csv.includes('"a,b",,"say ""hi""\nnext"'));
  assert.ok(!csv.includes('undefined'));
});

test('csvFilename lowercases and collapses non-alphanumerics into a csv filename', () => {
  assert.equal(csvFilename(evidence), 'evidence-rank-bettergov-gaa-coverage-2026-11-07.csv');
  assert.equal(csvFilename({ ...evidence, recipe: 'Change Over Time', datasetReleaseId: 'Release / 2026_v1' }),
    'evidence-change-over-time-release-2026-v1.csv');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from '../src/filters.ts';

// filters.ts shares its vocabulary with review.ts and impact.ts through the usual
// ESM `.js` specifiers, which the plain node test runner does not map back to
// `.ts`; tsx is already a dev dependency, so it loads this module graph.
const { tsImport } = await import('tsx/esm/api');
const { filterDatasets, filterQueue, isInvalidFilter, matchCatalogQuery, parseFreshness } = await tsImport<typeof import('../src/filters.ts')>('../src/filters.ts', import.meta.url);

const release = (overrides: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name: 'Philippine General Appropriations Act coverage',
  publisher: 'BetterGovPH',
  releaseId: 'bettergovph/gaa-2000-2026@2026-11-07',
  agencyId: 'bettergov',
  freshnessStatus: 'current',
  ...overrides,
});

const findings = [
  { status: 'Pending verification', impact: 'high', claim: 'FY2024 appropriations match the release' },
  { status: 'In review', impact: 'low', claim: 'A single year differs from the source' },
  { status: 'In review', impact: 'standard', claim: null },
];

test('an empty catalog query matches every release', () => {
  assert.equal(matchCatalogQuery(release(), ''), true);
  assert.equal(matchCatalogQuery(release(), '   '), true);
});

test('the catalog query matches name, publisher, release id, and agency case-insensitively', () => {
  assert.equal(matchCatalogQuery(release(), 'APPROPRIATIONS'), true);
  assert.equal(matchCatalogQuery(release(), 'bettergovph'), true);
  assert.equal(matchCatalogQuery(release(), 'GAA-2000-2026'), true);
  assert.equal(matchCatalogQuery(release(), 'BetterGov'), true);
  assert.equal(matchCatalogQuery(release(), 'health'), false);
  // A release without an agency simply has nothing to match there.
  assert.equal(matchCatalogQuery(release({ agencyId: null, name: 'X', publisher: 'Y', releaseId: 'Z' }), 'bettergov'), false);
});

test('freshness accepts the documented vocabulary and nothing else', () => {
  assert.equal(parseFreshness('current'), 'current');
  assert.equal(parseFreshness('possibly_stale'), 'possibly_stale');
  assert.equal(parseFreshness('stale'), 'stale');
  assert.equal(parseFreshness(''), undefined);
  assert.equal(parseFreshness(undefined), undefined);
  for (const value of ['import_failed', 'reuse_terms_unclear', 'unknown', 'fresh', 42]) {
    const parsed = parseFreshness(value);
    assert.ok(isInvalidFilter(parsed), `expected invalid for ${String(value)}`);
    assert.equal(parsed.parameter, 'freshness');
  }
});

test('catalog filters combine query, agency, and freshness', () => {
  const datasets = [release(), release({ name: 'Department of Health budget', publisher: 'DOH', releaseId: 'doh/health@2025-01-01', agencyId: 'doh', freshnessStatus: 'stale' })];
  assert.deepEqual(filterDatasets(datasets, {}), datasets);
  assert.deepEqual(filterDatasets(datasets, { q: '' }), datasets);
  assert.deepEqual(filterDatasets(datasets, { q: 'appropriations' }).map((item) => item.releaseId), ['bettergovph/gaa-2000-2026@2026-11-07']);
  assert.deepEqual(filterDatasets(datasets, { agency: 'doh' }).map((item) => item.agencyId), ['doh']);
  assert.deepEqual(filterDatasets(datasets, { freshness: 'current' }).map((item) => item.agencyId), ['bettergov']);
  assert.deepEqual(filterDatasets(datasets, { q: 'other', agency: 'bettergov' }), []);});

test('an unknown agency matches nothing rather than everything', () => {
  assert.deepEqual(filterDatasets([release()], { agency: 'no-such-agency' }), []);
});

test('an invalid freshness filter is reported instead of dropped', () => {
  const result = filterDatasets([release()], { freshness: 'bogus' });
  assert.ok(isInvalidFilter(result));
  assert.deepEqual(result, { error: 'invalid_filter', parameter: 'freshness' });
});

test('queue filters combine claim search, status, and impact', () => {
  assert.deepEqual(filterQueue(findings, {}), findings);
  assert.deepEqual(filterQueue(findings, { q: '' }), findings);
  assert.deepEqual(filterQueue(findings, { q: 'FY2024' }).map((item) => item.impact), ['high']);
  assert.deepEqual(filterQueue(findings, { q: 'single year' }).map((item) => item.impact), ['low']);
  assert.deepEqual(filterQueue(findings, { status: 'In review' }).map((item) => item.claim), ['A single year differs from the source', null]);
  assert.deepEqual(filterQueue(findings, { impact: 'standard' }).map((item) => item.claim), [null]);
  assert.deepEqual(filterQueue(findings, { status: 'In review', impact: 'low' }).map((item) => item.claim), ['A single year differs from the source']);
});

test('an invalid queue status or impact is reported rather than silently ignored', () => {
  const badStatus = filterQueue(findings, { status: 'Reviewed' });
  assert.ok(isInvalidFilter(badStatus));
  assert.deepEqual(badStatus, { error: 'invalid_filter', parameter: 'status' });
  const badImpact = filterQueue(findings, { impact: 'critical' });
  assert.ok(isInvalidFilter(badImpact));
  assert.deepEqual(badImpact, { error: 'invalid_filter', parameter: 'impact' });
  // Both wrong: the first offending parameter is the one reported.
  assert.deepEqual(filterQueue(findings, { status: 'Reviewed', impact: 'critical' }), { error: 'invalid_filter', parameter: 'status' });
});

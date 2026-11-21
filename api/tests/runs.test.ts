import test from 'node:test';
import assert from 'node:assert/strict';
import { insightRecord, planRun, runSummaryFor } from '../src/runs.ts';
import type { Selection } from '../src/insights.ts';

const selection = (overrides: Partial<Selection> = {}): Selection => ({
  applicable: ['summary', 'rank', 'change_over_time'],
  skipped: [
    { recipe: 'distribution', reason: 'no categorical column' },
    { recipe: 'compare', reason: 'the year column is text, not an integer or date year column' },
  ],
  ...overrides,
});

test('planRun keeps the selection order and passes skip reasons through unchanged', () => {
  const skipped = [
    { recipe: 'distribution', reason: 'no categorical column' },
    { recipe: 'change_over_time', reason: 'change over time skipped: no ordered year column' },
  ];
  const plan = planRun({
    releaseIds: ['release-a', 'release-b'],
    connectorIds: ['bettergov', 'hdx'],
    filters: { year: 2024 },
    selection: selection({ applicable: ['rank', 'summary'], skipped }),
  });

  assert.deepEqual(plan, {
    toRun: ['rank', 'summary'],
    skipped,
  });
  assert.equal(plan.skipped[0], skipped[0], 'skip entries are passed through, not rebuilt');
  assert.equal(plan.skipped[1].reason, 'change over time skipped: no ordered year column');
});

test('planRun reports an empty selection as an empty plan', () => {
  const plan = planRun({
    releaseIds: [], connectorIds: [], filters: {},
    selection: { applicable: [], skipped: [] },
  });
  assert.deepEqual(plan, { toRun: [], skipped: [] });
});

test('insightRecord rejects ok without evidence and failed without a reason', () => {
  const base = {
    runId: 'run-1', recipe: 'summary', releaseId: 'release-1', recipeVersion: 'v1',
  };
  for (const bad of [{}, { evidenceId: '' }, { evidenceId: '   ' }]) {
    assert.throws(() => insightRecord({ ...base, status: 'ok', ...bad }), { message: 'insight_ok_requires_evidence' });
  }
  for (const bad of [{}, { reason: '' }, { reason: '  ' }]) {
    assert.throws(() => insightRecord({ ...base, status: 'failed', ...bad }), { message: 'insight_failed_requires_reason' });
  }
});

test('insightRecord builds the row shape for saved and failed insights', () => {
  const base = {
    runId: 'run-1', recipe: 'rank', releaseId: 'release-1', recipeVersion: 'v1',
  };
  assert.deepEqual(insightRecord({ ...base, status: 'ok', evidenceId: 'evidence-1' }), {
    runId: 'run-1', recipe: 'rank', releaseId: 'release-1', recipeVersion: 'v1',
    status: 'ok', evidenceId: 'evidence-1', reason: '',
  });
  assert.deepEqual(insightRecord({
    ...base, status: 'failed', reason: 'no ordered year column',
  }), {
    runId: 'run-1', recipe: 'rank', releaseId: 'release-1', recipeVersion: 'v1',
    status: 'failed', evidenceId: null, reason: 'no ordered year column',
  });
});

test('runSummaryFor counts one insight and pluralises it correctly', () => {
  const summary = runSummaryFor([{ status: 'ok' }]);
  assert.deepEqual(
    { total: summary.total, ok: summary.ok, failed: summary.failed, skipped: summary.skipped },
    { total: 1, ok: 1, failed: 0, skipped: 0 },
  );
  assert.equal(summary.sentence, '1 insight was produced.');

  assert.equal(runSummaryFor([{ status: 'failed' }]).sentence, '0 insights were produced and 1 failed.');
  assert.equal(runSummaryFor([{ status: 'skipped' }]).sentence, '0 insights were produced and 1 was skipped.');
});

test('runSummaryFor counts and pluralises many insights in the example sentence', () => {
  const summary = runSummaryFor([
    { status: 'ok' }, { status: 'ok' },
    { status: 'failed' },
    { status: 'skipped' }, { status: 'skipped' }, { status: 'skipped' },
  ]);
  assert.deepEqual(
    { total: summary.total, ok: summary.ok, failed: summary.failed, skipped: summary.skipped },
    { total: 6, ok: 2, failed: 1, skipped: 3 },
  );
  assert.equal(summary.sentence, '2 insights were produced, 1 failed, and 3 were skipped.');

  assert.equal(
    runSummaryFor([{ status: 'ok' }, { status: 'failed' }, { status: 'skipped' }]).sentence,
    '1 insight was produced, 1 failed, and 1 was skipped.',
  );
  assert.equal(
    runSummaryFor([{ status: 'ok' }, { status: 'ok' }, { status: 'failed' }, { status: 'failed' }]).sentence,
    '2 insights were produced and 2 failed.',
  );
});

test('runSummaryFor of no records has a zero sentence', () => {
  const summary = runSummaryFor([]);
  assert.deepEqual(
    { total: summary.total, ok: summary.ok, failed: summary.failed, skipped: summary.skipped },
    { total: 0, ok: 0, failed: 0, skipped: 0 },
  );
  assert.equal(summary.sentence, '0 insights were produced.');
});

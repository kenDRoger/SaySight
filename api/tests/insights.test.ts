import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoricalColumns,
  describeSelection,
  numericColumns,
  orderedYearColumn,
  runSummary,
  selectInsights,
  zeroResultMessage,
  type Column,
  type Selection,
} from '../src/insights.ts';

const column = (name: string, type: Column['type']): Column => ({ name, type });
const reasonFor = (selection: Selection, recipe: string): string =>
  selection.skipped.find((item) => item.recipe === recipe)?.reason ?? '';
const allRecipes = ['summary', 'rank', 'distribution', 'change_over_time', 'compare'];

test('numeric-only columns keep summary and rank and skip the other recipes by name', () => {
  const columns = [column('amount', 'number'), column('count', 'integer')];
  const selection = selectInsights(columns);

  assert.deepEqual(selection.applicable, ['summary', 'rank']);
  assert.deepEqual(selection.skipped.map((item) => item.recipe), ['distribution', 'change_over_time', 'compare']);
  assert.match(reasonFor(selection, 'distribution'), /categorical/);
  assert.equal(reasonFor(selection, 'change_over_time'), 'no ordered year column');
  assert.equal(reasonFor(selection, 'compare'), 'no ordered year column');
  assert.deepEqual(numericColumns(columns), columns);
  assert.deepEqual(categoricalColumns(columns), []);
  assert.equal(orderedYearColumn(columns), undefined);
});

test('a categorical-only table still gets a status summary and a distribution', () => {
  const columns = [column('status', 'text'), column('current', 'boolean')];
  const selection = selectInsights(columns);

  assert.deepEqual(selection.applicable, ['summary', 'distribution']);
  assert.deepEqual(selection.skipped.map((item) => item.recipe), ['rank', 'change_over_time', 'compare']);
  assert.equal(reasonFor(selection, 'rank'), 'no numeric column to rank');
  assert.match(reasonFor(selection, 'change_over_time'), /no numeric column/);
  assert.match(reasonFor(selection, 'change_over_time'), /no ordered year column/);
  assert.match(reasonFor(selection, 'compare'), /no numeric column/);
  assert.deepEqual(numericColumns(columns), []);
  assert.deepEqual(categoricalColumns(columns), columns);
});

test('numeric, categorical and year columns make all five recipes apply', () => {
  const columns = [column('year', 'integer'), column('amount', 'number'), column('status', 'text')];
  const selection = selectInsights(columns);

  assert.deepEqual(selection.applicable, allRecipes);
  assert.deepEqual(selection.skipped, []);
  assert.deepEqual(orderedYearColumn(columns), columns[0]);
  assert.match(describeSelection(selection), /5 of 5 recipes apply/);

  const dated = selectInsights([column('fiscal_year', 'date'), column('amount', 'number')]);
  assert.deepEqual(dated.applicable, ['summary', 'rank', 'change_over_time', 'compare']);
  assert.deepEqual(dated.skipped.map((item) => item.recipe), ['distribution']);
});

test('a text year column is not an ordered year, and the skip reason says why', () => {
  const columns = [column('year', 'text'), column('amount', 'number')];
  const selection = selectInsights(columns);

  assert.deepEqual(selection.applicable, ['summary', 'rank', 'distribution']);
  for (const recipe of ['change_over_time', 'compare']) {
    const reason = reasonFor(selection, recipe);
    assert.match(reason, /year/);
    assert.match(reason, /text/);
    assert.match(reason, /integer or date/);
  }
  assert.equal(orderedYearColumn(columns), undefined);

  const fiscal = selectInsights([column('fiscal_year', 'text'), column('amount', 'number')]);
  assert.match(reasonFor(fiscal, 'change_over_time'), /fiscal_year column is text/);
});

test('no columns means every recipe is skipped in readable lowercase sentences', () => {
  const selection = selectInsights([]);

  assert.deepEqual(selection.applicable, []);
  assert.deepEqual(selection.skipped.map((item) => item.recipe), allRecipes);
  assert.equal(reasonFor(selection, 'rank'), 'no numeric column to rank');
  assert.match(reasonFor(selection, 'summary'), /numeric/);
  assert.match(reasonFor(selection, 'summary'), /categorical/);
  for (const { recipe, reason } of selection.skipped) {
    assert.ok(reason.length > 0, `${recipe} has a reason`);
    assert.equal(reason, reason.toLowerCase());
    assert.doesNotMatch(reason, /_|column\(|InsightRecipe/);
  }
  assert.match(describeSelection(selection), /0 of 5 recipes apply/);
  assert.match(describeSelection(selection), /rank skipped: no numeric column to rank/);
});

test('describeSelection names the skipped recipe and its reason', () => {
  const selection = selectInsights([column('amount', 'number'), column('status', 'text')]);
  assert.deepEqual(selection.skipped.map((item) => item.recipe), ['change_over_time', 'compare']);
  assert.equal(
    describeSelection(selection),
    '3 of 5 recipes apply; change over time skipped: no ordered year column; compare skipped: no ordered year column',
  );
});

test('a zero-result message names the dataset, filters, and a concrete next step', () => {
  const message = zeroResultMessage({ datasetName: 'City Grants', filters: { status: 'open', year: 2024 }, matchedRows: 0 });
  assert.match(message ?? '', /City Grants/);
  assert.match(message ?? '', /status=open/);
  assert.match(message ?? '', /year=2024/);
  assert.match(message ?? '', /clear the status filter/);
  assert.match(zeroResultMessage({ datasetName: 'City Grants', filters: {}, matchedRows: 0 }) ?? '', /no filters applied/);
});

test('a filter with matching rows has no zero-result message', () => {
  assert.equal(zeroResultMessage({ datasetName: 'City Grants', filters: { status: 'open' }, matchedRows: 3 }), undefined);
  assert.equal(zeroResultMessage({ datasetName: 'City Grants', filters: {}, matchedRows: 1 }), undefined);
});

test('runSummary counts successful insights when none failed', () => {
  const summary = runSummary([{ id: 'summary', status: 'ok' }, { id: 'rank', status: 'ok' }]);
  assert.deepEqual({ total: summary.total, ok: summary.ok, failed: summary.failed }, { total: 2, ok: 2, failed: 0 });
  assert.match(summary.sentence, /2 insights were produced/);
  assert.doesNotMatch(summary.sentence, /failed/);
});

test('runSummary counts partial failures and says they are listed with their reason', () => {
  const summary = runSummary([
    { id: 'summary', status: 'ok' },
    { id: 'rank', status: 'ok' },
    { id: 'change_over_time', status: 'ok' },
    { id: 'compare', status: 'failed' },
  ]);
  assert.deepEqual({ total: summary.total, ok: summary.ok, failed: summary.failed }, { total: 4, ok: 3, failed: 1 });
  assert.match(summary.sentence, /3 insights were produced/);
  assert.match(summary.sentence, /1 insight failed and is listed with its reason/);
});

test('selection does not treat the year column as a measure', () => {
  const selection = selectInsights([{ name: 'year', type: 'integer' }]);
  assert.deepEqual(selection.applicable, []);
  assert.match(selection.skipped.find((entry) => entry.recipe === 'rank')?.reason ?? '', /no numeric column to rank/);
});

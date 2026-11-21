import test from 'node:test';
import assert from 'node:assert/strict';
import { selectInsights } from '../src/insights.ts';
import {
  changeOverTime,
  compare,
  distribution,
  rank,
  runAllApplicable,
  runRecipe,
  summarise,
  type Column,
  type RecipeId,
  type Row,
} from '../src/recipes.ts';

const column = (name: string, type: Column['type']): Column => ({ name, type });

const summaryRows: Row[] = [
  { year: 2021, amount: 10, score: null, status: 'verified' },
  { year: 2021, amount: 20, score: null, status: 'verified' },
  { year: 2022, amount: 30, score: '', status: 'draft' },
  { year: 2022, amount: 40, score: null, status: 'draft' },
  { year: 2023, amount: null, score: null, status: 'verified' },
  { year: 2023, amount: '', score: null, status: 'draft' },
  { year: 2024, amount: '50', score: null, status: 'published' },
  { year: 2024, amount: 80, score: null, status: 'published' },
];

test('summary reports row count, numeric min/max/mean and an empty numeric column', () => {
  const columns = [
    column('year', 'integer'),
    column('amount', 'number'),
    column('score', 'integer'),
    column('status', 'text'),
  ];
  const result = summarise(summaryRows, columns);

  assert.equal(result.recipe, 'summary');
  assert.equal(result.recipeVersion, 'generic-v1');
  assert.equal(result.outputRows, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.result, {
    rows: 8,
    numeric: [
      { column: 'year', min: 2021, max: 2024, mean: 2022.5, available: 8 },
      { column: 'amount', min: 10, max: 80, mean: 38.33, available: 6 },
      { column: 'score', min: null, max: null, mean: null, available: 0 },
    ],
    categorical: [{ column: 'status', distinct: 3 }],
  });
  assert.match(result.calculation, /^Counted 8 rows/);
  assert.match(result.calculation, /min, max and mean over year, amount, score/);
  assert.match(result.calculation, /distinct non-missing values over status/);
});

const rankRows: Row[] = [
  { name: 'Alpha', value: 50 },
  { name: 'Beta', value: 100 },
  { name: 'Gamma', value: 100 },
  { name: 'Delta', value: 75 },
  { name: null, value: 90 },
  { name: 'Epsilon', value: 25 },
];
const rankColumns = [column('name', 'text'), column('value', 'number')];

test('rank orders descending, truncates to top-N, ties share the value with sequential ranks, missing label falls back to the row number', () => {
  const result = rank(rankRows, rankColumns, { top: 4 });

  assert.equal(result.recipe, 'rank');
  assert.equal(result.recipeVersion, 'generic-v1');
  assert.equal(result.outputRows, 4);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.result, [
    { rank: 1, label: 'Beta', value: 100 },
    { rank: 2, label: 'Gamma', value: 100 },
    { rank: 3, label: '5', value: 90 },
    { rank: 4, label: 'Delta', value: 75 },
  ]);
  assert.match(result.calculation, /measure value/);
  assert.match(result.calculation, /keeping the top 4/);
  assert.match(result.calculation, /sequential ranks/);
});

const distributionRows: Row[] = [
  { status: 'verified', amount: 10 },
  { status: 'verified', amount: 20 },
  { status: 'verified', amount: 30 },
  { status: 'draft', amount: 40 },
  { status: 'draft', amount: 50 },
  { status: 'published', amount: 60 },
  { status: 'published', amount: 70 },
  { status: '', amount: 80 },
  { status: null, amount: 90 },
];

test('distribution groups missing values as (missing) and percentages total ~100', () => {
  const result = distribution(distributionRows, [column('status', 'text'), column('amount', 'number')]);

  assert.equal(result.recipe, 'distribution');
  assert.equal(result.outputRows, 4);
  assert.match(result.calculation, /by status/);
  assert.match(result.calculation, /\(missing\)/);
  const payload = result.result as { field: string; groups: Array<{ value: string; count: number; percentage: number }> };
  assert.equal(payload.field, 'status');
  assert.equal(payload.groups[0]?.value, 'verified');
  assert.deepEqual(payload.groups.find((group) => group.value === '(missing)'), {
    value: '(missing)',
    count: 2,
    percentage: 22.22,
  });
  assert.equal(payload.groups.reduce((sum, group) => sum + group.count, 0), 9);
  const total = payload.groups.reduce((sum, group) => sum + group.percentage, 0);
  assert.ok(Math.abs(total - 100) <= 0.05, `percentages summed to ${total}`);
});

const trendRows: Row[] = [
  { year: 2020, amount: 100 },
  { year: 2021, amount: 150 },
  { year: 2022, amount: null },
  { year: 2023, amount: 175 },
  { year: null, amount: 200 },
  { year: 2024, amount: 'abc' },
  { year: 2025, amount: 200 },
];

test('change over time yields null changes for missing values, keeps a missing year as a null period and warns about non-numeric measures', () => {
  const result = changeOverTime(trendRows, [column('year', 'integer'), column('amount', 'number')]);

  assert.equal(result.recipe, 'change_over_time');
  assert.equal(result.outputRows, 6);
  assert.match(result.calculation, /year/);
  assert.match(result.calculation, /amount/);
  assert.match(result.calculation, /never 0/);
  const points = result.result as Array<{
    period: string | number | null;
    value: number | null;
    changeFromPrevious: number | null;
    percentChangeFromPrevious: number | null;
  }>;
  assert.equal(points.length, 6);
  assert.deepEqual(points.map((point) => point.period), [2020, 2021, 2022, 2023, 2025, null]);
  assert.equal(points[0]?.changeFromPrevious, null);
  assert.deepEqual(points[1], { period: 2021, value: 150, changeFromPrevious: 50, percentChangeFromPrevious: 50 });
  assert.deepEqual(points[2], { period: 2022, value: null, changeFromPrevious: null, percentChangeFromPrevious: null });
  assert.equal(points[3]?.changeFromPrevious, null);
  assert.equal(points[4]?.changeFromPrevious, 25);
  assert.equal(points[4]?.percentChangeFromPrevious, 14.29);
  assert.equal(points[5]?.period, null);
  assert.equal(points[5]?.changeFromPrevious, null);
  assert.deepEqual(result.warnings, ['change_over_time: skipped 1 row with non-numeric amount']);
});

const compareRows: Row[] = [
  { year: 2019, amount: 350 },
  { year: 2020, amount: 300 },
  { year: 2021, amount: 400 },
  { year: 2022, amount: 380 },
  { year: 2023, amount: 420 },
  { year: 2024, amount: 460 },
];
const compareColumns = [column('year', 'integer'), column('amount', 'number')];

test('compare reports null values and names the period when one side is absent', () => {
  const result = compare(compareRows, compareColumns, { periodA: 2018, periodB: 2020 });

  assert.equal(result.recipe, 'compare');
  assert.equal(result.outputRows, 1);
  assert.deepEqual(result.result, {
    periodA: 2018,
    periodB: 2020,
    valueA: null,
    valueB: 300,
    difference: null,
    percentChange: null,
  });
  assert.deepEqual(result.warnings, ['compare: no rows for period 2018']);
  assert.match(result.calculation, /periodA/);
});

test('compare computes difference and percent change from the real period values', () => {
  const result = compare(compareRows, compareColumns, { periodA: 2019, periodB: 2021 });

  assert.equal(result.recipe, 'compare');
  assert.deepEqual(result.result, {
    periodA: 2019,
    periodB: 2021,
    valueA: 350,
    valueB: 400,
    difference: 50,
    percentChange: 14.29,
  });
  assert.deepEqual(result.warnings, []);
  assert.match(result.calculation, /percent change = difference \/ \|periodA\| \* 100/);
});

test('runAllApplicable runs only applicable recipes and keeps the skip entries in selection order', () => {
  const columns = [column('amount', 'number'), column('status', 'text')];
  const selection = selectInsights(columns);

  const run = runAllApplicable(selection, summaryRows, columns);

  assert.deepEqual(run.results.map((entry) => entry.recipe), ['summary', 'rank', 'distribution']);
  assert.deepEqual(run.skipped, selection.skipped);
  assert.deepEqual(run.skipped.map((entry) => entry.recipe), ['change_over_time', 'compare']);
  for (const entry of run.results) assert.equal(entry.recipeVersion, 'generic-v1');
});

test('runAllApplicable records an applicable recipe missing its required options as a skip entry', () => {
  const columns = [column('year', 'integer'), column('amount', 'number'), column('status', 'text')];
  const selection = selectInsights(columns);
  assert.deepEqual(selection.applicable, ['summary', 'rank', 'distribution', 'change_over_time', 'compare']);

  const run = runAllApplicable(selection, summaryRows, columns);

  assert.deepEqual(run.results.map((entry) => entry.recipe), ['summary', 'rank', 'distribution', 'change_over_time']);
  assert.deepEqual(run.skipped, [
    { recipe: 'compare', reason: 'compare needs two periods; pass periodA and periodB' },
  ]);
});

test('runRecipe dispatches by id and rejects an unknown recipe', () => {
  const result = runRecipe('rank', rankRows, rankColumns, { top: 2 });
  assert.equal(result.recipe, 'rank');
  assert.equal(result.outputRows, 2);
  // Deliberately invalid id to pin the dispatch guard.
  assert.throws(() => runRecipe('nope' as unknown as RecipeId, rankRows, rankColumns), /unknown recipe: nope/);
});

test('rank never measures the year column when a real measure exists', () => {
  const rows = [
    { year: 2022, agency: 'A', amount: 100 },
    { year: 2023, agency: 'B', amount: 150 },
    { year: 2024, agency: 'C', amount: 200 },
  ];
  const result = rank(rows, [column('year', 'integer'), column('agency', 'text'), column('amount', 'number')]);
  assert.deepEqual(result.result, [
    { rank: 1, label: 'C', value: 200 },
    { rank: 2, label: 'B', value: 150 },
    { rank: 3, label: 'A', value: 100 },
  ]);
  assert.match(result.calculation, /amount/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCardinality, checkGrain, checkKeys, diagnoseJoin, measureCardinality, planJoin,
  type Aggregation, type Column, type JoinPlan, type JoinRequest, type Side,
} from '../src/joinPlan.ts';

const col = (name: string, type: Column['type'] = 'text'): Column => ({ name, type });

const baseRequest = (): JoinRequest => ({
  left: {
    label: 'barangays', grain: 'year',
    columns: [col('year', 'integer'), col('amount_pesos', 'number')],
    rows: [{ year: 2024, amount_pesos: 100 }, { year: 2024, amount_pesos: 200 }],
  },
  right: {
    label: 'regions', grain: 'year',
    columns: [col('year', 'number'), col('region')],
    rows: [{ year: 2024, region: 'NCR' }, { year: 2023, region: 'NCR' }],
  },
  leftKey: 'year',
  rightKey: 'year',
});

const aggregated = (column: string, fn: Aggregation['fn'], targetGrain: string): Aggregation =>
  ({ column, fn, targetGrain });

const mismatchedGrains = (request: JoinRequest): JoinRequest => ({
  ...request,
  left: { ...request.left, grain: 'barangay' },
});

test('checkKeys accepts compatible integer and number keys, and planJoin builds a deterministic plan', () => {
  const request = baseRequest();
  assert.deepEqual(checkKeys(request), { ok: true });
  assert.deepEqual(planJoin(request), {
    ok: true,
    plan: { leftKey: 'year', rightKey: 'year', rightUniqueKeys: ['2023', '2024'] },
  });
});

test('checkKeys names the side and column for a missing left or right key', () => {
  const left = baseRequest();
  left.left = { ...left.left, columns: left.left.columns.filter((column) => column.name !== 'year') };
  assert.deepEqual(checkKeys(left), {
    ok: false, error: 'missing_column', message: "Missing left column 'year' on side 'barangays'.",
  });

  const right = baseRequest();
  right.right = { ...right.right, columns: right.right.columns.filter((column) => column.name !== 'year') };
  assert.deepEqual(checkKeys(right), {
    ok: false, error: 'missing_column', message: "Missing right column 'year' on side 'regions'.",
  });
});

test('checkKeys names both types for incompatible keys', () => {
  const request = baseRequest();
  request.right = { ...request.right, columns: [col('year', 'text'), col('region')] };
  assert.deepEqual(checkKeys(request), {
    ok: false, error: 'incompatible_key_types', message: "Incompatible key types: left 'integer' and right 'text'.",
  });
});

test('measureCardinality counts keys appearing more than once, not extra rows', () => {
  const rows = [{ k: 'a' }, { k: 'a' }, { k: 'a' }, { k: 'b' }, { k: null }, {}];
  assert.deepEqual(measureCardinality(rows, 'k'), { unique: 2, duplicates: 1 });
  assert.deepEqual(measureCardinality([{ k: 1 }, { k: 2 }], 'k'), { unique: 2, duplicates: 0 });
});

test('checkCardinality accepts one-to-one and many-to-one joins', () => {
  const oneToOne = baseRequest();
  oneToOne.left = { ...oneToOne.left, rows: [{ year: 2024, amount_pesos: 100 }] };
  assert.deepEqual(checkCardinality(oneToOne), { ok: true, cardinality: 'one-to-one' });

  assert.deepEqual(checkCardinality(baseRequest()), { ok: true, cardinality: 'many-to-one' });
});

test('checkCardinality refuses many-to-many with both duplicate key counts', () => {
  const request = baseRequest();
  request.left = { ...request.left, rows: [{ year: 2024 }, { year: 2024 }, { year: 2023 }, { year: 2023 }] };
  request.right = { ...request.right, rows: [{ year: 2024 }, { year: 2024 }, { year: 2023 }] };
  assert.deepEqual(checkCardinality(request), {
    ok: false, error: 'many_to_many_join',
    message: 'Many-to-many join: left duplicate keys = 2, right duplicate keys = 1.',
  });
});

test('checkCardinality refuses one-to-many because the right side must be unique', () => {
  const request = baseRequest();
  request.left = { ...request.left, rows: [{ year: 2024 }] };
  request.right = { ...request.right, rows: [{ year: 2024 }, { year: 2024 }] };
  assert.deepEqual(checkCardinality(request), {
    ok: false, error: 'one_to_many_join',
    message: 'One-to-many join: right duplicate keys = 1 (MVP-E executes only joins with unique right keys).',
  });
});

test('checkGrain refuses differing grains without an aggregation and names the target-grain fix', () => {
  const request = mismatchedGrains(baseRequest());
  assert.deepEqual(checkGrain(request), {
    ok: false, error: 'grain_mismatch',
    message: "Grain mismatch: left grain 'barangay' and right grain 'year'. Aggregate one side first to a target grain matching the other side, for example 'year'.",
  });
  assert.deepEqual(planJoin(request), {
    ok: false, error: 'grain_mismatch',
    message: "Grain mismatch: left grain 'barangay' and right grain 'year'. Aggregate one side first to a target grain matching the other side, for example 'year'.",
  });
});

test('checkGrain accepts aggregation to the other side grain and planJoin records it', () => {
  const aggregation = aggregated('amount_pesos', 'sum', 'year');
  const request = { ...mismatchedGrains(baseRequest()), aggregation };
  assert.deepEqual(checkGrain(request), { ok: true });
  assert.deepEqual(planJoin(request), {
    ok: true,
    plan: { leftKey: 'year', rightKey: 'year', rightUniqueKeys: ['2023', '2024'], aggregation },
  });
});

test('checkGrain refuses an aggregation whose target grain is not the other side grain', () => {
  const request = { ...mismatchedGrains(baseRequest()), aggregation: aggregated('amount_pesos', 'sum', 'province') };
  assert.deepEqual(checkGrain(request), {
    ok: false, error: 'aggregation_grain_mismatch',
    message: "Aggregation target grain 'province' does not match the right grain 'year'.",
  });
});

test('checkGrain refuses an aggregation on a column that does not exist', () => {
  const request = { ...mismatchedGrains(baseRequest()), aggregation: aggregated('missing_amount', 'sum', 'year') };
  assert.deepEqual(checkGrain(request), {
    ok: false, error: 'missing_aggregation_column',
    message: "Aggregation column 'missing_amount' is missing from the left side.",
  });
});

test('checkGrain refuses sum on a percentage and mean on avg_cost', () => {
  const withPercentage: JoinRequest = {
    ...mismatchedGrains(baseRequest()),
    left: {
      ...baseRequest().left,
      columns: [...baseRequest().left.columns, col('percentage', 'number')],
    },
    aggregation: aggregated('percentage', 'sum', 'year'),
  };
  assert.deepEqual(checkGrain(withPercentage), {
    ok: false, error: 'unsafe_aggregation',
    message: "Unsafe aggregation 'sum' on 'percentage': rates, percentages and averages cannot be summed or averaged.",
  });

  const withAverage: JoinRequest = {
    ...mismatchedGrains(baseRequest()),
    left: {
      ...baseRequest().left,
      columns: [...baseRequest().left.columns, col('avg_cost', 'number')],
    },
    aggregation: aggregated('avg_cost', 'mean', 'year'),
  };
  assert.deepEqual(checkGrain(withAverage), {
    ok: false, error: 'unsafe_aggregation',
    message: "Unsafe aggregation 'mean' on 'avg_cost': rates, percentages and averages cannot be summed or averaged.",
  });
});

test('planJoin stops at the first failure in key, cardinality, grain order', () => {
  const keyFirst = baseRequest();
  keyFirst.left = { ...keyFirst.left, columns: [col('amount_pesos', 'number')] };
  keyFirst.left.grain = 'barangay';
  assert.equal(planJoin(keyFirst).ok, false);
  assert.equal(planJoin(keyFirst).ok === false && planJoin(keyFirst).error, 'missing_column');

  const cardinalityFirst = baseRequest();
  cardinalityFirst.left = { ...cardinalityFirst.left, rows: [{ year: 2024 }] };
  cardinalityFirst.right = { ...cardinalityFirst.right, rows: [{ year: 2024 }, { year: 2024 }] };
  cardinalityFirst.left.grain = 'barangay';
  assert.equal(planJoin(cardinalityFirst).ok === false && planJoin(cardinalityFirst).error, 'one_to_many_join');
});

test('diagnoseJoin computes exact counts from real rows, including a row with a missing key', () => {
  const request = baseRequest();
  request.left = {
    ...request.left,
    rows: [{ year: 2024, amount_pesos: 1 }, { year: 2024, amount_pesos: 2 },
      { year: 9999, amount_pesos: 3 }, { amount_pesos: 4 }],
  };
  request.right = {
    ...request.right,
    rows: [{ year: 2024 }, { year: 2010 }, { year: 2011 }, { region: 'unknown' }],
  };
  const planResult = planJoin(request);
  assert.ok(planResult.ok);
  assert.deepEqual(diagnoseJoin(planResult.plan, request.left, request.right), {
    leftRows: 4,
    rightRows: 4,
    matchedRows: 2,
    unmatchedLeft: 2,
    unmatchedRight: 2,
    duplicateLeftKeys: 1,
    duplicateRightKeys: 0,
    cardinality: 'many-to-one',
  });
});

test('diagnoseJoin does not match left rows against duplicated right keys', () => {
  const plan: JoinPlan = { leftKey: 'year', rightKey: 'year', rightUniqueKeys: ['2024'] };
  const left: Side = { label: 'left', grain: 'year', columns: [col('year', 'integer')], rows: [{ year: 2024 }, { year: 2023 }] };
  const right: Side = { label: 'right', grain: 'year', columns: [col('year', 'integer')], rows: [{ year: 2024 }, { year: 2024 }, {}] };
  assert.deepEqual(diagnoseJoin(plan, left, right), {
    leftRows: 2,
    rightRows: 3,
    matchedRows: 0,
    unmatchedLeft: 2,
    unmatchedRight: 1,
    duplicateLeftKeys: 0,
    duplicateRightKeys: 1,
    cardinality: 'one-to-many',
  });
});

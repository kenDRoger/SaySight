import assert from 'node:assert/strict';
import test from 'node:test';

const { inferSchema, describeSchema } = await import('tsx/esm/api').then(async ({ tsImport }) =>
  tsImport<typeof import('../src/schemaInfer.ts')>('../src/schemaInfer.ts', import.meta.url));

const column = (name: string, values: unknown[]): Array<Record<string, unknown>> =>
  values.map((value) => ({ [name]: value }));

test('a column of whole numbers is inferred as integer with high confidence', () => {
  const { columns } = inferSchema(column('year', [2020, 2021, 2022, 2023, 2024, 2025, 2020, 2021, 2022, 2023]));
  assert.deepEqual(columns.map((item) => [item.name, item.type, item.confidence]), [['year', 'integer', 'high']]);
});

test('a numeric column with fractional values is a number, and empty values are ignored', () => {
  const values = [1.5, 2.25, 3, 4.75, 5, 6.5, 7, 8.25, 9, 10.5, '', '   ', null];
  const { columns } = inferSchema(column('amount', values));
  assert.deepEqual(columns.map((item) => [item.name, item.type, item.confidence]), [['amount', 'number', 'high']]);
});

test('mixed numeric and textual values force text with low confidence', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'not reported'];
  const [inferred] = inferSchema(column('amount', values)).columns;
  assert.equal(inferred.type, 'text');
  assert.equal(inferred.confidence, 'low');
  assert.match(inferred.reason, /conflicting values/);
  assert.match(inferred.reason, /integer/);
  assert.match(inferred.reason, /text/);
});

test('ISO-like dates are inferred as dates and non-ISO date strings are not', () => {
  const dates = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01', '2024-06-01', '2024-07-01', '2024-08-01', '2024-09-01', '2024-10-01'];
  const [date] = inferSchema(column('published', dates)).columns;
  assert.equal(date.type, 'date');
  assert.equal(date.confidence, 'high');
  const [loose] = inferSchema(column('published', dates.map((value) => value.replace(/-/g, '/')))).columns;
  assert.equal(loose.type, 'text');
});

test('booleans are inferred from real booleans and from the words true and false', () => {
  const flags = [true, false, true, false, true, false, true, false, true, false];
  assert.equal(inferSchema(column('current', flags)).columns[0].type, 'boolean');
  assert.equal(inferSchema(column('current', flags.map(String))).columns[0].type, 'boolean');
});

test('fewer than ten non-empty samples forces text with low confidence', () => {
  const [inferred] = inferSchema(column('year', [2020, 2021, 2022, 2023, 2024, 2025, 2020, 2021, 2022])).columns;
  assert.equal(inferred.type, 'text');
  assert.equal(inferred.confidence, 'low');
  assert.match(inferred.reason, /fewer than 10/);
  assert.match(inferred.reason, /9 non-empty samples/);
  // Exactly ten samples are enough to infer a type.
  assert.equal(inferSchema(column('year', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).columns[0].type, 'integer');
});

test('inference reads only the bounded sample it is given', () => {
  const rows = column('year', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).concat([{ year: 'later' }]);
  assert.equal(inferSchema(rows, 10).columns[0].type, 'integer');
  assert.equal(inferSchema(rows).columns[0].type, 'text');
});

test('describeSchema names the column count and the low-confidence columns', () => {
  const schema = inferSchema([
    ...column('year', [2020, 2021, 2022, 2023, 2024, 2025, 2020, 2021, 2022, 2023]),
    ...column('note', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']),
    ...column('amount', [1, 2, 3, 4, 5, 6, 7, 8, 9, 'unknown']),
  ]);
  const sentence = describeSchema(schema);
  assert.match(sentence, /3 columns/);
  assert.match(sentence, /amount/);
  assert.ok(!/year/.test(sentence), 'high-confidence columns are not listed');
  assert.match(describeSchema(inferSchema(column('year', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))), /all inferred with high confidence/);
  assert.match(describeSchema(inferSchema([])), /no columns/);
});

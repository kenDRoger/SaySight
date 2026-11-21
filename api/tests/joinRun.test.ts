import assert from 'node:assert/strict';
import test from 'node:test';

const { executeJoin, limitJoinedRows, joinedSchema } = await import('tsx/esm/api').then(async ({ tsImport }) =>
  tsImport<typeof import('../src/joinRun.ts')>('../src/joinRun.ts', import.meta.url));

const plan = { leftKey: 'id', rightKey: 'id', rightUniqueKeys: ['b'] };

test('executeJoin prefixes right columns so a shared name is not overwritten', () => {
  const result = executeJoin(plan,
    [{ id: 'a', amount: 10 }],
    [{ id: 'a', amount: 99, region: 'NCR' }],
  );
  assert.deepEqual(result.rows, [{ id: 'a', amount: 10, 'right.amount': 99, 'right.region': 'NCR' }]);
  assert.equal(result.diagnostics.matchedRows, 1);
  assert.equal(result.diagnostics.duplicateRightKeys, 0);
});

test('executeJoin excludes duplicated right keys and counts them in diagnostics', () => {
  const result = executeJoin(plan,
    [{ id: 'a', v: 1 }, { id: 'b', v: 2 }],
    [{ id: 'a', label: 'first' }, { id: 'a', label: 'second' }, { id: 'b', label: 'only' }],
  );
  assert.deepEqual(result.rows, [{ id: 'b', v: 2, 'right.label': 'only' }]);
  assert.equal(result.diagnostics.duplicateRightKeys, 1);
  assert.equal(result.diagnostics.matchedRows, 1);
  assert.equal(result.diagnostics.unmatchedLeft, 1);
  assert.equal(result.diagnostics.cardinality, 'one-to-many');
});

test('executeJoin leaves a left row with a missing key unmatched', () => {
  const result = executeJoin(plan,
    [{ id: 'a', v: 1 }, { v: 2 }],
    [{ id: 'a', label: 'found' }],
  );
  assert.deepEqual(result.rows, [{ id: 'a', v: 1, 'right.label': 'found' }]);
  assert.equal(result.diagnostics.matchedRows, 1);
  assert.equal(result.diagnostics.unmatchedLeft, 1);
});

test('limitJoinedRows truncates and reports the truncation', () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
  assert.deepEqual(limitJoinedRows(rows, 2), { rows: [{ n: 1 }, { n: 2 }], truncated: true });
  assert.deepEqual(limitJoinedRows(rows, 3), { rows, truncated: false });
  assert.deepEqual(limitJoinedRows(rows), { rows, truncated: false });
});

test('joinedSchema prefixes right columns and keeps the key once', () => {
  const schema = joinedSchema(
    [{ name: 'id', type: 'integer' }, { name: 'amount', type: 'number' }],
    [{ name: 'id', type: 'integer' }, { name: 'amount', type: 'number' }, { name: 'region', type: 'text' }],
    'id',
  );
  assert.deepEqual(schema, [
    { name: 'id', type: 'integer' },
    { name: 'amount', type: 'number' },
    { name: 'right.amount', type: 'number' },
    { name: 'right.region', type: 'text' },
  ]);
  assert.equal(schema.filter((column) => column.name === 'id').length, 1);
});

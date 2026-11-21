import assert from 'node:assert/strict';
import test from 'node:test';

const { computeDrift, classifyCheck, summarise, sourceFingerprint } = await import('tsx/esm/api').then(async ({ tsImport }) =>
  tsImport<typeof import('../src/refresh.ts')>('../src/refresh.ts', import.meta.url));

const fingerprint = (overrides: Partial<Parameters<typeof computeDrift>[0]> = {}): Parameters<typeof computeDrift>[0] => ({
  checksum: 'old-checksum',
  fiscalYears: [2023, 2024, 2025],
  rowCounts: { '2023': 10, '2024': 5, '2025': 7 },
  fields: ['year', 'status'],
  ...overrides,
});

test('a source is unchanged only when its checksum matches and changed when it differs', () => {
  assert.equal(classifyCheck('old-checksum', 'old-checksum'), 'unchanged');
  assert.equal(classifyCheck('old-checksum', 'new-checksum'), 'changed');
});

test('an unreadable source is classified as unreachable', () => {
  assert.equal(classifyCheck('old-checksum', undefined), 'unreachable');
  assert.equal(classifyCheck('', undefined), 'unreachable');
});

test('an identical snapshot produces an empty, serialisable drift report', () => {
  const report = computeDrift(fingerprint(), fingerprint());
  assert.deepEqual(report, {
    checksumChanged: false,
    addedYears: [],
    removedYears: [],
    rowCountChanges: [],
    addedFields: [],
    removedFields: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(report)) as unknown, report);
  assert.equal(summarise(report), 'Source unchanged: no differences found.');
});

test('drift reports added and removed years, differing row counts, and field changes', () => {
  const report = computeDrift(fingerprint(), fingerprint({
    checksum: 'new-checksum',
    fiscalYears: [2024, 2025, 2026],
    rowCounts: { '2024': 9, '2025': 7, '2026': 3 },
    fields: ['year', 'rows'],
  }));
  assert.deepEqual(report, {
    checksumChanged: true,
    addedYears: [2026],
    removedYears: [2023],
    rowCountChanges: [{ year: 2024, previous: 5, current: 9 }],
    addedFields: ['rows'],
    removedFields: ['status'],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(report)) as unknown, report);
  assert.equal(summarise(report), 'Source changed: the checksum changed; added fiscal years 2026; removed fiscal years 2023; row counts changed for 2024; added fields rows; removed fields status.');
});

test('a missing year is reported in the year arrays, never as a zero row count', () => {
  const report = computeDrift(
    fingerprint({ fiscalYears: [2024, 2025], rowCounts: { '2024': 5, '2025': 7 } }),
    fingerprint({ checksum: 'new-checksum', fiscalYears: [2024, 2026], rowCounts: { '2024': 9, '2026': 3 } }),
  );
  assert.deepEqual(report.addedYears, [2026]);
  assert.deepEqual(report.removedYears, [2025]);
  assert.deepEqual(report.rowCountChanges, [{ year: 2024, previous: 5, current: 9 }]);
  assert.ok(!report.rowCountChanges.some((change) => change.year === 2025 || change.year === 2026));
  assert.ok(!JSON.stringify(report).includes('"current":0'));
});

test('a structured source snapshot supplies coverage and row counts for the drift report', () => {
  const current = sourceFingerprint({
    fiscalYears: [2026, 2024],
    rowCounts: { '2024': 9, '2026': 3 },
    fields: ['rows', 'year'],
  }, 'new-checksum');
  assert.deepEqual(current, {
    checksum: 'new-checksum',
    fiscalYears: [2024, 2026],
    rowCounts: { '2024': 9, '2026': 3 },
    fields: ['rows', 'year'],
  });
  assert.deepEqual(computeDrift(fingerprint(), current).addedYears, [2026]);
});

test('a malformed source snapshot is refused instead of inventing coverage', () => {
  for (const snapshot of [[], null, 'text', { fiscalYears: [2024] }, { fiscalYears: ['2024'], rowCounts: {}, fields: [] }]) {
    assert.throws(() => sourceFingerprint(snapshot, 'new-checksum'), /invalid_source_snapshot/);
  }
});

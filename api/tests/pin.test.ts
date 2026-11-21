import assert from 'node:assert/strict';
import test from 'node:test';

const { releaseKey, licenceStatus, pinSummary, inferReleaseSchema } = await import('tsx/esm/api').then(async ({ tsImport }) =>
  tsImport<typeof import('../src/pin.ts')>('../src/pin.ts', import.meta.url));

test('releaseKey names the connector, dataset and checksum as one immutable path', () => {
  const checksum = 'a'.repeat(64);
  assert.equal(releaseKey('bettergov', 'gaa-coverage', checksum), `connectors/bettergov/gaa-coverage/${checksum}`);
});

test('licenceStatus distinguishes confirmed, absent and explicitly unstated licences', () => {
  assert.equal(licenceStatus('CC BY 4.0'), 'confirmed');
  assert.equal(licenceStatus(undefined), 'unconfirmed');
  assert.equal(licenceStatus(null), 'unconfirmed');
  assert.equal(licenceStatus(''), 'not-stated');
  assert.equal(licenceStatus('not-stated'), 'not-stated');
});

test('inferReleaseSchema reads a bounded schema from JSON rows or a CSV header', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ year: 2020 + index }));
  const json = inferReleaseSchema(new TextEncoder().encode(JSON.stringify(rows)), 'json');
  assert.deepEqual(json.columns.map((column) => [column.name, column.type, column.confidence]), [['year', 'integer', 'high']]);
  const csv = inferReleaseSchema(new TextEncoder().encode('year,note\n2024,a\n2025,b\n'), 'csv');
  assert.deepEqual(csv.columns.map((column) => column.name), ['year', 'note']);
  assert.deepEqual(inferReleaseSchema(new TextEncoder().encode('opaque'), 'xlsx').columns, []);
});

test('pinSummary states the connector, dataset, byte count and licence state in one sentence', () => {
  assert.equal(
    pinSummary('bettergov', 'gaa-coverage', 1024, 'unconfirmed'),
    'Pinned gaa-coverage from bettergov (1024 bytes) with licence status unconfirmed.',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedFormats, checkPublish, checkRows, checkUpload, detectFormat, isQuarantineReason, maxImportRows, maxUploadBytes, quarantineReasons } from '../src/uploadPolicy.ts';

test('only the four documented formats are accepted', () => {
  assert.deepEqual([...allowedFormats], ['csv', 'json', 'xlsx', 'parquet']);
  assert.equal(detectFormat('Budget.CSV'), 'csv');
  assert.equal(detectFormat('notes.txt'), undefined);
  assert.deepEqual(checkUpload({ filename: 'data.csv', bytes: 10 }), { ok: true, format: 'csv' });
  assert.deepEqual(checkUpload({ filename: 'data.txt', bytes: 10 }), { ok: false, error: 'unsupported_format' });
  assert.deepEqual(checkUpload({ filename: '  ', bytes: 10 }), { ok: false, error: 'name_required' });
});

test('empty and oversized uploads are refused at the boundary', () => {
  assert.deepEqual(checkUpload({ filename: 'a.csv', bytes: 0 }), { ok: false, error: 'empty_file' });
  assert.deepEqual(checkUpload({ filename: 'a.csv', bytes: maxUploadBytes + 1 }), { ok: false, error: 'file_too_large' });
  assert.deepEqual(checkUpload({ filename: 'a.csv', bytes: maxUploadBytes }), { ok: true, format: 'csv' });
});

test('row caps refuse rather than trim', () => {
  assert.deepEqual(checkRows(0), { ok: false, error: 'empty_dataset' });
  assert.deepEqual(checkRows(maxImportRows + 1), { ok: false, error: 'too_many_rows' });
  assert.deepEqual(checkRows(27), { ok: true });
});

test('a draft is published only by a maintainer and only after validation', () => {
  assert.deepEqual(checkPublish({ state: 'private-draft', role: 'maintainer' }), { ok: false, error: 'not_validated' });
  assert.deepEqual(checkPublish({ state: 'validated', role: 'reviewer' }), { ok: false, error: 'maintainer_required' });
  assert.deepEqual(checkPublish({ state: 'validated', role: 'maintainer' }), { ok: true });
  assert.deepEqual(checkPublish({ state: 'published', role: 'maintainer' }), { ok: false, error: 'already_published' });
  assert.deepEqual(checkPublish({ state: 'quarantined', role: 'maintainer' }), { ok: false, error: 'quarantined' });
});

test('quarantine reasons are a closed vocabulary', () => {
  assert.equal(isQuarantineReason('checksum_mismatch'), true);
  assert.equal(isQuarantineReason('because'), false);
  assert.equal(quarantineReasons.length, 4);
});

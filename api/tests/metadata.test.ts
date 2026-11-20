import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetadata, type PublicationMetadata } from '../src/metadata.ts';

const valid: PublicationMetadata = {
  publisher: 'Agency',
  sourceUrl: 'https://example.org/data',
  license: 'CC0 1.0 Universal',
  coverage: { fiscalYears: [2024] },
  fields: [{ name: 'year', type: 'integer', description: 'Fiscal year' }],
  limitations: [],
};

test('complete metadata is accepted', () => {
  assert.deepEqual(validateMetadata(valid), { ok: true });
});

test('every required field is checked, including source and reuse terms', () => {
  const result = validateMetadata({ publisher: '', sourceUrl: 'ftp://x', license: 'license not confirmed', coverage: {}, fields: [], limitations: undefined });
  assert.deepEqual(result, { ok: false, errors: [
    'publisher_required', 'source_url_required', 'license_required',
    'coverage_required', 'fields_required', 'limitations_required',
  ] });
});

test('coverage must contain integer fiscal years and fields must be named', () => {
  assert.deepEqual(validateMetadata({ ...valid, coverage: { fiscalYears: ['2024'] } }), { ok: false, errors: ['coverage_required'] });
  assert.deepEqual(validateMetadata({ ...valid, fields: [{}] }), { ok: false, errors: ['fields_required'] });
});

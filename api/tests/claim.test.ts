import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClaim } from '../src/claim.ts';

test('a missing or blank claim is refused', () => {
  assert.deepEqual(validateClaim(undefined), { error: 'claim_required' });
  assert.deepEqual(validateClaim('   '), { error: 'claim_required' });
});

test('a claim shorter than 20 characters is refused', () => {
  assert.deepEqual(validateClaim('x'.repeat(19)), { error: 'claim_too_short' });
});

test('a claim of exactly 20 characters is accepted', () => {
  assert.deepEqual(validateClaim('x'.repeat(20)), { claim: 'x'.repeat(20) });
});

test('a claim is trimmed before it is stored', () => {
  assert.deepEqual(validateClaim(`  ${'x'.repeat(20)}  `), { claim: 'x'.repeat(20) });
});

test('a claim longer than 1000 characters is refused', () => {
  assert.deepEqual(validateClaim('x'.repeat(1001)), { error: 'claim_too_long' });
});

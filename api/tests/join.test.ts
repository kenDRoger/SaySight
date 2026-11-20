import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseJoin, joinLimitations, joinRecipeVersion, planJoin, type Relationship } from '../src/join.ts';

const relationship: Relationship = {
  id: 'rel-1',
  primaryReleaseId: 'primary-release',
  relatedReleaseId: 'related-release',
  joinKeys: ['fiscal_year', 'agency'],
  status: 'validated',
};

test('only the validated curated pair with explicit keys can be planned', () => {
  const result = planJoin({ relationship, primaryReleaseId: 'primary-release', relatedReleaseId: 'related-release' });
  assert.ok(result.ok);
  assert.deepEqual(result.plan, {
    relationshipId: 'rel-1', primaryReleaseId: 'primary-release', relatedReleaseId: 'related-release',
    joinKeys: ['fiscal_year', 'agency'], recipeVersion: joinRecipeVersion,
  });
});

test('draft and retired relationships are refused', () => {
  for (const status of ['draft', 'retired'] as const) {
    assert.deepEqual(planJoin({ relationship: { ...relationship, status }, primaryReleaseId: 'primary-release', relatedReleaseId: 'related-release' }),
      { ok: false, error: 'relationship_not_validated' });
  }
});

test('a different release pair is refused', () => {
  assert.deepEqual(planJoin({ relationship, primaryReleaseId: 'primary-release', relatedReleaseId: 'other' }),
    { ok: false, error: 'release_pair_mismatch' });
});

test('empty, blank, or duplicated keys are refused', () => {
  for (const joinKeys of [[], ['  '], ['year', 'year']]) {
    assert.deepEqual(planJoin({ relationship: { ...relationship, joinKeys }, primaryReleaseId: 'primary-release', relatedReleaseId: 'related-release' }),
      { ok: false, error: 'invalid_join_keys' });
  }
});

test('diagnostics report unmatched rows and key conflicts', () => {
  const clean = diagnoseJoin({ leftRows: 10, rightRows: 8, matchedRows: 8, unmatchedLeft: 2, unmatchedRight: 0, duplicateKeys: 0 });
  assert.equal(clean.valid, true);
  const conflicted = diagnoseJoin({ leftRows: 10, rightRows: 8, matchedRows: 7, unmatchedLeft: 3, unmatchedRight: 1, duplicateKeys: 1 });
  assert.equal(conflicted.valid, false);
  assert.throws(() => diagnoseJoin({ leftRows: -1, rightRows: 0, matchedRows: 0, unmatchedLeft: 0, unmatchedRight: 0, duplicateKeys: 0 }), /invalid_diagnostic_counts/);
});

test('limitations are explicit', () => {
  assert.equal(joinLimitations.length, 3);
  assert.ok(joinLimitations.some((item) => item.includes('curated')));
});

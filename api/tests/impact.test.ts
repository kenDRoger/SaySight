import test from 'node:test';
import assert from 'node:assert/strict';
import { checkImpactGate, conflictRecord, deriveImpact, detectConflict, impacts, isImpact, requiredDecisions } from '../src/impact.ts';

test('impact is derived from how much of the release the finding covers', () => {
  assert.equal(deriveImpact({ inputRows: 27, sourceRows: 27, filters: {} }), 'high');
  assert.equal(deriveImpact({ inputRows: 27, sourceRows: 27, filters: { year: 2024 } }), 'standard');
  assert.equal(deriveImpact({ inputRows: 5, sourceRows: 27, filters: { year: 2024, status: 'GAA' } }), 'low');
  assert.equal(deriveImpact({ inputRows: 0, sourceRows: 0, filters: {} }), 'high');
});

test('high impact requires two independent decisions', () => {
  assert.equal(requiredDecisions('high'), 2);
  assert.equal(requiredDecisions('standard'), 1);
  assert.equal(requiredDecisions('low'), 1);
  assert.deepEqual(checkImpactGate({ impact: 'high', decisionsMade: 1, role: 'reviewer' }), { ok: true });
  assert.deepEqual(checkImpactGate({ impact: 'high', decisionsMade: 2, role: 'reviewer' }), { ok: false, error: 'second_review_in_progress' });
  assert.deepEqual(checkImpactGate({ impact: 'low', decisionsMade: 0, role: 'submitter' }), { ok: false, error: 'reviewer_required' });
});

test('two different terminal decisions are a conflict, one decision is not', () => {
  const verified = { actorId: 'r1', status: 'Verified', reason: 'matches', createdAt: '2026-01-01T00:00:00Z' };
  const rejected = { actorId: 'r2', status: 'Rejected', reason: 'filters wrong', createdAt: '2026-01-02T00:00:00Z' };
  assert.deepEqual(detectConflict([verified]), { conflicted: false, statuses: ['Verified'] });
  assert.deepEqual(detectConflict([verified, rejected]), { conflicted: true, statuses: ['Verified', 'Rejected'] });
  assert.equal(conflictRecord('f1', [verified]), undefined);
  const record = conflictRecord('f1', [verified, rejected]);
  assert.equal(record?.findingId, 'f1');
  assert.equal(record?.positions.length, 2);
  assert.deepEqual(record?.statuses, ['Verified', 'Rejected']);
});

test('status vocabulary is closed', () => {
  assert.deepEqual([...impacts], ['low', 'standard', 'high']);
  assert.equal(isImpact('High'), false);
  assert.equal(isImpact('high'), true);
});

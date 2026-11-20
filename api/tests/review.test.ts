import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTransition, decisionStatuses, isStatus, reasonLimit, reviewQueueStatuses, statuses, validateReason } from '../src/review.ts';

const reviewer = { role: 'reviewer' as const, actorId: 'reviewer-1', submittedBy: 'author-1' };

test('the documented status set is exactly the one mvp.md names', () => {
  assert.deepEqual([...statuses], ['Unverified', 'Pending verification', 'In review', 'Verified', 'Needs correction', 'Rejected', 'Insufficient evidence']);
  assert.deepEqual([...decisionStatuses], ['Verified', 'Needs correction', 'Rejected', 'Insufficient evidence']);
  assert.deepEqual([...reviewQueueStatuses], ['Pending verification', 'In review']);
});

test('a decision status cannot be reached in one step from Unverified', () => {
  assert.deepEqual(checkTransition({ ...reviewer, from: 'Unverified', to: 'Verified' }), {
    ok: false, error: 'invalid_transition', allowed: ['Pending verification', 'Rejected'],
  });
});

test('the review path runs Unverified to a terminal decision', () => {
  assert.deepEqual(checkTransition({ ...reviewer, from: 'Unverified', to: 'Pending verification' }), { ok: true });
  assert.deepEqual(checkTransition({ ...reviewer, from: 'Pending verification', to: 'In review' }), { ok: true });
  assert.deepEqual(checkTransition({ ...reviewer, from: 'In review', to: 'Verified' }), { ok: true });
});

test('every terminal status refuses further transitions', () => {
  for (const from of ['Verified', 'Rejected', 'Insufficient evidence']) {
    for (const to of statuses) {
      assert.equal(checkTransition({ ...reviewer, from, to }).ok, false, `${from} -> ${to}`);
    }
  }
});

test('Needs correction returns to the submitter instead of ending the workflow', () => {
  assert.deepEqual(checkTransition({ ...reviewer, from: 'In review', to: 'Needs correction' }), { ok: true });
  assert.deepEqual(checkTransition({ ...reviewer, from: 'Needs correction', to: 'Pending verification' }), { ok: true });
});

test('a submitter cannot decide a review', () => {
  assert.deepEqual(
    checkTransition({ from: 'In review', to: 'Verified', role: 'submitter', actorId: 'someone-else', submittedBy: 'author-1' }),
    { ok: false, error: 'reviewer_required' },
  );
});

test('a reviewer cannot decide their own submission, even as a maintainer', () => {
  for (const role of ['reviewer', 'maintainer'] as const) {
    assert.deepEqual(
      checkTransition({ from: 'In review', to: 'Verified', role, actorId: 'author-1', submittedBy: 'author-1' }),
      { ok: false, error: 'self_review_not_allowed' },
    );
  }
});

test('unknown statuses are refused rather than coerced', () => {
  assert.equal(isStatus('Verified '), false);
  assert.equal(isStatus('verified'), false);
  assert.deepEqual(checkTransition({ ...reviewer, from: 'Unverified', to: 'Bogus' }), { ok: false, error: 'invalid_status' });
});

test('a decision reason is mandatory and bounded', () => {
  assert.deepEqual(validateReason('  '), { error: 'reason_required' });
  assert.deepEqual(validateReason(undefined), { error: 'reason_required' });
  assert.deepEqual(validateReason('x'.repeat(reasonLimit + 1)), { error: 'reason_too_long' });
  assert.deepEqual(validateReason('  checked against the release  '), { reason: 'checked against the release' });
});

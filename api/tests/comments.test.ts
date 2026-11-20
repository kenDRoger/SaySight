import test from 'node:test';
import assert from 'node:assert/strict';
import { canComment, checkRemoval, commentBodyLimit, removalReasonLimit, validateCommentBody, validateRemovalReason } from '../src/comments.ts';

test('a comment body is required, trimmed, and bounded', () => {
  assert.deepEqual(validateCommentBody('   '), { error: 'comment_required' });
  assert.deepEqual(validateCommentBody(undefined), { error: 'comment_required' });
  assert.deepEqual(validateCommentBody('  good point  '), { body: 'good point' });
  assert.deepEqual(validateCommentBody('x'.repeat(commentBodyLimit + 1)), { error: 'comment_too_long' });
});

test('removal demands a moderator and a written reason', () => {
  assert.deepEqual(checkRemoval({ status: 'visible', role: 'submitter' }), { ok: false, error: 'moderator_required' });
  assert.deepEqual(checkRemoval({ status: 'visible', role: 'reviewer' }), { ok: true });
  assert.deepEqual(checkRemoval({ status: 'visible', role: 'maintainer' }), { ok: true });
  assert.deepEqual(checkRemoval({ status: 'removed', role: 'maintainer' }), { ok: false, error: 'comment_already_removed' });
  assert.deepEqual(validateRemovalReason(''), { error: 'removal_reason_required' });
  assert.deepEqual(validateRemovalReason('x'.repeat(removalReasonLimit + 1)), { error: 'removal_reason_too_long' });
  assert.deepEqual(validateRemovalReason(' off topic '), { reason: 'off topic' });
});

test('only a signed-in account may comment', () => {
  assert.equal(canComment(true), true);
  assert.equal(canComment(false), false);
});

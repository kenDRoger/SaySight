// Comment rules. MVP-B publishes comments immediately and lets a moderator remove
// them with a recorded reason; pre-moderation is the documented alternative if
// BetterGov prefers it later, so the status set already carries `pending`.
export type CommentStatus = 'visible' | 'removed';
export type Role = 'submitter' | 'reviewer' | 'maintainer';

export const commentBodyLimit = 5000;
export const removalReasonLimit = 500;

export function validateCommentBody(value: unknown): { body: string } | { error: 'comment_required' | 'comment_too_long' } {
  if (typeof value !== 'string') return { error: 'comment_required' };
  const body = value.trim();
  if (!body) return { error: 'comment_required' };
  if (body.length > commentBodyLimit) return { error: 'comment_too_long' };
  return { body };
}

export function validateRemovalReason(value: unknown): { reason: string } | { error: 'removal_reason_required' | 'removal_reason_too_long' } {
  if (typeof value !== 'string') return { error: 'removal_reason_required' };
  const reason = value.trim();
  if (!reason) return { error: 'removal_reason_required' };
  if (reason.length > removalReasonLimit) return { error: 'removal_reason_too_long' };
  return { reason };
}

export const canComment = (signedIn: boolean) => signedIn;

// Removal is a moderation act, not an author act: only reviewers and maintainers
// remove content, and a comment that is already removed stays removed so the log
// is not rewritten.
export function checkRemoval(input: { status: CommentStatus; role: Role }):
  | { ok: true }
  | { ok: false; error: 'moderator_required' | 'comment_already_removed' } {
  if (input.status === 'removed') return { ok: false, error: 'comment_already_removed' };
  if (input.role !== 'reviewer' && input.role !== 'maintainer') return { ok: false, error: 'moderator_required' };
  return { ok: true };
}

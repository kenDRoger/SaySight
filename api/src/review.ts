// Workflow rules for a finding. Statuses are mutable workflow state and every
// change is written to the append-only `finding_transitions` table; the evidence
// a finding points at never changes.
export const statuses = ['Unverified', 'Pending verification', 'In review', 'Verified', 'Needs correction', 'Rejected', 'Insufficient evidence'] as const;
export type Status = (typeof statuses)[number];
export type Role = 'submitter' | 'reviewer' | 'maintainer';

// Decision statuses end the review; `Needs correction` sends the finding back for
// a new submission, so it is the only non-terminal outcome.
const transitions: Record<Status, Status[]> = {
  Unverified: ['Pending verification', 'Rejected'],
  'Pending verification': ['In review', 'Rejected', 'Insufficient evidence'],
  'In review': ['Verified', 'Needs correction', 'Rejected', 'Insufficient evidence'],
  'Needs correction': ['Pending verification', 'Rejected'],
  Verified: [],
  Rejected: [],
  'Insufficient evidence': [],
};

export const decisionStatuses: Status[] = ['Verified', 'Needs correction', 'Rejected', 'Insufficient evidence'];
// A submitted finding is Unverified, and triage is a reviewer job: without it here a new
// finding is invisible to every reviewer and the documented flow stops at step one.
export const reviewQueueStatuses: Status[] = ['Unverified', 'Pending verification', 'In review'];

export const isStatus = (value: unknown): value is Status => typeof value === 'string' && (statuses as readonly string[]).includes(value);

export const reasonLimit = 2000;

// An empty reason is refused: a reviewer decision must explain itself. Returns the
// trimmed reason or a typed failure the caller turns into a 400.
export function validateReason(value: unknown): { reason: string } | { error: 'reason_required' | 'reason_too_long' } {
  if (typeof value !== 'string') return { error: 'reason_required' };
  const reason = value.trim();
  if (!reason) return { error: 'reason_required' };
  if (reason.length > reasonLimit) return { error: 'reason_too_long' };
  return { reason };
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; error: 'invalid_status' | 'invalid_transition' | 'reviewer_required' | 'self_review_not_allowed'; allowed?: Status[] };

export function checkTransition(input: { from: string; to: string; role: Role; actorId: string; submittedBy: string | null }): TransitionCheck {
  const { from, to, role, actorId, submittedBy } = input;
  if (!isStatus(from) || !isStatus(to)) return { ok: false, error: 'invalid_status' };
  const allowed = transitions[from];
  if (!allowed.includes(to)) return { ok: false, error: 'invalid_transition', allowed };
  const privileged = role === 'reviewer' || role === 'maintainer';
  if (!privileged) return { ok: false, error: 'reviewer_required' };
  // Nobody reviews their own submission, whatever their role.
  if (submittedBy && actorId === submittedBy) return { ok: false, error: 'self_review_not_allowed' };
  return { ok: true };
}

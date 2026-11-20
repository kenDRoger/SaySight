// Review depth and conflict resolution. Impact is derived from the evidence a
// finding points at, so it never depends on what the submitter claims, and a
// disagreement between reviewers is stored instead of being silently settled.
export type Impact = 'low' | 'standard' | 'high';
export type Role = 'submitter' | 'reviewer' | 'maintainer';
export const impacts: Impact[] = ['low', 'standard', 'high'];

// Deterministic derivation: the broader the slice of the dataset and the more
// money it covers, the more scrutiny the finding needs.
export function deriveImpact(evidence: { inputRows: number; sourceRows: number; filters: Record<string, unknown> }): Impact {
  const { inputRows, sourceRows, filters } = evidence;
  const share = sourceRows > 0 ? inputRows / sourceRows : 1;
  const narrowed = Object.values(filters).some((value) => value !== undefined && value !== null && value !== '');
  // An unfiltered run describes the whole release, so a mistake there misleads the
  // most people; a single narrow filter is the least consequential case.
  if (!narrowed && share >= 0.99) return 'high';
  if (share >= 0.5) return 'standard';
  return 'low';
}

// Independent decisions needed before a status is final.
export const requiredDecisions = (impact: Impact): number => (impact === 'high' ? 2 : 1);

export const isImpact = (value: unknown): value is Impact => typeof value === 'string' && (impacts as string[]).includes(value);

// A second reviewer may start only when the first has not settled the finding.
export function checkImpactGate(input: { impact: Impact; decisionsMade: number; role: Role }):
  | { ok: true }
  | { ok: false; error: 'reviewer_required' | 'second_review_in_progress' } {
  if (input.role !== 'reviewer' && input.role !== 'maintainer') return { ok: false, error: 'reviewer_required' };
  if (input.decisionsMade < requiredDecisions(input.impact)) return { ok: true };
  return { ok: false, error: 'second_review_in_progress' };
}

export type ConflictInput = { actorId: string; status: string; reason: string; createdAt: string };

// Two reviewers reaching different terminal statuses is a conflict, and the record
// keeps both positions rather than picking a winner without review.
export function detectConflict(decisions: ConflictInput[]): { conflicted: boolean; statuses: string[] } {
  const terminal = decisions.filter((decision) => decision.status !== 'In review' && decision.status !== 'Pending verification');
  const statuses = [...new Set(terminal.map((decision) => decision.status))];
  return { conflicted: statuses.length > 1, statuses };
}

export function conflictRecord(findingId: string, decisions: ConflictInput[]) {
  const { conflicted, statuses } = detectConflict(decisions);
  if (!conflicted) return undefined;
  return {
    findingId,
    // Both positions plus who took them: the record explains the disagreement.
    positions: decisions.map((decision) => ({ actorId: decision.actorId, status: decision.status, reason: decision.reason, createdAt: decision.createdAt })),
    statuses,
  };
}

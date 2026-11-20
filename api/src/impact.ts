// Review depth and conflict resolution. Impact is derived from the evidence a
// finding points at, so it never depends on what the submitter claims, and a
// disagreement between reviewers is stored instead of being silently settled.
export type Impact = 'low' | 'standard' | 'high';
export type Role = 'submitter' | 'reviewer' | 'maintainer';
export const impacts: Impact[] = ['low', 'standard', 'high'];

// Deterministic derivation from how much of the release period a finding speaks
// for: a claim about the whole series can mislead everyone who reads it, while a
// single year is the narrowest case the recipes offer.
export function deriveImpact(input: { filters: Record<string, unknown>; totalYears: number }): Impact {
  const { filters, totalYears } = input;
  const selected = Array.isArray(filters.years) ? filters.years.length : typeof filters.year === 'number' ? 1 : undefined;
  // No year filter speaks for the entire series; one year is the narrowest claim the
  // recipes can make; anything in between is a comparison across several years.
  if (selected === undefined || totalYears <= 0) return 'high';
  if (selected <= 1) return 'low';
  return selected >= totalYears ? 'high' : 'standard';
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

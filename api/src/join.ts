// Curated join rules. The only permitted join is a validated relationship
// already in the catalog, with explicit keys and no user-supplied SQL.
export type Relationship = {
  id: string;
  primaryReleaseId: string;
  relatedReleaseId: string;
  joinKeys: string[];
  status: 'draft' | 'validated' | 'retired';
};

export type JoinPlan = {
  relationshipId: string;
  primaryReleaseId: string;
  relatedReleaseId: string;
  joinKeys: string[];
  recipeVersion: string;
};

export type PlanResult = { ok: true; plan: JoinPlan } | { ok: false; error: 'relationship_not_validated' | 'release_pair_mismatch' | 'invalid_join_keys' };

export const joinRecipeVersion = 'joined-v1';

export function planJoin(input: { relationship: Relationship; primaryReleaseId: string; relatedReleaseId: string }): PlanResult {
  const { relationship } = input;
  if (relationship.status !== 'validated') return { ok: false, error: 'relationship_not_validated' };
  if (input.primaryReleaseId !== relationship.primaryReleaseId || input.relatedReleaseId !== relationship.relatedReleaseId) {
    return { ok: false, error: 'release_pair_mismatch' };
  }
  if (!relationship.joinKeys.length || relationship.joinKeys.some((key) => !key.trim()) ||
      new Set(relationship.joinKeys).size !== relationship.joinKeys.length) return { ok: false, error: 'invalid_join_keys' };
  return { ok: true, plan: { relationshipId: relationship.id, primaryReleaseId: relationship.primaryReleaseId,
    relatedReleaseId: relationship.relatedReleaseId, joinKeys: [...relationship.joinKeys], recipeVersion: joinRecipeVersion } };
}

export type JoinDiagnostics = {
  leftRows: number;
  rightRows: number;
  matchedRows: number;
  unmatchedLeft: number;
  unmatchedRight: number;
  duplicateKeys: number;
  valid: boolean;
};

// Diagnostics make the join's blind spots visible: unmatched rows and duplicate
// keys are reported, never silently dropped.
export function diagnoseJoin(input: Omit<JoinDiagnostics, 'valid'>): JoinDiagnostics {
  const { leftRows, rightRows, matchedRows, unmatchedLeft, unmatchedRight, duplicateKeys } = input;
  const counts = [leftRows, rightRows, matchedRows, unmatchedLeft, unmatchedRight, duplicateKeys];
  if (counts.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('invalid_diagnostic_counts');
  return { ...input, valid: duplicateKeys === 0 && matchedRows > 0 && unmatchedLeft + matchedRows <= leftRows && unmatchedRight + matchedRows <= rightRows };
}

export const joinLimitations = [
  'Only the curated primary/related release pair can be joined.',
  'Rows with missing or duplicated join keys are excluded from matched results and reported in diagnostics.',
  'A joined result is evidence for that exact pair of releases and recipe version only.',
];

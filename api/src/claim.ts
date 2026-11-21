export const claimMinLength = 20;
export const claimMaxLength = 1000;

export function validateClaim(value: unknown): { claim: string } | { error: 'claim_required' | 'claim_too_short' | 'claim_too_long' } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'claim_required' };
  const claim = value.trim();
  if (claim.length < claimMinLength) return { error: 'claim_too_short' };
  if (claim.length > claimMaxLength) return { error: 'claim_too_long' };
  return { claim };
}

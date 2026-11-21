// Pure E2 join planner. Selection, guards, plan and diagnostics only; execution
// and wiring belong to a later unit. Exactly two sides are ever considered.
export type Column = { name: string; type: 'integer' | 'number' | 'text' | 'date' | 'boolean' };
export type Side = { label: string; columns: Column[]; rows: Array<Record<string, unknown>>; grain: string };
export type Aggregation = { column: string; fn: 'sum' | 'count' | 'mean' | 'min' | 'max'; targetGrain: string };
export type JoinRequest = { left: Side; right: Side; leftKey: string; rightKey: string; aggregation?: Aggregation };

export type JoinDiagnostics = {
  leftRows: number;
  rightRows: number;
  matchedRows: number;
  unmatchedLeft: number;
  unmatchedRight: number;
  duplicateLeftKeys: number;
  duplicateRightKeys: number;
  cardinality: 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';
};

export type JoinErrorCode =
  | 'missing_column'
  | 'incompatible_key_types'
  | 'many_to_many_join'
  | 'one_to_many_join'
  | 'grain_mismatch'
  | 'aggregation_grain_mismatch'
  | 'missing_aggregation_column'
  | 'unsafe_aggregation';

export type CheckResult = { ok: true } | { ok: false; error: JoinErrorCode; message: string };
export type CardinalityCheck = { ok: true; cardinality: 'one-to-one' | 'many-to-one' } | { ok: false; error: JoinErrorCode; message: string };
export type JoinPlan = { leftKey: string; rightKey: string; rightUniqueKeys: string[]; aggregation?: Aggregation };
export type PlanResult = { ok: true; plan: JoinPlan } | { ok: false; error: JoinErrorCode; message: string };

const fail = (error: JoinErrorCode, message: string) => ({ ok: false as const, error, message });

// Missing and blank key values are absent, not a shared join key. Stringify so
// declared integer/number keys match whether a value arrived as 1 or '1'.
const keyOf = (row: Record<string, unknown>, key: string): string | undefined => {
  const value = row[key];
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  return String(value);
};

const compatibleTypes = (left: Column['type'], right: Column['type']): boolean =>
  left === right || (left === 'integer' && right === 'number') || (left === 'number' && right === 'integer');

export function checkKeys(request: JoinRequest): CheckResult {
  const leftType = request.left.columns.find((column) => column.name === request.leftKey)?.type;
  if (!leftType) return fail('missing_column', `Missing left column '${request.leftKey}' on side '${request.left.label}'.`);
  const rightType = request.right.columns.find((column) => column.name === request.rightKey)?.type;
  if (!rightType) return fail('missing_column', `Missing right column '${request.rightKey}' on side '${request.right.label}'.`);
  if (!compatibleTypes(leftType, rightType)) {
    return fail('incompatible_key_types', `Incompatible key types: left '${leftType}' and right '${rightType}'.`);
  }
  return { ok: true };
}

export function measureCardinality(rows: Array<Record<string, unknown>>, key: string): { unique: number; duplicates: number } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = keyOf(row, key);
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of counts.values()) if (count > 1) duplicates++;
  return { unique: counts.size, duplicates };
}

export function checkCardinality(request: JoinRequest): CardinalityCheck {
  const { duplicates: leftDuplicates } = measureCardinality(request.left.rows, request.leftKey);
  const { duplicates: rightDuplicates } = measureCardinality(request.right.rows, request.rightKey);
  if (leftDuplicates > 0 && rightDuplicates > 0) {
    return fail('many_to_many_join', `Many-to-many join: left duplicate keys = ${leftDuplicates}, right duplicate keys = ${rightDuplicates}.`);
  }
  if (rightDuplicates > 0) {
    return fail('one_to_many_join', `One-to-many join: right duplicate keys = ${rightDuplicates} (MVP-E executes only joins with unique right keys).`);
  }
  return { ok: true, cardinality: leftDuplicates > 0 ? 'many-to-one' : 'one-to-one' };
}

export function checkGrain(request: JoinRequest): CheckResult {
  const { left, right, aggregation } = request;
  if (left.grain !== right.grain && !aggregation) {
    return fail('grain_mismatch', `Grain mismatch: left grain '${left.grain}' and right grain '${right.grain}'. Aggregate one side first to a target grain matching the other side, for example '${right.grain}'.`);
  }
  if (aggregation) {
    // The aggregation carries no side: it rolls the left side up to the right
    // grain, the side that must stay unique for execution (S3).
    if (aggregation.targetGrain !== right.grain) {
      return fail('aggregation_grain_mismatch', `Aggregation target grain '${aggregation.targetGrain}' does not match the right grain '${right.grain}'.`);
    }
    if (!left.columns.some((column) => column.name === aggregation.column)) {
      return fail('missing_aggregation_column', `Aggregation column '${aggregation.column}' is missing from the left side.`);
    }
    if ((aggregation.fn === 'sum' || aggregation.fn === 'mean') && /(rate|ratio|percent|percentage|avg|average|share)/i.test(aggregation.column)) {
      return fail('unsafe_aggregation', `Unsafe aggregation '${aggregation.fn}' on '${aggregation.column}': rates, percentages and averages cannot be summed or averaged.`);
    }
  }
  return { ok: true };
}

export function planJoin(request: JoinRequest): PlanResult {
  const keys = checkKeys(request);
  if (!keys.ok) return keys;
  const cardinality = checkCardinality(request);
  if (!cardinality.ok) return cardinality;
  const grain = checkGrain(request);
  if (!grain.ok) return grain;

  const rightUniqueKeys = [...new Set(request.right.rows
    .map((row) => keyOf(row, request.rightKey))
    .filter((value): value is string => value !== undefined))].sort();
  const plan: JoinPlan = { leftKey: request.leftKey, rightKey: request.rightKey, rightUniqueKeys };
  if (request.aggregation) plan.aggregation = { ...request.aggregation };
  return { ok: true, plan };
}

export function diagnoseJoin(plan: JoinPlan, left: Side, right: Side): JoinDiagnostics {
  const rightCounts = new Map<string, number>();
  for (const row of right.rows) {
    const value = keyOf(row, plan.rightKey);
    if (value === undefined) continue;
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }

  const matchedKeys = new Set<string>();
  let matchedRows = 0;
  for (const row of left.rows) {
    const value = keyOf(row, plan.leftKey);
    if (value !== undefined && rightCounts.get(value) === 1) {
      matchedRows++;
      matchedKeys.add(value);
    }
  }

  let unmatchedRight = 0;
  for (const key of rightCounts.keys()) if (!matchedKeys.has(key)) unmatchedRight++;

  const leftCardinality = measureCardinality(left.rows, plan.leftKey);
  const rightCardinality = measureCardinality(right.rows, plan.rightKey);
  const cardinality = leftCardinality.duplicates > 0 && rightCardinality.duplicates > 0 ? 'many-to-many'
    : rightCardinality.duplicates > 0 ? 'one-to-many'
      : leftCardinality.duplicates > 0 ? 'many-to-one' : 'one-to-one';

  return {
    leftRows: left.rows.length,
    rightRows: right.rows.length,
    matchedRows,
    unmatchedLeft: left.rows.length - matchedRows,
    unmatchedRight,
    duplicateLeftKeys: leftCardinality.duplicates,
    duplicateRightKeys: rightCardinality.duplicates,
    cardinality,
  };
}

export type ReleaseFingerprint = {
  checksum: string;
  fiscalYears: number[];
  rowCounts: Record<string, number>;
  fields: string[];
};

export type CheckStatus = 'unchanged' | 'changed' | 'unreachable';

export type DriftReport = {
  checksumChanged: boolean;
  addedYears: number[];
  removedYears: number[];
  rowCountChanges: Array<{ year: number; previous: number; current: number }>;
  addedFields: string[];
  removedFields: string[];
};

const isFiscalYear = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const ascending = (left: number, right: number) => left - right;

export function computeDrift(previous: ReleaseFingerprint, current: ReleaseFingerprint): DriftReport {
  const previousYears = new Set(previous.fiscalYears);
  const currentYears = new Set(current.fiscalYears);
  const addedYears = [...currentYears].filter((year) => !previousYears.has(year)).sort(ascending);
  const removedYears = [...previousYears].filter((year) => !currentYears.has(year)).sort(ascending);
  // Years present on only one side are reported above; inventing a zero count
  // for a missing year would make an absent source row look like a measurement.
  const sharedYears = [...currentYears].filter((year) => previousYears.has(year)).sort(ascending);
  const rowCountChanges = sharedYears.flatMap((year) => {
    const before = previous.rowCounts[String(year)];
    const after = current.rowCounts[String(year)];
    return typeof before === 'number' && typeof after === 'number' && before !== after
      ? [{ year, previous: before, current: after }]
      : [];
  });
  const previousFields = new Set(previous.fields);
  const currentFields = new Set(current.fields);
  return {
    checksumChanged: previous.checksum !== current.checksum,
    addedYears,
    removedYears,
    rowCountChanges,
    addedFields: [...currentFields].filter((field) => !previousFields.has(field)).sort(),
    removedFields: [...previousFields].filter((field) => !currentFields.has(field)).sort(),
  };
}

export function classifyCheck(previousChecksum: string, currentChecksum: string | undefined): CheckStatus {
  if (currentChecksum === undefined) return 'unreachable';
  return currentChecksum === previousChecksum ? 'unchanged' : 'changed';
}

// A source snapshot describes coverage only in this structured form. Anything
// else is a checksum-only observation, so no coverage differences are invented.
export function sourceFingerprint(snapshot: unknown, checksum: string): ReleaseFingerprint {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid_source_snapshot');
  const value = snapshot as Record<string, unknown>;
  const fiscalYears = value.fiscalYears;
  const rowCounts = value.rowCounts;
  const fields = value.fields;
  if (!Array.isArray(fiscalYears) || !fiscalYears.every(isFiscalYear)
    || !rowCounts || typeof rowCounts !== 'object' || Array.isArray(rowCounts)
    || !Array.isArray(fields) || !fields.every((field): field is string => typeof field === 'string')) {
    throw new Error('invalid_source_snapshot');
  }
  const counts: Record<string, number> = {};
  for (const [year, count] of Object.entries(rowCounts)) {
    if (!Number.isInteger(Number(year)) || typeof count !== 'number' || !Number.isFinite(count)) throw new Error('invalid_source_snapshot');
    counts[year] = count;
  }
  return { checksum, fiscalYears: [...new Set(fiscalYears)].sort(ascending), rowCounts: counts,
    fields: [...new Set(fields)].sort() };
}

export function summarise(report: DriftReport): string {
  const changes: string[] = [];
  if (report.checksumChanged) changes.push('the checksum changed');
  if (report.addedYears.length) changes.push(`added fiscal years ${report.addedYears.join(', ')}`);
  if (report.removedYears.length) changes.push(`removed fiscal years ${report.removedYears.join(', ')}`);
  if (report.rowCountChanges.length) changes.push(`row counts changed for ${report.rowCountChanges.map((change) => change.year).join(', ')}`);
  if (report.addedFields.length) changes.push(`added fields ${report.addedFields.join(', ')}`);
  if (report.removedFields.length) changes.push(`removed fields ${report.removedFields.join(', ')}`);
  return changes.length ? `Source changed: ${changes.join('; ')}.` : 'Source unchanged: no differences found.';
}

// Pure generic recipe execution over arbitrary rows (E3). The same five insights
// as worker/analysis.go, computed from any dataset's rows; no I/O, no wiring.
import type { Selection } from './insights.js';

export type Row = Record<string, unknown>;
export type Column = { name: string; type: 'integer' | 'number' | 'text' | 'date' | 'boolean' };

export type RecipeId = 'summary' | 'rank' | 'distribution' | 'change_over_time' | 'compare';

export type RecipeResult = {
  recipe: string;
  recipeVersion: string;
  calculation: string;
  result: unknown;
  outputRows: number;
  warnings: string[];
};

export type RecipeOptions = {
  measure?: string;
  field?: string;
  top?: number;
  periodA?: string | number;
  periodB?: string | number;
};

export type RecipeRun = {
  results: RecipeResult[];
  skipped: Selection['skipped'];
};

const RECIPE_VERSION = 'generic-v1';

const round2 = (value: number): number => Math.round(value * 100) / 100;

const isMissing = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

// Booleans and nulls are not numbers: Number(true) and Number(null) are 1 and 0.
const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const numericColumns = (columns: Column[]): Column[] =>
  columns.filter(({ type }) => type === 'integer' || type === 'number');

const categoricalColumns = (columns: Column[]): Column[] =>
  columns.filter(({ type }) => type === 'text' || type === 'boolean');

const yearCandidates = (columns: Column[]): Column[] =>
  columns.filter(({ name }) => /^(year|fiscal_year)$/i.test(name.trim()));

const orderedYearColumn = (columns: Column[]): Column | undefined =>
  yearCandidates(columns).find(({ type }) => type === 'integer' || type === 'date');

// `exclude` keeps the period column from becoming its own measure: a dataset
// starting with `year` would otherwise measure change of year over year.
const resolveMeasure = (recipe: RecipeId, columns: Column[], options: RecipeOptions, exclude?: string): string => {
  if (options.measure !== undefined) {
    const chosen = columns.find(({ name }) => name === options.measure);
    if (!chosen || (chosen.type !== 'integer' && chosen.type !== 'number')) {
      throw new Error(`${recipe}: measure "${options.measure}" is not a numeric column`);
    }
    return chosen.name;
  }
  const first = numericColumns(columns).find(({ name }) => name !== exclude);
  if (!first) throw new Error(`${recipe}: no numeric column to measure`);
  return first.name;
};

const resolveField = (columns: Column[], options: RecipeOptions): string => {
  if (options.field !== undefined) {
    const chosen = columns.find(({ name }) => name === options.field);
    if (!chosen || (chosen.type !== 'text' && chosen.type !== 'boolean')) {
      throw new Error(`distribution: field "${options.field}" is not a categorical column`);
    }
    return chosen.name;
  }
  const first = categoricalColumns(columns)[0];
  if (!first) throw new Error('distribution: no categorical column');
  return first.name;
};

const resolveYearColumn = (recipe: RecipeId, columns: Column[]): string => {
  const year = orderedYearColumn(columns);
  if (!year) throw new Error(`${recipe}: no ordered year column (expected year or fiscal_year as integer or date)`);
  return year.name;
};

const outcome = (
  recipe: RecipeId,
  calculation: string,
  result: unknown,
  outputRows: number,
  warnings: string[] = [],
): RecipeResult => ({ recipe, recipeVersion: RECIPE_VERSION, calculation, result, outputRows, warnings });

export function summarise(rows: Row[], columns: Column[]): RecipeResult {
  const numeric = numericColumns(columns).map((column) => {
    let available = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const row of rows) {
      const value = toNumber(row[column.name]);
      if (value === undefined) continue;
      available += 1;
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }
    if (!available) return { column: column.name, min: null, max: null, mean: null, available: 0 };
    return { column: column.name, min: round2(min), max: round2(max), mean: round2(sum / available), available };
  });
  const categorical = categoricalColumns(columns).map((column) => {
    const values = new Set<string>();
    for (const row of rows) {
      const value = row[column.name];
      if (!isMissing(value)) values.add(String(value));
    }
    return { column: column.name, distinct: values.size };
  });
  const parts = [`Counted ${rows.length} rows`];
  const numericNames = numericColumns(columns).map(({ name }) => name);
  const categoricalNames = categoricalColumns(columns).map(({ name }) => name);
  if (numericNames.length) {
    parts.push(`; computed min, max and mean over ${numericNames.join(', ')} using only parsable values, rounded to 2 decimals`);
  }
  if (categoricalNames.length) {
    parts.push(`; counted distinct non-missing values over ${categoricalNames.join(', ')}`);
  }
  return outcome('summary', `${parts.join('')}.`, { rows: rows.length, numeric, categorical }, 1);
}

export function rank(rows: Row[], columns: Column[], options: RecipeOptions = {}): RecipeResult {
  // A year column is numeric but ranking by it is meaningless, so it is never the
  // default measure; an explicit options.measure still wins.
  const measure = resolveMeasure('rank', columns, options, orderedYearColumn(columns)?.name);
  const top = options.top ?? 20;
  if (!Number.isFinite(top) || top < 0) throw new Error('rank: options.top must be a non-negative number');
  const labelColumn = columns.find(({ type }) => type === 'text');
  const entries: Array<{ label: string; value: number; index: number }> = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const value = toNumber(row[measure]);
    if (value === undefined) {
      skipped += 1;
      return;
    }
    const raw = labelColumn ? row[labelColumn.name] : undefined;
    entries.push({ label: isMissing(raw) ? String(index + 1) : String(raw), value, index });
  });
  entries.sort((a, b) => b.value - a.value || a.index - b.index);
  const ranked = entries.slice(0, top).map((entry, position) => ({
    rank: position + 1,
    label: entry.label,
    value: entry.value,
  }));
  const warnings = skipped
    ? [`rank: skipped ${skipped} ${skipped === 1 ? 'row' : 'rows'} with a missing or non-numeric ${measure} value`]
    : [];
  const labelSource = labelColumn
    ? `first text column ${labelColumn.name} with row-number fallback`
    : 'row number (no text column)';
  const calculation = `Ranked ${ranked.length} of ${rows.length} rows descending by measure ${measure}, keeping the top ${top}; label from ${labelSource}; ties keep the same value and receive sequential ranks in input order.`;
  return outcome('rank', calculation, ranked, ranked.length, warnings);
}

export function distribution(rows: Row[], columns: Column[], options: RecipeOptions = {}): RecipeResult {
  const field = resolveField(columns, options);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = row[field];
    const key = isMissing(raw) ? '(missing)' : String(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = rows.length;
  const groups = [...counts.entries()]
    .map(([value, count]) => ({ value, count, percentage: round2((count * 100) / total) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const calculation = total
    ? `Counted ${total} rows by ${field}, grouped blank or missing values as (missing), percentage = count / ${total} * 100 rounded to 2 decimals.`
    : `Counted 0 rows by ${field}; there are no groups.`;
  return outcome('distribution', calculation, { field, groups }, groups.length);
}

const comparePeriods = (a: string | number | null, b: string | number | null): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

export function changeOverTime(rows: Row[], columns: Column[], options: RecipeOptions = {}): RecipeResult {
  const year = resolveYearColumn('change_over_time', columns);
  const measure = resolveMeasure('change_over_time', columns, options, year);
  const points: Array<{
    period: string | number | null;
    value: number | null;
    changeFromPrevious: number | null;
    percentChangeFromPrevious: number | null;
  }> = [];
  let skipped = 0;
  for (const row of rows) {
    const rawValue = row[measure];
    const numeric = toNumber(rawValue);
    if (numeric === undefined && !isMissing(rawValue)) {
      skipped += 1;
      continue;
    }
    const rawPeriod = row[year];
    const period = isMissing(rawPeriod)
      ? null
      : typeof rawPeriod === 'number' || typeof rawPeriod === 'string'
        ? rawPeriod
        : String(rawPeriod);
    // A known period with no value is a real gap (an MVP-A reenacted year, for example),
    // so it stays as a null point; only a row with no period is different information.
    points.push({ period, value: numeric ?? null, changeFromPrevious: null, percentChangeFromPrevious: null });
  }
  points.sort((a, b) => comparePeriods(a.period, b.period));
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous.period === null || current.period === null || previous.value === null || current.value === null) {
      continue;
    }
    const change = current.value - previous.value;
    current.changeFromPrevious = round2(change);
    current.percentChangeFromPrevious = previous.value === 0 ? null : round2((change / Math.abs(previous.value)) * 100);
  }
  const warnings = skipped
    ? [`change_over_time: skipped ${skipped} ${skipped === 1 ? 'row' : 'rows'} with non-numeric ${measure}`]
    : [];
  const calculation = `Sorted ${points.length} points by ${year} ascending; per point, change = ${measure} minus the previous point's ${measure} and percent change = change / |previous| * 100 against the previous point in the sorted series; missing values yield null, never 0, rows without ${year} keep a null period, rows with non-numeric ${measure} are skipped.`;
  return outcome('change_over_time', calculation, points, points.length, warnings);
}

export function compare(rows: Row[], columns: Column[], options: RecipeOptions): RecipeResult {
  const { periodA, periodB } = options;
  if (periodA === undefined || periodB === undefined) {
    throw new Error('compare: options.periodA and options.periodB are required');
  }
  const year = resolveYearColumn('compare', columns);
  const measure = resolveMeasure('compare', columns, options, year);
  const warnings: string[] = [];
  const valueFor = (period: string | number): number | null => {
    const key = String(period).trim();
    const match = rows.find((row) => {
      const raw = row[year];
      return !isMissing(raw) && String(raw).trim() === key;
    });
    if (!match) {
      warnings.push(`compare: no rows for period ${period}`);
      return null;
    }
    const value = toNumber(match[measure]);
    if (value === undefined) {
      warnings.push(`compare: no ${measure} value for period ${period}`);
      return null;
    }
    return value;
  };
  const valueA = valueFor(periodA);
  const valueB = valueFor(periodB);
  let difference: number | null = null;
  let percentChange: number | null = null;
  if (valueA !== null && valueB !== null) {
    const raw = valueB - valueA;
    difference = round2(raw);
    percentChange = valueA === 0 ? null : round2((raw / Math.abs(valueA)) * 100);
  }
  const calculation = `Compared ${measure} for period ${periodA} against period ${periodB} over year column ${year} (first matching row per period): difference = periodB - periodA and percent change = difference / |periodA| * 100, null when either side has no value.`;
  return outcome(
    'compare',
    calculation,
    { periodA, periodB, valueA, valueB, difference, percentChange },
    1,
    warnings,
  );
}

export function runRecipe(
  recipe: RecipeId,
  rows: Row[],
  columns: Column[],
  options: RecipeOptions = {},
): RecipeResult {
  switch (recipe) {
    case 'summary':
      return summarise(rows, columns);
    case 'rank':
      return rank(rows, columns, options);
    case 'distribution':
      return distribution(rows, columns, options);
    case 'change_over_time':
      return changeOverTime(rows, columns, options);
    case 'compare':
      return compare(rows, columns, options);
    default:
      throw new Error(`unknown recipe: ${String(recipe)}`);
  }
}

export function runAllApplicable(
  selection: Selection,
  rows: Row[],
  columns: Column[],
  options: RecipeOptions = {},
): RecipeRun {
  const results: RecipeResult[] = [];
  // Selection skips keep their order (S5); an applicable recipe that fails its
  // data requirements lands here too, so a run never crashes without a reason (S7).
  const skipped: Selection['skipped'] = [...selection.skipped];
  for (const id of selection.applicable) {
    try {
      results.push(runRecipe(id as RecipeId, rows, columns, options));
    } catch (error) {
      skipped.push({ recipe: id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, skipped };
}

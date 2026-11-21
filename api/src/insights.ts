export type Column = { name: string; type: 'integer' | 'number' | 'text' | 'date' | 'boolean' };

export type Requirement =
  | { kind: 'numeric'; columns?: number }
  | { kind: 'categorical' }
  | { kind: 'ordered-year' }
  | { kind: 'paired-years' };

export type InsightRecipe = {
  id: 'summary' | 'rank' | 'distribution' | 'change_over_time' | 'compare';
  required: Requirement[];
};

export type Selection = {
  applicable: string[];
  skipped: Array<{ recipe: string; reason: string }>;
};

export const numericColumns = (columns: Column[]): Column[] => {
  // The ordered year column is numeric but is a period, not a measure; leaving it in
  // makes "rank" and "summary" claim to apply to a dataset with nothing to measure.
  const year = orderedYearColumn(columns)?.name;
  return columns.filter(({ name, type }) => (type === 'integer' || type === 'number') && name !== year);
};

export const categoricalColumns = (columns: Column[]): Column[] =>
  columns.filter(({ type }) => type === 'text' || type === 'boolean');

const yearCandidates = (columns: Column[]): Column[] =>
  columns.filter(({ name }) => /^(year|fiscal_year)$/i.test(name.trim()));

export const orderedYearColumn = (columns: Column[]): Column | undefined =>
  yearCandidates(columns).find(({ type }) => type === 'integer' || type === 'date');

// The recipe list is the selection policy: no model chooses the analysis (S5).
const recipes: InsightRecipe[] = [
  { id: 'summary', required: [{ kind: 'numeric' }] },
  { id: 'rank', required: [{ kind: 'numeric' }] },
  { id: 'distribution', required: [{ kind: 'categorical' }] },
  { id: 'change_over_time', required: [{ kind: 'numeric' }, { kind: 'ordered-year' }] },
  { id: 'compare', required: [{ kind: 'numeric' }, { kind: 'ordered-year' }] },
];

function requirementFailure(recipe: InsightRecipe['id'], requirement: Requirement, columns: Column[]): string | undefined {
  switch (requirement.kind) {
    case 'numeric': {
      const needed = requirement.columns ?? 1;
      if (numericColumns(columns).length >= needed) return undefined;
      if (needed === 1) return recipe === 'rank' ? 'no numeric column to rank' : 'no numeric column';
      return `fewer than ${needed} numeric columns`;
    }
    case 'categorical':
      return categoricalColumns(columns).length ? undefined : 'no categorical column';
    case 'ordered-year': {
      if (orderedYearColumn(columns)) return undefined;
      const named = yearCandidates(columns)[0];
      return named
        ? `the ${named.name} column is ${named.type}, not an integer or date year column`
        : 'no ordered year column';
    }
    case 'paired-years':
      // Requires row values rather than a schema; no recipe asks for it yet.
      return undefined;
  }
}

export function selectInsights(columns: Column[]): Selection {
  const selection: Selection = { applicable: [], skipped: [] };
  for (const recipe of recipes) {
    if (recipe.id === 'summary') {
      // A categorical-only table still supports a status summary.
      if (numericColumns(columns).length || categoricalColumns(columns).length) selection.applicable.push(recipe.id);
      else selection.skipped.push({ recipe: recipe.id, reason: 'no numeric or categorical column' });
      continue;
    }
    const reasons = recipe.required
      .map((requirement) => requirementFailure(recipe.id, requirement, columns))
      .filter((reason): reason is string => reason !== undefined);
    if (reasons.length) selection.skipped.push({ recipe: recipe.id, reason: reasons.length === 1 ? reasons[0]! : `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}` });
    else selection.applicable.push(recipe.id);
  }
  return selection;
}

export function describeSelection(selection: Selection): string {
  const total = selection.applicable.length + selection.skipped.length;
  const headline = `${selection.applicable.length} of ${total} recipes apply`;
  if (!selection.skipped.length) return headline;
  const skips = selection.skipped.map(({ recipe, reason }) => `${recipe.replaceAll('_', ' ')} skipped: ${reason}`);
  return `${headline}; ${skips.join('; ')}`;
}

export function zeroResultMessage(input: {
  datasetName: string;
  filters: Record<string, unknown>;
  matchedRows: number;
}): string | undefined {
  if (input.matchedRows !== 0) return undefined;
  const entries = Object.entries(input.filters);
  const format = (value: unknown) => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  const filters = entries.length
    ? entries.map(([name, value]) => `${name}=${format(value)}`).join(', ')
    : 'no filters applied';
  const nextStep = entries.length ? `clear the ${entries[0][0]} filter` : 'try a different dataset';
  return `No rows in ${input.datasetName} matched ${filters}. Next step: ${nextStep}.`;
}

export function runSummary(insights: Array<{ id: string; status: 'ok' | 'failed' }>): {
  total: number;
  ok: number;
  failed: number;
  sentence: string;
} {
  const ok = insights.filter((insight) => insight.status === 'ok').length;
  const failed = insights.length - ok;
  const plural = (count: number) => `${count} insight${count === 1 ? '' : 's'}`;
  const produced = `${plural(ok)} ${ok === 1 ? 'was' : 'were'} produced`;
  const sentence = failed
    ? `${produced}; ${plural(failed)} failed and ${failed === 1 ? 'is' : 'are'} listed with ${failed === 1 ? 'its' : 'their'} reason.`
    : `${produced}.`;
  return { total: insights.length, ok, failed, sentence };
}

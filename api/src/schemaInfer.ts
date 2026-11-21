export type ColumnType = 'integer' | 'number' | 'text' | 'date' | 'boolean';
export type InferredColumn = { name: string; type: ColumnType; confidence: 'high' | 'low'; reason: string };
export type InferredSchema = { columns: InferredColumn[] };

const isoDate = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

// The type one value supports; anything unrecognised is text, never a guess.
const kindOf = (value: unknown): ColumnType => {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return !Number.isFinite(value) ? 'text' : Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value !== 'string') return 'text';
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return 'boolean';
  if (isoDate.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) return 'date';
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number.isInteger(Number(trimmed)) ? 'integer' : 'number';
  return 'text';
};

const nonEmpty = (value: unknown) => value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');

function inferColumn(name: string, values: unknown[]): InferredColumn {
  const samples = values.filter(nonEmpty);
  const low = (reason: string): InferredColumn => ({ name, type: 'text', confidence: 'low', reason });
  // A column with too few samples cannot carry a typed claim (S9).
  if (!samples.length) return low('no non-empty samples in the sample');
  if (samples.length < 10) return low(`only ${samples.length} non-empty samples, fewer than 10`);
  const kinds = new Set(samples.map(kindOf));
  if (kinds.size === 1) {
    const [kind] = [...kinds];
    return { name, type: kind, confidence: 'high', reason: `every sampled value is ${kind === 'text' ? 'text' : kind}` };
  }
  if (kinds.size === 2 && kinds.has('integer') && kinds.has('number')) {
    return { name, type: 'number', confidence: 'high', reason: 'every sampled value is numeric and some are fractional' };
  }
  return low(`conflicting values (${[...kinds].join(', ')}) force text`);
}

export function inferSchema(rows: Array<Record<string, unknown>>, sampleSize = 200): InferredSchema {
  const sample = rows.slice(0, Math.max(0, Math.trunc(sampleSize)));
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of sample) for (const name of Object.keys(row)) {
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return { columns: names.map((name) => inferColumn(name, sample.map((row) => row[name]))) };
}

export function describeSchema(schema: InferredSchema): string {
  const count = schema.columns.length;
  const plural = count === 1 ? '' : 's';
  if (!count) return 'The sample has no columns.';
  const low = schema.columns.filter((column) => column.confidence === 'low').map((column) => column.name);
  if (!low.length) return `The sample has ${count} column${plural}, all inferred with high confidence.`;
  return `The sample has ${count} column${plural}; ${low.length} low-confidence column${low.length === 1 ? '' : 's'} stored as text: ${low.join(', ')}.`;
}

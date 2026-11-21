import type { Evidence } from './store.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);

// A tabular result is either a list of records or a distribution's groups.
const tabularRows = (result: unknown): Row[] | undefined => {
  const rows = Array.isArray(result) ? result : isRow(result) ? result.groups : undefined;
  if (!Array.isArray(rows) || !rows.length || !rows.every(isRow)) return undefined;
  return rows;
};

export function rowColumns(result: unknown): string[] | undefined {
  const rows = tabularRows(result);
  if (!rows) return undefined;
  const columns = Object.keys(rows[0]);
  const shape = [...columns].sort().join('\0');
  if (!columns.length || rows.some((row) => [...Object.keys(row)].sort().join('\0') !== shape)) return undefined;
  return columns;
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const validationStatus = (validation: unknown): string => {
  if (typeof validation === 'string') return validation;
  return isRow(validation) && typeof validation.status === 'string' ? validation.status : '';
};

export function toCsv(evidence: Evidence): string {
  const metadata: Array<[string, unknown]> = [
    ['release', evidence.datasetReleaseId],
    ['release_checksum', evidence.releaseChecksum],
    ['recipe', evidence.recipe],
    ['recipe_version', evidence.recipeVersion],
    ['filters', evidence.filters],
    ['input_rows', evidence.inputRows],
    ['output_rows', evidence.outputRows],
    ['validation_status', validationStatus(evidence.validation)],
    ['reproducibility', evidence.reproducibilityStatus],
  ];
  const lines = metadata.map(([key, value]) => `${key},${cell(value)}`);
  const rows = tabularRows(evidence.result);
  const columns = rows && rowColumns(evidence.result);
  if (rows && columns) {
    lines.push('', columns.map(cell).join(','));
    for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function csvFilename(evidence: Evidence): string {
  return `evidence-${evidence.recipe}-${evidence.datasetReleaseId}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.csv';
}

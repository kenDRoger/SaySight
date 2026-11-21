// Pure E2 execution over the planner's plan. No storage, no HTTP, no worker.
import { diagnoseJoin, type Column, type JoinDiagnostics, type JoinPlan } from './joinPlan.js';

export type JoinedRows = { rows: Array<Record<string, unknown>>; diagnostics: JoinDiagnostics };

// Keys are absent when null, undefined or blank, and are compared as strings so
// 1 and '1' meet exactly as they do in the planner.
const keyOf = (row: Record<string, unknown>, key: string): string | undefined => {
  const value = row[key];
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  return String(value);
};

export function executeJoin(plan: JoinPlan, leftRows: Array<Record<string, unknown>>, rightRows: Array<Record<string, unknown>>): JoinedRows {
  const rightByKey = new Map<string, Record<string, unknown>>();
  const duplicateKeys = new Set<string>();
  for (const row of rightRows) {
    const key = keyOf(row, plan.rightKey);
    if (key === undefined) continue;
    if (rightByKey.has(key)) { duplicateKeys.add(key); rightByKey.delete(key); }
    else if (!duplicateKeys.has(key)) rightByKey.set(key, row);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const leftRow of leftRows) {
    const key = keyOf(leftRow, plan.leftKey);
    if (key === undefined || duplicateKeys.has(key)) continue;
    const rightRow = rightByKey.get(key);
    if (!rightRow) continue;
    const joined: Record<string, unknown> = { ...leftRow };
    for (const [name, value] of Object.entries(rightRow)) if (name !== plan.rightKey) joined[`right.${name}`] = value;
    rows.push(joined);
  }

  const diagnostics = diagnoseJoin(plan,
    { label: 'left', grain: '', columns: [], rows: leftRows },
    { label: 'right', grain: '', columns: [], rows: rightRows });
  return { rows, diagnostics };
}

export function limitJoinedRows(rows: Array<Record<string, unknown>>, max = 50_000): { rows: Array<Record<string, unknown>>; truncated: boolean } {
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}

export function joinedSchema(leftColumns: Column[], rightColumns: Column[], key: string): Column[] {
  const columns = new Map<string, Column>();
  for (const column of leftColumns) columns.set(column.name, column);
  for (const column of rightColumns) {
    if (column.name === key) continue;
    columns.set(`right.${column.name}`, { ...column, name: `right.${column.name}` });
  }
  return [...columns.values()];
}

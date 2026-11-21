// Pure run/insight model. Persistence and route wiring belong to other units.
import type { Selection } from './insights.js';

export type RunPlan = { toRun: string[]; skipped: Selection['skipped'] };

export function planRun(input: {
  releaseIds: string[];
  connectorIds: string[];
  filters: Record<string, unknown>;
  selection: Selection;
}): RunPlan {
  return {
    toRun: [...input.selection.applicable],
    skipped: [...input.selection.skipped],
  };
}

export type InsightRecord = {
  runId: string;
  recipe: string;
  releaseId: string;
  recipeVersion: string;
  status: 'ok' | 'failed';
  evidenceId: string | null;
  reason: string;
};

export function insightRecord(input: {
  runId: string;
  recipe: string;
  releaseId: string;
  recipeVersion: string;
  status: 'ok' | 'failed';
  evidenceId?: string;
  reason?: string;
}): InsightRecord {
  if (input.status === 'ok' && !input.evidenceId?.trim()) throw new Error('insight_ok_requires_evidence');
  if (input.status === 'failed' && !input.reason?.trim()) throw new Error('insight_failed_requires_reason');
  return {
    runId: input.runId,
    recipe: input.recipe,
    releaseId: input.releaseId,
    recipeVersion: input.recipeVersion,
    status: input.status,
    evidenceId: input.evidenceId ?? null,
    reason: input.reason ?? '',
  };
}

export type InsightStatusRow = { status: 'ok' | 'failed' | 'skipped' };
export type RunSummary = { total: number; ok: number; failed: number; skipped: number; sentence: string };

export function runSummaryFor(records: InsightStatusRow[]): RunSummary {
  const ok = records.filter((record) => record.status === 'ok').length;
  const failed = records.filter((record) => record.status === 'failed').length;
  const skipped = records.filter((record) => record.status === 'skipped').length;
  const plural = (count: number) => `${count} insight${count === 1 ? '' : 's'}`;
  const parts = [`${plural(ok)} ${ok === 1 ? 'was' : 'were'} produced`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'was' : 'were'} skipped`);
  const sentence = parts.length === 1 ? `${parts[0]}.`
    : parts.length === 2 ? `${parts[0]} and ${parts[1]}.`
      : `${parts[0]}, ${parts[1]}, and ${parts[2]}.`;
  return { total: records.length, ok, failed, skipped, sentence };
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { DatasetRelease } from './catalog.js';

export type Evidence = {
  id: string;
  datasetReleaseId: string;
  recipe: string;
  recipeVersion: string;
  filters: Record<string, unknown>;
  result: unknown;
  inputRows: number;
  outputRows: number;
  releaseChecksum: string;
  calculation: string;
  validation: unknown;
  warnings: string[];
  limitations: string[];
  reproducibilityStatus: string;
  createdAt: string;
};

// Accounts require durable storage, so the pool is shared with the auth layer.
export const pool: Pool | undefined = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;
const memory = new Map<string, Evidence>();
type Finding = { id: string; evidenceId: string; status: string; submittedBy: string | null; createdAt: string };
const findings = new Map<string, Finding>();
const draftReleases = new Map<string, { id: string; name: string; filename: string; checksum: string; status: 'draft'; createdAt: string }>();

export async function registerDraftRelease(name: string, filename: string, data: Buffer): Promise<{ id: string; name: string; filename: string; checksum: string; status: 'draft'; createdAt: string }> {
  const id = `draft-${randomUUID()}`;
  const checksum = createHash('sha256').update(data).digest('hex');
  const createdAt = new Date().toISOString();
  await mkdir(join(process.cwd(), 'data', 'uploads'), { recursive: true });
  await writeFile(join(process.cwd(), 'data', 'uploads', `${id}-${filename}`), data, { flag: 'wx' });
  const release = { id, name, filename, checksum, status: 'draft' as const, createdAt };
  draftReleases.set(id, release);
  if (pool) await pool.query(
    `INSERT INTO dataset_releases (id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, name, 'User upload', 'local-upload', id, checksum, 'license not confirmed', 'possibly_stale', JSON.stringify({ filename, visibility: 'private-draft' })],
  );
  return release;
}

export function listDraftReleases() { return [...draftReleases.values()]; }

export type NormalizedCoverage = { year: number; status: string; rows: number; amount_pesos: number | null; scopes: Record<string, unknown>; notes: string[] };

export async function getCatalogReleases(): Promise<DatasetRelease[] | undefined> {
  if (!pool) return undefined;
  const result = await pool.query('SELECT id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata FROM dataset_releases ORDER BY name');
  return result.rows.map((row) => ({ id: row.id, name: row.name, publisher: row.publisher, sourceUrl: row.source_url,
    releaseId: row.release_id, checksum: row.checksum, reuseTerms: row.reuse_terms, status: row.status,
    coverage: row.metadata.coverage, fields: row.metadata.fields, limitations: row.metadata.limitations }));
}

export async function getNormalizedCoverage(releaseId: string): Promise<NormalizedCoverage[] | undefined> {
  if (!pool) return undefined;
  const result = await pool.query(
    `SELECT fiscal_year, coverage_status, source_row_count, amount_pesos, scopes, notes
     FROM coverage_records WHERE dataset_release_id = $1 ORDER BY fiscal_year`,
    [releaseId],
  );
  return result.rows.map((row) => ({ year: row.fiscal_year, status: row.coverage_status, rows: row.source_row_count,
    amount_pesos: row.amount_pesos === null ? null : Number(row.amount_pesos), scopes: row.scopes ?? {}, notes: row.notes ?? [] }));
}

export async function saveNormalizedCoverage(rows: Array<{ DatasetReleaseID: string; FiscalYear: number; CoverageStatus: string; SourceRowCount: number; AmountPesos?: number; Scopes?: Record<string, unknown>; Notes: string[] }>, release: DatasetRelease): Promise<number> {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO dataset_releases (id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [release.id, release.name, release.publisher, release.sourceUrl, release.releaseId, release.checksum, release.reuseTerms, release.status,
          JSON.stringify({ coverage: release.coverage, fields: release.fields, limitations: release.limitations })],
      );
      for (const row of rows) await client.query(
        `INSERT INTO coverage_records (dataset_release_id, fiscal_year, coverage_status, source_row_count, amount_pesos, scopes, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dataset_release_id, fiscal_year) DO NOTHING`,
        [row.DatasetReleaseID, row.FiscalYear, row.CoverageStatus, row.SourceRowCount, row.AmountPesos ?? null, JSON.stringify(row.Scopes ?? {}), JSON.stringify(row.Notes)],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return rows.length;
}

export async function saveEvidence(input: Omit<Evidence, 'id' | 'createdAt'>): Promise<Evidence> {
  const evidence: Evidence = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  memory.set(evidence.id, evidence);
  if (pool) {
    await pool.query(
      `INSERT INTO analysis_runs (id, dataset_release_id, recipe, recipe_version, filters, result, validation, reproducibility_status, input_rows, output_rows, release_checksum, calculation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      
      [evidence.id, evidence.datasetReleaseId, evidence.recipe, evidence.recipeVersion, JSON.stringify(evidence.filters), JSON.stringify(evidence.result),
        JSON.stringify({ validation: evidence.validation, warnings: evidence.warnings, limitations: evidence.limitations }), evidence.reproducibilityStatus,
        evidence.inputRows, evidence.outputRows, evidence.releaseChecksum, evidence.calculation],
    );
  }
  return evidence;
}

export async function createFinding(evidenceId: string, submittedBy: string): Promise<Finding> {
  const finding: Finding = { id: randomUUID(), evidenceId, status: 'Unverified', submittedBy, createdAt: new Date().toISOString() };
  findings.set(finding.id, finding);
  if (pool) await pool.query('INSERT INTO findings (id, analysis_run_id, status, submitted_by) VALUES ($1, $2, $3, $4)', [finding.id, evidenceId, finding.status, submittedBy]);
  return finding;
}

export async function getFinding(id: string): Promise<Finding | undefined> {
  if (findings.has(id)) return findings.get(id);
  if (!pool) return undefined;
  const result = await pool.query('SELECT id, analysis_run_id, status, submitted_by, created_at FROM findings WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? { id: row.id, evidenceId: row.analysis_run_id, status: row.status, submittedBy: row.submitted_by, createdAt: row.created_at.toISOString() } : undefined;
}

export async function getEvidence(id: string): Promise<Evidence | undefined> {
  if (memory.has(id)) return memory.get(id);
  if (!pool) return undefined;
  const result = await pool.query('SELECT * FROM analysis_runs WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id, datasetReleaseId: row.dataset_release_id, recipe: row.recipe,
    recipeVersion: row.recipe_version, filters: row.filters, result: row.result,
    inputRows: row.input_rows, outputRows: row.output_rows, releaseChecksum: row.release_checksum, calculation: row.calculation,
    validation: row.validation?.validation ?? { status: 'Not run', checks: [] }, warnings: row.validation?.warnings ?? [], limitations: row.validation?.limitations ?? [],
    reproducibilityStatus: row.reproducibility_status, createdAt: row.created_at.toISOString(),
  };
}

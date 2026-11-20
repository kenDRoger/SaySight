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

export type Comment = { id: string; findingId: string; authorId: string; body: string; status: 'visible' | 'removed'; createdAt: string; removalReason: string | null };

export async function createComment(input: { findingId: string; authorId: string; body: string }): Promise<Comment> {
  if (!pool) throw new Error('database_required');
  const comment: Comment = { id: randomUUID(), ...input, status: 'visible', createdAt: new Date().toISOString(), removalReason: null };
  await pool.query('INSERT INTO comments (id, finding_id, author_id, body) VALUES ($1, $2, $3, $4)',
    [comment.id, comment.findingId, comment.authorId, comment.body]);
  return comment;
}

// Removed comments stay in the list with their text dropped, so the thread keeps its
// shape and the removal reason is public.
export async function listComments(findingId: string): Promise<Comment[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT c.id, c.finding_id, c.author_id, c.body, c.status, c.created_at,
            (SELECT m.reason FROM comment_moderation m WHERE m.comment_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS removal_reason
     FROM comments c WHERE c.finding_id = $1 ORDER BY c.created_at`,
    [findingId],
  );
  return result.rows.map((row) => ({ id: row.id, findingId: row.finding_id, authorId: row.author_id,
    body: row.status === 'removed' ? '' : row.body, status: row.status, createdAt: row.created_at.toISOString(),
    removalReason: row.removal_reason ?? null }));
}

export async function getComment(id: string): Promise<{ id: string; status: 'visible' | 'removed' } | undefined> {
  if (!pool) return undefined;
  const result = await pool.query('SELECT id, status FROM comments WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status } : undefined;
}

export async function removeComment(input: { commentId: string; actorId: string; reason: string }): Promise<void> {
  if (!pool) throw new Error('database_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query("UPDATE comments SET status = 'removed' WHERE id = $1 AND status = 'visible' RETURNING id", [input.commentId]);
    if (!updated.rows[0]) {
      const exists = await client.query('SELECT 1 FROM comments WHERE id = $1', [input.commentId]);
      throw new Error(exists.rows[0] ? 'comment_already_removed' : 'comment_not_found');
    }
    await client.query('INSERT INTO comment_moderation (id, comment_id, actor_id, reason) VALUES ($1, $2, $3, $4)',
      [randomUUID(), input.commentId, input.actorId, input.reason]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export type FindingTransition = { id: string; findingId: string; fromStatus: string; toStatus: string; actorId: string; reason: string; createdAt: string };

export async function recordTransition(input: { findingId: string; fromStatus: string; toStatus: string; actorId: string; reason: string }): Promise<FindingTransition> {
  const transition: FindingTransition = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
  if (!pool) throw new Error('database_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO finding_transitions (id, finding_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5, $6)',
      [transition.id, transition.findingId, transition.fromStatus, transition.toStatus, transition.actorId, transition.reason]);
    await client.query('UPDATE findings SET status = $2 WHERE id = $1', [transition.findingId, transition.toStatus]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return transition;
}

export async function listTransitions(findingId: string): Promise<FindingTransition[]> {
  if (!pool) return [];
  const result = await pool.query('SELECT id, finding_id, from_status, to_status, actor_id, reason, created_at FROM finding_transitions WHERE finding_id = $1 ORDER BY created_at', [findingId]);
  return result.rows.map((row) => ({ id: row.id, findingId: row.finding_id, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, reason: row.reason, createdAt: row.created_at.toISOString() }));
}

// The queue is what a reviewer can act on now: findings waiting for review, oldest
// first, with the author so self-review can be refused.
export async function listReviewQueue(statuses: string[]): Promise<Array<Finding & { authorRole: string | null; authorEmail: string | null }>> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT f.id, f.analysis_run_id, f.status, f.submitted_by, f.created_at, u.role AS author_role, u.email AS author_email
     FROM findings f LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.status = ANY($1) ORDER BY f.created_at`,
    [statuses],
  );
  return result.rows.map((row) => ({ id: row.id, evidenceId: row.analysis_run_id, status: row.status, submittedBy: row.submitted_by,
    createdAt: row.created_at.toISOString(), authorRole: row.author_role ?? null, authorEmail: row.author_email ?? null }));
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

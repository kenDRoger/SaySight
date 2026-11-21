import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { catalog, type DatasetRelease } from './catalog.js';
import type { CheckStatus, DriftReport, ReleaseFingerprint } from './refresh.js';
import type { LicenceStatus } from './pin.js';

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
type Finding = { id: string; evidenceId: string; status: string; impact: string; claim: string | null; submittedBy: string | null; createdAt: string };
const findings = new Map<string, Finding>();
const draftReleases = new Map<string, { id: string; name: string; filename: string; checksum: string; status: DraftStatus; createdAt: string }>();

type DraftStatus = 'private-draft' | 'validated' | 'quarantined' | 'published';
type DraftOptions = {
  submittedBy?: string;
  format: string;
  rows: number;
  validationStatus: 'Pass' | 'Fail';
  checks: string[];
  quarantineReason?: string;
};

export async function registerDraftRelease(name: string, filename: string, data: Buffer, options: DraftOptions): Promise<{ id: string; name: string; filename: string; checksum: string; status: DraftStatus; createdAt: string }> {
  const draftId = randomUUID();
  // Public draft IDs keep the MVP-A `draft-<uuid>` shape; import tables use a
  // real UUID so their foreign keys stay typed.
  const id = `draft-${draftId}`;
  const checksum = createHash('sha256').update(data).digest('hex');
  const createdAt = new Date().toISOString();
  const status: DraftStatus = options.quarantineReason ? 'quarantined' : options.validationStatus === 'Pass' ? 'validated' : 'private-draft';
  await mkdir(join(process.cwd(), 'data', 'uploads'), { recursive: true });
  await writeFile(join(process.cwd(), 'data', 'uploads', `${id}-${filename}`), data, { flag: 'wx' });
  const release = { id, name, filename, checksum, status, createdAt };
  draftReleases.set(id, release);
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO dataset_releases (id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, name, 'User upload', 'local-upload', id, checksum, 'license not confirmed', 'possibly_stale', JSON.stringify({ filename, visibility: 'private-draft' })],
      );
      await client.query(
        `INSERT INTO import_drafts (id, name, filename, checksum, bytes, format, status, submitted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [draftId, name, filename, checksum, data.length, options.format, status, options.submittedBy ?? null],
      );
      await client.query(
        `INSERT INTO import_validations (id, draft_id, status, checks, row_count) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), draftId, options.validationStatus, JSON.stringify(options.checks), options.rows],
      );
      if (options.quarantineReason) await client.query('INSERT INTO quarantine_records (id, draft_id, reason) VALUES ($1, $2, $3)',
        [randomUUID(), draftId, options.quarantineReason]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return release;
}

export function listDraftReleases() { return [...draftReleases.values()]; }
export async function saveImportRows(publicId: string, offset: number, rows: Array<Record<string, unknown>>): Promise<number> {
  if (!pool) return 0;
  if (!rows.length) return 0;
  const draftId = publicId.startsWith('draft-') ? publicId.slice('draft-'.length) : publicId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params: unknown[] = [draftId];
    const tuples = rows.map((_, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3}::jsonb)`);
    rows.forEach((row, index) => params.push(offset + index + 1, JSON.stringify(row)));
    await client.query(`INSERT INTO import_rows (draft_id, row_number, data) VALUES ${tuples.join(', ')}`, params);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return rows.length;
}

export type ImportDraft = { id: string; publicId: string; status: DraftStatus; checksum: string; name: string };

export async function getImportDraft(publicId: string): Promise<ImportDraft | undefined> {
  if (!pool) return undefined;
  const uuid = publicId.startsWith('draft-') ? publicId.slice('draft-'.length) : publicId;
  const result = await pool.query('SELECT id, status, checksum, name FROM import_drafts WHERE id = $1', [uuid]);
  const row = result.rows[0];
  return row ? { id: uuid, publicId: `draft-${uuid}`, status: row.status, checksum: row.checksum, name: row.name } : undefined;
}

// Publication is a maintainer decision and creates a new release; it never edits
// an existing release, which stays append-only.
export async function publishImportDraft(input: {
  publicId: string; actorId: string; reason: string;
  metadata: { publisher: string; sourceUrl: string; license: string; coverage: unknown; fields: unknown; limitations: unknown };
}): Promise<{ draft: ImportDraft; releaseId: string }> {
  if (!pool) throw new Error('database_required');
  const draft = await getImportDraft(input.publicId);
  if (!draft) throw new Error('draft_not_found');
  if (draft.status === 'published') throw new Error('already_published');
  if (draft.status !== 'validated') throw new Error('draft_not_validated');
  const releaseId = `release-${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO publication_decisions (id, draft_id, actor_id, action, reason) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), draft.id, input.actorId, 'publish', input.reason]);
    // The declared field types are the schema a reader and the recipes rely on; without
    // it every insight skips the release as "no numeric or categorical column". A stated
    // licence is a confirmation, so it is recorded as such rather than "unconfirmed".
    const columns = Array.isArray(input.metadata.fields)
      ? (input.metadata.fields as Array<{ name?: unknown; type?: unknown }>)
        .filter((field) => typeof field.name === 'string' && field.name.length > 0)
        .map((field) => ({ name: String(field.name), type: typeof field.type === 'string' && field.type ? field.type : 'text' }))
      : [];
    const licence = typeof input.metadata.license === 'string' ? input.metadata.license.trim() : '';
    await client.query(
      `INSERT INTO dataset_releases (id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata, licence_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [releaseId, draft.name, input.metadata.publisher, input.metadata.sourceUrl, releaseId, draft.checksum, input.metadata.license, 'current',
        JSON.stringify({ ...input.metadata, schema: { columns }, publishedFrom: draft.publicId }),
        licence ? 'confirmed' : 'unconfirmed'],
    );
    // A published upload must be analysable. The validated rows live in import_rows, so
    // they are copied into the analysis table here; otherwise the release appears in the
    // catalog with nothing to run on and every insight refuses it.
    await client.query(
      `INSERT INTO release_rows (release_id, row_number, data)
       SELECT $1, r.row_number, r.data FROM import_rows r WHERE r.draft_id = $2
       ON CONFLICT (release_id, row_number) DO NOTHING`,
      [releaseId, draft.id],
    );
    // A CSV arrives with every value as text; the declared types are what make a column
    // analysable, so numeric columns are cast here rather than left as strings.
    for (const column of columns) {
      if (column.type !== 'integer' && column.type !== 'number') continue;
      await client.query(
        `UPDATE release_rows SET data = jsonb_set(data, ARRAY[$2::text], to_jsonb((data->>$2)::numeric), false)
         WHERE release_id = $1 AND data ? $2 AND (data->>$2) ~ '^-?[0-9]+(\.[0-9]+)?$'`,
        [releaseId, column.name],
      );
    }
    await client.query("UPDATE import_drafts SET status = 'published' WHERE id = $1", [draft.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { draft: { ...draft, status: 'published' }, releaseId };
}



export type NormalizedCoverage = { year: number; status: string; rows: number; amount_pesos: number | null; scopes: Record<string, unknown>; notes: string[] };

export async function getCatalogReleases(): Promise<DatasetRelease[] | undefined> {
  if (!pool) return undefined;
  // Private drafts are workflow state, not catalog entries.
  const result = await pool.query(`SELECT id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata, agency_id, region, last_checked_at, source_published_at, source_updated_at, freshness_status, attribution, licence_status, connector_id,
            (SELECT count(*)::int FROM release_rows r WHERE r.release_id = dataset_releases.id) AS row_count
     FROM dataset_releases
     WHERE COALESCE(metadata->>'visibility', '') <> 'private-draft'
     ORDER BY name`);
  return result.rows.map((row) => {
    const verified = catalog.find((item) => item.id === row.id);
    return { id: row.id, name: row.name, publisher: row.publisher, sourceUrl: row.source_url,
    releaseId: row.release_id, checksum: row.checksum, reuseTerms: row.reuse_terms, status: row.status,
    coverage: row.metadata.coverage ?? { fiscalYears: [] },
    fields: row.metadata.fields ?? [],
    limitations: row.metadata.limitations ?? [],
    agencyId: row.agency_id || row.metadata.agencyId || verified?.agencyId || null,
    region: row.region || row.metadata.region || verified?.region || null,
    lastCheckedAt: (row.last_checked_at ?? row.metadata.lastCheckedAt)?.toISOString?.() ?? row.metadata.lastCheckedAt ?? verified?.lastCheckedAt ?? null,
    sourcePublishedAt: (row.source_published_at ?? row.metadata.sourcePublishedAt)?.toISOString?.() ?? row.metadata.sourcePublishedAt ?? verified?.sourcePublishedAt ?? null,
    sourceUpdatedAt: (row.source_updated_at ?? row.metadata.sourceUpdatedAt)?.toISOString?.() ?? row.metadata.sourceUpdatedAt ?? verified?.sourceUpdatedAt ?? null,
    freshnessStatus: (row.freshness_status !== 'unknown' && row.freshness_status) || row.metadata.freshnessStatus || verified?.freshnessStatus || 'unknown',
    // A reader must be able to see the licence state before using a dataset (S10a),
    // and the UI needs the stored schema to offer join keys.
    licenceStatus: row.licence_status ?? 'unconfirmed',
    attribution: row.attribution || verified?.publisher || '',
    connectorId: row.connector_id ?? null,
    // Insights and joins read release_rows, so a reader must see which releases have
    // none before choosing one that cannot run.
    rowCount: row.row_count ?? 0,
    schema: row.metadata.schema ?? null };
  });
}

export async function listAgencies(): Promise<Array<{ id: string; name: string; website: string }>> {
  if (!pool) return [{ id: 'bettergov', name: 'BetterGovPH', website: 'https://data.bettergov.ph' }];
  const result = await pool.query('SELECT id, name, website FROM agencies ORDER BY name');
  return result.rows;
}

export async function datasetReleaseExists(id: string): Promise<boolean> {
  if (!pool) return catalog.some((item) => item.id === id);
  const result = await pool.query('SELECT 1 FROM dataset_releases WHERE id = $1', [id]);
  return result.rows.length > 0;
}

type ReleaseRowPage = { offset: number; rows: Array<Record<string, unknown>> };

const writeReleaseRows = async (client: PoolClient, releaseId: string, offset: number, rows: Array<Record<string, unknown>>): Promise<number> => {
  if (!rows.length) return 0;
  const params: unknown[] = [releaseId];
  const tuples = rows.map((_, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3}::jsonb)`);
  rows.forEach((row, index) => params.push(offset + index + 1, JSON.stringify(row)));
  await client.query(`INSERT INTO release_rows (release_id, row_number, data) VALUES ${tuples.join(', ')}`, params);
  return rows.length;
};

// Derived input can be re-imported; the pinned bytes and release stay immutable.
export async function saveReleaseRows(releaseId: string, offset: number, rows: Array<Record<string, unknown>>): Promise<number> {
  if (!pool || !rows.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await writeReleaseRows(client, releaseId, offset, rows);
    await client.query('COMMIT');
    return saved;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

// A pinned release is a new row: a fetch-on-demand snapshot is never edited.
export async function findPinnedRelease(connectorId: string, datasetId: string, checksum: string): Promise<string | undefined> {
  if (!pool) return undefined;
  const result = await pool.query(
    'SELECT id FROM dataset_releases WHERE connector_id = $1 AND source_dataset_id = $2 AND checksum = $3 ORDER BY created_at LIMIT 1',
    [connectorId, datasetId, checksum],
  );
  return result.rows[0]?.id as string | undefined;
}

export async function insertPinnedRelease(input: {
  connectorId: string; datasetId: string; checksum: string; licenceStatus: LicenceStatus;
  licence?: string; attribution: string; name: string; sourceUrl: string; metadata: Record<string, unknown>;
  rows?: ReleaseRowPage[];
}): Promise<string> {
  if (!pool) throw new Error('database_required');
  const id = `release-${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Rows reference a release that is not yet visible; the FK is deferred to
    // this transaction's commit, so readers never see a half-pinned release.
    for (const page of input.rows ?? []) await writeReleaseRows(client, id, page.offset, page.rows);
    await client.query(
      `INSERT INTO dataset_releases (id, name, publisher, source_url, release_id, checksum, reuse_terms, status, metadata,
        connector_id, source_dataset_id, attribution, licence_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, input.name, input.attribution, input.sourceUrl, id, input.checksum, input.licence ?? '', 'current', JSON.stringify(input.metadata),
        input.connectorId, input.datasetId, input.attribution, input.licenceStatus],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return id;
}

export async function getReleaseRows(releaseId: string, limit?: number): Promise<Array<Record<string, unknown>>> {
  if (!pool) return [];
  const bounded = limit !== undefined && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : undefined;
  const result = await pool.query(
    `SELECT data FROM release_rows WHERE release_id = $1 ORDER BY row_number${bounded === undefined ? '' : ' LIMIT $2'}`,
    bounded === undefined ? [releaseId] : [releaseId, bounded],
  );
  return result.rows.map((row) => row.data as Record<string, unknown>);
}

export type RunRecord = { id: string; connectorIds: string[]; releaseIds: string[]; filters: Record<string, unknown>; selection: unknown; createdAt: string };
export type InsightRow = { id: string; runId: string; recipe: string; releaseId: string | null; recipeVersion: string; status: 'ok' | 'failed' | 'skipped'; evidenceId: string | null; reason: string; createdAt: string };

export async function insertRun(input: { connectorIds: string[]; releaseIds: string[]; filters: Record<string, unknown>; selection: unknown }): Promise<string> {
  if (!pool) throw new Error('database_required');
  const id = randomUUID();
  await pool.query('INSERT INTO runs (id, connector_ids, release_ids, filters, selection) VALUES ($1, $2, $3, $4, $5)',
    [id, JSON.stringify(input.connectorIds), JSON.stringify(input.releaseIds), JSON.stringify(input.filters), JSON.stringify(input.selection)]);
  return id;
}

export async function insertInsight(input: { runId: string; recipe: string; releaseId: string; recipeVersion: string; status: 'ok' | 'failed' | 'skipped'; evidenceId?: string | null; reason?: string }): Promise<string> {
  if (!pool) throw new Error('database_required');
  const id = randomUUID();
  await pool.query('INSERT INTO insights (id, run_id, recipe, dataset_release_id, recipe_version, status, evidence_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, input.runId, input.recipe, input.releaseId, input.recipeVersion, input.status, input.evidenceId ?? null, input.reason ?? '']);
  return id;
}

export async function attachInsightEvidence(insightId: string, evidenceId: string): Promise<void> {
  if (!pool) throw new Error('database_required');
  const updated = await pool.query('UPDATE insights SET evidence_id = $2 WHERE id = $1 AND evidence_id IS NULL RETURNING id', [insightId, evidenceId]);
  if (!updated.rows[0]) throw new Error('evidence_already_attached');
}

export async function getRun(id: string): Promise<{ run: RunRecord; insights: InsightRow[] } | undefined> {
  if (!pool) return undefined;
  const runResult = await pool.query('SELECT id, connector_ids, release_ids, filters, selection, created_at FROM runs WHERE id = $1', [id]);
  const row = runResult.rows[0];
  if (!row) return undefined;
  const insightResult = await pool.query('SELECT id, run_id, recipe, dataset_release_id, recipe_version, status, evidence_id, reason, created_at FROM insights WHERE run_id = $1 ORDER BY created_at, recipe', [id]);
  return {
    run: { id: row.id, connectorIds: row.connector_ids, releaseIds: row.release_ids, filters: row.filters, selection: row.selection, createdAt: row.created_at.toISOString() },
    insights: insightResult.rows.map((insight) => ({ id: insight.id, runId: insight.run_id, recipe: insight.recipe,
      releaseId: insight.dataset_release_id, recipeVersion: insight.recipe_version, status: insight.status,
      evidenceId: insight.evidence_id, reason: insight.reason, createdAt: insight.created_at.toISOString() })),
  };
}

export async function countReleaseRows(releaseId: string): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query('SELECT count(*)::int AS total FROM release_rows WHERE release_id = $1', [releaseId]);
  return Number(result.rows[0]?.total ?? 0);
}

export async function getReleaseRowSchema(releaseId: string): Promise<Record<string, unknown> | undefined> {
  if (!pool) return undefined;
  const result = await pool.query("SELECT metadata->'schema' AS schema FROM dataset_releases WHERE id = $1", [releaseId]);
  const schema = result.rows[0]?.schema;
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema as Record<string, unknown> : undefined;
}

export type SavedView = { id: string; name: string; datasetReleaseId: string; filters: Record<string, unknown>; createdAt: string };

export async function listSavedViews(userId: string): Promise<SavedView[]> {
  if (!pool) return [];
  const result = await pool.query('SELECT id, name, dataset_release_id, filters, created_at FROM saved_views WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return result.rows.map((row) => ({ id: row.id, name: row.name, datasetReleaseId: row.dataset_release_id, filters: row.filters, createdAt: row.created_at.toISOString() }));
}

export async function createSavedView(input: { userId: string; name: string; datasetReleaseId: string; filters: Record<string, unknown> }): Promise<SavedView> {
  if (!pool) throw new Error('database_required');
  const view: SavedView = { id: randomUUID(), name: input.name, datasetReleaseId: input.datasetReleaseId, filters: input.filters, createdAt: new Date().toISOString() };
  await pool.query('INSERT INTO saved_views (id, user_id, name, dataset_release_id, filters) VALUES ($1, $2, $3, $4, $5)',
    [view.id, input.userId, view.name, view.datasetReleaseId, JSON.stringify(view.filters)]);
  return view;
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

export async function getReleaseFingerprint(releaseId: string): Promise<ReleaseFingerprint | undefined> {
  if (!pool) return undefined;
  const release = await pool.query('SELECT checksum, metadata FROM dataset_releases WHERE id = $1', [releaseId]);
  const row = release.rows[0];
  if (!row) return undefined;
  const metadata = (row.metadata ?? {}) as { coverage?: { fiscalYears?: unknown }; fields?: unknown };
  const coverage = await pool.query(
    'SELECT fiscal_year, source_row_count FROM coverage_records WHERE dataset_release_id = $1 ORDER BY fiscal_year',
    [releaseId],
  );
  const fiscalYears = Array.isArray(metadata.coverage?.fiscalYears)
    ? (metadata.coverage.fiscalYears as unknown[]).filter((year): year is number => typeof year === 'number' && Number.isInteger(year)).sort((left, right) => left - right)
    : coverage.rows.map((record: { fiscal_year: number }) => Number(record.fiscal_year));
  const rowCounts: Record<string, number> = {};
  for (const record of coverage.rows) rowCounts[String(record.fiscal_year)] = Number(record.source_row_count);
  const fields = Array.isArray(metadata.fields)
    ? metadata.fields.map((field: unknown) => typeof field === 'string' ? field
      : field && typeof field === 'object' && 'name' in field ? String((field as { name: unknown }).name ?? '') : '').filter(Boolean)
    : [];
  return { checksum: String(row.checksum), fiscalYears, rowCounts, fields };
}

export type ReleaseCheck = {
  id: string;
  releaseId: string;
  status: CheckStatus;
  sourceChecksum: string | null;
  previousChecksum: string;
  drift: DriftReport;
  note: string;
  createdAt: string;
};

export async function insertReleaseCheck(input: Omit<ReleaseCheck, 'id' | 'createdAt'>): Promise<ReleaseCheck> {
  if (!pool) throw new Error('database_required');
  const check: ReleaseCheck = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO release_checks (id, release_id, status, source_checksum, previous_checksum, drift, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [check.id, check.releaseId, check.status, check.sourceChecksum, check.previousChecksum, JSON.stringify(check.drift), check.note],
  );
  return check;
}

export async function listReleaseChecks(releaseId: string): Promise<ReleaseCheck[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, release_id, status, source_checksum, previous_checksum, drift, note, created_at
     FROM release_checks WHERE release_id = $1 ORDER BY created_at`,
    [releaseId],
  );
  return result.rows.map((row) => ({ id: row.id, releaseId: row.release_id, status: row.status,
    sourceChecksum: row.source_checksum, previousChecksum: row.previous_checksum, drift: row.drift,
    note: row.note, createdAt: row.created_at.toISOString() }));
}

export type ConnectorCheck = {
  id: string;
  connector: string;
  status: 'ok' | 'failed';
  httpStatus: number | null;
  datasetCount: number | null;
  message: string;
  createdAt: string;
};

// A failed portal read is written here too, so it is reported instead of swallowed.
export async function insertConnectorCheck(input: Omit<ConnectorCheck, 'id' | 'createdAt'>): Promise<ConnectorCheck> {
  if (!pool) throw new Error('database_required');
  const check: ConnectorCheck = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO connector_checks (id, connector, status, http_status, dataset_count, message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [check.id, check.connector, check.status, check.httpStatus, check.datasetCount, check.message],
  );
  return check;
}

// One row per connector: the most recent observation is the connector's state.
export async function latestConnectorChecks(): Promise<ConnectorCheck[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT DISTINCT ON (connector) id, connector, status, http_status, dataset_count, message, created_at
     FROM connector_checks ORDER BY connector, created_at DESC`,
  );
  return result.rows.map((row) => ({ id: row.id, connector: row.connector, status: row.status,
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    datasetCount: row.dataset_count === null ? null : Number(row.dataset_count),
    message: row.message, createdAt: row.created_at.toISOString() }));
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
      // The seed creates the canonical release, so it also creates the curated
      // relationship once its synthetic counterpart exists from migration 018.
      if (release.id === 'bettergov-gaa-coverage-2026-11-07') await client.query(
        `INSERT INTO dataset_relationships (id, name, primary_release_id, related_release_id, join_keys, status)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        ['11111111-2222-3333-4444-555555555555', 'mvp-d-gaa-to-synthetic-fixture', release.id,
          'join-fixture-2026-11-07', JSON.stringify(['fiscal_year']), 'validated'],
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

export type Relationship = { id: string; primaryReleaseId: string; relatedReleaseId: string; joinKeys: string[]; status: 'draft' | 'validated' | 'retired' };

export async function getRelationship(id: string): Promise<Relationship | undefined> {
  if (!pool) return undefined;
  const result = await pool.query('SELECT id, primary_release_id, related_release_id, join_keys, status FROM dataset_relationships WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? { id: row.id, primaryReleaseId: row.primary_release_id, relatedReleaseId: row.related_release_id,
    joinKeys: row.join_keys as string[], status: row.status } : undefined;
}

export async function getJoinRows(releaseId: string): Promise<Array<{ fiscal_year: number; coverage_status: string; source_row_count: number }>> {
  if (!pool) return [];
  const result = await pool.query(
    'SELECT fiscal_year, coverage_status, source_row_count FROM coverage_records WHERE dataset_release_id = $1 ORDER BY fiscal_year',
    [releaseId],
  );
  return result.rows.map((row) => ({ fiscal_year: row.fiscal_year, coverage_status: row.coverage_status, source_row_count: row.source_row_count }));
}

// Evidence and its joined diagnostics are written in one transaction so a
// successful analysis run can never exist without its joined record.
export async function saveJoinedRun(input: {
  relationshipId: string;
  evidence: Omit<Evidence, 'id' | 'createdAt'>;
  diagnostics: unknown;
  result: unknown;
}): Promise<Evidence> {
  const evidence: Evidence = { ...input.evidence, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) throw new Error('database_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO analysis_runs (id, dataset_release_id, recipe, recipe_version, filters, result, validation, reproducibility_status, input_rows, output_rows, release_checksum, calculation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [evidence.id, evidence.datasetReleaseId, evidence.recipe, evidence.recipeVersion, JSON.stringify(evidence.filters), JSON.stringify(evidence.result),
        JSON.stringify({ validation: evidence.validation, warnings: evidence.warnings, limitations: evidence.limitations }), evidence.reproducibilityStatus,
        evidence.inputRows, evidence.outputRows, evidence.releaseChecksum, evidence.calculation],
    );
    await client.query(
      `INSERT INTO joined_evidence (id, relationship_id, analysis_run_id, recipe_version, filters, diagnostics, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), input.relationshipId, evidence.id, evidence.recipeVersion, JSON.stringify(evidence.filters),
        JSON.stringify(input.diagnostics), JSON.stringify(input.result)],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return evidence;
}

export async function createFinding(evidenceId: string, submittedBy: string, impact: string, claim: string): Promise<Finding> {
  const finding: Finding = { id: randomUUID(), evidenceId, status: 'Unverified', impact, claim, submittedBy, createdAt: new Date().toISOString() };
  // Only the database-less development fallback keeps findings in memory; with a
  // pool, PostgreSQL is the single source of truth and a local copy would go stale.
  if (!pool) findings.set(finding.id, finding);
  if (pool) await pool.query('INSERT INTO findings (id, analysis_run_id, status, submitted_by, impact, claim) VALUES ($1, $2, $3, $4, $5, $6)',
    [finding.id, evidenceId, finding.status, submittedBy, impact, claim]);
  return finding;
}

export async function getFinding(id: string): Promise<Finding | undefined> {
  if (!pool) return findings.get(id);
  const result = await pool.query('SELECT id, analysis_run_id, status, impact, claim, submitted_by, created_at FROM findings WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? { id: row.id, evidenceId: row.analysis_run_id, status: row.status, impact: row.impact, claim: row.claim, submittedBy: row.submitted_by, createdAt: row.created_at.toISOString() } : undefined;
}

export type ExplanationRecord = { id: string; findingId: string; text: string; source: 'llm' | 'template'; provider: string | null; model: string | null; templateVersion: string; createdAt: string };

export async function saveExplanation(input: { findingId: string; text: string; source: 'llm' | 'template'; provider?: string; model?: string; templateVersion: string }): Promise<ExplanationRecord> {
  if (!pool) throw new Error('database_required');
  const record: ExplanationRecord = { id: randomUUID(), findingId: input.findingId, text: input.text, source: input.source,
    provider: input.provider ?? null, model: input.model ?? null, templateVersion: input.templateVersion, createdAt: new Date().toISOString() };
  await pool.query('INSERT INTO explanations (id, finding_id, text, source, provider, model, template_version) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [record.id, record.findingId, record.text, record.source, record.provider, record.model, record.templateVersion]);
  return record;
}

export async function getLatestExplanation(findingId: string): Promise<ExplanationRecord | undefined> {
  if (!pool) return undefined;
  const result = await pool.query('SELECT id, finding_id, text, source, provider, model, template_version, created_at FROM explanations WHERE finding_id = $1 ORDER BY created_at DESC LIMIT 1', [findingId]);
  const row = result.rows[0];
  return row ? { id: row.id, findingId: row.finding_id, text: row.text, source: row.source, provider: row.provider,
    model: row.model, templateVersion: row.template_version, createdAt: row.created_at.toISOString() } : undefined;
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

export async function recordTransition(input: { findingId: string; fromStatus: string; toStatus: string; actorId: string; reason: string; applyStatus?: boolean }): Promise<FindingTransition> {
  const applyStatus = input.applyStatus ?? true;
  const transition: FindingTransition = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
  if (!pool) throw new Error('database_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO finding_transitions (id, finding_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5, $6)',
      [transition.id, transition.findingId, transition.fromStatus, transition.toStatus, transition.actorId, transition.reason]);
    // A high-impact first decision is recorded without moving the status: the
    // finding needs a second, independent reviewer before it is settled.
    if (applyStatus) await client.query('UPDATE findings SET status = $2 WHERE id = $1', [transition.findingId, transition.toStatus]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return transition;
}

export async function listTransitions(findingId: string): Promise<FindingTransition[]> {
  if (!pool) return [];
  const result = await pool.query('SELECT id, finding_id, from_status, to_status, actor_id, reason, created_at FROM finding_transitions WHERE finding_id = $1 ORDER BY created_at', [findingId]);
  return result.rows.map((row) => ({ id: row.id, findingId: row.finding_id, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, reason: row.reason, createdAt: row.created_at.toISOString() }));
}

// Decisions already on record, and how many different reviewers made them: a
// high-impact finding is only settled by two independent reviewers.
export async function listDecisionTransitions(findingId: string, decisionStatuses: string[]): Promise<FindingTransition[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, finding_id, from_status, to_status, actor_id, reason, created_at FROM finding_transitions
     WHERE finding_id = $1 AND to_status = ANY($2) ORDER BY created_at`,
    [findingId, decisionStatuses],
  );
  return result.rows.map((row) => ({ id: row.id, findingId: row.finding_id, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, reason: row.reason, createdAt: row.created_at.toISOString() }));
}

export async function recordConflict(input: { findingId: string; statuses: string[]; positions: Array<{ actorId: string; status: string; reason: string; createdAt: string }> }): Promise<void> {
  if (!pool) throw new Error('database_required');
  await pool.query('INSERT INTO review_conflicts (id, finding_id, statuses, positions) VALUES ($1, $2, $3, $4)',
    [randomUUID(), input.findingId, JSON.stringify(input.statuses), JSON.stringify(input.positions)]);
}

export async function listConflicts(findingId: string): Promise<Array<{ id: string; statuses: string[]; positions: unknown; createdAt: string }>> {
  if (!pool) return [];
  const result = await pool.query('SELECT id, statuses, positions, created_at FROM review_conflicts WHERE finding_id = $1 ORDER BY created_at', [findingId]);
  return result.rows.map((row) => ({ id: row.id, statuses: row.statuses, positions: row.positions, createdAt: row.created_at.toISOString() }));
}

// The queue is what a reviewer can act on now: findings waiting for review, oldest
// first, with the author so self-review can be refused.
export async function listReviewQueue(statuses: string[]): Promise<Array<Finding & { authorRole: string | null; authorEmail: string | null }>> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT f.id, f.analysis_run_id, f.status, f.impact, f.claim, f.submitted_by, f.created_at, u.role AS author_role, u.email AS author_email
     FROM findings f LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.status = ANY($1) ORDER BY f.created_at`,
    [statuses],
  );
  return result.rows.map((row) => ({ id: row.id, evidenceId: row.analysis_run_id, status: row.status, impact: row.impact, claim: row.claim, submittedBy: row.submitted_by,
    createdAt: row.created_at.toISOString(), authorRole: row.author_role ?? null, authorEmail: row.author_email ?? null }));
}

export type PublicFinding = Finding & { recipe: string | null; datasetReleaseId: string | null; datasetName: string | null; filters: Record<string, unknown>; validationStatus: string | null };

// Every finding is public by design, so this reads without an account. It joins the
// run for its recipe because a claim alone does not tell a reader what was computed.
export async function listPublicFindings(input: { statuses?: string[]; limit: number; offset: number }): Promise<PublicFinding[]> {
  if (!pool) {
    return [...findings.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(input.offset, input.offset + input.limit)
      .map((finding) => ({ ...finding, recipe: null, datasetReleaseId: null, datasetName: null, filters: {}, validationStatus: null }));
  }
  const result = await pool.query(
    `SELECT f.id, f.analysis_run_id, f.status, f.impact, f.claim, f.submitted_by, f.created_at, a.recipe, a.dataset_release_id,
            a.filters, a.validation, d.name AS dataset_name
     FROM findings f LEFT JOIN analysis_runs a ON a.id = f.analysis_run_id
     LEFT JOIN dataset_releases d ON d.id = a.dataset_release_id
     WHERE $1::text[] IS NULL OR f.status = ANY($1::text[])
     ORDER BY f.created_at DESC, f.id DESC LIMIT $2 OFFSET $3`,
    [input.statuses ?? null, input.limit, input.offset],
  );
  return result.rows.map((row) => ({ id: row.id, evidenceId: row.analysis_run_id, status: row.status, impact: row.impact,
    claim: row.claim, submittedBy: row.submitted_by, createdAt: row.created_at.toISOString(),
    recipe: row.recipe ?? null, datasetReleaseId: row.dataset_release_id ?? null, datasetName: row.dataset_name ?? null,
    // The evidence payload nests its own validation report, so read through it once.
    filters: (row.filters ?? {}) as Record<string, unknown>,
    validationStatus: row.validation?.validation?.status ?? row.validation?.status ?? null }));
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

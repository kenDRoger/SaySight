import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { catalog } from './catalog.js';
import { createFinding, getCatalogReleases, getEvidence, getFinding, getNormalizedCoverage, listDraftReleases, registerDraftRelease, saveEvidence, saveNormalizedCoverage } from './store.js';

const port = Number(process.env.PORT ?? 3000);
const workerUrl = process.env.WORKER_URL ?? 'http://127.0.0.1:8080';
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const json = (response: import('node:http').ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { status: 'ok', service: 'saysight-api' });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/datasets') {
    getCatalogReleases().then((releases) => json(response, 200, { datasets: releases?.length ? releases : catalog })).catch(() => json(response, 503, { error: 'catalog_unavailable' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/recipes') {
    json(response, 200, {
      recipes: ['summary', 'compare', 'rank', 'distribution', 'change_over_time'],
    });
    return;
  }

  const previewMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/datasets\/([^/]+)\/preview(?:\?(.*))?$/) : undefined;
  if (previewMatch) {
    (async () => {
      const releaseId = previewMatch[1];
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams;
      const allowed = new Set(['year', 'years', 'status']);
      if ([...params.keys()].some((key) => !allowed.has(key)) || (params.has('year') && params.has('years'))) { json(response, 400, { error: 'invalid_preview_filters' }); return; }
      const parseYears = (value: string | null) => {
        if (!value) return undefined;
        const parsed = value.split(',').map(Number);
        return parsed.every((year) => Number.isInteger(year) && year >= 2000 && year <= 2026) ? parsed : null;
      };
      const years = parseYears(params.get('years'));
      const yearValues = parseYears(params.get('year'));
      if (years === null || yearValues === null || (yearValues && yearValues.length !== 1)) { json(response, 400, { error: 'fiscal_year_must_be_between_2000_and_2026' }); return; }
      let normalizedRows: Awaited<ReturnType<typeof getNormalizedCoverage>>;
      try { normalizedRows = await getNormalizedCoverage(releaseId); }
      catch { json(response, 503, { error: 'normalized_preview_unavailable' }); return; }
      if (normalizedRows !== undefined) {
        if (!normalizedRows.length) { json(response, 503, { error: 'dataset_release_not_imported' }); return; }
        const selectedYears = years ?? yearValues;
        const status = params.get('status');
        const matchingRows = normalizedRows.filter((row) => (!selectedYears || selectedYears.includes(row.year)) && (!status || row.status === status));
        json(response, 200, { filters: Object.fromEntries(params.entries()), matching_rows: matchingRows.length, source_rows: normalizedRows.length });
        return;
      }
      const workerResponse = await fetch(`${workerUrl}/preview${previewMatch[2] ? `?${previewMatch[2]}` : ''}`);
      response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(await workerResponse.text());
    })().catch(() => json(response, 503, { error: 'analysis_worker_unavailable' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/imports/drafts') { json(response, 200, { releases: listDraftReleases() }); return; }

  const registerMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/imports\/register\?filename=([^&]+)&name=([^&]+)$/) : undefined;
  if (registerMatch) {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const data = Buffer.concat(chunks);
        const workerResponse = await fetch(`${workerUrl}/validate-import?filename=${registerMatch[1]}`, { method: 'POST', body: data });
        if (!workerResponse.ok) { response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(await workerResponse.text()); return; }
        const release = await registerDraftRelease(decodeURIComponent(registerMatch[2]), decodeURIComponent(registerMatch[1]), data);
        json(response, 201, { ...release, visibility: 'private-draft', validation: await workerResponse.json() });
      } catch { json(response, 503, { error: 'draft_registration_unavailable' }); }
    });
    return;
  }

  const importMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/imports\/validate\?filename=([^&]+)$/) : undefined;
  if (importMatch) {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const workerResponse = await fetch(`${workerUrl}/validate-import?filename=${importMatch[1]}`, { method: 'POST', body: Buffer.concat(chunks) });
        response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(await workerResponse.text());
      } catch { json(response, 503, { error: 'import_worker_unavailable' }); }
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/datasets/bettergov-gaa-coverage-2026-11-07/import') {
    fetch(`${workerUrl}/records`).then(async (workerResponse) => {
      if (!workerResponse.ok) { json(response, 503, { error: 'coverage_release_unavailable' }); return; }
      const rows = await workerResponse.json() as Array<{ DatasetReleaseID: string; FiscalYear: number; CoverageStatus: string; SourceRowCount: number; AmountPesos?: number; Scopes?: Record<string, unknown>; Notes: string[] }>;
      const imported = await saveNormalizedCoverage(rows, catalog[0]);
      json(response, 200, { dataset_release_id: 'bettergov-gaa-coverage-2026-11-07', imported_rows: imported, status: 'validated' });
    }).catch((error) => { console.error(error); json(response, 503, { error: 'normalized_import_unavailable' }); });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/analyze') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        let payload: unknown;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
        if (!payload || typeof payload !== 'object' || !('recipe' in payload) || typeof payload.recipe !== 'string') { json(response, 400, { error: 'recipe_required' }); return; }
        const requestBody = payload as Record<string, unknown>;
        const allowedRecipes = new Set(['summary', 'compare', 'rank', 'distribution', 'change_over_time']);
        if (!allowedRecipes.has(payload.recipe)) { json(response, 400, { error: 'unsupported_recipe' }); return; }
        const year = requestBody.year;
        if (year !== undefined && (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2026)) { json(response, 400, { error: 'year_must_be_between_2000_and_2026' }); return; }
        if (requestBody.status !== undefined && typeof requestBody.status !== 'string') { json(response, 400, { error: 'status_must_be_string' }); return; }
        let compareYears: number[] | undefined;
        if (payload.recipe === 'compare') {
          if (!Array.isArray(requestBody.compare_years) || requestBody.compare_years.length !== 2 || requestBody.compare_years.some((value) => !Number.isInteger(value) || value < 2000 || value > 2026)) { json(response, 400, { error: 'compare_requires_two_valid_fiscal_years' }); return; }
          compareYears = requestBody.compare_years as number[];
        } else if (requestBody.compare_years !== undefined) { json(response, 400, { error: 'compare_years_only_valid_for_compare' }); return; }
        const normalizedRows = await getNormalizedCoverage('bettergov-gaa-coverage-2026-11-07');
        if (normalizedRows && normalizedRows.length === 0) { json(response, 503, { error: 'dataset_release_not_imported' }); return; }
        const workerBody = {
          recipe: payload.recipe,
          ...(year !== undefined ? { year } : {}),
          ...(typeof requestBody.status === 'string' ? { status: requestBody.status } : {}),
          ...(compareYears ? { compare_years: compareYears } : {}),
          ...(normalizedRows ? { rows: normalizedRows } : {}),
        };
        const analyzeOnce = () => fetch(`${workerUrl}/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(workerBody),
        });
        const workerResponse = await analyzeOnce();
        const body = await workerResponse.text();
        if (!workerResponse.ok) { response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(body); return; }
        const result = JSON.parse(body) as Record<string, any>;
        const replayResponse = await analyzeOnce();
        if (!replayResponse.ok) { json(response, 503, { error: 'reproducibility_rerun_unavailable', validation: { status: 'Not run', checks: ['second execution unavailable'] }, reproducibility_status: 'Not run' }); return; }
        const replay = await replayResponse.json();
        if (!isDeepStrictEqual(result, replay)) { json(response, 422, { error: 'reproducibility_mismatch', validation: { status: 'Fail', checks: ['second execution did not match the first result'] }, reproducibility_status: 'Failed' }); return; }
        result.reproducibility_status = 'Passed';
        result.validation.checks.push('deterministic rerun matched');
        const evidence = await saveEvidence({
          datasetReleaseId: 'bettergov-gaa-coverage-2026-11-07',
          recipe: String(result.recipe), recipeVersion: String(result.recipe_version),
          filters: (result.filters ?? {}) as Record<string, unknown>, result: result.result,
          inputRows: Number(result.input_rows ?? 0), outputRows: Number(result.output_rows ?? 0),
          releaseChecksum: catalog[0].checksum, calculation: String(result.calculation ?? ''),
          validation: result.validation ?? { status: 'Not run', checks: [] },
          warnings: (result.warnings ?? []) as string[], limitations: (result.limitations ?? []) as string[],
          reproducibilityStatus: String(result.reproducibility_status),
        });
        json(response, 200, { ...result, evidence_id: evidence.id, evidence_created_at: evidence.createdAt });
      } catch (error) {
        console.error('analysis request failed', error);
        json(response, 503, { error: 'analysis_worker_unavailable', validation: { status: 'Not run', checks: ['analysis worker unavailable'] }, reproducibility_status: 'Not run' });
      }
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/findings') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { evidence_id?: unknown };
        if (typeof payload.evidence_id !== 'string') { json(response, 400, { error: 'evidence_id_required' }); return; }
        const evidence = await getEvidence(payload.evidence_id);
        if (!evidence) { json(response, 404, { error: 'evidence_not_found' }); return; }
        json(response, 201, await createFinding(evidence.id));
      } catch { json(response, 400, { error: 'invalid_json' }); }
    });
    return;
  }

  const findingPageMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/page$/) : undefined;
  if (findingPageMatch) {
    getFinding(findingPageMatch[1]).then(async (finding) => {
      if (!finding) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Finding not found'); return; }
      const evidence = await getEvidence(finding.evidenceId);
      const dataset = catalog.find((item) => item.id === evidence?.datasetReleaseId);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const details = evidence ? `<section aria-labelledby="evidence-heading"><h2 id="evidence-heading">Evidence</h2><dl><dt>Dataset</dt><dd>${escapeHtml(dataset?.name ?? evidence.datasetReleaseId)}</dd><dt>Source</dt><dd>${dataset ? `<a href="${escapeHtml(dataset.sourceUrl)}">${escapeHtml(dataset.sourceUrl)}</a>` : escapeHtml(evidence.datasetReleaseId)}</dd><dt>Release</dt><dd><code>${escapeHtml(evidence.datasetReleaseId)}</code></dd><dt>SHA-256</dt><dd><code>${escapeHtml(evidence.releaseChecksum)}</code></dd><dt>Recipe</dt><dd>${escapeHtml(evidence.recipe)} v${escapeHtml(evidence.recipeVersion)}</dd><dt>Calculation</dt><dd>${escapeHtml(evidence.calculation)}</dd><dt>Filters</dt><dd><pre>${escapeHtml(JSON.stringify(evidence.filters, null, 2))}</pre></dd><dt>Rows</dt><dd>${evidence.inputRows} input, ${evidence.outputRows} output</dd><dt>Reproducibility</dt><dd>${escapeHtml(evidence.reproducibilityStatus)}</dd><dt>Validation</dt><dd><pre>${escapeHtml(JSON.stringify(evidence.validation, null, 2))}</pre></dd></dl><h3>Result</h3><pre>${escapeHtml(JSON.stringify(evidence.result, null, 2))}</pre><h3>Warnings</h3><ul>${evidence.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul><h3>Limitations</h3><ul>${evidence.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('')}</ul></section>` : '<p>Evidence unavailable.</p>';
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unverified finding · Saysight</title></head><body><main><h1>Unverified finding</h1><p>This is an analysis candidate; it has not been human-reviewed.</p><p>Status: <strong>${escapeHtml(finding.status)}</strong></p><p>Finding ID: <code>${escapeHtml(finding.id)}</code></p><p><a href="/api/v1/evidence/${encodeURIComponent(finding.evidenceId)}">View evidence JSON</a></p>${details}</main></body></html>`);
    }).catch(() => { response.writeHead(503); response.end('Finding page unavailable'); });
    return;
  }

  const findingMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)$/) : undefined;
  if (findingMatch) {
    getFinding(findingMatch[1]).then((finding) => finding ? json(response, 200, finding) : json(response, 404, { error: 'finding_not_found' })).catch(() => json(response, 503, { error: 'finding_store_unavailable' }));
    return;
  }

  const evidenceMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/evidence\/([^/]+)$/) : undefined;
  if (evidenceMatch) {
    getEvidence(evidenceMatch[1]).then((evidence) => evidence ? json(response, 200, evidence) : json(response, 404, { error: 'evidence_not_found' })).catch(() => json(response, 503, { error: 'evidence_store_unavailable' }));
    return;
  }

  json(response, 404, { error: 'not_found' });
});

server.listen(port, () => console.log(`SaySight API listening on :${port}`));

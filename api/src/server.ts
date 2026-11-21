import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { catalog } from './catalog.js';
import { workerFetch } from './worker.js';
import { createGate } from './gate.js';
import { createComment, listPublicFindings, createFinding, getRun, insertInsight, insertRun, createSavedView, countReleaseRows, datasetReleaseExists, findPinnedRelease, getComment, getCatalogReleases, getEvidence, getFinding, getImportDraft, getJoinRows, getLatestExplanation, getRelationship, getReleaseRowSchema, getReleaseRows, insertConnectorCheck, insertPinnedRelease, latestConnectorChecks, listAgencies, getNormalizedCoverage, getReleaseFingerprint, insertReleaseCheck, listComments, listConflicts, listDecisionTransitions, listDraftReleases, listReviewQueue, listSavedViews, listTransitions, pool, publishImportDraft, recordConflict, recordTransition, registerDraftRelease, removeComment, saveEvidence, saveExplanation, saveImportRows, saveReleaseRows, saveJoinedRun, saveNormalizedCoverage } from './store.js';
import { inferReleaseSchema, licenceStatus, pinSummary, releaseKey } from './pin.js';
import { executeJoin, joinedSchema, limitJoinedRows } from './joinRun.js';
import { connectors, getConnector } from './connectors.js';
import { classifyCheck, computeDrift, sourceFingerprint, summarise, type ReleaseFingerprint } from './refresh.js';
import { createExplainer } from './explain.js';
import { checkRemoval, validateCommentBody, validateRemovalReason } from './comments.js';
import { checkRows, checkUpload, type QuarantineReason } from './uploadPolicy.js';
import { validateMetadata, type PublicationMetadata } from './metadata.js';
import { joinLimitations, planJoin, type Relationship } from './join.js';
import { runAllApplicable, type Column as RecipeColumn, type RecipeOptions } from './recipes.js';
import { selectInsights } from './insights.js';
import { planJoin as planTwoWayJoin, type Aggregation, type Column } from './joinPlan.js';
import { checkTransition, decisionStatuses, isStatus, reviewQueueStatuses, validateReason } from './review.js';
import { validateClaim } from './claim.js';
import { csvFilename, toCsv } from './export.js';
import { filterDatasets, filterQueue, isInvalidFilter } from './filters.js';
import { checkImpactGate, conflictRecord, deriveImpact, isImpact, type Impact } from './impact.js';
import { clearSessionCookie, createAuth, defaultTransport, readCookie, serializeSessionCookie, sessionCookie } from './auth.js';
import { createPgAuthStore } from './authpg.js';

const port = Number(process.env.PORT ?? 3000);
const workerUrl = process.env.WORKER_URL ?? 'http://127.0.0.1:8080';
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const json = (response: import('node:http').ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const workerMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : body;
  } catch { return body; }
};

const maxUploadBytes = 100 * 1024 * 1024;
const maxJsonBytes = 1024 * 1024;
// Shape the worker guarantees for an analysis response; anything else is read as
// unknown so no `any` leaks into the evidence write path.
type WorkerAnalysisResponse = {
  recipe: string;
  recipe_version: string;
  filters?: Record<string, unknown>;
  result?: unknown;
  input_rows?: number;
  output_rows?: number;
  calculation?: string;
  validation: { status: string; checks: string[] };
  warnings?: string[];
  limitations?: string[];
  reproducibility_status?: string;
};

// Public endpoint contract for every route in this file: success is 200, 201,
// 202, or 204; failures use a JSON { error: '<code>' } body with 400 for bad
// input (400 invalid_filter adds the offending `parameter`),
// 401 sign_in_required / invalid_or_expired_link, 403 for denied roles,
// 404 for missing records, 409 for state conflicts, 413 for capped bodies, 422
// for rejected imports, 429 upload_busy, 502 when a connector check cannot read
// its portal, and 503 for unavailable dependencies.
// The findings/:id/page route is HTML and returns 404 or 503 as plain text.
const maxConcurrentUploads = 2;
// A public list must stay one bounded response, so the cap is the contract.
const publicFindingLimit = 100;

function uploadBusy(response: ServerResponse) {
  response.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' });
  response.end(JSON.stringify({ error: 'upload_busy' }));
}

// Reads a body with an explicit byte cap. An oversized body is rejected before it
// can exhaust the container, and the request is destroyed to stop the upload.
function readBoundedBody(request: IncomingMessage, limit: number): Promise<{ data: Buffer } | { denied: true } | { failed: true }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: { data: Buffer } | { denied: true } | { failed: true }) => { if (!settled) { settled = true; resolve(value); } };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { finish({ denied: true }); request.resume(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => finish({ data: Buffer.concat(chunks) }));
    request.on('error', () => finish({ failed: true }));
  });
}

const maxSourceBytes = 10 * 1024 * 1024;

// A source read is bounded: an oversized or unreadable response is recorded as
// unreachable instead of stalling a maintainer's manual check.
async function readSourceBytes(url: string): Promise<Buffer | undefined> {
  try {
    const fetched = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!fetched.ok || !fetched.body) return undefined;
    const reader = fetched.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSourceBytes) { await reader.cancel(); return undefined; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch { return undefined; }
}

// Optional pagination for growing lists. With no parameters the response shape is
// unchanged, so every MVP-A/MVP-B caller keeps working.
function paginationFor(url: string | undefined): { limit?: number; offset: number } | { error: true } {
  const params = new URL(url ?? '/', 'http://localhost').searchParams;
  const rawLimit = params.get('limit');
  const rawOffset = params.get('offset');
  const parse = (value: string | null, min: number, max?: number) => {
    if (value === null) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) return null;
    return parsed;
  };
  const limit = parse(rawLimit, 1, 100);
  const offset = parse(rawOffset, 0) ?? 0;
  if (limit === null || (rawOffset !== null && parse(rawOffset, 0) === null)) return { error: true };
  return { limit, offset };
}

const paginate = <T>(items: T[], page: { limit?: number; offset: number }) =>
  items.slice(page.offset, page.limit === undefined ? undefined : page.offset + page.limit);

// shortcut: each page reparses the file; replace with a streaming worker reader
// when normal imports routinely exceed ~100,000 rows.
async function normalizeDraft(filename: string, data: Buffer, publicId: string): Promise<number> {
  let offset = 0;
  let total = 0;
  do {
    const response = await workerFetch(`${workerUrl}/normalize-import?filename=${encodeURIComponent(filename)}&offset=${offset}&limit=1000`,
      { method: 'POST', body: data as unknown as BodyInit });
    if (!response.ok) throw new Error('normalization_failed');
    const page = (await response.json()) as { total_rows?: number; rows?: Array<Record<string, unknown>> };
    total = Number(page.total_rows ?? 0);
    const rows = Array.isArray(page.rows) ? page.rows : [];
    if (rows.length) await saveImportRows(publicId, offset, rows);
    if (!rows.length) break;
    offset += rows.length;
  } while (offset < total);
  return offset;
}

const maxReleaseRows = 200_000;
const releaseRowPageSize = 1000;
const maxJoinedRows = 50_000;

// The worker reparses the pinned bytes for each page; only bounded pages are
// kept, and a truncated read is recorded on the release rather than hidden.
async function normalizeReleaseRows(filename: string, data: Buffer): Promise<{
  pages: Array<{ offset: number; rows: Array<Record<string, unknown>> }>; truncated: boolean;
}> {
  const pages: Array<{ offset: number; rows: Array<Record<string, unknown>> }> = [];
  let offset = 0;
  let total = 0;
  do {
    const response = await workerFetch(`${workerUrl}/normalize-import?filename=${encodeURIComponent(filename)}&offset=${offset}&limit=${releaseRowPageSize}`,
      { method: 'POST', body: data as unknown as BodyInit });
    if (!response.ok) throw new Error(workerMessage(await response.text()));
    const page = (await response.json()) as { total_rows?: number; rows?: Array<Record<string, unknown>> };
    total = Number(page.total_rows ?? 0);
    const rows = Array.isArray(page.rows)
      ? page.rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
      : [];
    if (!rows.length) break;
    const remaining = maxReleaseRows - offset;
    if (remaining <= 0) break;
    const kept = rows.slice(0, remaining);
    pages.push({ offset, rows: kept });
    offset += kept.length;
    if (kept.length < rows.length) break;
  } while (offset < total && offset < maxReleaseRows);
  return { pages, truncated: total > maxReleaseRows || offset < total };
}

const columnTypes = ['integer', 'number', 'text', 'date', 'boolean'];
const columnsFromSchema = (schema: Record<string, unknown> | undefined): Column[] => {
  const raw = schema?.columns;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Column[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const candidate = entry as { name?: unknown; type?: unknown };
    if (typeof candidate.name !== 'string') return [];
    const type = columnTypes.includes(String(candidate.type)) ? candidate.type as Column['type'] : 'text';
    return [{ name: candidate.name, type }];
  });
};
const grainFromSchema = (schema: Record<string, unknown> | undefined): string =>
  typeof schema?.grain === 'string' && schema.grain.trim() ? schema.grain : 'row';

// A pinned release stores its schema as { columns: [...] }; anything else means the
// rows cannot be typed, which is reported instead of guessed.
function schemaColumns(schema: Record<string, unknown> | undefined): RecipeColumn[] {
  const columns = schema?.columns;
  if (!Array.isArray(columns)) return [];
  return columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const entry = column as { name?: unknown; type?: unknown };
    if (typeof entry.name !== 'string') return [];
    const type = entry.type === 'integer' || entry.type === 'number' || entry.type === 'text' || entry.type === 'date' || entry.type === 'boolean'
      ? entry.type : 'text';
    return [{ name: entry.name, type }];
  });
}

const uploads = createGate(maxConcurrentUploads);

// Accounts need PostgreSQL; without it the auth endpoints report themselves as
// unavailable rather than falling back to a store that forgets sessions.
const auth = pool
  ? createAuth(createPgAuthStore(pool), {
      maintainerEmail: process.env.SAYSIGHT_MAINTAINER_EMAIL,
      baseUrl: process.env.SAYSIGHT_BASE_URL ?? 'http://localhost:5173',
      transport: defaultTransport,
    })
  : undefined;
const cookieSecure = process.env.COOKIE_SECURE === 'true';
// Explanations only rephrase an existing result. With no provider configured the
// explainer answers with the deterministic template, which is the required fallback.
const explanationEndpoint = process.env.EXPLANATION_PROVIDER_ENDPOINT;
const explanationModel = process.env.EXPLANATION_PROVIDER_MODEL;
const explainer = createExplainer({
  provider: explanationEndpoint && explanationModel
    ? { name: process.env.EXPLANATION_PROVIDER_NAME ?? 'openai-compatible', model: explanationModel, endpoint: explanationEndpoint, apiKey: process.env.EXPLANATION_API_KEY }
    : undefined,
  timeoutMs: Number(process.env.EXPLANATION_TIMEOUT_MS ?? 8000),
});
const requestSessionToken = (request: IncomingMessage) => readCookie(request.headers.cookie, sessionCookie);

const server = createServer((request, response) => {


  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { status: 'ok', service: 'saysight-api' });
    return;
  }

  const datasetsMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/datasets(?:\?(.*))?$/) : undefined;
  if (datasetsMatch) {
    const page = paginationFor(request.url);
    if ('error' in page) { json(response, 400, { error: 'invalid_pagination' }); return; }
    // Filters narrow the list before pagination, so a page holds the matches the
    // caller asked for. With no parameters the list is exactly what it was.
    const params = new URL(request.url ?? '/', 'http://localhost').searchParams;
    const filters = { q: params.get('q'), agency: params.get('agency'), freshness: params.get('freshness') };
    getCatalogReleases().then((releases) => {
      const filtered = filterDatasets(releases?.length ? releases : catalog, filters);
      if (isInvalidFilter(filtered)) { json(response, 400, filtered); return; }
      json(response, 200, { datasets: paginate(filtered, page) });
    }).catch(() => json(response, 503, { error: 'catalog_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/auth/magic-link') {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      let payload: unknown;
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const email = payload && typeof payload === 'object' && 'email' in payload ? (payload as { email?: unknown }).email : undefined;
      if (typeof email !== 'string') { json(response, 400, { error: 'email_required' }); return; }
      try {
        // The response never reveals whether the address is known.
        await auth.requestMagicLink(email);
        json(response, 202, { status: 'pending' });
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_email') { json(response, 400, { error: 'invalid_email' }); return; }
        json(response, 503, { error: 'accounts_unavailable' });
      }
    });
    return;
  }

  const verifyMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/auth\/verify\?token=([^&]+)$/) : undefined;
  if (verifyMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    auth.verify(decodeURIComponent(verifyMatch[1])).then((result) => {
      if (!result) { json(response, 401, { error: 'invalid_or_expired_link' }); return; }
      const cookie = serializeSessionCookie(result.sessionToken, cookieSecure);
      // Browsers follow the link and land on the app; API clients ask for JSON.
      if ((request.headers.accept ?? '').includes('application/json')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie });
        response.end(JSON.stringify({ user: { id: result.user.id, email: result.user.email, role: result.user.role } }));
        return;
      }
      response.writeHead(303, { location: '/', 'set-cookie': cookie });
      response.end();
    }).catch(() => json(response, 503, { error: 'accounts_unavailable' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/auth/me') {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    auth.session(requestSessionToken(request)).then((user) =>
      user ? json(response, 200, { user: { id: user.id, email: user.email, role: user.role } }) : json(response, 401, { error: 'not_signed_in' }))
      .catch(() => json(response, 503, { error: 'accounts_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/auth/logout') {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    auth.logout(requestSessionToken(request)).then(() => {
      response.writeHead(204, { 'set-cookie': clearSessionCookie(cookieSecure) });
      response.end();
    }).catch(() => json(response, 503, { error: 'accounts_unavailable' }));
    return;
  }

  const reviewQueueMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/review\/queue(?:\?(.*))?$/) : undefined;
  if (reviewQueueMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    const page = paginationFor(request.url);
    if ('error' in page) { json(response, 400, { error: 'invalid_pagination' }); return; }
    const params = new URL(request.url ?? '/', 'http://localhost').searchParams;
    const filters = { status: params.get('status'), impact: params.get('impact'), q: params.get('q') };
    auth.session(requestSessionToken(request)).then(async (user) => {
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      if (user.role !== 'reviewer' && user.role !== 'maintainer') { json(response, 403, { error: 'reviewer_required' }); return; }
      // A reviewer's own submissions are excluded rather than shown and refused.
      const queue = await listReviewQueue([...reviewQueueStatuses]);
      const filtered = filterQueue(queue.filter((finding) => finding.submittedBy !== user.id), filters);
      if (isInvalidFilter(filtered)) { json(response, 400, filtered); return; }
      json(response, 200, { findings: paginate(filtered, page) });
    }).catch(() => json(response, 503, { error: 'review_queue_unavailable' }));
    return;
  }

  const decisionMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/decisions$/) : undefined;
  if (decisionMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      let payload: { status?: unknown; reason?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      if (!isStatus(payload.status)) { json(response, 400, { error: 'invalid_status' }); return; }
      const reason = validateReason(payload.reason);
      if ('error' in reason) { json(response, 400, { error: reason.error }); return; }
      const finding = await getFinding(decisionMatch[1]);
      if (!finding) { json(response, 404, { error: 'finding_not_found' }); return; }
      const check = checkTransition({ from: finding.status, to: payload.status, role: user.role, actorId: user.id, submittedBy: finding.submittedBy });
      if (!check.ok) {
        if (check.error === 'reviewer_required' || check.error === 'self_review_not_allowed') { json(response, 403, { error: check.error }); return; }
        json(response, 409, { error: check.error, ...('allowed' in check ? { allowed: check.allowed } : {}), current_status: finding.status });
        return;
      }
      // Only a terminal decision needs the second reviewer; moving a finding into
      // review is ordinary workflow progress and always applies.
      const isDecision = (decisionStatuses as string[]).includes(payload.status);
      const priorDecisions = finding.impact === 'high' && isDecision ? await listDecisionTransitions(finding.id, [...decisionStatuses]) : [];
      const distinctActors = new Set(priorDecisions.map((decision) => decision.actorId));
      distinctActors.delete(user.id);
      const needsSecondReviewer = finding.impact === 'high' && isImpact(finding.impact) && isDecision;
      if (needsSecondReviewer) {
        const gate = checkImpactGate({ impact: finding.impact as Impact, decisionsMade: distinctActors.size, role: user.role });
        if (!gate.ok) { json(response, 409, { error: gate.error, impact: finding.impact }); return; }
      }
      const applyStatus = !needsSecondReviewer || distinctActors.size >= 1;
      const transition = await recordTransition({ findingId: finding.id, fromStatus: finding.status, toStatus: payload.status, actorId: user.id, reason: reason.reason, applyStatus });
      // Two reviewers reaching different decisions are both kept, and the
      // disagreement is recorded rather than overwritten.
      const decisions = [...priorDecisions, transition].map((decision) => ({ actorId: decision.actorId, status: decision.toStatus, reason: decision.reason, createdAt: decision.createdAt }));
      const conflict = conflictRecord(finding.id, decisions);
      if (conflict) await recordConflict(conflict);
      json(response, 200, { finding: { ...finding, status: applyStatus ? payload.status : finding.status }, transition, ...(conflict ? { conflict: { statuses: conflict.statuses } } : {}) });
    }).catch(() => json(response, 503, { error: 'review_unavailable' }));
    return;
  }

  const commentsMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/comments(?:\?(.*))?$/) : undefined;
  if (commentsMatch) {
    const page = paginationFor(request.url);
    if ('error' in page) { json(response, 400, { error: 'invalid_pagination' }); return; }
    listComments(commentsMatch[1]).then((comments) => json(response, 200, { comments: paginate(comments, page) })).catch(() => json(response, 503, { error: 'comments_unavailable' }));
    return;
  }

  const newCommentMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/comments$/) : undefined;
  if (newCommentMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      let payload: { body?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const body = validateCommentBody(payload.body);
      if ('error' in body) { json(response, 400, { error: body.error }); return; }
      const finding = await getFinding(newCommentMatch[1]);
      if (!finding) { json(response, 404, { error: 'finding_not_found' }); return; }
      json(response, 201, await createComment({ findingId: finding.id, authorId: user.id, body: body.body }));
    }).catch(() => json(response, 503, { error: 'comments_unavailable' }));
    return;
  }

  const removalMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/comments\/([^/]+)\/removal$/) : undefined;
  if (removalMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      let payload: { reason?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const reason = validateRemovalReason(payload.reason);
      if ('error' in reason) { json(response, 400, { error: reason.error }); return; }
      // Only a moderator removes content, and only while it is still visible.
      const comment = await getComment(removalMatch[1]);
      if (!comment) { json(response, 404, { error: 'comment_not_found' }); return; }
      const removal = checkRemoval({ status: comment.status, role: user.role });
      if (!removal.ok) {
        json(response, removal.error === 'moderator_required' ? 403 : 409, { error: removal.error });
        return;
      }
      try {
        await removeComment({ commentId: removalMatch[1], actorId: user.id, reason: reason.reason });
        json(response, 200, { status: 'removed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'comment_not_found') { json(response, 404, { error: 'comment_not_found' }); return; }
        if (message === 'comment_already_removed') { json(response, 409, { error: 'comment_already_removed' }); return; }
        json(response, 503, { error: 'comments_unavailable' });
      }
    });
    return;
  }

  const newExplanationMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/explanation$/) : undefined;
  if (newExplanationMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    (async () => {
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      const finding = await getFinding(newExplanationMatch[1]);
      if (!finding) { json(response, 404, { error: 'finding_not_found' }); return; }
      const evidence = await getEvidence(finding.evidenceId);
      if (!evidence) { json(response, 404, { error: 'evidence_not_found' }); return; }
      const explanation = await explainer.explain({
        recipe: evidence.recipe, recipeVersion: evidence.recipeVersion, filters: evidence.filters,
        inputRows: evidence.inputRows, outputRows: evidence.outputRows, validation: evidence.validation,
        warnings: evidence.warnings, limitations: evidence.limitations, result: evidence.result,
      });
      // The generated text is stored beside the evidence, never attached to it.
      const record = await saveExplanation({
        findingId: finding.id, text: explanation.text, source: explanation.source,
        provider: explanation.provider, model: explanation.model, templateVersion: explanation.templateVersion,
      });
      json(response, 201, record);
    })().catch(() => json(response, 503, { error: 'explanation_unavailable' }));
    return;
  }

  const explanationMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/explanation$/) : undefined;
  if (explanationMatch) {
    getLatestExplanation(explanationMatch[1]).then((record) => json(response, 200, { explanation: record ?? null })).catch(() => json(response, 503, { error: 'explanation_unavailable' }));
    return;
  }

  const historyMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/history$/) : undefined;
  if (historyMatch) {
    listTransitions(historyMatch[1]).then((transitions) => json(response, 200, { transitions })).catch(() => json(response, 503, { error: 'review_history_unavailable' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/agencies') {
    listAgencies().then((agencies) => json(response, 200, { agencies })).catch(() => json(response, 503, { error: 'agency_catalog_unavailable' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/connectors') {
    latestConnectorChecks().then((checks) => {
      const latest = new Map(checks.map((check) => [check.connector, check]));
      json(response, 200, {
        connectors: connectors.map((connector) => ({
          id: connector.id, name: connector.name, protocol: connector.protocol, kind: connector.kind,
          externalBenchmark: connector.externalBenchmark === true,
          last_check: latest.get(connector.id) ?? null,
        })),
      });
    }).catch(() => json(response, 503, { error: 'connector_log_unavailable' }));
    return;
  }

  const connectorCheckMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/connectors\/([^/]+)\/check$/) : undefined;
  if (connectorCheckMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    (async () => {
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      if (user.role !== 'maintainer') { json(response, 403, { error: 'maintainer_required' }); return; }
      const connector = getConnector(connectorCheckMatch[1]);
      if (!connector) { json(response, 404, { error: 'connector_not_found' }); return; }
      let status: 'ok' | 'failed' = 'ok';
      let httpStatus: number | null = null;
      let datasetCount: number | null = null;
      let message = '';
      try {
        const listing = await connector.listDatasets(fetch);
        // A scraped source is probed, so its real HTTP status is recorded; a status of
        // 200 with no datasets is reported as such rather than as success with data.
        httpStatus = listing.httpStatus;
        datasetCount = listing.datasets.length;
        message = connector.kind === 'scraped' ? `scraped source; ${datasetCount} dataset link${datasetCount === 1 ? '' : 's'} found` : '';
      } catch (error) {
        status = 'failed';
        message = error instanceof Error ? error.message : String(error);
        // Each adapter names the connector and the HTTP status in its message.
        const named = /HTTP (\d{3})/.exec(message);
        httpStatus = named ? Number(named[1]) : null;
      }
      // The row is written for a failure too: an unreadable portal is reported, not hidden.
      await insertConnectorCheck({ connector: connector.id, status, httpStatus, datasetCount, message });
      json(response, status === 'ok' ? 200 : 502, { connector: connector.id, status, dataset_count: datasetCount, http_status: httpStatus, message });
    })().catch(() => json(response, 503, { error: 'connector_log_unavailable' }));
    return;
  }

  const pinMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/connectors\/([^/]+)\/pin$/) : undefined;
  if (pinMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      if (user.role !== 'maintainer') { json(response, 403, { error: 'maintainer_required' }); return; }
      const connector = getConnector(pinMatch[1]);
      if (!connector) { json(response, 404, { error: 'connector_not_found' }); return; }
      let payload: { dataset_id?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')) as { dataset_id?: unknown }; }
      catch { json(response, 400, { error: 'invalid_json' }); return; }
      if (typeof payload.dataset_id !== 'string' || !payload.dataset_id.trim()) { json(response, 400, { error: 'dataset_id_required' }); return; }
      const datasetId = payload.dataset_id;

      let pinned: Awaited<ReturnType<typeof connector.fetchDataset>>;
      try { pinned = await connector.fetchDataset(datasetId, fetch); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (connector.kind === 'scraped') { json(response, 400, { error: 'scraped_source', message }); return; }
        const named = /HTTP (\d{3})/.exec(message);
        await insertConnectorCheck({ connector: connector.id, status: 'failed',
          httpStatus: named ? Number(named[1]) : null, datasetCount: null, message }).catch(() => undefined);
        json(response, 502, { error: 'connector_fetch_failed', message });
        return;
      }

      const bytes = Buffer.from(pinned.bytes);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const key = releaseKey(connector.id, datasetId, checksum);
      let storeResponse: Response;
      try {
        storeResponse = await workerFetch(`${workerUrl}/store-release?key=${encodeURIComponent(key)}&sha256=${checksum}`,
          { method: 'POST', body: bytes as unknown as BodyInit });
      } catch { json(response, 502, { error: 'release_store_failed', message: 'worker_unavailable' }); return; }
      // A 409 names the same content-addressed key, so the immutable bytes are
      // already present and the pin can continue without a second write.
      if (!storeResponse.ok && storeResponse.status !== 409) {
        json(response, 502, { error: 'release_store_failed', message: workerMessage(await storeResponse.text()) });
        return;
      }

      let normalized: Awaited<ReturnType<typeof normalizeReleaseRows>>;
      try { normalized = await normalizeReleaseRows(pinned.filename, bytes); }
      catch (error) {
        json(response, 502, { error: 'release_rows_parse_failed', message: error instanceof Error ? error.message : String(error) });
        return;
      }

      try {
        const existing = await findPinnedRelease(connector.id, datasetId, checksum);
        if (existing) {
          // A release pinned before row storage existed has no queryable rows, and a
          // silent no-op would leave it permanently unjoinable.
          const rowCount = await countReleaseRows(existing);
          if (rowCount > 0) { json(response, 200, { release_id: existing, already_pinned: true, rows: rowCount }); return; }
          for (const page of normalized.pages) await saveReleaseRows(existing, page.offset, page.rows);
          const stored = await countReleaseRows(existing);
          json(response, 200, { release_id: existing, already_pinned: true, rows: stored, rows_backfilled: true });
          return;
        }
        const status = licenceStatus(pinned.licence);
        const releaseId = await insertPinnedRelease({
          connectorId: connector.id, datasetId, checksum, licenceStatus: status,
          licence: pinned.licence, attribution: pinned.attribution, name: pinned.name, sourceUrl: connector.baseUrl,
          metadata: { schema: inferReleaseSchema(pinned.bytes, pinned.format), description: pinned.description,
            filename: pinned.filename, format: pinned.format, releaseKey: key,
            ...(normalized.truncated ? { rowsTruncated: true } : {}) },
          rows: normalized.pages,
        });
        json(response, 201, { release_id: releaseId, already_pinned: false,
          summary: pinSummary(connector.id, datasetId, bytes.length, status) });
      } catch { json(response, 503, { error: 'pin_unavailable' }); }
    }).catch(() => json(response, 503, { error: 'pin_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/runs') {
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      let payload: { release_ids?: unknown; left_key?: unknown; right_key?: unknown; filters?: unknown; options?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const releaseIds = Array.isArray(payload.release_ids) ? payload.release_ids.filter((id): id is string => typeof id === 'string') : [];
      if (releaseIds.length < 1 || releaseIds.length > 2) { json(response, 400, { error: 'release_ids_required', message: 'a run analyses one release or joins exactly two' }); return; }
      const rowsByRelease = await Promise.all(releaseIds.map(async (id) => ({ id, rows: await getReleaseRows(id, 50_000) })));
      for (const entry of rowsByRelease) {
        if (!entry.rows.length) { json(response, 400, { error: 'release_not_pinned', message: `release ${entry.id} has no stored rows; pin it first` }); return; }
      }

      let rows: Array<Record<string, unknown>>;
      let columns: RecipeColumn[];
      if (rowsByRelease.length === 2) {
        if (typeof payload.left_key !== 'string' || typeof payload.right_key !== 'string') {
          json(response, 400, { error: 'join_keys_required', message: 'a two-release run needs left_key and right_key' });
          return;
        }
        const [left, right] = rowsByRelease;
        const leftColumns = schemaColumns(await getReleaseRowSchema(left.id));
        const rightColumns = schemaColumns(await getReleaseRowSchema(right.id));
        const planned = planJoin({ relationship: { id: 'ad-hoc', primaryReleaseId: left.id, relatedReleaseId: right.id,
          joinKeys: [payload.left_key], status: 'validated' }, primaryReleaseId: left.id, relatedReleaseId: right.id });
        if (!planned.ok) { json(response, 409, { error: planned.error }); return; }
        const plan = planTwoWayJoin({ left: { label: left.id, columns: leftColumns, rows: left.rows, grain: 'row' },
          right: { label: right.id, columns: rightColumns, rows: right.rows, grain: 'row' },
          leftKey: payload.left_key, rightKey: payload.right_key });
        if (!plan.ok) { json(response, 400, { error: plan.error, message: plan.message }); return; }
        const joined = executeJoin(plan.plan, left.rows, right.rows);
        const limited = limitJoinedRows(joined.rows);
        if (limited.rows.length !== joined.rows.length) { json(response, 413, { error: 'join_too_large', rows: joined.rows.length, limit: 50_000 }); return; }
        rows = limited.rows;
        columns = joinedSchema(leftColumns, rightColumns, payload.left_key) as RecipeColumn[];
      } else {
        rows = rowsByRelease[0].rows;
        columns = schemaColumns(await getReleaseRowSchema(rowsByRelease[0].id));
      }

      const selection = selectInsights(columns);
      const options = (payload.options && typeof payload.options === 'object' ? payload.options : {}) as RecipeOptions;
      const runId = await insertRun({ connectorIds: [], releaseIds, filters: (payload.filters && typeof payload.filters === 'object' ? payload.filters : {}) as Record<string, unknown>, selection });
      const executed = runAllApplicable(selection, rows, columns, options);
      const insights = [];
      for (const result of executed.results) {
        const id = await insertInsight({ runId, recipe: result.recipe, releaseId: releaseIds[0]!, recipeVersion: result.recipeVersion, status: 'ok' });
        insights.push({ id, recipe: result.recipe, status: 'ok', result: result.result, calculation: result.calculation, warnings: result.warnings, evidence_id: null });
      }
      for (const skip of executed.skipped) {
        const id = await insertInsight({ runId, recipe: skip.recipe, releaseId: releaseIds[0]!, recipeVersion: 'generic-v1', status: 'skipped', reason: skip.reason });
        insights.push({ id, recipe: skip.recipe, status: 'skipped', reason: skip.reason });
      }
      json(response, 201, { run_id: runId, selection, insights,
        summary: `${insights.filter((insight) => insight.status === 'ok').length} insights produced, ${executed.skipped.length} skipped` });
    }).catch(() => json(response, 503, { error: 'run_unavailable' }));
    return;
  }

  const runMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/runs\/([^/]+)$/) : undefined;
  if (runMatch) {
    getRun(runMatch[1]).then((found) => found ? json(response, 200, found) : json(response, 404, { error: 'run_not_found' }))
      .catch(() => json(response, 503, { error: 'run_unavailable' }));
    return;
  }

  const savedViewsMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/saved-views(?:\?(.*))?$/) : undefined;
  if (savedViewsMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    const page = paginationFor(request.url);
    if ('error' in page) { json(response, 400, { error: 'invalid_pagination' }); return; }
    auth.session(requestSessionToken(request)).then(async (user) => {
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      json(response, 200, { views: paginate(await listSavedViews(user.id), page) });
    }).catch(() => json(response, 503, { error: 'saved_views_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/saved-views') {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      let payload: { name?: unknown; datasetReleaseId?: unknown; filters?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      if (typeof payload.name !== 'string' || !payload.name.trim()) { json(response, 400, { error: 'name_required' }); return; }
      if (typeof payload.datasetReleaseId !== 'string') { json(response, 400, { error: 'dataset_release_id_required' }); return; }
      if (!payload.filters || typeof payload.filters !== 'object' || Array.isArray(payload.filters)) { json(response, 400, { error: 'filters_required' }); return; }
      if (!await datasetReleaseExists(payload.datasetReleaseId)) { json(response, 404, { error: 'dataset_release_not_found' }); return; }
      const view = await createSavedView({ userId: user.id, name: payload.name.trim(), datasetReleaseId: payload.datasetReleaseId, filters: payload.filters as Record<string, unknown> });
      json(response, 201, view);
    }).catch(() => json(response, 503, { error: 'saved_views_unavailable' }));
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
      const workerResponse = await workerFetch(`${workerUrl}/preview${previewMatch[2] ? `?${previewMatch[2]}` : ''}`);
      response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(await workerResponse.text());
    })().catch(() => json(response, 503, { error: 'analysis_worker_unavailable' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/imports/drafts') { json(response, 200, { releases: listDraftReleases() }); return; }

  const publishMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/imports\/([^/]+)\/publish$/) : undefined;
  if (publishMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      if (user.role !== 'maintainer') { json(response, 403, { error: 'maintainer_required' }); return; }
      let payload: { reason?: unknown; metadata?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const reason = validateReason(payload.reason);
      if ('error' in reason) { json(response, 400, { error: reason.error }); return; }
      if (!payload.metadata || typeof payload.metadata !== 'object') { json(response, 400, { error: 'invalid_metadata' }); return; }
      const metadata = validateMetadata(payload.metadata as PublicationMetadata);
      if (!metadata.ok) { json(response, 400, { error: 'invalid_metadata', fields: metadata.errors }); return; }
      try {
        const draft = await getImportDraft(publishMatch[1]);
        if (!draft) { json(response, 404, { error: 'draft_not_found' }); return; }
        const published = await publishImportDraft({ publicId: draft.publicId, actorId: user.id, reason: reason.reason,
          metadata: payload.metadata as { publisher: string; sourceUrl: string; license: string; coverage: unknown; fields: unknown; limitations: unknown } });
        json(response, 201, { draft: published.draft, release_id: published.releaseId });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'draft_not_found') { json(response, 404, { error: code }); return; }
        if (code === 'draft_not_validated' || code === 'already_published') { json(response, 409, { error: code }); return; }
        json(response, 503, { error: 'publication_unavailable' });
      }
    }).catch(() => json(response, 503, { error: 'publication_unavailable' }));
    return;
  }

  const registerMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/imports\/register\?filename=([^&]+)&name=([^&]+)$/) : undefined;
  if (registerMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    // A draft has an owner, so anonymous uploads are refused before any body is read.
    auth.session(requestSessionToken(request)).then(async (user) => {
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      const filename = decodeURIComponent(registerMatch[1]);
      const name = decodeURIComponent(registerMatch[2]);
      const release = uploads.tryAcquire();
      if (!release) { uploadBusy(response); return; }
      const incoming = await readBoundedBody(request, maxUploadBytes).finally(release);
      if ('denied' in incoming) { json(response, 413, { error: 'dataset_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      const upload = checkUpload({ filename, bytes: incoming.data.length });
      if (!upload.ok) { json(response, 400, { error: upload.error }); return; }
      try {
        const workerResponse = await workerFetch(`${workerUrl}/validate-import?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: incoming.data as unknown as BodyInit });
        if (!workerResponse.ok) { response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(await workerResponse.text()); return; }
        // The worker owns the validation shape; the API only reads its row count.
        const validation = (await workerResponse.json()) as { rows?: unknown; status?: unknown; checks?: unknown };
        const rows = typeof validation.rows === 'number' ? validation.rows : 0;
        const rowCheck = checkRows(rows);
        const quarantineReason: QuarantineReason | undefined = !rowCheck.ok
          ? (rowCheck.error === 'too_many_rows' ? 'row_limit_exceeded' : 'schema_invalid')
          : undefined;
        const draft = await registerDraftRelease(name, filename, incoming.data, {
          submittedBy: user.id, format: upload.format, rows,
          validationStatus: validation.status === 'Fail' || quarantineReason ? 'Fail' : 'Pass',
          checks: Array.isArray(validation.checks) ? validation.checks.filter((item): item is string => typeof item === 'string') : [],
          quarantineReason,
        });
        const normalizedRows = draft.status === 'quarantined' || rows === 0 ? 0 : await normalizeDraft(filename, incoming.data, draft.id);
        json(response, 201, { ...draft, visibility: 'private-draft', checkRows: rowCheck.ok ? 'ok' : rowCheck.error, normalized_rows: normalizedRows, validation });
      } catch { json(response, 503, { error: 'draft_registration_unavailable' }); }
    }).catch(() => json(response, 503, { error: 'accounts_unavailable' }));
    return;
  }

  const importMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/imports\/validate\?filename=([^&]+)$/) : undefined;
  if (importMatch) {
    const release = uploads.tryAcquire();
    if (!release) { uploadBusy(response); return; }
    readBoundedBody(request, maxUploadBytes).finally(release).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'dataset_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      try {
        const filename = decodeURIComponent(importMatch[1]);
      const upload = checkUpload({ filename, bytes: incoming.data.length });
      if (!upload.ok) { json(response, 400, { error: upload.error }); return; }
      const workerResponse = await workerFetch(`${workerUrl}/validate-import?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: incoming.data as unknown as BodyInit });
        response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(await workerResponse.text());
      } catch { json(response, 503, { error: 'import_worker_unavailable' }); }
    });
    return;
  }

  const refreshMatch = request.method === 'POST' ? request.url?.match(/^\/api\/v1\/datasets\/([^/]+)\/refresh-check$/) : undefined;
  if (refreshMatch) {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    (async () => {
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      if (user.role !== 'maintainer') { json(response, 403, { error: 'maintainer_required' }); return; }
      const previous = await getReleaseFingerprint(refreshMatch[1]);
      if (!previous) { json(response, 404, { error: 'dataset_release_not_found' }); return; }
      const sourceUrl = process.env.SOURCE_REFRESH_URL;
      if (!sourceUrl) { json(response, 503, { error: 'source_check_unavailable' }); return; }
      const bytes = await readSourceBytes(sourceUrl);
      const sourceChecksum = bytes ? createHash('sha256').update(bytes).digest('hex') : undefined;
      const status = classifyCheck(previous.checksum, sourceChecksum);
      // shortcut: only JSON snapshots describe coverage drift; other bytes are
      // checkable by checksum alone until the source publishes a schema.
      let current: ReleaseFingerprint = { ...previous };
      if (bytes && sourceChecksum) {
        try { current = sourceFingerprint(JSON.parse(bytes.toString('utf8')), sourceChecksum); }
        catch { current = { ...previous, checksum: sourceChecksum }; }
      }
      const drift = computeDrift(previous, current);
      const summary = summarise(drift);
      await insertReleaseCheck({
        releaseId: refreshMatch[1], status, sourceChecksum: sourceChecksum ?? null,
        previousChecksum: previous.checksum, drift,
        note: status === 'unreachable' ? 'source could not be read' : '',
      });
      json(response, 200, { status, drift, summary });
    })().catch(() => json(response, 503, { error: 'refresh_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/datasets/bettergov-gaa-coverage-2026-11-07/import') {
    workerFetch(`${workerUrl}/records`).then(async (workerResponse) => {
      if (!workerResponse.ok) { json(response, 503, { error: 'coverage_release_unavailable' }); return; }
      const rows = await workerResponse.json() as Array<{ DatasetReleaseID: string; FiscalYear: number; CoverageStatus: string; SourceRowCount: number; AmountPesos?: number; Scopes?: Record<string, unknown>; Notes: string[] }>;
      const imported = await saveNormalizedCoverage(rows, catalog[0]);
      json(response, 200, { dataset_release_id: 'bettergov-gaa-coverage-2026-11-07', imported_rows: imported, status: 'validated' });
    }).catch((error) => { console.error(error); json(response, 503, { error: 'normalized_import_unavailable' }); });
    return;
  }

  // Public, like /api/v1/join/analyze: it reads pinned snapshots, not accounts.
  if (request.method === 'POST' && request.url === '/api/v1/join/run') {
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      let payload: unknown;
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { json(response, 400, { error: 'invalid_join_request' }); return; }
      const body = payload as Record<string, unknown>;
      const field = (name: string) => typeof body[name] === 'string' && (body[name] as string).trim() ? body[name] as string : undefined;
      const leftReleaseId = field('left_release_id');
      const rightReleaseId = field('right_release_id');
      const leftKey = field('left_key');
      const rightKey = field('right_key');
      if (!leftReleaseId || !rightReleaseId || !leftKey || !rightKey) { json(response, 400, { error: 'invalid_join_request' }); return; }

      let aggregation: Aggregation | undefined;
      if (body.aggregation !== undefined) {
        const raw = body.aggregation;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { json(response, 400, { error: 'invalid_join_request' }); return; }
        const candidate = raw as Record<string, unknown>;
        const functions: Aggregation['fn'][] = ['sum', 'count', 'mean', 'min', 'max'];
        if (typeof candidate.column !== 'string' || typeof candidate.targetGrain !== 'string' || !functions.some((fn) => fn === candidate.fn)) {
          json(response, 400, { error: 'invalid_join_request' }); return;
        }
        aggregation = { column: candidate.column, fn: candidate.fn as Aggregation['fn'], targetGrain: candidate.targetGrain };
      }

      const [leftExists, rightExists] = await Promise.all([datasetReleaseExists(leftReleaseId), datasetReleaseExists(rightReleaseId)]);
      if (!leftExists || !rightExists) { json(response, 404, { error: 'release_not_found' }); return; }
      const [leftCount, rightCount] = await Promise.all([countReleaseRows(leftReleaseId), countReleaseRows(rightReleaseId)]);
      if (!leftCount || !rightCount) { json(response, 400, { error: 'release_not_pinned' }); return; }
      const [leftRows, rightRows, leftSchema, rightSchema] = await Promise.all([
        getReleaseRows(leftReleaseId), getReleaseRows(rightReleaseId),
        getReleaseRowSchema(leftReleaseId), getReleaseRowSchema(rightReleaseId),
      ]);
      const planned = planTwoWayJoin({
        left: { label: leftReleaseId, grain: grainFromSchema(leftSchema), columns: columnsFromSchema(leftSchema), rows: leftRows },
        right: { label: rightReleaseId, grain: grainFromSchema(rightSchema), columns: columnsFromSchema(rightSchema), rows: rightRows },
        leftKey, rightKey, aggregation,
      });
      if (!planned.ok) { json(response, 400, { error: planned.error, message: planned.message }); return; }

      const { rows, diagnostics } = executeJoin(planned.plan, leftRows, rightRows);
      const limited = limitJoinedRows(rows, maxJoinedRows);
      if (limited.truncated) {
        json(response, 413, { error: 'join_result_too_large', row_count: rows.length, row_limit: maxJoinedRows,
          left_rows: leftRows.length, right_rows: rightRows.length });
        return;
      }
      json(response, 200, { diagnostics, rows: limited.rows, truncated: limited.truncated,
        schema: joinedSchema(columnsFromSchema(leftSchema), columnsFromSchema(rightSchema), planned.plan.rightKey) });
    }).catch(() => json(response, 503, { error: 'join_run_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/join/analyze') {
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      let payload: { relationship_id?: unknown };
      try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
      const relationshipId = typeof payload.relationship_id === 'string' ? payload.relationship_id : '11111111-2222-3333-4444-555555555555';
      const relationship = await getRelationship(relationshipId);
      if (!relationship) { json(response, 404, { error: 'relationship_not_found' }); return; }
      const planned = planJoin({ relationship: relationship as Relationship,
        primaryReleaseId: relationship.primaryReleaseId, relatedReleaseId: relationship.relatedReleaseId });
      if (!planned.ok) { json(response, 409, { error: planned.error }); return; }
      const [leftRows, rightRows] = await Promise.all([getJoinRows(relationship.primaryReleaseId), getJoinRows(relationship.relatedReleaseId)]);
      const workerBody = { recipe: 'joined_summary', keys: planned.plan.joinKeys, left_rows: leftRows, right_rows: rightRows };
      const callWorker = () => workerFetch(`${workerUrl}/analyze-join`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workerBody),
      });
      const firstResponse = await callWorker();
      const firstText = await firstResponse.text();
      if (!firstResponse.ok) { response.writeHead(firstResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(firstText); return; }
      const first = JSON.parse(firstText) as { result?: unknown; validation?: { status?: string; checks?: string[] }; warnings?: string[]; limitations?: string[]; recipe_version?: string };
      const replayResponse = await callWorker();
      if (!replayResponse.ok) { json(response, 503, { error: 'reproducibility_rerun_unavailable', reproducibility_status: 'Not run' }); return; }
      const replay = (await replayResponse.json()) as unknown;
      if (!isDeepStrictEqual(first, replay)) { json(response, 422, { error: 'reproducibility_mismatch', reproducibility_status: 'Failed' }); return; }
      const result = first.result ?? {};
      const matched = (result as { matched_rows?: number }).matched_rows ?? 0;
      const evidence = await saveJoinedRun({
        relationshipId: relationship.id,
        evidence: {
          datasetReleaseId: relationship.primaryReleaseId,
          recipe: 'joined_summary',
          recipeVersion: String(first.recipe_version ?? 'joined-v1'),
          filters: { relationship_id: relationship.id, related_release_id: relationship.relatedReleaseId, join_keys: planned.plan.joinKeys },
          result, inputRows: leftRows.length + rightRows.length, outputRows: matched,
          releaseChecksum: catalog[0].checksum,
          calculation: 'Equi-join on curated explicit keys with unmatched and duplicate-key diagnostics.',
          validation: { status: first.validation?.status ?? 'Not run', checks: [...(first.validation?.checks ?? []), 'deterministic rerun matched'] },
          warnings: [...(first.warnings ?? [])], limitations: [...(first.limitations ?? []), ...joinLimitations],
          reproducibilityStatus: 'Passed',
        },
        diagnostics: result,
        result,
      });
      json(response, 200, { ...result, evidence_id: evidence.id, analysis_run_id: evidence.id,
        relationship_id: relationship.id, reproducibility_status: 'Passed', validation: first.validation,
        warnings: first.warnings, limitations: first.limitations });
    }).catch(() => json(response, 503, { error: 'joined_analysis_unavailable' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/analyze') {
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      try {
        let payload: unknown;
        try { payload = JSON.parse(incoming.data.toString('utf8')); } catch { json(response, 400, { error: 'invalid_json' }); return; }
        if (!payload || typeof payload !== 'object' || !('recipe' in payload) || typeof payload.recipe !== 'string') { json(response, 400, { error: 'recipe_required' }); return; }
        const requestBody = payload as Record<string, unknown>;
        const allowedRecipes = new Set(['summary', 'compare', 'rank', 'distribution', 'change_over_time']);
        if (!allowedRecipes.has(payload.recipe)) { json(response, 400, { error: 'unsupported_recipe' }); return; }
        const rawYear = requestBody.year;
        if (rawYear !== undefined && (typeof rawYear !== 'number' || !Number.isInteger(rawYear) || rawYear < 2000 || rawYear > 2026)) { json(response, 400, { error: 'year_must_be_between_2000_and_2026' }); return; }
        const year = typeof rawYear === 'number' ? rawYear : undefined;
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
        const analyzeOnce = () => workerFetch(`${workerUrl}/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(workerBody),
        });
        const workerResponse = await analyzeOnce();
        const body = await workerResponse.text();
        if (!workerResponse.ok) { response.writeHead(workerResponse.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(body); return; }
        const result = JSON.parse(body) as WorkerAnalysisResponse;
        const replayResponse = await analyzeOnce();
        if (!replayResponse.ok) { json(response, 503, { error: 'reproducibility_rerun_unavailable', validation: { status: 'Not run', checks: ['second execution unavailable'] }, reproducibility_status: 'Not run' }); return; }
        // The replay is compared structurally with the first result, so it is read as
        // unknown-shaped JSON rather than being trusted as a typed response.
        const replay = (await replayResponse.json()) as WorkerAnalysisResponse;
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
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    readBoundedBody(request, maxJsonBytes).then(async (incoming) => {
      if ('denied' in incoming) { json(response, 413, { error: 'request_too_large' }); return; }
      if ('failed' in incoming) { json(response, 400, { error: 'invalid_request_body' }); return; }
      // Submission is an authenticated act: the author is recorded and the
      // finding starts Unverified, exactly like every other source.
      const user = await auth.session(requestSessionToken(request));
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      try {
        const payload = JSON.parse(incoming.data.toString('utf8')) as { evidence_id?: unknown; claim?: unknown };
        if (typeof payload.evidence_id !== 'string') { json(response, 400, { error: 'evidence_id_required' }); return; }
        const claim = validateClaim(payload.claim);
        if ('error' in claim) { json(response, 400, { error: claim.error }); return; }
        const evidence = await getEvidence(payload.evidence_id);
        if (!evidence) { json(response, 404, { error: 'evidence_not_found' }); return; }
        // Impact is derived from the evidence, never chosen by the submitter.
        const release = catalog.find((item) => item.id === evidence.datasetReleaseId);
        const impact = deriveImpact({ filters: evidence.filters, totalYears: release?.coverage.fiscalYears.length ?? 0 });
        json(response, 201, await createFinding(evidence.id, user.id, impact, claim.claim));
      } catch { json(response, 400, { error: 'invalid_json' }); }
    });
    return;
  }

  const findingPageMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/page$/) : undefined;
  if (findingPageMatch) {
    getFinding(findingPageMatch[1]).then(async (finding) => {
      if (!finding) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Finding not found'); return; }
      const evidence = await getEvidence(finding.evidenceId);
      const transitions = await listTransitions(finding.id).catch(() => []);
      const comments = await listComments(finding.id).catch(() => []);
      const conflicts = await listConflicts(finding.id).catch(() => []);
      const explanation = await getLatestExplanation(finding.id).catch(() => undefined);
      const dataset = catalog.find((item) => item.id === evidence?.datasetReleaseId);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const details = evidence ? `<section aria-labelledby="evidence-heading"><h2 id="evidence-heading">Evidence</h2><dl><dt>Dataset</dt><dd>${escapeHtml(dataset?.name ?? evidence.datasetReleaseId)}</dd><dt>Source</dt><dd>${dataset ? `<a href="${escapeHtml(dataset.sourceUrl)}">${escapeHtml(dataset.sourceUrl)}</a>` : escapeHtml(evidence.datasetReleaseId)}</dd><dt>Release</dt><dd><code>${escapeHtml(evidence.datasetReleaseId)}</code></dd><dt>SHA-256</dt><dd><code>${escapeHtml(evidence.releaseChecksum)}</code></dd><dt>Recipe</dt><dd>${escapeHtml(evidence.recipe)} v${escapeHtml(evidence.recipeVersion)}</dd><dt>Calculation</dt><dd>${escapeHtml(evidence.calculation)}</dd><dt>Filters</dt><dd><pre>${escapeHtml(JSON.stringify(evidence.filters, null, 2))}</pre></dd><dt>Rows</dt><dd>${evidence.inputRows} input, ${evidence.outputRows} output</dd><dt>Reproducibility</dt><dd>${escapeHtml(evidence.reproducibilityStatus)}</dd><dt>Validation</dt><dd><pre>${escapeHtml(JSON.stringify(evidence.validation, null, 2))}</pre></dd></dl><h3>Result</h3><pre>${escapeHtml(JSON.stringify(evidence.result, null, 2))}</pre><h3>Warnings</h3><ul>${evidence.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul><h3>Limitations</h3><ul>${evidence.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('')}</ul></section>` : '<p>Evidence unavailable.</p>';
      const explanationSection = explanation
        ? `<section aria-labelledby="explanation-heading"><h2 id="explanation-heading">Explanation</h2><p>${escapeHtml(explanation.text)}</p><p><small>${explanation.source === 'llm' ? `From a model (${escapeHtml(explanation.provider ?? 'unknown')} / ${escapeHtml(explanation.model ?? 'unknown')})` : 'From the deterministic template'}, template version ${escapeHtml(explanation.templateVersion)}.</small></p></section>`
        : '';
      // A reviewed finding must never be described as unreviewed: the status is what a
      // reader came to check, and the history below is its record.
      const awaitingReview = ['Unverified', 'Pending verification', 'In review'].includes(finding.status);
      const reviewedNote = awaitingReview
        ? 'This is an analysis candidate; it has not been human-reviewed.'
        : `A reviewer recorded <strong>${escapeHtml(finding.status)}</strong>; the review history below is the record of that judgement.`;
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(finding.status)} finding · Saysight</title><style>body{margin:0 auto;max-width:60rem;padding:1rem;font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}dd{margin:0 0 .75rem}a{overflow-wrap:anywhere}</style></head><body><main><h1>${escapeHtml(finding.status)} finding</h1><p>${reviewedNote}</p><p>Status: <strong>${escapeHtml(finding.status)}</strong> · Review depth: ${escapeHtml(finding.impact)}</p>${finding.claim ? `<p><strong>Claim:</strong> ${escapeHtml(finding.claim)}</p>` : ''}${conflicts.length ? `<p><strong>Reviewers disagreed</strong>: ${conflicts.map((conflict) => escapeHtml(conflict.statuses.join(' vs '))).join('; ')} — both positions are recorded in the history.</p>` : ''}${transitions.length ? `<section aria-labelledby="history-heading"><h2 id="history-heading">Review history</h2><ol>${transitions.map((transition) => `<li><strong>${escapeHtml(transition.toStatus)}</strong> — ${escapeHtml(transition.reason)} <small>(${escapeHtml(transition.createdAt)})</small></li>`).join('')}</ol></section>` : ''}<p>Finding ID: <code>${escapeHtml(finding.id)}</code></p><p><a href="/api/v1/evidence/${encodeURIComponent(finding.evidenceId)}">View evidence JSON</a></p>${details}${evidence ? `<p>Download: <a href="/api/v1/evidence/${encodeURIComponent(evidence.id)}/export.csv">CSV</a> · <a href="/api/v1/evidence/${encodeURIComponent(evidence.id)}/export.json">JSON</a></p>` : ''}${explanationSection}<section aria-labelledby="comments-heading"><h2 id="comments-heading">Comments</h2>${comments.length ? `<ol>${comments.map((comment) => comment.status === 'removed'
        ? `<li><em>Comment removed by a moderator</em>${comment.removalReason ? ` — ${escapeHtml(comment.removalReason)}` : ''}</li>`
        : `<li>${escapeHtml(comment.body)} <small>(${escapeHtml(comment.createdAt)})</small></li>`).join('')}</ol>` : '<p>No comments yet.</p>'}</section></main></body></html>`);
    }).catch(() => { response.writeHead(503); response.end('Finding page unavailable'); });
    return;
  }

  // Public, anonymous browse of every finding. The page route renders one finding;
  // without this a reader can only reach findings they already have ids for.
  const findingsListMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings(?:\?(.*))?$/) : undefined;
  if (findingsListMatch) {
    const params = new URLSearchParams(findingsListMatch[1] ?? '');
    const status = params.get('status');
    const limit = params.get('limit');
    const offset = params.get('offset');
    if (status !== null && !isStatus(status)) { json(response, 400, { error: 'invalid_filter', parameter: 'status' }); return; }
    if (limit !== null && !/^\d+$/.test(limit)) { json(response, 400, { error: 'invalid_filter', parameter: 'limit' }); return; }
    if (offset !== null && !/^\d+$/.test(offset)) { json(response, 400, { error: 'invalid_filter', parameter: 'offset' }); return; }
    const requested = limit === null ? publicFindingLimit : Number(limit);
    if (requested < 1 || requested > publicFindingLimit) { json(response, 400, { error: 'invalid_filter', parameter: 'limit' }); return; }
    listPublicFindings({ statuses: status === null ? undefined : [status], limit: requested, offset: offset === null ? 0 : Number(offset) })
      .then((findings) => json(response, 200, { findings }))
      .catch(() => json(response, 503, { error: 'finding_store_unavailable' }));
    return;
  }

  const findingMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)$/) : undefined;
  if (findingMatch) {
    getFinding(findingMatch[1]).then((finding) => finding ? json(response, 200, finding) : json(response, 404, { error: 'finding_not_found' })).catch(() => json(response, 503, { error: 'finding_store_unavailable' }));
    return;
  }

  const exportMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/evidence\/([^/]+)\/export\.(csv|json)$/) : undefined;
  if (exportMatch) {
    getEvidence(exportMatch[1]).then((evidence) => {
      if (!evidence) { json(response, 404, { error: 'evidence_not_found' }); return; }
      const format = exportMatch[2];
      const filename = csvFilename(evidence).replace(/\.csv$/, `.${format}`);
      response.writeHead(200, {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      });
      response.end(format === 'csv' ? toCsv(evidence) : JSON.stringify(evidence));
    }).catch(() => json(response, 503, { error: 'evidence_store_unavailable' }));
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

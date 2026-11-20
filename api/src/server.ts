import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { catalog } from './catalog.js';
import { workerFetch } from './worker.js';
import { createGate } from './gate.js';
import { createComment, createFinding, getComment, getCatalogReleases, getEvidence, getFinding, getImportDraft, getLatestExplanation, getNormalizedCoverage, listComments, listConflicts, listDecisionTransitions, listDraftReleases, listReviewQueue, listTransitions, pool, publishImportDraft, recordConflict, recordTransition, registerDraftRelease, removeComment, saveEvidence, saveExplanation, saveNormalizedCoverage } from './store.js';
import { createExplainer } from './explain.js';
import { checkRemoval, validateCommentBody, validateRemovalReason } from './comments.js';
import { checkRows, checkUpload, type QuarantineReason } from './uploadPolicy.js';
import { validateMetadata, type PublicationMetadata } from './metadata.js';
import { checkTransition, decisionStatuses, isStatus, reviewQueueStatuses, validateReason } from './review.js';
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
// input, 401 sign_in_required / invalid_or_expired_link, 403 for denied roles,
// 404 for missing records, 409 for state conflicts, 413 for capped bodies, 422
// for rejected imports, 429 upload_busy, and 503 for unavailable dependencies.
// The findings/:id/page route is HTML and returns 404 or 503 as plain text.
const maxConcurrentUploads = 2;

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

  if (request.method === 'GET' && request.url === '/api/v1/datasets') {
    getCatalogReleases().then((releases) => json(response, 200, { datasets: releases?.length ? releases : catalog })).catch(() => json(response, 503, { error: 'catalog_unavailable' }));
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

  if (request.method === 'GET' && request.url === '/api/v1/review/queue') {
    if (!auth) { json(response, 503, { error: 'accounts_unavailable' }); return; }
    auth.session(requestSessionToken(request)).then(async (user) => {
      if (!user) { json(response, 401, { error: 'sign_in_required' }); return; }
      if (user.role !== 'reviewer' && user.role !== 'maintainer') { json(response, 403, { error: 'reviewer_required' }); return; }
      // A reviewer's own submissions are excluded rather than shown and refused.
      const queue = await listReviewQueue([...reviewQueueStatuses]);
      json(response, 200, { findings: queue.filter((finding) => finding.submittedBy !== user.id) });
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

  const commentsMatch = request.method === 'GET' ? request.url?.match(/^\/api\/v1\/findings\/([^/]+)\/comments$/) : undefined;
  if (commentsMatch) {
    listComments(commentsMatch[1]).then((comments) => json(response, 200, { comments })).catch(() => json(response, 503, { error: 'comments_unavailable' }));
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
        json(response, 201, { ...draft, visibility: 'private-draft', checkRows: rowCheck.ok ? 'ok' : rowCheck.error, validation });
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

  if (request.method === 'POST' && request.url === '/api/v1/datasets/bettergov-gaa-coverage-2026-11-07/import') {
    workerFetch(`${workerUrl}/records`).then(async (workerResponse) => {
      if (!workerResponse.ok) { json(response, 503, { error: 'coverage_release_unavailable' }); return; }
      const rows = await workerResponse.json() as Array<{ DatasetReleaseID: string; FiscalYear: number; CoverageStatus: string; SourceRowCount: number; AmountPesos?: number; Scopes?: Record<string, unknown>; Notes: string[] }>;
      const imported = await saveNormalizedCoverage(rows, catalog[0]);
      json(response, 200, { dataset_release_id: 'bettergov-gaa-coverage-2026-11-07', imported_rows: imported, status: 'validated' });
    }).catch((error) => { console.error(error); json(response, 503, { error: 'normalized_import_unavailable' }); });
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
        const payload = JSON.parse(incoming.data.toString('utf8')) as { evidence_id?: unknown };
        if (typeof payload.evidence_id !== 'string') { json(response, 400, { error: 'evidence_id_required' }); return; }
        const evidence = await getEvidence(payload.evidence_id);
        if (!evidence) { json(response, 404, { error: 'evidence_not_found' }); return; }
        // Impact is derived from the evidence, never chosen by the submitter.
        const release = catalog.find((item) => item.id === evidence.datasetReleaseId);
        const impact = deriveImpact({ filters: evidence.filters, totalYears: release?.coverage.fiscalYears.length ?? 0 });
        json(response, 201, await createFinding(evidence.id, user.id, impact));
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
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unverified finding · Saysight</title><style>body{margin:0 auto;max-width:60rem;padding:1rem;font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}dd{margin:0 0 .75rem}a{overflow-wrap:anywhere}</style></head><body><main><h1>Unverified finding</h1><p>This is an analysis candidate; it has not been human-reviewed.</p><p>Status: <strong>${escapeHtml(finding.status)}</strong> · Review depth: ${escapeHtml(finding.impact)}</p>${conflicts.length ? `<p><strong>Reviewers disagreed</strong>: ${conflicts.map((conflict) => escapeHtml(conflict.statuses.join(' vs '))).join('; ')} — both positions are recorded in the history.</p>` : ''}${transitions.length ? `<section aria-labelledby="history-heading"><h2 id="history-heading">Review history</h2><ol>${transitions.map((transition) => `<li><strong>${escapeHtml(transition.toStatus)}</strong> — ${escapeHtml(transition.reason)} <small>(${escapeHtml(transition.createdAt)})</small></li>`).join('')}</ol></section>` : ''}<p>Finding ID: <code>${escapeHtml(finding.id)}</code></p><p><a href="/api/v1/evidence/${encodeURIComponent(finding.evidenceId)}">View evidence JSON</a></p>${details}${explanationSection}<section aria-labelledby="comments-heading"><h2 id="comments-heading">Comments</h2>${comments.length ? `<ol>${comments.map((comment) => comment.status === 'removed'
        ? `<li><em>Comment removed by a moderator</em>${comment.removalReason ? ` — ${escapeHtml(comment.removalReason)}` : ''}</li>`
        : `<li>${escapeHtml(comment.body)} <small>(${escapeHtml(comment.createdAt)})</small></li>`).join('')}</ol>` : '<p>No comments yet.</p>'}</section></main></body></html>`);
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

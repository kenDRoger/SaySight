import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import test, { after, before, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const apiDir = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl = 'postgres://saysight:saysight-dev-only@localhost:5432/saysight';
const workerUrl = 'http://127.0.0.1:8080';
const maintainerEmail = `maintainer-${randomUUID()}@example.test`;
const logPrefix = 'magic link for ';

let baseUrl = '';
let child: ChildProcess | undefined;
let stderrTail = '';
const stdoutLines: string[] = [];
let stdoutChunk = '';
let databaseReachable = false;
let evidenceId: string | undefined;

type ApiOptions = { cookie?: string; method?: string; body?: unknown; accept?: string };
type User = { id: string; email: string; role: string };
type Account = { email: string; cookie: string; user: User };
type Finding = { id: string; evidenceId: string; status: string; impact: string; claim: string | null; submittedBy: string | null };

const uniqueEmail = (label: string) => `${label}-${randomUUID()}@example.test`;

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function httpReachable(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a free port');
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const exited = (child?.exitCode !== null && child?.exitCode !== undefined) || (child?.signalCode !== null && child?.signalCode !== undefined);
    if (exited) throw new Error(`API exited early: ${stderrTail}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* the child is still starting */ }
    await sleep(50);
  }
  throw new Error(`API did not become healthy: ${stderrTail}`);
}

function ready(t: TestContext, needsEvidence = false): boolean {
  if (!databaseReachable) { t.skip('PostgreSQL is not reachable at localhost:5432'); return false; }
  if (needsEvidence && !evidenceId) {
    t.skip(`the analysis worker is not reachable at ${workerUrl}, so POST /api/v1/analyze cannot provide evidence`);
    return false;
  }
  return true;
}

async function api(path: string, options: ApiOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.accept) headers.accept = options.accept;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const url = /^https?:\/\//.test(path) ? path : `${baseUrl}${path}`;
  return fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const responseText = async (response: Response) => response.text();
const responseJson = async <T>(response: Response): Promise<T> => JSON.parse(await response.text()) as T;

async function requestMagicLink(email: string): Promise<string> {
  const response = await api('/api/v1/auth/magic-link', { method: 'POST', body: { email } });
  const text = await responseText(response);
  assert.equal(response.status, 202, text);
  assert.deepEqual(JSON.parse(text) as unknown, { status: 'pending' });
  const prefix = `${logPrefix}${email}: `;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const line = stdoutLines.find((candidate) => candidate.startsWith(prefix));
    if (line) {
      const link = line.slice(prefix.length).trim();
      assert.match(link, /\/api\/v1\/auth\/verify\?token=/);
      return link;
    }
    await sleep(20);
  }
  assert.fail(`no magic link for ${email} appeared on API stdout`);
}

async function verify(link: string): Promise<{ cookie: string; user: User }> {
  const response = await api(link, { accept: 'application/json' });
  const text = await responseText(response);
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as { user: User };
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'verify must set a session cookie');
  return { cookie, user: body.user };
}

async function signIn(label: string, email = uniqueEmail(label)): Promise<Account> {
  const link = await requestMagicLink(email);
  const { cookie, user } = await verify(link);
  assert.equal(user.email, email);
  return { email, cookie, user };
}

let cachedMaintainer: Account | undefined;
const maintainer = async () => (cachedMaintainer ??= await signIn('maintainer', maintainerEmail));

function promote(email: string, role: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['scripts/promote.mjs', email, role], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`promote failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

async function reviewer(): Promise<Account> {
  const account = await signIn('reviewer');
  await promote(account.email, 'reviewer');
  const response = await api('/api/v1/auth/me', { cookie: account.cookie });
  const body = await responseJson<{ user: User }>(response);
  assert.equal(response.status, 200);
  assert.equal(body.user.role, 'reviewer');
  return account;
}

const findingClaim = 'FY2024 appropriations match the published release for this scope';

async function submitFinding(cookie: string): Promise<Finding> {
  assert.ok(evidenceId, 'evidence must come from POST /api/v1/analyze');
  const response = await api('/api/v1/findings', { method: 'POST', cookie, body: { evidence_id: evidenceId, claim: findingClaim } });
  const text = await responseText(response);
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as Finding;
}

const decide = (id: string, cookie: string, status: string, reason?: string) =>
  api(`/api/v1/findings/${id}/decisions`, {
    method: 'POST',
    cookie,
    body: reason === undefined ? { status } : { status, reason },
  });

async function moveTo(id: string, cookie: string, status: string): Promise<Finding> {
  const response = await decide(id, cookie, status, 'checked against the source release');
  const text = await responseText(response);
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { finding: Finding }).finding;
}

before(async () => {
  databaseReachable = await tcpReachable('localhost', 5432);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    SAYSIGHT_MAINTAINER_EMAIL: maintainerEmail,
    SAYSIGHT_BASE_URL: baseUrl,
    WORKER_URL: workerUrl,
    COOKIE_SECURE: 'false',
  };
  // A provider in the parent environment would produce `llm` explanations and
  // make the deterministic fallback assertions flaky.
  for (const key of ['EXPLANATION_PROVIDER_ENDPOINT', 'EXPLANATION_PROVIDER_MODEL', 'EXPLANATION_PROVIDER_NAME', 'EXPLANATION_API_KEY']) delete env[key];
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutChunk += chunk;
    const lines = stdoutChunk.split('\n');
    stdoutChunk = lines.pop() ?? '';
    stdoutLines.push(...lines);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrTail = `${stderrTail}${chunk}`.slice(-4000); });
  await waitForHealth();
  if (databaseReachable && await httpReachable(`${workerUrl}/health`)) {
    const response = await api('/api/v1/analyze', { method: 'POST', body: { recipe: 'summary', year: 2024 } });
    const text = await responseText(response);
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text) as { evidence_id?: unknown };
    assert.equal(typeof body.evidence_id, 'string');
    evidenceId = body.evidence_id;
  }
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
});

// Auth routes.

test('magic-link request returns 202 and logs the link instead of sending mail', async (t) => {
  if (!ready(t)) return;
  const email = uniqueEmail('magic');
  const link = await requestMagicLink(email);
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/auth\/verify\?token=\S+$/);
});

test('verifying a magic link sets an httpOnly SameSite=Lax cookie and returns the user', async (t) => {
  if (!ready(t)) return;
  const email = uniqueEmail('verify');
  const { cookie, user } = await verify(await requestMagicLink(email));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.equal(user.email, email);
  assert.ok(user.id);
});

test('a replayed magic link is refused with 401 invalid_or_expired_link', async (t) => {
  if (!ready(t)) return;
  const link = await requestMagicLink(uniqueEmail('replay'));
  assert.equal((await api(link, { accept: 'application/json' })).status, 200);
  const replay = await api(link, { accept: 'application/json' });
  assert.equal(replay.status, 401);
  assert.deepEqual(await responseJson<unknown>(replay), { error: 'invalid_or_expired_link' });
});

test('/auth/me returns 401 without a cookie and 200 with one', async (t) => {
  if (!ready(t)) return;
  const anonymous = await api('/api/v1/auth/me');
  assert.equal(anonymous.status, 401);
  const account = await signIn('me');
  const authenticated = await api('/api/v1/auth/me', { cookie: account.cookie });
  assert.equal(authenticated.status, 200);
  assert.equal((await responseJson<{ user: User }>(authenticated)).user.email, account.email);
});

test('/auth/logout returns 204 and revokes the session cookie', async (t) => {
  if (!ready(t)) return;
  const { cookie } = await signIn('logout');
  const response = await api('/api/v1/auth/logout', { method: 'POST', cookie });
  assert.equal(response.status, 204);
  const afterLogout = await api('/api/v1/auth/me', { cookie });
  assert.equal(afterLogout.status, 401);
  assert.deepEqual(await responseJson<unknown>(afterLogout), { error: 'not_signed_in' });
});

// Maintainer bootstrap and role assignment.

test('the configured maintainer address verifies with the maintainer role', async (t) => {
  if (!ready(t)) return;
  const account = await maintainer();
  assert.equal(account.email, maintainerEmail);
  assert.equal(account.user.role, 'maintainer');
});

test('any other address verifies with the submitter role', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('submitter-role');
  assert.equal(account.user.role, 'submitter');
});

// Finding submission.

test('anonymous finding submission is refused with 401 sign_in_required', async (t) => {
  if (!ready(t)) return;
  const response = await api('/api/v1/findings', { method: 'POST', body: { evidence_id: randomUUID() } });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'sign_in_required' });
});

test('an authenticated submission creates an Unverified finding with derived impact', async (t) => {
  if (!ready(t, true)) return;
  const account = await signIn('submitter');
  const finding = await submitFinding(account.cookie);
  assert.equal(finding.status, 'Unverified');
  assert.equal(finding.impact, 'low'); // a one-year summary filter is the narrowest derived impact
  assert.equal(finding.claim, findingClaim);
  assert.equal(finding.submittedBy, account.user.id);
  assert.ok(finding.id);
});

test('a submission without a claim is refused with 400 claim_required', async (t) => {
  if (!ready(t, true)) return;
  const account = await signIn('claim-missing');
  const response = await api('/api/v1/findings', { method: 'POST', cookie: account.cookie, body: { evidence_id: evidenceId } });
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'claim_required' });
});

test('a claim shorter than 20 characters is refused with 400 claim_too_short', async (t) => {
  if (!ready(t, true)) return;
  const account = await signIn('claim-short');
  const response = await api('/api/v1/findings', { method: 'POST', cookie: account.cookie, body: { evidence_id: evidenceId, claim: 'too short' } });
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'claim_too_short' });
});

test('a claim longer than 1000 characters is refused with 400 claim_too_long', async (t) => {
  if (!ready(t, true)) return;
  const account = await signIn('claim-long');
  const response = await api('/api/v1/findings', { method: 'POST', cookie: account.cookie, body: { evidence_id: evidenceId, claim: 'x'.repeat(1001) } });
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'claim_too_long' });
});

test('the public finding page shows the claim escaped directly under the status line', async (t) => {
  if (!ready(t, true)) return;
  const account = await signIn('claim-page');
  const claim = '<b>FY2024 appropriations match the published release for this scope</b>';
  const created = await api('/api/v1/findings', { method: 'POST', cookie: account.cookie, body: { evidence_id: evidenceId, claim } });
  const createdText = await responseText(created);
  assert.equal(created.status, 201, createdText);
  const finding = JSON.parse(createdText) as Finding;
  const page = await api(`/api/v1/findings/${finding.id}/page`);
  const html = await responseText(page);
  assert.equal(page.status, 200, html);
  assert.ok(html.includes(`</p><p><strong>Claim:</strong> &lt;b&gt;FY2024 appropriations match the published release for this scope&lt;/b&gt;</p>`));
  assert.ok(!html.includes('<b>FY2024 appropriations'));
  assert.match(html, /<p>Download:/);
  assert.ok(html.includes(`/api/v1/evidence/${evidenceId}/export.csv`));
  assert.ok(html.includes(`/api/v1/evidence/${evidenceId}/export.json`));
});

// Review queue, decisions, and history.

test('a submitter cannot list the review queue', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('queue-denied');
  const response = await api('/api/v1/review/queue', { cookie: account.cookie });
  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'reviewer_required' });
});

test('a reviewer can list findings waiting for review', async (t) => {
  if (!ready(t, true)) return;
  const submitterAccount = await signIn('queue-author');
  const finding = await submitFinding(submitterAccount.cookie);
  const reviewerAccount = await reviewer();
  await moveTo(finding.id, reviewerAccount.cookie, 'Pending verification');
  const response = await api('/api/v1/review/queue', { cookie: reviewerAccount.cookie });
  assert.equal(response.status, 200);
  const { findings } = await responseJson<{ findings: Finding[] }>(response);
  assert.ok(findings.some((candidate) => candidate.id === finding.id && candidate.status === 'Pending verification'));
});

test('a decision without a reason is refused with 400 reason_required', async (t) => {
  if (!ready(t, true)) return;
  const reviewAccount = await reviewer();
  const finding = await submitFinding((await signIn('no-reason-author')).cookie);
  const response = await decide(finding.id, reviewAccount.cookie, 'Verified');
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'reason_required' });
});

test('skipping from Unverified to Verified is refused with 409 invalid_transition', async (t) => {
  if (!ready(t, true)) return;
  const reviewAccount = await reviewer();
  const finding = await submitFinding((await signIn('skip-author')).cookie);
  const response = await decide(finding.id, reviewAccount.cookie, 'Verified', 'checked against the source release');
  assert.equal(response.status, 409);
  const body = await responseJson<{ error: string; current_status: string }>(response);
  assert.equal(body.error, 'invalid_transition');
  assert.equal(body.current_status, 'Unverified');
});

test('a submitter cannot make a review decision', async (t) => {
  if (!ready(t, true)) return;
  const author = await signIn('decision-author');
  const finding = await submitFinding(author.cookie);
  const reviewAccount = await reviewer();
  await moveTo(finding.id, reviewAccount.cookie, 'Pending verification');
  await moveTo(finding.id, reviewAccount.cookie, 'In review');
  const response = await decide(finding.id, author.cookie, 'Verified', 'checked against the source release');
  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'reviewer_required' });
});

test('a reviewer cannot decide their own finding', async (t) => {
  if (!ready(t, true)) return;
  const author = await reviewer();
  const finding = await submitFinding(author.cookie);
  const otherReviewer = await maintainer();
  await moveTo(finding.id, otherReviewer.cookie, 'Pending verification');
  await moveTo(finding.id, otherReviewer.cookie, 'In review');
  const response = await decide(finding.id, author.cookie, 'Verified', 'checked against the source release');
  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'self_review_not_allowed' });
});

test('the legal review path reaches a terminal status and the finding reflects it', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('legal-author')).cookie);
  const reviewAccount = await reviewer();
  assert.equal((await moveTo(finding.id, reviewAccount.cookie, 'Pending verification')).status, 'Pending verification');
  assert.equal((await moveTo(finding.id, reviewAccount.cookie, 'In review')).status, 'In review');
  const decision = await moveTo(finding.id, reviewAccount.cookie, 'Verified');
  assert.equal(decision.status, 'Verified');
  const current = await api(`/api/v1/findings/${finding.id}`);
  assert.equal((await responseJson<Finding>(current)).status, 'Verified');
});

test('the finding history lists every recorded transition', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('history-author')).cookie);
  const reviewAccount = await reviewer();
  for (const status of ['Pending verification', 'In review', 'Verified']) await moveTo(finding.id, reviewAccount.cookie, status);
  const response = await api(`/api/v1/findings/${finding.id}/history`);
  assert.equal(response.status, 200);
  const { transitions } = await responseJson<{ transitions: Array<{ fromStatus: string; toStatus: string; reason: string }> }>(response);
  assert.deepEqual(transitions.map((transition) => transition.toStatus), ['Pending verification', 'In review', 'Verified']);
  assert.deepEqual(transitions.map((transition) => transition.fromStatus), ['Unverified', 'Pending verification', 'In review']);
  assert.ok(transitions.every((transition) => transition.reason.length > 0));
});

test('a terminal status refuses another decision with 409 invalid_transition', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('terminal-author')).cookie);
  const reviewAccount = await reviewer();
  for (const status of ['Pending verification', 'In review', 'Verified']) await moveTo(finding.id, reviewAccount.cookie, status);
  const response = await decide(finding.id, reviewAccount.cookie, 'Rejected', 'later evidence changed the outcome');
  assert.equal(response.status, 409);
  const body = await responseJson<{ error: string; current_status: string }>(response);
  assert.equal(body.error, 'invalid_transition');
  assert.equal(body.current_status, 'Verified');
});

// Contextual comments.

test('anonymous comment posting is refused with 401', async (t) => {
  if (!ready(t)) return;
  const response = await api(`/api/v1/findings/${randomUUID()}/comments`, { method: 'POST', body: { body: 'hello' } });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'sign_in_required' });
});

test('an empty comment body is refused with 400 comment_required', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('empty-comment');
  const response = await api(`/api/v1/findings/${randomUUID()}/comments`, { method: 'POST', cookie: account.cookie, body: { body: '   ' } });
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'comment_required' });
});

test('an authenticated comment is created with 201', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('comment-author')).cookie);
  const account = await signIn('commenter');
  const response = await api(`/api/v1/findings/${finding.id}/comments`, { method: 'POST', cookie: account.cookie, body: { body: 'A useful observation.' } });
  assert.equal(response.status, 201);
  const comment = await responseJson<{ id: string; body: string; status: string }>(response);
  assert.ok(comment.id);
  assert.equal(comment.body, 'A useful observation.');
  assert.equal(comment.status, 'visible');
});

test('a submitter cannot remove a comment', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('removal-author')).cookie);
  const submitter = await signIn('removal-submitter');
  const commentResponse = await api(`/api/v1/findings/${finding.id}/comments`, { method: 'POST', cookie: submitter.cookie, body: { body: 'Needs moderator attention.' } });
  const comment = await responseJson<{ id: string }>(commentResponse);
  const response = await api(`/api/v1/comments/${comment.id}/removal`, { method: 'POST', cookie: submitter.cookie, body: { reason: 'spam' } });
  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'moderator_required' });
});

test('a reviewer removes a comment with a recorded reason', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('moderated-author')).cookie);
  const author = await signIn('moderated-commenter');
  const commentResponse = await api(`/api/v1/findings/${finding.id}/comments`, { method: 'POST', cookie: author.cookie, body: { body: 'Remove me.' } });
  const comment = await responseJson<{ id: string }>(commentResponse);
  const response = await api(`/api/v1/comments/${comment.id}/removal`, { method: 'POST', cookie: (await reviewer()).cookie, body: { reason: 'off topic' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson<unknown>(response), { status: 'removed' });
});

test('removing the same comment twice is refused with 409 comment_already_removed', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('repeat-author')).cookie);
  const author = await signIn('repeat-commenter');
  const commentResponse = await api(`/api/v1/findings/${finding.id}/comments`, { method: 'POST', cookie: author.cookie, body: { body: 'Repeat removal.' } });
  const comment = await responseJson<{ id: string }>(commentResponse);
  const reviewAccount = await reviewer();
  assert.equal((await api(`/api/v1/comments/${comment.id}/removal`, { method: 'POST', cookie: reviewAccount.cookie, body: { reason: 'duplicate' } })).status, 200);
  const repeat = await api(`/api/v1/comments/${comment.id}/removal`, { method: 'POST', cookie: reviewAccount.cookie, body: { reason: 'duplicate again' } });
  assert.equal(repeat.status, 409);
  assert.deepEqual(await responseJson<unknown>(repeat), { error: 'comment_already_removed' });
});

test('removing an unknown comment returns 404', async (t) => {
  if (!ready(t)) return;
  const response = await api(`/api/v1/comments/${randomUUID()}/removal`, { method: 'POST', cookie: (await reviewer()).cookie, body: { reason: 'not there' } });
  assert.equal(response.status, 404);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'comment_not_found' });
});

test('a removed comment hides its text and shows its reason in the public thread', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('hidden-author')).cookie);
  const author = await signIn('hidden-commenter');
  const secret = `secret-${randomUUID()}`;
  const commentResponse = await api(`/api/v1/findings/${finding.id}/comments`, { method: 'POST', cookie: author.cookie, body: { body: secret } });
  const comment = await responseJson<{ id: string }>(commentResponse);
  const reason = 'personal details';
  assert.equal((await api(`/api/v1/comments/${comment.id}/removal`, { method: 'POST', cookie: (await reviewer()).cookie, body: { reason } })).status, 200);
  const response = await api(`/api/v1/findings/${finding.id}/comments`);
  assert.equal(response.status, 200);
  const { comments } = await responseJson<{ comments: Array<{ id: string; body: string; status: string; removalReason: string | null }> }>(response);
  const removed = comments.find((candidate) => candidate.id === comment.id);
  assert.ok(removed);
  assert.equal(removed.status, 'removed');
  assert.equal(removed.body, '');
  assert.ok(!JSON.stringify(comments).includes(secret));
  assert.equal(removed.removalReason, reason);
});

// Bounded explanations.

test('anonymous explanation generation is refused with 401', async (t) => {
  if (!ready(t)) return;
  const response = await api(`/api/v1/findings/${randomUUID()}/explanation`, { method: 'POST' });
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'sign_in_required' });
});

test('a finding has no explanation before one is generated', async (t) => {
  if (!ready(t)) return;
  const response = await api(`/api/v1/findings/${randomUUID()}/explanation`);
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson<unknown>(response), { explanation: null });
});

test('authenticated generation returns a bounded template explanation', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('explanation-author')).cookie);
  const response = await api(`/api/v1/findings/${finding.id}/explanation`, { method: 'POST', cookie: (await signIn('explainer')).cookie });
  const text = await responseText(response);
  assert.equal(response.status, 201, text);
  const record = JSON.parse(text) as { source: string; text: string; templateVersion: string };
  assert.equal(record.source, 'template');
  assert.ok(record.text.length > 0 && record.text.length <= 600);
  assert.ok(record.templateVersion);
});

test('the generated explanation is readable through the public GET route', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('read-explanation-author')).cookie);
  const createdResponse = await api(`/api/v1/findings/${finding.id}/explanation`, { method: 'POST', cookie: (await signIn('read-explainer')).cookie });
  assert.equal(createdResponse.status, 201);
  const created = await responseJson<{ id: string; text: string; source: string }>(createdResponse);
  const response = await api(`/api/v1/findings/${finding.id}/explanation`);
  assert.equal(response.status, 200);
  const { explanation } = await responseJson<{ explanation: { id: string; text: string; source: string; createdAt: string } | null }>(response);
  assert.ok(explanation);
  // The two reads have different statement timestamps; compare the stored record.
  assert.deepEqual({ id: explanation.id, text: explanation.text, source: explanation.source }, { id: created.id, text: created.text, source: created.source });
  assert.ok(explanation.createdAt);
});

test('the public finding page shows the explanation section', async (t) => {
  if (!ready(t, true)) return;
  const finding = await submitFinding((await signIn('page-author')).cookie);
  const createdResponse = await api(`/api/v1/findings/${finding.id}/explanation`, { method: 'POST', cookie: (await signIn('page-explainer')).cookie });
  assert.equal(createdResponse.status, 201);
  const { text } = await responseJson<{ text: string }>(createdResponse);
  const response = await api(`/api/v1/findings/${finding.id}/page`);
  assert.equal(response.status, 200);
  const html = await responseText(response);
  assert.match(html, /<h2 id="explanation-heading">Explanation<\/h2>/);
  const escaped = text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  assert.ok(html.includes(escaped));
});

// Session isolation.

test('a second account sees only its own session identity', async (t) => {
  if (!ready(t)) return;
  const first = await signIn('isolated-first');
  const second = await signIn('isolated-second');
  const response = await api('/api/v1/auth/me', { cookie: second.cookie });
  assert.equal(response.status, 200);
  const { user } = await responseJson<{ user: User }>(response);
  assert.equal(user.email, second.email);
  assert.notEqual(user.email, first.email);
  assert.notEqual(user.id, first.user.id);
});

// General upload boundary (MVP-C).

const upload = (filename: string, body: string, cookie?: string, name = 'Route test') =>
  fetch(`${baseUrl}/api/v1/imports/register?filename=${encodeURIComponent(filename)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body,
  });

test('draft registration requires a signed-in owner', async (t) => {
  if (!ready(t)) return;
  const response = await upload('route.csv', 'year,status\n2024,GAA\n');
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'sign_in_required' });
});

test('unsupported upload formats are refused before parsing', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('upload-format');
  const response = await upload('route.txt', 'year,status\n2024,GAA\n', account.cookie);
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'unsupported_format' });
});

test('a valid CSV becomes a private draft with a recorded validation', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('upload-valid');
  const response = await upload('route.csv', 'year,status\n2024,GAA\n2025,GAA\n', account.cookie);
  const text = await responseText(response);
  assert.equal(response.status, 201, text);
  const draft = JSON.parse(text) as { status: string; checkRows: string; normalized_rows: number; validation: { rows: number } };
  assert.equal(draft.status, 'validated');
  assert.equal(draft.checkRows, 'ok');
  assert.equal(draft.validation.rows, 2);
  assert.equal(draft.normalized_rows, 2);
});

test('an empty dataset is quarantined with a recorded reason', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('upload-empty');
  const response = await upload('empty.csv', 'year,status\n', account.cookie);
  const text = await responseText(response);
  assert.equal(response.status, 201, text);
  const draft = JSON.parse(text) as { status: string; checkRows: string };
  assert.equal(draft.status, 'quarantined');
  assert.equal(draft.checkRows, 'empty_dataset');
});


// Maintainer publication (MVP-C).

const publishBody = {
  reason: 'source, license, and coverage checked',
  metadata: {
    publisher: 'BetterGov',
    sourceUrl: 'https://example.org/data',
    license: 'CC0 1.0 Universal',
    coverage: { fiscalYears: [2024] },
    fields: [{ name: 'year', type: 'integer', description: 'Fiscal year' }],
    limitations: [],
  },
};

async function validDraft(label: string) {
  const account = await maintainer();
  const name = `Publishable ${randomUUID()}`;
  const response = await upload('publish.csv', 'year,status\n2024,GAA\n', account.cookie, name);
  const text = await responseText(response);
  assert.equal(response.status, 201, text);
  const draft = JSON.parse(text) as { id: string };
  return { account, name, id: draft.id };
}

test('only a maintainer can publish a draft', async (t) => {
  if (!ready(t)) return;
  const { id } = await validDraft('publish-role');
  const submitter = await signIn('publish-submitter');
  const response = await api(`/api/v1/imports/${id}/publish`, { method: 'POST', cookie: submitter.cookie, body: publishBody });
  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'maintainer_required' });
});

test('publication refuses incomplete metadata', async (t) => {
  if (!ready(t)) return;
  const { account, id } = await validDraft('publish-metadata');
  const response = await api(`/api/v1/imports/${id}/publish`, {
    method: 'POST', cookie: account.cookie,
    body: { reason: 'checked', metadata: { publisher: '', sourceUrl: 'ftp://x', license: 'license not confirmed', coverage: {}, fields: [], limitations: undefined } },
  });
  assert.equal(response.status, 400);
  const body = await responseJson<{ error: string; fields: string[] }>(response);
  assert.equal(body.error, 'invalid_metadata');
  assert.ok(body.fields.includes('publisher_required'));
});

test('a maintainer publishes a validated draft as a new release', async (t) => {
  if (!ready(t)) return;
  const { account, id, name } = await validDraft('publish-valid');
  const response = await api(`/api/v1/imports/${id}/publish`, { method: 'POST', cookie: account.cookie, body: publishBody });
  const text = await responseText(response);
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text) as { draft: { status: string }; release_id: string };
  assert.equal(body.draft.status, 'published');
  assert.match(body.release_id, /^release-/);
  const catalog = await responseJson<{ datasets: Array<{ name: string }> }>(await api('/api/v1/datasets'));
  assert.ok(catalog.datasets.some((dataset) => dataset.name === name), 'published release is in the catalog');
});

// Multi-agency catalog and saved views (MVP-C).

test('the catalog exposes agencies and verified freshness metadata', async (t) => {
  if (!ready(t)) return;
  const agencies = await responseJson<{ agencies: Array<{ id: string }> }>(await api('/api/v1/agencies'));
  assert.ok(agencies.agencies.some((agency) => agency.id === 'bettergov'));
  const catalog = await responseJson<{ datasets: Array<{ id: string; agencyId: string | null; freshnessStatus: string }> }>(await api('/api/v1/datasets'));
  const verified = catalog.datasets.find((dataset) => dataset.id === 'bettergov-gaa-coverage-2026-11-07');
  assert.ok(verified);
  assert.equal(verified.agencyId, 'bettergov');
  assert.equal(verified.freshnessStatus, 'current');
});

test('saved views require an owner and stay isolated', async (t) => {
  if (!ready(t)) return;
  assert.equal((await api('/api/v1/saved-views')).status, 401);
  const first = await signIn('view-owner');
  const second = await signIn('view-other');
  const created = await api('/api/v1/saved-views', {
    method: 'POST', cookie: first.cookie,
    body: { name: 'FY2024', datasetReleaseId: 'bettergov-gaa-coverage-2026-11-07', filters: { year: 2024 } },
  });
  assert.equal(created.status, 201, await responseText(created));
  const mine = await responseJson<{ views: Array<{ name: string }> }>(await api('/api/v1/saved-views', { cookie: first.cookie }));
  assert.ok(mine.views.some((view) => view.name === 'FY2024'));
  const theirs = await responseJson<{ views: Array<{ name: string }> }>(await api('/api/v1/saved-views', { cookie: second.cookie }));
  assert.ok(!theirs.views.some((view) => view.name === 'FY2024'));
});

// Optional pagination (MVP-C).

test('list pagination is opt-in and preserves the default response', async (t) => {
  if (!ready(t)) return;
  // Saved views are created by this test, so the assertion does not depend on
  // how many releases a clean volume happens to contain.
  const account = await signIn('pagination-owner');
  for (const name of ['Page one', 'Page two', 'Page three']) {
    await api('/api/v1/saved-views', {
      method: 'POST', cookie: account.cookie,
      body: { name, datasetReleaseId: 'bettergov-gaa-coverage-2026-11-07', filters: {} },
    });
  }
  const all = await responseJson<{ views: Array<{ id: string }> }>(await api('/api/v1/saved-views', { cookie: account.cookie }));
  assert.ok(all.views.length >= 3);
  const first = await responseJson<{ views: Array<{ id: string }> }>(await api('/api/v1/saved-views?limit=1', { cookie: account.cookie }));
  assert.equal(first.views.length, 1);
  assert.equal(first.views[0].id, all.views[0].id);
  const second = await responseJson<{ views: Array<{ id: string }> }>(await api('/api/v1/saved-views?offset=1&limit=1', { cookie: account.cookie }));
  assert.equal(second.views[0].id, all.views[1].id);
});

test('invalid pagination parameters are refused', async (t) => {
  if (!ready(t)) return;
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) {
    const response = await api(`/api/v1/datasets?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await responseJson<unknown>(response), { error: 'invalid_pagination' });
  }
});

// Catalog and queue search and filter (gap 9).

test('the catalog filters by query, agency, and freshness and keeps the default response', async (t) => {
  if (!ready(t)) return;
  type CatalogDataset = { id: string; name: string; publisher: string; releaseId: string; agencyId: string | null; freshnessStatus: string };
  const defaultText = await responseText(await api('/api/v1/datasets'));
  const all = JSON.parse(defaultText) as { datasets: CatalogDataset[] };
  assert.ok(all.datasets.length > 0);
  // Empty filter parameters mean "no filter", so the body is byte-identical.
  assert.equal(await responseText(await api('/api/v1/datasets?q=&agency=&freshness=')), defaultText);
  const ids = new Set(all.datasets.map((dataset) => dataset.id));
  const verifiedId = 'bettergov-gaa-coverage-2026-11-07';

  const matched = await responseJson<{ datasets: CatalogDataset[] }>(await api('/api/v1/datasets?q=APPROPRIATIONS'));
  assert.ok(matched.datasets.some((dataset) => dataset.id === verifiedId));
  for (const dataset of matched.datasets) {
    assert.ok(ids.has(dataset.id), `filter invented a release: ${dataset.id}`);
    assert.ok([dataset.name, dataset.publisher, dataset.releaseId, dataset.agencyId ?? ''].some((field) => field.toLowerCase().includes('appropriations')), `matched on nothing: ${dataset.id}`);
  }
  const lower = await responseJson<{ datasets: CatalogDataset[] }>(await api('/api/v1/datasets?q=appropriations'));
  assert.deepEqual(lower.datasets.map((dataset) => dataset.id), matched.datasets.map((dataset) => dataset.id));

  const byAgency = await responseJson<{ datasets: CatalogDataset[] }>(await api('/api/v1/datasets?agency=bettergov'));
  assert.ok(byAgency.datasets.some((dataset) => dataset.id === verifiedId));
  assert.ok(byAgency.datasets.every((dataset) => dataset.agencyId === 'bettergov'));
  assert.deepEqual((await responseJson<{ datasets: CatalogDataset[] }>(await api('/api/v1/datasets?agency=no-such-agency'))).datasets, []);

  const current = await responseJson<{ datasets: CatalogDataset[] }>(await api('/api/v1/datasets?freshness=current'));
  assert.ok(current.datasets.some((dataset) => dataset.id === verifiedId));
  assert.ok(current.datasets.every((dataset) => dataset.freshnessStatus === 'current'));

  for (const query of ['freshness=bogus', 'q=appropriations&freshness=unknown']) {
    const response = await api(`/api/v1/datasets?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await responseJson<unknown>(response), { error: 'invalid_filter', parameter: 'freshness' });
  }
});

test('the review queue filters by status, impact, and claim', async (t) => {
  if (!ready(t, true)) return;
  const author = await signIn('queue-filter-author');
  const finding = await submitFinding(author.cookie);
  const reviewAccount = await reviewer();
  await moveTo(finding.id, reviewAccount.cookie, 'Pending verification');

  const defaultText = await responseText(await api('/api/v1/review/queue', { cookie: reviewAccount.cookie }));
  assert.equal(await responseText(await api('/api/v1/review/queue?status=&impact=&q=', { cookie: reviewAccount.cookie })), defaultText);

  const byStatus = await responseJson<{ findings: Finding[] }>(await api('/api/v1/review/queue?status=In%20review', { cookie: reviewAccount.cookie }));
  assert.ok(byStatus.findings.every((item) => item.status === 'In review'));
  const byImpact = await responseJson<{ findings: Finding[] }>(await api('/api/v1/review/queue?impact=low', { cookie: reviewAccount.cookie }));
  assert.ok(byImpact.findings.some((item) => item.id === finding.id), 'the single-year finding is low impact');
  assert.ok(byImpact.findings.every((item) => item.impact === 'low'));
  const byClaim = await responseJson<{ findings: Finding[] }>(await api('/api/v1/review/queue?q=FY2024%20APPROPRIATIONS', { cookie: reviewAccount.cookie }));
  assert.ok(byClaim.findings.some((item) => item.id === finding.id));
  assert.ok(byClaim.findings.every((item) => (item.claim ?? '').toLowerCase().includes('fy2024 appropriations')));

  for (const [query, parameter] of [['status=Reviewed', 'status'], ['impact=critical', 'impact']] as const) {
    const response = await api(`/api/v1/review/queue?${query}`, { cookie: reviewAccount.cookie });
    assert.equal(response.status, 400, query);
    assert.deepEqual(await responseJson<unknown>(response), { error: 'invalid_filter', parameter });
  }
});

test('the public catalog excludes private drafts and always has complete arrays', async (t) => {
  if (!ready(t)) return;
  const { datasets } = await responseJson<{ datasets: Array<{ id: string; coverage?: { fiscalYears?: unknown }; fields?: unknown; limitations?: unknown }> }>(await api('/api/v1/datasets'));
  assert.ok(datasets.length > 0);
  for (const dataset of datasets) {
    assert.ok(!dataset.id.startsWith('draft-'), `private draft leaked: ${dataset.id}`);
    assert.ok(Array.isArray(dataset.coverage?.fiscalYears), `coverage missing: ${dataset.id}`);
    assert.ok(Array.isArray(dataset.fields), `fields missing: ${dataset.id}`);
    assert.ok(Array.isArray(dataset.limitations), `limitations missing: ${dataset.id}`);
  }
});

test('a saved view cannot reference an unknown release', async (t) => {
  if (!ready(t)) return;
  const account = await signIn('view-unknown-release');
  const response = await api('/api/v1/saved-views', {
    method: 'POST', cookie: account.cookie,
    body: { name: 'Broken', datasetReleaseId: 'missing-release', filters: {} },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'dataset_release_not_found' });
});

// Curated join analysis (MVP-D).

test('the curated join runs twice and records joined evidence', async (t) => {
  if (!ready(t)) return;
  const response = await api('/api/v1/join/analyze', { method: 'POST', body: {} });
  const text = await responseText(response);
  assert.equal(response.status, 200, text);
  const joined = JSON.parse(text) as { matched_rows: number; evidence_id: string; reproducibility_status: string; relationship_id: string };
  assert.equal(joined.matched_rows, 27);
  assert.ok(joined.evidence_id);
  assert.equal(joined.reproducibility_status, 'Passed');
  const evidence = await responseJson<{ recipe: string }>(await api(`/api/v1/evidence/${joined.evidence_id}`));
  assert.equal(evidence.recipe, 'joined_summary');
});

test('an unknown relationship is refused', async (t) => {
  if (!ready(t)) return;
  const response = await api('/api/v1/join/analyze', {
    method: 'POST', body: { relationship_id: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'relationship_not_found' });
});

// Downloadable evidence (gap 8).

test('the CSV export downloads evidence metadata with escaped values', async (t) => {
  if (!ready(t, true)) return;
  const response = await api(`/api/v1/evidence/${evidenceId}/export.csv`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/csv/);
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="evidence-.*\.csv"$/);
  const evidence = await responseJson<{ releaseChecksum: string }>(await api(`/api/v1/evidence/${evidenceId}`));
  const body = await responseText(response);
  assert.ok(body.includes(`release_checksum,${evidence.releaseChecksum}`));
  const quotedFilters = JSON.stringify({ year: 2024 }).replace(/"/g, '""');
  assert.ok(body.includes(`filters,"${quotedFilters}"`), 'quoted filter value survives');
  const missing = await api(`/api/v1/evidence/${randomUUID()}/export.csv`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson<unknown>(missing), { error: 'evidence_not_found' });
});

test('the JSON export downloads the same evidence and refuses unknown ids', async (t) => {
  if (!ready(t, true)) return;
  const response = await api(`/api/v1/evidence/${evidenceId}/export.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="evidence-.*\.json"$/);
  assert.equal((await responseJson<{ id: string }>(response)).id, evidenceId);
  const missing = await api(`/api/v1/evidence/${randomUUID()}/export.json`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson<unknown>(missing), { error: 'evidence_not_found' });
});

// Manual source refresh (gap 7). The test API is started without SOURCE_REFRESH_URL.

test('a refresh check without a configured source is unavailable and writes nothing', async (t) => {
  if (!ready(t)) return;
  const releaseId = 'bettergov-gaa-coverage-2026-11-07';
  const before = await responseText(await api('/api/v1/datasets'));
  const response = await api(`/api/v1/datasets/${releaseId}/refresh-check`, { method: 'POST', cookie: (await maintainer()).cookie });
  assert.equal(response.status, 503);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'source_check_unavailable' });
  assert.equal(await responseText(await api('/api/v1/datasets')), before);
});

test('only a maintainer can request a refresh check and an unknown release is not found', async (t) => {
  if (!ready(t)) return;
  const releaseId = 'bettergov-gaa-coverage-2026-11-07';
  const submitter = await signIn('refresh-submitter');
  const denied = await api(`/api/v1/datasets/${releaseId}/refresh-check`, { method: 'POST', cookie: submitter.cookie });
  assert.equal(denied.status, 403);
  assert.deepEqual(await responseJson<unknown>(denied), { error: 'maintainer_required' });
  const missing = await api(`/api/v1/datasets/${randomUUID()}/refresh-check`, { method: 'POST', cookie: (await maintainer()).cookie });
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson<unknown>(missing), { error: 'dataset_release_not_found' });
});

// Connector registry and status log (MVP-E).

type ConnectorEntry = { id: string; name: string; protocol: string; kind: string; externalBenchmark: boolean; last_check: { status: string; httpStatus: number | null; datasetCount: number | null; message: string; createdAt: string } | null };

const connectorCheck = (id: string, cookie?: string) =>
  api(`/api/v1/connectors/${id}/check`, { method: 'POST', ...(cookie ? { cookie } : {}) });

test('the connector catalog is public and lists every source', async (t) => {
  if (!ready(t)) return;
  const response = await api('/api/v1/connectors');
  const text = await responseText(response);
  assert.equal(response.status, 200, text);
  const { connectors } = JSON.parse(text) as { connectors: ConnectorEntry[] };
  assert.equal(connectors.length, 8);
  assert.ok(connectors.every((connector) => connector.name && connector.protocol && connector.kind));
  for (const id of ['data-gov-ph', 'psada', 'opendata-org-ph', 'cids']) {
    assert.equal(connectors.find((connector) => connector.id === id)?.kind, 'link-out', `${id} is a listed link-out`);
  }
  assert.equal(connectors.find((connector) => connector.id === 'worldbank')?.externalBenchmark, true);
  assert.equal(connectors.find((connector) => connector.id === 'bettergov')?.externalBenchmark, false);
});

test('a maintainer check of a link-out connector is recorded without fetching anything', async (t) => {
  if (!ready(t)) return;
  const response = await connectorCheck('cids', (await maintainer()).cookie);
  const text = await responseText(response);
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as { connector: string; status: string; dataset_count: number; http_status: number | null; message: string };
  assert.deepEqual(
    { connector: body.connector, status: body.status, dataset_count: body.dataset_count, http_status: body.http_status },
    { connector: 'cids', status: 'ok', dataset_count: 0, http_status: null },
  );
  assert.match(body.message, /not fetched/);
  const listed = await responseJson<{ connectors: ConnectorEntry[] }>(await api('/api/v1/connectors'));
  const cids = listed.connectors.find((connector) => connector.id === 'cids');
  assert.equal(cids?.last_check?.status, 'ok');
  assert.equal(cids?.last_check?.datasetCount, 0);
  assert.ok(cids?.last_check?.createdAt);
});

test('an unknown connector check returns 404 for a maintainer', async (t) => {
  if (!ready(t)) return;
  const response = await connectorCheck('no-such-portal', (await maintainer()).cookie);
  assert.equal(response.status, 404);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'connector_not_found' });
});

test('a submitter cannot check a connector', async (t) => {
  if (!ready(t)) return;
  const response = await connectorCheck('bettergov', (await signIn('connector-submitter')).cookie);
  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'maintainer_required' });
});

test('an anonymous connector check is refused with 401', async (t) => {
  if (!ready(t)) return;
  const response = await connectorCheck('bettergov');
  assert.equal(response.status, 401);
  assert.deepEqual(await responseJson<unknown>(response), { error: 'sign_in_required' });
});

// Pinning (MVP-E): the route is maintainer-only and append-only.

const pinDataset = (id: string, body: unknown, cookie?: string) =>
  api(`/api/v1/connectors/${id}/pin`, { method: 'POST', ...(cookie ? { cookie } : {}), body });

const failedCheckCount = async (message: string): Promise<number> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query('SELECT count(*)::int AS total FROM connector_checks WHERE status = $1 AND message = $2', ['failed', message]);
    return Number(result.rows[0].total);
  } finally { await pool.end(); }
};

test('pin route checks authentication before the connector', async (t) => {
  if (!ready(t)) return;
  const anonymous = await pinDataset('bettergov', { dataset_id: 'gaa-coverage' });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await responseJson<unknown>(anonymous), { error: 'sign_in_required' });
  const submitter = await pinDataset('bettergov', { dataset_id: 'gaa-coverage' }, (await signIn('pin-submitter')).cookie);
  assert.equal(submitter.status, 403);
  assert.deepEqual(await responseJson<unknown>(submitter), { error: 'maintainer_required' });
  const unknown = await pinDataset('no-such-portal', { dataset_id: 'gaa-coverage' }, (await maintainer()).cookie);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await responseJson<unknown>(unknown), { error: 'connector_not_found' });
});

test('pinning a link-out is refused with the connector message', async (t) => {
  if (!ready(t)) return;
  const response = await pinDataset('cids', { dataset_id: 'anything' }, (await maintainer()).cookie);
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson<unknown>(response),
    { error: 'link_out', message: 'cids is a link-out and has no data to pin' });
});

test('a failed pin writes one failed connector check and no release', async (t) => {
  if (!ready(t)) return;
  const message = 'openstat cannot be pinned yet: PxWeb table selection is not implemented';
  const before = await failedCheckCount(message);
  const response = await pinDataset('openstat', { dataset_id: 'DB1' }, (await maintainer()).cookie);
  const text = await responseText(response);
  assert.equal(response.status, 502, text);
  assert.deepEqual(JSON.parse(text) as unknown, { error: 'connector_fetch_failed', message });
  assert.equal(await failedCheckCount(message), before + 1);
});

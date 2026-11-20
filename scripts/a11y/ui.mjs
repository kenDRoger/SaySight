// UI interaction checks for accounts, the review queue, and moderated comments.
// Requires a running stack; magic links are read from the API log (log-only mail).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { obtainSession } from './audit.mjs';

const api = process.env.API_URL ?? 'http://localhost:3000';
const app = process.env.APP_URL ?? 'http://localhost:5173';
const release = 'bettergov-gaa-coverage-2026-11-07';
const maintainerEmail = process.env.SAYSIGHT_MAINTAINER_EMAIL ?? 'maintainer@example.org';
const submitterEmail = `a11y-submitter-${Date.now()}@example.org`;
const secret = `a11y-secret-${randomUUID()}`;
const removalReason = `A11y removal reason ${randomUUID()}`;
const timeout = 3_000;

async function request(path, session, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(session ? { cookie: `saysight_session=${session}` } : {}), ...init.headers },
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function ok(path, session, init) {
  const { response, body } = await request(path, session, init);
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const maintainerSession = process.env.AUDIT_SESSION ?? await obtainSession(maintainerEmail);
const submitterSession = await obtainSession(submitterEmail);
const browser = await chromium.launch({
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  args: ['--no-sandbox'],
});

try {
  const maintainerContext = await browser.newContext();
  await maintainerContext.addCookies([{ name: 'saysight_session', value: maintainerSession, url: app }]);
  const maintainerPage = await maintainerContext.newPage();
  maintainerPage.setDefaultTimeout(timeout);
  await maintainerPage.goto(app, { timeout });
  const signedIn = maintainerPage.getByRole('status').filter({ hasText: 'Signed in as' });
  await signedIn.waitFor();
  const signedInText = await signedIn.textContent();
  assert.ok(signedInText?.includes(`Signed in as ${maintainerEmail} (maintainer)`), `signed-in line: ${signedInText}`);
  console.log(`OK signed-in line shows ${maintainerEmail} (maintainer)`);

  const viewName = `a11y-view-${randomUUID()}`;
  await ok('/api/v1/saved-views', maintainerSession, {
    method: 'POST',
    body: JSON.stringify({ name: viewName, datasetReleaseId: 'bettergov-gaa-coverage-2026-11-07', filters: { year: 2024 } }),
  });
  await maintainerPage.reload({ timeout });
  const catalog = maintainerPage.getByRole('region', { name: 'Dataset catalog' });
  await catalog.getByText('Philippine General Appropriations Act coverage, FY2000–FY2026').first().waitFor();
  assert.ok((await catalog.textContent()).includes('current'), 'catalog freshness status is missing');
  console.log('OK catalog shows the release with agency and freshness metadata');
  const views = maintainerPage.getByRole('region', { name: 'Saved views' });
  await views.getByText(viewName).waitFor();
  console.log('OK signed-in user sees their saved view');
  await maintainerPage.getByRole('region', { name: 'Upload a dataset draft' }).waitFor();
  console.log('OK dataset upload section is available');

  const join = maintainerPage.getByRole('region', { name: 'Curated join' });
  await join.getByRole('button', { name: 'Run curated join' }).click();
  await join.getByText(/Curated join finished: 27 matched rows/).waitFor();
  const joinText = await join.textContent();
  assert.ok(joinText?.includes('Passed'), `join reproducibility missing: ${joinText}`);
  assert.ok(/synthetic/i.test(joinText ?? ''), 'join fixture is not labeled as synthetic');
  console.log('OK curated join runs and renders diagnostics with the synthetic-fixture warning');

  const analysis = await ok('/api/v1/analyze', undefined, { method: 'POST', body: JSON.stringify({ datasetReleaseId: release, recipe: 'summary' }) });
  const finding = await ok('/api/v1/findings', submitterSession, { method: 'POST', body: JSON.stringify({ evidence_id: analysis.evidence_id }) });
  assert.ok(finding.id, `finding response: ${JSON.stringify(finding)}`);
  console.log(`OK submitter created fixture finding ${finding.id}`);

  const decision = await ok(`/api/v1/findings/${finding.id}/decisions`, maintainerSession, {
    method: 'POST', body: JSON.stringify({ status: 'Pending verification', reason: `A11y review ${randomUUID()}` }),
  });
  assert.equal(decision.finding.status, 'Pending verification');
  console.log('OK maintainer moved the finding into review with a reason');

  const comment = await ok(`/api/v1/findings/${finding.id}/comments`, submitterSession, { method: 'POST', body: JSON.stringify({ body: secret }) });
  assert.equal(comment.body, secret);
  assert.equal(comment.status, 'visible');
  const thread = await ok(`/api/v1/findings/${finding.id}/comments`);
  assert.ok(thread.comments.some((item) => item.id === comment.id && item.status === 'visible' && item.body === secret), 'posted comment is not visible');
  console.log('OK comment is visible with the secret phrase');

  const rejected = await request(`/api/v1/comments/${comment.id}/removal`, maintainerSession, { method: 'POST', body: JSON.stringify({ reason: '   ' }) });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.error, 'removal_reason_required');
  const unchanged = await ok(`/api/v1/findings/${finding.id}/comments`);
  assert.ok(unchanged.comments.some((item) => item.id === comment.id && item.status === 'visible' && item.body === secret), 'comment changed after refused removal');
  console.log('OK removal without a reason was refused and left the comment visible');

  const removal = await ok(`/api/v1/comments/${comment.id}/removal`, maintainerSession, { method: 'POST', body: JSON.stringify({ reason: removalReason }) });
  assert.equal(removal.status, 'removed');
  console.log('OK moderator removed the comment with a reason');

  await maintainerPage.reload({ timeout });
  const queue = maintainerPage.getByRole('region', { name: 'Review queue' });
  await queue.getByRole('heading', { name: 'Review queue' }).waitFor();
  console.log('OK maintainer sees the Review queue heading');
  const item = queue.locator('li').filter({ hasText: finding.id });
  await item.waitFor();
  await item.getByRole('button', { name: 'View finding' }).click();
  const detail = maintainerPage.getByRole('region', { name: 'Finding detail' });
  await detail.getByText('Comment removed by a moderator').waitFor();
  const detailText = await detail.textContent();
  assert.ok(detailText?.includes('Comment removed by a moderator'), `detail: ${detailText}`);
  assert.ok(detailText.includes(removalReason), `detail: ${detailText}`);
  assert.ok(!detailText.includes(secret), `removed secret phrase still visible: ${detailText}`);
  console.log('OK finding detail hides the removed text and shows the moderator notice and reason');

  await detail.getByRole('button', { name: 'Generate explanation' }).click();
  await detail.getByText(/This (summary|compare|rank|distribution|change_over_time) analysis/).waitFor();
  const explanationText = await detail.textContent();
  assert.ok(explanationText?.includes('template-v1'), `explanation provenance missing: ${explanationText}`);
  console.log('OK signed-in generate button renders an explanation with template provenance');

  const submitterContext = await browser.newContext();
  await submitterContext.addCookies([{ name: 'saysight_session', value: submitterSession, url: app }]);
  const submitterPage = await submitterContext.newPage();
  submitterPage.setDefaultTimeout(timeout);
  await submitterPage.goto(app, { timeout });
  const submitterSignedIn = submitterPage.getByRole('status').filter({ hasText: 'Signed in as' });
  await submitterSignedIn.waitFor();
  assert.ok((await submitterSignedIn.textContent())?.includes(`Signed in as ${submitterEmail} (submitter)`));
  assert.equal(await submitterPage.getByRole('heading', { name: 'Review queue' }).count(), 0);
  console.log('OK submitter does not see the Review queue heading');
} finally {
  await browser.close();
}

// Accessibility and mobile-overflow audit for the Saysight UI.
//
// Requires a running stack (`docker compose up --build`): the app on :5173 and
// the API on :3000. Override with APP_URL / API_URL, and set BROWSER_PATH to use
// an installed Chromium-based browser instead of Playwright's bundled one.
//
// The audit signs itself in through the magic-link flow (log-only mail transport)
// unless AUDIT_SESSION supplies a saysight_session value directly. It creates one
// analysis and one finding moved to Pending verification so both the public page
// and the reviewer queue have content. A second account is promoted to reviewer
// with the same operator script the verification suites use. That evidence is
// append-only and stays in the database.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const api = process.env.API_URL ?? 'http://localhost:3000';
const app = process.env.APP_URL ?? 'http://localhost:5173';
const release = 'bettergov-gaa-coverage-2026-11-07';
const widths = (process.env.WIDTHS ?? '1280,375').split(',').map((value) => Number(value.trim()));
const composeFile = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'docker-compose.yml');

// Mail is log-only by decision: request a link, read it from the API logs, then
// exchange it for a session cookie. AUDIT_SESSION bypasses this whole flow.
export async function obtainSession(email = `a11y-${Date.now()}@example.org`) {
  // A fixed address (the maintainer) has a 60-second link cooldown, so a rerun
  // can find an already-consumed link in the logs. Retry rather than failing the
  // whole audit; unique addresses succeed on the first round.
  for (let round = 0; round < 8; round++) {
    const requested = await fetch(`${api}/api/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!requested.ok) throw new Error(`magic-link request for ${email} failed: ${requested.status}`);

    const marker = `magic link for ${email}: `;
    let link;
    for (let attempt = 0; attempt < 15; attempt++) {
      const logs = execFileSync('docker', ['compose', '-f', composeFile, 'logs', 'api', '--since', '2m'], { encoding: 'utf8', timeout: 2000 });
      const line = logs.split('\n').reverse().find((entry) => entry.includes(marker));
      if (line) {
        link = line.slice(line.indexOf(marker) + marker.length).trim();
        break;
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
    if (!link) throw new Error(`no magic link for ${email} appeared in the API logs within 15s`);

    const verified = await fetch(link, { headers: { accept: 'application/json' } });
    if (verified.ok) {
      const value = (verified.headers.get('set-cookie') ?? '').match(/(?:^|;)\s*saysight_session=([^;]+)/)?.[1];
      if (!value) throw new Error('magic-link response had no saysight_session cookie');
      return decodeURIComponent(value);
    }
    if (verified.status !== 401) throw new Error(`magic-link verification failed: ${verified.status}`);
    // The newest logged link was already consumed; wait out the cooldown.
    await new Promise((done) => setTimeout(done, 10_000));
  }
  throw new Error(`could not obtain a fresh magic-link session for ${email}`);
}

async function createFixture(submitterCookie, reviewerCookie) {
  const analysis = await fetch(`${api}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReleaseId: release, recipe: 'summary' }),
  });
  if (!analysis.ok) throw new Error(`analysis for the audit failed: ${analysis.status}`);
  const { evidence_id: evidenceId } = await analysis.json();
  const finding = await fetch(`${api}/api/v1/findings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: submitterCookie },
    body: JSON.stringify({ evidence_id: evidenceId, claim: 'The analyzed GAA coverage matches the published release' }),
  });
  if (!finding.ok) throw new Error(`finding for the audit failed: ${finding.status}`);
  const { id } = await finding.json();
  const decision = await fetch(`${api}/api/v1/findings/${id}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: reviewerCookie },
    body: JSON.stringify({ status: 'Pending verification', reason: 'a11y audit fixture' }),
  });
  if (!decision.ok) throw new Error(`review decision for the audit failed: ${decision.status}`);
  return { page: `${api}/api/v1/findings/${id}/page`, id };
}

async function runAudit() {
  const reviewerEmail = `a11y-reviewer-${Date.now()}@example.org`;
  const session = process.env.AUDIT_SESSION ?? await obtainSession(reviewerEmail);
  if (!process.env.AUDIT_SESSION) {
    execFileSync('docker', ['compose', '-f', composeFile, 'exec', '-T', 'api',
      'node', 'scripts/promote.mjs', reviewerEmail, 'reviewer'], { encoding: 'utf8', timeout: 10_000 });
  }
  const submitter = await obtainSession(`a11y-submitter-${Date.now()}@example.org`);
  const browser = await chromium.launch({
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
    args: ['--no-sandbox'],
  });
  const finding = await createFixture(`saysight_session=${submitter}`, `saysight_session=${session}`);
  const reviewerViews = [
    ['review queue', '[aria-labelledby="queue-heading"]'],
    ['saved views', '[aria-labelledby="views-heading"]'],
    ['upload', '[aria-labelledby="upload-heading"]'],
    ['curated join', '[aria-labelledby="join-heading"]'],
  ];
  const results = [];
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  for (const width of widths) {
    for (const [name, url] of [['catalog/analysis', app], ['public finding', finding.page]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.querySelectorAll('details').forEach((node) => (node.open = true)));
      const { violations } = await new AxeBuilder({ page })
        .withTags(tags)
        .analyze();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      results.push({ name, width, violations: violations.map((item) => `${item.id} (${item.nodes.length})`), overflow });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'saysight_session', value: session, url: app }]);
    const page = await context.newPage();
    await page.goto(app, { waitUntil: 'networkidle' });
    const signedIn = page.getByRole('status').filter({ hasText: 'Signed in as' });
    await signedIn.waitFor();
    const queue = page.getByRole('region', { name: 'Review queue' });
    await queue.getByText(finding.id).first().waitFor({ timeout: 10_000 });
    await page.evaluate(() => document.querySelectorAll('details').forEach((node) => (node.open = true)));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const [name, selector] of reviewerViews) {
      await page.locator(selector).waitFor();
      const { violations } = await new AxeBuilder({ page })
        .include(selector)
        .withTags(tags)
        .analyze();
      results.push({ name, width, violations: violations.map((item) => `${item.id} (${item.nodes.length})`), overflow });
    }
    await context.close();
  }

  await browser.close();

  for (const result of results) {
    const found = result.violations.length ? ` -> ${result.violations.join(', ')}` : '';
    console.log(`${result.name} @${result.width}px  violations=${result.violations.length}${found}  horizontalOverflow=${result.overflow}px`);
  }

  const failures = results.filter((result) => result.violations.length > 0 || result.overflow > 0);
  console.log(failures.length === 0 ? 'AXE_OK' : 'AXE_FAILED');
  process.exit(failures.length === 0 ? 0 : 1);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await runAudit();

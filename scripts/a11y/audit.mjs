// Accessibility and mobile-overflow audit for the Saysight UI.
//
// Requires a running stack (`docker compose up --build`): the app on :5173 and
// the API on :3000. Override with APP_URL / API_URL, and set BROWSER_PATH to use
// an installed Chromium-based browser instead of Playwright's bundled one.
//
// Submitting a finding requires an account (MVP-B), so set AUDIT_SESSION to the
// value of the saysight_session cookie. Obtain one with:
//   curl -s -X POST localhost:3000/api/v1/auth/magic-link -H 'content-type: application/json' -d '{"email":"you@example.org"}'
//   docker compose logs api | grep 'magic link for'   # take the token, then:
//   curl -s -c /tmp/ck.txt -H 'accept: application/json' '<link>' && grep saysight_session /tmp/ck.txt
//
// It creates one analysis and one Unverified finding so the public finding page
// can be audited; that evidence is append-only and stays in the database.
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const api = process.env.API_URL ?? 'http://localhost:3000';
const app = process.env.APP_URL ?? 'http://localhost:5173';
const release = 'bettergov-gaa-coverage-2026-11-07';
const widths = (process.env.WIDTHS ?? '1280,375').split(',').map((value) => Number(value.trim()));

const sessionCookie = process.env.AUDIT_SESSION ? `saysight_session=${process.env.AUDIT_SESSION}` : '';

async function createFixture() {
  const analysis = await fetch(`${api}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReleaseId: release, recipe: 'summary' }),
  });
  if (!analysis.ok) throw new Error(`analysis for the audit failed: ${analysis.status}`);
  const { evidence_id: evidenceId } = await analysis.json();
  const finding = await fetch(`${api}/api/v1/findings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
    body: JSON.stringify({ evidence_id: evidenceId }),
  });
  if (finding.status === 401) throw new Error('finding for the audit failed: 401 — set AUDIT_SESSION to a saysight_session cookie value (see the header comment)');
  if (!finding.ok) throw new Error(`finding for the audit failed: ${finding.status}`);
  const { id } = await finding.json();
  return `${api}/api/v1/findings/${id}/page`;
}

const browser = await chromium.launch({
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  args: ['--no-sandbox'],
});
const findingPage = await createFixture();
const results = [];

for (const width of widths) {
  for (const [name, url] of [['catalog/analysis', app], ['public finding', findingPage]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelectorAll('details').forEach((node) => (node.open = true)));
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    results.push({ name, width, violations: violations.map((item) => `${item.id} (${item.nodes.length})`), overflow });
    await context.close();
  }
}

await browser.close();

for (const result of results) {
  const found = result.violations.length ? ` -> ${result.violations.join(', ')}` : '';
  console.log(`${result.name} @${result.width}px  violations=${result.violations.length}${found}  horizontalOverflow=${result.overflow}px`);
}

const failures = results.filter((result) => result.violations.length > 0 || result.overflow > 0);
console.log(failures.length === 0 ? 'AXE_OK' : 'AXE_FAILED');
process.exit(failures.length === 0 ? 0 : 1);

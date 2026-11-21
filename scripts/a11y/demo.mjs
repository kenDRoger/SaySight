// Demo-mode browser check. Requires an API started with SAYSIGHT_DEMO_ROLES=1, because
// the whole point is the opt-in path; run it with `npm run demo`.
//
// It fails rather than skips when demo mode is off: a check that silently skips is not a
// check. With the flag on it proves the switcher appears before sign-in, that each role
// lands on its own home, and that the authorization still bites by hiding the queue from
// a submitter.
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import assert from 'node:assert/strict';

const app = process.env.APP_URL ?? 'http://localhost:5173';
const api = process.env.API_URL ?? app.replace(/:\d+$/, ':3000');
const timeout = Number(process.env.UI_TIMEOUT_MS ?? 30_000);

const check = async () => {
  const health = await fetch(`${api}/api/v1/auth/me`).catch(() => undefined);
  assert.ok(health, `the API is not reachable at ${api}`);
  const body = await health.json();
  assert.equal(body.demo, true, 'demo mode is off: start the API with SAYSIGHT_DEMO_ROLES=1');

  const browser = await chromium.launch({
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(app, { waitUntil: 'networkidle' });

    // Before anyone is signed in, the choice must already be on screen.
    await page.getByText('Demo mode', { exact: false }).first().waitFor();
    const roles = page.getByRole('group', { name: 'Demo role' });
    await roles.waitFor();
    for (const role of ['Submitter', 'Reviewer', 'Maintainer']) {
      await roles.getByRole('button', { name: role, exact: true }).waitFor();
    }
    console.log('OK the role switcher is offered before sign-in, with a demo badge');

    // Reviewer: a session, the queue, and the role recorded as pressed.
    await roles.getByRole('button', { name: 'Reviewer', exact: true }).click();
    await page.getByRole('region', { name: 'Review queue' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#/review');
    assert.equal(await roles.getByRole('button', { name: 'Reviewer', exact: true }).getAttribute('aria-pressed'), 'true');
    console.log('OK Reviewer opens a session and lands on the review queue');

    // The switcher changes identity, so the previous role's powers go with it.
    await roles.getByRole('button', { name: 'Submitter', exact: true }).click();
    await page.getByRole('region', { name: 'Public findings' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#/findings');
    assert.equal(await page.getByRole('region', { name: 'Review queue' }).count(), 0, 'a submitter must not reach the review queue');
    console.log('OK Submitter lands on findings and the review queue is gone');

    await roles.getByRole('button', { name: 'Maintainer', exact: true }).click();
    await page.getByRole('region', { name: 'Upload a dataset draft' }).waitFor();
    console.log('OK Maintainer reaches publication controls');

    // Nothing in the header may leak the internal demo addresses.
    const header = await page.locator('header').textContent();
    assert.ok(!(header ?? '').includes('@demo.invalid'), 'the demo address must not be shown');

    // Accessibility with the switcher present, including the narrow width.
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `horizontal overflow at ${width}px`);
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      assert.equal(violations.length, 0, `axe violations at ${width}px: ${violations.map((item) => `${item.id} on ${item.nodes.map((node) => node.target.join(' ')).join(', ')}`).join(' | ')}`);
    }
    console.log('OK demo header and views: zero axe violations, 0px overflow at 1280px and 375px');
    await context.close();
  } finally {
    await browser.close();
  }
  console.log('DEMO_OK');
};

await check().catch((reason) => {
  console.error(reason instanceof Error ? reason.message : reason);
  process.exit(1);
});

import { expect, test, type Page } from '@playwright/test';

/**
 * Offline acceptance checks.
 *
 * Every request that is not served by the local preview origin must be
 * blocked and recorded. The app must still render, report Offline ready and
 * show no unexpected CSP violations.
 */

const LOCAL_ORIGIN = 'http://localhost:4173';

interface Probe {
  external: string[];
  violations: string[];
}

async function instrument(page: Page): Promise<Probe> {
  const probe: Probe = { external: [], violations: [] };
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(LOCAL_ORIGIN) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) {
      return route.continue();
    }
    probe.external.push(url);
    return route.abort();
  });
  await page.addInitScript(() => {
    window.addEventListener('securitypolicyviolation', (event) => {
      const bucket = (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [];
      bucket.push(event.violatedDirective + ' ' + event.blockedURI);
      (window as unknown as { __cspViolations?: string[] }).__cspViolations = bucket;
    });
  });
  return probe;
}

test('PWA starts offline and reports Offline ready', async ({ page }) => {
  const probe = await instrument(page);
  await page.goto('/');
  const status = page.locator('p.status');
  await expect(status).toContainText('Offline ready', { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'QRRelay' })).toBeVisible();
  expect(probe.external).toEqual([]);
  const violations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  expect(violations).toEqual([]);
});

test('PWA has a precache containing the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('p.status')).toContainText('Offline ready', { timeout: 20_000 });
  const keys = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]!);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(keys).toContain('/index.html');
  expect(keys.some((path) => path.endsWith('.js'))).toBe(true);
  expect(keys.some((path) => path.endsWith('.css'))).toBe(true);
});

test('link check screen opens without a camera and explains the limitation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Link Check' }).click();
  await expect(page.getByRole('heading', { name: 'Link Check' })).toBeVisible();
  // No camera in headless CI: start must fail gracefully and say why.
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.locator('p.status')).not.toHaveText('Checking offline availability…', { timeout: 15_000 });
  await expect(page.locator('p.hint')).not.toBeEmpty();
});

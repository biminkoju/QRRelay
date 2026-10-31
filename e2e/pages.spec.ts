import { expect, test } from '@playwright/test';

/**
 * GitHub Pages compatibility.
 *
 * A project site is served from /<repo>/ rather than the origin root, over
 * HTTPS in production and with a plain static file server. These checks run
 * against the same dist/ directory mounted under a subpath.
 */

const PREFIXED = 'http://localhost:4175/qrrelay/';

test('app starts when served from a subpath', async ({ page }) => {
  const failures: string[] = [];
  page.on('requestfailed', (request) => failures.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(response.status() + ' ' + response.url());
  });

  await page.goto(PREFIXED);
  await expect(page.getByRole('heading', { name: 'QRRelay' })).toBeVisible();
  await expect(page.locator('p.status')).toContainText('Offline ready', { timeout: 20_000 });
  expect(failures).toEqual([]);
});

test('manifest is served as JSON and lists installable icons', async ({ page, request }) => {
  await page.goto(PREFIXED);
  const href = await page.getAttribute('link[rel=manifest]', 'href');
  expect(href).toBe('./manifest.json');

  const response = await request.get(PREFIXED + 'manifest.json');
  expect(response.status()).toBe(200);
  // Pages has historically served .webmanifest as octet-stream, which browsers
  // ignore. manifest.json avoids that entirely; assert the type is JSON-like.
  const type = response.headers()['content-type'] ?? '';
  expect(type).toMatch(/json/i);

  const manifest = (await response.json()) as { icons?: { sizes?: string }[] };
  const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
});

test('service worker precaches the subpath assets', async ({ page }) => {
  await page.goto(PREFIXED);
  await expect(page.locator('p.status')).toContainText('Offline ready', { timeout: 20_000 });
  const paths = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]!);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  // Precache entries are relative, so they resolve under the subpath.
  expect(paths.some((p) => p.endsWith('/qrrelay/index.html'))).toBe(true);
  expect(paths.some((p) => p.endsWith('/qrrelay/manifest.json'))).toBe(true);
});

test('the published HTML contains no root-absolute asset paths', async ({ request }) => {
  const response = await request.get(PREFIXED + 'index.html');
  const html = await response.text();
  expect(html).not.toMatch(/(src|href)="\/[^\/]/);
  // .nojekyll must ship, or Pages may mangle underscore-prefixed entries.
  const nojekyll = await request.get(PREFIXED + '.nojekyll');
  expect(nojekyll.status()).toBe(200);
});

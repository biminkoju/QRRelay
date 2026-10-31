import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The single-file build must open straight from disk with its CSP hashes. */
test('single-file build starts from file:// with no CSP violations', async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    window.addEventListener('securitypolicyviolation', (event) => {
      const bucket = (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [];
      bucket.push(event.violatedDirective + ' ' + event.blockedURI);
      (window as unknown as { __cspViolations?: string[] }).__cspViolations = bucket;
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
      violations.push(message.text());
    }
  });

  const url = pathToFileURL(resolve('dist-single/qrrelay.html')).href;
  const response = await page.goto(url);
  expect(response === null || response.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'QRRelay' })).toBeVisible();
  await expect(page.locator('p.status')).toContainText('Offline ready', { timeout: 15_000 });
  const reported = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  expect(reported).toEqual([]);
  expect(violations).toEqual([]);
});

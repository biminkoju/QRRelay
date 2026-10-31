import { expect, test } from '@playwright/test';

/**
 * The Simulate button must produce a populated table, not empty cells.
 * A blank Forward/Reverse column would look like a successful run while
 * telling the reader nothing, so this is asserted, not assumed.
 */
test.setTimeout(240_000);

test('simulate fills the measurements table', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Link Check' }).click();
  await expect(page.getByRole('heading', { name: 'Link Check' })).toBeVisible();

  await page.getByRole('button', { name: 'Simulate (no camera)' }).click();

  // Six ladder rungs, largest first.
  const rows = page.locator('table.diag tbody tr');
  await expect(rows).toHaveCount(6, { timeout: 180_000 });

  const bytes = await rows.locator('td:nth-child(1)').allTextContents();
  expect(bytes).toEqual(['1024', '512', '256', '128', '64', '32']);

  const forward = await rows.locator('td:nth-child(2)').allTextContents();
  const reverse = await rows.locator('td:nth-child(3)').allTextContents();
  // Every cell must carry a verdict, not an empty string.
  expect(forward.every((t) => t.trim().length > 0)).toBe(true);
  expect(reverse.every((t) => t.trim().length > 0)).toBe(true);
  expect(forward.every((t) => t === 'ok')).toBe(true);
  expect(reverse.every((t) => t === 'ok')).toBe(true);

  const summary = page.locator('p.mono.small').last();
  await expect(summary).toContainText('SIMULATED');
  await expect(summary).toContainText('chunk 512 B');
  // RTT from virtual time is not a measurement; it must not be reported as one.
  await expect(summary).toContainText('RTT n/a (virtual time)');
  await expect(page.locator('p.status')).toContainText('Simulated calibration');
});

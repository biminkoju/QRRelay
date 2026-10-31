import { expect, test } from '@playwright/test';

/**
 * IndexedDB storage, verified in a real browser. Node has no IndexedDB, so the
 * durable path can only be exercised here. This is the only evidence that a
 * reload would not lose received chunks.
 */
test('receiver storage persists across a page reload', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Storage: any = (globalThis as any).__qrrelay.IndexedDbReceiverStorage;
    if (!Storage.isSupported()) return { supported: false };

    const sessionId = 'test-session-' + Date.now();
    const first = new Storage(sessionId);
    await first.commitChunk(0, new Uint8Array([1, 2, 3]));
    await first.commitChunk(1, new Uint8Array([4, 5, 6]));
    const before = { chunks: first.committedChunks, bytes: first.committedBytes };

    // A fresh instance stands in for a reloaded page.
    const second = new Storage(sessionId);
    await second.load();
    const assembled = await second.assemble();
    const after = { chunks: second.committedChunks, bytes: second.committedBytes };

    await second.clear();
    const cleared = new Storage(sessionId);
    await cleared.load();

    return {
      supported: true,
      before,
      after,
      assembled: Array.from(assembled),
      clearedChunks: cleared.committedChunks,
    };
  });

  expect(result.supported).toBe(true);
  if (!result.supported) return;

  expect(result.before).toEqual({ chunks: 2, bytes: 6 });
  // The fresh instance sees what the first one wrote.
  expect(result.after).toEqual({ chunks: 2, bytes: 6 });
  expect(result.assembled).toEqual([1, 2, 3, 4, 5, 6]);
  // Clearing removes them.
  expect(result.clearedChunks).toBe(0);
});
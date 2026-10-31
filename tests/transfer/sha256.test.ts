import { describe, expect, it } from 'vitest';
import { sha256HexChunked } from '../../src/transfer/sha256';
import { sha256Hex } from '../../src/transfer/hash';

/**
 * Hand-written SHA-256 is only defensible if it is checked against the
 * platform. Every test here compares with crypto.subtle on the same bytes.
 */
describe('incremental sha256', () => {
  it('matches crypto.subtle for every length around a block boundary', async () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 13) & 0xff;
      expect(await sha256HexChunked(bytes)).toBe(await sha256Hex(bytes));
    }
  }, 60000);

  it('matches crypto.subtle when split into many small slices', async () => {
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const chunked = await sha256HexChunked(bytes, { sliceBytes: 64 });
    expect(chunked).toBe(await sha256Hex(bytes));
  }, 60000);

  it('matches crypto.subtle for an awkward slice size', async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 3 + 1) & 0xff;
    for (const sliceBytes of [65, 100, 127, 999]) {
      expect(await sha256HexChunked(bytes, { sliceBytes })).toBe(await sha256Hex(bytes));
    }
  }, 60000);

  it('reports progress from 0 to 1', async () => {
    const seen: number[] = [];
    const bytes = new Uint8Array(4096);
    await sha256HexChunked(bytes, { sliceBytes: 1024, onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  }, 60000);

  it('yields between slices so the UI can paint', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      await sha256HexChunked(new Uint8Array(4096), { sliceBytes: 512 });
    } finally {
      clearInterval(timer);
    }
    // If the hash blocked, no timer callback could have run.
    expect(ticks).toBeGreaterThan(0);
  }, 60000);
});

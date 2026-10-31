/** SHA-256 helpers.
 *
 * Phase 1 fixtures are small enough for a one-shot digest. Incremental
 * hashing in a worker is required before large-file transfers are claimed;
 * see docs/IMPLEMENTATION-STATUS.md.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

export const sourceHash = sha256Hex;

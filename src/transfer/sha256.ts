/**
 * Incremental SHA-256 that yields to the event loop.
 *
 * Why not a Worker? The single-file build runs under `worker-src 'none'`, so a
 * worker-based hash would silently break that build. Yielding between slices
 * keeps the same property — the UI stays responsive — while working under both
 * CSPs.
 *
 * Correctness is checked against crypto.subtle on the same input in the tests,
 * which is the only reason writing SHA-256 by hand is defensible here.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Processes 64-byte blocks of `data` into `state`. */
function processBlocks(state: Uint32Array, data: Uint8Array, w: Uint32Array): void {
  const blocks = Math.floor(data.length / 64);
  for (let b = 0; b < blocks; b++) {
    const at = b * 64;
    for (let i = 0; i < 16; i++) {
      const o = at + i * 4;
      w[i] = ((data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, h] = state as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & bb!) ^ (a! & c!) ^ (bb! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + bb!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
}

/** Yields to the event loop so a long hash does not freeze the page. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface HashOptions {
  /** Bytes hashed between yields. Defaults to 1 MiB. */
  sliceBytes?: number;
  /** Called with 0..1 after each slice. */
  onProgress?: (fraction: number) => void;
}

/**
 * Hashes a whole buffer in slices, yielding between them.
 *
 * The input is not copied: slices are fed through a rolling 64-byte window so
 * peak memory stays near the input size rather than doubling it.
 */
export async function sha256HexChunked(
  bytes: Uint8Array,
  options: HashOptions = {},
): Promise<string> {
  const sliceBytes = Math.max(64, Math.floor(options.sliceBytes ?? 1024 * 1024));
  const state = INIT.slice();
  const w = new Uint32Array(64);

  // Leftover bytes that did not fill a block, carried between slices.
  let carry = new Uint8Array(0);
  let offset = 0;

  while (offset < bytes.length) {
    const end = Math.min(offset + sliceBytes, bytes.length);
    const merged = new Uint8Array(carry.length + (end - offset));
    merged.set(carry, 0);
    merged.set(bytes.subarray(offset, end), carry.length);

    const usable = Math.floor(merged.length / 64) * 64;
    if (usable > 0) processBlocks(state, merged.subarray(0, usable), w);
    carry = merged.slice(usable);

    offset = end;
    options.onProgress?.(offset / bytes.length);
    await yieldToLoop();
  }

  // Padding: 0x80, then zeros, then the bit length as a 64-bit big-endian value.
  const bitLength = bytes.length * 8;
  const padLength = carry.length < 56 ? 64 - carry.length : 128 - carry.length;
  const final = new Uint8Array(carry.length + padLength);
  final.set(carry, 0);
  final[carry.length] = 0x80;
  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  const tail = final.length - 8;
  final[tail] = (hi >>> 24) & 0xff;
  final[tail + 1] = (hi >>> 16) & 0xff;
  final[tail + 2] = (hi >>> 8) & 0xff;
  final[tail + 3] = hi & 0xff;
  final[tail + 4] = (lo >>> 24) & 0xff;
  final[tail + 5] = (lo >>> 16) & 0xff;
  final[tail + 6] = (lo >>> 8) & 0xff;
  final[tail + 7] = lo & 0xff;
  processBlocks(state, final, w);

  let out = '';
  for (let i = 0; i < 8; i++) out += state[i]!.toString(16).padStart(8, '0');
  options.onProgress?.(1);
  return out;
}

import { base64UrlDecode, base64UrlEncode } from '../protocol/bytes';
import { encodeQr, type EccLevel } from './encode';
import { renderQrToRgba } from './render';
import { decodeQrText } from './decode';

export interface ByteFidelityResult {
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
}

/** Deterministic test vectors that must survive encode -> render -> decode. */
export const FIDELITY_VECTORS: Array<{ name: string; bytes: Uint8Array }> = [
  { name: 'all byte values', bytes: new Uint8Array(Array.from({ length: 256 }, (_, i) => i)) },
  { name: 'invalid utf-8 lead byte', bytes: new Uint8Array([0xff, 0xfe, 0xfd]) },
  { name: 'lone 0xff', bytes: new Uint8Array([0xff]) },
  { name: 'truncated multi-byte utf-8', bytes: new Uint8Array([0xe2, 0x82]) },
  { name: 'zero run', bytes: new Uint8Array(32) },
  { name: '0xff run', bytes: new Uint8Array(32).fill(0xff) },
];

/**
 * Proves that the bundled encoder and decoder preserve payload bytes exactly.
 * The bytes travel the same way real DATA frames do: Base64URL text inside a
 * QR symbol. If this fails, binary framing must stay disabled.
 */
export function runByteFidelitySelfTest(ecl: EccLevel = 'Q', scale = 4): ByteFidelityResult {
  const checks: ByteFidelityResult['checks'] = [];
  for (const vector of FIDELITY_VECTORS) {
    const text = 'QRF1|DATA|' + '0'.repeat(31) + '1|0|' + base64UrlEncode(vector.bytes) + '|00000000';
    try {
      const image = renderQrToRgba(encodeQr(text, ecl), { scale });
      const decoded = decodeQrText(image);
      if (decoded === null) {
        checks.push({ name: vector.name, pass: false, detail: 'no QR symbol decoded' });
        continue;
      }
      if (decoded !== text) {
        checks.push({ name: vector.name, pass: false, detail: 'decoded frame text differs' });
        continue;
      }
      const bytes = base64UrlDecode(decoded.split('|')[4] ?? '');
      const exact = bytes.length === vector.bytes.length && bytes.every((b, i) => b === vector.bytes[i]);
      checks.push({ name: vector.name, pass: exact, detail: exact ? 'byte-exact' : 'bytes differ after decode' });
    } catch (error) {
      checks.push({ name: vector.name, pass: false, detail: (error as Error).message });
    }
  }
  return { pass: checks.every((c) => c.pass), checks };
}

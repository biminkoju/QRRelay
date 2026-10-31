/** 128-bit session identifiers, rendered as 32 lowercase hex characters. */

export const SESSION_ID_HEX_LENGTH = 32;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;

export function isValidSessionId(text: string): boolean {
  return SESSION_ID_RE.test(text);
}

export function isZeroSessionId(text: string): boolean {
  return /^0{32}$/.test(text);
}

export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function newSessionId(random: RandomBytes = cryptoRandomBytes): string {
  return toHex(random(16));
}

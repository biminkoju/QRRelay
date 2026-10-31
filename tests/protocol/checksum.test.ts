import { describe, expect, it } from 'vitest';
import { crc32, crc32Hex } from '../../src/protocol/checksum';
import { utf8 } from '../../src/protocol/bytes';

describe('crc32 (ISO-HDLC)', () => {
  it('matches the canonical check vector', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });

  it('returns 0 for empty input', () => {
    expect(crc32Hex(new Uint8Array(0))).toBe('00000000');
  });

  it('formats as eight lowercase hex characters', () => {
    expect(crc32Hex(utf8('a'))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('detects a single flipped bit', () => {
    const original = utf8('QRRelay frame');
    const flipped = original.slice();
    flipped[3] ^= 0x01;
    expect(crc32(original)).not.toBe(crc32(flipped));
  });
});

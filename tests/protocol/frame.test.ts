import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode, utf8 } from '../../src/protocol/bytes';
import { decodeFrame, encodeFrame, FrameError } from '../../src/protocol/frame';

const sid = '0123456789abcdef0123456789abcdef';

function roundTrip(type: 'DATA' | 'ACK', payload: Uint8Array, sequence = 0) {
  const text = encodeFrame({ type, sessionId: sid, sequence, payload });
  return decodeFrame(text);
}

describe('QRF1 frame envelope', () => {
  it('round-trips an empty-payload control frame', () => {
    const text = encodeFrame({ type: 'FIN', sessionId: sid, sequence: 0, payload: new Uint8Array(0) });
    const frame = decodeFrame(text);
    expect(frame.type).toBe('FIN');
    expect(frame.sessionId).toBe(sid);
    expect(frame.sequence).toBe(0);
    expect(frame.payload.length).toBe(0);
  });

  it('round-trips arbitrary binary payloads byte-exactly', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const frame = roundTrip('DATA', bytes, 42);
    expect(Array.from(frame.payload)).toEqual(Array.from(bytes));
    expect(frame.sequence).toBe(42);
  });

  it('accepts the maximum 32-bit sequence', () => {
    expect(roundTrip('DATA', utf8('x'), 0xffffffff).sequence).toBe(0xffffffff);
  });

  it('rejects a corrupted CRC', () => {
    const text = encodeFrame({ type: 'ACK', sessionId: sid, sequence: 0, payload: utf8('{}') });
    const tampered = text.slice(0, -1) + (text.at(-1) === '0' ? '1' : '0');
    expect(() => decodeFrame(tampered)).toThrow(FrameError);
  });

  it('rejects a modified payload', () => {
    const text = encodeFrame({ type: 'DATA', sessionId: sid, sequence: 1, payload: utf8('hello') });
    const fields = text.split('|');
    fields[4] = base64UrlEncode(utf8('hellO'));
    expect(() => decodeFrame(fields.join('|'))).toThrow(/CRC/);
  });

  it('rejects wrong field count and magic', () => {
    expect(() => decodeFrame('QRF1|FIN|x|0||00000000|extra')).toThrow(/6 pipe/);
    expect(() => decodeFrame('QRX1|FIN|' + sid + '|0||00000000')).toThrow(/magic/);
  });

  it('rejects uppercase session ids', () => {
    expect(() => decodeFrame('QRF1|FIN|' + sid.toUpperCase() + '|0||00000000')).toThrow(/session/);
  });

  it('reserves the all-zero session id for CAL_BEACON', () => {
    const zero = '0'.repeat(32);
    expect(() => encodeFrame({ type: 'HELLO', sessionId: zero, sequence: 0, payload: new Uint8Array(0) })).toThrow(/all-zero/);
  });

  it('rejects payloads above the size limit', () => {
    expect(() => encodeFrame({ type: 'DATA', sessionId: sid, sequence: 0, payload: new Uint8Array(4097) })).toThrow(/too large/);
  });

  it('rejects malformed base64url', () => {
    expect(() => base64UrlDecode('!!!!')).toThrow();
  });

  it('base64url round-trips without padding', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 0xff);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

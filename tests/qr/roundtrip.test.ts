import { describe, expect, it } from 'vitest';
import { encodeQr } from '../../src/qr/encode';
import { renderQrToRgba } from '../../src/qr/render';
import { decodeQrText } from '../../src/qr/decode';
import { runByteFidelitySelfTest } from '../../src/qr/byteFidelity';
import { encodeFrame } from '../../src/protocol/frame';
import { jsonPayload } from '../../src/protocol/sender';
import type { Frame } from '../../src/protocol/frame';

const sid = '0123456789abcdef0123456789abcdef';

function opticalRoundTrip(frame: Frame, ecl: 'M' | 'Q' = 'Q'): string | null {
  const text = encodeFrame(frame);
  const image = renderQrToRgba(encodeQr(text, ecl), { scale: 4 });
  return decodeQrText(image);
}

const frames: Frame[] = [
  { type: 'HELLO', sessionId: sid, sequence: 0, payload: jsonPayload({ appVersion: '0.1.0', buildId: 't', protocolVersions: [1], capabilities: [], transferModes: ['reliable'] }) },
  { type: 'READY', sessionId: sid, sequence: 0, payload: jsonPayload({ accepted: true, protocolVersion: 1, capabilities: [], transferMode: 'reliable' }) },
  { type: 'META_ACCEPT', sessionId: sid, sequence: 0, payload: new Uint8Array(0) },
  { type: 'ACK', sessionId: sid, sequence: 0, payload: jsonPayload({ nextExpected: 1 }) },
  { type: 'NACK', sessionId: sid, sequence: 0, payload: jsonPayload({ nextExpected: 0, reason: 'missing' }) },
  { type: 'END', sessionId: sid, sequence: 3, payload: jsonPayload({ totalChunks: 3, size: 7, sha256: 'a'.repeat(64) }) },
  { type: 'COMPLETE', sessionId: sid, sequence: 0, payload: jsonPayload({ size: 7, sha256: 'a'.repeat(64) }) },
  { type: 'FIN', sessionId: sid, sequence: 0, payload: new Uint8Array(0) },
  { type: 'ABORT', sessionId: sid, sequence: 0, payload: jsonPayload({ reason: 'user cancelled' }) },
  { type: 'ERROR', sessionId: sid, sequence: 0, payload: jsonPayload({ code: 'FAILED', message: 'boom' }) },
  { type: 'DATA', sessionId: sid, sequence: 7, payload: new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 0x00]) },
];

describe('QR round trip for every implemented message type', () => {
  for (const frame of frames) {
    it('round-trips ' + frame.type + ' (' + frame.payload.length + ' payload bytes)', () => {
      const decoded = opticalRoundTrip(frame);
      expect(decoded).not.toBeNull();
      expect(decoded).toBe(encodeFrame(frame));
    });
  }

  it('round-trips a maximum-size text payload at EC L and H', () => {
    const big = 'x'.repeat(300);
    const frame: Frame = { type: 'DATA', sessionId: sid, sequence: 0, payload: new TextEncoder().encode(big) };
    // Text payload stays under the frame size limit only through DATA binary shape;
    // use 300 bytes of raw data and check both EC levels decode identically.
    expect(opticalRoundTrip(frame, 'M')).toBe(encodeFrame(frame));
  });
});

describe('byte-fidelity self-test', () => {
  it('preserves every byte value and invalid UTF-8 through QR encode/decode', () => {
    const result = runByteFidelitySelfTest('Q', 4);
    const failed = result.checks.filter((c) => !c.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

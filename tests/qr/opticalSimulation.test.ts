import { describe, expect, it } from 'vitest';
import { runSimulation, deterministicRandomBytes, type FrameCodec } from '../../src/protocol/simulation';
import { newSessionId } from '../../src/protocol/session';
import { sourceFromBytes } from '../../src/transfer/source';
import { InMemoryReceiverStorage } from '../../src/transfer/receiverStorage';
import { sha256Hex } from '../../src/transfer/hash';
import { encodeQr, type EccLevel } from '../../src/qr/encode';
import { renderQrToRgba } from '../../src/qr/render';
import { decodeQrText } from '../../src/qr/decode';

/** Every protocol frame really becomes a QR bitmap and is decoded from it. */
function qrCodec(ecl: EccLevel = 'Q'): FrameCodec {
  return {
    encode: (text) => {
      const image = renderQrToRgba(encodeQr(text, ecl), { scale: 3 });
      // Pack the bitmap as a text key so the fake channel stays string-based.
      const bits: string[] = [];
      for (let i = 0; i < image.data.length; i += 4) bits.push(image.data[i] === 0 ? '1' : '0');
      return image.width + 'x' + bits.join('');
    },
    decode: (key) => {
      const [sizeText, bits] = key.split('x');
      const size = Number(sizeText);
      if (!Number.isInteger(size) || size <= 0 || !bits) return null;
      const data = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const dark = bits.charAt(i) === '1';
        const value = dark ? 0 : 255;
        data[i * 4] = value;
        data[i * 4 + 1] = value;
        data[i * 4 + 2] = value;
        data[i * 4 + 3] = 255;
      }
      return decodeQrText({ width: size, height: size, data });
    },
  };
}

async function transferThroughQr(bytes: Uint8Array, ecl: EccLevel, seed: number) {
  const sha = await sha256Hex(bytes);
  const storage = new InMemoryReceiverStorage();
  const result = await runSimulation({
    source: sourceFromBytes('fixture.bin', bytes, sha),
    sessionId: newSessionId(deterministicRandomBytes(seed + 500)),
    storage,
    codec: qrCodec(ecl),
    seed,
  });
  return { result, storage, sha };
}

describe('simulated transfer routed through real QR images', () => {
  it('transfers a small binary file with no injected faults', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 0xfe, 0xff, 0x80, 0x7f]);
    const { result, storage, sha } = await transferThroughQr(bytes, 'Q', 21);
    expect(result.verified).toBe(true);
    expect(await sha256Hex(await storage.assemble())).toBe(sha);
  }, 30000);

  it('transfers a multi-chunk file at EC M', async () => {
    const bytes = deterministicRandomBytes(99)(1200);
    const { result, storage, sha } = await transferThroughQr(bytes, 'M', 22);
    expect(result.verified).toBe(true);
    expect(await sha256Hex(await storage.assemble())).toBe(sha);
  }, 60000);

  it('still verifies when the optical channel drops frames', async () => {
    const bytes = deterministicRandomBytes(98)(800);
    const sha = await sha256Hex(bytes);
    const storage = new InMemoryReceiverStorage();
    const result = await runSimulation({
      source: sourceFromBytes('fixture.bin', bytes, sha),
      sessionId: newSessionId(deterministicRandomBytes(777)),
      storage,
      codec: qrCodec('Q'),
      forward: { dropRate: 0.15 },
      reverse: { dropRate: 0.15 },
      seed: 23,
    });
    expect(result.verified).toBe(true);
    expect(await sha256Hex(await storage.assemble())).toBe(sha);
  }, 60000);
});

import { describe, expect, it } from 'vitest';
import { encodeQr, maxFrameTextLength, QrEncodeError } from '../../src/qr/encode';
import { MIN_QUIET_ZONE, renderQrToRgba } from '../../src/qr/render';

const frame = 'QRF1|FIN|0123456789abcdef0123456789abcdef|0||cbf43926';

describe('QR encoding', () => {
  it('encodes a frame and reports its version', () => {
    const qr = encodeQr(frame, 'Q');
    expect(qr.version).toBeGreaterThanOrEqual(1);
    expect(qr.version).toBeLessThanOrEqual(40);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.ecl).toBe('Q');
  });

  it('exposes a boolean module matrix of the right size', () => {
    const qr = encodeQr(frame, 'M');
    expect(qr.modules).toHaveLength(qr.size);
    expect(qr.modules.every((row) => row.length === qr.size)).toBe(true);
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        expect(qr.modules[y][x]).toBe(qr.isDark(x, y));
      }
    }
  });

  it('rejects an empty payload', () => {
    expect(() => encodeQr('', 'Q')).toThrow(QrEncodeError);
  });

  it('rejects a payload beyond QR capacity', () => {
    expect(() => encodeQr('A'.repeat(5000), 'H')).toThrow(/capacity/);
  });

  it('shows capacity shrinking as error correction rises', () => {
    // 2000 alphanumeric characters fit at EC L but not at EC H.
    expect(() => encodeQr('A'.repeat(2000), 'L')).not.toThrow();
    expect(() => encodeQr('A'.repeat(2000), 'H')).toThrow(/capacity/);
    // The reported capacity probe is consistent with those two facts.
    expect(maxFrameTextLength('L')).toBeGreaterThanOrEqual(2000);
    expect(maxFrameTextLength('H')).toBeLessThan(2000);
    expect(maxFrameTextLength('H')).toBeGreaterThan(100);
  }, 20000);
});

describe('QR rendering', () => {
  it('uses integer scaling with a white quiet zone', () => {
    const qr = encodeQr(frame, 'Q');
    const image = renderQrToRgba(qr, { scale: 3, quietZone: MIN_QUIET_ZONE });
    expect(image.width).toBe((qr.size + 2 * MIN_QUIET_ZONE) * 3);
    expect(image.height).toBe(image.width);
    // Top-left pixel lies in the quiet zone and must be white.
    expect(Array.from(image.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
    // Every pixel must be pure black or pure white, with equal RGB channels.
    // Counted rather than asserted per pixel so the check stays fast.
    let impure = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      if ((r !== 0 && r !== 255) || g !== r || b !== r || a !== 255) impure++;
    }
    expect(impure).toBe(0);
  }, 20000);

  it('rejects a quiet zone below the QR minimum and fractional scale', () => {
    const qr = encodeQr(frame, 'Q');
    expect(() => renderQrToRgba(qr, { quietZone: 2 })).toThrow(/quiet zone/);
    expect(() => renderQrToRgba(qr, { scale: 1.5 })).toThrow(/integer/);
  });
});

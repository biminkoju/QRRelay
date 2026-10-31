import type { EncodedQr } from './encode';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export interface RenderOptions {
  /** Quiet zone in modules on every side (QR spec minimum is 4). */
  quietZone?: number;
  /** Pixels per module; must be a positive integer for crisp edges. */
  scale?: number;
}

export const MIN_QUIET_ZONE = 4;

/**
 * Renders a QR symbol to an RGBA bitmap using integer module scaling and a
 * plain white quiet zone. No anti-aliasing, no gradients, no recolouring.
 */
export function renderQrToRgba(qr: EncodedQr, options: RenderOptions = {}): RgbaImage {
  const quietZone = options.quietZone ?? MIN_QUIET_ZONE;
  const scale = options.scale ?? 4;
  if (!Number.isInteger(scale) || scale < 1) throw new Error('scale must be a positive integer');
  if (!Number.isInteger(quietZone) || quietZone < MIN_QUIET_ZONE) {
    throw new Error('quiet zone must be an integer of at least ' + MIN_QUIET_ZONE + ' modules');
  }
  const modulesAcross = qr.size + quietZone * 2;
  const pixels = modulesAcross * scale;
  const data = new Uint8ClampedArray(pixels * pixels * 4);
  data.fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.isDark(x, y)) continue;
      const px0 = (x + quietZone) * scale;
      const py0 = (y + quietZone) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const rowStart = ((py0 + dy) * pixels + px0) * 4;
        for (let dx = 0; dx < scale; dx++) {
          const at = rowStart + dx * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
          data[at + 3] = 255;
        }
      }
    }
  }
  return { width: pixels, height: pixels, data };
}

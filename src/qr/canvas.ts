import type { EncodedQr } from './encode';
import { MIN_QUIET_ZONE } from './render';

/**
 * Draws a QR symbol into a canvas at an integer module scale, centred, with a
 * white quiet zone. Module size is an integer number of device pixels so
 * module edges stay crisp on HiDPI displays.
 */
export function drawQrToCanvas(
  canvas: HTMLCanvasElement,
  qr: EncodedQr,
  options: { quietZone?: number; maxCssSize?: number } = {},
): void {
  const quietZone = options.quietZone ?? MIN_QUIET_ZONE;
  const maxCssSize = options.maxCssSize ?? 720;
  const ratio = Math.max(1, Math.floor(globalThis.devicePixelRatio || 1));
  const modulesAcross = qr.size + quietZone * 2;
  const scaleCss = Math.max(1, Math.floor(maxCssSize / modulesAcross));
  const scale = scaleCss * ratio;
  const pixels = modulesAcross * scale;

  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = modulesAcross * scaleCss + 'px';
  canvas.style.height = modulesAcross * scaleCss + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pixels, pixels);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.isDark(x, y)) continue;
      ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
    }
  }
}

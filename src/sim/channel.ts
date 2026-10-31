import { decodeQrText } from '../qr/decode';
import { encodeQr, type EccLevel } from '../qr/encode';
import { renderQrToRgba, type RgbaImage } from '../qr/render';

/**
 * A simulated optical channel.
 *
 * Encodes a frame exactly as the display would, then degrades the bitmap the
 * way a camera at distance would degrade it: it shrinks the image to a capture
 * resolution, optionally blurs it, dims it and adds sensor noise. The result is
 * fed to the same decoder the real scanner uses.
 *
 * This is a model, not a measurement. It cannot tell you your webcam's real
 * limits. It can tell you whether a symbol survives a given number of capture
 * pixels per module, which is the variable that actually decides decodability.
 */

export interface ChannelOptions {
  /** CSS pixels per module when the symbol is drawn. */
  modulePx: number;
  /** Width, in pixels, of the simulated camera capture. */
  captureWidth: number;
  /** Box-blur radius in capture pixels. 0 disables blur. */
  blurRadius: number;
  /** Uniform noise amplitude, 0..1, added to every channel. */
  noise: number;
  /** Brightness multiplier, 0..1.5. */
  brightness: number;
  /**
   * Contrast, 0..2. Applied around mid-grey as 128 + (v - 128) * contrast.
   * Below 1 this compresses the dynamic range, which is what a washed-out or
   * glare-flooded capture actually does: black and white both drift towards
   * grey, and the decoder eventually cannot tell them apart. A plain
   * brightness multiplier cannot model this, because it scales both equally
   * and preserves their separation.
   */
  contrast: number;
  /** Quiet zone in modules. The QR minimum is 4. */
  quietZone: number;
  /** Seed, so a given configuration always degrades identically. */
  seed: number;
}

export const DEFAULT_CHANNEL: ChannelOptions = {
  modulePx: 8,
  captureWidth: 640,
  blurRadius: 0,
  noise: 0,
  brightness: 1,
  contrast: 1,
  quietZone: 4,
  seed: 1,
};

export interface CaptureResult {
  /** What the simulated camera produced, for display. */
  capture: RgbaImage;
  /** What the decoder got back, or null. */
  decoded: string | null;
  /** The number that matters: capture pixels per QR module. */
  capturePxPerModule: number;
  /** Modules across, quiet zone excluded. */
  modules: number;
}

/** Deterministic PRNG, so a failing configuration is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Area-average downscale. A camera samples an area per pixel, it does not pick one. */
function downscaleArea(image: RgbaImage, targetWidth: number): RgbaImage {
  if (targetWidth >= image.width) return image;
  const targetHeight = Math.max(1, Math.round((image.height / image.width) * targetWidth));
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const xRatio = image.width / targetWidth;
  const yRatio = image.height / targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * image.width + sx) * 4;
          r += image.data[at]!;
          g += image.data[at + 1]!;
          b += image.data[at + 2]!;
          a += image.data[at + 3]!;
          n++;
        }
      }
      const to = (y * targetWidth + x) * 4;
      data[to] = r / n;
      data[to + 1] = g / n;
      data[to + 2] = b / n;
      data[to + 3] = a / n;
    }
  }
  return { width: targetWidth, height: targetHeight, data };
}

/** Separable box blur, two passes for a smoother falloff. */
function blurBox(image: RgbaImage, radius: number): RgbaImage {
  if (radius < 1) return image;
  const { width, height } = image;
  let source = image.data;
  let target = new Uint8ClampedArray(source.length);
  const pass = (horizontal: boolean): void => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let d = -radius; d <= radius; d++) {
          const sx = horizontal ? x + d : x;
          const sy = horizontal ? y : y + d;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          const at = (sy * width + sx) * 4;
          r += source[at]!;
          g += source[at + 1]!;
          b += source[at + 2]!;
          n++;
        }
        const to = (y * width + x) * 4;
        target[to] = r / n;
        target[to + 1] = g / n;
        target[to + 2] = b / n;
        target[to + 3] = 255;
      }
    }
    const swap = source;
    source = target;
    target = new Uint8ClampedArray(swap.length);
  };
  pass(true);
  pass(false);
  return { width, height, data: source };
}

/**
 * Brightness, then contrast around mid-grey, then noise. Order matters: a
 * camera dims the light, glare reduces contrast, and the sensor adds noise
 * last. Contrast is applied after brightness so a dark capture is not
 * accidentally re-expanded.
 */
function applyBrightnessAndNoise(
  image: RgbaImage,
  brightness: number,
  contrast: number,
  noise: number,
  seed: number,
): RgbaImage {
  const random = mulberry32(seed);
  const data = new Uint8ClampedArray(image.data.length);
  const stretch = (value: number): number => 128 + (value - 128) * contrast;
  for (let i = 0; i < image.data.length; i += 4) {
    const jitter = noise > 0 ? (random() * 2 - 1) * noise * 255 : 0;
    data[i] = stretch(image.data[i]! * brightness) + jitter;
    data[i + 1] = stretch(image.data[i + 1]! * brightness) + jitter;
    data[i + 2] = stretch(image.data[i + 2]! * brightness) + jitter;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

/** Draws, degrades and decodes one frame. Pure and deterministic. */
export function simulateCapture(text: string, ecl: EccLevel, options: ChannelOptions): CaptureResult {
  const qr = encodeQr(text, ecl);
  const source = renderQrToRgba(qr, { scale: Math.max(1, Math.round(options.modulePx)), quietZone: options.quietZone });
  let capture = downscaleArea(source, Math.max(8, Math.round(options.captureWidth)));
  capture = blurBox(capture, Math.round(options.blurRadius));
  capture = applyBrightnessAndNoise(capture, options.brightness, options.contrast, options.noise, options.seed);
  const decoded = decodeQrText(capture);
  return {
    capture,
    decoded: decoded === text ? decoded : null,
    capturePxPerModule: (capture.width / (qr.size + options.quietZone * 2)),
    modules: qr.size,
  };
}

/** Capture width that yields roughly this many capture pixels per module. */
export function captureWidthFor(modules: number, quietZone: number, pxPerModule: number): number {
  return Math.max(8, Math.round((modules + quietZone * 2) * pxPerModule));
}

import { decodeQrText } from '../qr/decode';
import { createDuplicateFilter, emptyStats, type ScannerStats } from './frameStats';

/**
 * Continuous scanner.
 *
 * The video frame is drawn to an offscreen canvas *unmirrored*; only the
 * preview may be mirrored with CSS, and that never touches this canvas.
 * requestVideoFrameCallback() is used when available so each camera frame is
 * examined at most once, with a timer fallback elsewhere.
 */

export interface ScannerOptions {
  onDecode(text: string): void;
  onStats?(stats: ScannerStats): void;
  /** Target minimum interval between decode attempts, in ms. */
  minAttemptIntervalMs?: number;
  /** Requested analysis width; the height follows the aspect ratio. */
  analysisWidth?: number;
  /** Emit repeated identical decodes as well (diagnostics only). */
  emitDuplicates?: boolean;
}

export interface ScannerHandle {
  stop(): void;
  stats(): ScannerStats;
  /** Signals that the page is hidden and scanning is suspended. */
  readonly suspended: boolean;
}

type VideoFrameCallback = (now: number, metadata: unknown) => void;
type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function require2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('2D canvas context unavailable for scanning');
  return ctx;
}

export function startScanner(video: HTMLVideoElement, options: ScannerOptions): ScannerHandle {
  const minInterval = options.minAttemptIntervalMs ?? 100;
  const analysisWidth = options.analysisWidth ?? 480;
  const canvas = document.createElement('canvas');
  const ctx: CanvasRenderingContext2D = require2dContext(canvas);

  const filter = createDuplicateFilter();
  const state = emptyStats();
  let running = true;
  let lastAttempt = 0;
  let callbackHandle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let suspended = false;
  const v = video as VideoWithCallback;
  const usesFrameCallback = typeof v.requestVideoFrameCallback === 'function';

  function grabAndDecode(nowMs: number): void {
    if (!running || suspended) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    if (nowMs - lastAttempt < minInterval) return;
    lastAttempt = nowMs;
    state.framesExamined++;

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const width = Math.min(analysisWidth, sourceWidth);
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    state.decodeAttempts++;
    const text = decodeQrText({ width, height, data: image.data });
    if (text === null) return;
    state.decoded++;
    state.lastDecodeAt = nowMs;
    if (!options.emitDuplicates && filter.isDuplicate(text)) return;
    state.distinct++;
    options.onDecode(text);
    options.onStats?.({ ...state });
  }

  function frameLoop(now: number): void {
    if (!running) return;
    grabAndDecode(now);
    schedule();
  }

  function schedule(): void {
    if (!running) return;
    if (usesFrameCallback) {
      callbackHandle = v.requestVideoFrameCallback!(frameLoop);
    } else {
      timer = setTimeout(() => frameLoop(performance.now()), minInterval);
    }
  }

  function onVisibility(): void {
    suspended = document.visibilityState === 'hidden';
  }

  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  schedule();

  return {
    stop() {
      running = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (callbackHandle !== null && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(callbackHandle);
      if (timer !== null) clearTimeout(timer);
      callbackHandle = null;
      timer = null;
    },
    stats: () => ({ ...state }),
    get suspended() {
      return suspended;
    },
  };
}

/**
 * Camera acquisition. Permission is only requested from a user action.
 * Tracks are always stopped by stop(); callers must call it on session end.
 */

export class CameraError extends Error {
  override name = 'CameraError';
  readonly code: 'INSECURE' | 'UNSUPPORTED' | 'DENIED' | 'NO_DEVICE' | 'FAILED';
  constructor(code: CameraError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraSession {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  readonly settings: MediaTrackSettings;
  stop(): void;
}

export function cameraSupport(): { secure: boolean; getUserMedia: boolean } {
  return {
    secure: Boolean(globalThis.isSecureContext),
    getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
  };
}

function ensureSupported(): void {
  const support = cameraSupport();
  if (!support.secure) {
    throw new CameraError(
      'INSECURE',
      'Camera access needs a secure context. Open the installed PWA or serve the app from a localhost origin; a file:// page cannot open a camera in most browsers.',
    );
  }
  if (!support.getUserMedia) {
    throw new CameraError('UNSUPPORTED', 'This browser does not expose getUserMedia.');
  }
}

/** Enumerates cameras. Labels only appear after permission was granted once. */
export async function listCameras(): Promise<CameraDevice[]> {
  ensureSupported();
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || 'Camera ' + (i + 1) }));
}

export interface StartOptions {
  deviceId?: string;
  width?: number;
  height?: number;
  /** Reuse a visible <video> element instead of a detached one. */
  video?: HTMLVideoElement;
}

export async function startCamera(options: StartOptions = {}): Promise<CameraSession> {
  ensureSupported();
  const video = options.video ?? document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      width: { ideal: options.width ?? 1280 },
      height: { ideal: options.height ?? 720 },
    },
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    const name = (error as DOMException).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('DENIED', 'Camera permission was denied. Grant it in the browser site settings and retry.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('NO_DEVICE', 'No usable camera was found for these constraints.');
    }
    throw new CameraError('FAILED', 'Camera could not be started: ' + (error as Error).message);
  }

  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];

  return {
    stream,
    video,
    settings: track ? track.getSettings() : {},
    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}

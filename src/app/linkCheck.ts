import {
  applyPeerBeacon,
  CALIBRATION_SESSION_ID,
  initialState,
  localBeacon,
  type AlignmentState,
} from "../protocol/alignment";
import { decodeFrame, encodeFrame, FrameError, type ValidatedFrame } from "../protocol/frame";
import { jsonPayload } from "../protocol/sender";
import { validateBeacon } from "../protocol/messageTypes";
import {
  CalibrationRunner,
  type CalibrationDiagnostics,
  type CalibrationPhase,
} from "../protocol/calibrationRunner";
import type { LinkProfile } from "../protocol/calibration";
import { newSessionId } from "../protocol/session";
import {
  startCamera,
  listCameras,
  cameraSupport,
  CameraError,
  type CameraSession,
  type Facing,
} from "../camera/cameraManager";
import { startScanner, type ScannerHandle } from "../camera/qrScanner";
import { acquireWakeLock, type WakeLockHandle } from "../camera/wakeLock";
import { decodeRatePerSecond, qualityLabel } from "../camera/frameStats";
import { encodeQr } from "../qr/encode";
import { drawQrToCanvas } from "../qr/canvas";
import { APP_VERSION, BUILD_ID, SUPPORTED_PROTOCOL_VERSIONS } from "../version";

export interface LinkCheckLocal {
  appVersion: string;
  buildId: string;
  protocolVersions: number[];
  capabilities: string[];
}

export interface LinkCheckView {
  /** Facing actually in use, or null when the platform does not report it. */
  cameraFacing: Facing | null;
  /** Human-readable phase for the status line. */
  phase: string;
  localNonce: string;
  peerNonce: string | null;
  iSeePeer: boolean;
  peerSeesMe: boolean;
  linkUp: boolean;
  calId: string | null;
  leader: boolean;
  peerAppVersion: string | null;
  peerProtocolVersions: number[] | null;
  decodeRate: number;
  quality: string;
  cameraError: string | null;
  hint: string;
  /** False until link-up; calibration cannot start earlier. */
  canCalibrate: boolean;
  calibration: CalibrationPhase;
  calibrationMessage: string;
  profile: LinkProfile | null;
  /** Raw measurements, or null before calibration starts. */
  diagnostics: CalibrationDiagnostics | null;
  /** EC level the current display frame is encoded at. */
  frameEcl: "L" | "M" | "Q" | "H";
}

export interface LinkCheckCallbacks {
  /**
   * Every frame that is not a calibration beacon, so file transfer can
   * claim it. Returning true means the frame was consumed.
   */
  onPeerFrame?(frame: ValidatedFrame): boolean;
  onView(view: LinkCheckView): void;
}

/**
 * Orchestrates one device's half of the link check: generate a nonce, display
 * a beacon QR, scan the peer's display, and track bidirectional confirmation.
 * All protocol decisions live in protocol/alignment.ts; this class only wires
 * device I/O to it.
 */
export class LinkCheckController {
  private readonly local: LinkCheckLocal;
  private readonly callbacks: LinkCheckCallbacks;
  private state: AlignmentState;
  private camera: CameraSession | null = null;
  private scanner: ScannerHandle | null = null;
  private wakeLock: WakeLockHandle | null = null;
  private firstDecodeAt: number | null = null;
  private cameraError: string | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private calibration: CalibrationRunner | null = null;
  private calibrationTimer: ReturnType<typeof setInterval> | null = null;
  private calibrationMessage = "Not started";
  private profile: LinkProfile | null = null;
  private calibrationSeq = 0;

  constructor(local: LinkCheckLocal, callbacks: LinkCheckCallbacks) {
    this.local = local;
    this.callbacks = callbacks;
    this.state = initialState(newSessionId());
  }

  /** The live camera session, or null when stopped. */
  get cameraSession(): CameraSession | null {
    return this.camera;
  }

  get alignment(): AlignmentState {
    return this.state;
  }

  /** The beacon this device must currently display. */
  currentBeaconFrame(): string {
    return encodeFrame({
      type: "CAL_BEACON",
      sessionId: CALIBRATION_SESSION_ID,
      sequence: 0,
      payload: jsonPayload(localBeacon(this.state, this.local)),
    });
  }

  emitView(): void {
    const rate =
      this.firstDecodeAt === null
        ? 0
        : decodeRatePerSecond(
            this.scanner?.stats() ?? {
              framesExamined: 0,
              decodeAttempts: 0,
              decoded: 0,
              distinct: 0,
              lastDecodeAt: null,
            },
            performance.now(),
            this.firstDecodeAt,
          );
    this.callbacks.onView({
      phase:
        this.state.phase === "link-up"
          ? "Link up (both directions)"
          : "Aligning cameras",
      localNonce: this.state.nonce,
      peerNonce: this.state.peerNonce,
      iSeePeer: this.state.peerSeen,
      peerSeesMe: this.state.peerSeesUs,
      linkUp: this.state.phase === "link-up",
      calId: this.state.calId,
      leader: this.state.leader,
      peerAppVersion: this.state.peerInfo?.appVersion ?? null,
      peerProtocolVersions: this.state.peerInfo?.protocolVersions ?? null,
      decodeRate: rate,
      quality: qualityLabel(rate),
      cameraError: this.cameraError,
      hint: this.hintFor(),
      canCalibrate:
        this.state.phase === "link-up" &&
        this.state.calId !== null &&
        this.calibration === null,
      calibration: this.calibration?.currentPhase ?? "idle",
      calibrationMessage: this.calibrationMessage,
      profile: this.profile,
      diagnostics: this.calibration?.diagnostics ?? null,
      frameEcl: this.displayEcl(),
      cameraFacing: this.camera?.facing ?? null,
    });
  }

  private hintFor(): string {
    if (this.cameraError) return this.cameraError;
    if (!cameraSupport().secure)
      return "Camera needs a secure context: use the installed PWA or a localhost origin.";
    if (this.state.phase === "link-up")
      return "Both screens are visible to each other. Calibration can start.";
    if (!this.state.peerSeen)
      return "Point this camera at the other screen. If nothing appears, lower the glare, raise the other screen brightness, or adjust the lid angle.";
    if (!this.state.peerSeesUs)
      return "This device sees the peer, but the peer does not see this screen yet. Angle the other camera toward this display.";
    return "Re-establishing the link.";
  }

  async start(
    video?: HTMLVideoElement,
    facingMode: Facing = "environment",
  ): Promise<void> {
    this.stopped = false;
    this.wakeLock = await acquireWakeLock();
    try {
      this.camera = await startCamera(
        video ? { video, facingMode } : { facingMode },
      );
      this.cameraError = null;
    } catch (error) {
      this.cameraError = (error as CameraError).message;
      this.emitView();
      throw error;
    }
    this.scanner = startScanner(this.camera.video, {
      onDecode: (text) => void this.handleDecoded(text),
    });
    this.statsTimer = setInterval(() => this.emitView(), 500);
    this.emitView();
  }

  async switchCamera(
    deviceId: string | undefined,
    video?: HTMLVideoElement,
    facingMode?: Facing,
  ): Promise<void> {
    this.stopDevices();
    const options = {
      ...(deviceId ? { deviceId } : {}),
      ...(facingMode && !deviceId ? { facingMode } : {}),
      ...(video ? { video } : {}),
    };
    this.camera = await startCamera(options);
    this.scanner = startScanner(this.camera.video, {
      onDecode: (text) => void this.handleDecoded(text),
    });
    this.statsTimer = setInterval(() => this.emitView(), 500);
    this.emitView();
  }

  /**
   * Starts bidirectional calibration. Requires link-up: the profile is only
   * meaningful once both sides have confirmed they can see each other.
   */
  startCalibration(nowMs: number = performance.now()): void {
    if (this.calibration !== null) return;
    if (this.state.phase !== "link-up" || this.state.calId === null) {
      this.calibrationMessage = "Link-up is required before calibration";
      this.emitView();
      return;
    }
    const runner = new CalibrationRunner({
      role: this.state.leader ? "leader" : "follower",
      calId: this.state.calId,
    });
    this.calibration = runner;
    this.profile = null;
    this.calibrationMessage =
      "Calibration started as " + (this.state.leader ? "leader" : "follower");
    runner.start(nowMs);
    this.calibrationTimer = setInterval(() => this.calibrationTick(), 250);
    this.emitView();
  }

  private calibrationTick(): void {
    const runner = this.calibration;
    if (!runner || this.stopped) return;
    const now = performance.now();
    runner.tick(now);
    for (const event of runner.drainEvents()) {
      this.calibrationMessage = event.message;
      this.emit("calibration", event.message);
    }
    if (runner.currentPhase === "done") {
      this.profile = runner.result;
      this.calibrationMessage =
        "Calibration complete: " +
        (runner.result?.chunkSize ?? 0) +
        " bytes per frame";
      this.emit("calibration", this.calibrationMessage);
      this.stopCalibrationTimer();
    }
    this.emitView();
  }

  private stopCalibrationTimer(): void {
    if (this.calibrationTimer !== null) clearInterval(this.calibrationTimer);
    this.calibrationTimer = null;
  }

  /** Diagnostics sink; the screen renders views, so this is a no-op hook. */
  private emit(_kind: string, _message: string): void {}

  /**
   * EC level for the frame currently on screen. Calibration frames must be
   * drawn at the level the runner reports, or the probe's own `ecl` field
   * contradicts what the camera actually sees.
   */
  displayEcl(): "L" | "M" | "Q" | "H" {
    if (this.calibration !== null && this.calibration.currentFrame() !== null) {
      return this.calibration.eclLevel;
    }
    return "Q";
  }

  displayFrameText(): string {
    if (this.calibration !== null) {
      const frame = this.calibration.currentFrame();
      if (frame !== null) return frame;
      if (this.calibration.currentPhase === "done")
        return this.currentBeaconFrame();
    }
    return this.currentBeaconFrame();
  }

  private async handleDecoded(text: string): Promise<void> {
    if (this.stopped) return;
    let frame;
    try {
      frame = decodeFrame(text);
    } catch {
      return;
    }
    // Any calibration frame belongs to the runner, never to the beacon logic.
    if (frame.type !== "CAL_BEACON" && this.callbacks.onPeerFrame?.(frame))
      return;
    if (frame.type !== "CAL_BEACON") {
      if (frame.sessionId !== CALIBRATION_SESSION_ID) return;
      this.calibrationSeq++;
      this.calibration?.onFrame(frame, performance.now());
      return;
    }
    if (frame.sessionId !== CALIBRATION_SESSION_ID) return;
    let beacon;
    try {
      beacon = validateBeacon(frame.json);
    } catch {
      return;
    }
    if (this.firstDecodeAt === null) this.firstDecodeAt = performance.now();
    const result = await applyPeerBeacon(this.state, beacon);
    if (result.state !== this.state) {
      this.state = result.state;
      this.emitView();
    }
  }

  private stopDevices(): void {
    this.stopCalibrationTimer();
    this.scanner?.stop();
    this.scanner = null;
    this.camera?.stop();
    this.camera = null;
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopDevices();
    await this.wakeLock?.release();
    this.wakeLock = null;
  }
}

export function linkCheckLocal(): LinkCheckLocal {
  return {
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: ["reliable", "text"],
  };
}

export {
  listCameras,
  cameraSupport,
  CameraError,
  FrameError,
  drawQrToCanvas,
  encodeQr,
};

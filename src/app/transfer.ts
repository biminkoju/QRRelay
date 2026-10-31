import { TransferSession, type TransferEvent, type TransferResult } from '../transfer/session';
import { sourceFromBytes } from '../transfer/source';
import { sha256Hex } from '../transfer/hash';
import type { ValidatedFrame } from '../protocol/frame';
import { newSessionId } from '../protocol/session';
import { APP_VERSION, BUILD_ID, SUPPORTED_PROTOCOL_VERSIONS } from '../version';
import { DEFAULT_CONFIG } from '../protocol/constants';

/**
 * File transfer orchestration for the Link Check screen.
 *
 * Deliberately thin: every protocol decision lives in TransferSession. This
 * class owns only the browser parts — reading the chosen file, offering the
 * received bytes back as a download, and routing decoded frames.
 */

export type TransferUiPhase = 'idle' | 'sending' | 'receiving' | 'finished' | 'failed';

export interface TransferUiView {
  phase: TransferUiPhase;
  message: string;
  sentChunks: number;
  totalChunks: number;
  fileName: string | null;
  receivedBytes: Uint8Array | null;
  receivedSha256: string | null;
  outcome: string | null;
}

export interface TransferUiOptions {
  onChange(view: TransferUiView): void;
  onFrame(frameText: string | null): void;
  /** Read on each use: calibration may finish after the controller exists. */
  chunkSize(): number | null;
}

const EMPTY_VIEW: TransferUiView = {
  phase: 'idle',
  message: 'No transfer in progress',
  sentChunks: 0,
  totalChunks: 0,
  fileName: null,
  receivedBytes: null,
  receivedSha256: null,
  outcome: null,
};

export class TransferController {
  private readonly options: TransferUiOptions;
  private session: TransferSession | null = null;
  private sessionId = newSessionId();
  private timer: ReturnType<typeof setInterval> | null = null;
  private view: TransferUiView = { ...EMPTY_VIEW };

  constructor(options: TransferUiOptions) {
    this.options = options;
  }

  get currentView(): TransferUiView {
    return { ...this.view };
  }

  get active(): boolean {
    return this.session !== null && this.session.currentPhase === 'running';
  }
  private local() {
    return {
      appVersion: APP_VERSION,
      buildId: BUILD_ID,
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: ['reliable'],
    };
  }

  private chunkSize(): number {
    const size = this.options.chunkSize();
    if (size === null) throw new Error('calibration must run before a transfer');
    return size;
  }

  private config() {
    return {
      ...DEFAULT_CONFIG,
      chunkSize: this.chunkSize(),
      ackTimeoutMs: 15000,
      maxRetries: 20,
    };
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (!this.session) return;
      this.session.tick();
      this.drain();
    }, 250);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private drain(): void {
    if (!this.session) return;
    for (const event of this.session.drainEvents()) this.applyEvent(event);
    this.options.onFrame(this.session.currentFrame());
    const result = this.session.result;
    if (result && this.view.outcome === null) this.finish(result);
    this.options.onChange({ ...this.view });
  }

  private applyEvent(event: TransferEvent): void {
    this.view.message = event.message;
    if (event.sent !== undefined) this.view.sentChunks = event.sent;
    if (event.total !== undefined) this.view.totalChunks = event.total;
  }

  private finish(result: TransferResult): void {
    this.stopTimer();
    this.view.outcome = result.outcome;
    this.view.phase = result.outcome === 'failed' ? 'failed' : 'finished';
    this.view.sentChunks = result.sentChunks;
    this.view.totalChunks = result.totalChunks;
    this.view.receivedBytes = result.receivedBytes;
    this.view.receivedSha256 = result.receivedSha256;
    if (result.receivedName) this.view.fileName = result.receivedName;

    if (result.outcome === 'verified') {
      this.view.message = 'Received ' + (result.receivedName ?? 'file') + ', verified';
    } else if (result.outcome === 'confirmed') {
      this.view.message = 'Sent, confirmed by the peer';
    } else {
      this.view.message = 'Transfer ended: ' + result.outcome;
    }
    this.options.onFrame(null);
  }

  /** Sender role: read the chosen file and start the exchange. */
  async send(file: File): Promise<void> {
    if (this.active) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(bytes);
    this.sessionId = newSessionId();
    this.view = {
      phase: 'sending',
      message: 'Starting transfer of ' + file.name,
      sentChunks: 0,
      totalChunks: Math.ceil(bytes.length / this.chunkSize()),
      fileName: file.name,
      receivedBytes: null,
      receivedSha256: null,
      outcome: null,
    };
    this.session = new TransferSession({
      role: 'sender',
      sessionId: this.sessionId,
      config: this.config(),
      local: this.local(),
      source: sourceFromBytes(file.name, bytes, sha),
    });
    this.session.start();
    this.startTimer();
    this.drain();
  }

  /** Receiver role: wait for the peer to begin. */
  receive(): void {
    if (this.active) return;
    this.sessionId = newSessionId();
    this.view = {
      phase: 'receiving',
      message: 'Waiting for the peer to start',
      sentChunks: 0,
      totalChunks: 0,
      fileName: null,
      receivedBytes: null,
      receivedSha256: null,
      outcome: null,
    };
    this.session = new TransferSession({
      role: 'receiver',
      sessionId: this.sessionId,
      config: this.config(),
      local: this.local(),
    });
    this.session.start();
    this.startTimer();
    this.drain();
  }

  /** Feeds one decoded peer frame. Frames for other sessions are ignored. */
  async onFrame(frame: ValidatedFrame): Promise<void> {
    if (!this.session) return;
    if (frame.sessionId !== this.sessionId) return;
    await this.session.onFrame(frame);
    this.drain();
  }

  reset(): void {
    this.stopTimer();
    this.session = null;
    this.view = { ...EMPTY_VIEW };
    this.options.onFrame(null);
    this.options.onChange({ ...this.view });
  }
}

import { TransferSession, type TransferEvent, type TransferResult } from '../transfer/session';
import { sourceFromBytes } from '../transfer/source';
import { IndexedDbReceiverStorage } from '../transfer/indexedDbStorage';
import { sha256HexChunked } from '../transfer/sha256';
import type { ValidatedFrame } from '../protocol/frame';
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
  /**
   * The transfer session id, shared by both machines. Using the calibration
   * id means both sides derive the same value independently, so it no
   * longer matters which one presses their button first. A locally drawn
   * random id would differ on each machine and no frame would ever match.
   */
  sessionId(): string | null;
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
  private sessionId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private view: TransferUiView = { ...EMPTY_VIEW };
  private durable: IndexedDbReceiverStorage | null = null;

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

  private requireSessionId(): string {
    const id = this.options.sessionId();
    if (id === null) throw new Error('link up with the peer before transferring');
    return id;
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
    // Chunked so a large file does not freeze the tab while it is hashed.
    const sha = await sha256HexChunked(bytes, {
      onProgress: (fraction) => {
        this.view.message = 'Hashing ' + Math.round(fraction * 100) + '%';
        this.options.onChange({ ...this.view });
      },
    });
    const shared = this.requireSessionId();
    this.sessionId = shared;
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
    const shared = this.requireSessionId();
    this.sessionId = shared;
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
    // Durable storage keeps chunks across a reload and lets the browser page
    // them to disk. In-memory remains the fallback for contexts without
    // IndexedDB, where the transfer is still correct but not durable.
    const storage = IndexedDbReceiverStorage.isSupported()
      ? new IndexedDbReceiverStorage(shared)
      : undefined;
    this.durable = storage ?? null;
    // Pull in anything already stored for this session so a reload can
    // resume instead of starting from zero.
    if (storage) void storage.load().then(() => this.drain());
    this.session = new TransferSession({
      role: 'receiver',
      ...(storage ? { storage } : {}),
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

  /** Removes durable chunks once the user has saved the file. */
  async clearDurable(): Promise<void> {
    if (this.durable) await this.durable.clear();
  }

  reset(): void {
    this.stopTimer();
    this.session = null;
    this.durable = null;
    this.view = { ...EMPTY_VIEW };
    this.options.onFrame(null);
    this.options.onChange({ ...this.view });
  }
}

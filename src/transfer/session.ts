import { Receiver, type ReceiverEvent } from '../protocol/receiver';
import { Sender, type SenderEvent } from '../protocol/sender';
import { encodeFrame, type Frame, type ValidatedFrame } from '../protocol/frame';
import { DEFAULT_CONFIG, type ReliableConfig } from '../protocol/constants';
import { InMemoryReceiverStorage } from './receiverStorage';
import { sha256Hex } from './hash';
import type { TransferSource } from './source';

/**
 * Drives a real reliable transfer over whatever transport the caller provides.
 *
 * Pure: no camera, no DOM, no timers. The caller supplies decoded peer frames,
 * asks for the frame to display, and calls tick() so ACK timeouts are detected.
 * This mirrors CalibrationRunner on purpose: the optical layer treats
 * calibration and transfer identically.
 */

export type TransferRole = 'sender' | 'receiver';

export type TransferPhase = 'idle' | 'running' | 'finished';

export interface TransferEvent {
  kind: 'phase' | 'progress' | 'notice' | 'finished';
  message: string;
  sent?: number;
  total?: number;
}

export interface TransferOptions {
  role: TransferRole;
  sessionId: string;
  config?: ReliableConfig;
  local: { appVersion: string; buildId: string; protocolVersions: number[]; capabilities: string[] };
  /** Sender only. */
  source?: TransferSource;
  /** Receiver only; called before accepting a file. Defaults to accept. */
  approve?: (meta: { name: string; size: number }) => boolean;
}

export interface TransferResult {
  /** Sender: confirmed/unconfirmed/failed. Receiver: verification state. */
  outcome: string | null;
  receivedName: string | null;
  receivedBytes: Uint8Array | null;
  receivedSha256: string | null;
  sentChunks: number;
  totalChunks: number;
}

export class TransferSession {
  private readonly config: ReliableConfig;
  private readonly sender: Sender | null;
  private readonly receiver: Receiver | null;
  private readonly storage: InMemoryReceiverStorage | null;
  private phase: TransferPhase = 'idle';
  private frameText: string | null = null;
  private events: TransferEvent[] = [];
  private finalResult: TransferResult | null = null;

  constructor(options: TransferOptions) {
    this.config = options.config ?? DEFAULT_CONFIG;

    if (options.role === 'sender') {
      if (!options.source) throw new Error('sender needs a source');
      this.sender = new Sender({
        sessionId: options.sessionId,
        source: options.source,
        config: this.config,
        hello: {
          appVersion: options.local.appVersion,
          buildId: options.local.buildId,
          protocolVersions: options.local.protocolVersions,
          capabilities: options.local.capabilities,
          transferModes: ['reliable'],
        },
      });
      this.receiver = null;
      this.storage = null;
    } else {
      this.sender = null;
      this.storage = new InMemoryReceiverStorage();
      this.receiver = new Receiver({
        sessionId: options.sessionId,
        config: this.config,
        storage: this.storage,
        local: options.local,
        ...(options.approve ? { approve: options.approve } : {}),
      });
    }
  }

  get currentPhase(): TransferPhase {
    return this.phase;
  }

  get result(): TransferResult | null {
    return this.finalResult;
  }

  currentFrame(): string | null {
    return this.frameText;
  }

  drainEvents(): TransferEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private display(frame: Frame): void {
    this.frameText = encodeFrame(frame);
  }

  /** Starts the exchange. The sender emits HELLO; the receiver waits. */
  start(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'running';
    this.events.push({ kind: 'phase', message: 'Transfer started' });
    if (this.sender) {
      this.absorbSender(this.sender.start());
    } else {
      this.frameText = null;
    }
  }

  /** Handles one decoded peer frame. Foreign frames are ignored. */
  async onFrame(frame: ValidatedFrame): Promise<void> {
    if (this.phase === 'finished') return;
    if (this.sender) {
      this.absorbSender(await this.sender.onFrame(frame));
      return;
    }
    if (!this.receiver) return;

    const outcome = await this.receiver.onFrame(frame);
    for (const event of outcome.events) {
      this.events.push(this.fromReceiverEvent(event));
    }
    if (outcome.outbound.length > 0) this.display(outcome.outbound[outcome.outbound.length - 1]!);
    await this.maybeFinishReceiver();
  }

  private fromReceiverEvent(event: ReceiverEvent): TransferEvent {
    const out: TransferEvent = { kind: event.kind, message: event.message };
    if (event.totalChunks !== undefined) {
      out.sent = event.receivedChunks ?? 0;
      out.total = event.totalChunks;
    }
    return out;
  }

  private absorbSender(outcome: { outbound: Frame[]; events: SenderEvent[] }): void {
    for (const event of outcome.events) {
      const mapped: TransferEvent = {
        kind: event.kind === 'retransmit' ? 'notice' : event.kind,
        message: event.message,
      };
      if (event.ackedChunks !== undefined) mapped.sent = event.ackedChunks;
      this.events.push(mapped);
    }
    if (outcome.outbound.length > 0) this.display(outcome.outbound[outcome.outbound.length - 1]!);
    if (!this.sender) return;
    const phase = this.sender.currentPhase;
    if (phase === 'confirmed' || phase === 'unconfirmed' || phase === 'failed') {
      this.finish(phase);
    }
  }

  private async maybeFinishReceiver(): Promise<void> {
    if (!this.receiver) return;
    const status = this.receiver.finalStatus;
    if (status === null) return;

    let bytes: Uint8Array | null = null;
    if (status !== 'failed' && this.storage) {
      try {
        bytes = await this.storage.assemble();
      } catch {
        bytes = null;
      }
    }
    const hash = bytes ? await sha256Hex(bytes) : null;
    this.finalResult = {
      outcome: status,
      receivedName: this.receiver.receivedName,
      receivedBytes: bytes,
      receivedSha256: hash,
      sentChunks: this.receiver.receivedChunks,
      totalChunks: this.receiver.expectedChunks,
    };
    this.finish(status);
  }

  private finish(outcome: string): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    // The final frame must stay readable. The receiver's COMPLETE is what
    // tells the sender the transfer is done; clearing it here would strand the
    // sender in 'running' forever, which is exactly what happened.
    this.events.push({ kind: 'finished', message: 'Transfer finished: ' + outcome });
    if (!this.finalResult) {
      this.finalResult = {
        outcome,
        receivedName: null,
        receivedBytes: null,
        receivedSha256: null,
        sentChunks: this.sender?.ackedChunks ?? 0,
        totalChunks: this.sender?.totalChunks ?? 0,
      };
    }
  }

  /** Advances time so ACK timeouts fire. Only the sender has retry timers. */
  tick(): void {
    if (this.sender && this.phase === 'running') {
      this.absorbSender(this.sender.onTick());
    }
  }
}

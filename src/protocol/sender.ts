import { performanceClock, type Clock, type ReliableConfig } from './constants';
import type { Frame, ValidatedFrame } from './frame';
import { validateAck, validateComplete, validateNack, validateReady } from './messageTypes';
import { utf8 } from './bytes';
import type { TransferSource } from '../transfer/source';

export type SenderPhase =
  | 'idle'
  | 'waiting-ready'
  | 'waiting-meta-accept'
  | 'sending-data'
  | 'waiting-complete'
  | 'confirmed'
  | 'unconfirmed'
  | 'failed';

export interface SenderEvent {
  kind:
    | 'phase'
    | 'retransmit'
    | 'progress'
    | 'notice'
    | 'finished';
  phase: SenderPhase;
  message: string;
  ackedChunks?: number;
  retries?: number;
}

export interface SenderOutcome {
  /** Frames to display. Each entry replaces the previously displayed frame. */
  outbound: Frame[];
  events: SenderEvent[];
}

export interface SenderOptions {
  sessionId: string;
  source: TransferSource;
  config: ReliableConfig;
  /** Local peer description used in HELLO. */
  hello: { appVersion: string; buildId: string; protocolVersions: number[]; capabilities: string[]; transferModes: string[] };
  clock?: Clock;
}

const encoder = new TextEncoder();

export function jsonPayload(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export class Sender {
  private readonly options: SenderOptions;
  private readonly clock: Clock;
  private phase: SenderPhase = 'idle';
  private seq = 0;
  private chunkCount: number;
  private retries = 0;
  private deadline = 0;
  private inFlight: Frame | null = null;
  private acked = 0;
  private finSent = false;

  constructor(options: SenderOptions) {
    this.options = options;
    this.clock = options.clock ?? performanceClock;
    const chunkSize = options.config.chunkSize;
    this.chunkCount = Math.ceil(options.source.size / chunkSize);
  }

  get currentPhase(): SenderPhase {
    return this.phase;
  }

  get ackedChunks(): number {
    return this.acked;
  }

  get totalChunks(): number {
    return this.chunkCount;
  }

  get retryCount(): number {
    return this.retries;
  }

  start(): SenderOutcome {
    if (this.phase !== 'idle') throw new Error('sender already started');
    const frame: Frame = {
      type: 'HELLO',
      sessionId: this.options.sessionId,
      sequence: 0,
      payload: jsonPayload(this.options.hello),
    };
    this.phase = 'waiting-ready';
    this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
    this.inFlight = frame;
    return { outbound: [frame], events: [{ kind: 'phase', phase: this.phase, message: 'Waiting for pairing QR' }] };
  }

  async onFrame(frame: ValidatedFrame): Promise<SenderOutcome> {
    const events: SenderEvent[] = [];
    const outbound: Frame[] = [];
    const fail = (message: string): SenderOutcome => {
      this.phase = 'failed';
      events.push({ kind: 'finished', phase: 'failed', message });
      const abort: Frame = { type: 'ABORT', sessionId: this.options.sessionId, sequence: this.nextSeq(), payload: jsonPayload({ reason: message }) };
      outbound.push(abort);
      return { outbound, events };
    };

    if (frame.sessionId !== this.options.sessionId) return { outbound, events };

    if (frame.type === 'ABORT') {
      this.phase = 'failed';
      events.push({ kind: 'finished', phase: 'failed', message: 'peer aborted' });
      return { outbound, events };
    }
    if (frame.type === 'ERROR') {
      this.phase = 'failed';
      events.push({ kind: 'finished', phase: 'failed', message: 'peer error' });
      return { outbound, events };
    }

    if (this.phase === 'waiting-ready' && frame.type === 'READY') {
      let ready;
      try {
        ready = validateReady(frame.json);
      } catch {
        return fail('malformed READY');
      }
      if (!ready.accepted) return fail('pairing rejected by receiver');
      const meta: Frame = {
        type: 'META',
        sessionId: this.options.sessionId,
        sequence: this.nextSeq(),
        payload: jsonPayload({
          name: this.options.source.name,
          kind: 'file',
          size: this.options.source.size,
          sha256: this.options.source.sha256,
          encoding: 'identity',
          transferSize: this.options.source.size,
          transferMode: 'reliable',
          chunkSize: this.options.config.chunkSize,
          totalChunks: this.chunkCount,
        }),
      };
      this.phase = 'waiting-meta-accept';
      this.inFlight = meta;
      this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
      outbound.push(meta);
      events.push({ kind: 'phase', phase: this.phase, message: 'Waiting for acceptance' });
      return { outbound, events };
    }

    if (this.phase === 'waiting-meta-accept' && frame.type === 'META_ACCEPT') {
      if (this.chunkCount === 0) {
        outbound.push(this.endFrame());
        this.phase = 'waiting-complete';
        this.inFlight = outbound[0] ?? null;
        this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
        events.push({ kind: 'phase', phase: this.phase, message: 'Waiting for verification' });
        return { outbound, events };
      }
      const first = await this.dataFrame(0);
      this.phase = 'sending-data';
      this.seq = 0;
      this.retries = 0;
      this.inFlight = first;
      this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
      outbound.push(first);
      events.push({ kind: 'phase', phase: this.phase, message: 'Sending chunk 0 of ' + this.chunkCount, ackedChunks: 0, retries: 0 });
      return { outbound, events };
    }

    if (this.phase === 'sending-data' && frame.type === 'ACK') {
      let ack;
      try {
        ack = validateAck(frame.json);
      } catch {
        return fail('malformed ACK');
      }
      if (ack.nextExpected <= this.seq) {
        // Stale ACK; keep displaying the in-flight frame.
        return { outbound, events };
      }
      if (ack.nextExpected > this.seq + 1) return fail('ACK skipped ahead of the sender');
      this.acked = ack.nextExpected;
      events.push({ kind: 'progress', phase: this.phase, message: 'Acknowledged ' + this.acked + ' of ' + this.chunkCount, ackedChunks: this.acked, retries: this.retries });
      if (this.acked === this.chunkCount) {
        const end = this.endFrame();
        this.phase = 'waiting-complete';
        this.inFlight = end;
        this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
        outbound.push(end);
        events.push({ kind: 'phase', phase: this.phase, message: 'Waiting for verification' });
        return { outbound, events };
      }
      this.seq = ack.nextExpected;
      this.retries = 0;
      const next = await this.dataFrame(this.seq);
      this.inFlight = next;
      this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
      outbound.push(next);
      events.push({ kind: 'phase', phase: this.phase, message: 'Sending chunk ' + this.seq + ' of ' + this.chunkCount, ackedChunks: this.acked, retries: 0 });
      return { outbound, events };
    }

    if (this.phase === 'sending-data' && frame.type === 'NACK') {
      let nack;
      try {
        nack = validateNack(frame.json);
      } catch {
        return fail('malformed NACK');
      }
      if (nack.nextExpected === this.seq + 1) return { outbound, events };
      if (nack.nextExpected !== this.seq) return fail('NACK sequence does not match the in-flight chunk');
      if (!this.inFlight) return fail('no in-flight frame to retransmit');
      this.retries++;
      this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
      outbound.push(this.inFlight);
      events.push({ kind: 'retransmit', phase: this.phase, message: 'Retransmission requested', ackedChunks: this.acked, retries: this.retries });
      return { outbound, events };
    }

    if (this.phase === 'waiting-complete' && frame.type === 'COMPLETE') {
      let complete;
      try {
        complete = validateComplete(frame.json);
      } catch {
        return fail('malformed COMPLETE');
      }
      if (complete.sha256 !== this.options.source.sha256 || complete.size !== this.options.source.size) {
        return fail('receiver reported a different hash or size');
      }
      this.phase = 'confirmed';
      const fin: Frame = { type: 'FIN', sessionId: this.options.sessionId, sequence: this.nextSeq(), payload: new Uint8Array(0) };
      this.finSent = true;
      outbound.push(fin);
      events.push({ kind: 'finished', phase: 'confirmed', message: 'Confirmed' });
      return { outbound, events };
    }

    return { outbound, events };
  }

  onTick(): SenderOutcome {
    const events: SenderEvent[] = [];
    const outbound: Frame[] = [];
    if (this.phase === 'confirmed' || this.phase === 'unconfirmed' || this.phase === 'failed' || this.phase === 'idle') {
      return { outbound, events };
    }
    if (this.clock.now() < this.deadline || !this.inFlight) return { outbound, events };
    if (this.phase === 'waiting-complete') {
      if (this.finSent) return { outbound, events };
      this.retries++;
      if (this.retries > this.options.config.maxRetries) {
        this.phase = 'unconfirmed';
        events.push({ kind: 'finished', phase: 'unconfirmed', message: 'Unconfirmed: receiver never showed COMPLETE' });
        return { outbound, events };
      }
      this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
      outbound.push(this.inFlight);
      events.push({ kind: 'retransmit', phase: this.phase, message: 'Re-sending final request', retries: this.retries });
      return { outbound, events };
    }
    this.retries++;
    if (this.retries > this.options.config.maxRetries) {
      this.phase = 'failed';
      events.push({ kind: 'finished', phase: 'failed', message: 'Retry limit reached; link lost' });
      return { outbound, events };
    }
    this.deadline = this.clock.now() + this.options.config.ackTimeoutMs;
    outbound.push(this.inFlight);
    events.push({ kind: 'retransmit', phase: this.phase, message: 'ACK not seen; retransmitting', ackedChunks: this.acked, retries: this.retries });
    return { outbound, events };
  }

  private nextSeq(): number {
    return this.seqOut++;
  }

  private seqOut = 1;

  private async dataFrame(sequence: number): Promise<Frame> {
    const chunkSize = this.options.config.chunkSize;
    const bytes = await this.options.source.read(sequence * chunkSize, chunkSize);
    return { type: 'DATA', sessionId: this.options.sessionId, sequence, payload: bytes };
  }

  private endFrame(): Frame {
    return {
      type: 'END',
      sessionId: this.options.sessionId,
      sequence: this.seq,
      payload: jsonPayload({
        totalChunks: this.chunkCount,
        size: this.options.source.size,
        sha256: this.options.source.sha256,
      }),
    };
  }
}

export function helloFrame(sessionId: string, hello: SenderOptions['hello']): Frame {
  return { type: 'HELLO', sessionId, sequence: 0, payload: utf8(JSON.stringify(hello)) };
}

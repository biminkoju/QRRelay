import type { Clock, ReliableConfig } from './constants';
import type { Frame, ValidatedFrame } from './frame';
import { validateEnd, validateHello, validateMeta } from './messageTypes';
import { negotiateProtocol, type NegotiationResult } from './versioning';
import type { ReceiverStorage } from '../transfer/receiverStorage';
import { sourceHash } from '../transfer/hash';
import { jsonPayload } from './sender';

export type ReceiverPhase =
  | 'idle'
  | 'awaiting-user'
  | 'waiting-meta'
  | 'receiving'
  | 'verifying'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface ReceiverEvent {
  kind: 'phase' | 'progress' | 'notice' | 'finished';
  phase: ReceiverPhase;
  message: string;
  receivedChunks?: number;
  totalChunks?: number;
  verification?: 'verified' | 'verified-unconfirmed' | 'failed';
}

export interface ReceiverOutcome {
  outbound: Frame[];
  events: ReceiverEvent[];
}

export interface ReceiverOptions {
  sessionId: string;
  config: ReliableConfig;
  storage: ReceiverStorage;
  local: { appVersion: string; buildId: string; protocolVersions: number[]; capabilities: string[] };
  clock?: Clock;
  /** Test hook: return false to reject the pairing request. */
  approve?: (meta: { name: string; size: number }) => boolean;
}

export class Receiver {
  private readonly options: ReceiverOptions;
  private phase: ReceiverPhase = 'idle';
  private nextExpected = 0;
  private totalChunks = 0;
  private chunkSize = 0;
  private meta: { name: string; size: number; sha256: string; totalChunks: number } | null = null;
  private negotiation: NegotiationResult | null = null;
  private lastResponse: Frame | null = null;
  private verification: 'verified' | 'verified-unconfirmed' | 'failed' | null = null;

  constructor(options: ReceiverOptions) {
    this.options = options;
  }

  get currentPhase(): ReceiverPhase {
    return this.phase;
  }

  get receivedChunks(): number {
    return this.nextExpected;
  }

  get expectedChunks(): number {
    return this.totalChunks;
  }

  get finalStatus(): 'verified' | 'verified-unconfirmed' | 'failed' | null {
    return this.verification;
  }

  get currentResponse(): Frame | null {
    return this.lastResponse;
  }

  async onFrame(frame: ValidatedFrame): Promise<ReceiverOutcome> {
    const events: ReceiverEvent[] = [];
    const outbound: Frame[] = [];
    const sid = this.options.sessionId;

    if (frame.sessionId !== sid) return { outbound, events };

    if (frame.type === 'ABORT' || frame.type === 'ERROR') {
      this.phase = 'failed';
      events.push({ kind: 'finished', phase: 'failed', message: 'sender aborted or reported an error' });
      return { outbound, events };
    }

    if (this.phase === 'idle' && frame.type === 'HELLO') {
      let hello;
      try {
        hello = validateHello(frame.json);
      } catch {
        return this.fail('malformed HELLO', events, outbound);
      }
      const negotiated = negotiateProtocol(this.options.local, hello);
      if (!negotiated.ok) {
        this.phase = 'failed';
        const error: Frame = { type: 'ERROR', sessionId: sid, sequence: 0, payload: jsonPayload({ code: 'VERSION_MISMATCH', message: 'no common protocol version' }) };
        outbound.push(error);
        events.push({ kind: 'finished', phase: 'failed', message: 'Version mismatch' });
        return { outbound, events };
      }
      this.negotiation = negotiated;
      this.phase = 'awaiting-user';
      events.push({ kind: 'phase', phase: this.phase, message: 'Pairing request detected' });
      const ready: Frame = {
        type: 'READY',
        sessionId: sid,
        sequence: 0,
        payload: jsonPayload({
          accepted: true,
          protocolVersion: negotiated.protocolVersion,
          capabilities: negotiated.capabilities,
          transferMode: 'reliable',
        }),
      };
      this.lastResponse = ready;
      outbound.push(ready);
      this.phase = 'waiting-meta';
      events.push({ kind: 'phase', phase: this.phase, message: 'Waiting for metadata' });
      return { outbound, events };
    }

    if (this.phase === 'waiting-meta' && frame.type === 'META') {
      let meta;
      try {
        meta = validateMeta(frame.json);
      } catch (error) {
        return this.fail('invalid META: ' + (error as Error).message, events, outbound);
      }
      if (meta.totalChunks > 100000) return this.fail('too many chunks', events, outbound);
      if (this.options.approve && !this.options.approve({ name: meta.name, size: meta.size })) {
        this.phase = 'rejected';
        const ready: Frame = { type: 'READY', sessionId: sid, sequence: 0, payload: jsonPayload({ accepted: false, protocolVersion: this.negotiation?.protocolVersion ?? 1, capabilities: [], transferMode: 'reliable', reason: 'user rejected' }) };
        outbound.push(ready);
        events.push({ kind: 'finished', phase: 'rejected', message: 'Transfer rejected' });
        return { outbound, events };
      }
      this.meta = { name: meta.name, size: meta.size, sha256: meta.sha256, totalChunks: meta.totalChunks };
      this.totalChunks = meta.totalChunks;
      this.chunkSize = meta.chunkSize;
      this.phase = 'receiving';
      const accept: Frame = { type: 'META_ACCEPT', sessionId: sid, sequence: 0, payload: new Uint8Array(0) };
      this.lastResponse = accept;
      outbound.push(accept);
      events.push({ kind: 'phase', phase: this.phase, message: 'Receiving chunk 0 of ' + this.totalChunks, receivedChunks: 0, totalChunks: this.totalChunks });
      return { outbound, events };
    }

    if (this.phase === 'receiving' && frame.type === 'DATA') {
      if (frame.sequence < this.nextExpected) {
        // Duplicate: never write twice, repeat the ACK.
        if (this.lastResponse) outbound.push(this.lastResponse);
        events.push({ kind: 'notice', phase: this.phase, message: 'Duplicate chunk ' + frame.sequence + ' ignored', receivedChunks: this.nextExpected, totalChunks: this.totalChunks });
        return { outbound, events };
      }
      if (frame.sequence > this.nextExpected) {
        const nack: Frame = { type: 'NACK', sessionId: sid, sequence: 0, payload: jsonPayload({ nextExpected: this.nextExpected, reason: 'missing' }) };
        this.lastResponse = nack;
        outbound.push(nack);
        events.push({ kind: 'notice', phase: this.phase, message: 'Out-of-order chunk ' + frame.sequence + ' rejected', receivedChunks: this.nextExpected, totalChunks: this.totalChunks });
        return { outbound, events };
      }
      if (frame.payload.length === 0 || frame.payload.length > this.chunkSize) {
        return this.fail('DATA payload length out of range', events, outbound);
      }
      try {
        await this.options.storage.commitChunk(frame.sequence, frame.payload);
      } catch (error) {
        return this.fail('storage commit failed: ' + (error as Error).message, events, outbound);
      }
      this.nextExpected++;
      const ack: Frame = { type: 'ACK', sessionId: sid, sequence: 0, payload: jsonPayload({ nextExpected: this.nextExpected }) };
      this.lastResponse = ack;
      outbound.push(ack);
      events.push({ kind: 'progress', phase: this.phase, message: 'Receiving chunk ' + this.nextExpected + ' of ' + this.totalChunks, receivedChunks: this.nextExpected, totalChunks: this.totalChunks });
      return { outbound, events };
    }

    if (this.phase === 'receiving' && frame.type === 'END') {
      let end;
      try {
        end = validateEnd(frame.json);
      } catch {
        return this.fail('malformed END', events, outbound);
      }
      if (!this.meta) return this.fail('END before META', events, outbound);
      if (end.totalChunks !== this.totalChunks || end.size !== this.meta.size) {
        return this.fail('END does not match META', events, outbound);
      }
      if (end.sha256 !== this.meta.sha256) {
        const error: Frame = { type: 'ERROR', sessionId: sid, sequence: 0, payload: jsonPayload({ code: 'HASH_INCONSISTENT', message: 'END hash differs from META hash' }) };
        this.phase = 'failed';
        this.verification = 'failed';
        outbound.push(error);
        events.push({ kind: 'finished', phase: 'failed', message: 'META and END hashes disagree', verification: 'failed' });
        return { outbound, events };
      }
      if (this.nextExpected !== this.totalChunks) {
        return this.fail('END before all chunks arrived', events, outbound);
      }
      this.phase = 'verifying';
      events.push({ kind: 'phase', phase: this.phase, message: 'Verifying file' });
      const bytes = await this.options.storage.assemble();
      if (bytes.length !== this.meta.size) {
        this.verification = 'failed';
        return this.fail('reconstructed size mismatch', events, outbound);
      }
      const actual = await sourceHash(bytes);
      if (actual !== this.meta.sha256) {
        this.verification = 'failed';
        return this.fail('SHA-256 mismatch', events, outbound);
      }
      this.verification = 'verified';
      this.phase = 'completed';
      const complete: Frame = { type: 'COMPLETE', sessionId: sid, sequence: 0, payload: jsonPayload({ size: this.meta.size, sha256: this.meta.sha256 }) };
      this.lastResponse = complete;
      outbound.push(complete);
      events.push({ kind: 'finished', phase: 'completed', message: 'Transfer complete (Verified)', verification: 'verified' });
      return { outbound, events };
    }

    if (this.phase === 'completed' && (frame.type === 'END' || frame.type === 'DATA')) {
      // Idempotent: re-display COMPLETE for a sender that missed it.
      if (this.lastResponse) outbound.push(this.lastResponse);
      return { outbound, events };
    }

    if (this.phase === 'completed' && frame.type === 'FIN') {
      events.push({ kind: 'finished', phase: 'completed', message: 'Sender confirmed; session closed', verification: 'verified' });
      return { outbound, events };
    }

    return { outbound, events };
  }

  private fail(message: string, events: ReceiverEvent[], outbound: Frame[]): ReceiverOutcome {
    this.phase = 'failed';
    const error: Frame = {
      type: 'ERROR',
      sessionId: this.options.sessionId,
      sequence: 0,
      payload: jsonPayload({ code: 'FAILED', message }),
    };
    outbound.push(error);
    events.push({ kind: 'finished', phase: 'failed', message, verification: this.verification ?? 'failed' });
    return { outbound, events };
  }
}

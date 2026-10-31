/**
 * Deterministic in-process optical transport simulator.
 *
 * Two protocol engines exchange real QRF1 strings through channels that can
 * drop, duplicate, delay or corrupt frames. This exercises the exact wire
 * format without cameras, so protocol correctness is proven before any UI
 * or webcam work begins.
 */
import { decodeFrame, encodeFrame, FrameError, type Frame } from './frame';
import { Receiver, type ReceiverEvent } from './receiver';
import { Sender, type SenderEvent } from './sender';
import type { ReliableConfig } from './constants';
import { DEFAULT_CONFIG } from './constants';
import type { RandomBytes } from './session';
import type { ReceiverStorage } from '../transfer/receiverStorage';
import type { TransferSource } from '../transfer/source';

export interface ChannelOptions {
  dropRate?: number;
  duplicateRate?: number;
  corruptRate?: number;
  reorderRate?: number;
}

/** Small deterministic PRNG so simulations are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deterministicRandomBytes(seed: number): RandomBytes {
  const next = mulberry32(seed);
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = Math.floor(next() * 256);
    return out;
  };
}

export interface SimulationResult {
  senderStatus: string;
  receiverStatus: string | null;
  verified: boolean;
  notes: string[];
  framesSent: number;
  framesDelivered: number;
  finalSenderPhase: string;
  finalReceiverPhase: string;
}

/**
 * Optional optical hop placed between the protocol engine and the channel.
 * Phase 2 tests use it to route every frame through a real QR image and back.
 * encode() may throw if the frame does not fit a symbol; decode() returns null
 * when no symbol could be read, which is treated as frame loss.
 */
export interface FrameCodec {
  encode(text: string): string;
  decode(text: string): string | null;
}

const identityCodec: FrameCodec = { encode: (t) => t, decode: (t) => t };

export interface SimulationOptions {
  source: TransferSource;
  sessionId: string;
  storage: ReceiverStorage;
  config?: ReliableConfig;
  forward?: ChannelOptions;
  reverse?: ChannelOptions;
  seed?: number;
  maxSteps?: number;
  /** Simulated milliseconds advanced per loop iteration (default 1000). */
  tickMs?: number;
  /** Optional QR (or other) hop applied to every frame text. */
  codec?: FrameCodec;
}

function transmit(text: string, channel: ChannelOptions, rand: () => number): string[] {
  const out: string[] = [];
  if (rand() < (channel.dropRate ?? 0)) return out;
  let frame = text;
  if (rand() < (channel.corruptRate ?? 0)) {
    const at = Math.floor(rand() * frame.length);
    const char = frame.charAt(at) === 'A' ? 'B' : 'A';
    frame = frame.slice(0, at) + char + frame.slice(at + 1);
  }
  out.push(frame);
  if (rand() < (channel.duplicateRate ?? 0)) out.push(frame);
  if (rand() < (channel.reorderRate ?? 0)) out.reverse();
  return out;
}

export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const rand = mulberry32(options.seed ?? 1);
  const notes: string[] = [];
  const codec = options.codec ?? identityCodec;
  /** Applies the optical hop, then the channel; returns readable frame texts. */
  const emit = (frame: Frame, channel: ChannelOptions): string[] => {
    let text: string;
    try {
      text = codec.encode(encodeFrame(frame));
    } catch (error) {
      notes.push('frame could not be encoded optically: ' + (error as Error).message);
      return [];
    }
    return transmit(text, channel, rand);
  };
  // Simulated monotonic clock: time advances by one tick per loop iteration so
  // ACK timeouts and retry limits are exercised deterministically.
  const tickMs = options.tickMs ?? 1000;
  let now = 0;
  const clock = { now: () => now };
  const sender = new Sender({
    sessionId: options.sessionId,
    source: options.source,
    config,
    clock,
    hello: { appVersion: '0.1.0', buildId: 'sim', protocolVersions: [1], capabilities: ['reliable'], transferModes: ['reliable'] },
  });
  const receiver = new Receiver({
    sessionId: options.sessionId,
    config,
    storage: options.storage,
    local: { appVersion: '0.1.0', buildId: 'sim', protocolVersions: [1], capabilities: ['reliable'] },
  });

  const senderEvents: SenderEvent[] = [];
  const receiverEvents: ReceiverEvent[] = [];
  let framesSent = 0;
  let framesDelivered = 0;

  const toReceiver: string[] = [];
  const toSender: string[] = [];

  const started = sender.start();
  for (const frame of started.outbound) {
    framesSent++;
    toReceiver.push(...emit(frame, options.forward ?? {}));
  }

  const maxSteps = options.maxSteps ?? 10000;
  for (let step = 0; step < maxSteps; step++) {
    let progressed = false;

    while (toReceiver.length > 0) {
      const text = toReceiver.shift();
      if (text === undefined) break;
      framesDelivered++;
      progressed = true;
      let validated;
      try {
        const optical = codec.decode(text);
        if (optical === null) {
          notes.push('receiver: optical decode produced no frame');
          continue;
        }
        validated = decodeFrame(optical);
      } catch (error) {
        notes.push('receiver dropped invalid frame: ' + (error as FrameError).message);
        continue;
      }
      const outcome = await receiver.onFrame(validated);
      receiverEvents.push(...outcome.events);
      for (const frame of outcome.outbound) {
        framesSent++;
        toSender.push(...emit(frame, options.reverse ?? {}));
      }
    }

    while (toSender.length > 0) {
      const text = toSender.shift();
      if (text === undefined) break;
      framesDelivered++;
      progressed = true;
      let validated;
      try {
        const optical = codec.decode(text);
        if (optical === null) {
          notes.push('sender: optical decode produced no frame');
          continue;
        }
        validated = decodeFrame(optical);
      } catch (error) {
        notes.push('sender dropped invalid frame: ' + (error as FrameError).message);
        continue;
      }
      const outcome = await sender.onFrame(validated);
      senderEvents.push(...outcome.events);
      for (const frame of outcome.outbound) {
        framesSent++;
        toReceiver.push(...emit(frame, options.forward ?? {}));
      }
    }

    // Advance simulated time; the sender's ACK timer uses this clock.
    now += tickMs;
    if (!progressed) {
      const tickSender = sender.onTick();
      senderEvents.push(...tickSender.events);
      for (const frame of tickSender.outbound) {
        framesSent++;
        toReceiver.push(...emit(frame, options.forward ?? {}));
      }
    }

    if (sender.currentPhase === 'confirmed' || sender.currentPhase === 'unconfirmed' || sender.currentPhase === 'failed') {
      if (toReceiver.length === 0 && toSender.length === 0) break;
    }
  }

  const senderFinal = senderEvents.filter((e) => e.kind === 'finished').at(-1);
  const verified = receiver.finalStatus === 'verified' && sender.currentPhase === 'confirmed';

  return {
    senderStatus: senderFinal?.phase ?? sender.currentPhase,
    receiverStatus: receiver.finalStatus,
    verified,
    notes,
    framesSent,
    framesDelivered,
    finalSenderPhase: sender.currentPhase,
    finalReceiverPhase: receiver.currentPhase,
  };
}

export type { Frame };

import { base64UrlEncode, utf8 } from './bytes';
import type {
  CalPingPayload,
  CalPongPayload,
  CalProbePayload,
  CalProbeResultPayload,
  CalRateFramePayload,
  CalRateResultPayload,
  CalibrationEcc,
} from './messageTypes';

/**
 * Bidirectional calibration: a directional probe ladder, a burst rate probe,
 * and ping/pong round-trip timing. Everything here is pure. No camera, clock
 * or DOM is consulted; callers pass measurements in and get a LinkProfile out.
 *
 * The guiding rule is conservatism: a size or rate is only trusted after it
 * has actually been observed in both directions, and the profile rounds down.
 */

export interface ProbeStep {
  step: number;
  total: number;
  bytes: number;
  ecl: CalibrationEcc;
}

export const PROBE_MIN_BYTES = 32;
export const PROBE_MAX_BYTES = 1024;

/**
 * The ladder grows geometrically until it fails. Larger payloads need denser
 * QR symbols, so a failure at size N is evidence the link cannot sustain N
 * reliably, not merely one bad frame.
 *
 * EC level is fixed per ladder run: mixing levels would make two failures
 * incomparable. The caller runs at 'M' first and re-runs at 'Q' only if 'M'
 * reached the ceiling.
 */
export function buildProbeLadder(ecl: CalibrationEcc = 'M'): ProbeStep[] {
  const steps: ProbeStep[] = [];
  let bytes = PROBE_MIN_BYTES;
  while (bytes <= PROBE_MAX_BYTES) {
    steps.push({ step: steps.length, total: 0, bytes, ecl });
    bytes *= 2;
  }
  return steps.map((s) => ({ ...s, total: steps.length }));
}

/**
 * Deterministic filler. Identical requests must produce identical bytes so a
 * cached display cannot accidentally pass a later step.
 */
export function probeFiller(calId: string, probeId: number, bytes: number): Uint8Array {
  const seed = utf8(calId + ':' + probeId.toString(16).padStart(8, '0'));
  const out = new Uint8Array(bytes);
  let state = 0x811c9dc5;
  for (const b of seed) {
    state ^= b;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  for (let i = 0; i < bytes; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

export function makeProbe(calId: string, step: ProbeStep, probeId: number): CalProbePayload {
  return {
    step: step.step,
    total: step.total,
    probeId,
    bytes: step.bytes,
    ecl: step.ecl,
    filler: base64UrlEncode(probeFiller(calId, probeId, step.bytes)),
  };
}

/**
 * A probe counts as observed only when the peer reports exactly the same byte
 * count; a partial or inflated answer is a failure, never a success.
 */
export function evaluateProbe(step: ProbeStep, result: CalProbeResultPayload): boolean {
  if (result.step !== step.step) return false;
  if (!result.ok) return false;
  return result.observedBytes === step.bytes;
}

export function confirmedBytes(steps: ProbeStep[], results: readonly CalProbeResultPayload[]): number {
  let best = 0;
  for (const step of steps) {
    const answer = results.find((r) => r.step === step.step);
    if (answer && evaluateProbe(step, answer)) best = Math.max(best, step.bytes);
  }
  return best;
}

export interface RateBurst {
  burstId: number;
  frames: number;
  bytes: number;
}

export function rateFiller(burstId: number, index: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const tag = ((burstId * 64 + index) >>> 0).toString(16).padStart(8, '0');
  for (let i = 0; i < bytes; i++) {
    out[i] = i < 8 ? Number.parseInt(tag.slice(i * 2, i * 2 + 2), 16) : (i * 31 + burstId) & 0xff;
  }
  return out;
}

export function makeRateFrame(burst: RateBurst, index: number): CalRateFramePayload {
  return {
    burstId: burst.burstId,
    index,
    filler: base64UrlEncode(rateFiller(burst.burstId, index, burst.bytes)),
  };
}

/** Fraction of a burst the peer saw, in 0..1. Never extrapolated. */
export function burstReliability(result: CalRateResultPayload, burst: RateBurst): number {
  if (result.burstId !== burst.burstId || burst.frames <= 0) return 0;
  return Math.max(0, Math.min(1, result.received / burst.frames));
}

export function burstFrameRate(result: CalRateResultPayload): number {
  if (!(result.elapsedMs > 0) || result.received <= 0) return 0;
  return (result.received * 1000) / result.elapsedMs;
}

export function makePing(pingId: number, t0: number): CalPingPayload {
  return { pingId, t0 };
}

export function makePong(ping: CalPingPayload, t1: number): CalPongPayload {
  return { pingId: ping.pingId, t0: ping.t0, t1 };
}

/**
 * Round-trip time for one ping. The answer must reference the same ping id,
 * or it is a stale reply and is discarded rather than averaged in.
 */
export function rttFor(ping: CalPingPayload, pong: CalPongPayload, t2: number): number | null {
  if (pong.pingId !== ping.pingId) return null;
  if (pong.t0 !== ping.t0) return null;
  const rtt = t2 - ping.t0;
  if (!(rtt >= 0)) return null;
  return rtt;
}

/** Median, which resists a single stalled frame far better than a mean. */
export function medianRtt(samples: readonly number[]): number | null {
  const valid = samples.filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid]! : (valid[mid - 1]! + valid[mid]!) / 2;
}

export interface LinkProfile {
  chunkSize: number;
  ecl: CalibrationEcc;
  framesPerSecond: number;
  reliability: number;
  rttMs: number | null;
  bidirectional: boolean;
  notes: string[];
}

export const MIN_PROFILE_CHUNK = 64;

export interface ProfileInput {
  forwardBytes: number;
  reverseBytes: number;
  ecl: CalibrationEcc;
  burst: RateBurst | null;
  burstResult: CalRateResultPayload | null;
  rttSamples: readonly number[];
}

/**
 * The weakest direction wins, and the result is halved once more because a
 * single successful decode at size N does not prove that size is sustainable.
 */
export function deriveLinkProfile(input: ProfileInput): LinkProfile {
  const notes: string[] = [];
  const weakest = Math.min(input.forwardBytes, input.reverseBytes);
  const bidirectional = input.forwardBytes > 0 && input.reverseBytes > 0;

  if (!bidirectional) {
    notes.push('At least one direction has no confirmed probe; the profile is a conservative fallback.');
  }

  let chunkSize = 0;
  if (weakest > 0) {
    chunkSize = Math.floor(weakest / 2);
    notes.push('Chunk size is half the weakest confirmed payload (' + weakest + ' bytes) for margin.');
  }
  chunkSize = Math.max(MIN_PROFILE_CHUNK, Math.min(chunkSize, 4096));

  const reliability = input.burst && input.burstResult ? burstReliability(input.burstResult, input.burst) : 0;
  const framesPerSecond = input.burstResult ? burstFrameRate(input.burstResult) : 0;
  if (input.burstResult === null) notes.push('No rate burst completed; frame rate is unknown.');
  else if (reliability < 1) notes.push('The rate burst lost frames; the profile does not extrapolate past what was seen.');

  const rttMs = medianRtt(input.rttSamples);
  if (rttMs === null) notes.push('No ping completed; ACK timeouts keep their conservative default.');

  return { chunkSize, ecl: input.ecl, framesPerSecond, reliability, rttMs, bidirectional, notes };
}

/**
 * Suggests an ACK timeout from measured RTT. Uses a wide multiple because an
 * optical ACK needs at least two screen refreshes plus a decode on each side.
 */
export function suggestedAckTimeoutMs(profile: LinkProfile): number {
  const floor = 3000;
  if (profile.rttMs === null) return floor;
  return Math.max(floor, Math.round(profile.rttMs * 4 + 2000));
}

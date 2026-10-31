import { decodeFrame, encodeFrame, type Frame, type ValidatedFrame } from '../protocol/frame';
import { CalibrationRunner, type CalibrationDiagnostics } from '../protocol/calibrationRunner';
import { CALIBRATION_SESSION_ID } from '../protocol/alignment';
import { jsonPayload } from '../protocol/sender';
import { buildProbeLadder, makeProbe, type LinkProfile, type ProbeStep } from '../protocol/calibration';
import type { CalibrationEcc } from '../protocol/messageTypes';
import type { EccLevel } from '../qr/encode';
import { simulateCapture, type ChannelOptions, type CaptureResult } from './channel';

/**
 * Runs a whole calibration exchange on one machine.
 *
 * Both runners are real. Every frame between them is drawn, degraded by the
 * simulated channel, decoded, and only then delivered. A frame the simulated
 * camera cannot read is a frame that never arrives, which is exactly what the
 * real link does. Nothing here is special-cased for the simulator: if the
 * runner loops forever on a lost frame, this harness would hang too.
 *
 * Time is virtual. Each step advances the clock by `stepMs`, so a run that
 * would take a minute on hardware completes in milliseconds and always
 * produces the same result for the same seed.
 */

export interface LoopbackOptions {
  channel: ChannelOptions;
  calId: string;
  ecl: CalibrationEcc;
  /** Virtual milliseconds per exchange step. */
  stepMs?: number;
  /** Virtual milliseconds allowed before giving up. */
  budgetMs?: number;
  /** How long a frame must stay on screen, in virtual ms. */
  frameDwellMs?: number;
  /** How long a runner waits for an answer, in virtual ms. */
  answerTimeoutMs?: number;
}

export interface DeliveredFrame {
  at: number;
  from: 'leader' | 'follower';
  type: string;
  bytes: number;
  ok: boolean;
  /** Capture pixels per module for this frame, the variable that decides it. */
  capturePxPerModule: number;
  modules: number;
}

export interface LoopbackResult {
  leader: CalibrationDiagnostics;
  follower: CalibrationDiagnostics;
  leaderProfile: LinkProfile | null;
  followerProfile: LinkProfile | null;
  log: DeliveredFrame[];
  /** Virtual time consumed. */
  elapsedMs: number;
  /** True when both sides reached the end without hitting the budget. */
  completed: boolean;
  /** The last capture produced, for display. */
  lastCapture: CaptureResult | null;
  /** Frames that were sent but never decoded. */
  dropped: number;
}

/** One frame, exactly as the real display/scanner pair would move it. */
function transmit(frame: Frame, ecl: EccLevel, channel: ChannelOptions): { frame: ValidatedFrame | null; capture: CaptureResult } {
  const text = encodeFrame(frame);
  const capture = simulateCapture(text, ecl, channel);
  if (capture.decoded === null) return { frame: null, capture };
  try {
    return { frame: decodeFrame(capture.decoded), capture };
  } catch {
    return { frame: null, capture };
  }
}

function asFrame(text: string): Frame {
  // The runner only ever produces frames from our own encoder, so this is a
  // narrow re-read of validated output, not untrusted input handling.
  const decoded = decodeFrame(text);
  return {
    type: decoded.type,
    sessionId: decoded.sessionId,
    sequence: decoded.sequence,
    payload: decoded.payload,
  };
}

export function runLoopback(options: LoopbackOptions): LoopbackResult {
  const stepMs = options.stepMs ?? 250;
  const budgetMs = options.budgetMs ?? 120000;
  const ecl = options.ecl;
  const leader = new CalibrationRunner({
    role: 'leader',
    calId: options.calId,
    ecl,
    answerTimeoutMs: options.answerTimeoutMs ?? 4000,
    frameDwellMs: options.frameDwellMs ?? 400,
  });
  const follower = new CalibrationRunner({
    role: 'follower',
    calId: options.calId,
    ecl,
    answerTimeoutMs: options.answerTimeoutMs ?? 4000,
    frameDwellMs: options.frameDwellMs ?? 400,
  });

  let now = 0;
  leader.start(now);
  follower.start(now);

  const log: DeliveredFrame[] = [];
  let dropped = 0;
  let lastCapture: CaptureResult | null = null;
  const seen = new Map<CalibrationRunner, string>();

  const deliver = (from: 'leader' | 'follower', sender: CalibrationRunner, receiver: CalibrationRunner): void => {
    const text = sender.currentFrame();
    if (text === null) return;
    if (seen.get(receiver) === text) return;
    seen.set(receiver, text);
    const { frame, capture } = transmit(asFrame(text), ecl, options.channel);
    lastCapture = capture;
    const entry: DeliveredFrame = {
      at: now,
      from,
      type: text.split('|')[1] ?? '?',
      bytes: asFrame(text).payload.length,
      ok: frame !== null,
      capturePxPerModule: capture.capturePxPerModule,
      modules: capture.modules,
    };
    if (frame === null) {
      dropped++;
      entry.ok = false;
      log.push(entry);
      return;
    }
    log.push(entry);
    receiver.onFrame(frame, now);
  };

  while (now < budgetMs) {
    if (leader.currentPhase === 'done' && follower.currentPhase === 'done') break;
    now += stepMs;
    deliver('leader', leader, follower);
    deliver('follower', follower, leader);
    leader.tick(now);
    follower.tick(now);
  }

  return {
    leader: leader.diagnostics,
    follower: follower.diagnostics,
    leaderProfile: leader.result,
    followerProfile: follower.result,
    log,
    elapsedMs: now,
    completed: leader.currentPhase === 'done' && follower.currentPhase === 'done',
    lastCapture,
    dropped,
  };
}

export interface SweepPoint {
  pxPerModule: number;
  bytes: number;
  modules: number;
  ok: boolean;
}

/**
 * How small can a module be before a given payload stops decoding?
 *
 * Encodes one frame at the given size, renders it at the requested px/module,
 * then sweeps the capture resolution down. This is the number that matters on
 * real hardware; the model only tells you the shape of the cliff.
 */
export function sweepModuleSize(
  bytes: number,
  ecl: EccLevel,
  calId: string,
  samples: number[],
  channel: Omit<ChannelOptions, 'captureWidth'>,
): SweepPoint[] {
  const ladder = buildProbeLadder(ecl === 'L' || ecl === 'M' || ecl === 'Q' || ecl === 'H' ? ecl : 'M');
  const step: ProbeStep = ladder.find((s) => s.bytes === bytes) ?? { step: 0, total: 1, bytes, ecl };
  const frame = encodeFrame({
    type: 'CAL_PROBE',
    sessionId: CALIBRATION_SESSION_ID,
    sequence: 0,
    payload: jsonPayload(makeProbe(calId, step, 1)),
  });
  return samples.map((pxPerModule) => {
    const capture = simulateCapture(frame, ecl, {
      ...channel,
      captureWidth: Math.max(8, Math.round((2 * channel.quietZone + 200) * pxPerModule)),
    });
    return { pxPerModule, bytes, modules: capture.modules, ok: capture.decoded === frame };
  });
}

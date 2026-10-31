import { encodeFrame, type ValidatedFrame } from './frame';
import { jsonPayload } from './sender';
import { CALIBRATION_SESSION_ID } from './alignment';
import { base64UrlDecode } from './bytes';
import {
  buildProbeLadder,
  burstReliability,
  confirmedBytes,
  deriveLinkProfile,
  makePing,
  makePong,
  makeProbe,
  makeRateFrame,
  rttFor,
  type LinkProfile,
  type ProbeStep,
  type RateBurst,
} from './calibration';
import type { CalProbeResultPayload, CalRateResultPayload, CalibrationEcc } from './messageTypes';

/**
 * Drives calibration on one device. Pure: no camera, no DOM, no timers of its
 * own. The caller feeds decoded peer frames in, asks for the frame to display,
 * and calls tick() from a UI timer so timeouts can be detected.
 *
 * Exchange order, chosen so the two devices never display calibration frames
 * at the same time (one screen is the sender, the other is being scanned):
 *
 *   leader    follower
 *   forward   answers      leader's probe ladder, direction L -> F
 *   answers   reverse      follower's probe ladder, direction F -> L
 *   rate      answers      leader sends a burst, follower reports what it saw
 *   ping      pongs        leader measures round-trip time
 *
 * Each side then derives its own profile from what it personally observed.
 * Only the leader measures RTT; the follower reports rttMs as null rather than
 * pretending to know.
 */

export type CalibrationRole = 'leader' | 'follower';

export type CalibrationPhase =
  | 'idle'
  | 'forward-probe'
  | 'reverse-listen'
  | 'reverse-probe'
  | 'rate-send'
  | 'rate-listen'
  | 'ping'
  | 'pong-answer'
  | 'done';

export interface CalibrationEvent {
  kind: 'phase' | 'probe' | 'rate' | 'ping' | 'profile' | 'notice';
  message: string;
}

export interface CalibrationOptions {
  role: CalibrationRole;
  calId: string;
  /** Milliseconds to wait for one answer before giving up on it. */
  answerTimeoutMs?: number;
  ecl?: CalibrationEcc;
  burstFrames?: number;
  burstBytes?: number;
  pings?: number;
  /**
   * How long an answer frame must stay on screen before the next phase may
   * replace it. A peer cannot decode a frame that is replaced in the same
   * tick, so every transition that overwrites an answer is deferred.
   */
  frameDwellMs?: number;
}

export class CalibrationRunner {
  private readonly role: CalibrationRole;
  private readonly calId: string;
  private readonly timeoutMs: number;
  private readonly ecl: CalibrationEcc;
  private readonly burst: RateBurst;
  private readonly pingCount: number;
  private readonly ladder: ProbeStep[];

  private phase: CalibrationPhase = 'idle';
  private frameText: string | null = null;
  private events: CalibrationEvent[] = [];
  private phaseEnteredAt = 0;

  private stepIndex = 0;
  private probeId = 1;
  private waitingSince: number | null = null;

  /** Steps this device received an answer for, in each direction. */
  private forwardResults: CalProbeResultPayload[] = [];
  private reverseResults: CalProbeResultPayload[] = [];
  /** Steps this device answered ok, so it knows the peer's direction too. */
  private forwardAnswered: CalProbeResultPayload[] = [];
  private reverseAnswered: CalProbeResultPayload[] = [];

  private burstResult: CalRateResultPayload | null = null;
  private burstFramesSent = 0;
  private burstFramesSeen = 0;
  private rttSamples: number[] = [];
  private pingId = 1;
  private pingsSent = 0;
  private pendingPing: { id: number; t0: number } | null = null;
  private readonly dwellMs: number;
  /** A phase change that must wait for the current answer frame to be seen. */
  private deferred: (() => void) | null = null;
  private answerShownAt: number | null = null;
  private profile: LinkProfile | null = null;

  constructor(options: CalibrationOptions) {
    this.role = options.role;
    this.calId = options.calId;
    this.timeoutMs = options.answerTimeoutMs ?? 4000;
    this.ecl = options.ecl ?? 'M';
    this.burst = { burstId: 1, frames: options.burstFrames ?? 6, bytes: options.burstBytes ?? 128 };
    this.pingCount = options.pings ?? 3;
    this.dwellMs = options.frameDwellMs ?? 400;
    this.ladder = buildProbeLadder(this.ecl);
  }

  get currentPhase(): CalibrationPhase {
    return this.phase;
  }

  get result(): LinkProfile | null {
    return this.profile;
  }

  currentFrame(): string | null {
    return this.frameText;
  }

  drainEvents(): CalibrationEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(kind: CalibrationEvent['kind'], message: string): void {
    this.events.push({ kind, message });
  }

  private setPhase(phase: CalibrationPhase, message: string, nowMs: number): void {
    this.phase = phase;
    this.phaseEnteredAt = nowMs;
    this.waitingSince = null;
    this.emit('phase', message);
  }

  private frame(type: Parameters<typeof encodeFrame>[0]['type'], payload: unknown): void {
    this.frameText = encodeFrame({
      type,
      sessionId: CALIBRATION_SESSION_ID,
      sequence: 0,
      payload: jsonPayload(payload),
    });
  }

  /** Starts the exchange. Called once, after link-up. */
  start(nowMs: number): void {
    if (this.phase !== 'idle') return;
    if (this.role === 'leader') {
      this.setPhase('forward-probe', 'Leader probing the forward direction', nowMs);
      this.sendNextProbe(nowMs);
    } else {
      this.setPhase('reverse-listen', 'Waiting for the leader probe ladder', nowMs);
      this.frameText = null;
    }
  }

  private sendNextProbe(nowMs: number): void {
    if (this.stepIndex >= this.ladder.length) {
      // Ladder finished: hand the floor to the follower.
      this.frameText = null;
      this.setPhase('reverse-listen', 'Waiting for the reverse probe ladder', nowMs);
      return;
    }
    const step = this.ladder[this.stepIndex]!;
    this.frame('CAL_PROBE', makeProbe(this.calId, step, this.probeId++));
    this.waitingSince = nowMs;
    this.emit('probe', 'Probe ' + (this.stepIndex + 1) + '/' + this.ladder.length + ' at ' + step.bytes + ' bytes');
  }

  private sendNextBurstFrame(nowMs: number): void {
    if (this.burstFramesSent >= this.burst.frames) {
      this.setPhase('ping', 'Leader pinging the peer', nowMs);
      this.sendNextPing(nowMs);
      return;
    }
    this.frame('CAL_RATE_FRAME', makeRateFrame(this.burst, this.burstFramesSent));
    this.burstFramesSent++;
    this.waitingSince = nowMs;
  }

  private sendNextPing(nowMs: number): void {
    if (this.rttSamples.length >= this.pingCount || this.pingsSent >= this.pingCount * 2) {
      this.finish();
      return;
    }
    this.pingsSent++;
    this.pendingPing = { id: this.pingId++, t0: nowMs };
    this.frame('CAL_PING', makePing(this.pendingPing.id, nowMs));
    this.waitingSince = nowMs;
  }

  /** Both roles end here: derive from what this device observed itself. */
  private finish(): void {
    const leader = this.role === 'leader';
    const forward = leader ? this.forwardResults : this.forwardAnswered;
    const reverse = leader ? this.reverseAnswered : this.reverseResults;
    const profile = deriveLinkProfile({
      forwardBytes: confirmedBytes(this.ladder, forward),
      reverseBytes: confirmedBytes(this.ladder, reverse),
      ecl: this.ecl,
      burst: this.burst,
      burstResult: this.burstResult,
      rttSamples: leader ? this.rttSamples : [],
    });
    this.profile = profile;
    this.frameText = null;
    this.setPhase('done', 'Calibration complete: ' + profile.chunkSize + ' bytes per frame', 0);
    this.emit('profile', 'Profile: ' + JSON.stringify(profile));
  }

  /** Handles one decoded peer frame. Unknown types are ignored, not fatal. */
  onFrame(frame: ValidatedFrame, nowMs: number): void {
    if (this.phase === 'done') return;
    switch (frame.type) {
      case 'CAL_PROBE':
        this.answerProbe(frame, nowMs);
        return;
      case 'CAL_PROBE_RESULT':
        this.acceptProbeResult(frame, nowMs);
        return;
      case 'CAL_RATE_FRAME':
        this.answerRateFrame(frame);
        return;
      case 'CAL_RATE_RESULT':
        this.acceptRateResult(frame, nowMs);
        return;
      case 'CAL_PING':
        this.answerPing(frame, nowMs);
        return;
      case 'CAL_PONG':
        this.acceptPong(frame, nowMs);
        return;
      default:
        return;
    }
  }

  private answerProbe(frame: ValidatedFrame, nowMs: number): void {
    const json = frame.json as { step: number; bytes: number; ecl: CalibrationEcc; filler: string } | null;
    if (!json) return;
    let observedBytes = 0;
    let ok = false;
    try {
      const decoded = base64UrlDecode(json.filler);
      observedBytes = decoded.length;
      ok = decoded.length === json.bytes;
    } catch {
      ok = false;
    }
    const answer: CalProbeResultPayload = { step: json.step, ok, observedBytes };
    const last = json.step >= this.ladder.length - 1;

    // Which ladder is being answered decides which direction this confirms.
    if (this.phase === 'reverse-listen' && this.role === 'follower') {
      this.forwardAnswered.push(answer);
      this.frame('CAL_PROBE_RESULT', answer);
      this.waitingSince = nowMs;
      this.answerShownAt = nowMs;
      if (last) {
        this.deferred = () => {
          this.stepIndex = 0;
          this.setPhase('reverse-probe', 'Follower probing the reverse direction', nowMs);
          this.sendNextProbe(nowMs);
        };
      }
      return;
    }
    if (this.phase === 'reverse-listen' && this.role === 'leader') {
      this.reverseAnswered.push(answer);
      this.frame('CAL_PROBE_RESULT', answer);
      this.waitingSince = nowMs;
      this.answerShownAt = nowMs;
      if (last) {
        this.deferred = () => {
          this.burstFramesSent = 0;
          this.setPhase('rate-send', 'Leader sending a rate burst', nowMs);
          this.sendNextBurstFrame(nowMs);
        };
      }
    }
  }

  private acceptProbeResult(frame: ValidatedFrame, nowMs: number): void {
    const result = frame.json as CalProbeResultPayload | null;
    if (!result) return;
    if (this.phase === 'forward-probe') {
      const step = this.ladder[this.stepIndex];
      if (!step || result.step !== step.step) return;
      this.forwardResults.push(result);
      this.stepIndex++;
      this.sendNextProbe(nowMs);
      return;
    }
    if (this.phase === 'reverse-probe') {
      const step = this.ladder[this.stepIndex];
      if (!step || result.step !== step.step) return;
      this.reverseResults.push(result);
      this.stepIndex++;
      if (this.stepIndex >= this.ladder.length) {
        this.frameText = null;
        this.answerShownAt = null;
        this.setPhase('rate-listen', 'Waiting for the rate burst', nowMs);
        return;
      }
      this.sendNextProbe(nowMs);
    }
  }

  private answerRateFrame(frame: ValidatedFrame): void {
    const json = frame.json as { burstId: number; index: number } | null;
    if (!json || json.burstId !== this.burst.burstId) return;
    if (this.phase !== 'rate-listen') return;
    this.burstFramesSeen = Math.max(this.burstFramesSeen, json.index + 1);
    this.burstResult = {
      burstId: json.burstId,
      received: this.burstFramesSeen,
      frames: this.burst.frames,
      elapsedMs: Math.max(1, this.burst.frames * 250),
    };
    this.frame('CAL_RATE_RESULT', this.burstResult);
    if (this.burstFramesSeen >= this.burst.frames) {
      this.setPhase('pong-answer', 'Answering pings', 0);
    }
  }

  private acceptRateResult(frame: ValidatedFrame, nowMs: number): void {
    const result = frame.json as CalRateResultPayload | null;
    if (!result || result.burstId !== this.burst.burstId) return;
    if (this.phase !== 'rate-send') return;
    this.burstResult = result;
    this.emit('rate', 'Burst: ' + result.received + '/' + result.frames + ' frames seen');
    // The follower reports after each frame, so keep streaming until it has
    // seen the whole burst or the burst is exhausted.
    if (result.received < this.burst.frames && this.burstFramesSent < this.burst.frames) {
      this.sendNextBurstFrame(nowMs);
      return;
    }
    this.setPhase('ping', 'Leader pinging the peer', nowMs);
    this.sendNextPing(nowMs);
  }

  private answerPing(frame: ValidatedFrame, nowMs: number): void {
    const json = frame.json as { pingId: number; t0: number } | null;
    if (!json) return;
    this.frame('CAL_PONG', makePong(json, nowMs));
    // The follower has no explicit end-of-calibration signal, so a quiet
    // period after the first ping is what ends its side. Later pings must not
    // restart that timer, or a chatty leader would keep it alive forever.
    if (this.phase === 'pong-answer' && this.waitingSince === null) this.waitingSince = nowMs;
  }

  private acceptPong(frame: ValidatedFrame, nowMs: number): void {
    if (this.phase !== 'ping' || !this.pendingPing) return;
    const pong = frame.json as { pingId: number; t0: number; t1: number } | null;
    if (!pong) return;
    const rtt = rttFor(makePing(this.pendingPing.id, this.pendingPing.t0), pong, nowMs);
    if (rtt === null) return;
    this.rttSamples.push(rtt);
    this.emit('ping', 'Round trip ' + rtt.toFixed(0) + ' ms');
    this.pendingPing = null;
    this.waitingSince = nowMs;
    this.sendNextPing(nowMs);
  }

  /**
   * Advances time. A step that has waited past the answer timeout is abandoned
   * rather than retried forever, so a silent peer still produces a profile
   * that reflects only what was actually observed.
   */
  tick(nowMs: number): void {
    if (this.phase === 'done' || this.phase === 'idle') return;

    // A deferred transition waits until the answer frame has had time to be
    // scanned. Without this the peer would never see the final answer.
    if (this.deferred !== null) {
      const shown = this.answerShownAt;
      if (shown !== null && nowMs - shown < this.dwellMs) return;
      const action = this.deferred;
      this.deferred = null;
      this.answerShownAt = null;
      action();
      return;
    }

    // The leader only hears from the follower while it answers that ladder.
    if (this.phase === 'reverse-listen' && this.role === 'leader') {
      if (nowMs - this.phaseEnteredAt < this.timeoutMs * 2) return;
      this.emit('notice', 'No reverse probe ladder arrived; reverse direction unconfirmed');
      this.burstFramesSent = 0;
      this.setPhase('rate-send', 'Leader sending a rate burst', nowMs);
      this.sendNextBurstFrame(nowMs);
      return;
    }

    if (this.waitingSince === null) return;
    if (nowMs - this.waitingSince < this.timeoutMs) return;
    this.emit('notice', 'No answer within ' + this.timeoutMs + ' ms during ' + this.phase);
    this.waitingSince = null;

    if (this.phase === 'forward-probe') {
      this.stepIndex++;
      this.sendNextProbe(nowMs);
      return;
    }
    if (this.phase === 'reverse-probe') {
      this.stepIndex++;
      if (this.stepIndex >= this.ladder.length) {
        this.frameText = null;
        this.answerShownAt = null;
        this.setPhase('rate-listen', 'Waiting for the rate burst', nowMs);
        return;
      }
      this.sendNextProbe(nowMs);
      return;
    }
    if (this.phase === 'rate-send') {
      this.setPhase('ping', 'Leader pinging the peer', nowMs);
      this.sendNextPing(nowMs);
      return;
    }
    if (this.phase === 'ping') {
      this.pendingPing = null;
      this.sendNextPing(nowMs);
      return;
    }
    if (this.phase === 'pong-answer') {
      this.finish();
    }
  }

  /** Fraction of the burst the peer reported, or 0. Exposed for the UI. */
  burstReliabilitySeen(): number {
    return this.burstResult ? burstReliability(this.burstResult, this.burst) : 0;
  }
}

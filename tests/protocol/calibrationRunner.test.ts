import { describe, expect, it } from 'vitest';
import { CalibrationRunner } from '../../src/protocol/calibrationRunner';
import { decodeFrame, encodeFrame, type ValidatedFrame } from '../../src/protocol/frame';
import type { CalProbeResultPayload } from '../../src/protocol/messageTypes';

const CAL_ID = '9c'.repeat(16);

/** Delivers a frame to the other runner exactly as the optical link would. */
function deliver(runner: CalibrationRunner, text: string | null, nowMs: number): void {
  if (text === null) return;
  const frame: ValidatedFrame = decodeFrame(text);
  runner.onFrame(frame, nowMs);
}

/**
 * Runs two runners against each other until both are done or the budget is
 * exhausted. This is a wiring test: it proves frames are produced and consumed
 * in the right order, not that any real link supports the sizes involved.
 */
function runPair(leader: CalibrationRunner, follower: CalibrationRunner, budgetMs = 60000): number {
  let now = 1000;
  leader.start(now);
  follower.start(now);
  // Each distinct frame text is delivered once. The optical link re-shows a
  // frame until the state machine replaces it; the receiver must not treat a
  // re-shown frame as new traffic.
  const delivered = new Map<CalibrationRunner, string>();
  const step = 250;
  while (now < budgetMs && (leader.currentPhase !== 'done' || follower.currentPhase !== 'done')) {
    now += step;
    for (const [sender, receiver] of [
      [leader, follower],
      [follower, leader],
    ] as const) {
      const text = sender.currentFrame();
      if (text === null) continue;
      if (delivered.get(receiver) === text) continue;
      delivered.set(receiver, text);
      deliver(receiver, text, now);
    }
    leader.tick(now);
    follower.tick(now);
  }
  return now;
}

describe('calibration runner', () => {
  it('starts idle with no frame', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    expect(leader.currentPhase).toBe('idle');
    expect(leader.currentFrame()).toBeNull();
    expect(leader.result).toBeNull();
  });

  it('leads with a probe the follower can decode', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    leader.start(1000);
    const text = leader.currentFrame();
    expect(text).not.toBeNull();
    const frame = decodeFrame(text!);
    expect(frame.type).toBe('CAL_PROBE');
    expect(frame.json).toMatchObject({ step: 0, total: 6, bytes: 32, ecl: 'M' });
  });

  it('completes the whole exchange and yields a bidirectional profile', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    const follower = new CalibrationRunner({ role: 'follower', calId: CAL_ID });
    runPair(leader, follower);

    expect(leader.currentPhase).toBe('done');
    expect(follower.currentPhase).toBe('done');

    const leaderProfile = leader.result;
    const followerProfile = follower.result;
    expect(leaderProfile).not.toBeNull();
    expect(followerProfile).not.toBeNull();
    expect(leaderProfile!.chunkSize).toBe(followerProfile!.chunkSize);
    expect(leaderProfile!.bidirectional).toBe(true);
    expect(leaderProfile!.chunkSize).toBeGreaterThanOrEqual(64);
    expect(leaderProfile!.chunkSize).toBeLessThanOrEqual(512);
    expect(leaderProfile!.rttMs).not.toBeNull();
  }, 20000);

  it('produces no calibration frame once done', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    const follower = new CalibrationRunner({ role: 'follower', calId: CAL_ID });
    runPair(leader, follower);
    expect(leader.currentFrame()).toBeNull();
    expect(follower.currentFrame()).toBeNull();
  }, 20000);

  it('times out a silent peer instead of hanging', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID, answerTimeoutMs: 1000 });
    leader.start(0);
    let now = 0;
    for (let i = 0; i < 400 && leader.currentPhase !== 'done'; i++) {
      now += 500;
      leader.tick(now);
    }
    expect(leader.currentPhase).toBe('done');
    // Nothing was ever confirmed, so the profile is the conservative fallback.
    expect(leader.result!.bidirectional).toBe(false);
    expect(leader.result!.chunkSize).toBe(64);
  });

  it('records a notice when an answer never arrives', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID, answerTimeoutMs: 1000 });
    leader.start(0);
    leader.tick(2000);
    const notices = leader.drainEvents().filter((e) => e.kind === 'notice');
    expect(notices.length).toBeGreaterThan(0);
  });

  it('rejects a probe result for the wrong step', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    leader.start(0);
    const before = leader.currentFrame();
    const wrong: CalProbeResultPayload = { step: 3, ok: true, observedBytes: 256 };
    const frame = decodeFrame(
      encodeFrame({
        type: 'CAL_PROBE_RESULT',
        sessionId: '0'.repeat(32),
        sequence: 0,
        payload: new TextEncoder().encode(JSON.stringify(wrong)),
      }),
    );
    leader.onFrame(frame, 500);
    expect(leader.currentFrame()).toBe(before);
  });

  it('drains events once', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    leader.start(0);
    expect(leader.drainEvents().length).toBeGreaterThan(0);
    expect(leader.drainEvents()).toEqual([]);
  });
});

describe('calibration diagnostics', () => {
  it('reports every ladder rung and both directions after a full exchange', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID });
    const follower = new CalibrationRunner({ role: 'follower', calId: CAL_ID });
    runPair(leader, follower);

    const diag = leader.diagnostics;
    expect(diag.role).toBe('leader');
    expect(diag.ecl).toBe('M');
    expect(diag.ladder.map((row) => row.bytes)).toEqual([32, 64, 128, 256, 512, 1024]);
    expect(diag.ladder.every((row) => row.forward === true)).toBe(true);
    expect(diag.ladder.every((row) => row.reverse === true)).toBe(true);
    expect(diag.forwardConfirmedBytes).toBe(1024);
    expect(diag.reverseConfirmedBytes).toBe(1024);
    expect(diag.timeouts).toBe(0);
    expect(diag.rttSamples.length).toBeGreaterThan(0);
  }, 20000);

  it('marks unanswered rungs as no answer rather than failed', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID, answerTimeoutMs: 1000 });
    leader.start(0);
    const diag = leader.diagnostics;
    expect(diag.ladder.every((row) => row.forward === null)).toBe(true);
    expect(diag.forwardConfirmedBytes).toBe(0);
  });

  it('counts timeouts', () => {
    const leader = new CalibrationRunner({ role: 'leader', calId: CAL_ID, answerTimeoutMs: 1000 });
    leader.start(0);
    leader.tick(2000);
    expect(leader.diagnostics.timeouts).toBe(1);
  });

  it('exposes the EC level the display must use', () => {
    expect(new CalibrationRunner({ role: 'leader', calId: CAL_ID }).eclLevel).toBe('M');
    expect(new CalibrationRunner({ role: 'leader', calId: CAL_ID, ecl: 'Q' }).eclLevel).toBe('Q');
  });
});

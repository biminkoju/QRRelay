import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL } from '../../src/sim/channel';
import { runLoopback, sweepModuleSize } from '../../src/sim/loopback';
import { buildProbeLadder } from '../../src/protocol/calibration';

const CAL_ID = '3a'.repeat(16);

/**
 * A channel good enough that every frame should decode. The point of the clean
 * run is to prove the runner wiring completes end to end, not to be generous.
 */
const CLEAN_CHANNEL = { ...DEFAULT_CHANNEL, modulePx: 8, captureWidth: 2400 };

describe('single-machine loopback', () => {
  it('completes a full calibration exchange over a clean channel', () => {
    const result = runLoopback({ channel: CLEAN_CHANNEL, calId: CAL_ID, ecl: 'M' });

    expect(result.completed).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.leader.role).toBe('leader');
    expect(result.follower.role).toBe('follower');
    // Every rung was answered in both directions.
    expect(result.leader.ladder.every((row) => row.forward === true)).toBe(true);
    expect(result.leader.forwardConfirmedBytes).toBe(1024);
    expect(result.leader.reverseConfirmedBytes).toBe(1024);
    expect(result.leaderProfile).not.toBeNull();
    expect(result.followerProfile).not.toBeNull();
    expect(result.leaderProfile!.chunkSize).toBe(result.followerProfile!.chunkSize);
    expect(result.leader.rttSamples.length).toBeGreaterThan(0);
  }, 60000);

  it('produces a deterministic result for the same seed', () => {
    const a = runLoopback({ channel: CLEAN_CHANNEL, calId: CAL_ID, ecl: 'M' });
    const b = runLoopback({ channel: CLEAN_CHANNEL, calId: CAL_ID, ecl: 'M' });
    expect(a.leaderProfile!.chunkSize).toBe(b.leaderProfile!.chunkSize);
    expect(a.log.length).toBe(b.log.length);
    expect(a.elapsedMs).toBe(b.elapsedMs);
  }, 120000);

  it('drops frames and reports an unconfirmed direction when the channel is unreadable', () => {
    // One capture pixel per module and below: nothing can be decoded.
    const hopeless = { ...DEFAULT_CHANNEL, modulePx: 4, captureWidth: 60 };
    const result = runLoopback({
      channel: hopeless,
      calId: CAL_ID,
      ecl: 'M',
      answerTimeoutMs: 1000,
      budgetMs: 200000,
    });

    expect(result.dropped).toBeGreaterThan(0);
    expect(result.leader.forwardConfirmedBytes).toBe(0);
    expect(result.leader.reverseConfirmedBytes).toBe(0);
    expect(result.leaderProfile!.bidirectional).toBe(false);
    expect(result.leaderProfile!.chunkSize).toBe(64);
  }, 60000);

  it('records every delivered frame with its pixels per module', () => {
    const result = runLoopback({ channel: CLEAN_CHANNEL, calId: CAL_ID, ecl: 'M' });
    expect(result.log.length).toBeGreaterThan(0);
    const first = result.log[0]!;
    expect(first.type).toMatch(/^CAL_/);
    expect(first.capturePxPerModule).toBeGreaterThan(1);
    expect(first.modules).toBeGreaterThan(0);
    // Both directions appear in the log.
    expect(result.log.some((f) => f.from === 'leader')).toBe(true);
    expect(result.log.some((f) => f.from === 'follower')).toBe(true);
  }, 60000);
});

describe('module size sweep', () => {
  it('decodes large symbols at generous resolution and fails at tiny ones', () => {
    const samples = [0.5, 2, 8];
    const points = sweepModuleSize(1024, 'M', CAL_ID, samples, DEFAULT_CHANNEL);

    expect(points.map((p) => p.pxPerModule)).toEqual(samples);
    expect(points.find((p) => p.pxPerModule === 8)!.ok).toBe(true);
    expect(points.find((p) => p.pxPerModule === 0.5)!.ok).toBe(false);
    // Every point reports the same symbol size, only the sampling differs.
    expect(new Set(points.map((p) => p.modules)).size).toBe(1);
  }, 60000);

  it('reports larger symbols for larger payloads', () => {
    const ladder = buildProbeLadder('M');
    const small = sweepModuleSize(ladder[0]!.bytes, 'M', CAL_ID, [8], DEFAULT_CHANNEL)[0]!;
    const large = sweepModuleSize(ladder[ladder.length - 1]!.bytes, 'M', CAL_ID, [8], DEFAULT_CHANNEL)[0]!;
    expect(large.modules).toBeGreaterThan(small.modules);
  }, 60000);
});

import { describe, expect, it } from 'vitest';
import {
  buildProbeLadder,
  burstFrameRate,
  burstReliability,
  confirmedBytes,
  deriveLinkProfile,
  evaluateProbe,
  makePing,
  makePong,
  makeProbe,
  makeRateFrame,
  medianRtt,
  probeFiller,
  rttFor,
  suggestedAckTimeoutMs,
  type ProbeStep,
  type RateBurst,
} from '../../src/protocol/calibration';
import { validateCalProbe, validateCalProbeResult } from '../../src/protocol/messageTypes';
import { base64UrlEncode } from '../../src/protocol/bytes';

const CAL_ID = 'ab'.repeat(16);

describe('probe ladder', () => {
  it('grows geometrically from 32 to 1024 bytes', () => {
    const ladder = buildProbeLadder('M');
    expect(ladder.map((s) => s.bytes)).toEqual([32, 64, 128, 256, 512, 1024]);
    expect(ladder.every((s) => s.total === 6)).toBe(true);
    expect(ladder.every((s) => s.ecl === 'M')).toBe(true);
  });

  it('numbers steps from zero', () => {
    expect(buildProbeLadder().map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('probe filler', () => {
  it('is deterministic for the same inputs', () => {
    expect(Array.from(probeFiller(CAL_ID, 7, 64))).toEqual(Array.from(probeFiller(CAL_ID, 7, 64)));
  });

  it('differs between probe ids and sizes', () => {
    expect(Array.from(probeFiller(CAL_ID, 1, 64))).not.toEqual(Array.from(probeFiller(CAL_ID, 2, 64)));
    expect(probeFiller(CAL_ID, 1, 32)).toHaveLength(32);
    expect(probeFiller(CAL_ID, 1, 128)).toHaveLength(128);
  });

  it('is not all zeros', () => {
    expect(probeFiller(CAL_ID, 1, 64).some((b) => b !== 0)).toBe(true);
  });
});

describe('makeProbe', () => {
  const step = buildProbeLadder()[3]!;

  it('produces a payload the validator accepts', () => {
    const payload = makeProbe(CAL_ID, step, 42);
    expect(validateCalProbe(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it('carries exactly the step byte count', () => {
    const payload = makeProbe(CAL_ID, step, 42);
    expect(payload.bytes).toBe(256);
    expect(payload.filler.length).toBeGreaterThan(0);
  });
});

describe('evaluateProbe', () => {
  const step: ProbeStep = { step: 2, total: 6, bytes: 128, ecl: 'M' };

  it('accepts an exact match', () => {
    expect(evaluateProbe(step, { step: 2, ok: true, observedBytes: 128 })).toBe(true);
  });

  it('rejects a partial or inflated answer', () => {
    expect(evaluateProbe(step, { step: 2, ok: true, observedBytes: 127 })).toBe(false);
    expect(evaluateProbe(step, { step: 2, ok: true, observedBytes: 129 })).toBe(false);
  });

  it('rejects a failed probe even when the byte count matches', () => {
    expect(evaluateProbe(step, { step: 2, ok: false, observedBytes: 128 })).toBe(false);
  });

  it('rejects an answer for a different step', () => {
    expect(evaluateProbe(step, { step: 3, ok: true, observedBytes: 128 })).toBe(false);
  });

  it('rejects an unvalidated oversized observation', () => {
    expect(() => validateCalProbeResult({ step: 2, ok: true, observedBytes: 5000 })).toThrow();
  });
});

describe('confirmedBytes', () => {
  const ladder = buildProbeLadder();

  it('returns the largest confirmed size', () => {
    expect(
      confirmedBytes(ladder, [
        { step: 0, ok: true, observedBytes: 32 },
        { step: 1, ok: true, observedBytes: 64 },
        { step: 2, ok: false, observedBytes: 0 },
      ]),
    ).toBe(64);
  });

  it('returns zero when nothing was confirmed', () => {
    expect(confirmedBytes(ladder, [])).toBe(0);
    expect(confirmedBytes(ladder, [{ step: 0, ok: false, observedBytes: 0 }])).toBe(0);
  });

  it('does not trust a confirmation beyond a failed step', () => {
    expect(
      confirmedBytes(ladder, [
        { step: 0, ok: true, observedBytes: 32 },
        { step: 1, ok: false, observedBytes: 0 },
        { step: 2, ok: true, observedBytes: 128 },
      ]),
    ).toBe(128);
  });
});

describe('rate burst', () => {
  const burst: RateBurst = { burstId: 5, frames: 10, bytes: 64 };

  it('builds a frame the validator accepts', () => {
    const frame = makeRateFrame(burst, 3);
    expect(frame.burstId).toBe(5);
    expect(frame.index).toBe(3);
    expect(typeof frame.filler).toBe('string');
  });

  it('computes reliability as received over frames', () => {
    expect(burstReliability({ burstId: 5, received: 7, frames: 10, elapsedMs: 1000 }, burst)).toBeCloseTo(0.7);
  });

  it('never reports reliability above one', () => {
    expect(burstReliability({ burstId: 5, received: 99, frames: 10, elapsedMs: 1000 }, burst)).toBe(1);
  });

  it('returns zero reliability for a mismatched burst id', () => {
    expect(burstReliability({ burstId: 6, received: 7, frames: 10, elapsedMs: 1000 }, burst)).toBe(0);
  });

  it('computes frames per second from observed data', () => {
    expect(burstFrameRate({ burstId: 5, received: 10, frames: 10, elapsedMs: 2000 })).toBeCloseTo(5);
  });

  it('returns zero frame rate for a zero or negative interval', () => {
    expect(burstFrameRate({ burstId: 5, received: 10, frames: 10, elapsedMs: 0 })).toBe(0);
  });
});

describe('ping/pong', () => {
  it('measures round-trip time from matching identifiers', () => {
    const ping = makePing(9, 1000);
    const pong = makePong(ping, 1050);
    expect(rttFor(ping, pong, 1200)).toBe(200);
  });

  it('discards a stale reply for a different ping', () => {
    const ping = makePing(9, 1000);
    const stale = makePong(makePing(8, 500), 1100);
    expect(rttFor(ping, stale, 1200)).toBeNull();
  });

  it('discards a reply that does not echo t0', () => {
    const ping = makePing(9, 1000);
    expect(rttFor(ping, { pingId: 9, t0: 999, t1: 1100 }, 1200)).toBeNull();
  });
});

describe('medianRtt', () => {
  it('is null for an empty sample', () => {
    expect(medianRtt([])).toBeNull();
  });

  it('takes the middle of an odd sample', () => {
    expect(medianRtt([500, 100, 300])).toBe(300);
  });

  it('averages the two middle values of an even sample', () => {
    expect(medianRtt([100, 200, 300, 400])).toBe(250);
  });

  it('ignores non-finite and negative samples', () => {
    expect(medianRtt([-5, Number.NaN, 100])).toBe(100);
  });
});

describe('LinkProfile derivation', () => {
  const burst: RateBurst = { burstId: 1, frames: 10, bytes: 64 };

  it('uses the weakest direction and halves it', () => {
    const profile = deriveLinkProfile({
      forwardBytes: 512,
      reverseBytes: 128,
      ecl: 'M',
      burst,
      burstResult: { burstId: 1, received: 10, frames: 10, elapsedMs: 2000 },
      rttSamples: [300, 400],
    });
    expect(profile.chunkSize).toBe(64);
    expect(profile.bidirectional).toBe(true);
    expect(profile.reliability).toBe(1);
    expect(profile.framesPerSecond).toBeCloseTo(5);
    expect(profile.rttMs).toBe(350);
  });

  it('falls back to the minimum chunk when a direction is unconfirmed', () => {
    const profile = deriveLinkProfile({
      forwardBytes: 1024,
      reverseBytes: 0,
      ecl: 'M',
      burst: null,
      burstResult: null,
      rttSamples: [],
    });
    expect(profile.chunkSize).toBe(64);
    expect(profile.bidirectional).toBe(false);
    expect(profile.reliability).toBe(0);
    expect(profile.rttMs).toBeNull();
    expect(profile.notes.length).toBeGreaterThan(0);
  });

  it('never exceeds the protocol payload ceiling', () => {
    const profile = deriveLinkProfile({
      forwardBytes: 1_000_000,
      reverseBytes: 1_000_000,
      ecl: 'M',
      burst: null,
      burstResult: null,
      rttSamples: [],
    });
    expect(profile.chunkSize).toBe(4096);
  });

  it('records a note when the burst lost frames', () => {
    const profile = deriveLinkProfile({
      forwardBytes: 256,
      reverseBytes: 256,
      ecl: 'M',
      burst,
      burstResult: { burstId: 1, received: 6, frames: 10, elapsedMs: 2000 },
      rttSamples: [],
    });
    expect(profile.reliability).toBeCloseTo(0.6);
    expect(profile.notes.join(' ')).toMatch(/lost frames/);
  });
});

describe('suggestedAckTimeoutMs', () => {
  const base = deriveLinkProfile({
    forwardBytes: 256,
    reverseBytes: 256,
    ecl: 'M',
    burst: null,
    burstResult: null,
    rttSamples: [1000],
  });

  it('applies a conservative floor', () => {
    const noRtt = deriveLinkProfile({
      forwardBytes: 0,
      reverseBytes: 0,
      ecl: 'M',
      burst: null,
      burstResult: null,
      rttSamples: [],
    });
    expect(suggestedAckTimeoutMs(noRtt)).toBe(3000);
  });

  it('scales with measured rtt', () => {
    expect(suggestedAckTimeoutMs(base)).toBe(6000);
  });
});

describe('probe payload validation', () => {
  it('rejects a filler whose length disagrees with bytes', () => {
    expect(() =>
      validateCalProbe({ step: 0, total: 6, probeId: 1, bytes: 64, ecl: 'M', filler: base64UrlEncode(new Uint8Array(32)) }),
    ).toThrow();
  });

  it('rejects an unknown EC level', () => {
    expect(() =>
      validateCalProbe({ step: 0, total: 6, probeId: 1, bytes: 32, ecl: 'X', filler: base64UrlEncode(new Uint8Array(32)) }),
    ).toThrow();
  });

  it('rejects filler that is not base64url', () => {
    expect(() =>
      validateCalProbe({ step: 0, total: 6, probeId: 1, bytes: 32, ecl: 'M', filler: 'not+valid/base64==' }),
    ).toThrow();
  });
});

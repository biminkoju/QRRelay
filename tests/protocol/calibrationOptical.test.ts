import { describe, expect, it } from 'vitest';
import {
  buildProbeLadder,
  burstReliability,
  confirmedBytes,
  deriveLinkProfile,
  evaluateProbe,
  makePing,
  makePong,
  makeProbe,
  makeRateFrame,
  medianRtt,
  rttFor,
  suggestedAckTimeoutMs,
} from '../../src/protocol/calibration';
import { CALIBRATION_SESSION_ID } from '../../src/protocol/alignment';
import { decodeFrame, encodeFrame } from '../../src/protocol/frame';
import { jsonPayload } from '../../src/protocol/sender';
import { decodeQrText } from '../../src/qr/decode';
import { encodeQr } from '../../src/qr/encode';
import { renderQrToRgba } from '../../src/qr/render';
import type { CalProbeResultPayload } from '../../src/protocol/messageTypes';

const CAL_ID = '4f'.repeat(16);

/** Optical hop: frame text -> QR bitmap -> decoded frame text. */
function throughQr(text: string): string {
  const image = renderQrToRgba(encodeQr(text, 'M'), { scale: 2 });
  const decoded = decodeQrText(image);
  if (decoded === null) throw new Error('no QR decoded');
  return decoded;
}

function calFrame(type: Parameters<typeof encodeFrame>[0]['type'], payload: unknown): string {
  return encodeFrame({ type, sessionId: CALIBRATION_SESSION_ID, sequence: 0, payload: jsonPayload(payload) });
}

describe('calibration frames through real QR images', () => {
  it('carries every probe step, including the 1024-byte ceiling', () => {
    const ladder = buildProbeLadder('M');
    const results: CalProbeResultPayload[] = [];
    for (const step of ladder) {
      const probe = makeProbe(CAL_ID, step, 100 + step.step);
      const decoded = decodeFrame(throughQr(calFrame('CAL_PROBE', probe)));
      expect(decoded.type).toBe('CAL_PROBE');
      expect(decoded.json).toEqual(probe);
      const answer: CalProbeResultPayload = { step: step.step, ok: true, observedBytes: step.bytes };
      const back = decodeFrame(throughQr(calFrame('CAL_PROBE_RESULT', answer)));
      expect(back.json).toEqual(answer);
      results.push(back.json as CalProbeResultPayload);
    }
    expect(ladder).toHaveLength(6);
    expect(ladder[5]!.bytes).toBe(1024);
    expect(confirmedBytes(ladder, results)).toBe(1024);
    expect(results.every((r, i) => evaluateProbe(ladder[i]!, r))).toBe(true);
  }, 60000);

  it('detects a probe that was corrupted in transit', () => {
    const step = buildProbeLadder('M')[2]!;
    const probe = makeProbe(CAL_ID, step, 7);
    const text = calFrame('CAL_PROBE', probe);
    const corrupted = text.slice(0, 60) + (text[60] === 'A' ? 'B' : 'A') + text.slice(61);
    expect(() => decodeFrame(corrupted)).toThrow();
  });

  it('carries a rate burst frame', () => {
    const frame = makeRateFrame({ burstId: 3, frames: 8, bytes: 128 }, 5);
    const decoded = decodeFrame(throughQr(calFrame('CAL_RATE_FRAME', frame)));
    expect(decoded.json).toEqual(frame);
    expect(burstReliability({ burstId: 3, received: 6, frames: 8, elapsedMs: 1200 }, { burstId: 3, frames: 8, bytes: 128 })).toBeCloseTo(0.75);
  }, 30000);

  it('carries ping and pong and yields a round-trip sample', () => {
    const ping = makePing(11, 1234.5);
    const seenPing = decodeFrame(throughQr(calFrame('CAL_PING', ping)));
    expect(seenPing.json).toEqual(ping);
    const pong = makePong(seenPing.json as typeof ping, 1900.25);
    const seenPong = decodeFrame(throughQr(calFrame('CAL_PONG', pong)));
    expect(rttFor(ping, seenPong.json as typeof pong, 2500)).toBe(1265.5);
  }, 30000);
});

describe('full calibration to a profile', () => {
  it('derives a bidirectional profile from measured values', () => {
    const ladder = buildProbeLadder('M');
    const forward = ladder
      .slice(0, 4)
      .map((s) => ({ step: s.step, ok: true, observedBytes: s.bytes }) as CalProbeResultPayload);
    const reverse = [
      { step: 0, ok: true, observedBytes: 32 },
      { step: 1, ok: true, observedBytes: 64 },
      { step: 2, ok: false, observedBytes: 0 },
    ];
    const burst = { burstId: 1, frames: 10, bytes: 64 };
    const burstResult = { burstId: 1, received: 10, frames: 10, elapsedMs: 2500 };
    const ping = makePing(1, 0);
    const rtts = [rttFor(ping, makePong(ping, 400), 800)!];

    const profile = deriveLinkProfile({
      forwardBytes: confirmedBytes(ladder, forward),
      reverseBytes: confirmedBytes(ladder, reverse),
      ecl: 'M',
      burst,
      burstResult,
      rttSamples: rtts,
    });

    expect(profile.bidirectional).toBe(true);
    // Weakest direction confirmed 64 bytes; half of that (32) is below the
    // 64-byte floor, so the floor wins and the note explains the clamp.
    expect(profile.chunkSize).toBe(64);
    expect(profile.notes.join(' ')).toMatch(/half the weakest confirmed payload/);
    expect(profile.framesPerSecond).toBeCloseTo(4);
    expect(profile.reliability).toBe(1);
    expect(profile.rttMs).toBe(800);
    expect(medianRtt(rtts)).toBe(800);
    expect(suggestedAckTimeoutMs(profile)).toBe(5200);
  });
});

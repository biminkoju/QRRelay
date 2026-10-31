import { describe, expect, it } from 'vitest';
import { applyPeerBeacon, initialState, localBeacon, type AlignmentState } from '../../src/protocol/alignment';
import { decodeFrame, encodeFrame, FrameError } from '../../src/protocol/frame';
import { CALIBRATION_SESSION_ID } from '../../src/protocol/alignment';
import { encodeQr } from '../../src/qr/encode';
import { renderQrToRgba } from '../../src/qr/render';
import { decodeQrText } from '../../src/qr/decode';
import { jsonPayload } from '../../src/protocol/sender';

const localA = { appVersion: '0.1.0', buildId: 'aaa', protocolVersions: [1], capabilities: ['reliable'] };
const localB = { appVersion: '0.1.0', buildId: 'bbb', protocolVersions: [1], capabilities: ['reliable'] };

/** One device: holds alignment state and renders its beacon as a real QR. */
async function beaconFrame(state: AlignmentState, local: typeof localA): Promise<string> {
  const payload = localBeacon(state, local);
  return encodeFrame({ type: 'CAL_BEACON', sessionId: CALIBRATION_SESSION_ID, sequence: 0, payload: jsonPayload(payload) });
}

/** Optical hop: frame text -> QR bitmap -> decoded frame text. */
function throughQr(text: string): string {
  const image = renderQrToRgba(encodeQr(text, 'Q'), { scale: 3 });
  const decoded = decodeQrText(image);
  if (decoded === null) throw new Error('no QR decoded');
  return decoded;
}

async function scan(state: AlignmentState, frameText: string) {
  const frame = decodeFrame(frameText);
  if (frame.sessionId !== CALIBRATION_SESSION_ID) throw new FrameError('BAD_SESSION', 'not a calibration frame');
  if (frame.json === null) throw new FrameError('BAD_PAYLOAD', 'beacon payload missing');
  return applyPeerBeacon(state, frame.json as Parameters<typeof applyPeerBeacon>[1]);
}

describe('beacon exchange through real QR images', () => {
  it('reaches link-up on both sides with a matching calibration id', async () => {
    let a = initialState('1'.repeat(32));
    let b = initialState('9'.repeat(32));

    // Round 1: both display, neither has seen the other.
    a = (await scan(a, throughQr(await beaconFrame(b, localB)))).state;
    b = (await scan(b, throughQr(await beaconFrame(a, localA)))).state;
    expect(a.phase).toBe('aligning');
    expect(a.peerSeen).toBe(true);
    expect(a.peerSeesUs).toBe(false);

    // Round 2: each beacon now acknowledges the other's nonce.
    a = (await scan(a, throughQr(await beaconFrame(b, localB)))).state;
    b = (await scan(b, throughQr(await beaconFrame(a, localA)))).state;

    expect(a.phase).toBe('link-up');
    expect(b.phase).toBe('link-up');
    expect(a.calId).toBe(b.calId);
    expect(a.calId).toMatch(/^[0-9a-f]{32}$/);
    // Exactly one side leads the first probe phase.
    expect(a.leader).not.toBe(b.leader);
  }, 30000);

  it('does not claim link-up when one direction is dead', async () => {
    let a = initialState('2'.repeat(32));
    const b = initialState('8'.repeat(32));
    // B can see A, but A never sees B.
    a = (await scan(a, throughQr(await beaconFrame(b, localB)))).state;
    expect(b.phase).toBe('aligning');
    expect(a.phase).toBe('aligning');
    expect(a.peerSeesUs).toBe(false);
  }, 30000);
});

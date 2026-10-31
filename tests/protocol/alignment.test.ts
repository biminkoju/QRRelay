import { describe, expect, it } from 'vitest';
import {
  applyPeerBeacon,
  deriveCalibrationId,
  initialState,
  leads,
  localBeacon,
} from '../../src/protocol/alignment';

const local = { appVersion: '0.1.0', buildId: 't', protocolVersions: [1], capabilities: ['reliable'] };
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

function beacon(nonce: string, seen: string | null) {
  return { ...local, nonce, seen };
}

describe('calibration id derivation', () => {
  it('is order-independent', async () => {
    expect(await deriveCalibrationId(A, B)).toBe(await deriveCalibrationId(B, A));
  });

  it('produces 32 hex characters', async () => {
    expect(await deriveCalibrationId(A, B)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs for different nonce pairs', async () => {
    expect(await deriveCalibrationId(A, B)).not.toBe(await deriveCalibrationId(A, 'c'.repeat(32)));
  });
});

describe('leader election', () => {
  it('gives leadership to the numerically larger nonce', () => {
    expect(leads('ff'.repeat(16), '00'.repeat(16))).toBe(true);
    expect(leads('00'.repeat(16), 'ff'.repeat(16))).toBe(false);
  });
});

describe('alignment state machine', () => {
  it('starts aligning with no peer information', () => {
    const state = initialState(A);
    expect(state.phase).toBe('aligning');
    expect(state.peerSeen).toBe(false);
    expect(state.peerSeesUs).toBe(false);
    expect(state.calId).toBeNull();
  });

  it('reports peer-seen without claiming link-up', async () => {
    const result = await applyPeerBeacon(initialState(A), beacon(B, null));
    expect(result.state.peerSeen).toBe(true);
    expect(result.state.peerSeesUs).toBe(false);
    expect(result.state.phase).toBe('aligning');
    expect(result.events.map((e) => e.kind)).toEqual(['peer-seen']);
  });

  it('reaches link-up only when the peer acknowledges our nonce', async () => {
    const first = await applyPeerBeacon(initialState(A), beacon(B, null));
    const second = await applyPeerBeacon(first.state, beacon(B, A));
    expect(second.state.phase).toBe('link-up');
    expect(second.state.peerSeesUs).toBe(true);
    expect(second.state.calId).toBe(await deriveCalibrationId(A, B));
    expect(second.state.leader).toBe(false);
    expect(second.events.map((e) => e.kind)).toEqual(['peer-sees-us', 'link-up']);
  });

  it('ignores its own beacon echoed back', async () => {
    const state = initialState(A);
    const result = await applyPeerBeacon(state, beacon(A, null));
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it('resets peer-sees-us when the peer nonce changes', async () => {
    const first = await applyPeerBeacon(initialState(A), beacon(B, A));
    const restarted = await applyPeerBeacon(first.state, beacon('c'.repeat(32), null));
    expect(restarted.state.peerSeen).toBe(true);
    expect(restarted.state.peerSeesUs).toBe(false);
  });

  it('emits no duplicate link-up events', async () => {
    const first = await applyPeerBeacon(initialState(A), beacon(B, A));
    const again = await applyPeerBeacon(first.state, beacon(B, A));
    expect(again.events).toEqual([]);
  });

  it('builds a local beacon that echoes the peer nonce', async () => {
    const first = await applyPeerBeacon(initialState(A), beacon(B, null));
    const out = localBeacon(first.state, local);
    expect(out.nonce).toBe(A);
    expect(out.seen).toBe(B);
    expect(out.capabilities).toEqual(['reliable']);
  });
});

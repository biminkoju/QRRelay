import type { BeaconPayload } from './messageTypes';
import { toHex } from './session';

/**
 * Optical alignment and calibration-id derivation.
 *
 * Both devices display CAL_BEACON frames and scan each other's. The link is
 * only considered bidirectional once each side has seen a beacon that
 * acknowledges its own nonce. Everything here is pure and testable; no camera
 * or DOM is involved.
 */

export const CALIBRATION_SESSION_ID = '0'.repeat(32);

export type AlignmentPhase = 'aligning' | 'link-up';

export interface AlignmentState {
  phase: AlignmentPhase;
  /** This device's nonce, 32 lowercase hex characters. */
  readonly nonce: string;
  /** Peer nonce as most recently observed, or null. */
  peerNonce: string | null;
  /** True once a peer beacon has been seen at all. */
  peerSeen: boolean;
  /** True once a peer beacon acknowledged our nonce. */
  peerSeesUs: boolean;
  /** Derived calibration id, present only once link-up. */
  calId: string | null;
  /** True when this device leads the first directional probe phase. */
  leader: boolean;
  peerInfo: { appVersion: string; buildId: string; protocolVersions: number[] } | null;
}

export interface AlignmentEvent {
  kind: 'phase' | 'peer-seen' | 'peer-sees-us' | 'link-up' | 'reset';
  message: string;
  state: AlignmentState;
}

/**
 * Derives the calibration id exactly as specified: the first 16 bytes of
 * SHA-256 over the smaller nonce followed by the larger nonce, compared as
 * 16-byte unsigned big-endian values (equivalently, as lowercase hex strings
 * of equal length).
 */
export async function deriveCalibrationId(a: string, b: string): Promise<string> {
  const [first, second] = a <= b ? [a, b] : [b, a];
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(first.slice(i * 2, i * 2 + 2), 16);
    bytes[16 + i] = Number.parseInt(second.slice(i * 2, i * 2 + 2), 16);
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return toHex(new Uint8Array(digest).slice(0, 16));
}

/** The device with the numerically larger nonce leads the first probe phase. */
export function leads(localNonce: string, peerNonce: string): boolean {
  return localNonce > peerNonce;
}

export function initialState(nonce: string): AlignmentState {
  return {
    phase: 'aligning',
    nonce,
    peerNonce: null,
    peerSeen: false,
    peerSeesUs: false,
    calId: null,
    leader: false,
    peerInfo: null,
  };
}

/**
 * Processes one decoded peer beacon. Stale or self-referential beacons are
 * ignored rather than mutating state.
 */
export async function applyPeerBeacon(
  state: AlignmentState,
  beacon: BeaconPayload,
): Promise<{ state: AlignmentState; events: AlignmentEvent[] }> {
  const events: AlignmentEvent[] = [];
  let next: AlignmentState = { ...state };

  if (beacon.nonce === state.nonce) {
    return { state, events };
  }

  // A peer nonce can change if the peer restarts; accept the newest beacon.
  if (next.peerNonce !== beacon.nonce) {
    next.peerNonce = beacon.nonce;
    next.peerSeesUs = false;
    next.peerInfo = {
      appVersion: beacon.appVersion,
      buildId: beacon.buildId,
      protocolVersions: beacon.protocolVersions,
    };
    if (!next.peerSeen) {
      next.peerSeen = true;
      events.push({ kind: 'peer-seen', message: 'I can see the peer', state: next });
    }
  }

  if (beacon.seen === state.nonce && !next.peerSeesUs) {
    next.peerSeesUs = true;
    events.push({ kind: 'peer-sees-us', message: 'The peer can see me', state: next });
  }

  if (next.peerSeen && next.peerSeesUs && next.phase !== 'link-up' && next.peerNonce) {
    next.calId = await deriveCalibrationId(next.nonce, next.peerNonce);
    next.leader = leads(next.nonce, next.peerNonce);
    next.phase = 'link-up';
    events.push({ kind: 'link-up', message: 'Link up (both directions)', state: next });
  }

  return { state: next, events };
}

/** The beacon this device should currently display. */
export function localBeacon(
  state: AlignmentState,
  local: { appVersion: string; buildId: string; protocolVersions: number[]; capabilities: string[] },
): BeaconPayload {
  return {
    appVersion: local.appVersion,
    buildId: local.buildId,
    protocolVersions: local.protocolVersions,
    capabilities: local.capabilities,
    nonce: state.nonce,
    seen: state.peerNonce,
  };
}

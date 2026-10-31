/** Typed payload schemas for QRF1 frames. Runtime validation is mandatory:
 *  TypeScript types alone never validate data arriving from a camera. */

import { base64UrlDecode } from './bytes';

export const MESSAGE_TYPES = [
  'CAL_BEACON',
  'CAL_PROBE',
  'CAL_PROBE_RESULT',
  'CAL_RATE_START',
  'CAL_RATE_FRAME',
  'CAL_RATE_RESULT',
  'CAL_PING',
  'CAL_PONG',
  'HELLO',
  'READY',
  'META',
  'META_ACCEPT',
  'DATA',
  'ACK',
  'NACK',
  'END',
  'COMPLETE',
  'FIN',
  'ABORT',
  'ERROR',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export function isMessageType(value: string): value is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Calibration frames are the only ones that may use the all-zero session id. */
export function isCalibrationType(value: string): boolean {
  return value.startsWith('CAL_');
}

/** Message types whose payload is raw bytes rather than JSON. */
export const BINARY_PAYLOAD_TYPES: readonly MessageType[] = ['DATA'];

// ---------------------------------------------------------- calibration

/** QR error-correction levels, ordered from weakest to strongest. */
export type CalibrationEcc = 'L' | 'M' | 'Q' | 'H';

/** One directional capacity probe from the leader. Carries its own filler. */
export interface CalProbePayload {
  step: number;
  total: number;
  probeId: number;
  bytes: number;
  ecl: CalibrationEcc;
  /** base64url of exactly `bytes` bytes derived from the calibration id. */
  filler: string;
}

export interface CalProbeResultPayload {
  step: number;
  ok: boolean;
  observedBytes: number;
}

export interface CalRateStartPayload {
  burstId: number;
  frames: number;
  bytes: number;
}

export interface CalRateFramePayload {
  burstId: number;
  index: number;
  filler: string;
}

export interface CalRateResultPayload {
  burstId: number;
  received: number;
  frames: number;
  elapsedMs: number;
}

/** t0/t1 are the sender's monotonic clock readings, in milliseconds. */
export interface CalPingPayload {
  pingId: number;
  t0: number;
}

export interface CalPongPayload {
  pingId: number;
  t0: number;
  t1: number;
}

// ---------------------------------------------------------------- validation

export class PayloadError extends Error {
  override name = 'PayloadError';
}

function fail(message: string): never {
  throw new PayloadError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(field + ' must be an integer');
  if (value < min || value > max) fail(field + ' out of range');
  return value;
}

function string(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') fail(field + ' must be a string');
  if (value.length > maxLength) fail(field + ' too long');
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field + ' must be a boolean');
  return value;
}

function stringArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value)) fail(field + ' must be an array');
  if (value.length > maxItems) fail(field + ' has too many items');
  return value.map((item, i) => string(item, field + '[' + i + ']', 64));
}

export interface PeerInfo {
  appVersion: string;
  buildId: string;
  protocolVersions: number[];
  capabilities: string[];
}

/** CAL_BEACON payload. Uses the all-zero session id; carries no file data. */
export interface BeaconPayload extends PeerInfo {
  /** This device's fresh 128-bit nonce, 32 lowercase hex characters. */
  nonce: string;
  /** The peer nonce this beacon acknowledges, or null on the first beacon. */
  seen: string | null;
}

export interface HelloPayload extends PeerInfo {
  transferModes: string[];
}

export interface ReadyPayload {
  accepted: boolean;
  protocolVersion: number;
  capabilities: string[];
  transferMode: string;
  reason?: string;
}

export interface MetaPayload {
  name: string;
  kind: 'file';
  size: number;
  sha256: string;
  encoding: 'identity';
  transferSize: number;
  transferMode: 'reliable';
  chunkSize: number;
  totalChunks: number;
}

export interface AckPayload {
  nextExpected: number;
}

export interface NackPayload {
  nextExpected: number;
  reason: 'missing' | 'out-of-order';
}

export interface EndPayload {
  totalChunks: number;
  size: number;
  sha256: string;
}

export interface CompletePayload {
  size: number;
  sha256: string;
}

export interface AbortPayload {
  reason: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export type JsonPayload =
  | BeaconPayload
  | CalProbePayload
  | CalProbeResultPayload
  | CalRateStartPayload
  | CalRateFramePayload
  | CalRateResultPayload
  | CalPingPayload
  | CalPongPayload
  | HelloPayload
  | ReadyPayload
  | MetaPayload
  | AckPayload
  | NackPayload
  | EndPayload
  | CompletePayload
  | AbortPayload
  | ErrorPayload
  | Record<string, never>;

const NONCE_RE = /^[0-9a-f]{32}$/;

export function validatePeerInfo(value: unknown): PeerInfo {
  if (!isRecord(value)) fail('peer info must be an object');
  const versions = value.protocolVersions;
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 16) {
    fail('protocolVersions must be a non-empty array');
  }
  return {
    appVersion: string(value.appVersion, 'appVersion', 64),
    buildId: string(value.buildId, 'buildId', 128),
    protocolVersions: versions.map((v, i) => integer(v, 'protocolVersions[' + i + ']', 1, 1000)),
    capabilities: stringArray(value.capabilities, 'capabilities', 32),
  };
}

export function validateBeacon(value: unknown): BeaconPayload {
  const peer = validatePeerInfo(value);
  const record = value as Record<string, unknown>;
  const nonce = string(record.nonce, 'nonce', 32);
  if (!NONCE_RE.test(nonce)) fail('nonce must be 32 lowercase hex characters');
  let seen: string | null;
  if (record.seen === null || record.seen === undefined) {
    seen = null;
  } else {
    seen = string(record.seen, 'seen', 32);
    if (!NONCE_RE.test(seen)) fail('seen must be 32 lowercase hex characters or null');
  }
  return { ...peer, nonce, seen };
}

export function validateHello(value: unknown): HelloPayload {
  const peer = validatePeerInfo(value);
  const record = value as Record<string, unknown>;
  return { ...peer, transferModes: stringArray(record.transferModes, 'transferModes', 8) };
}

export function validateReady(value: unknown): ReadyPayload {
  if (!isRecord(value)) fail('READY payload must be an object');
  const reason = value.reason === undefined ? undefined : string(value.reason, 'reason', 200);
  return {
    accepted: boolean(value.accepted, 'accepted'),
    protocolVersion: integer(value.protocolVersion, 'protocolVersion', 1, 1000),
    capabilities: stringArray(value.capabilities, 'capabilities', 32),
    transferMode: string(value.transferMode, 'transferMode', 32),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function validateMeta(value: unknown): MetaPayload {
  if (!isRecord(value)) fail('META payload must be an object');
  if (value.kind !== 'file') fail('unsupported META kind');
  if (value.encoding !== 'identity') fail('unsupported META encoding');
  if (value.transferMode !== 'reliable') fail('unsupported META transfer mode');
  const sha256 = string(value.sha256, 'sha256', 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail('sha256 must be 64 lowercase hex characters');
  const size = integer(value.size, 'size', 0, Number.MAX_SAFE_INTEGER);
  const chunkSize = integer(value.chunkSize, 'chunkSize', 1, 65535);
  const totalChunks = integer(value.totalChunks, 'totalChunks', 0, 0xffffffff);
  const transferSize = integer(value.transferSize, 'transferSize', 0, Number.MAX_SAFE_INTEGER);
  if (totalChunks !== Math.ceil(size / chunkSize)) fail('totalChunks does not match size/chunkSize');
  if (transferSize !== size) fail('transferSize must equal size for identity encoding');
  return {
    name: string(value.name, 'name', 255),
    kind: 'file',
    size,
    sha256,
    encoding: 'identity',
    transferSize,
    transferMode: 'reliable',
    chunkSize,
    totalChunks,
  };
}

export function validateAck(value: unknown): AckPayload {
  if (!isRecord(value)) fail('ACK payload must be an object');
  return { nextExpected: integer(value.nextExpected, 'nextExpected', 0, 0xffffffff) };
}

export function validateNack(value: unknown): NackPayload {
  if (!isRecord(value)) fail('NACK payload must be an object');
  const reason = value.reason;
  if (reason !== 'missing' && reason !== 'out-of-order') fail('invalid NACK reason');
  return { nextExpected: integer(value.nextExpected, 'nextExpected', 0, 0xffffffff), reason };
}

export function validateEnd(value: unknown): EndPayload {
  if (!isRecord(value)) fail('END payload must be an object');
  const sha256 = string(value.sha256, 'sha256', 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail('sha256 must be 64 lowercase hex characters');
  return {
    totalChunks: integer(value.totalChunks, 'totalChunks', 0, 0xffffffff),
    size: integer(value.size, 'size', 0, Number.MAX_SAFE_INTEGER),
    sha256,
  };
}

export function validateComplete(value: unknown): CompletePayload {
  if (!isRecord(value)) fail('COMPLETE payload must be an object');
  const sha256 = string(value.sha256, 'sha256', 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail('sha256 must be 64 lowercase hex characters');
  return { size: integer(value.size, 'size', 0, Number.MAX_SAFE_INTEGER), sha256 };
}

export function validateAbort(value: unknown): AbortPayload {
  if (!isRecord(value)) fail('ABORT payload must be an object');
  return { reason: string(value.reason, 'reason', 200) };
}

export function validateError(value: unknown): ErrorPayload {
  if (!isRecord(value)) fail('ERROR payload must be an object');
  return {
    code: string(value.code, 'code', 64),
    message: string(value.message, 'message', 300),
  };
}

function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field + ' must be a finite number');
  if (value < min || value > max) fail(field + ' out of range');
  return value;
}

const ECC_LEVELS: readonly CalibrationEcc[] = ['L', 'M', 'Q', 'H'];

export function calibrationEcc(value: unknown): CalibrationEcc {
  if (typeof value !== 'string' || !(ECC_LEVELS as readonly string[]).includes(value)) {
    fail('ecl must be one of L, M, Q, H');
  }
  return value as CalibrationEcc;
}

function base64UrlString(value: unknown, field: string, maxLength: number): string {
  const text = string(value, field, maxLength);
  if (!/^[A-Za-z0-9_-]*$/.test(text)) fail(field + ' must be base64url without padding');
  return text;
}

/** Maximum filler bytes a single calibration frame may carry. */
export const MAX_CAL_FILLER_BYTES = 1024;

export function validateCalProbe(value: unknown): CalProbePayload {
  if (!isRecord(value)) fail('CAL_PROBE payload must be an object');
  const bytes = integer(value.bytes, 'bytes', 1, MAX_CAL_FILLER_BYTES);
  const filler = base64UrlString(value.filler, 'filler', 2048);
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(filler);
  } catch {
    return fail('filler is not valid base64url');
  }
  if (decoded.length !== bytes) fail('filler length does not match bytes');
  return {
    step: integer(value.step, 'step', 0, 63),
    total: integer(value.total, 'total', 1, 64),
    probeId: integer(value.probeId, 'probeId', 0, 0xffffffff),
    bytes,
    ecl: calibrationEcc(value.ecl),
    filler,
  };
}

export function validateCalProbeResult(value: unknown): CalProbeResultPayload {
  if (!isRecord(value)) fail('CAL_PROBE_RESULT payload must be an object');
  return {
    step: integer(value.step, 'step', 0, 63),
    ok: boolean(value.ok, 'ok'),
    observedBytes: integer(value.observedBytes, 'observedBytes', 0, MAX_CAL_FILLER_BYTES),
  };
}

export function validateCalRateStart(value: unknown): CalRateStartPayload {
  if (!isRecord(value)) fail('CAL_RATE_START payload must be an object');
  return {
    burstId: integer(value.burstId, 'burstId', 0, 0xffffffff),
    frames: integer(value.frames, 'frames', 1, 64),
    bytes: integer(value.bytes, 'bytes', 1, MAX_CAL_FILLER_BYTES),
  };
}

export function validateCalRateFrame(value: unknown): CalRateFramePayload {
  if (!isRecord(value)) fail('CAL_RATE_FRAME payload must be an object');
  const filler = base64UrlString(value.filler, 'filler', 2048);
  try {
    base64UrlDecode(filler);
  } catch {
    return fail('filler is not valid base64url');
  }
  return {
    burstId: integer(value.burstId, 'burstId', 0, 0xffffffff),
    index: integer(value.index, 'index', 0, 63),
    filler,
  };
}

export function validateCalRateResult(value: unknown): CalRateResultPayload {
  if (!isRecord(value)) fail('CAL_RATE_RESULT payload must be an object');
  return {
    burstId: integer(value.burstId, 'burstId', 0, 0xffffffff),
    received: integer(value.received, 'received', 0, 64),
    frames: integer(value.frames, 'frames', 1, 64),
    elapsedMs: finiteNumber(value.elapsedMs, 'elapsedMs', 0, 600000),
  };
}

export function validateCalPing(value: unknown): CalPingPayload {
  if (!isRecord(value)) fail('CAL_PING payload must be an object');
  return {
    pingId: integer(value.pingId, 'pingId', 0, 0xffffffff),
    t0: finiteNumber(value.t0, 't0', 0, Number.MAX_SAFE_INTEGER),
  };
}

export function validateCalPong(value: unknown): CalPongPayload {
  if (!isRecord(value)) fail('CAL_PONG payload must be an object');
  return {
    pingId: integer(value.pingId, 'pingId', 0, 0xffffffff),
    t0: finiteNumber(value.t0, 't0', 0, Number.MAX_SAFE_INTEGER),
    t1: finiteNumber(value.t1, 't1', 0, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeJsonPayload(type: MessageType, bytes: Uint8Array): JsonPayload {
  if (bytes.length > 4096) fail('JSON payload exceeds 4096 bytes');
  // META_ACCEPT and FIN are bare control frames with no payload body.
  if (bytes.length === 0 && (type === 'META_ACCEPT' || type === 'FIN')) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('payload is not valid UTF-8 JSON');
  }
  switch (type) {
    case 'CAL_BEACON':
      return validateBeacon(parsed);
    case 'CAL_PROBE':
      return validateCalProbe(parsed);
    case 'CAL_PROBE_RESULT':
      return validateCalProbeResult(parsed);
    case 'CAL_RATE_START':
      return validateCalRateStart(parsed);
    case 'CAL_RATE_FRAME':
      return validateCalRateFrame(parsed);
    case 'CAL_RATE_RESULT':
      return validateCalRateResult(parsed);
    case 'CAL_PING':
      return validateCalPing(parsed);
    case 'CAL_PONG':
      return validateCalPong(parsed);
    case 'HELLO':
      return validateHello(parsed);
    case 'READY':
      return validateReady(parsed);
    case 'META':
      return validateMeta(parsed);
    case 'ACK':
      return validateAck(parsed);
    case 'NACK':
      return validateNack(parsed);
    case 'END':
      return validateEnd(parsed);
    case 'COMPLETE':
      return validateComplete(parsed);
    case 'ABORT':
      return validateAbort(parsed);
    case 'ERROR':
      return validateError(parsed);
    case 'META_ACCEPT':
    case 'FIN':
      return {};
    case 'DATA':
      return fail('DATA payload is binary, not JSON');
  }
}

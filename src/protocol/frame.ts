import { base64UrlDecode, base64UrlEncode, concatBytes, hexToBytes, u32be, utf8 } from './bytes';
import { crc32Hex } from './checksum';
import {
  BINARY_PAYLOAD_TYPES,
  decodeJsonPayload,
  isMessageType,
  type JsonPayload,
  type MessageType,
} from './messageTypes';
import { isZeroSessionId, isValidSessionId } from './session';
import { isCalibrationType } from './messageTypes';

/** QRF1 wire envelope: QRF1|TYPE|SESSION_ID|SEQUENCE|PAYLOAD_BASE64URL|CRC32 */
export const FRAME_MAGIC = 'QRF1';
export const MAX_SEQUENCE = 0xffffffff;
export const MAX_PAYLOAD_BYTES = 4096;

export interface Frame {
  type: MessageType;
  sessionId: string;
  sequence: number;
  payload: Uint8Array;
}

/** A frame that passed envelope, field and CRC validation, with payload typed. */
export interface ValidatedFrame {
  type: MessageType;
  sessionId: string;
  sequence: number;
  payload: Uint8Array;
  json: JsonPayload | null;
}

export class FrameError extends Error {
  override name = 'FrameError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** CRC input is defined byte-by-byte; never a JSON or string concatenation. */
export function crcInput(frame: Frame): Uint8Array {
  return concatBytes(
    utf8(FRAME_MAGIC),
    new Uint8Array([0]),
    utf8(frame.type),
    new Uint8Array([0]),
    hexToBytes(frame.sessionId),
    new Uint8Array([0]),
    u32be(frame.sequence),
    new Uint8Array([0]),
    frame.payload,
  );
}

export function encodeFrame(frame: Frame): string {
  if (!isMessageType(frame.type)) throw new FrameError('BAD_TYPE', 'unsupported message type');
  if (!isValidSessionId(frame.sessionId)) throw new FrameError('BAD_SESSION', 'session id must be 32 lowercase hex chars');
  if (isZeroSessionId(frame.sessionId) && !isCalibrationType(frame.type)) {
    throw new FrameError('BAD_SESSION', 'all-zero session id is only valid for calibration frames');
  }
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > MAX_SEQUENCE) {
    throw new FrameError('BAD_SEQUENCE', 'sequence out of range');
  }
  if (frame.payload.length > MAX_PAYLOAD_BYTES) throw new FrameError('BAD_PAYLOAD', 'payload too large');
  return [
    FRAME_MAGIC,
    frame.type,
    frame.sessionId,
    String(frame.sequence),
    base64UrlEncode(frame.payload),
    crc32Hex(crcInput(frame)),
  ].join('|');
}

/**
 * Validation order is deliberate: field count, magic, type, session syntax,
 * sequence range, Base64URL validity and size, then CRC, then typed payload.
 * Nothing reaches state-machine code unless every step passed.
 */
export function decodeFrame(text: string): ValidatedFrame {
  const fields = text.split('|');
  if (fields.length !== 6) throw new FrameError('BAD_ENVELOPE', 'expected 6 pipe-separated fields');
  const [magic, typeText, sessionId, sequenceText, payloadText, crcText] = fields;
  if (magic !== FRAME_MAGIC) throw new FrameError('BAD_MAGIC', 'unexpected frame magic');
  if (!isMessageType(typeText)) throw new FrameError('BAD_TYPE', 'unsupported message type');
  if (!isValidSessionId(sessionId)) throw new FrameError('BAD_SESSION', 'invalid session id syntax');
  if (isZeroSessionId(sessionId) && !isCalibrationType(typeText)) {
    throw new FrameError('BAD_SESSION', 'all-zero session id is only valid for calibration frames');
  }
  if (!/^[0-9]+$/.test(sequenceText)) throw new FrameError('BAD_SEQUENCE', 'sequence must be unsigned decimal');
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence) || sequence > MAX_SEQUENCE) {
    throw new FrameError('BAD_SEQUENCE', 'sequence out of range');
  }
  let payload: Uint8Array;
  try {
    payload = base64UrlDecode(payloadText);
  } catch {
    throw new FrameError('BAD_PAYLOAD', 'invalid base64url payload');
  }
  if (payload.length > MAX_PAYLOAD_BYTES) throw new FrameError('BAD_PAYLOAD', 'payload too large');
  if (!/^[0-9a-f]{8}$/.test(crcText)) throw new FrameError('BAD_CRC', 'CRC must be 8 lowercase hex chars');
  const expected = crc32Hex(crcInput({ type: typeText, sessionId, sequence, payload }));
  if (crcText !== expected) throw new FrameError('BAD_CRC', 'CRC mismatch');

  let json: JsonPayload | null = null;
  if (!BINARY_PAYLOAD_TYPES.includes(typeText)) {
    try {
      json = decodeJsonPayload(typeText, payload);
    } catch (error) {
      throw new FrameError('BAD_PAYLOAD', 'invalid payload: ' + (error as Error).message);
    }
  }
  return { type: typeText, sessionId, sequence, payload, json };
}

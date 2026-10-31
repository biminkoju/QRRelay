import { describe, expect, it } from 'vitest';
import { TransferSession } from '../../src/transfer/session';
import { sourceFromBytes } from '../../src/transfer/source';
import { sha256Hex } from '../../src/transfer/hash';
import { decodeFrame, type ValidatedFrame } from '../../src/protocol/frame';
import { DEFAULT_CONFIG } from '../../src/protocol/constants';
import { simulateCapture, DEFAULT_CHANNEL } from '../../src/sim/channel';

const LOCAL = { appVersion: '0.1.0', buildId: 'test', protocolVersions: [1], capabilities: ['reliable'] };
const SESSION = 'ab'.repeat(16);

/**
 * Delivers a frame through a real QR image, the same way the optical link
 * does. A frame the decoder cannot read is a frame that never arrived.
 */
function throughQr(text: string): ValidatedFrame | null {
  const shot = simulateCapture(text, 'M', { ...DEFAULT_CHANNEL, modulePx: 8, captureWidth: 2400 });
  if (shot.decoded === null) return null;
  try {
    return decodeFrame(shot.decoded);
  } catch {
    return null;
  }
}

/** Runs both sessions against each other over the simulated optical hop. */
async function runTransfer(bytes: Uint8Array, chunkSize: number) {
  const sha = await sha256Hex(bytes);
  const source = sourceFromBytes('payload.bin', bytes, sha);
  const config = { ...DEFAULT_CONFIG, chunkSize, ackTimeoutMs: 4000, maxRetries: 4 };
  const sender = new TransferSession({ role: 'sender', sessionId: SESSION, config, local: LOCAL, source });
  const receiver = new TransferSession({ role: 'receiver', sessionId: SESSION, config, local: LOCAL });
  sender.start();
  receiver.start();

  const delivered = new Map<TransferSession, string>();
  let now = 0;
  let dropped = 0;

  for (let step = 0; step < 4000; step++) {
    if (sender.currentPhase === 'finished' && receiver.currentPhase === 'finished') break;
    now += 250;
    for (const [from, to] of [[sender, receiver], [receiver, sender]] as const) {
      const text = from.currentFrame();
      if (text === null) continue;
      if (delivered.get(to) === text) continue;
      delivered.set(to, text);
      const frame = throughQr(text);
      if (frame === null) {
        dropped++;
        continue;
      }
      await to.onFrame(frame);
    }
    sender.tick();
  }
  return { sender, receiver, dropped, sha };
}

describe('reliable transfer over a real optical channel', () => {
  it('delivers a small file byte-for-byte', async () => {
    const bytes = new TextEncoder().encode('hello QRRelay, this crossed a QR code');
    const { sender, receiver, sha } = await runTransfer(bytes, 64);
    expect(sender.result?.outcome).toBe('confirmed');
    const result = receiver.result;
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('verified');
    expect(result!.receivedName).toBe('payload.bin');
    expect(result!.receivedBytes).not.toBeNull();
    expect(Array.from(result!.receivedBytes!)).toEqual(Array.from(bytes));
    expect(result!.receivedSha256).toBe(sha);
  }, 180000);

  it('delivers a multi-chunk file and counts every chunk', async () => {
    const bytes = new Uint8Array(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const { receiver, sha } = await runTransfer(bytes, 64);
    const result = receiver.result;
    expect(result!.outcome).toBe('verified');
    expect(result!.totalChunks).toBe(Math.ceil(bytes.length / 64));
    expect(Array.from(result!.receivedBytes!)).toEqual(Array.from(bytes));
    expect(result!.receivedSha256).toBe(sha);
  }, 300000);
});

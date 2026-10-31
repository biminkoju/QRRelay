import { describe, expect, it } from 'vitest';
import { Sender } from '../../src/protocol/sender';
import { decodeFrame, encodeFrame } from '../../src/protocol/frame';
import { DEFAULT_CONFIG } from '../../src/protocol/constants';
import { sourceFromBytes } from '../../src/transfer/source';

const sid = 'a'.repeat(32);
const sha = 'b'.repeat(64);

function makeSender(now: { t: number }) {
  return new Sender({
    sessionId: sid,
    source: sourceFromBytes('x.bin', new Uint8Array([1, 2, 3, 4]), sha),
    config: { ...DEFAULT_CONFIG, chunkSize: 2, ackTimeoutMs: 1000, maxRetries: 3 },
    hello: { appVersion: '0.1.0', buildId: 't', protocolVersions: [1], capabilities: [], transferModes: ['reliable'] },
    clock: { now: () => now.t },
  });
}

/** Feed the sender a frame produced by another endpoint. */
async function feed(sender: Sender, type: 'READY' | 'META_ACCEPT' | 'ACK' | 'NACK' | 'COMPLETE', json: unknown, sequence = 0) {
  const text = encodeFrame({ type, sessionId: sid, sequence, payload: new TextEncoder().encode(JSON.stringify(json)) });
  return sender.onFrame(decodeFrame(text));
}

const ready = { accepted: true, protocolVersion: 1, capabilities: [], transferMode: 'reliable' };

async function reachSendingData(now: { t: number }) {
  const sender = makeSender(now);
  sender.start();
  await feed(sender, 'READY', ready);
  await feed(sender, 'META_ACCEPT', {});
  return sender;
}

describe('sender reliable mode', () => {
  it('does not advance without an ACK', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    expect(sender.ackedChunks).toBe(0);
    expect(sender.currentPhase).toBe('sending-data');
  });

  it('retransmits the same chunk after the ACK timeout', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    now.t = 1001;
    const tick = sender.onTick();
    expect(tick.outbound).toHaveLength(1);
    expect(tick.outbound[0].type).toBe('DATA');
    expect(tick.outbound[0].sequence).toBe(0);
    expect(sender.retryCount).toBe(1);
  });

  it('fails after maxRetries consecutive timeouts instead of claiming success', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    for (let i = 0; i < 4; i++) {
      now.t += 1001;
      sender.onTick();
    }
    expect(sender.currentPhase).toBe('failed');
    expect(sender.ackedChunks).toBe(0);
  });

  it('retransmits on a NACK for the in-flight chunk', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    const outcome = await feed(sender, 'NACK', { nextExpected: 0, reason: 'missing' });
    expect(outcome.outbound).toHaveLength(1);
    expect(outcome.outbound[0].type).toBe('DATA');
    expect(outcome.outbound[0].sequence).toBe(0);
  });

  it('ignores a stale ACK without advancing', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    const outcome = await feed(sender, 'ACK', { nextExpected: 0 });
    expect(outcome.outbound).toHaveLength(0);
    expect(sender.ackedChunks).toBe(0);
  });

  it('rejects an ACK that skips ahead', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    await feed(sender, 'ACK', { nextExpected: 2 });
    expect(sender.currentPhase).toBe('failed');
  });

  it('ends with Unconfirmed when COMPLETE is never seen', async () => {
    const now = { t: 0 };
    const sender = await reachSendingData(now);
    await feed(sender, 'ACK', { nextExpected: 1 });
    await feed(sender, 'ACK', { nextExpected: 2 });
    expect(sender.currentPhase).toBe('waiting-complete');
    for (let i = 0; i < 4; i++) {
      now.t += 1001;
      sender.onTick();
    }
    expect(sender.currentPhase).toBe('unconfirmed');
  });
});

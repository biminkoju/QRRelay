import { describe, expect, it } from 'vitest';
import { Receiver } from '../../src/protocol/receiver';
import { decodeFrame, encodeFrame } from '../../src/protocol/frame';
import { DEFAULT_CONFIG } from '../../src/protocol/constants';
import { InMemoryReceiverStorage } from '../../src/transfer/receiverStorage';
import { sha256Hex } from '../../src/transfer/hash';

const sid = 'c'.repeat(32);
const local = { appVersion: '0.1.0', buildId: 't', protocolVersions: [1], capabilities: [] };

async function makeReceiver(storage = new InMemoryReceiverStorage()) {
  return { receiver: new Receiver({ sessionId: sid, config: { ...DEFAULT_CONFIG, chunkSize: 3 }, storage, local }), storage };
}

async function feed(receiver: Receiver, type: string, json: unknown | null, payload: Uint8Array = new Uint8Array(0), sequence = 0) {
  const body = json === null ? payload : new TextEncoder().encode(JSON.stringify(json));
  const text = encodeFrame({ type: type as 'READY', sessionId: sid, sequence, payload: body });
  return receiver.onFrame(decodeFrame(text));
}

const hello = { appVersion: '0.1.0', buildId: 't', protocolVersions: [1], capabilities: [], transferModes: ['reliable'] };

async function reachReceiving() {
  const { receiver, storage } = await makeReceiver();
  await feed(receiver, 'HELLO', hello);
  const body = new Uint8Array([0, 1, 2, 3, 4, 5, 6]);
  const sha = await sha256Hex(body);
  await feed(receiver, 'META', {
    name: 'x.bin', kind: 'file', size: 7, sha256: sha, encoding: 'identity',
    transferSize: 7, transferMode: 'reliable', chunkSize: 3, totalChunks: 3,
  });
  return { receiver, storage, body, sha };
}

describe('receiver reliable mode', () => {
  it('acks and stores a chunk at nextExpected', async () => {
    const { receiver, storage } = await reachReceiving();
    const out = await feed(receiver, 'DATA', null, new Uint8Array([0, 1, 2]), 0);
    expect(storage.committedChunks).toBe(1);
    expect(out.outbound[0].type).toBe('ACK');
  });

  it('does not store a duplicate chunk twice and re-sends the ACK', async () => {
    const { receiver, storage } = await reachReceiving();
    await feed(receiver, 'DATA', null, new Uint8Array([0, 1, 2]), 0);
    const out = await feed(receiver, 'DATA', null, new Uint8Array([0, 1, 2]), 0);
    expect(storage.committedChunks).toBe(1);
    expect(out.outbound[0].type).toBe('ACK');
  });

  it('sends NACK for an out-of-order chunk without storing it', async () => {
    const { receiver, storage } = await reachReceiving();
    const out = await feed(receiver, 'DATA', null, new Uint8Array([3, 4, 5]), 1);
    expect(storage.committedChunks).toBe(0);
    expect(out.outbound[0].type).toBe('NACK');
  });

  it('rejects END whose hash differs from META', async () => {
    const { receiver } = await reachReceiving();
    const out = await feed(receiver, 'END', { totalChunks: 3, size: 7, sha256: 'd'.repeat(64) });
    expect(receiver.currentPhase).toBe('failed');
    expect(out.outbound[0].type).toBe('ERROR');
  });

  it('verifies and reports COMPLETE when bytes match', async () => {
    const { receiver, sha } = await reachReceiving();
    await feed(receiver, 'DATA', null, new Uint8Array([0, 1, 2]), 0);
    await feed(receiver, 'DATA', null, new Uint8Array([3, 4, 5]), 1);
    await feed(receiver, 'DATA', null, new Uint8Array([6]), 2);
    const out = await feed(receiver, 'END', { totalChunks: 3, size: 7, sha256: sha });
    expect(receiver.finalStatus).toBe('verified');
    expect(out.outbound[0].type).toBe('COMPLETE');
  });
});

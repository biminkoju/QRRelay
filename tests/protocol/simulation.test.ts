import { describe, expect, it } from 'vitest';
import { runSimulation, deterministicRandomBytes } from '../../src/protocol/simulation';
import { newSessionId } from '../../src/protocol/session';
import { sourceFromBytes } from '../../src/transfer/source';
import { InMemoryReceiverStorage } from '../../src/transfer/receiverStorage';
import { sha256Hex } from '../../src/transfer/hash';

function bytesFromSeed(seed: number, length: number): Uint8Array {
  return deterministicRandomBytes(seed)(length);
}

async function transfer(bytes: Uint8Array, channel = {}, seed = 7) {
  const sha = await sha256Hex(bytes);
  const storage = new InMemoryReceiverStorage();
  const result = await runSimulation({
    source: sourceFromBytes('fixture.bin', bytes, sha),
    sessionId: newSessionId(deterministicRandomBytes(seed + 100)),
    storage,
    forward: channel,
    reverse: channel,
    seed,
  });
  return { result, storage, sha };
}

describe('reliable-mode simulation', () => {
  it('transfers an empty file', async () => {
    const { result, storage } = await transfer(new Uint8Array(0));
    expect(result.verified).toBe(true);
    expect(storage.committedChunks).toBe(0);
  });

  it('transfers a single byte', async () => {
    const { result, storage } = await transfer(new Uint8Array([0xab]));
    expect(result.verified).toBe(true);
    expect(storage.committedBytes).toBe(1);
  });

  it('transfers a multi-chunk file byte-exactly', async () => {
    const bytes = bytesFromSeed(1, 5000);
    const { result, storage, sha } = await transfer(bytes);
    expect(result.verified).toBe(true);
    expect(await sha256Hex(await storage.assemble())).toBe(sha);
  });

  it('survives loss, duplication, corruption and reordering', async () => {
    const bytes = bytesFromSeed(2, 3000);
    const { result, storage, sha } = await transfer(
      bytes,
      { dropRate: 0.2, duplicateRate: 0.2, corruptRate: 0.1, reorderRate: 0.2 },
      11,
    );
    expect(result.verified).toBe(true);
    expect(await sha256Hex(await storage.assemble())).toBe(sha);
  });

  it('never reports success when the channel is fully dead', async () => {
    const { result } = await transfer(bytesFromSeed(3, 1000), { dropRate: 1 });
    expect(result.verified).toBe(false);
    expect(result.senderStatus).toBe('failed');
  });
});

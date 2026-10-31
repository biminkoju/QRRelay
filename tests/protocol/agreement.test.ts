import { describe, expect, it } from 'vitest';
import { agree, isValidOffer } from '../../src/protocol/agreement';
import type { CalibrationEcc } from '../../src/protocol/messageTypes';

const LEVELS: CalibrationEcc[] = ['L', 'M', 'Q', 'H'];

describe('chunk size agreement', () => {
  it('agrees exactly when both sides measured the same size', () => {
    const r = agree({ chunkSize: 256, ecl: 'M' }, { chunkSize: 256, ecl: 'M' });
    expect(r.chunkSize).toBe(256);
    expect(r.agreedExactly).toBe(true);
    expect(r.ecl).toBe('M');
  });

  it('takes the smaller size when the sides disagree', () => {
    expect(agree({ chunkSize: 512, ecl: 'M' }, { chunkSize: 128, ecl: 'M' }).chunkSize).toBe(128);
    expect(agree({ chunkSize: 128, ecl: 'M' }, { chunkSize: 512, ecl: 'M' }).chunkSize).toBe(128);
  });

  it('reports the EC level of whichever side set the constraint', () => {
    const r = agree({ chunkSize: 512, ecl: 'Q' }, { chunkSize: 128, ecl: 'L' });
    expect(r.chunkSize).toBe(128);
    expect(r.ecl).toBe('L');
  });

  it('takes the stronger EC level on a tie, never the weaker', () => {
    expect(agree({ chunkSize: 256, ecl: 'Q' }, { chunkSize: 256, ecl: 'L' }).ecl).toBe('Q');
    expect(agree({ chunkSize: 256, ecl: 'L' }, { chunkSize: 256, ecl: 'Q' }).ecl).toBe('Q');
  });

  it('is commutative: both machines reach the same answer', () => {
    for (const localSize of [32, 64, 128, 256, 512, 1024]) {
      for (const remoteSize of [32, 64, 128, 256, 512, 1024]) {
        for (const localEcl of LEVELS) {
          for (const remoteEcl of LEVELS) {
            const fromA = agree(
              { chunkSize: localSize, ecl: localEcl },
              { chunkSize: remoteSize, ecl: remoteEcl },
            );
            const fromB = agree(
              { chunkSize: remoteSize, ecl: remoteEcl },
              { chunkSize: localSize, ecl: localEcl },
            );
            expect(fromA.chunkSize).toBe(fromB.chunkSize);
            expect(fromA.ecl).toBe(fromB.ecl);
            expect(fromA.agreedExactly).toBe(fromB.agreedExactly);
          }
        }
      }
    }
  });

  it('never agrees to more than either side measured', () => {
    const r = agree({ chunkSize: 512, ecl: 'M' }, { chunkSize: 64, ecl: 'M' });
    expect(r.chunkSize).toBeLessThanOrEqual(64);
    expect(r.chunkSize).toBeLessThanOrEqual(512);
  });

  it('rejects offers the protocol cannot express', () => {
    expect(isValidOffer({ chunkSize: 0, ecl: 'M' })).toBe(false);
    expect(isValidOffer({ chunkSize: 4097, ecl: 'M' })).toBe(false);
    expect(isValidOffer({ chunkSize: 1.5, ecl: 'M' })).toBe(false);
    expect(isValidOffer({ chunkSize: 64, ecl: 'X' as CalibrationEcc })).toBe(false);
    expect(() => agree({ chunkSize: 0, ecl: 'M' }, { chunkSize: 64, ecl: 'M' })).toThrow();
  });

  it('accepts the protocol boundaries', () => {
    expect(isValidOffer({ chunkSize: 1, ecl: 'L' })).toBe(true);
    expect(isValidOffer({ chunkSize: 4096, ecl: 'H' })).toBe(true);
  });
});

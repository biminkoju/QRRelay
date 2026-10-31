import { describe, expect, it } from 'vitest';
import { deriveCalibrationId } from '../../src/protocol/alignment';
import { isValidSessionId, isZeroSessionId } from '../../src/protocol/session';

/**
 * The transfer session id is the calibration id, so both machines derive it
 * independently and no longer need a particular button order.
 */
describe('transfer session id is shared by construction', () => {
  it('both machines derive the same id from the same nonces', async () => {
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    const fromA = await deriveCalibrationId(a, b);
    const fromB = await deriveCalibrationId(b, a);
    expect(fromA).toBe(fromB);
  });

  it('is a valid non-zero session id', async () => {
    const id = await deriveCalibrationId('1'.repeat(32), '2'.repeat(32));
    expect(isValidSessionId(id)).toBe(true);
    expect(isZeroSessionId(id)).toBe(false);
  });

  it('differs when the nonces differ', async () => {
    const one = await deriveCalibrationId('1'.repeat(32), '2'.repeat(32));
    const two = await deriveCalibrationId('1'.repeat(32), '3'.repeat(32));
    expect(one).not.toBe(two);
  });
});

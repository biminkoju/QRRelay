import type { CalibrationEcc } from './messageTypes';

/**
 * Chunk-size agreement.
 *
 * Both machines calibrate independently, and nothing guarantees the two
 * measurements agree. Frames built with different chunk sizes carry different
 * META and DATA shapes, so a transfer would fail in ways that look like a bad
 * link rather than a configuration mismatch.
 *
 * The rule is deliberately boring: both sides broadcast their own value and
 * both adopt the smaller one. Min is symmetric, so no leader is needed and
 * both sides provably reach the same answer without a second round trip.
 * Taking the minimum also means neither side uses a size it has not itself
 * proven it can read.
 */

export interface AgreementOffer {
  chunkSize: number;
  ecl: CalibrationEcc;
}

export interface AgreementResult {
  /** The agreed size, safe to use on both machines. */
  chunkSize: number;
  /**
   * EC level of whichever side set the constraint. When sizes tie, the
   * stronger level is reported so the caller does not accidentally assume a
   * weaker symbol than was measured.
   */
  ecl: CalibrationEcc;
  /** True when both sides offered the same chunk size. */
  agreedExactly: boolean;
  /** Human-readable explanation, for the UI and for logs. */
  reason: string;
}

const STRENGTH: Record<CalibrationEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };

function stronger(a: CalibrationEcc, b: CalibrationEcc): CalibrationEcc {
  return STRENGTH[a] >= STRENGTH[b] ? a : b;
}

/** Rejects offers outside what the protocol can express, rather than clamping. */
export function isValidOffer(offer: AgreementOffer): boolean {
  return (
    Number.isInteger(offer.chunkSize) &&
    offer.chunkSize >= 1 &&
    offer.chunkSize <= 4096 &&
    (offer.ecl === 'L' || offer.ecl === 'M' || offer.ecl === 'Q' || offer.ecl === 'H')
  );
}

export function agree(
  local: AgreementOffer,
  remote: AgreementOffer,
): AgreementResult {
  if (!isValidOffer(local) || !isValidOffer(remote)) {
    throw new Error('agreement offers must be within 1..4096 bytes and a valid EC level');
  }

  const agreedExactly = local.chunkSize === remote.chunkSize;
  const chunkSize = Math.min(local.chunkSize, remote.chunkSize);

  // Report the EC level belonging to whichever side set the constraint. On a
  // tie, take the stronger level: the caller then never assumes weaker
  // protection than was actually measured.
  let ecl: CalibrationEcc;
  if (local.chunkSize < remote.chunkSize) ecl = local.ecl;
  else if (remote.chunkSize < local.chunkSize) ecl = remote.ecl;
  else ecl = stronger(local.ecl, remote.ecl);

  const reason = agreedExactly
    ? 'Both sides measured ' + chunkSize + ' bytes at EC ' + ecl
    : 'Using the smaller measurement: ' +
      chunkSize +
      ' bytes at EC ' +
      ecl +
      ' (local ' +
      local.chunkSize +
      ' B/' +
      local.ecl +
      ', peer ' +
      remote.chunkSize +
      ' B/' +
      remote.ecl +
      ')';

  return { chunkSize, ecl, agreedExactly, reason };
}

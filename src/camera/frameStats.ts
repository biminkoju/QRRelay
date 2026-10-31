/** Pure helpers for scanner statistics and duplicate suppression. */

export interface ScannerStats {
  framesExamined: number;
  decodeAttempts: number;
  decoded: number;
  distinct: number;
  lastDecodeAt: number | null;
}

export function emptyStats(): ScannerStats {
  return { framesExamined: 0, decodeAttempts: 0, decoded: 0, distinct: 0, lastDecodeAt: null };
}

/**
 * Duplicate suppression is an optimisation only. It never affects protocol
 * correctness: the state machines already treat duplicates as idempotent.
 */
export interface DuplicateFilter {
  isDuplicate(text: string): boolean;
  reset(): void;
}

export function createDuplicateFilter(): DuplicateFilter {
  let last: string | null = null;
  return {
    isDuplicate(text) {
      if (text === last) return true;
      last = text;
      return false;
    },
    reset() {
      last = null;
    },
  };
}

/** Distinct decodes per second over the window that starts at firstDecodeAt. */
export function decodeRatePerSecond(stats: ScannerStats, nowMs: number, firstDecodeAt: number | null): number {
  if (firstDecodeAt === null || stats.distinct === 0) return 0;
  const seconds = (nowMs - firstDecodeAt) / 1000;
  if (seconds <= 0) return 0;
  return stats.distinct / seconds;
}

/** Simple three-level quality label derived from measured decode rate. */
export function qualityLabel(ratePerSecond: number): 'none' | 'poor' | 'fair' | 'good' {
  if (ratePerSecond <= 0) return 'none';
  if (ratePerSecond < 0.2) return 'poor';
  if (ratePerSecond < 1) return 'fair';
  return 'good';
}

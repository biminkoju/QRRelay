import { describe, expect, it } from 'vitest';
import {
  createDuplicateFilter,
  decodeRatePerSecond,
  emptyStats,
  qualityLabel,
} from '../../src/camera/frameStats';

describe('duplicate filter', () => {
  it('suppresses only consecutive identical decodes', () => {
    const filter = createDuplicateFilter();
    expect(filter.isDuplicate('A')).toBe(false);
    expect(filter.isDuplicate('A')).toBe(true);
    expect(filter.isDuplicate('B')).toBe(false);
    expect(filter.isDuplicate('A')).toBe(false);
  });

  it('can be reset', () => {
    const filter = createDuplicateFilter();
    filter.isDuplicate('A');
    filter.reset();
    expect(filter.isDuplicate('A')).toBe(false);
  });
});

describe('decode rate', () => {
  it('is zero before any decode', () => {
    expect(decodeRatePerSecond(emptyStats(), 1000, null)).toBe(0);
  });

  it('counts distinct decodes over elapsed time', () => {
    const stats = { ...emptyStats(), distinct: 5 };
    expect(decodeRatePerSecond(stats, 5000, 2500)).toBeCloseTo(2);
  });
});

describe('quality label', () => {
  it('maps measured rates to labels', () => {
    expect(qualityLabel(0)).toBe('none');
    expect(qualityLabel(0.1)).toBe('poor');
    expect(qualityLabel(0.5)).toBe('fair');
    expect(qualityLabel(2)).toBe('good');
  });
});

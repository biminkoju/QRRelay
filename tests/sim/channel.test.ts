import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL, captureWidthFor, simulateCapture } from '../../src/sim/channel';
import { encodeQr } from '../../src/qr/encode';

const TEXT = 'QRF1|CAL_PROBE|' + '0'.repeat(32) + '|0|AAAA|deadbeef';

describe('simulated channel', () => {
  it('decodes an undegraded capture', () => {
    const result = simulateCapture(TEXT, 'M', { ...DEFAULT_CHANNEL, modulePx: 10, captureWidth: 2000 });
    expect(result.decoded).toBe(TEXT);
  });

  it('is deterministic for the same seed', () => {
    const options = { ...DEFAULT_CHANNEL, noise: 0.4, captureWidth: 300 };
    const a = simulateCapture(TEXT, 'M', options);
    const b = simulateCapture(TEXT, 'M', options);
    expect(a.decoded).toBe(b.decoded);
    expect(Array.from(a.capture.data.slice(0, 64))).toEqual(Array.from(b.capture.data.slice(0, 64)));
  });

  it('fails once a module is smaller than a capture pixel', () => {
    const qr = encodeQr(TEXT, 'M');
    const modules = qr.size + 8;
    // One capture pixel per module and below: modules alias together.
    const hopeless = simulateCapture(TEXT, 'M', {
      ...DEFAULT_CHANNEL,
      modulePx: 4,
      captureWidth: captureWidthFor(modules, 4, 0.5),
    });
    expect(hopeless.decoded).toBeNull();
    expect(hopeless.capturePxPerModule).toBeLessThan(1);
  });

  it('reports capture pixels per module rather than display pixels', () => {
    const qr = encodeQr(TEXT, 'M');
    const modules = qr.size + 8;
    const wide = simulateCapture(TEXT, 'M', { ...DEFAULT_CHANNEL, captureWidth: captureWidthFor(modules, 4, 6) });
    expect(wide.capturePxPerModule).toBeGreaterThan(5);
    // captureWidthFor rounds the target width, so the realised ratio lands
    // slightly above the 6 that was requested. Assert a band, not an exact value.
    expect(wide.capturePxPerModule).toBeLessThan(7.5);
  });

  it('survives mild blur but not extreme blur', () => {
    const qr = encodeQr(TEXT, 'M');
    const modules = qr.size + 8;
    const width = captureWidthFor(modules, 4, 8);
    const mild = simulateCapture(TEXT, 'M', { ...DEFAULT_CHANNEL, blurRadius: 1, captureWidth: width });
    const extreme = simulateCapture(TEXT, 'M', { ...DEFAULT_CHANNEL, blurRadius: 12, captureWidth: width });
    expect(mild.decoded).toBe(TEXT);
    expect(extreme.decoded).toBeNull();
  });

  it('fails when contrast is too low to separate black from white', () => {
    const qr = encodeQr(TEXT, 'M');
    const modules = qr.size + 8;
    const width = captureWidthFor(modules, 4, 8);
    // A pure brightness multiplier preserves the black/white ratio, so it can
    // never model washout. Reduced contrast pulls both ends towards mid-grey,
    // which is what glare actually does.
    const washed = simulateCapture(TEXT, 'M', {
      ...DEFAULT_CHANNEL,
      contrast: 0.08,
      captureWidth: width,
    });
    expect(washed.decoded).toBeNull();
  });

  it('still decodes at mild contrast loss', () => {
    const qr = encodeQr(TEXT, 'M');
    const modules = qr.size + 8;
    const mild = simulateCapture(TEXT, 'M', {
      ...DEFAULT_CHANNEL,
      contrast: 0.6,
      captureWidth: captureWidthFor(modules, 4, 8),
    });
    expect(mild.decoded).toBe(TEXT);
  });

  it('records the module count of the symbol it produced', () => {
    const qr = encodeQr(TEXT, 'M');
    const result = simulateCapture(TEXT, 'M', { ...DEFAULT_CHANNEL, captureWidth: 2000 });
    expect(result.modules).toBe(qr.size);
  });
});

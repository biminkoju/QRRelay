import { describe, expect, it } from 'vitest';

/**
 * The facing reported by a live track decides the UI label. These tests pin the
 * parsing rule, because a browser is free to ignore the facingMode request and
 * a label based on the request would describe a camera that is not open.
 */
function parseFacing(settings: { facingMode?: string }): 'environment' | 'user' | null {
  const reported = settings.facingMode;
  return reported === 'environment' || reported === 'user' ? reported : null;
}

describe('camera facing parsing', () => {
  it('accepts the rear camera', () => {
    expect(parseFacing({ facingMode: 'environment' })).toBe('environment');
  });

  it('accepts the front camera', () => {
    expect(parseFacing({ facingMode: 'user' })).toBe('user');
  });

  it('returns null when the platform does not report facing', () => {
    expect(parseFacing({})).toBeNull();
  });

  it('returns null for an unexpected value rather than guessing', () => {
    expect(parseFacing({ facingMode: 'left' })).toBeNull();
    expect(parseFacing({ facingMode: '' })).toBeNull();
  });

  it('picks the opposite lens when switching', () => {
    const flip = (actual: 'environment' | 'user'): 'environment' | 'user' =>
      actual === 'environment' ? 'user' : 'environment';
    expect(flip('environment')).toBe('user');
    expect(flip('user')).toBe('environment');
  });
});

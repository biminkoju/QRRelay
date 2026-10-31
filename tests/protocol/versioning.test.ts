import { describe, expect, it } from 'vitest';
import { negotiateProtocol } from '../../src/protocol/versioning';

const base = { appVersion: '0.1.0', buildId: 'a', protocolVersions: [1, 2], capabilities: ['reliable', 'text'] };

describe('version negotiation', () => {
  it('picks the highest common version', () => {
    const result = negotiateProtocol(base, { ...base, protocolVersions: [2, 3] });
    expect(result).toMatchObject({ ok: true, protocolVersion: 2 });
  });

  it('fails when no version overlaps', () => {
    expect(negotiateProtocol(base, { ...base, protocolVersions: [7] })).toEqual({ ok: false });
  });

  it('intersects capabilities', () => {
    const result = negotiateProtocol(base, { ...base, capabilities: ['reliable', 'binary'] });
    expect(result.ok && result.capabilities).toEqual(['reliable']);
  });

  it('reports app-version mismatch separately', () => {
    const result = negotiateProtocol(base, { ...base, appVersion: '0.2.0' });
    expect(result.ok && result.appVersionMatches).toBe(false);
  });
});

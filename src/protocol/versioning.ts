import type { PeerInfo } from './messageTypes';

export interface NegotiationResult {
  ok: true;
  protocolVersion: number;
  capabilities: string[];
  appVersionMatches: boolean;
}

/** Picks the highest common protocol version, then intersects capabilities. */
export function negotiateProtocol(
  local: PeerInfo,
  remote: PeerInfo,
): NegotiationResult | { ok: false } {
  const common = local.protocolVersions
    .filter((v) => remote.protocolVersions.includes(v))
    .sort((a, b) => b - a);
  if (common.length === 0) return { ok: false };
  const capabilities = local.capabilities.filter((c) => remote.capabilities.includes(c)).sort();
  return {
    ok: true,
    protocolVersion: common[0],
    capabilities,
    appVersionMatches: local.appVersion === remote.appVersion,
  };
}

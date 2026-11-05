import { parseProviderSharePeer } from './providerSharePeer.js';
import type { ProviderShareOwned } from './providerShareApi.js';

export type ProviderShareGuestDenial = 'host-not-running' | 'host-scope-stale' | 'not-guest-peer'
  | 'self-device' | 'snapshot-not-loaded' | 'share-unknown' | 'share-on-other-device'
  | 'member-not-active' | 'member-cleanup-pending' | 'remote-control-off' | 'provider-not-remote';
export interface ProviderShareGuestAccess { shareId: string; memberId: string; providerId: string }

/** Shared Desktop/CLI admission; only server-owned membership snapshots authorize guests. */
export function checkProviderShareGuestAccess(controller: string, state: {
  running: boolean; current: boolean; selfDeviceId: string | null;
  shares: readonly ProviderShareOwned[]; fetched: boolean; remoteControlEnabled: boolean;
  memberReady(shareId: string, memberId: string, joinedAt: string): boolean;
  providerAllowed(providerId: string): boolean;
}): { access: ProviderShareGuestAccess } | { denied: ProviderShareGuestDenial } {
  if (!state.running) return { denied: 'host-not-running' };
  if (!state.current) return { denied: 'host-scope-stale' };
  const peer = parseProviderSharePeer(controller);
  if (!peer || peer.role !== 'guest') return { denied: 'not-guest-peer' };
  if (state.selfDeviceId && peer.deviceId === state.selfDeviceId) return { denied: 'self-device' };
  const share = state.shares.find(item => item.shareId === peer.shareId);
  if (!share) return { denied: state.fetched ? 'share-unknown' : 'snapshot-not-loaded' };
  if (state.selfDeviceId && share.hostDeviceId !== state.selfDeviceId) return { denied: 'share-on-other-device' };
  const member = share.members.find(item => item.memberId === peer.memberId);
  if (!member || member.status !== 'active') return { denied: 'member-not-active' };
  if (!state.memberReady(share.shareId, member.memberId, member.joinedAt)) return { denied: 'member-cleanup-pending' };
  if (!state.remoteControlEnabled) return { denied: 'remote-control-off' };
  if (!state.providerAllowed(share.providerId)) return { denied: 'provider-not-remote' };
  return { access: { shareId: share.shareId, memberId: member.memberId, providerId: share.providerId } };
}

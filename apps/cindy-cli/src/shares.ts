/**
 * Using providers shared by other accounts (guest side, provider-sharing.md §4–§5).
 * Same-region only: this build is Global and cross-region guest support (Desktop
 * providerShareCrossRegion.ts) is not ported. Membership belongs to the account and is
 * always re-read from the official service; nothing local authorizes a share.
 * Manual sync point with Desktop device-link/providerShareGuest.ts.
 */
import { createHash } from 'node:crypto';
import {
  createProviderShareApi, parseProviderShareInvitationIntent, parseProviderShareLink, providerShareHostPeer, providerShareLinkRegion,
  type ProviderShareApi, type ProviderShareInvitationIntent, type ProviderShareLinkPreview, type ProviderShareReceived, type ProviderShareRequestState,
} from '@cindy/device-link';
import { parseShareAgentDeviceId } from './catalog';
import type { ShareTrustStore } from './trust-store';

export class ShareError extends Error {
  constructor(public readonly code: 'INVALID_LINK' | 'OTHER_REGION' | 'NOT_FOUND' | 'PAUSED' | 'REMOVED' | 'UNAVAILABLE') { super(code); }
}

export interface ShareTransport {
  /** Authenticated JSON request to the device-link service (same account, same region). */
  request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<unknown>;
  /** Authenticated JSON request to the account service (identity card). */
  identityRequest(path: string, body: unknown): Promise<unknown>;
  isCurrent(): boolean;
  deviceLinkApiBaseUrl: string;
}

export interface GuestShares {
  api: ProviderShareApi;
  /** Parses a pasted link or `cindy://provider-share/join?…` intent. */
  resolve(link: string): ProviderShareInvitationIntent;
  preview(link: string): Promise<ProviderShareLinkPreview>;
  /** Sends the request only after the user confirmed the preview. */
  request(link: string): Promise<ProviderShareRequestState>;
  status(requestId: string): Promise<ProviderShareRequestState>;
  withdraw(requestId: string): Promise<void>;
  /** Authoritative list from the service; cached for target resolution. */
  refresh(): Promise<ProviderShareReceived[]>;
  received(): readonly ProviderShareReceived[];
  isTrusted(shareId: string): boolean;
  setTrusted(memberId: string, enabled: boolean): Promise<ProviderShareReceived>;
  leave(memberId: string): Promise<void>;
  /** `share:<id>` → the sharer's peer key; same-account device ids pass through. */
  resolveTarget(agentDeviceId: string): Promise<string>;
}

export function createGuestShares(transport: ShareTransport, options: { trust?: ShareTrustStore } = {}): GuestShares {
  const api = createProviderShareApi({
    request: (path, options) => transport.request(path, { method: options.method, ...(options.body === undefined ? {} : { body: options.body }) }),
    captureScope: () => ({ isCurrent: transport.isCurrent }),
  });
  let cache: ProviderShareReceived[] | null = null;
  let loading: Promise<ProviderShareReceived[]> | null = null;
  let generation = 0;
  const left = new Set<string>();
  const leaving = new Set<string>();
  const changes = new Map<string, number>();
  const current = () => { if (!transport.isCurrent()) throw new ShareError('UNAVAILABLE'); };
  const resolve = (link: string): ProviderShareInvitationIntent => {
    const intent = parseProviderShareInvitationIntent(link.trim()) ?? parseProviderShareLink(link);
    if (!intent) throw new ShareError('INVALID_LINK');
    if (providerShareLinkRegion(intent, { local: transport.deviceLinkApiBaseUrl }) !== 'local') throw new ShareError('OTHER_REGION');
    return intent;
  };
  const refresh = (): Promise<ProviderShareReceived[]> => {
    if (!transport.isCurrent()) return Promise.reject(new ShareError('UNAVAILABLE'));
    if (!loading) {
      const captured = generation;
      const operation = api.listReceived().then(async list => {
        current();
        if (captured !== generation) throw new ShareError('UNAVAILABLE');
        const received = list.filter(item => !left.has(item.memberId));
        // Membership disappears before asynchronous disk pruning, never after it.
        cache = received;
        await options.trust?.retain(received.map(item => item.shareId));
        current();
        if (captured !== generation) throw new ShareError('UNAVAILABLE');
        return received;
      }).finally(() => { if (loading === operation) loading = null; });
      loading = operation;
    }
    return loading;
  };
  return {
    api,
    resolve,
    preview: async link => api.preview(resolve(link).invitation),
    async request(link) {
      const { invitation } = resolve(link);
      // Identity card carries only nickname and avatar, bound to this invitation (Desktop parity).
      const nonce = createHash('sha256').update(invitation).digest('hex');
      const identity = await transport.identityRequest('/api/me/identity-card', { audience: 'cindy-provider-share', purpose: 'share-request', nonce }) as { card?: unknown };
      if (typeof identity?.card !== 'string' || !identity.card || identity.card.length > 8192) throw new ShareError('UNAVAILABLE');
      return api.sendRequest(invitation, identity.card);
    },
    status: requestId => api.getRequest(requestId),
    withdraw: requestId => api.withdraw(requestId),
    refresh,
    received: () => transport.isCurrent() ? cache ?? [] : [],
    isTrusted: shareId => transport.isCurrent() && !!cache?.some(item => item.shareId === shareId && !left.has(item.memberId) && !leaving.has(item.memberId)) && options.trust?.isTrusted(shareId) === true,
    async setTrusted(memberId, enabled) {
      current();
      if (leaving.has(memberId)) throw new ShareError('UNAVAILABLE');
      if (!options.trust) throw new ShareError('UNAVAILABLE');
      const revision = (changes.get(memberId) ?? 0) + 1;
      changes.set(memberId, revision);
      // Turning trust off is immediate for an already known member, even if refresh fails.
      const known = cache?.find(item => item.memberId === memberId);
      const revocation = !enabled && known ? options.trust.setTrusted(known.shareId, false) : null;
      // Observe failures immediately while still awaiting authoritative validation below.
      void revocation?.catch(() => undefined);
      const list = await refresh();
      current();
      const member = list.find(item => item.memberId === memberId && !left.has(memberId));
      if (!member) throw new ShareError('NOT_FOUND');
      if (changes.get(memberId) !== revision) throw new ShareError('UNAVAILABLE');
      if (revocation) await revocation;
      else await options.trust.setTrusted(member.shareId, enabled);
      if (changes.get(memberId) !== revision) throw new ShareError('UNAVAILABLE');
      if (!transport.isCurrent() || left.has(memberId) || !cache?.some(item => item.memberId === memberId)) {
        await options.trust.setTrusted(member.shareId, false);
        throw new ShareError('UNAVAILABLE');
      }
      return member;
    },
    async leave(memberId) {
      current();
      const known = cache?.find(item => item.memberId === memberId) ?? (await refresh()).find(item => item.memberId === memberId);
      if (!known) throw new ShareError('NOT_FOUND');
      generation++;
      changes.set(memberId, (changes.get(memberId) ?? 0) + 1);
      loading = null;
      leaving.add(memberId);
      const revocation = options.trust?.setTrusted(known.shareId, false);
      void revocation?.catch(() => undefined);
      try {
        await api.leave(memberId);
        current();
        left.add(memberId);
        cache = cache?.filter(item => item.memberId !== memberId) ?? [];
        await revocation;
        await refresh().catch(() => undefined);
      } finally {
        // A failed network leave also keeps the user's local trust revocation.
        await revocation?.catch(() => undefined);
        leaving.delete(memberId);
      }
    },
    async resolveTarget(agentDeviceId) {
      const shareId = parseShareAgentDeviceId(agentDeviceId);
      if (!shareId) return agentDeviceId;
      current();
      // Not loaded yet is not "removed": load first, then decide.
      const list = cache ?? await refresh().catch(() => { throw new ShareError('UNAVAILABLE'); });
      const share = list.find(item => item.shareId === shareId);
      if (!share) throw new ShareError('REMOVED');
      if (share.status !== 'active') throw new ShareError('PAUSED');
      return providerShareHostPeer(share.shareId, share.hostDeviceId);
    },
  };
}

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
  leave(memberId: string): Promise<void>;
  /** `share:<id>` → the sharer's peer key; same-account device ids pass through. */
  resolveTarget(agentDeviceId: string): Promise<string>;
}

export function createGuestShares(transport: ShareTransport): GuestShares {
  const api = createProviderShareApi({
    request: (path, options) => transport.request(path, { method: options.method, ...(options.body === undefined ? {} : { body: options.body }) }),
    captureScope: () => ({ isCurrent: transport.isCurrent }),
  });
  let cache: ProviderShareReceived[] | null = null;
  let loading: Promise<ProviderShareReceived[]> | null = null;
  const resolve = (link: string): ProviderShareInvitationIntent => {
    const intent = parseProviderShareInvitationIntent(link.trim()) ?? parseProviderShareLink(link);
    if (!intent) throw new ShareError('INVALID_LINK');
    if (providerShareLinkRegion(intent, { local: transport.deviceLinkApiBaseUrl }) !== 'local') throw new ShareError('OTHER_REGION');
    return intent;
  };
  const refresh = () => {
    loading ??= api.listReceived().then(list => { cache = list; return list; }).finally(() => { loading = null; });
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
    received: () => cache ?? [],
    async leave(memberId) {
      await api.leave(memberId);
      await refresh().catch(() => undefined);
    },
    async resolveTarget(agentDeviceId) {
      const shareId = parseShareAgentDeviceId(agentDeviceId);
      if (!shareId) return agentDeviceId;
      // Not loaded yet is not "removed": load first, then decide.
      const list = cache ?? await refresh().catch(() => { throw new ShareError('UNAVAILABLE'); });
      const share = list.find(item => item.shareId === shareId);
      if (!share) throw new ShareError('REMOVED');
      if (share.status !== 'active') throw new ShareError('PAUSED');
      return providerShareHostPeer(share.shareId, share.hostDeviceId);
    },
  };
}

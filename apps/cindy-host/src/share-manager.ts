import { readShareUsage } from './share-usage';
import type { ProviderShareUsageStore } from '@cindy/remote-agent-host/providerShareUsageStore';
import { createHash } from 'node:crypto';
import { buildProviderShareLink, checkProviderShareGuestAccess, createProviderShareApi, parseProviderSharePeer,
  PROVIDER_SHARE_NEUTRAL_DEVICE_NAME, type ProviderShareOwned } from '@cindy/device-link';
import type { ShareCommand } from './share-control';

export function createShareManager(options: {
  providerId: string; providerName: string; deviceId(): string | null; current(): boolean; enabled(): boolean;
  request(path: string, body?: unknown, identity?: boolean): Promise<unknown>;
  ledger?: ProviderShareUsageStore; ownerScope?: string;
  server: string; notify(text: string): void;
  revoke(match: (peer: string) => boolean, purge: boolean): Promise<void>;
}) {
  let shares: ProviderShareOwned[] = [];
  let fetched = false; let refreshedAt = -Infinity; let lastAttempt = -Infinity;
  let inflight: Promise<void> | undefined;
  let mutationEpoch = 0;
  const known = new Set<string>();
  const blocked = new Set<string>();
  const api = createProviderShareApi({ captureScope: () => ({ isCurrent: options.current }),
    request: (path, request) => {
      if (!request.isCurrent()) throw new Error('Account changed');
      return options.request(path, request.method === 'POST' ? request.body ?? {} : undefined);
    },
  });
  const valid = () => options.current() && options.enabled() && fetched && performance.now() - refreshedAt < 65000;
  function access(peer: string) {
    const checked = checkProviderShareGuestAccess(peer, { running: true, current: valid(), selfDeviceId: options.deviceId(),
      shares, fetched, remoteControlEnabled: options.enabled(), memberReady: (shareId, memberId) => !blocked.has(`${shareId}:${memberId}`) && (!options.ledger || options.ledger.memberGenerationReady({ ownerScope: options.ownerScope!, ownerDeviceId: options.deviceId()!, shareId, memberId }, shares.find(share => share.shareId === shareId)!.members.find(member => member.memberId === memberId)!.joinedAt)),
      providerAllowed: id => id === options.providerId });
    return 'access' in checked ? checked.access : null;
  }
  async function refresh(force = false) {
    if (inflight) return inflight;
    if (!force && performance.now() - lastAttempt < 5000) return;
    lastAttempt = performance.now();
    const epoch = mutationEpoch;
    inflight = (async () => {
      const next = (await api.listOwned()).filter(share => share.hostDeviceId === options.deviceId() && share.providerId === options.providerId);
      if (!options.current() || epoch !== mutationEpoch) throw new Error('Account or share state changed');
      if (options.ledger) {
        const pending = await options.ledger.reconcileMemberGenerations(options.ownerScope!, options.deviceId()!, next);
        for (const member of pending) {
          await options.revoke(peer => { const value = parseProviderSharePeer(peer); return value?.role === 'guest' && value.shareId === member.shareId && value.memberId === member.memberId; }, true);
          if (!options.current() || epoch !== mutationEpoch) throw new Error('Account or share state changed');
          await options.ledger.acknowledgeMemberCleanup(member);
        }
      }
      // Revoke old admissions before allowing any replacement membership.
      const previous = shares;
      for (const share of previous) for (const member of share.members) {
        const updated = next.find(item => item.shareId === share.shareId)?.members.find(item => item.memberId === member.memberId);
        if (!updated || updated.status !== 'active' || updated.joinedAt !== member.joinedAt) blocked.add(`${share.shareId}:${member.memberId}`);
      }
      for (const share of previous) for (const member of share.members) {
        const updated = next.find(item => item.shareId === share.shareId)?.members.find(item => item.memberId === member.memberId);
        if (!updated || updated.status !== 'active' || updated.joinedAt !== member.joinedAt) {
          await options.revoke(peer => { const value = parseProviderSharePeer(peer); return value?.role === 'guest' && value.shareId === share.shareId && value.memberId === member.memberId; }, !updated || updated.joinedAt !== member.joinedAt);
        }
      }
      // On restart also remove deleted members' retained guest data.
      await options.revoke(peer => { const value = parseProviderSharePeer(peer); return value?.role === 'guest' && !next.some(share => share.shareId === value.shareId && share.members.some(member => member.memberId === value.memberId)); }, true);
      if (!options.current() || epoch !== mutationEpoch) throw new Error('Account or share state changed');
      shares = next; fetched = true; refreshedAt = performance.now(); blocked.clear();
      for (const share of shares) for (const request of share.requests) if (!known.has(request.requestId)) {
        known.add(request.requestId);
        options.notify(`Provider share request: ${JSON.stringify({ requestId: request.requestId, name: request.displayName, expiresAt: request.expiresAt })}`);
      }
    })().finally(() => { inflight = undefined; });
    return inflight;
  }
  async function execute(command: ShareCommand) {
    if (command.action === 'usage' || command.action === 'quota') throw new Error('Share quota and usage settings are handled by the host.');
    await refresh(true);
    if (!options.current()) throw new Error('Sharing unavailable');
    if (['link', 'approve', 'resume'].includes(command.action) && !options.enabled()) throw new Error('Sharing is disabled');
    if (command.action === 'list') return { shares, usage: options.ledger?.query(new Set(shares.map(share => share.shareId)), 'all') ?? [] };
    if (command.action === 'link') {
      const deviceId = options.deviceId();
      if (!deviceId) throw new Error('Host is offline');
      const nonce = createHash('sha256').update(`${deviceId}:${options.providerId}`).digest('hex');
      const identity = await options.request('/api/me/identity-card', { audience: 'cindy-provider-share', purpose: 'share-link', nonce }, true) as { card?: unknown };
      if (typeof identity.card !== 'string') throw new Error('Identity unavailable');
      const link = await api.createLink({ providerId: options.providerId, providerLabel: options.providerName,
        deviceName: PROVIDER_SHARE_NEUTRAL_DEVICE_NAME, identityCard: identity.card });
      return { url: buildProviderShareLink(link.invitation, options.server), expiresAt: link.expiresAt };
    }
    if (command.action === 'approve' || command.action === 'reject') {
      const request = shares.flatMap(share => share.requests).find(item => item.requestId === command.id);
      if (!request || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Request unavailable');
      if (command.action === 'approve') {
        if (request.pairingCode !== command.code) throw new Error('Pairing code mismatch');
        mutationEpoch++; await api.approve(request.requestId); mutationEpoch++;
      } else { mutationEpoch++; await api.reject(request.requestId); mutationEpoch++; }
    } else {
      const share = shares.find(item => item.members.some(member => member.memberId === command.id));
      if (!share || !command.id) throw new Error('Member unavailable');
      mutationEpoch++; await api.setMember(command.id, command.action); mutationEpoch++;
      if (command.action !== 'resume') {
        blocked.add(`${share.shareId}:${command.id}`);
        shares = shares.map(item => ({ ...item, members: item.members.flatMap(member => member.memberId !== command.id ? [member] : command.action === 'remove' ? [] : [{ ...member, status: 'paused' as const }]) }));
        await options.revoke(peer => { const value = parseProviderSharePeer(peer); return value?.role === 'guest' && value.shareId === share.shareId && value.memberId === command.id; }, command.action === 'remove');
      }
    }
    if (inflight) await inflight.catch(() => undefined);
    await refresh(true);
    return { ok: true };
  }
  return { access, refresh, execute, async usage(peer: string) {
    const grant = access(peer);
    const share = grant && shares.find(s => s.shareId === grant.shareId);
    if (!grant || !share || !options.ledger) throw new Error('Share usage unavailable');
    return readShareUsage(options.ledger, share, grant.memberId, options.providerId);
  }, quotaAccess(peer: string) {
    const grant = access(peer);
    if (!grant) return null;
    const share = shares.find(s => s.shareId === grant.shareId);
    // History contains every current member; any roster change invalidates an in-flight reply.
    return share ? JSON.stringify([grant, share.members, mutationEpoch]) : null;
  } };
}

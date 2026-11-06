import { describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer, type ProviderShareOwned } from '@cindy/device-link';
import { createShareManager } from './share-manager';

// Unit: production management/admission against fake authoritative REST responses.
// Existing host tests cover only owner peers. Minimal regressions are an unapproved
// member, wrong pairing code, paused membership, stale owner, or foreign-device share.
// Standalone measurement: 2.07s wall (7 cases, 72ms test execution).
function fixture() {
  const shareId = '11111111-1111-4111-8111-111111111111';
  const memberId = '22222222-2222-4222-8222-222222222222';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const person = { displayName: 'Test user', avatarUrl: null, region: 'global' as const };
  let shares: ProviderShareOwned[] = [{ shareId, providerId: 'cli-codex', providerLabel: 'Codex API', hostDeviceId: 'host', createdAt: new Date().toISOString(), members: [],
    requests: [{ ...person, requestId, pairingCode: '1234', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() }] }];
  let current = true; let enabled = true;
  const notify = vi.fn();
  const revoke = vi.fn(async () => {});
  const request = vi.fn(async (url: string) => {
    if (url.endsWith('/approve')) { shares[0].members = [{ ...person, memberId, status: 'active', joinedAt: new Date().toISOString() }]; shares[0].requests = []; return { shareId, memberId }; }
    if (url.endsWith('/pause')) { shares[0].members[0].status = 'paused'; return { memberId, status: 'paused' }; }
    if (url.endsWith('/remove')) { shares[0].members = []; return { memberId, status: 'removed' }; }
    if (url.endsWith('/identity-card')) return { card: 'invalid-fake-card' };
    if (url.endsWith('/links')) return { shareId, invitation: 'a'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString() };
    return structuredClone({ shares });
  });
  const manager = createShareManager({ providerId: 'cli-codex', providerName: 'Codex API', deviceId: () => 'host', current: () => current,
    enabled: () => enabled, server: 'https://device-link.cindy.app', notify, revoke, request });
  const peer = providerShareGuestPeer(shareId, memberId, 'guest-device');
  return { manager, request, revoke, notify, peer, requestId, memberId, setCurrent: () => { current = false; }, disable: () => { enabled = false; }, foreign: () => { shares[0].hostDeviceId = 'other-host'; } };
}

describe('CLI provider share management', () => {
  // Direct execute previously allowed quota/usage to reach the member-action path.
  // The public runtime routes these to quota.manage; no member endpoint may be called.
  // Unit: existing fake REST fixture, minimal input is either action plus a valid member.
  it.each(['usage', 'quota'] as const)('rejects direct %s dispatch without a member request', async action => {
    const h = fixture();
    await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
    h.request.mockClear();
    await expect(h.manager.execute({ action, id: h.memberId })).rejects.toThrow('handled by the host');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.manager.access(h.peer)).not.toBeNull();
  });
  it('requires approval and matching pairing code before admitting the exact share/member', async () => {
    const h = fixture();
    await h.manager.refresh();
    expect(h.manager.access(h.peer)).toBeNull();
    await expect(h.manager.execute({ action: 'approve', id: h.requestId, code: '9999' })).rejects.toThrow('Pairing');
    expect(h.request.mock.calls.some(([url]) => url.endsWith('/approve'))).toBe(false);
    await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
    expect(h.manager.access(h.peer)?.providerId).toBe('cli-codex');
    expect(h.manager.access('ordinary-device')).toBeNull();
  });
  // provider-sharing §11: pairing codes remain in the management response, never service logs.
  // Existing admission tests did not observe notify; one pending request is sufficient.
  it('keeps pairing codes out of service notifications', async () => {
    const h = fixture();
    const result = await h.manager.execute({ action: 'list' });
    expect(result).toMatchObject({ shares: [{ requests: [{ pairingCode: '1234' }] }] });
    expect(h.notify).toHaveBeenCalledOnce();
    const message = JSON.parse(h.notify.mock.calls[0][0].slice('Provider share request: '.length));
    expect(message.requestId).toBe(h.requestId);
    expect(message).not.toHaveProperty('pairingCode');
    expect(message).not.toHaveProperty('region');
  });
  it.each(['pause', 'remove'] as const)('revokes active access after %s and requests the correct cleanup', async action => {
    const h = fixture();
    await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
    h.revoke.mockClear();
    await h.manager.execute({ action, id: h.memberId });
    expect(h.manager.access(h.peer)).toBeNull();
    expect(h.revoke.mock.calls.some(call => (call as unknown[])[1] === (action === 'remove'))).toBe(true);
  });
  it('expires cached authorization even if the wall clock moves backwards', async () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const wall = Date.now();
    const h = fixture();
    try {
      await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
      expect(h.manager.access(h.peer)).not.toBeNull();
      vi.spyOn(Date, 'now').mockReturnValue(wall - 60000);
      monotonic.mockReturnValue(70000);
      expect(h.manager.access(h.peer)).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });
  it('keeps owner inspection and revocation available when remote serving is disabled', async () => {
    const h = fixture();
    await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
    h.disable();
    expect(await h.manager.execute({ action: 'list' })).toHaveProperty('shares');
    await expect(h.manager.execute({ action: 'link' })).rejects.toThrow('disabled');
    await h.manager.execute({ action: 'remove', id: h.memberId });
    expect(h.manager.access(h.peer)).toBeNull();
  });
  it('keeps a removed member blocked when the subsequent snapshot fetch fails', async () => {
    const h = fixture();
    await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
    const original = h.request.getMockImplementation()!;
    let removed = false;
    h.request.mockImplementation(async url => {
      if (removed) throw new Error('fake-network-failure');
      const result = await original(url);
      if (url.endsWith('/remove')) removed = true;
      return result;
    });
    await expect(h.manager.execute({ action: 'remove', id: h.memberId })).rejects.toThrow();
    expect(h.manager.access(h.peer)).toBeNull();
  });
  it('does not restore removed access from a snapshot requested before the mutation completed', async () => {
    const h = fixture();
    await h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' });
    const original = h.request.getMockImplementation()!;
    let mutationStarted!: () => void; let finishMutation!: () => void; let finishRead!: () => void;
    const started = new Promise<void>(resolve => { mutationStarted = resolve; });
    const mutation = new Promise<void>(resolve => { finishMutation = resolve; });
    const read = new Promise<void>(resolve => { finishRead = resolve; });
    let holdRead = false;
    h.request.mockImplementation(async url => {
      if (url.endsWith('/remove')) { mutationStarted(); await mutation; return original(url); }
      const result = await original(url);
      if (holdRead) { holdRead = false; await read; }
      return result;
    });
    const removing = h.manager.execute({ action: 'remove', id: h.memberId });
    await started;
    holdRead = true;
    const stale = h.manager.refresh(true).catch(() => undefined);
    await Promise.resolve();
    finishMutation();
    await vi.waitFor(() => expect(h.manager.access(h.peer)).toBeNull());
    finishRead();
    await Promise.all([removing, stale]);
    expect(h.manager.access(h.peer)).toBeNull();
  });
  it('rejects stale account and shares owned by another host device', async () => {
    const h = fixture(); h.foreign(); await h.manager.refresh();
    await expect(h.manager.execute({ action: 'approve', id: h.requestId, code: '1234' })).rejects.toThrow();
    h.setCurrent(); await expect(h.manager.execute({ action: 'link' })).rejects.toThrow();
  });
  it('uses the official invitation format and keeps its secret in the URL fragment', async () => {
    const h = fixture();
    const link = await h.manager.execute({ action: 'link' }) as { url: string };
    const url = new URL(link.url);
    expect(url.hash).toBe('#' + 'a'.repeat(43));
    expect(url.pathname).not.toContain('a'.repeat(43));
    expect(h.request.mock.calls.some(([url]) => url.endsWith('/identity-card'))).toBe(true);
  });
});

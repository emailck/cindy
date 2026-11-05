import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShareQuota, codexQuota, claudeQuota, type QuotaAccount } from './share-quota';

// Unit: public quota projection/management boundary, no agent module graph or credentials.
// Gap: CLI previously had no insights response. Minimal inputs: one native window,
// revoked membership during read, off/on while pending, and persisted explicit off.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const account = (): QuotaAccount => ({ state: 'ready', updatedAt: Date.now(), windows: [{ kind: 'week', label: null, remainingPercent: 73, resetsAt: Date.now() + 86400000, windowMinutes: 10080 }], balance: null });
async function fixture(read = vi.fn(async () => account())) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cindy-quota-test-')); roots.push(dataDir);
  let member: string | null = 'member-generation-1';
  const usage = vi.fn(async () => ({ todayKey: '2026-11-05', coverageStart: null, parties: [] }));
  const options = { usage, dataDir, scope: 'fake-owner', providerId: 'openai', read, current: () => true, access: () => member };
  return { quota: await createShareQuota(options), options, read, usage, revoke: () => { member = null; } };
}
const request = { version: 1, includeUsage: false };
describe('CLI subscription quota sharing', () => {
  it('defaults on, shares only quota, coalesces reads, and persists explicit off per owner/provider', async () => {
    const h = await fixture();
    const [a, b] = await Promise.all([h.quota.insights('guest', request), h.quota.insights('guest', request)]);
    expect(a.result).toMatchObject({ capabilities: { quota: true, usage: true }, status: { quota: 'ready' }, usage: null, quota: { accounts: [{ windows: [{ remainingPercent: 73 }] }] } });
    expect(b.result).toEqual(a.result); expect(h.read).toHaveBeenCalledOnce();
    await h.quota.manage('off');
    expect(a.isCurrent()).toBe(false);
    const reopened = await createShareQuota(h.options);
    expect((await reopened.insights('guest', request)).result).toMatchObject({ status: { quota: 'disabled' }, quota: null });
    expect(h.read).toHaveBeenCalledOnce();
    const other = await createShareQuota({ ...h.options, scope: 'another-owner' });
    expect((await other.insights('guest', request)).result.capabilities.quota).toBe(true);
  });
  it('reads usage only when expanded and persists its independent visibility choice', async () => {
    const h = await fixture();
    expect((await h.quota.insights('guest', request)).result.status.usage).toBe('not-requested');
    expect(h.usage).not.toHaveBeenCalled();
    const shown = await h.quota.insights('guest', { ...request, includeUsage: true });
    expect(shown.result).toMatchObject({ status: { usage: 'ready' }, usage: { todayKey: '2026-11-05' } });
    expect(h.usage).toHaveBeenCalledOnce();
    await h.quota.manage('off', 'usage');
    expect(shown.isCurrent()).toBe(false);
    const reopened = await createShareQuota(h.options);
    expect((await reopened.insights('guest', { ...request, includeUsage: true })).result).toMatchObject({
      capabilities: { quota: true, usage: false }, status: { usage: 'disabled' }, usage: null,
    });
    expect(h.usage).toHaveBeenCalledOnce();
    await reopened.manage('on', 'usage');
    expect((await reopened.insights('guest', { ...request, includeUsage: true })).result.status.usage).toBe('ready');
  });
  it('keeps quota available when usage fails and rejects usage after off/on during read', async () => {
    const h = await fixture();
    h.usage.mockRejectedValueOnce(new Error('private-history-error'));
    expect((await h.quota.insights('guest', { ...request, includeUsage: true })).result).toMatchObject({ status: { quota: 'ready', usage: 'unavailable' }, usage: null });
    let finish!: (value: Awaited<ReturnType<typeof h.usage>>) => void;
    h.usage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.quota.insights('guest', { ...request, includeUsage: true });
    const rejected = expect(pending).rejects.toThrow('Share changed');
    await h.quota.manage('off', 'usage'); await h.quota.manage('on', 'usage');
    finish({ todayKey: '2026-11-05', coverageStart: null, parties: [] }); await rejected;
  });
  it.each(['revoke', 'off-on'] as const)('discards late data after %s', async change => {
    let finish!: (value: QuotaAccount) => void;
    const h = await fixture(vi.fn(() => new Promise<QuotaAccount>(resolve => { finish = resolve; })));
    const pending = h.quota.insights('guest', request);
    const rejection = expect(pending).rejects.toThrow('Share changed');
    if (change === 'revoke') h.revoke();
    else { await h.quota.manage('off'); await h.quota.manage('on'); }
    finish(account()); await rejection;
  });
  it('does not turn failed reads into zero or leak upstream errors', async () => {
    const h = await fixture(vi.fn(async () => { throw new Error('fake-secret-upstream-error'); }));
    expect((await h.quota.insights('guest', request)).result).toMatchObject({ status: { quota: 'unavailable' }, quota: null });
    await expect(h.quota.insights('guest', { ...request, providerId: 'other' })).rejects.toThrow();
  });
  it('projects native Codex generic windows with milliseconds and strips credits/identity', () => {
    const value = codexQuota({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000 }, secondary: { usedPercent: 60, windowMinutes: 10080, resetsAt: 3000 }, credits: { hasCredits: true, unlimited: false, balance: '999' } }, rateLimitsByLimitId: null, rateLimitResetCredits: null }, 1000);
    expect(value.windows).toEqual([
      { kind: 'session', label: null, remainingPercent: 75, windowMinutes: 300, resetsAt: 2000000 },
      { kind: 'week', label: null, remainingPercent: 40, windowMinutes: 10080, resetsAt: 3000000 },
    ]);
    expect(value.balance).toBeNull();
    expect(codexQuota({ rateLimits: { limitId: 'model-promotion', primary: { usedPercent: 1 } }, rateLimitsByLimitId: null, rateLimitResetCredits: null }).state).toBe('unavailable');
  });
  it('accepts native Claude old/new quota shapes and excludes expired windows', () => {
    expect(claudeQuota({ five_hour: { utilization: 10, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 20 } }).windows.map(w => w.remainingPercent)).toEqual([90, 80]);
    expect(claudeQuota({ limits: [{ kind: 'weekly_all', percent: 30, resets_at: 2000 }, { kind: 'session', percent: 2, resets_at: 1 }] }, 1000).windows.map(w => w.remainingPercent)).toEqual([70]);
  });
});

// The CLI ledger contains executor IDs and SDK counters. Only the existing UI DTO may escape.
// No production agent or real account is loaded; minimal data is two device rows for one model.
it('projects and merges member usage without exposing devices, removed members or provider identifiers', async () => {
  const { readShareUsage } = await import('./share-usage');
  const rows = [1, 2].map(index => ({ day: '2026-11-05', kind: 'codex', providerId: 'openai', memberKey: `private-device-${index}`, model: 'model', turns: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 0, sdkCostUsd: 0.5 }));
  const history = vi.fn(() => [{ shareId: 'share', memberId: 'member', lastUsedAt: 1000, days: rows }]);
  const ledger = { history, memberTokenSnapshot: () => ({ available: true }) } as unknown as Parameters<typeof readShareUsage>[0];
  const share = { shareId: 'share', members: [{ memberId: 'member', displayName: 'Guest', avatarUrl: null }] } as Parameters<typeof readShareUsage>[1];
  const result = readShareUsage(ledger, share, 'member', 'openai');
  expect(result.parties[0]).toMatchObject({ isYou: true, days: [{ inputTokens: 20, outputTokens: 4, cacheReadTokens: 6, turns: 2, amount: { amount: 1, currency: 'USD' } }] });
  expect(JSON.stringify(result)).not.toContain('private-device');
  expect(JSON.stringify(result)).not.toContain('providerId');
  expect(history).toHaveBeenCalledWith(new Set(['share']), { maxRows: 5001, memberKeys: new Set(['["share","member"]']) });
});

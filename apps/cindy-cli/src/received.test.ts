/**
 * 测试价值
 * - 生产入口与可观察结果：runReceived + createGuestShares（cindy received …）；用户看到的申请前告知与配对码、
 *   是否真正发出申请、以及任务目标解析（分享来的供应商 → 分享者电脑）。
 * - Bug／规则依据：provider-sharing.md §4.1 第 3 步（确认后才提交，取消不提交）、§4.2（已用／过期链接）、§6.1 配对码、
 *   §8（终端版只支持同区域，跨区链接不能误发到本区服务）、§5.3（暂停／删除后不能再用）。
 * - 现有覆盖缺口：Desktop 的受邀者流程在 providerShareGuest.ts（Electron），CLI 为新的薄层实现。
 * - 最小失败输入：回答 n 仍发申请；跨区链接被当成本区；暂停的分享仍解析出目标；显式 trust on 未保存到当前账号的数据目录，重开进程仍弹分享确认；非法参数或 shareId 被误当 memberId 开启信任。
 * - tier：unit（内存假 REST；信任偏好使用系统临时目录中的真实存储；无网络、无钥匙串）。
 * - 实测耗时：received.test.ts 单独执行 4.73 秒（2026-11-16，7 项；用例执行 74 ms）。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildProviderShareLink, providerShareHostPeer } from '@cindy/device-link';
import { describe, expect, it } from 'vitest';
import { createTranslator } from './i18n';
import { CliError } from './profile';
import { runReceived } from './received';
import { createGuestShares, ShareError } from './shares';
import { createShareTrustStore } from './trust-store';

const SERVER = 'https://link.example.test';
const INVITATION = 'a'.repeat(43);
const LINK = buildProviderShareLink(INVITATION, SERVER);
const owner = { displayName: 'Magi', avatarUrl: null, region: 'global' };

function service(options: { state?: string; statuses?: string[]; received?: unknown[] } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const statuses = [...(options.statuses ?? ['approved'])];
  const transport = {
    deviceLinkApiBaseUrl: SERVER,
    isCurrent: () => true,
    async identityRequest(path: string, body: unknown) { calls.push({ path, method: 'POST', body }); return { card: 'identity-card' }; },
    async request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
      calls.push({ path, ...init });
      const base = '/api/device-link/provider-shares';
      if (path === `${base}/preview`) return { shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', deviceName: 'Cindy', owner, state: options.state ?? 'unused', expiresAt: new Date().toISOString() };
      if (path === `${base}/requests`) return { requestId: 'req-1', status: 'pending', pairingCode: '4821', expiresAt: new Date().toISOString() };
      if (path === `${base}/requests/req-1`) return { requestId: 'req-1', status: statuses.shift() ?? 'pending', pairingCode: '4821', expiresAt: new Date().toISOString() };
      if (path === `${base}/received`) return { shares: options.received ?? [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { transport, calls, posted: (suffix: string) => calls.some(call => call.method === 'POST' && call.path.endsWith(suffix)) };
}

function deps(shares: ReturnType<typeof createGuestShares>, answer: string) {
  const lines: string[] = [];
  return { lines, value: { shares, t: createTranslator('en'), output: (line: string) => lines.push(line), ask: async () => answer, wait: async () => {} } };
}

const received = (status: 'active' | 'paused') => ({ shareId: 'share-1', memberId: 'member-1', providerId: 'anthropic', providerLabel: 'Anthropic',
  hostDeviceId: 'host-device', deviceName: 'Cindy', owner, status, hostOnline: true, hostCapable: true });

describe('cindy received', () => {
  it('shows who shares what and sends nothing when the user declines', async () => {
    const api = service();
    const { lines, value } = deps(createGuestShares(api.transport), 'n');
    expect(await runReceived(['join', LINK], value)).toBe(1);
    expect(lines.join('\n')).toContain('Magi wants to share Anthropic with you');
    expect(lines.join('\n')).toContain("pass through Magi's computer");
    expect(lines.at(-1)).toBe('Request not sent. The link stays unused until it expires.');
    expect(api.posted('/requests')).toBe(false);
  });

  it('sends a request bound to the invitation, shows the pairing code and waits for approval', async () => {
    const api = service({ statuses: ['pending', 'approved'] });
    const { lines, value } = deps(createGuestShares(api.transport), 'y');
    expect(await runReceived(['join', LINK], value)).toBe(0);
    expect(api.calls.find(call => call.path === '/api/me/identity-card')?.body)
      .toEqual({ audience: 'cindy-provider-share', purpose: 'share-request', nonce: createHash('sha256').update(INVITATION).digest('hex') });
    expect(lines).toContain('Pairing code: 4821');
    expect(lines.at(-1)).toBe('Magi shared Anthropic with you. Choose it with /model in cindy.');
  });

  it.each([
    ['a used link', service({ state: 'used' }), LINK, /already used or has expired/],
    ['a link from another region', service(), buildProviderShareLink(INVITATION, 'https://link.other-region.test'), null],
  ])('does not ask for %s', async (_name, api, link, message) => {
    const { lines, value } = deps(createGuestShares(api.transport), 'y');
    const run = runReceived(['join', link], value);
    if (message) { expect(await run).toBe(1); expect(lines.join('\n')).toMatch(message); }
    else {
      await expect(run).rejects.toEqual(new CliError('SHARE_OTHER_REGION', 'error.shareOtherRegion'));
      expect(api.calls).toEqual([]);
    }
    expect(api.posted('/requests')).toBe(false);
  });

  it('persists trust only after an explicit command and reports the saved state in status and list', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-received-trust-'));
    try {
      const api = service({ received: [received('active')] });
      const reopen = async () => createGuestShares(api.transport, { trust: await createShareTrustStore(dir, 'account-a', 'global') });
      const first = deps(await reopen(), 'unused');
      first.value.ask = async () => { throw new Error('Explicit trust command must not ask again'); };
      expect(await runReceived(['trust', 'member-1'], first.value)).toBe(0);
      expect(first.lines.join('\n')).toContain('persistent trust off');
      expect(await runReceived(['trust', 'member-1', 'on'], first.value)).toBe(0);
      expect(first.lines.join('\n')).toContain('including access to credentials');
      expect(first.lines.join('\n')).toContain("task's normal permission mode still applies");
      expect(first.lines.join('\n')).toContain('current account in this local Cindy data directory');
      const second = deps(await reopen(), 'unused');
      expect(await runReceived(['trust', 'member-1'], second.value)).toBe(0);
      expect(second.lines[0]).toContain('trusted (includes credentials)');
      expect(await runReceived(['list'], second.value)).toBe(0);
      expect(second.lines.at(-1)).toContain('trusted (includes credentials) · member member-1');
      const chinese = deps(second.value.shares, 'unused');
      chinese.value.t = createTranslator('zh');
      expect(await runReceived(['trust', 'member-1'], chinese.value)).toBe(0);
      expect(chinese.lines[0]).toContain('已信任（含凭证）');
      expect(await runReceived(['trust', 'member-1', 'off'], second.value)).toBe(0);
      expect(second.lines.join('\n')).toContain('existing grants for this task remain in effect');
      const third = deps(await reopen(), 'unused');
      expect(await runReceived(['trust', 'member-1'], third.value)).toBe(0);
      expect(third.lines[0]).toContain('persistent trust off');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects unknown member IDs and malformed trust arguments without enabling trust', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-received-trust-invalid-'));
    try {
      const api = service({ received: [received('active')] });
      const shares = createGuestShares(api.transport, { trust: await createShareTrustStore(dir, 'account-a', 'global') });
      const { lines, value } = deps(shares, 'unused');
      for (const args of [['trust'], ['trust', 'member-1', 'yes'], ['trust', 'member-1', 'on', 'extra']]) {
        expect(await runReceived(args, value)).toBe(1);
        expect(lines.at(-1)).toContain('cindy received trust MEMBER_ID [on|off]');
      }
      expect(api.calls).toEqual([]);
      await expect(runReceived(['trust', 'share-1', 'on'], value))
        .rejects.toEqual(new CliError('SHARE_NOT_FOUND', 'error.shareNotFound'));
      expect(shares.isTrusted('share-1')).toBe(false);
      const reopened = createGuestShares(api.transport, { trust: await createShareTrustStore(dir, 'account-a', 'global') });
      expect(await runReceived(['trust', 'member-1'], deps(reopened, 'unused').value)).toBe(0);
      expect(reopened.isTrusted('share-1')).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('routes shared tasks to the sharer and refuses paused or removed shares', async () => {
    const active = createGuestShares(service({ received: [received('active')] }).transport);
    expect(await active.resolveTarget('share:share-1')).toBe(providerShareHostPeer('share-1', 'host-device'));
    expect(await active.resolveTarget('same-account-device')).toBe('same-account-device');
    await expect(createGuestShares(service({ received: [received('paused')] }).transport).resolveTarget('share:share-1')).rejects.toEqual(new ShareError('PAUSED'));
    await expect(createGuestShares(service({ received: [] }).transport).resolveTarget('share:share-1')).rejects.toEqual(new ShareError('REMOVED'));
  });
});

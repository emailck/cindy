/**
 * 测试价值
 * - 生产入口与可观察结果：真实 ShareTrustStore 文件 + GuestShares API；明确开启才信任，重启保留，账号/区域/分享隔离，移除即时撤销。
 * - Bug／规则依据：provider-sharing.md §9.7 本机按账号/区域/分享保存显式开启项，退出或权威名单移除即清除；用户 TRUST-1 授权。
 * - 现有覆盖缺口：received.test 验证命令路径，未覆盖损坏文件、落盘失败与并发撤销/权威刷新时序。
 * - 最小失败输入：同一分享的未完成 enable 后 retain([])，离开期间收到旧名单，离开成功后刷新离线。
 * - tier：unit（官方 API 内存 transport；文件只写系统临时目录，finally 删除测试自己的目录）。
 * - 实测耗时：单文件 vitest Duration 4.47 秒（9 项，执行 147 ms；2026-11-16）。
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createShareTrustStore } from './trust-store';
import { createGuestShares, type ShareTransport } from './shares';

const accountDir = (dir: string, scope = 'account-a') => path.join(dir, 'accounts', createHash('sha256').update(scope).digest('hex'));
const filename = (dir: string, scope = 'account-a') => path.join(accountDir(dir, scope), 'provider-share-trust.json');
async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-share-trust-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const member = (shareId = 'share-1', memberId = 'member-1') => ({ shareId, memberId, providerId: 'anthropic', providerLabel: 'Provider',
  hostDeviceId: 'host-device', deviceName: 'Host', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
  status: 'active', hostOnline: true, hostCapable: true });
function service() {
  const state = { list: [member()], current: true, offline: false, next: null as Promise<unknown> | null, failAfterLeave: false, leaveResponse: null as Promise<unknown> | null };
  const transport: ShareTransport = { isCurrent: () => state.current, deviceLinkApiBaseUrl: 'https://link.example.test', identityRequest: async () => ({}),
    async request(url) {
      if (url.endsWith('/leave')) { await state.leaveResponse; state.list = []; state.offline = state.failAfterLeave; return {}; }
      if (!url.endsWith('/received')) throw new Error('unexpected route');
      if (state.offline) throw new Error('offline');
      const pending = state.next; state.next = null;
      return pending ?? { shares: state.list };
    } };
  return { state, transport };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('local provider-share trust and authoritative membership', () => {
  it('persists explicit overrides privately across restart without crossing account, region or share', () => temporary(async dir => {
    const global = await createShareTrustStore(dir, 'account-a', 'global');
    const other = await createShareTrustStore(dir, 'account-b', 'global');
    const cn = await createShareTrustStore(dir, 'account-a', 'cn');
    expect(global.isTrusted('share-1')).toBe(false);
    await global.setTrusted('share-1', true);
    await cn.setTrusted('share-2', true);
    expect(other.isTrusted('share-1')).toBe(false);
    expect(cn.isTrusted('share-1')).toBe(false);
    const reopened = await createShareTrustStore(dir, 'account-a', 'global');
    expect(reopened.isTrusted('share-1')).toBe(true);
    expect(reopened.isTrusted('share-2')).toBe(false);
    await reopened.retain([]);
    expect((await createShareTrustStore(dir, 'account-a', 'global')).isTrusted('share-1')).toBe(false);
    expect((await createShareTrustStore(dir, 'account-a', 'cn')).isTrusted('share-2')).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(accountDir(dir))).mode & 0o777).toBe(0o700);
      expect((await stat(filename(dir))).mode & 0o777).toBe(0o600);
    }
    const document = await readFile(filename(dir), 'utf8');
    expect(document).not.toContain('account-a');
    expect(document).not.toContain('Owner');
    expect((await readdir(accountDir(dir))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  }));

  it('fails closed on malformed preferences without preventing discovery or overwriting them', () => temporary(async dir => {
    await mkdir(accountDir(dir), { recursive: true, mode: 0o700 });
    const malformed = '{"version":1,"trusted":{"[\\"global\\",\\"share-1\\"]":"true"}}';
    await writeFile(filename(dir), malformed, { mode: 0o600 });
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    expect(trust.isTrusted('share-1')).toBe(false);
    await trust.retain([]);
    await expect(trust.setTrusted('share-1', true)).rejects.toThrow('INVALID_SHARE_TRUST_STORE');
    const api = service();
    const shares = createGuestShares(api.transport, { trust });
    expect(await shares.refresh()).toHaveLength(1);
    expect(shares.isTrusted('share-1')).toBe(false);
    expect(await readFile(filename(dir), 'utf8')).toBe(malformed);
  }));

  it.skipIf(process.platform === 'win32')('does not follow an account directory alias into another account trust', () => temporary(async dir => {
    const other = await createShareTrustStore(dir, 'account-b', 'global');
    await other.setTrusted('share-1', true);
    await symlink(accountDir(dir, 'account-b'), accountDir(dir));
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    expect(trust.isTrusted('share-1')).toBe(false);
    await expect(trust.setTrusted('share-1', true)).rejects.toThrow('INVALID_SHARE_TRUST_STORE');
  }));

  it('revokes immediately despite a failed disk write and cancels an older queued enable', () => temporary(async dir => {
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    const enable = trust.setTrusted('share-1', true);
    const prune = trust.retain([]);
    expect(trust.isTrusted('share-1')).toBe(false);
    await expect(enable).rejects.toThrow('SHARE_TRUST_REVOKED');
    await prune;
    await trust.setTrusted('share-1', true);
    await rename(filename(dir), `${filename(dir)}.backup`);
    await mkdir(filename(dir));
    const disable = trust.setTrusted('share-1', false);
    expect(trust.isTrusted('share-1')).toBe(false);
    await expect(disable).rejects.toThrow();
    await rm(filename(dir), { recursive: true });
    await rename(`${filename(dir)}.backup`, filename(dir));
    await trust.setTrusted('share-1', false);
    expect((await createShareTrustStore(dir, 'account-a', 'global')).isTrusted('share-1')).toBe(false);
  }));

  it('requires exact current membership, retains offline trust and prunes authoritative removal', () => temporary(async dir => {
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    const { state, transport } = service();
    const shares = createGuestShares(transport, { trust });
    await expect(shares.setTrusted('share-1', true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await shares.setTrusted('member-1', true);
    expect(shares.isTrusted('share-1')).toBe(true);
    state.offline = true;
    await expect(shares.refresh()).rejects.toThrow('offline');
    expect(shares.isTrusted('share-1')).toBe(true);
    state.offline = false; state.list = [];
    await shares.refresh();
    expect(shares.isTrusted('share-1')).toBe(false);
    expect((await createShareTrustStore(dir, 'account-a', 'global')).isTrusted('share-1')).toBe(false);
    await expect(createGuestShares(transport).setTrusted('member-1', true)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  }));

  it('successful leave revokes across restart even offline, and old refresh cannot restore membership', () => temporary(async dir => {
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    const { state, transport } = service();
    const shares = createGuestShares(transport, { trust });
    await shares.setTrusted('member-1', true);
    const old = deferred<unknown>(); state.next = old.promise;
    const refreshing = shares.refresh();
    const observed = refreshing.catch(error => error);
    state.failAfterLeave = true;
    await shares.leave('member-1');
    expect(shares.isTrusted('share-1')).toBe(false);
    old.resolve({ shares: [member()] });
    expect(await observed).toMatchObject({ code: 'UNAVAILABLE' });
    expect(shares.received()).toEqual([]);
    expect((await createShareTrustStore(dir, 'account-a', 'global')).isTrusted('share-1')).toBe(false);
  }));

  it('rejects late-account membership before enabling or publishing its cache', () => temporary(async dir => {
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    const { state, transport } = service();
    const shares = createGuestShares(transport, { trust });
    const response = deferred<unknown>(); state.next = response.promise;
    const enabling = shares.setTrusted('member-1', true);
    state.current = false;
    response.resolve({ shares: [member()] });
    await expect(enabling).rejects.toThrow();
    expect(shares.received()).toEqual([]);
    expect(shares.isTrusted('share-1')).toBe(false);
    expect(trust.isTrusted('share-1')).toBe(false);
  }));

  it('revokes while leave is pending and keeps trust off when the server rejects leaving', () => temporary(async dir => {
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    const { state, transport } = service();
    const shares = createGuestShares(transport, { trust });
    await shares.setTrusted('member-1', true);
    let reject!: (error: Error) => void;
    state.leaveResponse = new Promise((_, fail) => { reject = fail; });
    const leaving = shares.leave('member-1');
    const observed = leaving.catch(error => error);
    expect(shares.isTrusted('share-1')).toBe(false);
    await expect(shares.setTrusted('member-1', true)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    reject(new Error('leave rejected'));
    expect(await observed).toMatchObject({ message: 'leave rejected' });
    expect(shares.received()).toHaveLength(1);
    expect(shares.isTrusted('share-1')).toBe(false);
    expect((await createShareTrustStore(dir, 'account-a', 'global')).isTrusted('share-1')).toBe(false);
  }));

  it('does not acknowledge an older enable after a newer off has finished', () => temporary(async dir => {
    const trust = await createShareTrustStore(dir, 'account-a', 'global');
    const written = deferred<void>();
    const release = deferred<void>();
    const wrapped = { ...trust, async setTrusted(id: string, enabled: boolean) {
      await trust.setTrusted(id, enabled);
      if (enabled) { written.resolve(); await release.promise; }
    } };
    const { transport } = service();
    const shares = createGuestShares(transport, { trust: wrapped });
    const enabling = shares.setTrusted('member-1', true).catch(error => error);
    await written.promise;
    await shares.setTrusted('member-1', false);
    release.resolve();
    expect(await enabling).toMatchObject({ code: 'UNAVAILABLE' });
    expect(shares.isTrusted('share-1')).toBe(false);
  }));
});

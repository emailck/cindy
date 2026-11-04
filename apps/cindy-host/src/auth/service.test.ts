import { afterEach, describe, expect, it, vi } from 'vitest';
import { CindyAuthClient, serializeAuthSessionRecord, type AuthFetch, type AuthMembership } from '@cindy/auth-client';

import { createHostAuthService } from './service.js';
import { getOrCreateDeviceIdentity, type ProtectedCredentialStore } from './store.js';
import { runAuthCommand } from './command.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：真实 CindyAuthClient + createHostAuthService；登录、受保护轮换、退出与恢复。
 * - 规则依据：CLI-003；credentials-and-local-storage「凭证不入仓」；auth-realm-routing「认证记录」。
 * - 现有覆盖缺口：auth-client 只测 API；Desktop 测试不覆盖 Node CLI 生命周期和注入的秘密库。
 * - 最小失败输入：账号选择票据、错误区域记录、轮换后退出、持久化失败或后端带秘密的错误。
 * - tier：unit；进程内内存存储和 HTTP transport fake，不访问真实目录、凭证库或网络。
 * - 实测耗时：Node 22.22 / pnpm 10.33.2，单 worker 22 条墙钟 1.57s，断言 35ms。
 */
const membership: AuthMembership = {
  id: 'invalid-fixture-membership', kind: 'personal', role: 'owner',
  displayName: 'Fixture', email: null, orgId: null, orgName: null,
};
const pair = {
  accessToken: 'invalid-fixture-access', refreshToken: 'invalid-fixture-refresh', membership,
};
const key = 'auth-session.v1.global';
afterEach(() => { vi.useRealTimers(); });

function memoryStore() {
  const entries = new Map<string, string>();
  const store: ProtectedCredentialStore = {
    assertAvailable: async () => undefined,
    get: async (entry) => entries.get(entry) ?? null,
    set: async (entry, value) => { entries.set(entry, value); },
    delete: async (entry) => { entries.delete(entry); },
  };
  return { store, entries };
}

function fixture(handler: (path: string, body: Record<string, unknown>) => unknown | Promise<unknown>, random = () => 0) {
  const { store, entries } = memoryStore();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: AuthFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ path, body });
    const result = await handler(path, body);
    if (result instanceof Error) throw result;
    const response = result as { httpError?: number; error?: unknown; retryAfter?: string };
    return { ok: !response.httpError, status: response.httpError ?? 200,
      headers: { get: (name) => name === 'retry-after' ? response.retryAfter ?? null : null }, json: async () => result };
  };
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.invalid', region: 'global', deviceId: 'fixture-device', clientType: 'desktop', fetch,
  });
  const service = createHostAuthService({ store, region: 'global', client, authApiBaseUrl: 'https://auth.invalid', random });
  return { service, store, entries, calls };
}

describe('CLI protected authentication lifecycle', () => {
  it('keeps selection tickets private and persists only the official refresh record after selection', async () => {
    const f = fixture((path, body) => {
      if (path.endsWith('verify-code')) return { status: 'select_account', loginTicket: 'invalid-fixture-ticket', accounts: [membership] };
      expect(body).toMatchObject({ loginTicket: 'invalid-fixture-ticket', accountId: membership.id });
      return { status: 'ok', ...pair };
    });
    const choice = await f.service.verifyCode('email', 'fixture@example.invalid', '000000');
    expect(choice).toEqual({ status: 'select_account', accounts: [membership] });
    expect(f.entries.has(key)).toBe(false);
    await expect(f.service.selectAccount('other-account')).rejects.toMatchObject({ code: 'INVALID_LOGIN_TICKET' });
    expect(await f.service.selectAccount(membership.id)).toEqual({ status: 'ok', membership });
    expect(JSON.parse(f.entries.get(key)!)).toEqual({ version: 1, realm: 'global', refreshToken: pair.refreshToken });
    expect(f.service.getAccessToken()).toBe(pair.accessToken);
    expect(JSON.stringify(f.service.status())).not.toContain('invalid-fixture-access');
    expect(f.entries.size).toBe(1);
  });

  it('blocks sending codes and accepting login when the secret backend is unavailable', async () => {
    const f = fixture(() => ({ status: 'ok', ...pair }));
    f.store.assertAvailable = async () => { throw new Error('backend leaked invalid-fixture-secret'); };
    await expect(f.service.requestCode('email', 'fixture@example.invalid')).rejects.toThrow('CREDENTIAL_STORE_UNAVAILABLE');
    await expect(f.service.verifyCode('email', 'fixture@example.invalid', '000000')).rejects.toThrow('CREDENTIAL_STORE_UNAVAILABLE');
    expect(f.calls).toEqual([]);
    expect(f.service.status().authenticated).toBe(false);
  });

  it('does not expose authenticated state if saving a rotated refresh token fails', async () => {
    const f = fixture(() => ({ status: 'ok', ...pair }));
    f.store.set = async () => { throw new Error(pair.refreshToken); };
    await expect(f.service.verifyCode('email', 'fixture@example.invalid', '000000')).rejects.toThrow('CREDENTIAL_STORE_UNAVAILABLE');
    expect(f.service.getAccessToken()).toBeNull();
    expect(f.service.status().authenticated).toBe(false);
  });

  it('restores and rotates official refresh tokens before exposing access', async () => {
    const f = fixture((_path, body) => {
      expect(body).toEqual({ refreshToken: 'invalid-fixture-previous', deviceId: 'fixture-device' });
      return pair;
    });
    f.entries.set(key, serializeAuthSessionRecord('global', 'invalid-fixture-previous'));
    expect(await f.service.restore()).toBe(true);
    expect(f.service.status()).toEqual({ authenticated: true, region: 'global', membership });
    expect(JSON.parse(f.entries.get(key)!).refreshToken).toBe(pair.refreshToken);
  });

  it.each(['INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_EXPIRED', 'ACCOUNT_UNAVAILABLE', 'MEMBERSHIP_DISABLED'])(
    'expires the saved session only after definitive server rejection: %s', async (code) => {
      const f = fixture(() => ({ httpError: 401, error: { code, message: 'invalid-fixture-server-message' } }));
      f.entries.set(key, serializeAuthSessionRecord('global', pair.refreshToken));
      await expect(f.service.restore()).rejects.toMatchObject({ code });
      expect(f.entries.has(key)).toBe(false);
      expect(f.service.status().authenticated).toBe(false);
    },
  );

  it.each([
    { httpError: 503, error: { code: 'SERVER_BUSY' } },
    { httpError: 401, error: { code: 'DEVICE_MISMATCH' } },
  ])('retains protected credentials on transient failure or device mismatch', async (response) => {
    const f = fixture(() => response);
    const saved = serializeAuthSessionRecord('global', pair.refreshToken);
    f.entries.set(key, saved);
    await expect(f.service.restore()).rejects.toBeDefined();
    expect(f.entries.get(key)).toBe(saved);
    expect(f.service.getAccessToken()).toBeNull();
  });

  it('refuses a peer-region record without transmitting its refresh token', async () => {
    const f = fixture(() => pair);
    f.entries.set(key, serializeAuthSessionRecord('cn', pair.refreshToken));
    await expect(f.service.restore()).rejects.toMatchObject({ code: 'AUTH_SESSION_INVALID' });
    expect(f.calls).toEqual([]);
    expect(f.entries.has(key)).toBe(true);
  });

  it('completes official binding and SSO verification without exposing their tickets', async () => {
    const f = fixture((path) => {
      if (path.endsWith('verify-code')) return { status: 'binding_required', bindType: 'email', bindTicket: 'invalid-fixture-binding' };
      if (path.endsWith('binding/verify')) return {
        status: 'sso_verification_required', verificationTicket: 'invalid-fixture-sso', channel: 'email', targetMasked: 'f***@example.invalid',
      };
      if (path.endsWith('sso/verification/verify')) return { status: 'ok', ...pair };
      return { status: 'sent' };
    });
    expect(await f.service.verifyCode('phone', 'invalid-fixture-phone', '000000')).toEqual({ status: 'binding_required', bindType: 'email' });
    await f.service.requestBindingCode('fixture@example.invalid');
    expect(await f.service.verifyBinding('fixture@example.invalid', '000000')).toEqual({
      status: 'sso_verification_required', channel: 'email', targetMasked: 'f***@example.invalid',
    });
    await f.service.requestSsoVerificationCode();
    expect(await f.service.verifySsoVerification('000000')).toEqual({ status: 'ok', membership });
    expect(f.entries.has(key)).toBe(true);
  });

  it('uses separate hosted poll credentials and PKCE verifier, completing the official exchange', async () => {
    const f = fixture((path) => path.endsWith('/poll') ? { status: 'ok', code: 'invalid-fixture-auth-code' } : { status: 'ok', ...pair });
    const url = new URL(await f.service.startBrowserLogin({ kind: 'social', providerOrConnectionId: 'google' }));
    expect(url.searchParams.get('redirect_uri')).toBe('https://auth.invalid/api/auth/desktop/callback');
    expect(await f.service.pollBrowserLogin()).toEqual({ status: 'ok', membership });
    const pollSecret = f.calls[0]!.body.pollSecret;
    const verifier = f.calls[1]!.body.codeVerifier;
    expect(pollSecret).toBeTypeOf('string');
    expect(verifier).toBeTypeOf('string');
    expect(url.toString()).not.toContain(pollSecret as string);
    expect(url.toString()).not.toContain(verifier as string);
    await expect(f.service.pollBrowserLogin()).rejects.toMatchObject({ code: 'INVALID_AUTH_CODE' });
  });

  it('serializes an in-flight rotation before logout and clears local login even if remote logout fails', async () => {
    let release: (value: typeof pair) => void = () => undefined;
    const rotating = new Promise<typeof pair>((resolve) => { release = resolve; });
    const f = fixture((path) => path.endsWith('/refresh') ? rotating : { httpError: 503, error: { code: 'SERVER_BUSY' } });
    f.entries.set(key, serializeAuthSessionRecord('global', pair.refreshToken));
    const refresh = f.service.refresh();
    const logout = f.service.logout();
    let drained = false;
    const drain = f.service.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release(pair);
    expect(await refresh).toBe(true);
    expect(await logout).toEqual({ remoteRevoked: false });
    expect(f.entries.has(key)).toBe(false);
    expect(f.service.status().authenticated).toBe(false);
    expect(f.service.getAccessToken()).toBeNull();
    await drain;
    expect(drained).toBe(true);
  });

  it('preserves a stable installation identity across recreation and logout, without touching real stores', async () => {
    const f = fixture(() => ({ status: 'ok', ...pair }));
    const identity = await getOrCreateDeviceIdentity(f.store);
    expect(await getOrCreateDeviceIdentity(f.store)).toBe(identity);
    await f.service.verifyCode('email', 'fixture@example.invalid', '000000');
    await f.service.logout();
    expect(await getOrCreateDeviceIdentity(f.store)).toBe(identity);
    f.entries.set('device-identity.v1', 'invalid-corrupted-identity');
    await expect(getOrCreateDeviceIdentity(f.store)).rejects.toThrow('CREDENTIAL_STORE_UNAVAILABLE');
  });

  it('keeps the runtime owner stable during rotation and changes it after signing in again', async () => {
    const f = fixture((path) => path.endsWith('/logout') ? { status: 'ok' } : { status: 'ok', ...pair });
    await f.service.verifyCode('email', 'fixture@example.invalid', '000000');
    const first = f.service.captureOwner();
    expect(first).not.toBeNull();
    await f.service.refresh();
    expect(f.service.captureOwner()).toBe(first);
    await f.service.logout();
    expect(f.service.captureOwner()).toBeNull();
    await f.service.verifyCode('email', 'fixture@example.invalid', '000000');
    expect(f.service.captureOwner()).not.toBe(first);
  });

  it('keeps the owner through transient refresh recovery but fences it after revocation', async () => {
    vi.useFakeTimers();
    let failure: string | null = null;
    const f = fixture(() => failure
      ? { httpError: failure === 'SERVER_BUSY' ? 503 : 401, error: { code: failure } }
      : { status: 'ok', ...pair });
    await f.service.verifyCode('email', 'fixture@example.invalid', '000000');
    const owner = f.service.captureOwner();
    const scope = f.service.storageScope();
    failure = 'SERVER_BUSY';
    await expect(f.service.refresh()).rejects.toMatchObject({ code: 'SERVER_BUSY' });
    expect(f.service.getAccessToken()).toBeNull();
    expect(f.service.captureOwner()).toBe(owner);
    expect(f.service.storageScope()).toBe(scope);
    failure = null;
    vi.setSystemTime(Date.now() + 60_000);
    await f.service.refresh();
    expect(f.service.captureOwner()).toBe(owner);
    expect(f.service.getAccessToken()).toBe(pair.accessToken);
    failure = 'INVALID_REFRESH_TOKEN';
    await expect(f.service.refresh()).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(f.service.captureOwner()).toBeNull();
    expect(f.entries.has(key)).toBe(false);
  });

  it('coalesces refresh requests and honors Retry-After without extending or skipping the deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let failure: string | null = 'RATE_LIMITED';
    const f = fixture(() => failure ? {
      httpError: failure === 'RATE_LIMITED' ? 429 : 503, error: { code: failure },
      ...(failure === 'RATE_LIMITED' ? { retryAfter: '600' } : {}),
    } : { status: 'ok', ...pair }, () => 0.5);
    f.entries.set(key, serializeAuthSessionRecord('global', pair.refreshToken));
    const results = await Promise.allSettled([f.service.refresh(), f.service.restore(), f.service.getToken()]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(f.calls).toHaveLength(1);
    const deadline = startedAt + 630_000;
    await expect(f.service.getToken()).rejects.toMatchObject({ code: 'AUTH_REFRESH_BACKOFF', retryAt: deadline });
    vi.setSystemTime(deadline - 1);
    await expect(f.service.refresh()).rejects.toMatchObject({ code: 'AUTH_REFRESH_BACKOFF', retryAt: deadline });
    expect(f.calls).toHaveLength(1);
    failure = null;
    vi.setSystemTime(deadline);
    expect(await f.service.getToken()).toBe(pair.accessToken);
    failure = 'SERVER_BUSY';
    await expect(f.service.refresh()).rejects.toMatchObject({ code: 'SERVER_BUSY', retryAt: deadline + 90_000 });
  });

  it('retries saving an authoritative rotation after keyring recovery without consuming the stale token again', async () => {
    vi.useFakeTimers();
    const rotated = { ...pair, refreshToken: 'invalid-fixture-rotated' };
    const f = fixture((path) => ({ status: 'ok', ...(path.endsWith('/refresh') ? rotated : pair) }));
    await f.service.verifyCode('email', 'fixture@example.invalid', '000000');
    const write = f.store.set;
    f.store.set = async () => { throw new Error('invalid-fixture-backend-failure'); };
    await expect(f.service.refresh()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    expect(f.service.getAccessToken()).toBeNull();
    f.store.set = write;
    vi.setSystemTime(Date.now() + 60_000);
    expect(await f.service.restore()).toBe(true);
    expect(f.calls.filter((call) => call.path.endsWith('/refresh'))).toHaveLength(1);
    expect(JSON.parse(f.entries.get(key)!).refreshToken).toBe(rotated.refreshToken);
    expect(f.service.getAccessToken()).toBe(pair.accessToken);
  });

  it('interactive CLI completes email discovery and verification without printing secrets', async () => {
    const f = fixture((path) => {
      if (path.endsWith('/providers')) return { region: 'global', attribution: 'email', email: true, phone: false, social: [] };
      if (path.endsWith('/discovery')) return { methods: [{ type: 'email_code' }] };
      if (path.endsWith('/request-code')) return { status: 'sent' };
      return { status: 'ok', ...pair };
    });
    const lines: string[] = [];
    expect(await runAuthCommand(['login', '--email', 'fixture@example.invalid'], {
      service: f.service, output: (line) => { lines.push(line); }, prompt: async () => '000000',
    })).toBe(0);
    expect(lines.join('\n')).not.toContain(pair.accessToken);
    expect(lines.join('\n')).not.toContain(pair.refreshToken);
    expect(lines.join('\n')).not.toContain('000000');
    expect(f.service.status().authenticated).toBe(true);
  });

  it('interactive CLI honors required CAPTCHA and refuses verification codes in argv', async () => {
    const f = fixture((path) => path.endsWith('/providers')
      ? { region: 'global', attribution: 'email', email: true, phone: false, social: [], captcha: { provider: 'turnstile', siteKey: 'invalid-fixture-public-key', requiredFor: ['email_request_code'] } }
      : { methods: [{ type: 'email_code' }] });
    const context = { service: f.service, output: (_line: string) => undefined, prompt: async () => '000000' };
    await expect(runAuthCommand(['login', '--email', 'fixture@example.invalid'], context)).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
    expect(f.calls.some((call) => call.path.endsWith('/request-code'))).toBe(false);
    await expect(runAuthCommand(['login', '--code', '000000'], context)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('cancels a browser polling wait without another request or success output', async () => {
    const f = fixture((path) => path.endsWith('/providers')
      ? { region: 'global', attribution: 'email', email: true, phone: false, social: ['google'] }
      : { status: 'pending' });
    const controller = new AbortController();
    const lines: string[] = [];
    await expect(runAuthCommand(['login', '--social', 'google'], {
      service: f.service, output: (line) => { lines.push(line); }, prompt: async () => '', signal: controller.signal,
      wait: async () => { controller.abort(); },
    })).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
    expect(f.calls.filter((call) => call.path.endsWith('/poll'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('authenticated'))).toBe(false);
  });
});

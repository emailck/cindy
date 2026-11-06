import { createHash, randomBytes } from 'node:crypto';
import {
  AuthApiError,
  parseAuthSessionRecord,
  serializeAuthSessionRecord,
  type AuthMembership,
  type AuthRegion,
  type AuthTokenPair,
  type CindyAuthClient,
  type LoginOutcome,
  type VerificationKind,
} from '@cindy/auth-client';

import { HostAuthError, protectedStoreCall, type ProtectedCredentialStore } from './store.js';
import { accountSnapshotKey, authSessionKey, serializeAccountSnapshot } from './account-projection.js';

export type HostLoginResult =
  | { status: 'ok'; membership: AuthMembership }
  | { status: 'select_account'; accounts: AuthMembership[] }
  | { status: 'binding_required'; bindType: VerificationKind }
  | { status: 'sso_verification_required'; channel: 'email' | 'sms'; targetMasked: string };

export interface HostAuthOptions {
  store: ProtectedCredentialStore;
  region: AuthRegion;
  client: CindyAuthClient;
  /** Must be the same trusted endpoint used to construct client. */
  authApiBaseUrl: string;
  /** Injectable entropy only; the policy remains the official refresh retry policy. */
  random?: () => number;
}

/** Auth tickets and tokens remain private to the trusted Node host. Never print this object. */
export function createHostAuthService(options: HostAuthOptions) {
  const { store, client, region } = options;
  const sessionKey = authSessionKey(region);
  const snapshotKey = accountSnapshotKey(region);
  let session: AuthTokenPair | null = null;
  let pending: Exclude<LoginOutcome, { status: 'ok' }> | null = null;
  let browser: { verifier: string; pollSecret: string } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let owner: { id: string; incarnation: number } | null = null;
  let incarnation = 0;
  let refreshFailures = 0;
  let refreshRetryAt = 0;
  let refreshInFlight: Promise<boolean> | null = null;
  // A successful rotation must survive a temporary keyring write failure within this process.
  let pendingRotation: AuthTokenPair | null = null;

  function clearRefreshWait() { refreshFailures = 0; refreshRetryAt = 0; }

  // Serialize rotations, login and logout: a late refresh must never restore a logged-out account.
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation).catch((error: unknown) => {
      if (error instanceof HostAuthError) throw error;
      if (error instanceof AuthApiError) throw new HostAuthError(error.code, error.retryAt);
      throw new HostAuthError('AUTH_REQUEST_FAILED');
    });
    queue = result.catch(() => undefined);
    return result;
  }

  async function available() {
    await protectedStoreCall(() => store.assertAvailable());
  }

  async function commit(pair: AuthTokenPair): Promise<void> {
    // Save rotation before exposing the new access token. Failure leaves the host unauthenticated.
    session = null;
    const serializedSession = serializeAuthSessionRecord(region, pair.refreshToken);
    await protectedStoreCall(() => store.set(sessionKey, serializedSession));
    session = pair;
    pendingRotation = null;
    clearRefreshWait();
    if (owner?.id !== pair.membership.id) owner = { id: pair.membership.id, incarnation: ++incarnation };
    pending = null;
    browser = null;
    // Display cache failure must never discard a successfully committed rotation. A stale
    // cache is suppressed by its binding to the current serialized refresh record.
    try { await store.set(snapshotKey, serializeAccountSnapshot(region, serializedSession, pair.membership)); }
    catch { /* Optional metadata only; do not fail login or retry a consumed refresh token. */ }
  }

  async function discardSnapshot() {
    try { await store.delete(snapshotKey); } catch { /* Missing session always suppresses this cache. */ }
  }

  async function accept(outcome: LoginOutcome): Promise<HostLoginResult> {
    if (outcome.status === 'ok') {
      await commit(outcome);
      return { status: 'ok', membership: outcome.membership };
    }
    pending = outcome;
    switch (outcome.status) {
      case 'select_account': return { status: outcome.status, accounts: outcome.accounts };
      case 'binding_required': return { status: outcome.status, bindType: outcome.bindType };
      case 'sso_verification_required': return {
        status: outcome.status, channel: outcome.channel, targetMasked: outcome.targetMasked,
      };
    }
  }

  async function refreshSession(): Promise<boolean> {
    // Same process-local policy as Desktop AuthRefreshBackoff. Relay/resume signals cannot shorten it.
    if (refreshRetryAt > Date.now()) throw new HostAuthError('AUTH_REFRESH_BACKOFF', refreshRetryAt);
    try {
      await available();
      if (pendingRotation) {
        await commit(pendingRotation);
        return true;
      }
      const raw = await protectedStoreCall(() => store.get(sessionKey));
      if (raw === null) { session = null; owner = null; clearRefreshWait(); return false; }
      const record = parseAuthSessionRecord(raw);
      if (!record || record.realm !== region) {
        owner = null;
        // Never send a malformed or peer-region credential to this auth endpoint.
        throw new HostAuthError('AUTH_SESSION_INVALID');
      }
      const pair = await client.refresh(record.refreshToken);
      pendingRotation = pair;
      await commit(pair);
      return true;
    } catch (error) {
      session = null;
      // Same terminal outcomes as the official Desktop refresh path; transient errors retain storage.
      if (error instanceof AuthApiError && ['INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_EXPIRED', 'ACCOUNT_UNAVAILABLE', 'MEMBERSHIP_DISABLED'].includes(error.code)) {
        owner = null;
        clearRefreshWait();
        await protectedStoreCall(() => store.delete(sessionKey));
        await discardSnapshot();
        throw error;
      }
      if (error instanceof AuthApiError && error.code === 'DEVICE_MISMATCH') { owner = null; clearRefreshWait(); await discardSnapshot(); throw error; }
      if (error instanceof HostAuthError && error.code === 'AUTH_SESSION_INVALID') { clearRefreshWait(); throw error; }
      const floor = Math.min(60_000 * 2 ** refreshFailures, 300_000);
      refreshFailures = Math.min(refreshFailures + 1, 3);
      const serverRetryAt = error instanceof AuthApiError ? error.retryAt : undefined;
      refreshRetryAt = Math.max(Date.now() + floor, Number.isFinite(serverRetryAt) ? serverRetryAt! : 0)
        + Math.floor((options.random ?? Math.random)() * floor);
      throw new HostAuthError(error instanceof AuthApiError || error instanceof HostAuthError ? error.code : 'AUTH_REQUEST_FAILED', refreshRetryAt);
    }
  }

  function runRefresh(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;
    const operation = exclusive(refreshSession);
    refreshInFlight = operation;
    void operation.then(() => { if (refreshInFlight === operation) refreshInFlight = null; }, () => { if (refreshInFlight === operation) refreshInFlight = null; });
    return operation;
  }

  return {
    /** Stop token consumers first, then drain before releasing the profile lock. Rotations must not be aborted. */
    async drain(): Promise<void> {
      for (;;) {
        const pendingOperations = queue;
        await pendingOperations;
        if (queue === pendingOperations) return;
      }
    },
    status() {
      return session
        ? { authenticated: true as const, region, membership: session.membership }
        : { authenticated: false as const, region };
    },
    getAccessToken(): string | null { return session?.accessToken ?? null; },
    // A transient transport outage removes token access but does not create a new account incarnation.
    captureOwner(): string | null { return owner ? `${region}:${owner.id}:${owner.incarnation}` : null; },
    storageScope(): string | null { return owner ? `${region}:${owner.id}` : null; },
    getToken: async (): Promise<string | null> => {
      let expiresAt = 0;
      if (session) {
        try {
          const payload = JSON.parse(Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
          if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
        } catch { /* Malformed expiry cannot justify reusing a token. The server still authenticates it. */ }
      }
      if (expiresAt > Date.now() + 60_000) return session!.accessToken;
      return await runRefresh() ? session?.accessToken ?? null : null;
    },
    restore: runRefresh,
    refresh: runRefresh,
    getProviders: () => exclusive(() => client.getProviders()),
    discover: (email: string) => exclusive(() => client.discover(email)),
    discoverSsoOrg: (org: string) => exclusive(() => client.discoverSsoOrg(org)),
    requestCode: (kind: VerificationKind, identifier: string, captcha: { captchaToken?: string } = {}) => exclusive(async () => {
      await available();
      await client.requestCode(kind, identifier, captcha);
    }),
    verifyCode: (kind: VerificationKind, identifier: string, code: string) => exclusive(async () => {
      await available();
      pending = null;
      browser = null;
      owner = null;
      return accept(await client.verifyCode(kind, identifier, code));
    }),
    selectAccount: (accountId: string) => exclusive(async () => {
      await available();
      if (pending?.status !== 'select_account' || !pending.accounts.some((account) => account.id === accountId)) {
        throw new HostAuthError('INVALID_LOGIN_TICKET');
      }
      return accept(await client.selectAccount(pending.loginTicket, accountId));
    }),
    requestBindingCode: (contact: string) => exclusive(async () => {
      await available();
      if (pending?.status !== 'binding_required') throw new HostAuthError('INVALID_BIND_TICKET');
      await client.requestBindingCode(pending.bindTicket, pending.bindType, contact);
    }),
    verifyBinding: (contact: string, code: string) => exclusive(async () => {
      await available();
      if (pending?.status !== 'binding_required') throw new HostAuthError('INVALID_BIND_TICKET');
      return accept(await client.verifyBinding(pending.bindTicket, pending.bindType, contact, code));
    }),
    requestSsoVerificationCode: () => exclusive(async () => {
      await available();
      if (pending?.status !== 'sso_verification_required') throw new HostAuthError('INVALID_SSO_VERIFICATION_TICKET');
      await client.requestSsoVerificationCode(pending.verificationTicket);
    }),
    verifySsoVerification: (code: string) => exclusive(async () => {
      await available();
      if (pending?.status !== 'sso_verification_required') throw new HostAuthError('INVALID_SSO_VERIFICATION_TICKET');
      return accept(await client.verifySsoVerification(pending.verificationTicket, code));
    }),
    startBrowserLogin: (input: { kind: 'social' | 'sso'; providerOrConnectionId: string }) => exclusive(async () => {
      await available();
      pending = null;
      const verifier = randomBytes(32).toString('base64url');
      const pollSecret = randomBytes(32).toString('base64url');
      browser = { verifier, pollSecret };
      return client.buildAuthorizeUrl({
        ...input,
        redirectUri: new URL('/api/auth/desktop/callback', options.authApiBaseUrl).toString(),
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        state: createHash('sha256').update(pollSecret).digest('base64url'),
      });
    }),
    pollBrowserLogin: () => exclusive(async (): Promise<HostLoginResult | { status: 'pending' }> => {
      if (!browser) throw new HostAuthError('INVALID_AUTH_CODE');
      const attempt = browser;
      const result = await client.pollDesktopAuthorization(attempt.pollSecret);
      if (result.status === 'pending') return result;
      browser = null;
      if (result.status === 'expired') throw new HostAuthError('INVALID_AUTH_CODE');
      if (result.status === 'error') throw new HostAuthError(result.error);
      await available();
      return accept(await client.exchangeAuthorizationCode(result.code, attempt.verifier));
    }),
    logout: () => exclusive(async (): Promise<{ remoteRevoked: boolean }> => {
      const accessToken = session?.accessToken;
      session = null;
      owner = null;
      clearRefreshWait();
      pendingRotation = null;
      pending = null;
      browser = null;
      // Clear local credentials even when the network is down. A failed clear is never reported as success.
      await protectedStoreCall(() => store.delete(sessionKey));
      await discardSnapshot();
      if (!accessToken) return { remoteRevoked: false };
      try { await client.logout(accessToken); return { remoteRevoked: true }; }
      catch { return { remoteRevoked: false }; }
    }),
  };
}

export type HostAuthService = ReturnType<typeof createHostAuthService>;

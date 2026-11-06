import { createHash } from 'node:crypto';
import { parseAuthSessionRecord, type AuthRegion } from '@cindy/auth-client';
import type { ProtectedCredentialStore } from './store.js';

/** Public display fields only. Never return a membership or credential record as status. */
export interface CindyAccountIdentity {
  displayName?: string;
  email?: string;
  loginMethod: 'cindy';
  organization?: string;
}

export const accountSnapshotKey = (region: AuthRegion) => `auth-account.v1.${region}`;
export const authSessionKey = (region: AuthRegion) => `auth-session.v1.${region}`;

function displayText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value.trim() || undefined;
}

/** The names differ between the official membership and the public status projection. */
export function projectCindyAccount(membership: unknown): CindyAccountIdentity {
  const fields = membership && typeof membership === 'object' ? membership as Record<string, unknown> : {};
  const displayName = displayText(fields.displayName, 200);
  const email = displayText(fields.email, 320);
  const organization = displayText(fields.orgName, 200);
  return { ...(displayName ? { displayName } : {}), ...(email ? { email } : {}), loginMethod: 'cindy', ...(organization ? { organization } : {}) };
}

function sessionDigest(region: AuthRegion, serializedSession: string): string {
  return createHash('sha256').update('cindy-host-account.v1\0').update(region).update('\0').update(serializedSession).digest('hex');
}

/** Caller commits the authoritative refresh record first and holds the profile lock. */
export function serializeAccountSnapshot(region: AuthRegion, serializedSession: string, membership: unknown): string {
  return JSON.stringify({ version: 1, realm: region, sessionDigest: sessionDigest(region, serializedSession), account: projectCindyAccount(membership) });
}

/** Read only: no refresh, device initialization, cache repair, or remote account request. */
export async function readStoredAuthStatus(store: ProtectedCredentialStore, region: AuthRegion): Promise<{ savedAuthentication: boolean; account: CindyAccountIdentity | null }> {
  const raw = await store.get(authSessionKey(region));
  if (raw === null) return { savedAuthentication: false, account: null };
  const record = parseAuthSessionRecord(raw);
  if (!record || record.realm !== region) return { savedAuthentication: true, account: null };
  let account: CindyAccountIdentity | null = null;
  try {
    const snapshotRaw = await store.get(accountSnapshotKey(region));
    const snapshot = snapshotRaw === null ? null : JSON.parse(snapshotRaw) as Record<string, unknown> | null;
    if (snapshot?.version === 1 && snapshot.realm === region && snapshot.sessionDigest === sessionDigest(region, raw)
      && snapshot.account && typeof snapshot.account === 'object') {
      const fields = snapshot.account as Record<string, unknown>;
      if (fields.loginMethod === 'cindy') {
        // Re-project even protected storage so corrupt or older snapshots cannot extend the API.
        account = projectCindyAccount({ displayName: fields.displayName, email: fields.email, orgName: fields.organization });
      }
    }
  } catch { /* Optional display metadata is unavailable; authentication is still preserved. */ }
  // Ordinary status can run beside serve. Never attach an old snapshot to a rotation/logout.
  const current = await store.get(authSessionKey(region));
  return { savedAuthentication: current !== null, account: current === raw ? account : null };
}

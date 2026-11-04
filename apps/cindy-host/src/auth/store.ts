import { randomUUID } from 'node:crypto';

/** Implementations must use a host/OS protected store, with no plaintext fallback. */
export interface ProtectedCredentialStore {
  assertAvailable(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class HostAuthError extends Error {
  constructor(public readonly code: string, public readonly retryAt?: number) {
    super(code);
    this.name = 'HostAuthError';
  }
}

/** Store failures must not expose backend errors, which can contain secret values. */
export async function protectedStoreCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new HostAuthError('CREDENTIAL_STORE_UNAVAILABLE');
  }
}

/** Caller holds its profile's exclusive process lock during initialization and use. */
export async function getOrCreateDeviceIdentity(store: ProtectedCredentialStore): Promise<string> {
  return protectedStoreCall(async () => {
    await store.assertAvailable();
    const existing = await store.get('device-identity.v1');
    if (existing !== null) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
        throw new Error('Invalid protected identity');
      }
      return existing;
    }
    const identity = randomUUID();
    await store.set('device-identity.v1', identity);
    return identity;
  });
}

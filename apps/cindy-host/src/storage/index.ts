import { createFileCredentialStore } from './file';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProtectedCredentialStore } from '../auth/store';

interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

export interface KeyringModule {
  AsyncEntry: new (
    service: string,
    account: string,
    options?: { linux: { store: 'secret-service' } },
  ) => KeyringEntry;
}

export interface CredentialStoreOptions {
  /** Dependency injection for tests; production uses the native OS credential store. */
  loadKeyring?: () => Promise<KeyringModule>;
  platform?: NodeJS.Platform;
}

export class CredentialStoreUnavailableError extends Error {
  readonly code = 'CREDENTIAL_STORE_UNAVAILABLE';

  constructor(platform: NodeJS.Platform) {
    super(platform === 'linux'
      ? 'Protected credential storage is unavailable. Install and unlock a Secret Service provider (such as GNOME Keyring or KWallet) and connect this process to its user D-Bus session. Plaintext and temporary keyring fallback are disabled.'
      : platform === 'darwin'
        ? 'Protected credential storage is unavailable. Unlock your macOS login Keychain and ensure the native keyring package is installed.'
        : platform === 'win32'
          ? 'Protected credential storage is unavailable. Use an accessible Windows user Credential Manager and ensure the native keyring package is installed.'
          : 'Protected credential storage is unsupported on this operating system.');
    this.name = 'CredentialStoreUnavailableError';
  }
}

/**
 * Credentials live only in OS-managed Keychain / Credential Manager / Secret Service.
 * There are no credential files, subprocess arguments, or plaintext fallbacks.
 * dataDir must be the host's validated, canonical profile directory; only its hash
 * enters the OS entry identity. Construction/import performs no credential I/O.
 */
export function createProtectedCredentialStore(
  dataDir: string,
  options: CredentialStoreOptions = {},
): ProtectedCredentialStore {
  const platform = options.platform ?? process.platform;
  if (!path.isAbsolute(dataDir)) throw new Error('Credential profile directory must be absolute.');
  const profilePath = platform === 'win32' ? path.resolve(dataDir).toLowerCase() : path.resolve(dataDir);
  const service = `cindy-host:${createHash('sha256').update(profilePath).digest('hex')}`;
  const load: () => Promise<KeyringModule> = options.loadKeyring ?? (() => import('@napi-rs/keyring'));
  let loaded: KeyringModule | undefined;

  async function entry(key: string): Promise<KeyringEntry> {
    if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
      throw new CredentialStoreUnavailableError(platform);
    }
    const module: KeyringModule = loaded ?? await load();
    loaded = module;
    // Upstream otherwise silently falls back to a kernel keyring on Linux.
    // That store does not survive reboot, so always require Secret Service.
    return new module.AsyncEntry(service, key, platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
  }

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new CredentialStoreUnavailableError(platform); }
  }

  return {
    async assertAvailable() {
      await guarded(async () => {
        // A missing lookup cannot establish write/unlock capability. Roundtrip a
        // unique non-secret probe; never overwrite or inspect a user credential.
        const probe = await entry(`capability-probe:${randomUUID()}`);
        const value = randomUUID();
        try {
          await probe.setPassword(value);
          if (await probe.getPassword() !== value) throw new Error('Credential probe failed.');
        } finally {
          await probe.deletePassword();
        }
      });
    },
    get(key) { return guarded(async () => (await entry(key)).getPassword()); },
    set(key, value) { return guarded(async () => (await entry(key)).setPassword(value)); },
    async delete(key) { await guarded(async () => { await (await entry(key)).deletePassword(); }); },
  };
}

/** File mode is explicit opt-in; never silently downgrade an OS keyring failure. */
export function createHostCredentialStore(dataDir: string, mode = process.env.CINDY_HOST_CREDENTIAL_STORE ?? 'keyring'): ProtectedCredentialStore {
  if (mode === 'file') return createFileCredentialStore(dataDir);
  if (mode === 'keyring') return createProtectedCredentialStore(dataDir);
  throw new Error('CINDY_HOST_CREDENTIAL_STORE must be keyring or file.');
}

import { mkdtemp, rm, readdir, stat, chmod, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProtectedCredentialStore, createHostCredentialStore, type KeyringModule } from './index';

/**
 * Test value: public store CRUD, profile isolation, capability failure and error
 * redaction protect credentials-and-local-storage's no-plaintext / no-leak rules.
 * This is a new host boundary with no prior storage tests. Minimal failure inputs:
 * missing Secret Service, a locked store, or a probe that cannot roundtrip/delete.
 * Tier: unit, in-memory native adapter; never reads an OS credential or user home.
 * Measured standalone: 3.63s (11 cases, test execution 36ms).
 */
function harness() {
  const values = new Map<string, string>();
  const opened: Array<{ service: string; account: string; options: unknown }> = [];
  const faults: { read?: boolean; write?: boolean; remove?: boolean; mismatch?: boolean } = {};
  const module: KeyringModule = {
    AsyncEntry: class {
      readonly id: string;
      constructor(service: string, account: string, options: unknown) {
        opened.push({ service, account, options });
        this.id = `${service}/${account}`;
      }
      async getPassword() {
        if (faults.read) throw new Error('backend leaked invalid-fake-refresh-token');
        return faults.mismatch ? 'wrong-value' : values.get(this.id) ?? null;
      }
      async setPassword(value: string) {
        if (faults.write) throw new Error(`backend leaked ${value}`);
        values.set(this.id, value);
      }
      async deletePassword() {
        if (faults.remove) throw new Error('backend leaked invalid-fake-refresh-token');
        return values.delete(this.id);
      }
    },
  };
  const loadKeyring = vi.fn(async () => module);
  const create = (profile = 'fake-profile-a', platform: NodeJS.Platform = 'linux') => createProtectedCredentialStore(
    path.join(tmpdir(), profile), { platform, loadKeyring },
  );
  return { values, opened, faults, create, loadKeyring };
}

describe('OS protected host credential storage', () => {
  it('persists, replaces and deletes within a profile without exposing the directory in entry names', async () => {
    const h = harness();
    const store = h.create();
    expect(h.loadKeyring).not.toHaveBeenCalled();
    expect(await store.get('auth-session.v1.global')).toBeNull();
    await store.set('auth-session.v1.global', 'invalid-fake-refresh-token');
    expect(await h.create().get('auth-session.v1.global')).toBe('invalid-fake-refresh-token');
    expect(await h.create('fake-profile-b').get('auth-session.v1.global')).toBeNull();
    expect(await store.get('auth-session.v1.cn')).toBeNull();
    await store.set('auth-session.v1.global', 'invalid-fake-rotated-token');
    expect(await store.get('auth-session.v1.global')).toBe('invalid-fake-rotated-token');
    await store.delete('auth-session.v1.global');
    await store.delete('auth-session.v1.global');
    expect(await store.get('auth-session.v1.global')).toBeNull();
    expect(h.opened.every(entry => !entry.service.includes('fake-profile'))).toBe(true);
  });

  it.each(['linux', 'win32', 'darwin'] as const)('probes %s by roundtripping a distinct entry and removing it', async platform => {
    const h = harness();
    const store = h.create('fake-profile-a', platform);
    await store.set('device-identity.v1', 'invalid-fake-device-id');
    await store.assertAvailable();
    expect(await store.get('device-identity.v1')).toBe('invalid-fake-device-id');
    expect(h.values.size).toBe(1);
    expect(h.opened.some(entry => entry.account.startsWith('capability-probe:'))).toBe(true);
    expect(h.opened.every(entry => platform === 'linux'
      ? JSON.stringify(entry.options) === JSON.stringify({ linux: { store: 'secret-service' } })
      : entry.options === undefined)).toBe(true);
  });

  it('fails closed with actionable Linux setup guidance when Secret Service cannot load', async () => {
    const store = createProtectedCredentialStore(path.join(tmpdir(), 'fake-unavailable-profile'), {
      platform: 'linux',
      loadKeyring: async () => { throw new Error('invalid-fake-sensitive-native-error'); },
    });
    await expect(store.assertAvailable()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE', message: expect.stringContaining('Secret Service') });
    await expect(store.get('auth-session.v1.global')).rejects.not.toThrow('invalid-fake-sensitive-native-error');
  });

  it.each(['read', 'write', 'remove', 'mismatch'] as const)('rejects failed %s probes and attempts cleanup', async fault => {
    const h = harness();
    h.faults[fault] = true;
    await expect(h.create().assertAvailable()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    expect(h.values.size).toBe(fault === 'remove' ? 1 : 0);
  });

  it('distinguishes unavailable reads/deletes from missing records and sanitizes all backend failures', async () => {
    const h = harness();
    const store = h.create();
    await store.set('auth-session.v1.global', 'invalid-fake-refresh-token');
    h.faults.read = true;
    await expect(store.get('auth-session.v1.global')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    h.faults.write = true;
    await expect(store.set('auth-session.v1.global', 'invalid-fake-refresh-token')).rejects.not.toThrow('invalid-fake-refresh-token');
    h.faults.remove = true;
    await expect(store.delete('auth-session.v1.global')).rejects.not.toThrow('invalid-fake-refresh-token');
    expect(h.values.size).toBe(1);
  });

  it('rejects unsupported platforms without loading any backend', async () => {
    const h = harness();
    await expect(h.create('fake-profile-a', 'freebsd').assertAvailable()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    expect(h.loadKeyring).not.toHaveBeenCalled();
  });
});

// File mode was explicitly requested for headless login without Secret Service.
// Existing tests only exercise a fake OS store. These unit cases cover real private
// file persistence/rotation/logout and rejection of a linked or public record.
// Minimal inputs: one fake token, mode 0644, or a symlink in a unique OS temp directory.
// Standalone run: 0.665s Vitest duration (15 cases total).
describe.skipIf(process.platform === 'win32')('explicit file credential mode', () => {
  it('persists across store instances, rotates and deletes without loading a keyring', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-file-store-'));
    try {
      const store = createHostCredentialStore(dir, 'file');
      await store.assertAvailable();
      expect(await readdir(path.join(dir, 'credentials'))).toEqual([]);
      await store.set('auth', 'fake-token');
      const reopened = createHostCredentialStore(dir, 'file');
      expect(await reopened.get('auth')).toBe('fake-token');
      await reopened.set('auth', 'fake-rotated-token');
      expect(await store.get('auth')).toBe('fake-rotated-token');
      const folder = path.join(dir, 'credentials');
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      const files = await readdir(folder);
      expect(files).toHaveLength(1);
      expect((await stat(path.join(folder, files[0]))).mode & 0o777).toBe(0o600);
      await reopened.delete('auth');
      expect(await store.get('auth')).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(['permissions', 'symlink', 'corrupt'] as const)('preserves and rejects an unsafe %s record', async kind => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-file-store-'));
    try {
      const store = createHostCredentialStore(dir, 'file');
      await store.set('auth', 'fake-token');
      const folder = path.join(dir, 'credentials');
      const file = path.join(folder, (await readdir(folder))[0]);
      if (kind === 'permissions') await chmod(file, 0o644);
      if (kind === 'corrupt') await writeFile(file, 'fake-broken-json');
      if (kind === 'symlink') {
        await rm(file);
        const target = path.join(dir, 'target');
        await writeFile(target, '"fake-token"', { mode: 0o600 });
        await symlink(target, file);
      }
      const before = await readFile(file, 'utf8');
      await expect(store.get('auth')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
      await expect(store.set('auth', 'fake-replacement')).rejects.not.toThrow('fake-token');
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

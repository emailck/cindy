/** Local, explicit per-share overrides; caller owns the CLI profile lock. Contains no credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface ShareTrustStore {
  isTrusted(shareId: string): boolean;
  setTrusted(shareId: string, enabled: boolean): Promise<void>;
  /** Prunes only this store's region after an authoritative successful membership refresh. */
  retain(shareIds: readonly string[]): Promise<void>;
}

function keyFor(region: string, shareId: string): string { return JSON.stringify([region, shareId]); }
function decodeKey(key: string): [string, string] {
  const parts: unknown = JSON.parse(key);
  if (!Array.isArray(parts) || parts.length !== 2 || !parts.every(part => typeof part === 'string' && part.length > 0)) throw new Error('INVALID_SHARE_TRUST_STORE');
  return parts as [string, string];
}
function parse(value: unknown): Set<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SHARE_TRUST_STORE');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.trusted || typeof record.trusted !== 'object' || Array.isArray(record.trusted)) throw new Error('INVALID_SHARE_TRUST_STORE');
  const trusted = new Set<string>();
  for (const [key, enabled] of Object.entries(record.trusted)) {
    const [region, shareId] = decodeKey(key);
    if (enabled !== true || keyFor(region, shareId) !== key) throw new Error('INVALID_SHARE_TRUST_STORE');
    trusted.add(key);
  }
  return trusted;
}

export async function createShareTrustStore(dataDir: string, storageScope: string, region: string): Promise<ShareTrustStore> {
  if (!storageScope || !region) throw new Error('INVALID_SHARE_TRUST_SCOPE');
  const dir = path.join(dataDir, 'accounts', createHash('sha256').update(storageScope).digest('hex'));
  const file = path.join(dir, 'provider-share-trust.json');
  const checkDirectory = async (directory: string) => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_SHARE_TRUST_DIRECTORY');
  };
  let trusted = new Set<string>();
  let invalid: unknown;
  try {
    await checkDirectory(path.join(dataDir, 'accounts'));
    await checkDirectory(dir);
    const info = await lstat(file);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('INVALID_SHARE_TRUST_STORE');
    trusted = parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = error;
  }
  // Negative overrides take effect synchronously, even if the durable write fails.
  // Positive overrides become visible only after persistence and cannot outrun a later revocation.
  const revoked = new Set<string>();
  const generations = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  const revoke = (key: string) => { revoked.add(key); generations.set(key, (generations.get(key) ?? 0) + 1); };
  const write = async (next: Set<string>) => {
    if (invalid) throw new Error('INVALID_SHARE_TRUST_STORE', { cause: invalid });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await checkDirectory(path.join(dataDir, 'accounts'));
    await checkDirectory(dir);
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    // Recheck before replacing: never overwrite externally corrupted or linked preferences.
    let persisted = new Set<string>();
    try {
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('INVALID_SHARE_TRUST_STORE');
      persisted = parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Other regions share the document but never this override namespace.
    const merged = new Set([...persisted].filter(key => decodeKey(key)[0] !== region));
    for (const key of next) if (decodeKey(key)[0] === region) merged.add(key);
    const temporary = path.join(dir, `.provider-share-trust-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify({ version: 1, trusted: Object.fromEntries([...merged].map(key => [key, true])) })}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => undefined); }
    return merged;
  };
  const enqueue = (change: () => Promise<void>) => {
    const operation = queue.then(change);
    queue = operation.catch(() => undefined);
    return operation;
  };
  return {
    isTrusted: shareId => !invalid && !revoked.has(keyFor(region, shareId)) && trusted.has(keyFor(region, shareId)),
    setTrusted(shareId, enabled) {
      if (!shareId) return Promise.reject(new Error('INVALID_SHARE_TRUST_ID'));
      const key = keyFor(region, shareId);
      if (!enabled) revoke(key);
      const generation = generations.get(key) ?? 0;
      generations.set(key, generation);
      return enqueue(async () => {
        if (enabled && generations.get(key) !== generation) throw new Error('SHARE_TRUST_REVOKED');
        const next = new Set(trusted);
        if (enabled) next.add(key); else next.delete(key);
        trusted = await write(next);
        if (enabled && generations.get(key) === generation) revoked.delete(key);
      });
    },
    retain(shareIds) {
      const retained = new Set(shareIds);
      const removed = new Set([...trusted, ...generations.keys()].filter(key => { const [scope, share] = decodeKey(key); return scope === region && !retained.has(share); }));
      for (const key of removed) revoke(key);
      return enqueue(async () => {
        // Corrupt optional preferences disable trust, not otherwise valid share discovery.
        if (invalid) return;
        const next = new Set([...trusted].filter(key => { const [scope, share] = decodeKey(key); return scope !== region || retained.has(share); }));
        if (next.size === trusted.size) return;
        trusted = await write(next);
      });
    },
  };
}

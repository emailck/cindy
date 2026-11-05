import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProtectedCredentialStore } from '../auth/store';
import { resolveDataDirectory } from '../config';

/** Explicit POSIX file mode; callers retain the existing profile lock for mutations. */
export function createFileCredentialStore(dataDir: string): ProtectedCredentialStore {
  const directory = path.join(dataDir, 'credentials');
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
  async function prepare() {
    if (process.platform === 'win32') throw new Error('POSIX permissions required');
    if (await resolveDataDirectory(dataDir) !== dataDir) throw new Error('Canonical profile required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(dataDir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() || (parent.mode & 0o022) !== 0) throw new Error('Private profile required');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Private directory required');
    }
  }
  const filename = (key: string) => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function read(key: string): Promise<string | null> {
    await prepare();
    let handle;
    try { handle = await open(filename(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new Error('Private file required');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (typeof value !== 'string') throw new Error('Invalid credential record');
      return value;
    } finally { await handle.close(); }
  }
  async function write(key: string, value: string) {
    await read(key); // Reject unsafe or malformed existing records without replacing them.
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close();
      await rename(temporary, filename(key));
      const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await folder.sync(); } finally { await folder.close(); }
    } finally {
      await handle.close();
      await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  }
  async function remove(key: string) {
    await read(key);
    await unlink(filename(key)).catch(error => { if (!missing(error)) throw error; });
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch {
      const error = new Error('Local credential files are unavailable. Use a directory outside Git workspaces, owned by this user, with credentials directory mode 700 and file mode 600.');
      Object.assign(error, { code: 'CREDENTIAL_STORE_UNAVAILABLE' });
      throw error;
    }
  }
  return {
    assertAvailable: () => guarded(async () => {
      const key = `probe:${randomUUID()}`;
      try {
        await write(key, 'nonsecret-probe');
        if (await read(key) !== 'nonsecret-probe') throw new Error('Probe failed');
      } finally { await remove(key); }
    }),
    get: key => guarded(() => read(key)),
    set: (key, value) => guarded(() => write(key, value)),
    delete: key => guarded(() => remove(key)),
  };
}

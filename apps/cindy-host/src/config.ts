import { DEFAULT_REMOTE_AGENT_LIMITS, isRemoteAgentLimitsPatch, REMOTE_AGENT_IDLE_MINUTES_MAX } from '@cindy/remote-agent-host/limits';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import endpoints from '../../../config/endpoint.global.json';

/** Build identity, not a runtime region selector. Endpoint manifest is the repository truth. */
export const HOST_REGION = 'global' as const;
export const HOST_ENDPOINTS = Object.freeze({ ...endpoints });

export class HostCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface HostConfig {
  remoteAccessEnabled: boolean;
  permissionMode: 'full-access';
  deviceName: string;
  /** Minutes before reclaiming an idle Agent; 0 disables idle reclamation. */
  idleMinutes?: number;
}
export type HostConfigOverrides = Partial<HostConfig>;
export const CONFIG_KEYS = ['remoteAccessEnabled', 'permissionMode', 'deviceName', 'idleMinutes'] as const;

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function assertOutsideGitTree(directory: string): Promise<void> {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await lstat(path.join(current, '.git'));
      throw new HostCliError('UNSAFE_DATA_DIRECTORY', 'The data directory must be outside Git workspaces.');
    } catch (error) { if (!isMissing(error)) throw error; }
    if (path.dirname(current) === current) break;
  }
}

/** Explicit only. Check physical ancestors as well as lexical ones to reject repository junctions. */
export async function resolveDataDirectory(input: string | undefined): Promise<string> {
  if (!input || !path.isAbsolute(input)) {
    throw new HostCliError('DATA_DIRECTORY_REQUIRED', 'Provide an absolute --data-dir path or CINDY_HOST_DATA_DIR outside Git workspaces.');
  }
  const directory = path.resolve(input);
  await assertOutsideGitTree(directory);
  let ancestor = directory;
  const suffix: string[] = [];
  for (;;) {
    try {
      const physical = await realpath(ancestor);
      const resolved = path.join(physical, ...suffix.reverse());
      await assertOutsideGitTree(resolved);
      return resolved;
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (path.dirname(ancestor) === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

function validateOverrides(value: unknown): HostConfigOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostCliError('INVALID_CONFIG', 'Configuration must be a JSON object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !(CONFIG_KEYS as readonly string[]).includes(key))) {
    throw new HostCliError('INVALID_CONFIG', 'Unknown configuration field. Secrets belong in the protected credential store.');
  }
  if ('remoteAccessEnabled' in record && typeof record.remoteAccessEnabled !== 'boolean') throw new HostCliError('INVALID_CONFIG', 'remoteAccessEnabled must be true or false.');
  if ('permissionMode' in record && record.permissionMode !== 'full-access') throw new HostCliError('INVALID_CONFIG', 'permissionMode must be full-access.');
  if ('deviceName' in record && (typeof record.deviceName !== 'string' || !record.deviceName.trim() || record.deviceName.length > 128 || /[\x00-\x1f\x7f]/.test(record.deviceName))) {
    throw new HostCliError('INVALID_CONFIG', 'deviceName must contain 1–128 printable characters.');
  }
  if ('idleMinutes' in record && !isRemoteAgentLimitsPatch({ idleMinutes: record.idleMinutes })) {
    throw new HostCliError('INVALID_CONFIG', `idleMinutes must be an integer from 0 to ${REMOTE_AGENT_IDLE_MINUTES_MAX} (0 disables idle reclamation).`);
  }
  return { ...record } as HostConfigOverrides;
}

async function assertRegularConfig(file: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HostCliError('INVALID_CONFIG', 'Configuration must be a regular file, not a link.');
  } catch (error) { if (!isMissing(error)) throw error; }
}

export async function readConfig(dataDir: string): Promise<{ overrides: HostConfigOverrides; effective: HostConfig }> {
  const file = path.join(dataDir, 'config.json');
  await assertRegularConfig(file);
  let overrides: HostConfigOverrides;
  try { overrides = validateOverrides(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if (isMissing(error)) overrides = {};
    else if (error instanceof HostCliError) throw error;
    else throw new HostCliError('INVALID_CONFIG', 'Cannot read configuration. The original file has been preserved.');
  }
  return { overrides, effective: { remoteAccessEnabled: false, permissionMode: 'full-access', deviceName: hostname(), idleMinutes: DEFAULT_REMOTE_AGENT_LIMITS.idleMinutes, ...overrides } };
}

/** Lock + atomic replace; preserve malformed files rather than silently resetting user choices. */
export async function updateConfig(dataDir: string, key: string, value: string | undefined): Promise<void> {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new HostCliError('INVALID_CONFIG', 'Unknown configuration field. Secrets cannot be configured here.');
  await resolveDataDirectory(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, 'config.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new HostCliError('CONFIG_BUSY', 'Cannot lock configuration. Another process may be editing it.'); }
  const temporary = path.join(dataDir, `.config-${randomUUID()}.tmp`);
  try {
    const { overrides } = await readConfig(dataDir);
    const next: Record<string, unknown> = { ...overrides };
    if (value === undefined) delete next[key];
    else if (key === 'remoteAccessEnabled') {
      if (value !== 'true' && value !== 'false') throw new HostCliError('INVALID_CONFIG', 'remoteAccessEnabled must be true or false.');
      next[key] = value === 'true';
    } else if (key === 'idleMinutes') {
      next[key] = value.trim() ? Number(value) : NaN;
    } else next[key] = value;
    validateOverrides(next);
    const output = await open(temporary, 'wx', 0o600);
    try { await output.writeFile(`${JSON.stringify(next, null, 2)}\n`); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, path.join(dataDir, 'config.json'));
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

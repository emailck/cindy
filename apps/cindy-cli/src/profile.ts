import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
// Fork-owned CLI code is shared with the provider host by direct import (same data-directory rules).
import { HostCliError, resolveDataDirectory as resolveHostDataDirectory } from '../../cindy-host/src/config';
import { isThemeSetting, type ThemeSetting } from './chat/theme';
import { isLanguage, type Language, type MessageKey } from './i18n';

export { HOST_ENDPOINTS as CLI_ENDPOINTS, HOST_REGION as CLI_REGION } from '../../cindy-host/src/config';

/** User-facing failure: a stable code plus a translatable message. Never carries secrets. */
export class CliError extends Error {
  constructor(public readonly code: string, public readonly messageKey: MessageKey, public readonly vars?: Record<string, string>) {
    super(code);
    this.name = 'CliError';
  }
}

export type PermissionChoice = 'full' | 'normal' | 'plan';
export const PERMISSION_CHOICES: readonly PermissionChoice[] = ['full', 'normal', 'plan'];
export function isPermissionChoice(value: unknown): value is PermissionChoice {
  return typeof value === 'string' && (PERMISSION_CHOICES as readonly string[]).includes(value);
}

/** The last model the user picked; restored on the next start when still offered. */
export interface ModelChoice { target: string; providerId: string; model: string }

export interface CliConfig {
  language?: Language;
  /** User decision 2026-11-15: full when unset. */
  permissionMode: PermissionChoice;
  deviceName: string;
  model?: ModelChoice;
  /** Terminal colors; auto follows the terminal background. */
  theme?: ThemeSetting;
}
type StoredConfig = Partial<CliConfig>;
export const CONFIG_KEYS = ['language', 'permissionMode', 'deviceName', 'theme'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Per-user application data, outside any project. Explicit flag/env win. */
export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string | undefined {
  if (env.CINDY_CLI_DATA_DIR) return env.CINDY_CLI_DATA_DIR;
  if (!home) return undefined;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Cindy CLI');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cindy CLI');
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(state, 'cindy-cli');
}

export async function resolveDataDirectory(input: string | undefined): Promise<string> {
  if (!input) throw new CliError('DATA_DIRECTORY_REQUIRED', 'error.dataDirUnavailable');
  if (!path.isAbsolute(input)) throw new CliError('DATA_DIRECTORY_REQUIRED', 'error.dataDirRelative');
  try { return await resolveHostDataDirectory(input); }
  catch (error) {
    if (error instanceof HostCliError && error.code === 'UNSAFE_DATA_DIRECTORY') throw new CliError(error.code, 'error.dataDirInGit');
    throw new CliError('DATA_DIRECTORY_REQUIRED', 'error.dataDirUnavailable');
  }
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

function validateStored(value: unknown, file: string): StoredConfig {
  const invalid = () => new CliError('INVALID_CONFIG', 'error.configInvalid', { file });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const result: StoredConfig = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === 'language' && isLanguage(item)) result.language = item;
    else if (key === 'permissionMode' && isPermissionChoice(item)) result.permissionMode = item;
    else if (key === 'deviceName' && validDeviceName(item)) result.deviceName = item;
    else if (key === 'model' && isModelChoice(item)) result.model = item;
    else if (key === 'theme' && isThemeSetting(item)) result.theme = item;
    else throw invalid();
  }
  return result;
}

function validDeviceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

function isModelChoice(value: unknown): value is ModelChoice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && ['target', 'providerId', 'model'].every(key => typeof record[key] === 'string' && (record[key] as string).length > 0 && (record[key] as string).length <= 512);
}

async function readStored(dataDir: string): Promise<StoredConfig> {
  const file = path.join(dataDir, 'config.json');
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new CliError('INVALID_CONFIG', 'error.configInvalid', { file });
    return validateStored(JSON.parse(await readFile(file, 'utf8')), file);
  } catch (error) {
    if (isMissing(error)) return {};
    if (error instanceof CliError) throw error;
    throw new CliError('INVALID_CONFIG', 'error.configInvalid', { file });
  }
}

export async function readConfig(dataDir: string): Promise<{ stored: StoredConfig; effective: CliConfig }> {
  const stored = await readStored(dataDir);
  return { stored, effective: { permissionMode: 'full', deviceName: hostname(), ...stored } };
}

/** Lock + atomic replace. A malformed file is preserved rather than silently reset. */
export async function writeConfig(dataDir: string, change: (current: StoredConfig) => StoredConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, 'config.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new CliError('CONFIG_BUSY', 'error.configBusy'); }
  const temporary = path.join(dataDir, `.config-${randomUUID()}.tmp`);
  try {
    const next = change(await readStored(dataDir));
    validateStored(next, path.join(dataDir, 'config.json'));
    const output = await open(temporary, 'wx', 0o600);
    try { await output.writeFile(`${JSON.stringify(next, null, 2)}\n`); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, path.join(dataDir, 'config.json'));
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

export function parseConfigValue(key: string, value: string): Partial<CliConfig> {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new CliError('INVALID_CONFIG', 'error.configKey');
  if (key === 'language' && isLanguage(value)) return { language: value };
  if (key === 'permissionMode' && isPermissionChoice(value)) return { permissionMode: value };
  if (key === 'deviceName' && validDeviceName(value)) return { deviceName: value };
  if (key === 'theme' && isThemeSetting(value)) return { theme: value };
  throw new CliError('INVALID_CONFIG', 'error.configValue', { key });
}

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
}

/** Whether a process with this id exists. EPERM: it exists but belongs to another user. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A lock without a process id this old was left between creating the file and writing the id. */
const UNWRITTEN_LOCK_MS = 30_000;

/**
 * profile.lock left by a process that no longer runs (crash, kill -9, power loss): move it aside, and remove it
 * only if it is still the same stale lock, so a lock another starting process just created is put back.
 * Returns whether the caller may try to create the lock again; a live holder's id otherwise.
 */
async function clearStaleLock(file: string): Promise<{ cleared: true } | { cleared: false; pid?: number }> {
  let content: string;
  try { content = await readFile(file, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { cleared: true } : { cleared: false }; }
  const pid = /^\s*(\d+)\s*$/.test(content) ? Number(content.trim()) : null;
  if (pid !== null) {
    // The same process id as ours is another command in this very process (tests), never a stale lock.
    if (pid === process.pid || processAlive(pid)) return { cleared: false, pid };
  } else {
    const age = await stat(file).then(info => Date.now() - info.mtimeMs, () => 0);
    if (age < UNWRITTEN_LOCK_MS) return { cleared: false };
  }
  const aside = `${file}.stale-${randomUUID()}`;
  try { await rename(file, aside); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { cleared: true } : { cleared: false }; }
  const moved = await readFile(aside, 'utf8').catch(() => null);
  if (moved !== content) {
    // Another process replaced the stale lock meanwhile: give its lock back.
    await link(aside, file).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return { cleared: false };
  }
  await unlink(aside).catch(() => undefined);
  return { cleared: true };
}

async function acquireProfileLock(file: string): Promise<FileHandle> {
  for (let attempt = 0; ; attempt++) {
    try { return await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw new CliError('PROFILE_BUSY', 'error.profileBusy');
    }
    const stale = await clearStaleLock(file);
    if (!stale.cleared) {
      throw stale.pid !== undefined
        ? new CliError('PROFILE_BUSY', 'error.profileBusyPid', { pid: String(stale.pid), file })
        : new CliError('PROFILE_BUSY', 'error.profileBusy');
    }
  }
}

/**
 * One Cindy CLI process per data directory: refresh-token rotation must never race. A lock whose process is gone
 * is taken over. SIGINT (Ctrl+C before the interactive UI owns the terminal; in it, Ctrl+C is a key), SIGTERM and
 * SIGHUP (terminal closed, SSH dropped) abort the action, so it ends through its normal cleanup and the lock goes.
 */
export async function withProfileLock<T>(dataDir: string, action: (signal: AbortSignal) => Promise<T>, options: { signals?: SignalSource } = {}): Promise<T> {
  const signals = options.signals ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const events = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const event of events) signals.on(event, cancel);
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (controller.signal.aborted) throw new CliError('COMMAND_CANCELLED', 'error.cancelled');
    const file = path.join(dataDir, 'profile.lock');
    const lock = await acquireProfileLock(file);
    try {
      await lock.writeFile(`${process.pid}\n`);
      if (controller.signal.aborted) throw new CliError('COMMAND_CANCELLED', 'error.cancelled');
      return await action(controller.signal);
    } catch (error) {
      // Startup work cut short by a signal fails in its own way (aborted fetch, relay); report the cancellation.
      if (controller.signal.aborted && !(error instanceof CliError && error.code === 'COMMAND_CANCELLED')) throw new CliError('COMMAND_CANCELLED', 'error.cancelled');
      throw error;
    } finally { await lock.close(); await unlink(file).catch(() => {}); }
  } finally {
    for (const event of events) signals.removeListener(event, cancel);
  }
}

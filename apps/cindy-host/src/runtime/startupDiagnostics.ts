import metadata from '../../package.json';
import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, type FileHandle } from 'node:fs/promises';

const MESSAGE = 'remote agent startup timing';
declare const __CINDY_HOST_BUILD_REVISION__: string;
const buildRevision = typeof __CINDY_HOST_BUILD_REVISION__ === 'undefined' ? 'dev' : __CINDY_HOST_BUILD_REVISION__;
const STAGES = new Set([
  'total', 'resume-workspaces', 'guest-registration', 'shadow-workspace', 'tunnel-prepare',
  'provider-route', 'agent-session', 'session-registration',
  'auth-status', 'process-spawn', 'initialize', 'ephemeral-auth-config', 'external-auth',
  'capability-skills', 'capability-config', 'capability-mcp-status', 'native-review-config',
  'hosted-mcp-config', 'guest-features', 'environment-add', 'thread-start', 'thread-resume', 'session-total',
]);
const COUNTERS = ['ancestorLevels', 'connections', 'answered', 'forwarded', 'shortcutAnswered'] as const;
const BATCH_COUNTERS = ['connections', 'attempted', 'prefetched', 'answered', 'notFound', 'nonNotFound', 'uriMismatch', 'rejectedUri', 'scopeMismatch', 'unprefetched', 'batches', 'budgetExhausted'] as const;
const STOP_REASONS = ['startup-complete', 'process-start', 'write', 'oversize', 'invalid-message'] as const;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_LINE_BYTES = 4096;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024;

function privateFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

/** The validated CLI data root owns these two files. Never follow a supplied file/link. */
async function appendDiagnostic(dataDir: string, line: string): Promise<void> {
  const file = path.join(dataDir, 'startup-timing.jsonl');
  const backup = `${file}.1`;
  let handle: FileHandle | undefined;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  const checkedOpen = async (exclusive = false): Promise<FileHandle> => {
    // lstat also protects platforms where O_NOFOLLOW is unavailable.
    try { if (!privateFile(await lstat(file))) throw new Error('Invalid diagnostic file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const fd = await open(file, flags | (exclusive ? constants.O_EXCL : 0), 0o600);
    try {
      const stat = await fd.stat();
      const entry = await lstat(file);
      if (!privateFile(stat) || !privateFile(entry) || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('Invalid diagnostic file');
      await fd.chmod(0o600);
      return fd;
    } catch (error) { await fd.close(); throw error; }
  };
  try {
    handle = await checkedOpen();
    if ((await handle.stat()).size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
      // Reject an unexpected backup instead of following or modifying it.
      try { if (!privateFile(await lstat(backup))) throw new Error('Invalid diagnostic backup'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await handle.close();
      handle = undefined;
      await rename(file, backup);
      handle = await checkedOpen(true);
    }
    await handle.appendFile(line, 'utf8');
  } finally { await handle?.close(); }
}

/** This is the CLI's sole runtime diagnostic outlet. Rebuild every field; never serialize arbitrary logs. */
export function startupDiagnostics(write: (line: string) => void, dataDir?: string) {
  let pending = Promise.resolve();
  let queuedBytes = 0;
  let droppedRecords = 0;
  const persist = (json: string) => {
    if (!dataDir) return;
    const line = `${json}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES || queuedBytes + bytes > MAX_QUEUED_BYTES) { droppedRecords += 1; return; }
    queuedBytes += bytes;
    // A bounded, finite queue: no polling/timers/retries and no startup await on disk operations.
    pending = pending.then(() => appendDiagnostic(dataDir, line)).catch(() => { droppedRecords += 1; })
      .finally(() => { queuedBytes -= bytes; });
  };
  const emit = (message: string, fields?: Record<string, unknown>): void => {
    try {
      if (message !== MESSAGE || !fields || typeof fields.stage !== 'string' || !STAGES.has(fields.stage)) return;
      if (typeof fields.side !== 'string' || !['host', 'codex'].includes(fields.side)
        || typeof fields.status !== 'string' || !['started', 'ok', 'failed'].includes(fields.status)) return;
      const safe: Record<string, unknown> = {
        recordedAt: new Date().toISOString(),
        diagnosticsVersion: 1, hostVersion: metadata.version, buildRevision, nodeVersion: process.versions.node,
        platform: process.platform, arch: process.arch, side: fields.side, stage: fields.stage, status: fields.status,
      };
      if (typeof fields.kind === 'string' && ['codex', 'claude-code', 'pi'].includes(fields.kind)) safe.kind = fields.kind;
      if (typeof fields.runtimeVersion === 'string' && fields.runtimeVersion.length <= 64 && /^\d+\.\d+\.\d+$/.test(fields.runtimeVersion)) safe.runtimeVersion = fields.runtimeVersion;
      for (const key of ['elapsedMs', 'durationMs']) if (number(fields[key])) safe[key] = fields[key];
      for (const key of ['sessionRef', 'runRef', 'hostRef', 'engineSessionRef']) {
        if (typeof fields[key] === 'string' && /^[A-Za-z0-9_-]{1,8}$/.test(fields[key])) safe[key] = fields[key];
      }
      if (typeof fields.reconnect === 'boolean') safe.reconnect = fields.reconnect;
      if (record(fields.stagesMs)) {
        safe.stagesMs = Object.fromEntries(Object.entries(fields.stagesMs).filter(([stage, value]) => STAGES.has(stage) && number(value)));
      }
      if (record(fields.execServer)) {
        const stats: Record<string, unknown> = {};
        if (typeof fields.execServer.shortcutEnabled === 'boolean') stats.shortcutEnabled = fields.execServer.shortcutEnabled;
        for (const key of COUNTERS) if (number(fields.execServer[key])) stats[key] = fields.execServer[key];
        const batch = fields.execServer.batch;
        if (record(batch)) {
          const safeBatch: Record<string, unknown> = Object.fromEntries(BATCH_COUNTERS.filter(key => number(batch[key])).map(key => [key, batch[key]]));
          if (typeof batch.incrementalEnabled === 'boolean') safeBatch.incrementalEnabled = batch.incrementalEnabled;
          if (record(batch.stopped)) safeBatch.stopped = Object.fromEntries(STOP_REASONS.filter(key => number((batch.stopped as Record<string, unknown>)[key])).map(key => [key, (batch.stopped as Record<string, unknown>)[key]]));
          stats.batch = safeBatch;
        }
        safe.execServer = stats;
      }
      if (droppedRecords) safe.droppedRecords = droppedRecords;
      const json = JSON.stringify(safe);
      persist(json);
      write(`${MESSAGE} ${json}`);
    } catch { /* Diagnostics, including a failing sink, cannot change startup. */ }
  };
  return Object.assign(emit, { flush: () => pending });
}

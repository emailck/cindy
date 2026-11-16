/**
 * Local task records for /resume, per account, in the private data directory: what reconnecting needs, and
 * the task's conversation as it was shown (replayed when the task is picked up again). The remote Agent keeps
 * its own native session; this copy only serves the terminal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface TaskRecord {
  sessionId: string;
  workingDir: string;
  target: string;
  targetLabel: string;
  agent: string;
  providerId: string;
  model: string;
  /** Native session id from the remote Agent; absent until the first turn reported one. */
  resumeSessionId?: string;
  /** First line of the first message, truncated; shown in the /resume list only. */
  title: string;
  updatedAt: number;
}

const MAX_RECORDS = 200;
const TITLE_LIMIT = 80;

export function taskTitle(text: string): string {
  const line = text.split(/\r?\n/).find(part => part.trim())?.trim() ?? '';
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function isRecord(value: unknown): value is TaskRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['sessionId', 'workingDir', 'target', 'targetLabel', 'agent', 'providerId', 'model', 'title'].every(key => typeof r[key] === 'string')
    && typeof r.updatedAt === 'number' && (r.resumeSessionId === undefined || typeof r.resumeSessionId === 'string');
}

export interface TaskStore {
  list(workingDir: string): Promise<TaskRecord[]>;
  save(record: TaskRecord): Promise<void>;
  /** Adds shown transcript entries (JSON values) for the task; oldest first. */
  appendTranscript?(sessionId: string, entries: readonly unknown[]): Promise<void>;
  /** The task's saved transcript entries, oldest first; empty when there are none. */
  readTranscript?(sessionId: string): Promise<unknown[]>;
}

/** Transcripts are named by the task id; anything else never becomes a file name. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A transcript past this size is cut down to its most recent entries. */
const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_KEEP_ENTRIES = 2_000;

/** `storageScope` is the account identity; another account never sees these records. */
export function createTaskStore(dataDir: string, storageScope: string): TaskStore {
  const dir = path.join(dataDir, 'accounts', createHash('sha256').update(storageScope).digest('hex'));
  const file = path.join(dir, 'tasks.json');
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<TaskRecord[]> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch { return []; }
  };
  const write = async (records: TaskRecord[]) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.tasks-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(records)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, file); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  };
  const transcripts = path.join(dir, 'transcripts');
  const transcriptFile = (sessionId: string) => (SESSION_ID.test(sessionId) ? path.join(transcripts, `${sessionId}.jsonl`) : null);
  const readEntries = async (file: string): Promise<unknown[]> => {
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch { return []; }
    // A line cut short by a crash is skipped, not fatal.
    return text.split('\n').flatMap(line => { if (!line) return []; try { return [JSON.parse(line) as unknown]; } catch { return []; } });
  };
  /** Transcripts of tasks no longer listed (dropped past the record limit, or never recorded) go with them. */
  const prune = async (kept: readonly TaskRecord[]) => {
    const ids = new Set(kept.map(record => record.sessionId.toLowerCase()));
    let names: string[];
    try { names = await readdir(transcripts); } catch { return; }
    await Promise.all(names.filter(name => name.endsWith('.jsonl') && !ids.has(name.slice(0, -6).toLowerCase()))
      .map(name => unlink(path.join(transcripts, name)).catch(() => {})));
  };
  return {
    async list(workingDir) {
      const target = path.resolve(workingDir);
      return (await read()).filter(record => path.resolve(record.workingDir) === target).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    save(record) {
      const next = queue.then(async () => {
        const records = (await read()).filter(item => item.sessionId !== record.sessionId);
        records.push(record);
        records.sort((a, b) => b.updatedAt - a.updatedAt);
        const kept = records.slice(0, MAX_RECORDS);
        await write(kept);
        await prune(kept);
      });
      queue = next.catch(() => undefined);
      return next;
    },
    appendTranscript(sessionId, entries) {
      const file = transcriptFile(sessionId);
      if (!file || !entries.length) return Promise.resolve();
      const next = queue.then(async () => {
        await mkdir(transcripts, { recursive: true, mode: 0o700 });
        await appendFile(file, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
        if ((await stat(file)).size <= TRANSCRIPT_MAX_BYTES) return;
        const recent = (await readEntries(file)).slice(-TRANSCRIPT_KEEP_ENTRIES);
        const temporary = path.join(transcripts, `.${randomUUID()}.tmp`);
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(recent.map(entry => `${JSON.stringify(entry)}\n`).join('')); await handle.sync(); }
        finally { await handle.close(); }
        try { await rename(temporary, file); }
        catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      });
      queue = next.catch(() => undefined);
      return next;
    },
    async readTranscript(sessionId) {
      const file = transcriptFile(sessionId);
      if (!file) return [];
      await queue;
      return readEntries(file);
    },
  };
}

/** Inputs kept across runs, per account, oldest first; each run reads its own project directory's. */
export interface HistoryEntry { dir: string; text: string; at: number }

const MAX_HISTORY = 1_000;
/** A long paste is remembered in full only up to this length. */
const HISTORY_TEXT_LIMIT = 10_000;

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.dir === 'string' && typeof r.text === 'string' && typeof r.at === 'number';
}

/**
 * Typed input for ↑ and Ctrl+R, in the account's private directory next to the task records (0600, atomic
 * replace). It holds what the user typed, like a shell history; another account never sees it.
 */
export function createHistoryStore(dataDir: string, storageScope: string): { load(workingDir: string): Promise<string[]>; add(workingDir: string, text: string): Promise<void> } {
  const dir = path.join(dataDir, 'accounts', createHash('sha256').update(storageScope).digest('hex'));
  const file = path.join(dir, 'history.json');
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<HistoryEntry[]> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
    } catch { return []; }
  };
  const write = async (entries: HistoryEntry[]) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.history-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(entries)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, file); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  };
  return {
    async load(workingDir) {
      const target = path.resolve(workingDir);
      return (await read()).filter(entry => path.resolve(entry.dir) === target).map(entry => entry.text);
    },
    add(workingDir, raw) {
      const text = raw.length > HISTORY_TEXT_LIMIT ? raw.slice(0, HISTORY_TEXT_LIMIT) : raw;
      const target = path.resolve(workingDir);
      const next = queue.then(async () => {
        // The same input again moves to the end instead of repeating.
        const entries = (await read()).filter(entry => !(entry.text === text && path.resolve(entry.dir) === target));
        entries.push({ dir: target, text, at: Date.now() });
        await write(entries.slice(-MAX_HISTORY));
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

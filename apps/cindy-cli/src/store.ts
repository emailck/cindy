/**
 * Local task records for /resume. Conversation history stays with the remote Agent's native
 * session; this keeps only what reconnecting needs, per account, in the private data directory.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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
}

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
        await write(records.slice(0, MAX_RECORDS));
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

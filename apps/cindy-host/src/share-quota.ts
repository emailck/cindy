import { MAX_FRAME_BYTES } from '@cindy/device-link';
import type { UsageDetails } from './share-usage';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AccountRateLimitsResponse } from '@cindy/maker-core';

// Existing Desktop wire contract; only presentation fields cross this channel.
export const SHARE_INSIGHTS_CHANNEL = 'provider-share:insights:v1';
export interface QuotaAccount {
  state: 'ready' | 'unsupported' | 'unavailable';
  updatedAt: number | null;
  windows: Array<{ kind: 'session' | 'week' | 'scoped'; label: string | null; remainingPercent: number; resetsAt: number | null; windowMinutes: number | null }>;
  balance: null;
}
export const emptyQuota = (state: QuotaAccount['state']): QuotaAccount => ({ state, updatedAt: null, windows: [], balance: null });

export function codexQuota(response: AccountRateLimitsResponse, now = Date.now()): QuotaAccount {
  // A model-specific promotional bucket must never impersonate the whole account.
  const buckets = response.rateLimitsByLimitId;
  const bucket = buckets?.codex ?? buckets?.__default__ ?? buckets?.default ?? response.rateLimits;
  if (!bucket || (bucket.limitId && !['codex', '__default__', 'default'].includes(bucket.limitId))) return emptyQuota('unavailable');
  const windows: QuotaAccount['windows'] = [];
  for (const window of [bucket.primary, bucket.secondary]) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const minutes = window.windowMinutes ?? window.windowDurationMins ?? 10080;
    const reset = window.resetsAt == null ? null : window.resetsAt * 1000;
    if (reset !== null && (!Number.isFinite(new Date(reset).getTime()) || reset <= now)) continue;
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    windows.push({ kind: minutes >= 10080 ? 'week' : 'session', label: null,
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetsAt: reset, windowMinutes: minutes });
  }
  return { state: windows.length ? 'ready' : 'unavailable', updatedAt: now, windows, balance: null };
}

/** Per Cindy account AND provider; process owns the existing exclusive profile lock. */
export async function createShareQuota(options: {
  dataDir: string; scope: string; providerId: string;
  read(): Promise<QuotaAccount>;
  usage?(peer: string): Promise<UsageDetails>;
  // Include membership incarnation so remove/reapprove cannot revive an in-flight reply.
  access(peer: string): string | null;
  current(): boolean;
}) {
  const directory = path.join(options.dataDir, 'accounts', createHash('sha256').update(options.scope).digest('hex'));
  const file = path.join(directory, `share-quota-${createHash('sha256').update(options.providerId).digest('hex')}.json`);
  // CLI quota visibility defaults on; an explicit off survives restarts.
  let enabled = true;
  let usageEnabled = true;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || typeof saved.enabled !== 'boolean') throw new Error();
    if (saved.usageEnabled !== undefined && typeof saved.usageEnabled !== 'boolean') throw new Error();
    enabled = saved.enabled;
    usageEnabled = saved.usageEnabled ?? true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Share quota preference is unavailable; existing file preserved.');
  }
  let revision = 0;
  let cache: { until: number; value: Promise<QuotaAccount> } | undefined;
  let writing: Promise<unknown> = Promise.resolve();
  const read = () => {
    if (!cache || cache.until <= Date.now()) {
      const value = options.read().catch(() => emptyQuota('unavailable'));
      cache = { until: Date.now() + 30000, value };
    }
    return cache.value;
  };
  async function manage(value?: string, capability: 'quota' | 'usage' = 'quota') {
    if (value === undefined) return capability === 'quota' ? { enabled, account: await read() } : { enabled: usageEnabled };
    if (value !== 'on' && value !== 'off') throw new Error('Use share quota [on|off].');
    const operation = writing.then(async () => {
      if (!options.current()) throw new Error('Account changed');
      revision++; cache = undefined;
      // Close before I/O; reopening only happens after durable persistence.
      if (capability === 'quota') enabled = false; else usageEnabled = false;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid preference directory');
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, enabled: capability === 'quota' ? value === 'on' : enabled, usageEnabled: capability === 'usage' ? value === 'on' : usageEnabled }) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        if (!options.current()) throw new Error('Account changed');
        await rename(temp, file);
        if (capability === 'quota') enabled = value === 'on'; else usageEnabled = value === 'on';
        revision++;
        return { enabled: capability === 'quota' ? enabled : usageEnabled };
      } finally { await unlink(temp).catch(() => {}); }
    });
    writing = operation.catch(() => {});
    return operation;
  }
  async function insights(peer: string, raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2
      || (raw as { version?: unknown }).version !== 1 || typeof (raw as { includeUsage?: unknown }).includeUsage !== 'boolean') throw new Error('Invalid quota request');
    const membership = options.access(peer);
    if (!membership || !options.current()) throw new Error('Share unavailable');
    const generation = revision;
    const allowed = enabled;
    const usageAllowed = usageEnabled;
    const includeUsage = (raw as { includeUsage: boolean }).includeUsage;
    const [account, history] = await Promise.all([
      allowed ? read() : null,
      usageAllowed && includeUsage ? options.usage?.(peer).catch(() => null) ?? null : null,
    ]);
    const isCurrent = () => options.current() && membership === options.access(peer) && revision === generation;
    if (!isCurrent()) throw new Error('Share changed');
    const live = account ? { ...account, windows: account.windows.filter(window => window.resetsAt === null || window.resetsAt > Date.now()) } : null;
    if (live?.state === 'ready' && !live.windows.length) live.state = 'unavailable';
    const result = { version: 1, capabilities: { quota: allowed, usage: usageAllowed },
      status: { quota: !allowed ? 'disabled' : live?.state === 'ready' ? 'ready' : 'unavailable',
        usage: !usageAllowed ? 'disabled' : !includeUsage ? 'not-requested' : history ? 'ready' : 'unavailable' },
      quota: live?.state === 'ready' ? { group: false, partial: false, accounts: [live] } : null, usage: history };
    boundUsageFrame(result);
    return { isCurrent, result };
  }
  return { manage, insights };
}

export function claudeQuota(raw: unknown, now = Date.now()): QuotaAccount {
  if (!raw || typeof raw !== 'object') return emptyQuota('unavailable');
  const data = raw as Record<string, unknown>;
  const windows: QuotaAccount['windows'] = [];
  const add = (kind: 'session' | 'week', value: unknown, field: string) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const used = record[field];
    if (typeof used !== 'number' || !Number.isFinite(used)) return;
    const reset = typeof record.resets_at === 'string' ? Date.parse(record.resets_at)
      : typeof record.resets_at === 'number' ? record.resets_at * 1000 : null;
    if (reset !== null && (!Number.isFinite(new Date(reset).getTime()) || reset <= now)) return;
    windows.push({ kind, label: null, remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      resetsAt: reset, windowMinutes: kind === 'session' ? 300 : 10080 });
  };
  for (const limit of Array.isArray(data.limits) ? data.limits : []) {
    if (limit?.kind === 'session') add('session', limit, 'percent');
    if (limit?.kind === 'weekly_all') add('week', limit, 'percent');
  }
  if (!windows.some(w => w.kind === 'session')) add('session', data.five_hour, 'utilization');
  if (!windows.some(w => w.kind === 'week')) add('week', data.seven_day, 'utilization');
  return { state: windows.length ? 'ready' : 'unavailable', windows: windows.slice(0, 32), updatedAt: now, balance: null };
}

/** Reserve envelope bytes; keep newest rows and disclose truncation instead of oversized frames. */
function boundUsageFrame(result: { usage: UsageDetails | null; status: { usage: string } }) {
  const maxBytes = MAX_FRAME_BYTES - 1024;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (!result.usage || bytes(result) <= maxBytes) return;
  const original = result.usage;
  const rows = original.parties.flatMap((party, index) => party.days.map(row => ({ index, row })))
    .sort((a, b) => b.row.day.localeCompare(a.row.day));
  result.usage = { ...original, coverageStart: null, parties: original.parties.map(party => ({ ...party, days: [] })) };
  let size = bytes(result); let kept = 0;
  for (const { index, row } of rows) {
    const days = result.usage.parties[index].days;
    const next = size + bytes(row) + (days.length ? 1 : 0) + bytes(row.day) - bytes(result.usage.coverageStart);
    if (next > maxBytes) break;
    days.push(row); result.usage.coverageStart = row.day; size = next; kept++;
  }
  if (size > maxBytes || (rows.length && !kept)) { result.usage = null; result.status.usage = 'unavailable'; }
}

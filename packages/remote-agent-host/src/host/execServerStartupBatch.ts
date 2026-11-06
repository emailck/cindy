import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXEC_SERVER_NOT_FOUND_CODE } from './execServerShortcut';
import type { StartupExecServerBatchStats } from '../startupTiming';

const MANIFEST_DIRS = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'];
// Includes the virtual workspace padding and host ancestors; bounded per connection.
const MAX_LEVELS = 64;
const MAX_MESSAGE_CHARS = 16 * 1024;
const READ_ONLY = new Set(['fs/getMetadata', 'fs/canonicalize', 'fs/readFile', 'fs/readDirectory', 'fs/readDir', 'fs/listDirectory', 'fs/walk']);

interface Rpc {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number };
}

function parse(data: string): Rpc | null {
  try {
    const value = JSON.parse(data);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

interface BatchDeps {
  stats?: StartupExecServerBatchStats;
  /** CLI opt-in: extend prefetch to new Skill branches within one connection-wide budget. */
  incremental?: boolean;
  shortcut(data: string): string | null;
  forward(data: string): void;
  answer(data: string): void;
}

/**
 * Codex probes three plugin manifests serially up the Skill's ancestry. Pipeline these
 * ordinary metadata RPCs over the existing tunnel; the task's native exec-server still
 * resolves every unknown path and enforces its sandbox. No new wire method or capability.
 * Only native NotFound replies are reused, for this connection's startup and exact params.
 * Existing files, permission failures and unsupported operations are queried normally.
 */
export function createExecServerStartupBatch(deps: BatchDeps) {
  const prefix = `cindy-startup-${randomUUID()}-`;
  const pending = new Map<string, string>(); // internal id -> original file URI
  const absent = new Set<string>();
  const waiters = new Map<string, string[]>();
  // Only synthetic RPCs consume this budget. Real queries always retain their original fallback.
  const prefetched = new Set<string>();
  const maxPrefetched = MAX_LEVELS * MANIFEST_DIRS.length;
  let nextId = 0;
  let scope: string | undefined;
  let active = true;
  let attempted = false;

  function finish(reason: keyof StartupExecServerBatchStats['stopped'] = 'startup-complete'): void {
    if (!active) return;
    if (deps.stats) deps.stats.stopped[reason] = (deps.stats.stopped[reason] ?? 0) + 1;
    active = false;
    absent.clear();
    for (const messages of waiters.values()) for (const message of messages) deps.forward(message);
    waiters.clear();
    // Retain pending ids until their replies arrive, so synthetic replies never reach Codex.
  }

  function request(data: string): boolean {
    if (!active) return false;
    if (data.length > MAX_MESSAGE_CHARS) { finish('oversize'); return false; }
    const rpc = parse(data);
    if (!rpc) { finish('invalid-message'); return false; }
    if (typeof rpc.method !== 'string') return false;
    if (rpc.method === 'process/start' || (rpc.method?.startsWith('fs/') && !READ_ONLY.has(rpc.method))) {
      finish(rpc.method === 'process/start' ? 'process-start' : 'write');
      return false;
    }
    if (rpc.method !== 'fs/getMetadata' || (typeof rpc.id !== 'string' && typeof rpc.id !== 'number')) return false;
    const uri = rpc.params?.path;
    if (typeof uri !== 'string' || !uri.startsWith('file://')) { if (deps.stats) deps.stats.rejectedUri += 1; return false; }
    let target: string;
    try { target = fileURLToPath(uri); } catch { if (deps.stats) deps.stats.rejectedUri += 1; return false; }
    if (path.basename(target) !== 'plugin.json' || !MANIFEST_DIRS.includes(path.basename(path.dirname(target)))) return false;
    const rest = { ...rpc.params };
    delete rest.path;
    const currentScope = JSON.stringify(rest);
    if (attempted && currentScope !== scope) { if (deps.stats) deps.stats.scopeMismatch += 1; return false; }
    // Do not infer equivalence for foreign encodings, drive letters or UNC paths. In CLI mode
    // such a query remains untouched and does not consume the first canonical prefetch opportunity.
    if (deps.incremental && pathToFileURL(target).href !== uri) {
      if (deps.stats) deps.stats.uriMismatch += 1;
      return false;
    }

    const newBranch = deps.incremental && !prefetched.has(uri);
    if (newBranch && prefetched.size >= maxPrefetched) {
      if (deps.stats) deps.stats.budgetExhausted = (deps.stats.budgetExhausted ?? 0) + 1;
      return false;
    }
    if (!attempted || newBranch) {
      attempted = true;
      if (deps.stats) deps.stats.attempted += 1;
      scope = currentScope;
      // Build the whole batch before forwarding: even a synchronous test transport may reply.
      const batch: string[] = [];
      let dir = path.dirname(path.dirname(target));
      for (let level = 0; level < MAX_LEVELS; level += 1) {
        for (const marker of MANIFEST_DIRS) {
          if (deps.incremental && prefetched.size >= maxPrefetched) break;
          const candidate = pathToFileURL(path.join(dir, marker, 'plugin.json')).href;
          if (deps.incremental && prefetched.has(candidate)) continue;
          const id = `${prefix}${deps.incremental ? nextId++ : batch.length}`;
          const message = JSON.stringify({ ...rpc, id, params: { ...rpc.params, path: candidate } });
          if (deps.shortcut(message) !== null) continue;
          if (deps.incremental) prefetched.add(candidate);
          pending.set(id, candidate);
          batch.push(message);
        }
        if (deps.incremental && prefetched.size >= maxPrefetched) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      // Match exact URIs; unfamiliar encodings keep their original query semantics.
      const held = [...pending.values()].includes(uri);
      if (deps.stats) {
        deps.stats.prefetched += batch.length;
        if (deps.incremental) deps.stats.batches = (deps.stats.batches ?? 0) + 1;
        if (!held) {
          if (!deps.incremental) deps.stats.uriMismatch += 1;
          else if (prefetched.size >= maxPrefetched) deps.stats.budgetExhausted = (deps.stats.budgetExhausted ?? 0) + 1;
          else deps.stats.unprefetched += 1;
        }
      }
      if (held) waiters.set(uri, [data]);
      for (const message of batch) deps.forward(message);
      return held;
    }
    if (absent.has(uri)) {
      if (deps.stats) deps.stats.answered += 1;
      deps.answer(JSON.stringify({ id: rpc.id, error: { code: EXEC_SERVER_NOT_FOUND_CODE, message: 'No such file or directory (os error 2)' } }));
      return true;
    }
    if ([...pending.values()].includes(uri)) {
      const messages = waiters.get(uri) ?? [];
      // Native startup is serial; cap retained duplicate queries if a peer misbehaves.
      if (messages.length >= 16) return false;
      messages.push(data);
      waiters.set(uri, messages);
      return true;
    }
    if (deps.stats) deps.stats.unprefetched += 1;
    return false;
  }

  function response(data: string): boolean {
    // Replies are already bounded/reassembled by the tunnel. Applying the request
    // optimization limit here would leak internal ids and strand their original queries.
    if (!pending.size) return false;
    const rpc = parse(data);
    if (!rpc || rpc.method !== undefined || typeof rpc.id !== 'string') return false;
    const uri = pending.get(rpc.id);
    if (uri === undefined) return false;
    pending.delete(rpc.id);
    if (deps.stats) {
      if (rpc.error?.code === EXEC_SERVER_NOT_FOUND_CODE) deps.stats.notFound += 1;
      else deps.stats.nonNotFound += 1;
    }
    if (active && rpc.error?.code === EXEC_SERVER_NOT_FOUND_CODE) absent.add(uri);
    const messages = waiters.get(uri) ?? [];
    waiters.delete(uri);
    for (const message of messages) {
      if (active && absent.has(uri)) {
        if (deps.stats) deps.stats.answered += 1;
        deps.answer(JSON.stringify({ ...rpc, id: parse(message)!.id }));
      } else deps.forward(message);
    }
    return true;
  }

  return { request, response, finish };
}

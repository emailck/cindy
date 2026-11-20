/**
 * Remote Agent task wiring. The controller itself is Desktop's, imported in place
 * (startRemoteAgentSession, executor, gate, project-file sync); this file supplies the
 * dependencies Desktop's controller/service.ts supplies, minus Desktop-only features
 * (local Cindy MCP tools, memory, managed Skills, change capture, PDF, group switching,
 * direct shared-executor allocation). Shared tasks keep the shared-provider rules:
 * credential files are not synced and credential operations need local confirmation unless this share is explicitly trusted
 * (provider-sharing.md §9 item 7).
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentKind, AgentSessionHandle, Effort, StartSessionOptions } from '@cindy/maker-core';
import { RemoteConnectionPool } from '../../desktop/src/main/remote-agent/controller/connectionPool';
import { remoteAgentEventMapper } from '../../desktop/src/main/remote-agent/controller/eventMap';
import {
  collectAncestorInstructionFiles, collectInstructionImports, collectPersonalConfig, collectProjectInstructionFiles,
} from '../../desktop/src/main/remote-agent/controller/projectFiles';
import { RemoteAgentPoller, RemoteAgentRunClient, remoteAgentInvoker } from '../../desktop/src/main/remote-agent/controller/runClient';
import { startRemoteAgentSession, type PreparedRemoteMcp } from '../../desktop/src/main/remote-agent/controller/startRemote';
import { credentialGrantFor } from '../../desktop/src/main/remote-agent/executor/credentialGrants';
import { findWindowsGitBash } from '../../desktop/src/main/remote-agent/executor/shell';
import type { RemoteInvoke } from './link';
import type { PermissionChoice } from './profile';
import { permissionOptions } from './permissions';

export { permissionOptions } from './permissions';
import { parseShareAgentDeviceId } from './catalog';

export interface RemoteTaskRequest {
  target: string;
  agent: AgentKind;
  providerId: string;
  model: string;
  effort?: string | null;
  permission: PermissionChoice;
  workingDir: string;
  /** Local task identity; stable across /resume. */
  sessionId: string;
  /** Native session id reported by the remote Agent; set when resuming. */
  resumeSessionId?: string;
  /** Text shown on the shared-provider credential confirmation, in the interface language. */
  credentialNotice: string;
}

/** Explicit override, then a repository checkout's bundled binary, then PATH. */
export function resolveRipgrep(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CINDY_CLI_RG) return env.CINDY_CLI_RG;
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ripgrep-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
  return existsSync(bundled) ? bundled : 'rg';
}

/**
 * Local prerequisites for the remote Agent's tools, which run here:
 *  - the Agent searches with `rg` through its Bash tool, so a bundled / CINDY_CLI_RG ripgrep is put on PATH;
 *  - on Windows commands need Git Bash (the Agent is told the shell is bash; without it they would run in cmd).
 */
export function prepareLocalTools(env: NodeJS.ProcessEnv = process.env): { rgPath: string; ripgrep: boolean; gitBash: boolean } {
  const rgPath = resolveRipgrep(env);
  if (path.isAbsolute(rgPath)) {
    const dir = path.dirname(rgPath);
    const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
    const entries = (env[key] ?? '').split(path.delimiter);
    if (!entries.includes(dir)) env[key] = [dir, ...entries.filter(Boolean)].join(path.delimiter);
  }
  return { rgPath, ripgrep: ripgrepAvailable('rg'), gitBash: process.platform !== 'win32' || findWindowsGitBash(env) !== null };
}

/** True when the resolved ripgrep actually runs. */
export function ripgrepAvailable(rgPath: string): boolean {
  try { return spawnSync(rgPath, ['--version'], { stdio: 'ignore', timeout: 5_000, windowsHide: true }).status === 0; }
  catch { return false; }
}

async function isGitRepo(workingDir: string): Promise<boolean> {
  let dir = path.resolve(workingDir);
  for (let i = 0; i < 64; i += 1) {
    try { await stat(path.join(dir, '.git')); return true; }
    catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
  return false;
}

const NO_LOCAL_MCP: PreparedRemoteMcp = { servers: new Map(), dispose() {} };

export interface RemoteTaskFactory {
  open(request: RemoteTaskRequest, signal?: AbortSignal): Promise<AgentSessionHandle>;
  /** Pool timers are unref'd; dropping references is enough. */
  dispose(): void;
}

/** One poller and connection pool per Agent computer, shared by every task on it (Desktop parity). */
export function createRemoteTaskFactory(invoke: RemoteInvoke, options: { rgPath?: string; /** Per-operation lookup by share id, never same-account device id. */ isShareTrusted?(shareId: string): boolean; log?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void } } = {}): RemoteTaskFactory {
  const log = options.log ?? { info() {}, warn() {} };
  const pollers = new Map<string, RemoteAgentPoller>();
  const pools = new Map<string, RemoteConnectionPool>();
  const pollerFor = (target: string) => {
    let poller = pollers.get(target);
    if (!poller) { poller = new RemoteAgentPoller(remoteAgentInvoker(target, invoke), log); pollers.set(target, poller); }
    return poller;
  };
  const poolFor = (target: string) => {
    let pool = pools.get(target);
    if (!pool) {
      const caps = remoteAgentInvoker(target, invoke);
      pool = new RemoteConnectionPool({ log, readCaps: () => RemoteAgentRunClient.caps(caps) });
      pools.set(target, pool);
    }
    return pool;
  };
  const rgPath = options.rgPath ?? resolveRipgrep();
  return {
    async open(request, signal) {
      const shareId = parseShareAgentDeviceId(request.target);
      const shared = shareId !== null;
      const collect = { skipCredentials: shared };
      const permission = permissionOptions(request.permission);
      const opts: StartSessionOptions = {
        sessionId: request.sessionId,
        workingDir: request.workingDir,
        model: request.model,
        providerId: request.providerId,
        ...(request.effort ? { effort: request.effort as Effort } : {}),
        ...permission,
        ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
      };
      const poller = pollerFor(request.target);
      return startRemoteAgentSession(request.agent as Parameters<typeof startRemoteAgentSession>[0], opts, {
        ...(signal ? { startupSignal: signal } : {}),
        invoke: poller.invoke,
        poller,
        pool: poolFor(request.target),
        rgPath,
        ...(shared ? { credentialConsent: { description: request.credentialNotice, grant: credentialGrantFor(request.sessionId, request.target), skip: () => shareId !== null && options.isShareTrusted?.(shareId) === true } } : {}),
        prepareMcp: async () => NO_LOCAL_MCP,
        collectProjectFiles: workingDir => collectProjectInstructionFiles(workingDir, collect),
        collectAncestorFiles: workingDir => collectAncestorInstructionFiles(workingDir, collect),
        collectPersonal: (kind, projectFiles) => collectPersonalConfig(kind, projectFiles, collect),
        collectImports: imports => collectInstructionImports(imports, collect),
        isGitRepo,
        mapEvent: remoteAgentEventMapper,
        newId: randomUUID,
        log: { info: log.info, warn: log.warn },
      });
    },
    dispose() {
      pollers.clear(); pools.clear();
    },
  };
}

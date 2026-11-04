import path from 'node:path';
import { mkdir, open, unlink } from 'node:fs/promises';
import { HostCliError, resolveDataDirectory } from './config';

/** Serializes serve and credential-changing commands to prevent refresh-token rotation races. */
export async function withProfileLock<T>(dataDir: string, action: (signal: AbortSignal) => Promise<T>, options: { signals?: SignalSource } = {}): Promise<T> {
  const signals = options.signals ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signals.on('SIGINT', cancel);
  signals.on('SIGTERM', cancel);
  try {
    const safeDirectory = await resolveDataDirectory(dataDir);
    await mkdir(safeDirectory, { recursive: true, mode: 0o700 });
    if (controller.signal.aborted) throw new HostCliError('COMMAND_CANCELLED', 'Command cancelled.');
    const file = path.join(safeDirectory, 'profile.lock');
    let lock;
    try { lock = await open(file, 'wx', 0o600); }
    catch { throw new HostCliError('PROFILE_BUSY', 'The profile is in use or cannot be locked. Stop its host before changing it. If a crash left profile.lock, verify the old process has stopped before removing the lock.'); }
    try {
      await lock.writeFile(`${process.pid}\n`);
      if (controller.signal.aborted) throw new HostCliError('COMMAND_CANCELLED', 'Command cancelled.');
      return await action(controller.signal);
    } finally { await lock.close(); await unlink(file); }
  } finally {
    signals.removeListener('SIGINT', cancel);
    signals.removeListener('SIGTERM', cancel);
  }
}

export interface HostLifecycle {
  /** Must honor abort during startup. Reject startup instead of reporting a partial connection as ready. */
  start(signal: AbortSignal): Promise<void>;
  /** Idempotent; releases relay, engine, credential/session resources even after failed startup. */
  stop(): Promise<void>;
  /** Rejects on fatal runtime failure, resolves on runtime shutdown. */
  waitUntilStopped?(): Promise<void>;
}
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export async function serveHost(hostOrFactory: HostLifecycle | (() => Promise<HostLifecycle>), options: { signals?: SignalSource; ready?: () => void } = {}): Promise<void> {
  const signals = options.signals ?? process;
  const controller = new AbortController();
  let notifyStop!: () => void;
  const stopped = new Promise<void>(resolve => { notifyStop = resolve; });
  const requestStop = () => { controller.abort(); notifyStop(); };
  signals.on('SIGINT', requestStop);
  signals.on('SIGTERM', requestStop);
  let host: HostLifecycle | undefined;
  try {
    host = typeof hostOrFactory === 'function' ? await hostOrFactory() : hostOrFactory;
    if (!controller.signal.aborted) await host.start(controller.signal);
    if (!controller.signal.aborted) {
      options.ready?.();
      await (host.waitUntilStopped ? Promise.race([stopped, host.waitUntilStopped()]) : stopped);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort();
    try { await host?.stop(); }
    finally {
      signals.removeListener('SIGINT', requestStop);
      signals.removeListener('SIGTERM', requestStop);
    }
  }
}

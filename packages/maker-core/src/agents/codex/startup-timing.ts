import { performance } from 'node:perf_hooks';
import type { Logger } from '../../interfaces/logger.js';

type Stage = 'auth-status' | 'process-spawn' | 'initialize' | 'ephemeral-auth-config'
  | 'external-auth' | 'capability-skills' | 'capability-config' | 'capability-mcp-status'
  | 'native-review-config' | 'hosted-mcp-config' | 'guest-features' | 'environment-add'
  | 'thread-start' | 'thread-resume' | 'session-total';

/** Local, monotonic diagnostics only. Never accept RPC bodies, paths or error text. */
export function codexStartupTiming(logger?: Logger, sessionId?: string, hostId?: string) {
  const epoch = performance.now();
  let runtimeVersion: string | undefined;
  return {
    setRuntimeVersion(userAgent?: string) {
      // userAgent can contain paths and platform details; retain only numeric semver.
      runtimeVersion = userAgent?.match(/(?:^|[\s/])(\d{1,6}\.\d{1,6}\.\d{1,6})(?=$|[\s/)])/u)?.[1];
    },
    begin(stage: Stage) {
      const started = performance.now();
      const emit = (status: 'started' | 'ok' | 'failed') => {
        try {
          logger?.info('remote agent startup timing', {
            side: 'codex', stage, status,
            ...(sessionId ? { sessionRef: sessionId.slice(0, 8) } : {}),
            ...(hostId ? { hostRef: hostId.slice(0, 8) } : {}),
            ...(runtimeVersion ? { runtimeVersion } : {}),
            ...(status === 'started' ? {} : { durationMs: Math.max(0, Math.round(performance.now() - started)) }),
            elapsedMs: Math.max(0, Math.round(performance.now() - epoch)),
          });
        } catch { /* A failed diagnostic sink must not change startup or replace its error. */ }
      };
      emit('started');
      return (status: 'ok' | 'failed') => emit(status);
    },
    async measure<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
      if (!logger) return operation();
      const end = this.begin(stage);
      try {
        const value = await operation();
        end('ok');
        return value;
      } catch (error) {
        end('failed');
        throw error;
      }
    },
  };
}

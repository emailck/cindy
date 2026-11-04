import type { AuthFetch } from '@cindy/auth-client';

/** Preserve successful credential rotations through cancellation; ordinary requests abort. */
export function createHostAuthFetch(signal?: AbortSignal, fetch: AuthFetch = globalThis.fetch): AuthFetch {
  return (input, init) => {
    const rotating = ['/api/auth/refresh', '/api/auth/account/refresh'].includes(new URL(input).pathname);
    // credentials-and-local-storage: a sent rotation must reach its protected commit.
    signal?.throwIfAborted();
    return fetch(input, {
      ...init,
      signal: !rotating && signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal,
    });
  };
}

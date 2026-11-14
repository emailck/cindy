import { describe, expect, it, vi } from 'vitest';
import { readAccountRateLimitsWithRefresh } from './account-rate-limits.js';
import { AppServerClient } from './client.js';
import { createConsoleLogger } from '../../../interfaces/logger.js';
import type { LineHandler } from './transport.js';
import { Method } from './protocol.js';

const expired = new Error('codex app-server account/rateLimits/read error -32603: 401 Unauthorized; {"code":"token_expired"}');

describe('native account rate limit renewal', () => {
  it('refreshes a recoverable expired access token before retrying the read once', async () => {
    const result = { rateLimits: { planType: 'pro' } };
    const request = vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce({}).mockResolvedValueOnce(result);
    await expect(readAccountRateLimitsWithRefresh(request)).resolves.toEqual(result);
    expect(request.mock.calls).toEqual([
      [Method.AccountRateLimitsRead, undefined, { timeoutMs: 15_000 }],
      ['account/read', { refreshToken: true }, { timeoutMs: 8_000 }],
      [Method.AccountRateLimitsRead, undefined, { timeoutMs: 15_000 }],
    ]);
  });

  // Production entry: a stalled quota RPC must reject, without OAuth renewal/retry.
  // Existing mocks only cover immediate replies; the minimal regression is a connected
  // in-memory app-server that never answers an initial read, refresh, or retry (unit tier).
  it.each(['initial read', 'refresh', 'retried read'] as const)('bounds a stalled %s with its own deadline', async stage => {
    vi.useFakeTimers();
    let receive: LineHandler = () => {};
    const methods: string[] = [];
    const client = new AppServerClient({
      logger: createConsoleLogger('quota-test'),
      createTransport: () => ({
        async writeLine(line) {
          const { id, method } = JSON.parse(line);
          methods.push(method);
          if (stage !== 'initial read' && methods.length === 1) {
            receive(JSON.stringify({ id, error: { code: -32603, message: '401 token_expired' } }));
          } else if (stage === 'retried read' && methods.length === 2) {
            receive(JSON.stringify({ id, result: {} }));
          }
        },
        onLine(handler) { receive = handler; return () => {}; },
        onClose() { return () => {}; },
        onStderr() { return () => {}; },
        async close() {},
      }),
    });
    try {
      client.start();
      const settled = vi.fn();
      const pending = readAccountRateLimitsWithRefresh(client.request.bind(client));
      void pending.then(settled, settled);
      const method = stage === 'refresh' ? 'account/read' : Method.AccountRateLimitsRead;
      const deadline = stage === 'refresh' ? 8_000 : 15_000;
      const rejection = expect(pending).rejects.toThrow(`${method} timed out after ${deadline}ms`);
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(methods).toEqual(stage === 'initial read' ? [Method.AccountRateLimitsRead]
        : stage === 'refresh' ? [Method.AccountRateLimitsRead, 'account/read']
          : [Method.AccountRateLimitsRead, 'account/read', Method.AccountRateLimitsRead]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await client.close();
      vi.useRealTimers();
    }
  });

  it.each([
    '401 token_expired',
    'codex app-server model/list error: 401 token_expired',
    'codex app-server account/rateLimits/read error: 401 token_expired token_revoked',
    'codex app-server account/rateLimits/read error: 401 token_expired token_invalidated',
    'codex app-server account/rateLimits/read error: 401 token_expired refresh_token_reused',
    'codex app-server account/rateLimits/read error: 429',
    'codex app-server account/rateLimits/read error: 502 upstream unreachable',
  ])('does not refresh unrelated or permanent errors: %s', message => {
    const error = new Error(message);
    const request = vi.fn().mockRejectedValue(error);
    return expect(readAccountRateLimitsWithRefresh(request)).rejects.toBe(error).then(() => {
      expect(request).toHaveBeenCalledOnce();
    });
  });

  it('does not loop when renewal fails or the renewed token is still rejected', async () => {
    const refreshFailed = new Error('network unavailable');
    const failed = vi.fn().mockRejectedValueOnce(expired).mockRejectedValueOnce(refreshFailed);
    await expect(readAccountRateLimitsWithRefresh(failed)).rejects.toBe(refreshFailed);
    expect(failed).toHaveBeenCalledTimes(2);
    const rejected = vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce({}).mockRejectedValueOnce(expired);
    await expect(readAccountRateLimitsWithRefresh(rejected)).rejects.toBe(expired);
    expect(rejected).toHaveBeenCalledTimes(3);
  });
});

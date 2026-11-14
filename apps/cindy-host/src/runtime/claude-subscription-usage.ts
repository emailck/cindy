import { parseClaudeOAuthUsageResponse, type ClaudeSubscriptionUsageSnapshot } from '@cindy/maker-shared/subscription-usage';
import type { ClaudeRateLimitsRead } from './claude-quota';

/** Existing Desktop same-account channel; the snapshot shape is the shared Desktop contract. */
export const CLAUDE_SUBSCRIPTION_USAGE_CHANNEL = 'maker:usage:claude-subscription';
/** Each read starts a native Claude process, so concurrent readers share one result per window. */
const THROTTLE_MS = 60_000;
const FAILURE_BACKOFF_MS = 60_000;

/**
 * Same-account reader for the CLI host. Unlike Desktop's cached-first reader there is no push
 * channel to deliver a background refresh, so a stale read waits for the native result.
 * Explicit "no plan limits" clears the cache; unreadable or failed reads keep the last snapshot.
 */
export function createClaudeSubscriptionUsageReader(fetchRaw: () => Promise<ClaudeRateLimitsRead>, now = Date.now) {
  let cached: { snapshot: ClaudeSubscriptionUsageSnapshot | null; at: number } | undefined;
  let failedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<ClaudeSubscriptionUsageSnapshot | null> | undefined;
  const unavailable = () => new Error('Claude subscription usage is unavailable.');
  async function refresh(): Promise<ClaudeSubscriptionUsageSnapshot | null> {
    try {
      const raw = await fetchRaw();
      const at = now();
      if (raw === 'empty') { cached = { snapshot: null, at }; failedAt = Number.NEGATIVE_INFINITY; return null; }
      const parsed = parseClaudeOAuthUsageResponse(raw.rateLimits, at);
      // An unrecognized body is a shape change, not "no limits".
      if (!parsed) throw unavailable();
      const snapshot = raw.subscriptionType ? { ...parsed, subscriptionType: raw.subscriptionType } : parsed;
      cached = { snapshot, at }; failedAt = Number.NEGATIVE_INFINITY;
      return snapshot;
    } catch {
      failedAt = now();
      if (cached) return cached.snapshot;
      throw unavailable();
    }
  }
  return {
    read(): Promise<ClaudeSubscriptionUsageSnapshot | null> {
      const t = now();
      if (cached && t - cached.at < THROTTLE_MS) return Promise.resolve(cached.snapshot);
      if (t - failedAt < FAILURE_BACKOFF_MS) return cached ? Promise.resolve(cached.snapshot) : Promise.reject(unavailable());
      inFlight ??= refresh().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}

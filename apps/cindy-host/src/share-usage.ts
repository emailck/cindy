import { createHash } from 'node:crypto';
import type { ProviderShareOwned } from '@cindy/device-link';
import { providerUsageLocalDay, type ProviderShareUsageStore } from '@cindy/remote-agent-host/providerShareUsageStore';

export interface UsageDay {
  day: string; kind: string; model: string; turns: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheCreateTokens: number;
  amount: { amount: number; currency: 'USD' | 'CNY' } | null;
}
export interface UsageDetails {
  todayKey: string; coverageStart: string | null;
  parties: Array<{ key: string; displayName: string; avatarUrl: string | null; isYou: boolean;
    isOwner: boolean; isRelay: boolean; lastUsedAt: number | null; days: UsageDay[] }>;
}

/** Only recorded share members; never synthesize an owner total from guest-only accounting. */
export function readShareUsage(ledger: ProviderShareUsageStore, share: ProviderShareOwned, viewer: string, providerId: string): UsageDetails {
  const shareIds = new Set([share.shareId]);
  if (!ledger.memberTokenSnapshot(shareIds, providerId, viewer).available) throw new Error('Share usage unavailable');
  const history = ledger.history(shareIds, { maxRows: 5001,
    memberKeys: new Set(share.members.map(member => JSON.stringify([share.shareId, member.memberId]))) });
  const byMember = new Map(history.map(member => [member.memberId, member]));
  const result: UsageDetails = { todayKey: providerUsageLocalDay(Date.now()), coverageStart: null,
    parties: share.members.map(member => ({
      key: createHash('sha256').update(JSON.stringify([share.shareId, member.memberId])).digest('hex').slice(0, 24),
      displayName: member.displayName, avatarUrl: member.avatarUrl, isYou: member.memberId === viewer,
      isOwner: false, isRelay: false, lastUsedAt: byMember.get(member.memberId)?.lastUsedAt ?? null, days: [],
    })) };
  const rows = history.flatMap(member => member.days.map(row => ({ memberId: member.memberId, row })))
    .filter(({ row }) => row.providerId === providerId).sort((a, b) => b.row.day.localeCompare(a.row.day));
  const parties = new Map(share.members.map((member, index) => [member.memberId, result.parties[index]]));
  for (const { memberId, row } of rows.slice(0, 5000)) {
    const party = parties.get(memberId)!;
    // Explicit projection excludes device keys, provider/account identity and raw SDK metadata.
    const amount = row.sdkCostUsd > 0 ? { amount: row.sdkCostUsd, currency: 'USD' as const } : null;
    const previous = party.days.find(day => day.day === row.day && day.kind === row.kind && day.model === row.model);
    if (previous) {
      previous.turns += row.turns; previous.inputTokens += row.inputTokens; previous.outputTokens += row.outputTokens;
      previous.cacheReadTokens += row.cacheReadTokens; previous.cacheCreateTokens += row.cacheCreateTokens;
      previous.amount = previous.amount && amount ? { amount: previous.amount.amount + amount.amount, currency: 'USD' } : null;
    } else party.days.push({ day: row.day, kind: row.kind, model: row.model, turns: row.turns,
      inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens,
      cacheCreateTokens: row.cacheCreateTokens, amount });
  }
  if (rows.length > 5000) result.coverageStart = rows[4999].row.day;
  return result;
}

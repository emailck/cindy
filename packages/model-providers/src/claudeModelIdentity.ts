/** Existing Claude discovery identity: route/window suffixes are not catalog members. */
export function normalizeClaudeCatalogModelId(raw: string): string {
  return raw.replace(/\[[^\]]*\]$/, '').replace(/-20\d{6}$/, '');
}

/** Resolve SDK family aliases only when their description declares a matching concrete version. */
export function resolveClaudeSdkModelId(value: string, description: unknown): string | null {
  const normalized = normalizeClaudeCatalogModelId(value);
  if (normalized.startsWith('claude')) return normalized;
  const alias = normalized.toLowerCase();
  const match = typeof description === 'string'
    ? /^(?:Claude\s+)?([A-Za-z]+)\s+(\d+)(?:\.(\d+))?(?![\w.])/.exec(description.trim()) : null;
  const family = match?.[1]?.toLowerCase();
  return match && family && (alias === 'default' || alias === family)
    ? `claude-${family}-${match[2]}${match[3] !== undefined ? `-${match[3]}` : ''}` : null;
}

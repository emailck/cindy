/**
 * subscriptionUsage — 订阅账号余量快照的跨端契约与必须同口径的纯判定。
 *
 * 这些快照由被控端 desktop 读取(`maker:usage:claude-subscription` /
 * `maker:usage:xai-subscription`),desktop renderer 与 mobile 任务菜单都要按同一套规则
 * 选窗口、判新鲜度 —— 两份实现必然漂移(见 codexUsageBuckets 的同类教训)。
 * 来源解析(端点 / headers 归一化)在 desktop shared,只在被控端执行;CLI 提供端
 * (apps/cindy-host)用下方 parseClaudeOAuthUsageResponse 的同口径副本。
 */

// ── Claude 订阅 ──────────────────────────────────────────────────────────────

/** 单个用量窗口(5h / 周 / 分模型周)。utilization 一律 0-100 已用百分比。 */
export interface ClaudeUsageWindow {
  utilization: number;
  /** Unix epoch 秒;缺失 = 未知。 */
  resetsAt?: number | null;
  /** 服务端判定的告警级别(端点 limits[].severity,如 'normal';headers 源无此字段)。 */
  severity?: string | null;
}

/** 分模型周窗口(端点 limits[] 里 kind=weekly_scoped 的条目)。 */
export interface ClaudeScopedUsageWindow extends ClaudeUsageWindow {
  /** scope.model.display_name,如 'Fable' / 'Opus' / 'Sonnet'。 */
  modelDisplayName: string;
  /** scope.model.id(端点常为 null)。 */
  modelId?: string | null;
}

/** extra usage(usage credits)状态 —— 套餐打满后的按量付费通道。 */
export interface ClaudeExtraUsageSnapshot {
  isEnabled: boolean;
  /** 0-100;仅启用且服务端给值时有。 */
  utilization?: number | null;
  /**
   * 已用 credits(服务端原值)。单位未文档化,不要当货币金额展示;
   * 仅保留原始值,等拿到 extra-usage 账号实样后再定展示口径。
   */
  usedCredits?: number | null;
  /** 月度上限原值;0 = 不限。单位未文档化,不要当货币金额展示。 */
  monthlyLimit?: number | null;
}

export interface ClaudeSubscriptionUsageSnapshot {
  /** 5 小时滚动窗口。 */
  fiveHour?: ClaudeUsageWindow | null;
  /** 总周限窗口。 */
  sevenDay?: ClaudeUsageWindow | null;
  /** 分模型周窗口(仅 oauth-endpoint 源有)。 */
  scoped?: ClaudeScopedUsageWindow[];
  /** 订阅套餐(凭证 blob 的 subscriptionType: pro / max 等,记录时由 main 一并写入)。 */
  subscriptionType?: string | null;
  /** headers 源的整体状态:allowed / allowed_warning / rejected。 */
  rateLimitStatus?: string | null;
  /** headers 源:当前代表性(最紧)窗口名,如 'five_hour' / 'seven_day'。 */
  representativeClaim?: string | null;
  extraUsage?: ClaudeExtraUsageSnapshot | null;
  source?: 'oauth-endpoint' | 'unified-headers' | string | null;
  /** 快照生成时间(ms epoch)。 */
  updatedAt?: number | null;
  /**
   * 归属账号的 OAuth token 指纹(sha256 截断, main 记录时附加, 不含 token 原文)。
   * 同机换号时 reader 据此判定持久化快照已过期, 避免 chip 闪上一个账号的余量。
   * 缺失(旧快照 / 仅 headers 源)时按未知归属处理, 不据此清除。
   */
  accountFingerprint?: string | null;
}

// ── 方案 B:当前模型 → scoped 窗口匹配 ───────────────────────────────────────

/**
 * 去掉末尾的 `[...]` 后缀(如 `[1m]`),等价于 `/\[[^\]]*\]\s*$/`。不用正则:
 * model id 来自远端数据,该正则在大量 `[` 的输入上是多项式回溯(CodeQL)。
 */
function stripTrailingBracketSuffix(value: string): string {
  const close = value.trimEnd().length - 1;
  if (close < 0 || value[close] !== ']') return value;
  const open = value.indexOf('[', value.lastIndexOf(']', close - 1) + 1);
  return open >= 0 && open < close ? value.slice(0, open) : value;
}

/**
 * 从 model id 提取模型家族名(与端点 scope.model.display_name 对齐的小写词)。
 *   'claude-fable-5[1m]' → 'fable';'claude-opus-4-8' → 'opus';'sonnet' → 'sonnet'
 * 未识别 → null(调用方回退总周限)。
 */
export function claudeModelFamily(modelId: string | null | undefined): string | null {
  const normalized = stripTrailingBracketSuffix((modelId ?? '').trim().toLowerCase());
  if (!normalized) return null;
  // 顺序无关 —— 家族名互斥地出现在 Anthropic model id 里。
  for (const family of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) {
    if (normalized.includes(family)) return family;
  }
  return null;
}

/**
 * 判断一个分模型周窗口是否属于指定家族。
 *
 * 优先用窗口自带的 `modelId` 经 `claudeModelFamily` 归类(权威、精确);`modelId`
 * 缺失或无法归类(端点常为 null,或 id 形态不在识别表里)时,回退用 `modelDisplayName`
 * 的变体包含匹配——端点对 display_name 的口径历史上有 "Fable" / "Claude Fable" /
 * "Fable 5" 等形态,精确等于会漏掉变体(issue #3244)。家族名互斥,不会跨家族误命中。
 *
 * matcher(`matchScopedWindowForModel`)与 legacy 兜底去重共用这一份口径,避免两份
 * includes 规则漂移。
 */
export function scopedWindowBelongsToFamily(
  window: ClaudeScopedUsageWindow,
  family: string,
): boolean {
  const fromId = claudeModelFamily(window.modelId);
  if (fromId) return fromId === family;
  return window.modelDisplayName.trim().toLowerCase().includes(family);
}

/**
 * 找当前会话模型对应的分模型周窗口(chip 方案 B:第二栏跟随当前模型)。
 * 找不到 → null,调用方回退 sevenDay 总周限(绝不臆造)。家族归属口径见
 * scopedWindowBelongsToFamily。
 */
export function matchScopedWindowForModel(
  scoped: ClaudeScopedUsageWindow[] | null | undefined,
  modelId: string | null | undefined,
): ClaudeScopedUsageWindow | null {
  if (!scoped || scoped.length === 0) return null;
  const family = claudeModelFamily(modelId);
  if (!family) return null;
  return scoped.find((w) => scopedWindowBelongsToFamily(w, family)) ?? null;
}

// ── Claude 订阅端点解析 ─────────────────────────────────────────────────────
// get_usage / GET /api/oauth/usage 的 rate_limits → 快照,供 CLI 提供端(apps/cindy-host)
// 回答同账号 `maker:usage:claude-subscription`。与 desktop shared/claudeSubscriptionUsage.ts
// 的同名函数逐字一致;Desktop 暂未改用此处,两边修改须同步(后续可让 Desktop 改为重新导出)。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  // Number(null) / Number('') 都是 0 —— 显式排除, null 语义必须保留为"无数据"。
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** ISO8601 字符串 / epoch 秒 → epoch 秒;解析不了 → null。 */
function toEpochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string' && v.length > 0) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return null;
}

function toOptionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// ── oauth-endpoint 解析 ──────────────────────────────────────────────────────

/** limits[] 单条 → 窗口(utilization 取 percent 字段,0-100)。 */
function parseLimitEntryWindow(entry: Record<string, unknown>): ClaudeUsageWindow | null {
  const percent = toFiniteNumber(entry.percent);
  if (percent === null) return null;
  return {
    utilization: clampPercent(percent),
    resetsAt: toEpochSeconds(entry.resets_at),
    severity: toOptionalString(entry.severity),
  };
}

/** 旧 schema 顶层键(five_hour 等)→ 窗口(utilization 字段,0-100)。 */
function parseLegacyWindow(v: unknown): ClaudeUsageWindow | null {
  if (!isPlainObject(v)) return null;
  const utilization = toFiniteNumber(v.utilization);
  if (utilization === null) return null;
  return {
    utilization: clampPercent(utilization),
    resetsAt: toEpochSeconds(v.resets_at),
  };
}

function parseExtraUsage(v: unknown): ClaudeExtraUsageSnapshot | null {
  if (!isPlainObject(v)) return null;
  const isEnabled = v.is_enabled === true;
  const utilization = toFiniteNumber(v.utilization);
  const usedCredits = toFiniteNumber(v.used_credits);
  const monthlyLimit = toFiniteNumber(v.monthly_limit);
  if (!isEnabled && utilization === null && usedCredits === null) return null;
  return {
    isEnabled,
    utilization: utilization === null ? null : clampPercent(utilization),
    usedCredits,
    monthlyLimit,
  };
}

/**
 * 解析 GET /api/oauth/usage 的响应 JSON。
 *
 * 优先走新 schema 的 `limits[]`(带 severity / scoped 模型信息);旧 schema 顶层键兜底。
 * 未知字段(实验性混淆键等)一律忽略。解析不出任何窗口时返回 null。
 */
export function parseClaudeOAuthUsageResponse(
  data: unknown,
  now: number,
): ClaudeSubscriptionUsageSnapshot | null {
  if (!isPlainObject(data)) return null;

  let fiveHour: ClaudeUsageWindow | null = null;
  let sevenDay: ClaudeUsageWindow | null = null;
  const scoped: ClaudeScopedUsageWindow[] = [];

  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const raw of limits) {
    if (!isPlainObject(raw)) continue;
    const window = parseLimitEntryWindow(raw);
    if (!window) continue;
    const kind = toOptionalString(raw.kind);
    if (kind === 'session') {
      fiveHour = window;
    } else if (kind === 'weekly_all') {
      sevenDay = window;
    } else if (kind === 'weekly_scoped') {
      const scope = isPlainObject(raw.scope) ? raw.scope : null;
      const model = scope && isPlainObject(scope.model) ? scope.model : null;
      const displayName = model ? toOptionalString(model.display_name) : null;
      if (displayName) {
        scoped.push({
          ...window,
          modelDisplayName: displayName,
          modelId: model ? toOptionalString(model.id) : null,
        });
      }
    }
    // 未知 kind(未来新窗口类型)静默跳过 —— fail-safe。
  }

  // 旧 schema 兜底:limits[] 没给的窗口再看顶层键。
  if (!fiveHour) fiveHour = parseLegacyWindow(data.five_hour);
  if (!sevenDay) sevenDay = parseLegacyWindow(data.seven_day);
  // 旧 schema 分模型周窗口兜底:按家族补 limits[] 没给 weekly_scoped 的家族,从顶层
  // seven_day_<model> 键取。不能用 `scoped.length === 0` 整体门控——混合/降级响应里
  // limits[] 可能只给了部分家族(如只有 Opus),其余家族(Fable)只通过顶层键下发;某家族
  // 的 weekly_scoped 畸形被跳过时同理。已由 limits[] 给出的家族以 limits[] 为准,不被
  // legacy 覆盖。家族归属统一走 scopedWindowBelongsToFamily,与 matchScopedWindowForModel
  // 同一份口径,避免两份 includes 规则漂移。Fable 是较新加的家族,旧兜底原先只列
  // Opus/Sonnet,走旧端点或降级快照时 Fable 周限丢失(issue #3244);Mythos/Haiku 端点
  // 目前不下发分模型周窗口,如未来新增在此追加。
  const legacyScoped: Array<[unknown, string]> = [
    [data.seven_day_opus, 'Opus'],
    [data.seven_day_sonnet, 'Sonnet'],
    [(data as { seven_day_fable?: unknown }).seven_day_fable, 'Fable'],
  ];
  for (const [raw, displayName] of legacyScoped) {
    const family = displayName.toLowerCase();
    if (scoped.some((w) => scopedWindowBelongsToFamily(w, family))) continue;
    const window = parseLegacyWindow(raw);
    if (window) scoped.push({ ...window, modelDisplayName: displayName });
  }

  if (!fiveHour && !sevenDay && scoped.length === 0) return null;

  return {
    fiveHour,
    sevenDay,
    scoped,
    extraUsage: parseExtraUsage(data.extra_usage),
    source: 'oauth-endpoint',
    updatedAt: now,
  };
}

// ── xAI(SuperGrok)订阅 ───────────────────────────────────────────────────────

/** 分产品周用量(页面「Grok Build 2%」)。 */
export interface XaiProductUsage {
  /** 上游 product id,如 GrokBuild。 */
  product: string;
  /** 0-100 已用百分比。 */
  usagePercent: number;
}

export interface XaiSubscriptionUsageSnapshot {
  /** 套餐展示名,如 SuperGrok Heavy。 */
  planLabel?: string | null;
  /** 0-100 本周已用百分比(页面「2% 已使用」)。 */
  creditUsagePercent?: number | null;
  /** Unix epoch 秒;周窗口重置时刻。 */
  resetsAt?: number | null;
  /** 分产品已用百分比。 */
  productUsage?: XaiProductUsage[];
  /**
   * 额外使用点数余额。单位按 grok.com 页面为美元;0 / 缺失不要当「免费额度」展示。
   */
  prepaidBalance?: number | null;
  source?: 'cli-billing' | string | null;
  updatedAt?: number | null;
  /**
   * 稳定账号指纹(OIDC sub 的不可逆哈希)。换 SuperGrok 号时用来丢掉旧快照。
   * 不是 access token 哈希 —— token 刷新会轮换。
   */
  accountFingerprint?: string | null;
}

/** 超过这个时间没刷新到新快照,就不再当「当前额度」展示。 */
export const XAI_USAGE_STALE_MS = 30 * 60 * 1000;

/**
 * 周窗口数字是否还能当当前额度:过了 TTL,或已经过了 resetsAt 却还没新快照,
 * 都不当当前值(避免无限显示旧百分比 / 卡在「重置中」)。套餐名仍可单独展示。
 */
export function isXaiWeeklyUsageCurrent(
  snapshot: XaiSubscriptionUsageSnapshot | null | undefined,
  nowMs: number,
): boolean {
  if (!snapshot) return false;
  if (
    typeof snapshot.creditUsagePercent !== 'number'
    || !Number.isFinite(snapshot.creditUsagePercent)
  ) {
    return false;
  }
  if (typeof snapshot.updatedAt !== 'number' || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt <= 0) {
    return false;
  }
  if (nowMs - snapshot.updatedAt > XAI_USAGE_STALE_MS) return false;
  if (typeof snapshot.resetsAt === 'number' && Number.isFinite(snapshot.resetsAt) && snapshot.resetsAt > 0) {
    if (nowMs >= snapshot.resetsAt * 1000) return false;
  }
  return true;
}

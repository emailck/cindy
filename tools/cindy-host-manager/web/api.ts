export interface AccountIdentity {
  displayName?: string;
  email?: string;
  loginMethod?: "cindy" | "chatgpt" | "claude" | "api-key";
  plan?: string;
  organization?: string;
}
export interface Instance {
  id: string;
  name: string;
  engine: "codex" | "claude-code";
  proxyMode: "none" | "default" | "custom" | "network";
  networkId?: string;
  networkName?: string;
  proxyUrl?: string;
  proxyAuthConfigured?: boolean;
  createdAt: string;
  state: "stopped" | "running" | "busy" | "error" | "missing";
  error?: string;
  accounts?: {
    cindy: AccountIdentity | null;
    provider: AccountIdentity | null;
  };
  authentication?: {
    cindy: "stored" | "missing" | "unknown";
    provider: "authenticated" | "missing" | "unknown";
  };
}
/** Result of the in-container "hi" test. */
export interface ProviderTest {
  ok: boolean;
  reply?: string;
  error?: string;
  model?: string;
  timedOut?: boolean;
  durationMs: number;
  checkedAt: string;
}
export interface UsageWindow {
  kind: "session" | "week" | "model" | "other";
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  windowMinutes?: number;
}
/** Subscription plan and quota windows read by the in-container CLI. */
export interface ProviderUsage {
  state: "ready" | "no-limits" | "unavailable";
  plan?: string;
  windows: UsageWindow[];
  limitReached?: boolean;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  extraUsage?: { enabled: boolean; usedPercent?: number };
  error?: string;
  timedOut?: boolean;
  checkedAt: string;
}
export interface Settings {
  image: string;
  proxyConfigured: boolean;
  proxyUrl: string | null;
  /** Gateway image for networks; null when networks are disabled on this computer. */
  gatewayImage?: string | null;
}
/** Forced-egress network shared by instances; the gateway is its only way out. */
export interface Network {
  id: string;
  name: string;
  subnet: string;
  gateway: string;
  proxyUrl: string;
  proxyAuthConfigured: boolean;
  directDomains: string[];
  createdAt: string;
  state: "running" | "stopped" | "missing" | "busy" | "error";
  instances: { id: string; name: string }[];
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class Api {
  csrf = "";
  constructor(readonly prefix = "/api") {}
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(
      `${path === "/session" ? "/api" : this.prefix}${path}`,
      {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(method !== "GET" ? { "X-CSRF-Token": this.csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        response.status,
        data.error?.code ?? "REQUEST_FAILED",
        data.error?.message ?? "",
      );
    return data as T;
  }
}
export function safeHttps(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
// A streaming chunk boundary is not a URL boundary. Wait for a delimiter, and
// preserve every URL character (including OAuth query punctuation) verbatim.
export function loginLinks(text: string): string[] {
  return [
    ...new Set(
      (text.match(/https:\/\/[^\s\x00-\x20<>"']+(?=[\s\x00-\x20<>"'])/g) ?? [])
        .map((value) => safeHttps(value))
        .filter((value): value is string => !!value),
    ),
  ];
}

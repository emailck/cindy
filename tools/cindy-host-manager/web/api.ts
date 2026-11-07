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
  proxyMode: "none" | "default" | "custom";
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
export interface Settings {
  image: string;
  proxyConfigured: boolean;
  proxyUrl: string | null;
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
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(method !== "GET" ? { "X-CSRF-Token": this.csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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

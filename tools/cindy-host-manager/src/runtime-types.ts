export type Engine = 'codex' | 'claude-code';
export interface RuntimeProxy { url: string; username?: string; password?: string }
/** Forced-egress network: a dedicated bridge whose only way out is its mihomo gateway. */
export interface RuntimeNetwork { id: string; subnet: string; proxy: RuntimeProxy; directDomains: string[] }
/** `network` is set when the instance uses a forced-egress network instead of proxy variables. */
export interface RuntimeInstance { id: string; engine: Engine; network?: RuntimeNetwork }
export interface AccountIdentity { displayName?: string; email?: string; loginMethod?: 'cindy' | 'chatgpt' | 'claude' | 'api-key'; plan?: string; organization?: string }
export interface RuntimeInspection {
  state: 'stopped' | 'running' | 'missing';
  authentication?: { cindy: 'stored' | 'missing' | 'unknown'; provider: 'authenticated' | 'missing' | 'unknown' };
  accounts?: { cindy: AccountIdentity | null; provider: AccountIdentity | null };
  checks?: unknown;
}
export interface LoginRequest { target: 'cindy' | 'provider'; method?: 'google' | 'email'; email?: string }
export interface ShareRequest { action: 'list' | 'link' | 'approve' | 'reject' | 'pause' | 'resume' | 'remove' | 'quota' | 'usage'; id?: string; code?: string }
export interface RuntimeLogin {
  input(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  cancel(): Promise<void>;
  onOutput(listener: (data: string) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}
/** Result of sending "hi" through the instance's native CLI. Text fields are sanitized, bounded projections. */
export interface ProviderTest { ok: boolean; reply?: string; error?: string; model?: string; timedOut?: boolean; durationMs: number; checkedAt: string }
export interface UsageWindow { kind: 'session' | 'week' | 'model' | 'other'; label?: string; usedPercent: number; resetsAt?: string; windowMinutes?: number }
/** Subscription plan and quota windows read by the instance's native CLI. */
export interface ProviderUsage {
  state: 'ready' | 'no-limits' | 'unavailable';
  plan?: string;
  windows: UsageWindow[];
  limitReached?: boolean;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  extraUsage?: { enabled: boolean; usedPercent?: number };
  error?: string;
  timedOut?: boolean;
  checkedAt: string;
}
export type ProbeKind = 'hello' | 'usage';
export interface ProxyTestResult { ip: string; country: string; region: string; city: string }
export type NetworkState = 'running' | 'stopped' | 'missing';
export interface DockerRuntime {
  testProxy(proxy: RuntimeProxy): Promise<ProxyTestResult>;
  /** First 172.30.N.0/24 not used by Docker or by the given subnets. */
  allocateSubnet(used: string[]): Promise<string>;
  /** Create or update the Docker network and its gateway; idempotent, recreates the gateway on config drift. */
  applyNetwork(network: RuntimeNetwork): Promise<void>;
  inspectNetwork(network: RuntimeNetwork): Promise<NetworkState>;
  /** Refuses while any other container is attached. */
  removeNetwork(network: RuntimeNetwork): Promise<void>;
  /** Exit IP seen by a disposable container on the network that sets no proxy variables. */
  testNetwork(network: RuntimeNetwork): Promise<ProxyTestResult>;
  create(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<void>;
  inspect(instance: RuntimeInstance): Promise<RuntimeInspection>;
  start(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<void>;
  stop(instance: RuntimeInstance): Promise<void>;
  check(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<RuntimeInspection>;
  /** Runs the native CLI inside the instance: a "hi" test, or a subscription/quota read. */
  probe(instance: RuntimeInstance, kind: ProbeKind, proxy?: RuntimeProxy | null): Promise<ProviderTest | ProviderUsage>;
  share(instance: RuntimeInstance, request: ShareRequest, proxy?: RuntimeProxy | null): Promise<unknown>;
  openLogin(instance: RuntimeInstance, request: LoginRequest, proxy?: RuntimeProxy | null): Promise<RuntimeLogin>;
}

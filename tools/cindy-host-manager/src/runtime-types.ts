export type Engine = 'codex' | 'claude-code';
export interface RuntimeInstance { id: string; engine: Engine }
export interface RuntimeProxy { url: string; username?: string; password?: string }
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
export interface ProxyTestResult { ip: string; country: string; region: string; city: string }
export interface DockerRuntime {
  testProxy(proxy: RuntimeProxy): Promise<ProxyTestResult>;
  create(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<void>;
  inspect(instance: RuntimeInstance): Promise<RuntimeInspection>;
  start(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<void>;
  stop(instance: RuntimeInstance): Promise<void>;
  check(instance: RuntimeInstance, proxy?: RuntimeProxy | null): Promise<RuntimeInspection>;
  share(instance: RuntimeInstance, request: ShareRequest, proxy?: RuntimeProxy | null): Promise<unknown>;
  openLogin(instance: RuntimeInstance, request: LoginRequest, proxy?: RuntimeProxy | null): Promise<RuntimeLogin>;
}

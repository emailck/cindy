import { HostCliError } from '../config';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAnthropicCompatProxy, createEnvOutboundProxyResolver, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import type { RemoteAgentHostDeps } from '@cindy/remote-agent-host';

/** Ask native Codex to resolve profiles/config layers; never log its response. */
export async function readNativeCodexConfig(binary: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // This probe reads configuration only; do not start background plugin installs.
    // The actual owner/guest engines keep their own native capability configuration.
    const child = spawn(binary, ['app-server', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false'], {
      env: process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
    });
    let input = ''; let settled = false; let answer: Record<string, unknown> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: Record<string, unknown>) => {
      if (settled) return; settled = true; answer = value; clearTimeout(timer);
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); }
      catch { child.kill(); }
      killTimer = setTimeout(() => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
        catch { /* The probe process group already exited. */ }
      }, 1000);
      killTimer.unref();
    };
    const timer = setTimeout(() => finish(), 15000);
    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('error', () => finish());
    child.on('close', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (answer) resolve(answer); else reject(new Error('Native Codex configuration is unavailable.'));
    });
    child.stdout.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 2 * 1024 * 1024) { finish(); return; }
      let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        try {
          const row = JSON.parse(line);
          if (row.id === 1) {
            if (row.error) { finish(); return; }
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'config/read', params: { includeLayers: false } }) + '\n');
          }
          if (row.id === 2) finish(row.result?.config);
        } catch { finish(); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cindy_host_share', version: '0.1.0' }, capabilities: { experimentalApi: true } } }) + '\n');
  });
}

/** Reuse Desktop's loopback proxy and maker-core guest isolation, not a new forwarding protocol. */
export async function createCodexShareBridge(binary: string, modelIds: ReadonlySet<string>, oauth = false) {
  const config = await readNativeCodexConfig(binary);
  const providers = config.model_providers as Record<string, Record<string, unknown>> | undefined;
  const provider = oauth ? { base_url: 'https://chatgpt.com/backend-api/codex', wire_api: 'responses' } as Record<string, unknown> : providers?.[String(config.model_provider ?? 'openai')];
  if (!provider || typeof provider.base_url !== 'string' || provider.wire_api !== 'responses') throw new HostCliError('SHARE_PROVIDER_UNSUPPORTED', 'Sharing currently requires a native Codex Responses API provider with a configured base_url.');
  const endpoint = new URL(provider.base_url);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Unsupported API endpoint.');
  const upstreamHeaders: Record<string, string> = {};
  const privateEnv = new Set<string>();
  const addHeader = (name: string, value: unknown) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid upstream headers');
    upstreamHeaders[name.toLowerCase()] = value;
  };
  for (const [name, value] of Object.entries((provider.http_headers ?? {}) as Record<string, unknown>)) addHeader(name, value);
  for (const [name, variable] of Object.entries((provider.env_http_headers ?? {}) as Record<string, unknown>)) {
    if (typeof variable !== 'string') throw new Error('Invalid credential environment');
    privateEnv.add(variable);
    if (process.env[variable]) addHeader(name, process.env[variable]);
  }
  const envKey = typeof provider.env_key === 'string' ? provider.env_key : null;
  if (envKey) privateEnv.add(envKey);
  for (const name of privateEnv) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ['HOME', 'CODEX_HOME', 'PATH', 'USERPROFILE', 'CINDY_GUEST_ROUTE_KEY'].includes(name)) throw new Error('Unsupported credential environment name');
  let key = envKey ? process.env[envKey] : undefined;
  if (!key && !oauth) {
    const nativeHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
    const auth = JSON.parse(await readFile(path.join(nativeHome, 'auth.json'), 'utf8'));
    key = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : undefined;
  }
  if (!key && !oauth) throw new Error('Native API credentials are unavailable for sharing.');
  const bindings = new Map<string, { token: string; proxy: ProxyHandle; current(): boolean }>();
  const bind: NonNullable<RemoteAgentHostDeps['bindGuestProviderRoute']> = async input => {
    if (input.kind !== 'codex') return null;
    const token = randomBytes(32).toString('hex');
    let released = false;
    const current = () => !released && input.isCurrent();
    const proxy = await createAnthropicCompatProxy({ upstream: null, transformRequest: [], routeOpaqueRequestBody: () => true, resolveOutboundProxy: createEnvOutboundProxyResolver(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      routingTransform: (body, ctx) => {
        const model = body && typeof body === 'object' ? (body as { model?: unknown }).model : undefined;
        if (!current() || ctx.method !== 'POST' || (oauth ? ctx.headers['x-cindy-share-route'] !== token || !ctx.headers.authorization?.startsWith('Bearer ') : ctx.headers.authorization !== `Bearer ${token}`) || !['/responses', '/responses/compact'].includes(ctx.url)
          || typeof model !== 'string' || !modelIds.has(model)) {
          return { localHandler: async ({ res }) => { res.writeHead(403); res.end('Request denied'); } };
        }
        return { upstreamOverride: endpoint.href, headerOverride: oauth ? {} : { authorization: `Bearer ${key}`, ...upstreamHeaders }, headerDelete: ['x-cindy-share-route'], dispatchGenerationValid: current };
      },
    });
    const entry = { token, proxy, current };
    bindings.set(input.hostSessionId, entry);
    return { routeToken: token, modelIds: [...modelIds], allowsModel: async model => current() && modelIds.has(model),
      release() { released = true; if (bindings.get(input.hostSessionId) === entry) bindings.delete(input.hostSessionId); void proxy.dispose(); } };
  };
  return {
    bind,
    spawnConfig(sessionId: string | undefined, storageOnly = false) {
      const entry = sessionId ? bindings.get(sessionId) : undefined;
      if ((!entry || !entry.current()) && !storageOnly) throw Object.assign(new Error('Guest route unavailable.'), { codexSpawnConfigFatal: true });
      // maker-core owns hosted MCP transport configuration. A synthetic stdio
      // entry here would merge with the requester's HTTP tunnel at thread/start.
      return { extraArgs: ['-c', 'model_provider="cindy_share"', '-c', ...Object.entries({ name: 'Shared API', base_url: storageOnly ? 'http://127.0.0.1:1' : entry!.proxy.url, wire_api: 'responses', ...(!oauth ? { env_key: 'CINDY_GUEST_ROUTE_KEY' } : {}), requires_openai_auth: oauth, ...(oauth ? { 'http_headers.x-cindy-share-route': storageOnly ? 'disabled-storage-only' : entry!.token } : {}), supports_websockets: false }).flatMap(([key, value]) => [`model_providers.cindy_share.${key}=${JSON.stringify(value)}`, '-c']).slice(0, -1)],
        extraEnv: { CINDY_GUEST_ROUTE_KEY: storageOnly ? 'disabled-storage-only' : entry!.token, OPENAI_API_KEY: '', CODEX_API_KEY: '', ...Object.fromEntries([...privateEnv].map(name => [name, ''])) } };
    },
    async dispose() { const all = [...bindings.values()]; bindings.clear(); await Promise.all(all.map(entry => entry.proxy.dispose())); },
  };
}

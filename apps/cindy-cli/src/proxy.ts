/**
 * Outbound proxy from the environment (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY), like curl.
 *
 * Node's built-in fetch and the `ws` library ignore these variables. On hosts where only the proxy
 * reaches the internet (WSL behind a Windows proxy, corporate Linux servers), login, REST and the
 * relay WebSocket would otherwise time out. Loopback and NO_PROXY targets stay direct. An explicitly
 * configured but unsupported proxy fails loudly instead of silently going direct.
 */
import type { Agent as HttpsAgent } from 'node:https';
import {
  createEnvOutboundProxyResolver, parseOutboundProxyUrl, Socks5HttpsAgent, TunnelingHttpsAgent,
} from '@cindy/anthropic-compat-proxy';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { CliError } from './profile';

const HTTP_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/** Proxy URL the relay WebSocket would use, or null for a direct connection. */
export function proxyForUrl(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return createEnvOutboundProxyResolver(env)(url.replace(/^ws(s?):/, 'http$1:'));
}

/** https.Agent tunnelling a wss:// connection through the configured proxy (HTTP CONNECT or SOCKS5). */
export function webSocketAgentFor(url: string, env: NodeJS.ProcessEnv = process.env): HttpsAgent | undefined {
  const raw = proxyForUrl(url, env);
  if (!raw) return undefined;
  const proxy = parseOutboundProxyUrl(raw);
  if (!proxy) throw new CliError('PROXY_UNSUPPORTED', 'error.proxyUnsupported');
  return proxy.kind === 'socks5' ? new Socks5HttpsAgent(proxy) : new TunnelingHttpsAgent(proxy);
}

/** Fails at startup for a proxy the client cannot use, rather than at the first reconnect. */
export function assertProxyConfig(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of [...HTTP_KEYS, 'ALL_PROXY', 'all_proxy']) {
    const value = env[key]?.trim();
    if (value && !parseOutboundProxyUrl(value)) throw new CliError('PROXY_UNSUPPORTED', 'error.proxyUnsupported');
  }
}

let processFetch: typeof globalThis.fetch | undefined;

function first(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) { const value = env[key]?.trim(); if (value) return value; }
  return undefined;
}

/**
 * fetch for login and REST. With an HTTP(S) proxy in the environment it goes through undici's
 * EnvHttpProxyAgent (honors NO_PROXY); otherwise the global fetch. SOCKS-only (ALL_PROXY) is not
 * supported for fetch and stays direct.
 */
export function networkFetch(env: NodeJS.ProcessEnv = process.env): typeof globalThis.fetch {
  if (!HTTP_KEYS.some(key => env[key]?.trim())) return globalThis.fetch;
  if (env === process.env && processFetch) return processFetch;
  // Explicit values: EnvHttpProxyAgent would otherwise read process.env on its own.
  const httpProxy = first(env, ['HTTP_PROXY', 'http_proxy']);
  const httpsProxy = first(env, ['HTTPS_PROXY', 'https_proxy']) ?? httpProxy;
  const noProxy = first(env, ['NO_PROXY', 'no_proxy']) ?? '';
  const dispatcher = new EnvHttpProxyAgent({ ...(httpProxy ? { httpProxy } : {}), ...(httpsProxy ? { httpsProxy } : {}), noProxy });
  const fetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof globalThis.fetch;
  if (env === process.env) processFetch = fetch;
  return fetch;
}

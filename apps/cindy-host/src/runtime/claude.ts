import { readClaudeQuota } from './claude-quota';
import { emptyQuota } from '../share-quota';
import { randomBytes } from 'node:crypto';
import type { RemoteAgentHostDeps } from '@cindy/remote-agent-host';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ClaudeCodeAgent, cleanProcessEnv, stripSensitiveAnthropicEnv, type AuthAdapter, type Logger, type ModelDescriptor } from '@cindy/maker-core';
import { BUNDLED_CATALOG, resolveClaudeSdkModelId, resolveModelMetadata, type CatalogModel, type Effort } from '@cindy/model-providers';

const run = promisify(execFile);
export interface ClaudeProviderSettings { binary: string; auth: 'native' | 'api-key' }

export function claudeProviderSettings(env: NodeJS.ProcessEnv = process.env): ClaudeProviderSettings {
  const binary = env.CINDY_HOST_CLAUDE_BINARY;
  if (!binary || !path.isAbsolute(binary)) throw new Error('Set CINDY_HOST_CLAUDE_BINARY to the absolute Claude executable path.');
  const auth = env.CINDY_HOST_CLAUDE_AUTH;
  if (auth !== 'native' && auth !== 'api-key') throw new Error('Set CINDY_HOST_CLAUDE_AUTH to native or api-key.');
  return { binary, auth };
}

/** Native auth stays in Claude's credential store; only its public status is read. */
export async function createClaudeProvider(dataDir: string, logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  // Injected env supplies provider settings only. Status and SDK share the ambient execution identity.
  const nativeExecutionEnv = cleanProcessEnv(process.env);
  env = {
    CINDY_HOST_CLAUDE_BINARY: env.CINDY_HOST_CLAUDE_BINARY,
    CINDY_HOST_CLAUDE_AUTH: env.CINDY_HOST_CLAUDE_AUTH,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
  };
  // The SDK merges process.env again; use the existing host boot scrub after capturing explicit API input.
  stripSensitiveAnthropicEnv();
  const settings = claudeProviderSettings(env);
  await access(settings.binary, constants.X_OK);
  const id = settings.auth === 'native' ? 'anthropic' : 'cli-anthropic-api';
  const auth: AuthAdapter = {
    async getState() {
      if (settings.auth === 'api-key') return { authenticated: !!env.ANTHROPIC_API_KEY, authSource: 'api-key' };
      try {
        const { stdout } = await run(settings.binary, ['auth', 'status', '--json'], {
          env: nativeExecutionEnv, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
        });
        const value = JSON.parse(stdout) as Record<string, unknown>;
        const authenticated = value.loggedIn === true && value.authMethod === 'claude.ai'
          && !value.apiKeySource && (!value.apiProvider || value.apiProvider === 'firstParty');
        return { authenticated, authSource: 'oauth' };
      } catch { return { authenticated: false, errorReason: 'native_cli_not_authenticated' }; }
    },
    async triggerLogin() { throw new Error('Authenticate using the native Claude CLI before starting serve.'); },
    async logout() { throw new Error('Manage Claude authentication using the native Claude CLI.'); },
    async getAuthEnv(): Promise<Record<string, string>> {
      return settings.auth === 'api-key' && env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {};
    },
  };
  if (!(await auth.getState()).authenticated) throw new Error('Claude authentication is unavailable. Run the native Claude login or provide ANTHROPIC_API_KEY for api-key mode.');
  const catalog = BUNDLED_CATALOG.providers.find(provider => provider.id === 'anthropic');
  if (!catalog) throw new Error('The bundled Claude catalog is unavailable.');
  const makeAgent = (availableModels: ModelDescriptor[] = []) => new ClaudeCodeAgent({
    auth, binaryPath: settings.binary, logger,
    runtimeConfig: { userDataPath: dataDir, ...(settings.auth === 'api-key' && env.ANTHROPIC_BASE_URL ? { endpoint: env.ANTHROPIC_BASE_URL } : {}) },
    capabilityAdditions: { availableModels },
  });
  let models: CatalogModel[] = [];
  if (settings.auth === 'native') {
    await makeAgent().refreshLocalModels({ onSupportedModels: raw => { models = mapClaudeModels(raw); } });
  } else {
    const base = new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Anthropic API base URL.');
    let after: string | undefined;
    const entries: unknown[] = [];
    do {
      const url = new URL(`${base.href.replace(/\/$/, '')}/v1/models`);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
      const response = await fetch(url, { headers: { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Anthropic model discovery failed. Check API credentials and endpoint.');
      const body = await response.json() as { data?: unknown[]; has_more?: boolean; last_id?: string };
      if (!Array.isArray(body.data)) throw new Error('Invalid Anthropic model discovery response.');
      entries.push(...body.data.map(value => {
        const entry = value as { id?: string; display_name?: string };
        return { value: entry.id, displayName: entry.display_name };
      }));
      const next = body.has_more ? body.last_id : undefined;
      if (next && (next === after || entries.length > 10_000)) throw new Error('Invalid Anthropic model discovery pagination.');
      after = next;
    } while (after);
    models = mapClaudeModels(entries);
  }
  if (!models.length) throw new Error('Claude returned no supported models. Check native CLI authentication and model discovery.');
  const agent = makeAgent(models.map(model => ({ id: model.id, displayName: model.name,
    contextWindow: model.contextWindow ?? 0, efforts: model.efforts, defaultEffort: model.defaultEffort,
    supportsFastMode: model.supportsFastMode,
  })));
  const modelIds = new Set(models.map(model => model.id));
  return {
    kind: 'claude-code' as const, id, agent, modelIds,
    sharing: settings.auth === 'native' ? createNativeClaudeSharing(id, modelIds, async () => (await auth.getState()).authenticated) : undefined,
    readQuota: async () => settings.auth === 'native' ? readClaudeQuota(settings.binary, dataDir) : emptyQuota('unsupported'),
    dispose: async () => {},
    async isAuthenticated() { return (await auth.getState()).authenticated; },
    view(enabled: boolean) {
      return { id, name: settings.auth === 'native' ? catalog.name : 'Anthropic API', source: catalog.source,
        agents: ['claude-code'], auth: { method: settings.auth === 'native' ? 'oauth' : 'api-key' },
        models: { 'claude-code': models }, connected: true, remoteInvocationEnabled: enabled,
        routing: {},
      };
    },
  };
}

/** SDK membership is authoritative; registry supplies metadata only, never extra members. */
export function mapClaudeModels(raw: unknown[]): CatalogModel[] {
  const result = new Map<string, CatalogModel>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.value !== 'string') continue;
    const id = resolveClaudeSdkModelId(entry.value, entry.description);
    if (!id) continue;
    if (result.has(id)) continue;
    const metadata = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, 'anthropic', id, undefined, undefined, 'claude-code');
    const allowedEfforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    const efforts: Effort[] = entry.supportsEffort === false ? [] : Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.filter((effort): effort is Effort => typeof effort === 'string' && allowedEfforts.has(effort))
      : metadata.efforts ?? [];
    result.set(id, { ...metadata, id, name: metadata.name ?? id, contextWindow: metadata.contextWindow ?? 0, efforts,
      defaultEffort: efforts.includes('high') ? 'high' : efforts.at(-1) ?? null,
      ...(typeof entry.supportsFastMode === 'boolean' ? { supportsFastMode: entry.supportsFastMode } : {}),
      status: 'active',
    });
  }
  return [...result.values()];
}

/** Runtime logs may contain user content and credentials: expose fixed lifecycle events only. */
export function quietRuntimeLogger(): Logger {
  const noop = () => undefined;
  const logger: Logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };
  return logger;
}

/** Native Claude owns credentials; this binding only carries member/model authority. */
export function createNativeClaudeSharing(id: string, modelIds: ReadonlySet<string>, authenticated: () => Promise<boolean>) {
  return {
    supported: true,
    async prepare() { if (!(await authenticated())) throw new Error('Native Claude login is unavailable.'); },
    bind: async (input: Parameters<NonNullable<RemoteAgentHostDeps['bindGuestProviderRoute']>>[0]) => {
      if (input.kind !== 'claude-code' || input.providerId !== id || !input.isCurrent()) return null;
      let released = false;
      return { routeToken: randomBytes(32).toString('hex'), modelIds: [...modelIds],
        allowsModel: async (model: string) => !released && input.isCurrent() && modelIds.has(model),
        release() { released = true; } };
    },
  };
}

import { codexQuota, emptyQuota } from '../share-quota';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createCodexShareBridge, readNativeCodexConfig } from './codex-share';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodexAgent, type AuthAdapter, type CodexModelListItem, type Logger } from '@cindy/maker-core';
import { BUNDLED_CATALOG, resolveModelMetadata, type CatalogModel, type Effort } from '@cindy/model-providers';

const run = promisify(execFile);

/** Native Codex owns credentials and account refresh; sharing reads access tokens in memory for ephemeral guest authentication. */
export async function createCodexProvider(dataDir: string, logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  const binary = env.CINDY_HOST_CODEX_BINARY;
  if (!binary || !path.isAbsolute(binary) || /\.(cmd|bat)$/i.test(binary)) throw new Error('Set CINDY_HOST_CODEX_BINARY to the absolute native Codex executable path.');
  await access(binary, constants.X_OK);
  const auth = createNativeCodexAuth(binary);
  const initialAuth = await auth.getState();
  if (!initialAuth.authenticated) throw new Error('Codex is not authenticated. Configure native Codex login or API credentials first.');
  const id = initialAuth.authSource === 'oauth' ? 'openai' : 'cli-codex';
  let models: CatalogModel[] = [];
  let sharing: Awaited<ReturnType<typeof createCodexShareBridge>> | undefined;
  const guestAgents = new Set<CodexAgent>();
  const credentialHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  let accountId: string | undefined;
  const readTokens = async () => {
    try {
      const value = JSON.parse(await readFile(path.join(credentialHome, 'auth.json'), 'utf8'));
      const tokens = value.tokens;
      if (typeof tokens?.access_token !== 'string' || !tokens.access_token || typeof tokens.account_id !== 'string' || !tokens.account_id) throw new Error();
      if (accountId && accountId !== tokens.account_id) throw new Error();
      accountId = tokens.account_id;
      return { accessToken: tokens.access_token as string, chatgptAccountId: accountId! };
    } catch { throw new Error('Native ChatGPT credentials are unavailable or the account changed.'); }
  };
  const makeAgent = () => new CodexAgent({ auth, binaryPath: binary, logger, runtimeConfig: { userDataPath: dataDir },
    prepareCodexExtraSpawnConfig: async (_providers, context) => context.deviceHostedGuestProviderId
      ? sharing!.spawnConfig(context.deviceHostedGuestSessionId, context.nativeStorageOnly) : { extraArgs: [], extraEnv: {} },
    createCodexAuthTokenReader: () => readTokens,
    onCodexLocalModelsListed: async entries => { models = mapCodexModels(entries); },
  });
  const agent = makeAgent();
  try {
    await agent.refreshLocalModels();
    if (!models.length) throw new Error('Codex returned no available models.');
  } catch (error) { await agent.dispose(); throw error; }
  const catalog = BUNDLED_CATALOG.providers.find(provider => provider.id === 'openai');
  return {
    kind: 'codex' as const, id, agent: nativeCodexAgent(agent, () => { const guest = makeAgent(); guestAgents.add(guest); return { guest, release: async () => { guestAgents.delete(guest); await guest.dispose(); } }; }), modelIds: new Set(models.map(model => model.id)),
    readQuota: async () => {
      if (initialAuth.authSource !== 'oauth') return emptyQuota('unsupported');
      await readTokens();
      const response = await agent.readAccountRateLimits();
      await readTokens();
      return codexQuota(response);
    },
    isAuthenticated: async () => (await auth.getState()).authenticated,
    sharing: {
      supported: true,
      async prepare() {
        if (initialAuth.authSource === 'oauth') await readTokens();
        sharing ??= await createCodexShareBridge(binary, new Set(models.map(model => model.id)), initialAuth.authSource === 'oauth');
      },
      bind: (input: Parameters<NonNullable<import('@cindy/remote-agent-host').RemoteAgentHostDeps['bindGuestProviderRoute']>>[0]) => sharing ? sharing.bind(input) : Promise.resolve(null),
    },
    dispose: async () => { await agent.dispose(); await Promise.all([...guestAgents].map(guest => guest.dispose())); guestAgents.clear(); await sharing?.dispose(); },
    view(enabled: boolean) {
      return { id, name: initialAuth.authSource === 'oauth' ? catalog?.name ?? 'OpenAI' : 'Codex API', source: catalog?.source ?? 'local',
        agents: ['codex'], auth: { method: initialAuth.authSource === 'oauth' ? 'oauth' : 'api-key' }, models: { codex: models },
        connected: true, remoteInvocationEnabled: enabled, routing: {},
      };
    },
  };
}

/** Native membership, effort levels and model slug are authoritative. */
export function mapCodexModels(entries: readonly CodexModelListItem[]): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const entry of entries) {
    if (entry.hidden || typeof entry.model !== 'string' || !entry.model.trim()) continue;
    const id = entry.model;
    const metadata = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, 'openai', id, undefined, undefined, 'codex');
    const allowed = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    const efforts = (entry.supportedReasoningEfforts ?? []).map(item => item.reasoningEffort)
      .filter((value): value is Effort => allowed.has(value));
    models.set(id, { ...metadata, id, name: entry.displayName || id, contextWindow: metadata.contextWindow ?? 0,
      efforts, defaultEffort: efforts.includes(entry.defaultReasoningEffort as Effort) ? entry.defaultReasoningEffort as Effort : null,
      status: 'active' });
  }
  return [...models.values()];
}

/** Status output can contain a masked key; only return a classification, never the text. */
export function createNativeCodexAuth(binary: string, status = async () =>
  run(binary, ['login', 'status'], { env: process.env, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }),
  configuredApi = async () => {
    const config = await readNativeCodexConfig(binary);
    const provider = (config.model_providers as Record<string, Record<string, unknown>> | undefined)?.[String(config.model_provider ?? '')];
    return !!provider && provider.wire_api === 'responses' && typeof provider.base_url === 'string'
      && typeof provider.env_key === 'string' && !!process.env[provider.env_key];
  },
): AuthAdapter {
  let nativeConfigAuth: Promise<boolean> | undefined;
  return {
    async getState() {
      try {
        const result = await status();
        const oauth = /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`);
        return { authenticated: true, authSource: oauth ? 'oauth' : 'api-key' };
      } catch {
        nativeConfigAuth ??= configuredApi().catch(() => false);
        return await nativeConfigAuth ? { authenticated: true, authSource: 'api-key' } : { authenticated: false };
      }
    },
    // Native Codex reads its own config/auth and inherited environment. Do not
    // replace CODEX_HOME, inject placeholder credentials, or force an OAuth route.
    async getAuthEnv() { return {}; },
    async triggerLogin() { throw new Error('Configure authentication using the native Codex CLI.'); },
    async logout() { throw new Error('Manage authentication using the native Codex CLI.'); },
  };
}

/** The remote provider ID is a UI/admission identity, not a Cindy credential route.
 * Native Codex owns the one configured route; keep start, fork and model changes
 * in that same credential family so multiple sessions can share its app-server.
 */
export function nativeCodexAgent(agent: Pick<CodexAgent, 'capabilities' | 'startSession' | 'forkSdkSession'>, createGuest?: () => { guest: CodexAgent; release(): Promise<void> }) {
  return {
    capabilities: agent.capabilities,
    async startSession(options: Parameters<CodexAgent['startSession']>[0]) {
      if (options.deviceHosted?.guest) {
        if (!createGuest) throw new Error('Isolated guest engine unavailable');
        const instance = createGuest();
        try {
          const handle = await instance.guest.startSession(options);
          let closed = false;
          return { ...handle, async close(...args: Parameters<typeof handle.close>) {
            if (closed) return; closed = true;
            try { await handle.close(...args); } finally { await instance.release(); }
          } };
        } catch (error) { await instance.release(); throw error; }
      }
      const handle = await agent.startSession({ ...options, providerId: undefined });
      const setModel = handle.setModel?.bind(handle);
      return { ...handle, ...(setModel ? {
        setModel: (model: string, options?: Parameters<NonNullable<typeof handle.setModel>>[1]) =>
          setModel(model, { ...options, providerId: undefined }),
      } : {}) };
    },
    async forkSdkSession(options: Parameters<CodexAgent['forkSdkSession']>[0]) {
      if (options.hostedGuestHome) {
        if (!createGuest) throw new Error('Isolated guest engine unavailable');
        const instance = createGuest();
        try { return await instance.guest.forkSdkSession(options); } finally { await instance.release(); }
      }
      return agent.forkSdkSession({ ...options, providerId: undefined });
    },
  };
}

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodexAgent, type AuthAdapter, type CodexModelListItem, type Logger } from '@cindy/maker-core';
import { BUNDLED_CATALOG, resolveModelMetadata, type CatalogModel, type Effort } from '@cindy/model-providers';

const run = promisify(execFile);

/** Native Codex owns credentials and account refresh; the host never reads auth.json. */
export async function createCodexProvider(dataDir: string, logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  const binary = env.CINDY_HOST_CODEX_BINARY;
  if (!binary || !path.isAbsolute(binary) || /\.(cmd|bat)$/i.test(binary)) throw new Error('Set CINDY_HOST_CODEX_BINARY to the absolute native Codex executable path.');
  await access(binary, constants.X_OK);
  const auth = createNativeCodexAuth(binary);
  const initialAuth = await auth.getState();
  if (!initialAuth.authenticated) throw new Error('Codex is not authenticated. Configure native Codex login or API credentials first.');
  const id = initialAuth.authSource === 'oauth' ? 'openai' : 'cli-codex';
  let models: CatalogModel[] = [];
  const agent = new CodexAgent({ auth, binaryPath: binary, logger, runtimeConfig: { userDataPath: dataDir },
    onCodexLocalModelsListed: async entries => { models = mapCodexModels(entries); },
  });
  try {
    await agent.refreshLocalModels();
    if (!models.length) throw new Error('Codex returned no available models.');
  } catch (error) { await agent.dispose(); throw error; }
  const catalog = BUNDLED_CATALOG.providers.find(provider => provider.id === 'openai');
  return {
    kind: 'codex' as const, id, agent: nativeCodexAgent(agent), modelIds: new Set(models.map(model => model.id)),
    isAuthenticated: async () => (await auth.getState()).authenticated,
    dispose: () => agent.dispose(),
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
): AuthAdapter {
  return {
    async getState() {
      try {
        const result = await status();
        const oauth = /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`);
        return { authenticated: true, authSource: oauth ? 'oauth' : 'api-key' };
      } catch { return { authenticated: false }; }
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
export function nativeCodexAgent(agent: Pick<CodexAgent, 'capabilities' | 'startSession' | 'forkSdkSession'>) {
  return {
    capabilities: agent.capabilities,
    async startSession(options: Parameters<CodexAgent['startSession']>[0]) {
      const handle = await agent.startSession({ ...options, providerId: undefined });
      const setModel = handle.setModel?.bind(handle);
      return { ...handle, ...(setModel ? {
        setModel: (model: string, options?: Parameters<NonNullable<typeof handle.setModel>>[1]) =>
          setModel(model, { ...options, providerId: undefined }),
      } : {}) };
    },
    forkSdkSession(options: Parameters<CodexAgent['forkSdkSession']>[0]) {
      return agent.forkSdkSession({ ...options, providerId: undefined });
    },
  };
}

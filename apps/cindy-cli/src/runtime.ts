/**
 * One signed-in terminal client: protected login, relay connection, shared providers,
 * remote task factory and local task records. Owned by a single process holding the
 * profile lock; close() drains credential rotation before the lock is released.
 */
import metadata from '../package.json';
import { createAuth, readSavedLogin, type CliAuth } from './auth';
import { catalogSources, readCatalog, type CatalogModel, type CatalogResult } from './catalog';
import type { CommandContext } from './cli';
import { createCliLink, type CliLink } from './link';
import { CLI_ENDPOINTS, CliError } from './profile';
import { createRemoteTaskFactory, prepareLocalTools, type RemoteTaskFactory } from './session';
import { createGuestShares, type GuestShares } from './shares';
import { createTaskStore, type TaskStore } from './store';

export interface AccountSummary { displayName?: string; email?: string }

export interface ClientRuntime {
  auth: CliAuth;
  link: CliLink;
  shares: GuestShares;
  tasks: TaskStore;
  factory: RemoteTaskFactory;
  account: AccountSummary | null;
  /** `rg` runnable from the Agent's Bash tool. */
  searchAvailable: boolean;
  /** Windows: Git Bash found (always true elsewhere). */
  shellAvailable: boolean;
  /** The ripgrep the Agent uses; `@` completion lists project files with it too. */
  rgPath: string;
  /** Same-account computers plus active shares; unreachable sources are reported, not hidden. */
  catalog(): Promise<CatalogResult>;
  /** Resolves when the account is lost (signed out elsewhere, device removed). */
  readonly accountLost: Promise<void>;
  close(): Promise<void>;
}

export async function startClientRuntime(context: CommandContext, signal: AbortSignal, options: { relay?: boolean } = {}): Promise<ClientRuntime> {
  const auth = await createAuth(context.dataDir, signal);
  let link: CliLink | undefined;
  try {
    if (!await auth.restore()) throw new CliError('AUTH_REQUIRED', 'error.authRequired');
    const scope = auth.storageScope();
    if (!scope) throw new CliError('AUTH_REQUIRED', 'error.authRequired');
    let notifyLost!: () => void;
    const accountLost = new Promise<void>(resolve => { notifyLost = resolve; });
    let shares!: GuestShares;
    link = createCliLink({
      auth, deviceName: context.config.deviceName, appVersion: metadata.version,
      deviceLinkApiBaseUrl: CLI_ENDPOINTS.deviceLinkApiBaseUrl, authApiBaseUrl: CLI_ENDPOINTS.authApiBaseUrl,
      resolveTarget: target => shares.resolveTarget(target),
      onAccountLost: () => notifyLost(),
    });
    const activeLink = link;
    shares = createGuestShares({
      request: (path, init) => activeLink.api(path, { method: init.method, ...(init.body === undefined ? {} : { body: init.body }) }),
      identityRequest: (path, body) => activeLink.api(path, { method: 'POST', body, service: 'auth' }),
      isCurrent: () => activeLink.isCurrent(),
      deviceLinkApiBaseUrl: CLI_ENDPOINTS.deviceLinkApiBaseUrl,
    });
    try { await link.start(signal, { relay: options.relay }); }
    catch { throw new CliError('RELAY_UNAVAILABLE', 'error.relayUnavailable'); }
    void shares.refresh().catch(() => undefined);
    const saved = await readSavedLogin(context.dataDir);
    const account = (saved.account && typeof saved.account === 'object' ? saved.account : null) as AccountSummary | null;
    const tools = prepareLocalTools();
    const factory = createRemoteTaskFactory(link.invoke, { rgPath: tools.rgPath });
    return {
      auth, link: activeLink, shares, factory, account, accountLost, searchAvailable: tools.ripgrep, shellAvailable: tools.gitBash, rgPath: tools.rgPath,
      tasks: createTaskStore(context.dataDir, scope),
      async catalog() {
        const [devices, received] = await Promise.all([
          activeLink.listDevices().catch(() => []),
          shares.refresh().catch(() => shares.received()),
        ]);
        return readCatalog(activeLink.invoke, catalogSources(devices, received, owner => context.t('catalog.sharedBy', { name: owner })));
      },
      async close() {
        activeLink.stop();
        factory.dispose();
        await auth.drain();
      },
    };
  } catch (error) {
    link?.stop();
    await auth.drain();
    throw error;
  }
}

/** Same provider and model on the same computer, if still offered. */
export function findModel(models: readonly CatalogModel[], wanted: { target?: string; providerId?: string; model: string }): CatalogModel | undefined {
  return models.find(entry => entry.model === wanted.model && (!wanted.target || entry.target === wanted.target) && (!wanted.providerId || entry.providerId === wanted.providerId))
    ?? models.find(entry => entry.model === wanted.model);
}

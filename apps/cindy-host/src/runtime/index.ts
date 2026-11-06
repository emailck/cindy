import { createShareQuota, SHARE_INSIGHTS_CHANNEL, emptyQuota } from '../share-quota';
import { createProviderShareUsageStore } from '@cindy/remote-agent-host/providerShareUsageStore';
import { createShareManager } from '../share-manager';
import { startShareControl } from '../share-control';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { wireAsyncInboundDispatch, DeviceLinkClient, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, REMOTE_AGENT_CHANNEL,
  PROTOCOL_VERSION, isScopedPeer, parseProviderSharePeer, PROVIDER_SHARE_RELAY_CAPABILITY, type Envelope, type InvokePayload, type InvokeResultPayload,
  type LinkOpenPayload, type DeviceLinkClientOptions } from '@cindy/device-link';
import { DEFAULT_REMOTE_AGENT_LIMITS } from '@cindy/remote-agent-host/limits';
import { createRemoteAgentHost, hostedStartOptions } from '@cindy/remote-agent-host';
import type { HostCommandContext } from '../cli';
import { readConfig } from '../config';
import type { HostLifecycle } from '../lifecycle';
import { quietRuntimeLogger } from './claude';
import { startupDiagnostics } from './startupDiagnostics';
import { createProvider } from './provider';
import metadata from '../../package.json';

export interface HostAuthPort {
  getToken(): Promise<string | null>;
  /** Account incarnation: stable across token refresh, changes on logout/login. */
  captureOwner(): string | null;
  storageScope(): string | null;
  refresh(): Promise<boolean>;
}
export interface CliHostOptions {
  auth: HostAuthPort;
  /** Provider settings/credential source only; HOME/PATH/native execution identity remain ambient. */
  env?: NodeJS.ProcessEnv;
  createProvider?: typeof createProvider;
  createWebSocket?: DeviceLinkClientOptions['createWebSocket'];
  loadConfig?: () => Promise<HostCommandContext['config']>;
}
const channels = [SHARE_INSIGHTS_CHANNEL, REMOTE_AGENT_CHANNEL, 'maker:provider:list', 'maker:list-available-agents', 'maker:get-capabilities', 'maker:agent:status'];
const allowlistHash = createHash('sha256').update([...channels].sort().join('\n')).digest('hex');

/** Relay-only same-account provider. All project tools run through the shared host's reverse tunnel. */
export async function createCliHost(context: HostCommandContext, options: CliHostOptions): Promise<HostLifecycle> {
  const logger = quietRuntimeLogger(startupDiagnostics(line => context.error(line), context.dataDir));
  if (!await options.auth.getToken()) throw new Error('Sign in to Cindy before starting serve.');
  const owner = options.auth.captureOwner();
  const storageScope = options.auth.storageScope();
  if (!owner || !storageScope) throw new Error('Cindy authentication owner is unavailable.');
  const provider = await (options.createProvider ?? createProvider)(context.dataDir, logger, options.env);
  let active = false;
  let enabled = context.config.remoteAccessEnabled;
  let authenticated = true;
  let accountReady = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let lastAuthProbe = 0;
  let publishedPresence: { remoteControlEnabled: boolean; busy: boolean } | undefined;
  let stopped: Promise<void> | undefined;
  let signal: AbortSignal | undefined;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>(resolve => { resolveStopped = resolve; });
  const ledger = createProviderShareUsageStore(path.join(context.dataDir, 'accounts', createHash('sha256').update(storageScope).digest('hex'), 'provider-share-usage.json'));
  const admitted = new Set<string>();
  const current = () => active && options.auth.captureOwner() === owner;
  let shareManager: ReturnType<typeof createShareManager> | undefined;
  let stopControl: (() => Promise<void>) | undefined;
  let shareTimer: ReturnType<typeof setInterval> | undefined;
  const authorized = (peer: string) => current() && enabled && authenticated && accountReady
    && (!isScopedPeer(peer) || shareManager?.access(peer)?.providerId === provider.id);
  const quota = await createShareQuota({ dataDir: context.dataDir, scope: storageScope, providerId: provider.id,
    usage: peer => shareManager?.usage(peer) ?? Promise.reject(new Error('Share usage unavailable')),
    read: () => provider.readQuota?.() ?? Promise.resolve(emptyQuota('unsupported')), current,
    access: peer => authorized(peer) ? shareManager?.quotaAccess(peer) ?? null : null }).catch(async () => {
      await provider.dispose(); throw new Error('Share quota preferences could not be loaded.');
    });
  const host = createRemoteAgentHost({
    incrementalStartupBatch: true,
    localGuestAllocation: true,
    log: { debug: (message, fields) => logger.debug(message, fields), info() {}, warn() {} },
    readLimits: () => ({ ...DEFAULT_REMOTE_AGENT_LIMITS, idleMinutes: context.config.idleMinutes ?? DEFAULT_REMOTE_AGENT_LIMITS.idleMinutes }),
    runsRoot: path.join(context.dataDir, 'accounts', createHash('sha256').update(storageScope).digest('hex'), 'remote-agent'),
    captureOwner: () => owner,
    isOwnerCurrent: candidate => candidate === owner && current(),
    isControllerAuthorized: authorized,
    controllerTrust: peer => isScopedPeer(peer) ? 'guest' : 'owner',
    reshare: { canUse: () => false, allows: () => false, async sync() { throw new Error('[REMOTE_AGENT_RESHARE_NOT_ALLOWED] CLI reshare consent is unavailable.'); } },
    isAgentAvailable: kind => kind === provider.kind && authenticated,
    startHosted: async input => {
      if (input.kind !== provider.kind || (input.guest && !provider.sharing?.supported)) throw new Error('[REMOTE_AGENT_UNSUPPORTED] Only same-account sessions for the selected harness are supported.');
      // Full access is the host default; an explicit desktop policy always wins.
      const startOptions = hostedStartOptions(input);
      return provider.agent.startSession({ ...startOptions,
        permissionMode: startOptions.permissionMode ?? (context.config.permissionMode === 'full-access' ? 'bypassPermissions' : 'ask'),
      });
    },
    forkHosted: (kind, input) => {
      if (kind !== provider.kind) throw new Error('[REMOTE_AGENT_UNSUPPORTED] Unsupported harness.');
      return provider.agent.forkSdkSession(input);
    },
    recordGuestUsage: (controller, usage) => {
      // A revoked run can still deliver its final usage; keep attribution to the
      // admitted peer in this account-scoped host, not the new access snapshot.
      const peer = parseProviderSharePeer(controller);
      if (peer?.role === 'guest' && usage.providerId === provider.id) ledger.record(peer.shareId, peer.memberId, usage);
    },
    bindGuestProviderRoute: provider.sharing?.supported ? input => provider.sharing!.bind({ ...input, isCurrent: () => input.isCurrent() && authorized(input.controller) }) : undefined,
    providerAccess: {
      resolve: async (kind, model, id, controller) => authorized(controller) && kind === provider.kind
        && (!id || id === provider.id) && provider.modelIds.has(model) ? provider.id : null,
      isAllowed: (id, controller, model) => authorized(controller) && id === provider.id && (!model || provider.modelIds.has(model)),
      models: async kind => kind === provider.kind ? [...provider.modelIds] : [],
    },
  });
  const client: DeviceLinkClient = new DeviceLinkClient({
    getWsUrl: () => context.endpoints.deviceLinkApiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/device-link/ws',
    getToken: async () => {
      try {
        // Issue notifications are deduplicated by kind. Retry refresh on later reconnects as well.
        if (client.getConnectionIssue()?.kind === 'auth-failed') await (authRecovery ?? options.auth.refresh());
        const token = await options.auth.getToken();
        accountReady = !!token && options.auth.captureOwner() === owner;
        if (options.auth.captureOwner() !== owner) { void stop(); return null; }
        return token;
      } catch (error) { accountReady = false; throw error; }
    },
    getHello: () => ({ deviceName: context.config.deviceName, platform: process.platform,
      appVersion: metadata.version, remoteControlEnabled: enabled && authenticated && accountReady, busy: host.turnRunningControllers().length > 0,
      capabilities: provider.sharing?.supported ? [PROVIDER_SHARE_RELAY_CAPABILITY] : [],
    }),
    createWebSocket: options.createWebSocket ?? ((url, headers) => new WebSocket(url, { headers })),
    // Transport diagnostics can include payload details; emit only our fixed lifecycle messages.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  let authRecovery: Promise<void> | undefined;
  const offIssue = client.onConnectionIssue(issue => {
    if (issue?.kind === 'device-removed') { accountReady = false; void stop(); return; }
    if (issue?.kind !== 'auth-failed') return;
    accountReady = false;
    if (authRecovery) return;
    authRecovery = options.auth.refresh().then(ok => {
      if (options.auth.captureOwner() !== owner) { void stop(); return; }
      if (ok && current()) client.connectNow('refreshed-after-auth-failure');
    }).catch(() => undefined).finally(() => { authRecovery = undefined; });
  });
  const replies = new Map<string, { peer: string; id: string; result: InvokeResultPayload; expires: number }>();
  const reply = (peer: string, id: string, result: InvokeResultPayload) => {
    if (!current()) return;
    try { client.sendInvokeResult(peer, id, result); replies.delete(`${peer}\0${id}`); }
    catch {
      // Shared host operations have their own idempotency keys. Keep bounded responses after socket backpressure.
      if (replies.size < 64) replies.set(`${peer}\0${id}`, { peer, id, result, expires: Date.now() + 120_000 });
    }
  };
  async function invoke(frame: Envelope): Promise<void> {
    if (!frame.id) return;
    const peer = frame.src!;
    if (!authorized(peer)) { reply(peer, frame.id, { ok: false, error: { code: 'ACCESS_REVOKED', message: 'Remote access is unavailable.' } }); return; }
    const payload = frame.payload as InvokePayload;
    if (!payload || !channels.includes(payload.channel) || (payload.args !== undefined && !Array.isArray(payload.args))) {
      reply(peer, frame.id, { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'This channel is unavailable on this host.' } }); return;
    }
    try {
      const args = payload.args ?? [];
      let value: unknown;
      switch (payload.channel) {
        case SHARE_INSIGHTS_CHANNEL: {
          if (args.length !== 1) throw new Error('Invalid quota request');
          const insight = await quota.insights(peer, args[0]);
          // Never put private insights in the generic retry/completion cache.
          if (authorized(peer) && insight.isCurrent()) {
            try { client.sendInvokeResult(peer, frame.id, { ok: true, result: insight.result }); } catch { /* Caller retries with fresh authorization. */ }
          }
          return;
        }
        case REMOTE_AGENT_CHANNEL:
          if (!admitted.has(peer)) {
            reply(peer, frame.id, { ok: false, error: { code: 'ACCESS_REVOKED', message: 'Open a control link before remote execution.' } });
            return;
          }
          value = await host.handle(peer, args[0]); break;
        case 'maker:provider:list': value = { providers: [provider.view(enabled)], modelVisibilityOverrides: {}, providerOrder: [provider.id] }; break;
        case 'maker:list-available-agents': value = [provider.kind]; break;
        case 'maker:get-capabilities': {
          // Desktop probes all harnesses together, including inactive ones. A null
          // response is a malformed catalog, not an unavailable engine.
          if (args[0] !== provider.kind) {
            value = { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] };
          } else {
            const models = Object.values(provider.view(enabled).models).flat();
            value = { ...provider.agent.capabilities, availableModels: models.map(model => ({
              id: model.id, displayName: model.name, contextWindow: model.contextWindow,
              efforts: model.efforts, defaultEffort: model.defaultEffort,
              ...(model.supportsFastMode !== undefined ? { supportsFastMode: model.supportsFastMode } : {}),
            })) };
          }
          break;
        }
        case 'maker:agent:status': value = { binaryReady: args[0] === provider.kind, binaryPath: null, authReady: args[0] === provider.kind && authenticated }; break;
      }
      if (authorized(peer)) reply(peer, frame.id, { ok: true, result: value });
    } catch (error) {
      // Only shared host's known protocol error marker may cross the boundary.
      const code = error instanceof Error ? /^\[(REMOTE_AGENT_[A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
      reply(peer, frame.id, { ok: false, error: { code: 'IPC_ERROR', message: code ? `[${code}] Remote Agent request failed.` : 'Remote Agent request failed.' } });
    }
  }
  const off = wireAsyncInboundDispatch(client, async frame => {
    if (!frame.src || !frame.id || !current()) return;
    if (isScopedPeer(frame.src)) {
      if (parseProviderSharePeer(frame.src)?.role !== 'guest' || !shareManager) return;
      if (!shareManager.access(frame.src)) await shareManager.refresh();
    }
    if (frame.kind === 'link-open') {
      if (!authorized(frame.src) || (frame.payload as LinkOpenPayload)?.protocolVersion !== PROTOCOL_VERSION) return;
      try {
        // DeviceLinkClient adds only negotiated reliable transport capabilities and stream ids.
        client.sendLinkAccept(frame.src, frame.id, { appVersion: metadata.version, allowlistHash,
          capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] });
        admitted.add(frame.src);
      } catch { /* Controller can reopen using the shared transport recovery. */ }
    } else if (frame.kind === 'link-close') admitted.delete(frame.src);
    else if (frame.kind === 'invoke') return invoke(frame);
  }, () => context.error('Remote request dispatch failed.'));
  const abort = () => { void stop(); };
  function stop(): Promise<void> {
    if (stopped) return stopped;
    active = false;
    if (timer) clearInterval(timer);
    if (shareTimer) clearInterval(shareTimer);
    signal?.removeEventListener('abort', abort);
    off(); offIssue(); admitted.clear(); replies.clear(); client.stop();
    const disposal = Promise.resolve(stopControl?.()).finally(() => host.dispose()).finally(() => provider.dispose()).finally(() => ledger.flush()).finally(resolveStopped);
    stopped = disposal;
    return disposal;
  }
  return {
    async start(startSignal) {
      if (stopped) throw new Error('Host already stopped.');
      if (active) return;
      signal = startSignal;
      if (signal.aborted) { await stop(); return; }
      active = true;
      signal.addEventListener('abort', abort, { once: true });
      timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => {
          const config = options.loadConfig ? await options.loadConfig() : (await readConfig(context.dataDir)).effective;
          enabled = config.remoteAccessEnabled;
          if (!current()) { await stop(); return; }
          if (Date.now() - lastAuthProbe > 30_000) {
            lastAuthProbe = Date.now(); authenticated = await provider.isAuthenticated();
          }
          if (!enabled || !authenticated || !accountReady) { admitted.clear(); await host.abortControllers(() => true); }
          else await host.abortControllers(peer => isScopedPeer(peer) && !authorized(peer));
          if (client.getStatus() === 'online') {
            const presence = { remoteControlEnabled: enabled && authenticated && accountReady, busy: host.turnRunningControllers().length > 0 };
            if (!publishedPresence || publishedPresence.remoteControlEnabled !== presence.remoteControlEnabled || publishedPresence.busy !== presence.busy) {
              client.sendPresence(presence); publishedPresence = presence;
            }
          }
          for (const [key, pending] of replies) {
            if (pending.expires < Date.now() || !authorized(pending.peer)) replies.delete(key);
            else reply(pending.peer, pending.id, pending.result);
          }
        })().catch(() => {
          enabled = false; admitted.clear(); void host.abortControllers(() => true);
          if (client.getStatus() === 'online') {
            try { client.sendPresence({ remoteControlEnabled: false }); publishedPresence = undefined; } catch { /* Reconnect hello carries the disabled state. */ }
          }
        })
          .finally(() => { checking = false; });
      }, 1_000);
      client.start();
      try { await client.waitUntilOnline(30_000); }
      catch { await stop(); throw new Error('Cindy relay handshake did not complete. Check authentication and network, then restart serve.'); }
      if (current() && provider.sharing && process.platform !== 'win32') {
        shareManager = createShareManager({ ledger, ownerScope: storageScope, providerId: provider.id, providerName: provider.view(true).name,
          deviceId: () => client.getSelfDeviceId(), current, enabled: () => enabled && authenticated && accountReady,
          server: context.endpoints.deviceLinkApiBaseUrl, notify: context.output,
          revoke: (match, purge) => purge ? host.purgeControllers(match) : host.abortControllers(match),
          async request(path, body, identity) {
            for (let attempt = 0; attempt < 2; attempt++) {
              if (!current()) throw new Error('Account changed');
              const token = await options.auth.getToken();
              if (!token || !current()) throw new Error('Authentication unavailable');
              const response = await fetch((identity ? context.endpoints.authApiBaseUrl : context.endpoints.deviceLinkApiBaseUrl) + path, {
                method: body === undefined ? 'GET' : 'POST', redirect: 'error',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.any([signal!, AbortSignal.timeout(15000)]),
              });
              if (response.status === 401 && attempt === 0 && current()) {
                await response.body?.cancel();
                if (await options.auth.refresh()) continue;
              }
              if (!response.ok || !current()) throw new Error('Share service request failed');
              return response.json();
            }
            throw new Error('Share authentication unavailable');
          },
        });
        stopControl = await startShareControl(context.dataDir, async command => {
          if (command.action === 'quota' || command.action === 'usage') return quota.manage(command.id, command.action);
          if (['link', 'approve', 'resume'].includes(command.action)) await provider.sharing!.prepare();
          return shareManager!.execute(command);
        });
        const refreshShares = async () => {
          if (!provider.sharing!.supported) return;
          try { await provider.sharing!.prepare(); await shareManager!.refresh(); }
          catch { /* Unavailable adapters/service never authorize a guest. */ }
        };
        await refreshShares();
        shareTimer = setInterval(() => { void refreshShares(); }, 5000);
      }
      if (current()) context.output(`Cindy provider online (same-account ${provider.kind}, relay transport).`);
    },
    stop,
    waitUntilStopped: () => stoppedPromise,
  };
}

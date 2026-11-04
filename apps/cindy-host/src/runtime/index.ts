import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { DeviceLinkClient, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, REMOTE_AGENT_CHANNEL,
  PROTOCOL_VERSION, isScopedPeer, type Envelope, type InvokePayload, type InvokeResultPayload,
  type LinkOpenPayload, type DeviceLinkClientOptions } from '@cindy/device-link';
import { createRemoteAgentHost, hostedStartOptions } from '@cindy/remote-agent-host';
import type { HostCommandContext } from '../cli';
import { readConfig } from '../config';
import type { HostLifecycle } from '../lifecycle';
import { createClaudeProvider, quietRuntimeLogger } from './claude';
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
  createProvider?: typeof createClaudeProvider;
  createWebSocket?: DeviceLinkClientOptions['createWebSocket'];
  loadConfig?: () => Promise<HostCommandContext['config']>;
}
const channels = [REMOTE_AGENT_CHANNEL, 'maker:provider:list', 'maker:list-available-agents', 'maker:get-capabilities', 'maker:agent:status'];
const allowlistHash = createHash('sha256').update([...channels].sort().join('\n')).digest('hex');

/** Relay-only same-account provider. All project tools run through the shared host's reverse tunnel. */
export async function createCliHost(context: HostCommandContext, options: CliHostOptions): Promise<HostLifecycle> {
  const logger = quietRuntimeLogger();
  if (!await options.auth.getToken()) throw new Error('Sign in to Cindy before starting serve.');
  const owner = options.auth.captureOwner();
  const storageScope = options.auth.storageScope();
  if (!owner || !storageScope) throw new Error('Cindy authentication owner is unavailable.');
  const provider = await (options.createProvider ?? createClaudeProvider)(context.dataDir, logger, options.env);
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
  const admitted = new Set<string>();
  const current = () => active && options.auth.captureOwner() === owner;
  const authorized = (peer: string) => current() && enabled && authenticated && accountReady && !isScopedPeer(peer);
  const host = createRemoteAgentHost({
    runsRoot: path.join(context.dataDir, 'accounts', createHash('sha256').update(storageScope).digest('hex'), 'remote-agent'),
    captureOwner: () => owner,
    isOwnerCurrent: candidate => candidate === owner && current(),
    isControllerAuthorized: authorized,
    controllerTrust: () => 'owner',
    isAgentAvailable: kind => kind === 'claude-code' && authenticated,
    startHosted: input => {
      if (input.kind !== 'claude-code' || input.guest) throw new Error('[REMOTE_AGENT_UNSUPPORTED] Only same-account Claude sessions are supported.');
      // Full access is the host default; an explicit desktop policy always wins.
      const startOptions = hostedStartOptions(input);
      return provider.agent.startSession({ ...startOptions,
        permissionMode: startOptions.permissionMode ?? (context.config.permissionMode === 'full-access' ? 'bypassPermissions' : 'ask'),
      });
    },
    forkHosted: (kind, input) => {
      if (kind !== 'claude-code') throw new Error('[REMOTE_AGENT_UNSUPPORTED] Unsupported harness.');
      return provider.agent.forkSdkSession(input);
    },
    providerAccess: {
      resolve: async (kind, model, id, controller) => authorized(controller) && kind === 'claude-code'
        && (!id || id === provider.id) && provider.modelIds.has(model) ? provider.id : null,
      isAllowed: (id, controller, model) => authorized(controller) && id === provider.id && (!model || provider.modelIds.has(model)),
      models: async kind => kind === 'claude-code' ? [...provider.modelIds] : [],
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
      capabilities: [],
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
    if (!authorized(peer) || !admitted.has(peer)) { reply(peer, frame.id, { ok: false, error: { code: 'ACCESS_REVOKED', message: 'Remote access is unavailable.' } }); return; }
    const payload = frame.payload as InvokePayload;
    if (!payload || !channels.includes(payload.channel) || (payload.args !== undefined && !Array.isArray(payload.args))) {
      reply(peer, frame.id, { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'This channel is unavailable on this host.' } }); return;
    }
    try {
      const args = payload.args ?? [];
      let value: unknown;
      switch (payload.channel) {
        case REMOTE_AGENT_CHANNEL:
          if (!admitted.has(peer)) throw new Error('Link is not open.');
          value = await host.handle(peer, args[0]); break;
        case 'maker:provider:list': value = { providers: [provider.view(enabled)], modelVisibilityOverrides: {}, providerOrder: [provider.id] }; break;
        case 'maker:list-available-agents': value = ['claude-code']; break;
        case 'maker:get-capabilities': value = args[0] === 'claude-code' ? provider.agent.capabilities : null; break;
        case 'maker:agent:status': value = { binaryReady: args[0] === 'claude-code', binaryPath: null, authReady: args[0] === 'claude-code' && authenticated }; break;
      }
      if (authorized(peer)) reply(peer, frame.id, { ok: true, result: value });
    } catch (error) {
      // Only shared host's known protocol error marker may cross the boundary.
      const code = error instanceof Error ? /^\[(REMOTE_AGENT_[A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
      reply(peer, frame.id, { ok: false, error: { code: 'IPC_ERROR', message: code ? `[${code}] Remote Agent request failed.` : 'Remote Agent request failed.' } });
    }
  }
  const off = client.onFrame(frame => {
    if (!frame.src || !frame.id || isScopedPeer(frame.src) || !current()) return;
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
  });
  const abort = () => { void stop(); };
  function stop(): Promise<void> {
    if (stopped) return stopped;
    active = false;
    if (timer) clearInterval(timer);
    signal?.removeEventListener('abort', abort);
    off(); offIssue(); admitted.clear(); replies.clear(); client.stop();
    const disposal = host.dispose().finally(resolveStopped);
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
      if (current()) context.output('Cindy provider online (same-account Claude, relay transport).');
    },
    stop,
    waitUntilStopped: () => stoppedPromise,
  };
}

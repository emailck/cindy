/**
 * Outbound Device Link for the terminal client (controller role only).
 *
 * Mirrors Desktop `device-link/index.ts` remoteInvoke/openRemoteLink, which are Electron-bound and
 * therefore re-implemented here (manual sync point, see docs/cindy-cli-client-plan.md):
 *  - wait for the relay before sending; recover a closed link before admitting a new request;
 *  - retry once only for LINK_NOT_OPEN raised before sending (never replay a sent write);
 *  - an explicit close bumps a per-device epoch so in-flight waits cannot reopen it.
 * Fault radius: every recovery acts on one peer's link only; the shared relay connection is
 * never restarted from here (remote-and-mobile-adaptation.md, fault-radius questions).
 */
import WebSocket from 'ws';
import {
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, DeviceLinkClient, DeviceLinkError, PROVIDER_SHARE_RELAY_CAPABILITY,
  resolveRemoteInvokeTimeoutMs, type DeviceLinkClientOptions, type DeviceView, type InvokeResultPayload,
} from '@cindy/device-link';
import { ensureInvokeLinkReady, invokeWithClosedLinkRecovery } from '../../desktop/src/main/device-link/linkRecovery';
import { networkFetch, webSocketAgentFor } from './proxy';

export interface LinkAuthPort {
  getToken(): Promise<string | null>;
  captureOwner(): string | null;
  refresh(): Promise<boolean>;
}

export interface CliLinkOptions {
  auth: LinkAuthPort;
  deviceName: string;
  appVersion: string;
  deviceLinkApiBaseUrl: string;
  /** Account service (identity cards for share requests). */
  authApiBaseUrl?: string;
  /** Maps a task's Agent device id (e.g. `share:<id>`) to the peer that receives frames. */
  resolveTarget?(agentDeviceId: string): Promise<string>;
  createWebSocket?: DeviceLinkClientOptions['createWebSocket'];
  fetch?: typeof globalThis.fetch;
  /** Called once when the account changes or the device is removed; the session must end. */
  onAccountLost?(): void;
}

export type RemoteInvoke = (deviceId: string, channel: string, args: unknown[]) => Promise<InvokeResultPayload>;

/** Controller capabilities (append-only, same names as Desktop CONTROLLER_CAPABILITIES where implemented). */
export const CLI_LINK_CAPABILITIES = [PROVIDER_SHARE_RELAY_CAPABILITY, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] as const;
const CONNECT_READY_TIMEOUT_MS = 15_000;

export interface CliLink {
  readonly client: DeviceLinkClient;
  /** `relay: false` enables only the authenticated REST API (share management). */
  start(signal: AbortSignal, options?: { relay?: boolean }): Promise<void>;
  stop(): void;
  /** Same-account devices (REST directory). */
  listDevices(signal?: AbortSignal): Promise<DeviceView[]>;
  /** Invoke on a task's Agent device id (share targets resolved first). */
  invoke: RemoteInvoke;
  /** Explicit close: later in-flight retries must not reopen this peer. */
  close(agentDeviceId: string): Promise<void>;
  /** Authenticated JSON request to the official device-link REST API. */
  api<T>(pathname: string, init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal; service?: 'device-link' | 'auth' }): Promise<T>;
  isCurrent(): boolean;
}

export function createCliLink(options: CliLinkOptions): CliLink {
  const owner = options.auth.captureOwner();
  if (!owner) throw new Error('Cindy authentication owner is unavailable.');
  const fetchImpl = options.fetch ?? networkFetch();
  let active = false;
  let lost = false;
  const current = () => active && !lost && options.auth.captureOwner() === owner;
  const loseAccount = () => {
    if (lost) return;
    lost = true;
    options.onAccountLost?.();
  };
  let authRecovery: Promise<void> | undefined;
  const client: DeviceLinkClient = new DeviceLinkClient({
    getWsUrl: () => options.deviceLinkApiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/device-link/ws',
    getToken: async () => {
      if (client.getConnectionIssue()?.kind === 'auth-failed') await (authRecovery ?? options.auth.refresh().catch(() => false));
      const token = await options.auth.getToken();
      if (options.auth.captureOwner() !== owner) { loseAccount(); return null; }
      return token;
    },
    // A terminal client never accepts control: other devices must not list it as controllable.
    getHello: () => ({ deviceName: options.deviceName, platform: process.platform, appVersion: options.appVersion,
      remoteControlEnabled: false, busy: false, capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] }),
    // Through HTTPS_PROXY / ALL_PROXY when set (WSL, proxy-only servers); direct otherwise.
    createWebSocket: options.createWebSocket ?? ((url, headers) => {
      const agent = webSocketAgentFor(url);
      return new WebSocket(url, agent ? { headers, agent } : { headers });
    }),
    // Transport diagnostics can include payload details; keep the terminal quiet.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const offIssue = client.onConnectionIssue(issue => {
    if (issue?.kind === 'device-removed') { loseAccount(); return; }
    if (issue?.kind !== 'auth-failed' || authRecovery) return;
    authRecovery = options.auth.refresh().then(ok => {
      if (options.auth.captureOwner() !== owner) { loseAccount(); return; }
      if (ok && current()) client.connectNow('refreshed-after-auth-failure');
    }).catch(() => undefined).finally(() => { authRecovery = undefined; });
  });

  const closeEpochs = new Map<string, number>();
  const openInFlight = new Map<string, Promise<unknown>>();
  const assertCurrent = () => {
    if (!current()) throw new DeviceLinkError('NOT_CONNECTED', 'terminal client is not connected for this account');
  };

  function openLink(peer: string): Promise<unknown> {
    const existing = openInFlight.get(peer);
    if (existing) return existing;
    const epoch = closeEpochs.get(peer) ?? 0;
    const request = (async () => {
      assertCurrent();
      if (client.getStatus() !== 'online') await client.waitUntilOnline(CONNECT_READY_TIMEOUT_MS);
      if ((closeEpochs.get(peer) ?? 0) !== epoch) throw new DeviceLinkError('LINK_NOT_OPEN', 'link closed while waiting to reconnect');
      return client.openLink(peer, { controllerName: options.deviceName, protocolVersion: 1, appVersion: options.appVersion, capabilities: [...CLI_LINK_CAPABILITIES] });
    })().finally(() => { if (openInFlight.get(peer) === request) openInFlight.delete(peer); });
    openInFlight.set(peer, request);
    return request;
  }

  async function invoke(agentDeviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload> {
    assertCurrent();
    const peer = options.resolveTarget ? await options.resolveTarget(agentDeviceId) : agentDeviceId;
    const epoch = closeEpochs.get(peer) ?? 0;
    const assertOpenable = () => {
      assertCurrent();
      if ((closeEpochs.get(peer) ?? 0) !== epoch) throw new DeviceLinkError('LINK_NOT_OPEN', 'link closed while waiting to reconnect');
    };
    const once = async (): Promise<InvokeResultPayload> => {
      if (client.getStatus() !== 'online') await client.waitUntilOnline(CONNECT_READY_TIMEOUT_MS);
      await ensureInvokeLinkReady(() => !client.isLinkReady(peer) || client.needsLinkRecovery(peer), () => openLink(peer), assertOpenable);
      return client.invoke(peer, { channel, args }, resolveRemoteInvokeTimeoutMs(channel, args, 'desktop'), { preSend: assertOpenable });
    };
    return invokeWithClosedLinkRecovery(once, () => { assertOpenable(); return openLink(peer); }, assertOpenable);
  }

  async function api<T>(pathname: string, init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal; service?: 'device-link' | 'auth' } = {}): Promise<T> {
    const base = init.service === 'auth' ? options.authApiBaseUrl : options.deviceLinkApiBaseUrl;
    if (!base) throw new DeviceLinkError('NOT_CONNECTED', 'service endpoint unavailable');
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = await options.auth.getToken();
      if (!token || !current()) throw new DeviceLinkError('NOT_CONNECTED', 'authentication unavailable');
      const response = await fetchImpl(base.replace(/\/$/, '') + pathname, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), redirect: 'error',
        headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        if (await options.auth.refresh()) continue;
      }
      if (!current()) throw new DeviceLinkError('NOT_CONNECTED', 'account changed');
      if (!response.ok) throw Object.assign(new Error(`device-link request failed (${response.status})`), { status: response.status });
      return await response.json() as T;
    }
    throw new DeviceLinkError('NOT_CONNECTED', 'authentication unavailable');
  }

  return {
    client,
    async start(signal, startOptions = {}) {
      if (active) return;
      active = true;
      if (startOptions.relay === false) return;
      client.start();
      const abort = () => client.stop();
      signal.addEventListener('abort', abort, { once: true });
      try { await client.waitUntilOnline(30_000); }
      finally { signal.removeEventListener('abort', abort); }
    },
    stop() {
      active = false;
      offIssue();
      client.stop();
    },
    async listDevices(signal) {
      const result = await api<{ devices?: DeviceView[] }>('/api/device-link/devices', { signal });
      return Array.isArray(result.devices) ? result.devices : [];
    },
    invoke,
    async close(agentDeviceId) {
      const peer = options.resolveTarget ? await options.resolveTarget(agentDeviceId).catch(() => agentDeviceId) : agentDeviceId;
      closeEpochs.set(peer, (closeEpochs.get(peer) ?? 0) + 1);
      openInFlight.delete(peer);
      client.closeLink(peer, 'user');
    },
    api,
    isCurrent: current,
  };
}

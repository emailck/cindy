/**
 * Remote model catalog for /model. Same projection as Desktop controller/deviceCatalog.ts
 * readDeviceProviderViews (not importable: it lazily loads the Electron device-link module).
 * Manual sync point: re-check after merging upstream.
 */
import { CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2, scrubSharedProvider, type DeviceView, type ProviderShareReceived } from '@cindy/device-link';
import { isModelSelectableForNewRoute, isModelVisible, remoteInvocationModels, type AgentKind, type ProviderView } from '@cindy/model-providers';
import type { RemoteInvoke } from './link';

/** Remote Agent kinds this terminal client can drive (Codex needs a local exec-server; not in v1). */
export const SUPPORTED_AGENTS: readonly AgentKind[] = ['claude-code'];

export const SHARE_AGENT_PREFIX = 'share:';
const SHARE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/;
export function shareAgentDeviceId(shareId: string): string {
  if (!SHARE_ID.test(shareId)) throw new Error('Invalid provider share id');
  return `${SHARE_AGENT_PREFIX}${shareId}`;
}
export function parseShareAgentDeviceId(value: string): string | null {
  if (!value.startsWith(SHARE_AGENT_PREFIX)) return null;
  const id = value.slice(SHARE_AGENT_PREFIX.length);
  return SHARE_ID.test(id) ? id : null;
}

export interface CatalogModel {
  /** Agent device id the task runs on: same-account device id or `share:<id>`. */
  target: string;
  /** Group label: device name, or the sharer for a shared provider. */
  targetLabel: string;
  shared: boolean;
  providerId: string;
  providerName: string;
  agent: AgentKind;
  model: string;
  modelName: string;
  efforts: string[];
  defaultEffort: string | null;
}

export interface CatalogSource { target: string; label: string; shared: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Minimal validation of the remote provider list; malformed entries are skipped. */
export function parseProviderViews(value: unknown): ProviderView[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) throw new Error('Invalid provider list response');
  return value.providers.flatMap((item): ProviderView[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') return [];
    if (!Array.isArray(item.agents) || !item.agents.every(agent => typeof agent === 'string')) return [];
    if (typeof item.connected !== 'boolean' || !isRecord(item.models)) return [];
    const models: Record<string, unknown[]> = {};
    for (const [agent, entries] of Object.entries(item.models)) {
      if (!Array.isArray(entries)) return [];
      models[agent] = entries.filter(entry => isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0)
        .map(entry => ({ efforts: [], defaultEffort: null, ...(entry as Record<string, unknown>) }));
    }
    return [{ ...item, models } as unknown as ProviderView];
  });
}

/** Providers the device allows to be invoked remotely, filtered to visible, selectable models. */
export async function readSourceModels(invoke: RemoteInvoke, source: CatalogSource): Promise<CatalogModel[]> {
  const result = await invoke(source.target, 'maker:provider:list', [{ capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] }]);
  if (!result.ok) throw Object.assign(new Error(result.error?.message ?? 'provider list unavailable'), { code: result.error?.code });
  const visibility = isRecord(result.result) && isRecord(result.result.modelVisibilityOverrides) ? result.result.modelVisibilityOverrides : {};
  const offered = parseProviderViews(result.result).filter(view => view.remoteInvocationEnabled === true && view.connected && !view.suspended)
    .map(remoteInvocationModels).map(view => (source.shared ? scrubSharedProvider(view) : view));
  return offered.flatMap(provider => SUPPORTED_AGENTS.filter(agent => provider.agents.includes(agent)).flatMap(agent =>
    (provider.models[agent] ?? []).filter(model => {
      const override = visibility[`${agent}:${provider.id}:${model.id}`];
      return isModelVisible(typeof override === 'boolean' ? override : undefined, model.defaultEnabled)
        && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' });
    }).map((model): CatalogModel => ({
      target: source.target, targetLabel: source.label, shared: source.shared,
      providerId: provider.id, providerName: provider.name, agent, model: model.id,
      modelName: typeof model.name === 'string' && model.name ? model.name : model.id,
      efforts: Array.isArray(model.efforts) ? model.efforts.map(String) : [],
      defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : null,
    }))));
}

/** Same-account computers that accept remote control, plus active shares from other accounts. */
export function catalogSources(devices: readonly DeviceView[], shares: readonly ProviderShareReceived[], shareLabel: (owner: string) => string): CatalogSource[] {
  const own = devices.filter(device => !device.isSelf && device.online && device.remoteControlEnabled)
    .map(device => ({ target: device.deviceId, label: device.name || device.deviceId.slice(0, 8), shared: false }));
  const shared = shares.filter(share => share.status === 'active')
    .map(share => ({ target: shareAgentDeviceId(share.shareId), label: shareLabel(share.owner.displayName), shared: true }));
  return [...own, ...shared];
}

export interface CatalogResult { models: CatalogModel[]; unavailable: CatalogSource[] }

/** Reads every source concurrently; one unreachable computer does not hide the others. */
export async function readCatalog(invoke: RemoteInvoke, sources: readonly CatalogSource[]): Promise<CatalogResult> {
  const results = await Promise.allSettled(sources.map(source => readSourceModels(invoke, source)));
  const models: CatalogModel[] = [];
  const unavailable: CatalogSource[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') models.push(...result.value);
    else unavailable.push(sources[index]!);
  });
  return { models, unavailable };
}

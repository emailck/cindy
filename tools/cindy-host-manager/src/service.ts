import { randomUUID } from 'node:crypto';
import { Store, type InstanceRecord } from './store.js';
import { DEFAULT_DIRECT_DOMAINS, gatewayAddress, normalizeDirectDomains } from './egress-gateway.js';
import type { DockerRuntime, LoginRequest, NetworkState, RuntimeInspection, RuntimeInstance, RuntimeLogin, RuntimeNetwork, RuntimeProxy, ShareRequest } from './runtime-types.js';
export class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function object(body: unknown, keys: string[]): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)))
        throw new ApiError(400, 'INVALID_BODY', 'Invalid request body.');
    return body as Record<string, unknown>;
}
export function text(value: unknown, max = 200): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new ApiError(400, 'INVALID_BODY', 'Invalid text value.'); return value; }
function proxyMode(value: unknown): InstanceRecord['proxyMode'] { if (value !== 'none' && value !== 'default' && value !== 'custom' && value !== 'network')
    throw new ApiError(400, 'INVALID_BODY', 'Invalid proxy mode.'); return value; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Encrypted record under `network:<id>`; the upstream proxy credentials never leave the manager API. */
export interface NetworkRecord { id: string; name: string; subnet: string; proxy: RuntimeProxy; directDomains: string[]; createdAt: string }
export interface NetworkView {
    id: string; name: string; subnet: string; gateway: string; proxyUrl: string; proxyAuthConfigured: boolean;
    directDomains: string[]; createdAt: string; state: NetworkState | 'busy' | 'error'; instances: { id: string; name: string }[];
}
export interface InstanceView extends InstanceRecord {
    networkId?: string;
    networkName?: string;
    proxyUrl?: string;
    proxyAuthConfigured?: boolean;
    state: RuntimeInspection['state'] | 'busy' | 'error';
    error?: string;
    authentication?: RuntimeInspection['authentication'];
    checks?: unknown;
}
export interface LoginOperation {
    id: string;
    owner: string;
    instanceId: string;
    runtime: RuntimeLogin;
    expiresAt: number;
    attached: boolean;
    output: string[];
    outputBytes: number;
    exitCode?: number;
    send?: (message: unknown) => void;
    close?: () => void;
    unsub: (() => void)[];
    released: boolean;
    cancellation?: Promise<void>;
}
export class ManagerService {
    private busy = new Set<string>();
    private errors = new Map<string, string>();
    readonly logins = new Map<string, LoginOperation>();
    constructor(readonly store: Store, readonly runtime: DockerRuntime, readonly image: string, readonly loginTimeoutMs = 10 * 60 * 1000, readonly gatewayImage?: string) { }
    private networkRecord(id: string): NetworkRecord {
        const record = UUID.test(id) ? this.store.secret<NetworkRecord>(`network:${id}`) : undefined;
        if (!record) throw new ApiError(404, 'NOT_FOUND', 'Network not found.');
        return record;
    }
    private networkRecords(): NetworkRecord[] {
        return this.store.keys('network:').map(key => this.store.secret<NetworkRecord>(key)!).filter(Boolean)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }
    private instanceNetworkId(instanceId: string) { return this.store.get(`instance-network:${instanceId}`); }
    private runtimeNetwork(record: NetworkRecord): RuntimeNetwork { return { id: record.id, subnet: record.subnet, proxy: record.proxy, directDomains: record.directDomains }; }
    /** Runtime view of an instance: forced-egress instances carry their network. */
    private target(instance: InstanceRecord): RuntimeInstance {
        if (instance.proxyMode !== 'network') return instance;
        const networkId = this.instanceNetworkId(instance.id);
        if (!networkId) throw new ApiError(409, 'NETWORK_NOT_CONFIGURED', 'Select a network for this instance.');
        return { ...instance, network: this.runtimeNetwork(this.networkRecord(networkId)) };
    }
    private networkChoice(data: Record<string, unknown>, mode: InstanceRecord['proxyMode']): string | undefined {
        if (mode !== 'network') return undefined;
        if (typeof data.networkId !== 'string') throw new ApiError(400, 'INVALID_BODY', 'Select a network.');
        return this.networkRecord(data.networkId).id;
    }
    private record(id: string) { const instance = this.store.instance(id); if (!instance)
        throw new ApiError(404, 'NOT_FOUND', 'Instance not found.'); return instance; }
    private proxy(instance: InstanceRecord) {
        if (instance.proxyMode === 'none' || instance.proxyMode === 'network') return null;
        const proxy = this.store.proxy(instance.proxyMode === 'custom' ? instance.id : undefined);
        if (!proxy) throw new ApiError(400, 'PROXY_NOT_CONFIGURED', 'Configure the selected proxy first.');
        return proxy;
    }
    private async locked<T>(id: string, run: (instance: InstanceRecord) => Promise<T>): Promise<T> {
        const instance = this.record(id);
        if (this.busy.has(id))
            throw new ApiError(409, 'INSTANCE_BUSY', 'An operation is already in progress.');
        this.busy.add(id);
        try {
            const result = await run(instance);
            this.errors.delete(id);
            return result;
        }
        catch (error) {
            if (!(error instanceof ApiError))
                this.errors.set(id, 'Runtime operation failed. Check the host configuration.');
            throw error;
        }
        finally {
            this.busy.delete(id);
        }
    }
    async view(id: string): Promise<InstanceView> {
        const record = this.record(id);
        const proxy = record.proxyMode === 'custom' ? this.store.proxy(id) : null;
        const networkId = record.proxyMode === 'network' ? this.instanceNetworkId(id) : undefined;
        const networkName = networkId ? this.store.secret<NetworkRecord>(`network:${networkId}`)?.name : undefined;
        const instance = { ...record, ...(proxy ? { proxyUrl: proxy.url, proxyAuthConfigured: !!(proxy.username || proxy.password) } : {}),
            ...(networkId ? { networkId, ...(networkName ? { networkName } : {}) } : {}) };
        if (this.busy.has(id))
            return { ...instance, state: 'busy' };
        try {
            const status = await this.runtime.inspect(instance);
            const error = this.errors.get(id);
            return { ...instance, ...status, ...(error ? { error } : {}) };
        }
        catch {
            return { ...instance, state: 'error', error: 'Runtime inspection failed. Check the host configuration.' };
        }
    }
    async list() { return Promise.all(this.store.list().map(instance => this.view(instance.id))); }
    async create(body: unknown) {
        const data = object(body, ['name', 'engine', 'proxyMode', 'proxyUrl', 'proxyUsername', 'proxyPassword', 'proxyClearAuth', 'networkId']);
        if (data.engine !== 'codex' && data.engine !== 'claude-code')
            throw new ApiError(400, 'INVALID_BODY', 'Invalid engine.');
        const instance: InstanceRecord = { id: randomUUID(), name: text(data.name, 100).trim(), engine: data.engine, proxyMode: proxyMode(data.proxyMode), createdAt: new Date().toISOString() };
        const custom = instance.proxyMode === 'custom' ? this.parseProxy(data) : null;
        if (instance.proxyMode === 'default') this.proxy(instance);
        const networkId = this.networkChoice(data, instance.proxyMode);
        this.store.transaction(() => { this.store.insert(instance); if (custom) this.store.setProxy(custom, instance.id);
            if (networkId) this.store.set(`instance-network:${instance.id}`, networkId); });
        await this.locked(instance.id, async (record) => this.runtime.create(this.target(record), this.proxy(record)));
        return this.view(instance.id);
    }
    async patch(id: string, body: unknown) {
        const data = object(body, ['name', 'proxyMode', 'proxyUrl', 'proxyUsername', 'proxyPassword', 'proxyClearAuth', 'networkId']);
        await this.locked(id, async (instance) => {
            const name = data.name === undefined ? instance.name : text(data.name, 100).trim();
            const mode = data.proxyMode === undefined ? instance.proxyMode : proxyMode(data.proxyMode);
            const previous = this.store.proxy(id);
            const custom = mode === 'custom' ? this.parseProxy(data, previous) : null;
            if (mode === 'default') this.proxy({ ...instance, proxyMode: mode });
            const networkId = this.networkChoice(data, mode);
            const previousNetwork = this.instanceNetworkId(id);
            const changed = mode !== instance.proxyMode || (mode === 'custom' && JSON.stringify(custom) !== JSON.stringify(previous))
                || (mode === 'network' && networkId !== previousNetwork);
            if (changed && (await this.runtime.inspect(instance)).state === 'running')
                throw new ApiError(409, 'STOP_REQUIRED', 'Stop this instance before changing its proxy.');
            this.store.transaction(() => {
                this.store.update({ ...instance, name, proxyMode: mode });
                if (mode === 'custom') this.store.setProxy(custom, id);
                if (networkId) this.store.set(`instance-network:${id}`, networkId);
                else this.store.delete(`instance-network:${id}`);
            });
        });
        return this.view(id);
    }
    async action(id: string, body: unknown) {
        const data = object(body, ['action']);
        if (!['start', 'stop', 'restart', 'check', 'hello', 'usage'].includes(String(data.action)))
            throw new ApiError(400, 'INVALID_BODY', 'Invalid action.');
        if (data.action === 'hello' || data.action === 'usage') {
            const kind = data.action;
            const result = await this.locked(id, async (instance) => {
                if ((await this.runtime.inspect(instance)).state === 'missing')
                    throw new ApiError(409, 'INSTANCE_MISSING', 'Instance container is missing. Start it to recreate the container.');
                return this.runtime.probe(this.target(instance), kind, this.proxy(instance));
            });
            const view = await this.view(id);
            return kind === 'hello' ? { ...view, providerTest: result } : { ...view, providerUsage: result };
        }
        let check: RuntimeInspection | undefined;
        await this.locked(id, async (instance) => {
            if (data.action === 'stop' || data.action === 'restart')
                await this.runtime.stop(instance);
            if (data.action === 'start' || data.action === 'restart') {
                if ((await this.runtime.inspect(instance)).state === 'missing')
                    await this.runtime.create(this.target(instance), this.proxy(instance));
                await this.runtime.start(this.target(instance), this.proxy(instance));
            }
            if (data.action === 'check')
                check = await this.runtime.check(this.target(instance), this.proxy(instance));
        });
        const view = await this.view(id);
        return check ? { ...view, ...check } : view;
    }
    settings() { const proxy = this.store.proxy(); return { image: this.image, proxyConfigured: !!proxy, proxyUrl: proxy?.url ?? null, gatewayImage: this.gatewayImage ?? null }; }
    // ---------- forced-egress networks ----------
    private async lockedNetwork<T>(id: string, run: (network: NetworkRecord) => Promise<T>): Promise<T> {
        const network = this.networkRecord(id);
        const key = `network:${id}`;
        if (this.busy.has(key)) throw new ApiError(409, 'NETWORK_BUSY', 'An operation is already in progress for this network.');
        this.busy.add(key);
        try { return await run(network); } finally { this.busy.delete(key); }
    }
    private async networkView(record: NetworkRecord): Promise<NetworkView> {
        let state: NetworkView['state'] = 'busy';
        if (!this.busy.has(`network:${record.id}`)) {
            try { state = await this.runtime.inspectNetwork(this.runtimeNetwork(record)); } catch { state = 'error'; }
        }
        return { id: record.id, name: record.name, subnet: record.subnet, gateway: gatewayAddress(record.subnet), proxyUrl: record.proxy.url,
            proxyAuthConfigured: !!(record.proxy.username || record.proxy.password), directDomains: record.directDomains, createdAt: record.createdAt, state,
            instances: this.store.list().filter(item => item.proxyMode === 'network' && this.instanceNetworkId(item.id) === record.id).map(item => ({ id: item.id, name: item.name })) };
    }
    async listNetworks() { return Promise.all(this.networkRecords().map(record => this.networkView(record))); }
    private networkFields(data: Record<string, unknown>, previous?: NetworkRecord) {
        const name = data.name === undefined && previous ? previous.name : text(data.name, 100).trim();
        const proxy = data.proxyUrl === undefined && data.proxyUsername === undefined && data.proxyPassword === undefined && data.proxyClearAuth === undefined && previous
            ? previous.proxy : this.parseProxy(data, previous?.proxy ?? null);
        const directDomains = data.directDomains === undefined ? previous?.directDomains ?? DEFAULT_DIRECT_DOMAINS : normalizeDirectDomains(data.directDomains);
        if (!directDomains) throw new ApiError(400, 'INVALID_BODY', 'Use up to 32 domain names, such as cindy.app.');
        return { name, proxy, directDomains };
    }
    async createNetwork(body: unknown) {
        const data = object(body, ['name', 'proxyUrl', 'proxyUsername', 'proxyPassword', 'directDomains']);
        const fields = this.networkFields(data);
        const subnet = await this.runtime.allocateSubnet(this.networkRecords().map(record => record.subnet));
        const record: NetworkRecord = { id: randomUUID(), subnet, createdAt: new Date().toISOString(), ...fields };
        this.store.setSecret(`network:${record.id}`, record);
        // A failed apply keeps the record so the operator can fix the cause and save again.
        await this.lockedNetwork(record.id, async network => this.runtime.applyNetwork(this.runtimeNetwork(network)));
        return this.networkView(record);
    }
    async updateNetwork(id: string, body: unknown) {
        const data = object(body, ['name', 'proxyUrl', 'proxyUsername', 'proxyPassword', 'proxyClearAuth', 'directDomains']);
        const record = await this.lockedNetwork(id, async previous => {
            const next: NetworkRecord = { ...previous, ...this.networkFields(data, previous) };
            this.store.setSecret(`network:${id}`, next);
            // Running instances keep their addresses; they reconnect through the replaced gateway.
            await this.runtime.applyNetwork(this.runtimeNetwork(next));
            return next;
        });
        return this.networkView(record);
    }
    async deleteNetwork(id: string) {
        await this.lockedNetwork(id, async network => {
            if (this.store.list().some(item => item.proxyMode === 'network' && this.instanceNetworkId(item.id) === id))
                throw new ApiError(409, 'NETWORK_IN_USE', 'Move every instance off this network first.');
            await this.runtime.removeNetwork(this.runtimeNetwork(network));
            this.store.delete(`network:${id}`);
        });
        return { deleted: true };
    }
    async testNetwork(id: string) {
        return this.lockedNetwork(id, async network => this.runtime.testNetwork(this.runtimeNetwork(network)));
    }
    private parseProxy(data: Record<string, unknown>, previous: RuntimeProxy | null = null): RuntimeProxy {
        const raw = data.proxyUrl === undefined ? previous?.url : data.proxyUrl;
        if (typeof raw !== 'string' || raw.length > 2048)
            throw new ApiError(400, 'INVALID_PROXY', 'Provide an HTTP proxy URL.');
        let url: URL;
        try {
            url = new URL(raw);
        }
        catch {
            throw new ApiError(400, 'INVALID_PROXY', 'Provide an HTTP proxy URL.');
        }
        if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
            throw new ApiError(400, 'INVALID_PROXY', 'Use an HTTP proxy URL without credentials, path, query or fragment.');
        for (const key of ['proxyUsername', 'proxyPassword'])
            if (data[key] !== undefined && (typeof data[key] !== 'string' || (data[key] as string).length > 1024 || /[\x00-\x1f\x7f]/.test(data[key] as string)))
                throw new ApiError(400, 'INVALID_PROXY', 'Invalid proxy credentials.');
        if (data.proxyClearAuth !== undefined && typeof data.proxyClearAuth !== 'boolean')
            throw new ApiError(400, 'INVALID_PROXY', 'Invalid proxy authentication option.');
        const same = previous?.url === url.origin;
        if (data.proxyClearAuth === true) return { url: url.origin };
        return { url: url.origin,
            username: (data.proxyUsername as string | undefined) || (same ? previous?.username : undefined),
            password: (data.proxyPassword as string | undefined) || (same ? previous?.password : undefined) };
    }
    updateSettings(body: unknown) {
        const data = object(body, ['proxyUrl', 'proxyUsername', 'proxyPassword', 'proxyClearAuth']);
        this.store.setProxy(data.proxyUrl === null ? null : this.parseProxy(data, this.store.proxy()));
        return this.settings();
    }
    async testProxy(body: unknown) {
        const data = object(body, ['proxyMode', 'instanceId', 'proxyUrl', 'proxyUsername', 'proxyPassword', 'proxyClearAuth']);
        const mode = proxyMode(data.proxyMode);
        if (mode === 'default' && data.proxyUrl === undefined && !this.store.proxy())
            throw new ApiError(400, 'PROXY_NOT_CONFIGURED', 'Configure the selected proxy first.');
        const previous = data.instanceId === undefined ? null : this.store.proxy(this.record(text(data.instanceId)).id);
        const proxy = mode === 'custom' ? this.parseProxy(data, previous)
            : mode === 'default' ? this.parseProxy(data, this.store.proxy()) : null;
        if (!proxy) throw new ApiError(400, 'PROXY_NOT_CONFIGURED', 'Configure the selected proxy first.');
        return this.runtime.testProxy(proxy);
    }
    async share(id: string, body: unknown) {
        const data = object(body, ['action', 'id', 'code']);
        if (!['list', 'link', 'approve', 'reject', 'pause', 'resume', 'remove', 'quota', 'usage'].includes(String(data.action)))
            throw new ApiError(400, 'INVALID_BODY', 'Invalid share action.');
        if (data.id !== undefined)
            text(data.id, 200);
        if (data.code !== undefined)
            text(data.code, 200);
        if (data.action === 'approve' && !data.code)
            throw new ApiError(400, 'INVALID_BODY', 'Approval requires a pairing code.');
        return this.locked(id, async (instance) => {
            if ((await this.runtime.inspect(instance)).state !== 'running')
                throw new ApiError(409, 'START_REQUIRED', 'Start the instance to manage sharing.');
            return this.runtime.share(instance, data as unknown as ShareRequest, this.proxy(instance));
        });
    }
    async login(id: string, owner: string, body: unknown, isActive: () => boolean = () => true) {
        const data = object(body, ['target', 'method', 'email']);
        if (data.target !== 'cindy' && data.target !== 'provider')
            throw new ApiError(400, 'INVALID_BODY', 'Invalid login target.');
        if (data.method !== undefined && data.method !== 'google' && data.method !== 'email')
            throw new ApiError(400, 'INVALID_BODY', 'Invalid login method.');
        if (data.email !== undefined)
            text(data.email, 320);
        if (data.target === 'cindy' && (data.method === undefined || (data.method === 'email' && !data.email)))
            throw new ApiError(400, 'INVALID_BODY', 'Choose a login method and provide an email when required.');
        const instance = this.record(id);
        if (this.busy.has(id))
            throw new ApiError(409, 'INSTANCE_BUSY', 'An operation is already in progress.');
        this.busy.add(id);
        let operation: LoginOperation | undefined;
        try {
            if ((await this.runtime.inspect(instance)).state === 'running')
                throw new ApiError(409, 'STOP_REQUIRED', 'Stop the instance before logging in.');
            const runtime = await this.runtime.openLogin(this.target(instance), data as unknown as LoginRequest, this.proxy(instance));
            const login: LoginOperation = { id: randomUUID(), instanceId: id, owner, runtime, expiresAt: Date.now() + this.loginTimeoutMs, attached: false, output: [], outputBytes: 0, unsub: [], released: false };
            operation = login;
            this.logins.set(login.id, login);
            login.unsub.push(runtime.onOutput(output => {
                if (login.send)
                    login.send({ type: 'output', data: output });
                else {
                    login.output.push(output);
                    login.outputBytes += Buffer.byteLength(output);
                    while (login.outputBytes > 65536 && login.output.length)
                        login.outputBytes -= Buffer.byteLength(login.output.shift()!);
                }
            }));
            login.unsub.push(runtime.onExit(code => { login.exitCode = code; this.releaseLogin(login); login.send?.({ type: 'exit', code }); }));
            if (!isActive()) {
                await this.cancelLogin(login);
                throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
            }
            return login.id;
        }
        catch (error) {
            if (!operation)
                this.busy.delete(id);
            throw error;
        }
    }
    ownedLogin(id: string, owner: string) { const login = this.logins.get(id); if (!login || login.owner !== owner || login.expiresAt <= Date.now())
        throw new ApiError(404, 'NOT_FOUND', 'Login operation not found.'); return login; }
    private releaseLogin(login: LoginOperation) { if (!login.released) {
        login.released = true;
        this.busy.delete(login.instanceId);
    } }
    async cancelLogin(login: LoginOperation) {
        if (login.cancellation)
            return login.cancellation;
        login.send = undefined;
        login.close?.();
        login.cancellation = (async () => {
            await login.runtime.cancel();
            login.unsub.forEach(unsubscribe => unsubscribe());
            this.logins.delete(login.id);
            this.releaseLogin(login);
        })();
        try {
            await login.cancellation;
        }
        catch (error) {
            login.cancellation = undefined;
            throw error;
        }
    }
    async revoke(owner: string) { await Promise.allSettled([...this.logins.values()].filter(login => login.owner === owner).map(login => this.cancelLogin(login))); }
    async sweep(active: (owner: string) => boolean) { await Promise.allSettled([...this.logins.values()].filter(login => !active(login.owner) || login.expiresAt <= Date.now()).map(login => this.cancelLogin(login))); }
    async close() {
        const results=await Promise.allSettled([...this.logins.values()].map(login=>this.cancelLogin(login)));
        if(results.some(result=>result.status==='rejected'))throw new Error('Some managed login containers could not be stopped.');
    }
}

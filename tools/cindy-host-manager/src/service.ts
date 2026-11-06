import { randomUUID } from 'node:crypto';
import { Store, type InstanceRecord } from './store.js';
import type { DockerRuntime, LoginRequest, RuntimeInspection, RuntimeLogin, ShareRequest } from './runtime-types.js';
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
function proxyMode(value: unknown): 'none' | 'default' { if (value !== 'none' && value !== 'default')
    throw new ApiError(400, 'INVALID_BODY', 'Invalid proxy mode.'); return value; }
export interface InstanceView extends InstanceRecord {
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
    constructor(readonly store: Store, readonly runtime: DockerRuntime, readonly image: string, readonly loginTimeoutMs = 10 * 60 * 1000) { }
    private record(id: string) { const instance = this.store.instance(id); if (!instance)
        throw new ApiError(404, 'NOT_FOUND', 'Instance not found.'); return instance; }
    private proxy(instance: InstanceRecord) { return instance.proxyMode === 'default' ? this.store.proxy() : null; }
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
        const instance = this.record(id);
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
        const data = object(body, ['name', 'engine', 'proxyMode']);
        if (data.engine !== 'codex' && data.engine !== 'claude-code')
            throw new ApiError(400, 'INVALID_BODY', 'Invalid engine.');
        const instance: InstanceRecord = { id: randomUUID(), name: text(data.name, 100).trim(), engine: data.engine, proxyMode: proxyMode(data.proxyMode), createdAt: new Date().toISOString() };
        this.store.insert(instance);
        await this.locked(instance.id, async (record) => this.runtime.create(record, this.proxy(record)));
        return this.view(instance.id);
    }
    async patch(id: string, body: unknown) {
        const data = object(body, ['name', 'proxyMode']);
        await this.locked(id, async (instance) => {
            const name = data.name === undefined ? instance.name : text(data.name, 100).trim();
            const mode = data.proxyMode === undefined ? instance.proxyMode : proxyMode(data.proxyMode);
            if (mode !== instance.proxyMode && (await this.runtime.inspect(instance)).state === 'running')
                throw new ApiError(409, 'STOP_REQUIRED', 'Stop this instance before changing its proxy.');
            this.store.update({ ...instance, name, proxyMode: mode });
        });
        return this.view(id);
    }
    async action(id: string, body: unknown) {
        const data = object(body, ['action']);
        if (!['start', 'stop', 'restart', 'check'].includes(String(data.action)))
            throw new ApiError(400, 'INVALID_BODY', 'Invalid action.');
        let check: RuntimeInspection | undefined;
        await this.locked(id, async (instance) => {
            if (data.action === 'stop' || data.action === 'restart')
                await this.runtime.stop(instance);
            if (data.action === 'start' || data.action === 'restart') {
                if ((await this.runtime.inspect(instance)).state === 'missing')
                    await this.runtime.create(instance, this.proxy(instance));
                await this.runtime.start(instance, this.proxy(instance));
            }
            if (data.action === 'check')
                check = await this.runtime.check(instance, this.proxy(instance));
        });
        const view = await this.view(id);
        return check ? { ...view, ...check } : view;
    }
    settings() { const proxy = this.store.proxy(); return { image: this.image, proxyConfigured: !!proxy, proxyUrl: proxy?.url ?? null }; }
    updateSettings(body: unknown) {
        const data = object(body, ['proxyUrl', 'proxyUsername', 'proxyPassword']);
        if (data.proxyUrl === null) {
            this.store.setProxy(null);
            return this.settings();
        }
        const previous = this.store.proxy();
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
        const same = previous?.url === url.origin;
        this.store.setProxy({ url: url.origin, username: data.proxyUsername as string | undefined ?? (same ? previous?.username : undefined), password: data.proxyPassword as string | undefined ?? (same ? previous?.password : undefined) });
        return this.settings();
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
            const runtime = await this.runtime.openLogin(instance, data as unknown as LoginRequest, this.proxy(instance));
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

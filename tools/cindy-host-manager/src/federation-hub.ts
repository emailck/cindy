import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from './store.js';
import { ApiError, text } from './service.js';
import { FEDERATION_VERSION, LEASE_MS, hash, identifier, parse, send, type FederationNode, type Frame, type RpcResult } from './federation-protocol.js';
interface NodeRecord { id: string; name: string; lastSeen: string | null; verifier?: string; enrollment?: string; expires?: number }
interface Pending { resolve(result: RpcResult): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; owner: string }
interface Stream { owner: string; send(data: unknown): void; close(): void }
interface Connection { ws: WebSocket; ready: boolean; seen: number; pending: Map<string, Pending>; streams: Map<string, Stream>; owners: Set<string> }
export class FederationHub {
    private closed = false;
    private connections = new Map<string, Connection>();
    private nodes: NodeRecord[];
    private timer: ReturnType<typeof setInterval>;
    constructor(readonly store: Store) {
        this.nodes = JSON.parse(store.get('federation:nodes') ?? '[]') as NodeRecord[];
        this.timer = setInterval(() => {
            for (const [nodeId, conn] of this.connections) {
                if (Date.now() - conn.seen > LEASE_MS) conn.ws.terminate();
                else if (conn.ready) { try { send(conn.ws, { type: 'lease', owners: [...conn.owners].map(owner => hash(nodeId + ':' + owner)) }); } catch { conn.ws.terminate(); } }
            }
        }, 10_000);
        this.timer.unref();
    }
    private persist() { this.store.set('federation:nodes', JSON.stringify(this.nodes)); }
    listNodes(): FederationNode[] { return this.nodes.map(node => ({ id: node.id, name: node.name, online: this.connections.get(node.id)?.ready ?? false, lastSeen: this.connections.get(node.id)?.ready ? new Date(this.connections.get(node.id)!.seen).toISOString() : node.lastSeen })); }
    createEnrollment(name: string) {
        name = text(name, 100).trim();
        const nodeId = randomUUID();
        const enrollmentToken = nodeId + '.' + randomBytes(32).toString('base64url');
        const node: NodeRecord = { id: nodeId, name, lastSeen: null, enrollment: hash(enrollmentToken), expires: Date.now() + 10 * 60_000 };
        this.nodes.push(node); this.persist();
        return { node: { id: node.id, name, online: false, lastSeen: null }, enrollmentToken, expiresAt: new Date(node.expires!).toISOString() };
    }
    enroll(token: string, suppliedCredential?: string) {
        if (typeof token !== 'string' || token.length > 200) throw new ApiError(401, 'ENROLLMENT_REJECTED', 'Enrollment code is invalid or expired.');
        const node = this.nodes.find(node => node.enrollment === hash(token) && (node.expires ?? 0) > Date.now());
        if (!node) throw new ApiError(401, 'ENROLLMENT_REJECTED', 'Enrollment code is invalid or expired.');
        if (suppliedCredential !== undefined && !/^[a-zA-Z0-9_-]{43}$/.test(suppliedCredential)) throw new ApiError(400, 'INVALID_CREDENTIAL', 'Invalid machine credential.');
        const credential = suppliedCredential ?? randomBytes(32).toString('base64url');
        node.verifier = hash(credential); delete node.enrollment; delete node.expires; this.persist();
        return { nodeId: node.id, credential };
    }
    authenticate(nodeId: string, credential: string) {
        if (typeof credential !== 'string' || credential.length > 200) return false;
        const verifier = this.nodes.find(node => node.id === nodeId)?.verifier;
        return !!verifier && timingSafeEqual(Buffer.from(verifier, 'hex'), Buffer.from(hash(credential), 'hex'));
    }
    accept(ws: WebSocket, nodeId: string, credential: string) {
        if (!this.authenticate(nodeId, credential)) { ws.close(1008, 'Machine authentication rejected'); return; }
        this.connections.get(nodeId)?.ws.terminate();
        const conn: Connection = { ws, ready: false, seen: Date.now(), pending: new Map(), streams: new Map(), owners: new Set() };
        this.connections.set(nodeId, conn);
        const cleanup = () => {
            if (this.connections.get(nodeId) === conn) {
                this.connections.delete(nodeId);
                const node = this.nodes.find(node => node.id === nodeId);
                if (node && conn.ready) { node.lastSeen = new Date(conn.seen).toISOString(); if (!this.closed) this.persist(); }
            }
            for (const pending of conn.pending.values()) { clearTimeout(pending.timer); pending.reject(new ApiError(503, 'OPERATION_UNCERTAIN', 'Connection lost. Operation outcome must be checked before retrying.')); }
            conn.pending.clear(); conn.streams.forEach(stream => stream.close()); conn.streams.clear();
        };
        ws.on('close', cleanup); ws.on('error', () => ws.terminate());
        ws.on('message', raw => {
            if (this.connections.get(nodeId) !== conn) return;
            try {
                const frame = parse(raw);
                if (!conn.ready) {
                    if (frame.type !== 'hello' || frame.version !== FEDERATION_VERSION || frame.nodeId !== nodeId) { ws.close(1008, 'VERSION_MISMATCH'); return; }
                    conn.ready = true; this.nodes.find(node => node.id === nodeId)!.lastSeen = new Date().toISOString(); this.persist();
                    send(ws, { type: 'ready', version: FEDERATION_VERSION }); return;
                }
                conn.seen = Date.now();
                if (frame.type === 'pong') return;
                if (frame.type === 'result' && typeof frame.id === 'string') {
                    const pending = conn.pending.get(frame.id);
                    if (!pending) return;
                    if (!Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) throw new Error('Invalid result');
                    clearTimeout(pending.timer); conn.pending.delete(frame.id); pending.resolve({ status: frame.status, body: frame.body }); return;
                }
                if (frame.type === 'terminal' && typeof frame.loginId === 'string') {
                    const stream = conn.streams.get(frame.loginId);
                    if (stream && hash(nodeId + ":" + stream.owner) === frame.owner) stream.send(frame.data);
                    return;
                }
                if (frame.type === 'terminalClosed' && typeof frame.loginId === 'string') { const stream = conn.streams.get(frame.loginId); if (stream && hash(nodeId + ":" + stream.owner) === frame.owner) { conn.streams.delete(frame.loginId); stream.close(); } return; }
                throw new Error('Invalid message');
            } catch { ws.close(1008, 'Invalid federation frame'); }
        });
    }
    revoke(nodeId: string) {
        this.nodes = this.nodes.filter(node => node.id !== nodeId); this.persist();
        this.connections.get(nodeId)?.ws.close(1008, 'Machine revoked');
        // Remove synchronously so no new request can race the close handshake.
        this.connections.get(nodeId)?.ws.terminate();
        this.connections.delete(nodeId);
    }
    private connection(nodeId: string) {
        const conn = this.connections.get(nodeId);
        if (!conn?.ready || !this.nodes.some(node => node.id === nodeId && node.verifier)) throw new ApiError(503, 'NODE_OFFLINE', 'Machine is offline.');
        return conn;
    }
    private rpc(nodeId: string, owner: string, frame: Frame): Promise<RpcResult> {
        if (!identifier(owner)) throw new ApiError(400, 'INVALID_OWNER', 'Invalid owner.');
        const conn = this.connection(nodeId), id = randomUUID();
        conn.owners.add(owner);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { conn.pending.delete(id); reject(new ApiError(504, 'OPERATION_UNCERTAIN', 'Operation timed out. Check the machine before retrying.')); }, 30_000);
            timer.unref(); conn.pending.set(id, { resolve, reject, timer, owner });
            try { send(conn.ws, { ...frame, id, owner: hash(nodeId + ":" + owner) }); } catch (error) { clearTimeout(timer); conn.pending.delete(id); reject(error); }
        });
    }
    async request(nodeId: string, owner: string, method: string, path: string, body?: unknown, operationId: string = randomUUID()): Promise<RpcResult> {
        return this.rpc(nodeId, owner, { type: 'request', method, path, body, operationId });
    }
    async attachLogin(nodeId: string, owner: string, loginId: string, output: (data: unknown) => void, close: () => void) {
        const conn = this.connection(nodeId);
        if (conn.streams.has(loginId)) throw new ApiError(409, 'ALREADY_ATTACHED', 'Login already connected.');
        conn.streams.set(loginId, { owner, send: output, close });
        try {
            const result = await this.rpc(nodeId, owner, { type: 'attach', loginId });
            if (result.status >= 400) { const err = (result.body as any)?.error; throw new ApiError(result.status, err?.code ?? 'OPERATION_FAILED', err?.message ?? 'Login attachment failed.'); }
        } catch (error) {
            conn.streams.delete(loginId);
            // Attachment may have succeeded even when its acknowledgement was lost.
            // Cancel only this owner's login; never leave an unreachable attached profile lock.
            if (this.connections.get(nodeId) === conn) { try { send(conn.ws, { type: 'detach', loginId, owner: hash(nodeId + ':' + owner) }); } catch {} }
            throw error;
        }
        return {
            message: (data: unknown) => { if (this.connections.get(nodeId) !== conn || conn.streams.get(loginId)?.owner !== owner) return; send(conn.ws, { type: 'terminal', loginId, owner: hash(nodeId + ':' + owner), data }); },
            close: () => { if (conn.streams.get(loginId)?.owner !== owner) return; conn.streams.delete(loginId); try { send(conn.ws, { type: 'detach', loginId, owner: hash(nodeId + ':' + owner) }); } catch { /* connection cleanup revokes the lease */ } },
        };
    }
    revokeOwner(owner: string) {
        for (const [nodeId, conn] of this.connections) {
            if (!conn.owners.delete(owner)) continue;
            for (const [id, stream] of conn.streams) if (stream.owner === owner) { conn.streams.delete(id); stream.close(); }
            try { send(conn.ws, { type: 'revokeOwner', owner: hash(nodeId + ':' + owner) }); } catch { conn.ws.terminate(); }
        }
    }
    sweep(active: (owner: string) => boolean) { for (const conn of this.connections.values()) for (const owner of conn.owners) if (!active(owner)) this.revokeOwner(owner); }
    close() { this.closed = true; for (const [nodeId, conn] of this.connections) { const node = this.nodes.find(node => node.id === nodeId); if (node && conn.ready) node.lastSeen = new Date(conn.seen).toISOString(); } this.persist(); clearInterval(this.timer); for (const conn of this.connections.values()) conn.ws.terminate(); }
}

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Store } from './store.js';
const derive = promisify(scrypt);
export interface Session {
    id: string;
    csrfToken: string;
    expiresAt: number;
}
export class Auth {
    private sessions = new Map<string, Session>();
    private attempts: number[] = [];
    constructor(private store: Store, readonly lifetimeMs = 8 * 60 * 60 * 1000, private now = Date.now) { }
    initialized() { return !!this.store.get('password'); }
    initialize(password: string) {
        if (this.initialized())
            throw new Error('Administrator already initialized.');
        if (password.length < 12 || password.length > 1024)
            throw new Error('Password must have 12 to 1024 characters.');
        const salt = randomBytes(16).toString('hex');
        this.store.set('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    }
    async login(password: string): Promise<Session | null> {
        const now = this.now();
        this.attempts = this.attempts.filter(at => at > now - 60000);
        if (this.attempts.length >= 10)
            return null;
        this.attempts.push(now);
        const stored = this.store.get('password');
        if (!stored)
            return null;
        const [salt, hash] = stored.split(':');
        const actual = await derive(password, salt!, 64) as Buffer;
        const expected = Buffer.from(hash!, 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
            return null;
        const session = { id: randomBytes(32).toString('hex'), csrfToken: randomBytes(32).toString('hex'), expiresAt: now + this.lifetimeMs };
        this.sessions.set(session.id, session);
        return session;
    }
    session(cookie: string | undefined): Session | undefined {
        const id = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('cindy_manager='))?.slice('cindy_manager='.length);
        const session = id ? this.sessions.get(id) : undefined;
        return session && session.expiresAt > this.now() ? session : undefined;
    }
    active(id: string) { const session = this.sessions.get(id); return !!session && session.expiresAt > this.now(); }
    revoke(id: string) { this.sessions.delete(id); }
    prune() { for (const [id, session] of this.sessions)
        if (session.expiresAt <= this.now())
            this.sessions.delete(id); }
}

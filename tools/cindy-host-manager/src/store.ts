import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { RuntimeInstance, RuntimeProxy } from './runtime-types.js';
export interface InstanceRecord extends RuntimeInstance {
    name: string;
    proxyMode: 'none' | 'default' | 'custom';
    createdAt: string;
}
export function privateDirectory(path: string): string {
    if (!isAbsolute(path))
        throw new Error('Data directory must be absolute and outside a Git workspace.');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077))
        throw new Error('Data directory must be owned by the current user with mode 0700.');
    const canonical = realpathSync(path);
    for (let parent = canonical;; parent = dirname(parent)) {
        if (existsSync(join(parent, '.git')))
            throw new Error('Data directory must be outside a Git workspace.');
        if (dirname(parent) === parent)
            break;
    }
    return canonical;
}
function privateFile(path: string) {
    if (!existsSync(path))
        return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077))
        throw new Error('Unsafe data file permissions.');
}
export class Store {
    readonly db: DatabaseSync;
    private readonly key: Buffer;
    constructor(directory: string) {
        directory = privateDirectory(directory);
        const keyPath = join(directory, 'encryption.key');
        privateFile(keyPath);
        if (!existsSync(keyPath))
            writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
        this.key = readFileSync(keyPath);
        if (this.key.length !== 32)
            throw new Error('Invalid encryption key.');
        const dbPath = join(directory, 'manager.sqlite');
        privateFile(dbPath);
        if (!existsSync(dbPath))
            writeFileSync(dbPath, '', { flag: 'wx', mode: 0o600 });
        this.db = new DatabaseSync(dbPath);
        chmodSync(dbPath, 0o600);
        this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY,name TEXT NOT NULL,engine TEXT NOT NULL,proxyMode TEXT NOT NULL,createdAt TEXT NOT NULL);');
    }
    transaction(run: () => void) {
        this.db.exec('BEGIN IMMEDIATE');
        try { run(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    close() { this.db.close(); }
    get(key: string): string | undefined { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {
        value: string;
    } | undefined)?.value; }
    set(key: string, value: string) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
    insert(instance: InstanceRecord) { this.db.prepare('INSERT INTO instances VALUES(?,?,?,?,?)').run(instance.id, instance.name, instance.engine, instance.proxyMode, instance.createdAt); }
    update(instance: InstanceRecord) { this.db.prepare('UPDATE instances SET name=?,proxyMode=? WHERE id=?').run(instance.name, instance.proxyMode, instance.id); }
    list(): InstanceRecord[] { return this.db.prepare('SELECT * FROM instances ORDER BY createdAt,id').all() as unknown as InstanceRecord[]; }
    instance(id: string): InstanceRecord | undefined { return this.db.prepare('SELECT * FROM instances WHERE id=?').get(id) as unknown as InstanceRecord | undefined; }
    proxy(instanceId?: string): RuntimeProxy | null {
        const encrypted = this.get(instanceId ? `proxy:${instanceId}` : 'proxy');
        if (!encrypted)
            return null;
        const buffer = Buffer.from(encrypted, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(0, 12));
        decipher.setAuthTag(buffer.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString()) as RuntimeProxy;
    }
    setProxy(proxy: RuntimeProxy | null, instanceId?: string) {
        const key = instanceId ? `proxy:${instanceId}` : 'proxy';
        if (!proxy) {
            this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
            return;
        }
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(proxy)), cipher.final()]);
        this.set(key, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'));
    }
}

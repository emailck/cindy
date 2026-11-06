import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliDependencies } from './cli';
import { readConfig, resolveDataDirectory, updateConfig } from './config';
import { serveHost, withProfileLock } from './lifecycle';
import { createHostAuthFetch } from './auth-fetch';

/* Test value: public runCli/readConfig/serveHost results protect CLI-002 diagnostics,
 * credentials-and-local-storage (no repository writes), configuration-and-overrides §2,
 * and SIGTERM cleanup. No prior host CLI exists. Minimal failures: omitted data directory,
 * a token config key, corrupt JSON, concurrent profile mutation, or a signal during startup.
 * Tier: unit, only unique os.tmpdir fixtures and in-process signals; no services/processes.
 * Measured wall time: recorded in implementation report after execution.
 */
let root: string;
beforeAll(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-host-cli-'))); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function capture(extra: CliDependencies = {}) {
  const output: string[] = []; const errors: string[] = [];
  return { output, errors, deps: { output: (value: string) => output.push(value), error: (value: string) => errors.push(value), env: {}, ...extra } };
}

describe('host commands and configuration', () => {
  it('help and version work without opening a profile; missing data is diagnosed', async () => {
    const result = capture();
    expect(await runCli(['help'], result.deps)).toBe(0);
    expect(result.output.join('\n')).toContain('serve');
    expect(await runCli(['--version'], result.deps)).toBe(0);
    expect(await runCli(['status'], result.deps)).toBe(1);
    expect(result.errors.at(-1)).toContain('DATA_DIRECTORY_REQUIRED');
  });
  it('rejects repository roots and junctions into them before creating data', async () => {
    const repository = path.join(root, 'repository');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await expect(resolveDataDirectory(path.join(repository, 'profile'))).rejects.toMatchObject({ code: 'UNSAFE_DATA_DIRECTORY' });
    const alias = path.join(root, 'alias');
    try { await symlink(repository, alias, 'junction'); }
    catch (error) {
      // Platform capability probe: core lexical boundary above remains covered.
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await expect(resolveDataDirectory(path.join(alias, 'profile'))).rejects.toMatchObject({ code: 'UNSAFE_DATA_DIRECTORY' });
  });
  it('stores only explicit overrides, resets to defaults and rejects secret fields', async () => {
    const profile = path.join(root, 'config');
    const result = capture();
    expect(await runCli(['--data-dir', profile, 'config', 'set', 'remoteAccessEnabled', 'true'], result.deps)).toBe(0);
    expect(JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8'))).toEqual({ remoteAccessEnabled: true });
    expect((await readConfig(profile)).effective.remoteAccessEnabled).toBe(true);
    expect(await runCli(['--data-dir', profile, 'config', 'reset', 'remoteAccessEnabled'], result.deps)).toBe(0);
    expect((await readConfig(profile)).overrides).toEqual({});
    expect(await runCli(['--data-dir', profile, 'config', 'set', 'token', 'INVALID_TEST_SECRET'], result.deps)).toBe(1);
    expect(result.errors.join('\n')).not.toContain('INVALID_TEST_SECRET');
    expect((await readConfig(profile)).effective.remoteAccessEnabled).toBe(false);
  });
  // Unit: CLI previously rejected idle retention overrides; verify persisted numbers,
  // zero (not default fallback), reset semantics and invalid inputs without data loss.
  it('sets idle retention, rejects invalid values and resets the override', async () => {
    const profile = path.join(root, 'idle-retention');
    const result = capture();
    for (const minutes of ['0', '120', '1440']) {
      expect(await runCli(['--data-dir', profile, 'config', 'set', 'idleMinutes', minutes], result.deps)).toBe(0);
      expect((await readConfig(profile)).overrides).toEqual({ idleMinutes: Number(minutes) });
      expect((await readConfig(profile)).effective.idleMinutes).toBe(Number(minutes));
    }
    for (const invalid of ['-1', '1441', '1.5', '', 'abc', 'Infinity']) {
      expect(await runCli(['--data-dir', profile, 'config', 'set', 'idleMinutes', invalid], result.deps)).toBe(1);
      expect((await readConfig(profile)).overrides).toEqual({ idleMinutes: 1440 });
    }
    expect(await runCli(['--data-dir', profile, 'config', 'reset', 'idleMinutes'], result.deps)).toBe(0);
    expect((await readConfig(profile)).overrides).toEqual({});
    expect((await readConfig(profile)).effective.idleMinutes).toBe(30);
    await writeFile(path.join(profile, 'config.json'), JSON.stringify({ idleMinutes: '0' }));
    await expect(readConfig(profile)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
  it('preserves corrupt config and refuses unsupported permission modes', async () => {
    const profile = path.join(root, 'corrupt');
    await mkdir(profile);
    await writeFile(path.join(profile, 'config.json'), '{ broken');
    await expect(updateConfig(profile, 'deviceName', 'new')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await readFile(path.join(profile, 'config.json'), 'utf8')).toBe('{ broken');
    expect(await readdir(profile)).toEqual(['config.json']);
    await expect(updateConfig(path.join(root, 'invalid-mode'), 'permissionMode', 'bypass-auth')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
  it('reports unavailable runtime honestly and does not echo upstream error secrets', async () => {
    const profile = path.join(root, 'unavailable');
    const result = capture();
    expect(await runCli(['--data-dir', profile, 'serve'], result.deps)).toBe(1);
    expect(result.errors.at(-1)).toContain('RUNTIME_UNAVAILABLE');
    expect(await runCli(['--data-dir', profile, 'doctor'], result.deps)).toBe(1);
    expect(JSON.parse(result.output.at(-1)!).checks.find((check: {name: string}) => check.name === 'runtime').ok).toBe(false);
    const failing = capture({ status: async () => { throw new Error('INVALID_TEST_SECRET'); } });
    expect(await runCli(['--data-dir', profile, 'status'], failing.deps)).toBe(1);
    expect(failing.errors.join('\n')).not.toContain('INVALID_TEST_SECRET');
  });
  it('locks profile mutations against active serve or authentication commands', async () => {
    const profile = path.join(root, 'locked');
    await withProfileLock(profile, async () => {
      await expect(withProfileLock(profile, async () => {})).rejects.toMatchObject({ code: 'PROFILE_BUSY' });
      const result = capture();
      expect(await runCli(['--data-dir', profile, 'config', 'set', 'deviceName', 'new'], result.deps)).toBe(1);
      expect(result.errors[0]).toContain('PROFILE_BUSY');
    });
    expect(await readdir(profile)).toEqual([]);
  });
  it('validates auth and ordinary arguments without outputting submitted values', async () => {
    const profile = path.join(root, 'args');
    const result = capture();
    expect(await runCli(['--data-dir', profile, 'status', '--token', 'INVALID_TEST_SECRET'], result.deps)).toBe(1);
    expect(result.errors.at(-1)).toContain('INVALID_ARGUMENT');
    expect(result.errors.join('\n')).not.toContain('INVALID_TEST_SECRET');
    expect(await runCli(['--data-dir', profile, 'login'], result.deps)).toBe(1);
    expect(result.errors.at(-1)).toContain('AUTH_UNAVAILABLE');
  });
  it('serves only after explicit opt-in and releases the profile after shutdown', async () => {
    const profile = path.join(root, 'serve');
    const signals = new EventEmitter(); const events: string[] = [];
    const result = capture({ signals, createHost: async context => {
      expect(context.region).toBe('global');
      expect(context.config.permissionMode).toBe('full-access');
      return { start: async () => { events.push('start'); }, stop: async () => { events.push('stop'); } };
    } });
    expect(await runCli(['--data-dir', profile, 'serve'], result.deps)).toBe(1);
    expect(result.errors.at(-1)).toContain('REMOTE_ACCESS_DISABLED');
    await updateConfig(profile, 'remoteAccessEnabled', 'true');
    const output = result.deps.output;
    result.deps.output = line => { output(line); if (line.includes('ready')) signals.emit('SIGTERM'); };
    expect(await runCli(['--data-dir', profile, 'serve'], result.deps)).toBe(0);
    expect(events).toEqual(['start', 'stop']);
    expect(await readdir(profile)).toEqual(['config.json']);
  });
  it('cancels authentication through the public command and releases its profile lock', async () => {
    const profile = path.join(root, 'cancel-login');
    const signals = new EventEmitter();
    const result = capture({ signals, authCommand: async (_args, context) => {
      expect(await readdir(profile)).toEqual(['profile.lock']);
      signals.emit('SIGTERM');
      expect(context.signal?.aborted).toBe(true);
      return 1;
    } });
    expect(await runCli(['--data-dir', profile, 'login'], result.deps)).toBe(1);
    expect(await readdir(profile)).toEqual([]);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('cancels before the public serve factory resolves without starting or leaving a lock', async () => {
    const profile = path.join(root, 'cancel-factory');
    await updateConfig(profile, 'remoteAccessEnabled', 'true');
    const signals = new EventEmitter(); const events: string[] = [];
    const result = capture({ signals, createHost: async context => {
      signals.emit('SIGTERM');
      expect(context.signal?.aborted).toBe(true);
      return { start: async () => { events.push('start'); }, stop: async () => { events.push('stop'); } };
    } });
    expect(await runCli(['--data-dir', profile, 'serve'], result.deps)).toBe(0);
    expect(events).toEqual(['stop']);
    expect(await readdir(profile)).toEqual(['config.json']);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('foreground lifecycle', () => {
  // Credential cancellation rule: successful rotation responses must not be lost.
  // First host transport has no previous coverage. Minimal input: abort after fetch
  // starts; unit, injected fetch only (no sockets or real credential material).
  it.each(['/api/auth/refresh', '/api/auth/account/refresh'])('delivers an in-flight %s result after host cancellation', async endpoint => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let respond!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void;
    const fetch = createHostAuthFetch(controller.signal, async (_input, init) => {
      requestSignal = init?.signal;
      return new Promise(resolve => { respond = resolve; });
    });
    const response = fetch(`https://auth.invalid${endpoint}`);
    controller.abort();
    expect(requestSignal?.aborted).not.toBe(true);
    respond({ ok: true, status: 200, json: async () => ({ rotated: true }) });
    expect(await (await response).json()).toEqual({ rotated: true });
    expect(() => fetch(`https://auth.invalid${endpoint}`)).toThrow();
  });
  it('aborts ordinary authentication requests and keeps the caller timeout signal', async () => {
    const controller = new AbortController(); const timeout = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetch = createHostAuthFetch(controller.signal, async (_input, init) => {
      requestSignal = init?.signal;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    await fetch('https://auth.invalid/api/auth/desktop/poll', { signal: timeout.signal });
    timeout.abort();
    expect(requestSignal?.aborted).toBe(true);
    await fetch('https://auth.invalid/api/auth/providers');
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });
  it('SIGTERM after readiness cleans once and unregisters both signal handlers', async () => {
    const signals = new EventEmitter(); const events: string[] = [];
    await serveHost({ start: async () => { events.push('start'); }, stop: async () => { events.push('stop'); } }, {
      signals, ready: () => { events.push('ready'); signals.emit('SIGTERM'); signals.emit('SIGINT'); },
    });
    expect(events).toEqual(['start', 'ready', 'stop']);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
  it('signal during startup aborts startup, skips ready and still cleans', async () => {
    const signals = new EventEmitter(); const events: string[] = [];
    await serveHost({
      start: async signal => { signals.emit('SIGTERM'); expect(signal.aborted).toBe(true); throw new Error('aborted'); },
      stop: async () => { events.push('stop'); },
    }, { signals, ready: () => events.push('ready') });
    expect(events).toEqual(['stop']);
  });
  it('signal during asynchronous host creation skips startup and cleans created resources', async () => {
    const signals = new EventEmitter(); const events: string[] = [];
    await serveHost(async () => {
      signals.emit('SIGTERM');
      return { start: async () => { events.push('start'); }, stop: async () => { events.push('stop'); } };
    }, { signals, ready: () => events.push('ready') });
    expect(events).toEqual(['stop']);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('startup failure preserves the error while cleaning resources', async () => {
    const signals = new EventEmitter(); const events: string[] = [];
    await expect(serveHost({ start: async () => { throw new Error('start failed'); }, stop: async () => { events.push('stop'); } }, { signals })).rejects.toThrow('start failed');
    expect(events).toEqual(['stop']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
  it('fatal runtime failure exits through stop rather than waiting forever', async () => {
    const events: string[] = [];
    await expect(serveHost({ start: async () => {}, stop: async () => { events.push('stop'); }, waitUntilStopped: async () => { throw new Error('relay fatal'); } }, { signals: new EventEmitter() })).rejects.toThrow('relay fatal');
    expect(events).toEqual(['stop']);
  });
});

/**
 * 测试价值
 * - 生产入口与可观察结果：runCli（cindy 命令入口）；输出语言、设置持久化、错误码、进程锁与传给对话的本次覆盖。
 * - Bug／规则依据：docs/cindy-cli-client-plan.md（用户裁决：默认 full、中英切换）；credentials-and-local-storage
 *   （数据目录不得在 Git 工作区内）；同一数据目录只能有一个进程持有登录（刷新令牌轮换竞态）。
 * - 现有覆盖缺口：新程序，无既有覆盖；cindy-host 的同类测试不经过本入口。
 * - 最小失败输入：语言优先级颠倒、坏设置文件被覆盖、Git 内数据目录被接受、并发登录不报 PROFILE_BUSY；
 *   进程已不在的 profile.lock 挡住下一次启动、关掉终端（SIGHUP）或界面接管前按 Ctrl+C 时进程被直接杀掉而锁留下
 *   （2026-11-16 用户反馈：进程退出后锁还在）；输入历史混入别的项目目录或别的账号、重复输入不去重、文件不是私有权限；
 *   任务对话记录不是私有权限、任意字符串被当成文件名、没有任务记录的对话记录一直留着。
 * - tier：unit（临时目录 + 注入依赖，不访问网络与系统钥匙串）。
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliDependencies } from './cli';
import { credentialStore } from './auth';
import { createHistoryStore, createTaskStore } from './store';

// Never access the developer's real OS credential store.
vi.mock('@napi-rs/keyring', () => ({ AsyncEntry: class { constructor() { throw new Error('No test keyring'); } } }));

let dataDir: string;
let lines: string[];
let errors: string[];
const env = { LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv;
const signals = { on() {}, removeListener() {} };

function run(argv: string[], extra: CliDependencies = {}) {
  return runCli(['--data-dir', dataDir, ...argv], { env, signals, output: text => lines.push(text), error: text => errors.push(text), ...extra });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cindy-cli-test-'));
  lines = []; errors = [];
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dataDir, { recursive: true, force: true }); });

describe('cindy command entry', () => {
  // User decision 2026-11-16: Linux login must work without Secret Service or env setup.
  // Missing coverage: CLI default backend selection, persistence and permissions; tier: unit.
  it.skipIf(process.platform !== 'linux')('persists Linux credentials privately without a keyring and honors an explicit override', async () => {
    vi.stubEnv('CINDY_CLI_CREDENTIAL_STORE', undefined);
    const store = credentialStore(dataDir);
    await store.assertAvailable();
    await store.set('test-credential', 'invalid-test-token');
    expect(await credentialStore(dataDir).get('test-credential')).toBe('invalid-test-token');
    const directory = path.join(dataDir, 'credentials');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    vi.stubEnv('CINDY_CLI_CREDENTIAL_STORE', 'keyring');
    await expect(credentialStore(dataDir).assertAvailable()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    vi.stubEnv('CINDY_CLI_CREDENTIAL_STORE', 'file');
    expect(await credentialStore(dataDir).get('test-credential')).toBe('invalid-test-token');
    await credentialStore(dataDir).delete('test-credential');
    expect(await store.get('test-credential')).toBeNull();
  });

  it('defaults to full access and follows saved language, with --lang winning for one run', async () => {
    expect(await run(['status'])).toBe(0);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ language: 'en', permissionMode: 'full' });

    expect(await run(['config', 'set', 'language', 'zh'])).toBe(0);
    // Confirmation uses the language in effect when the command ran.
    expect(lines.pop()).toBe('Setting saved.');
    expect(await run(['status'])).toBe(0);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ language: 'zh', title: 'Cindy CLI 状态' });

    expect(await run(['status', '--lang', 'en'])).toBe(0);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ language: 'en' });
  });

  it('rejects invalid settings without rewriting the file, and preserves a malformed file', async () => {
    // A saved /theme must read back: the reader rejects the whole file on any key it does not know.
    expect(await run(['config', 'set', 'theme', 'light'])).toBe(0);
    expect(await run(['config', 'set', 'theme', 'pink'])).toBe(1);
    expect(errors.pop()).toBe('INVALID_CONFIG: Invalid value for theme.');
    expect(await run(['config', 'set', 'permissionMode', 'yolo'])).toBe(1);
    expect(errors.pop()).toBe('INVALID_CONFIG: Invalid value for permissionMode.');
    expect(JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'))).toEqual({ theme: 'light' });

    const file = path.join(dataDir, 'config.json');
    await writeFile(file, '{ not json');
    expect(await run(['config', 'set', 'language', 'en'])).toBe(1);
    expect(errors.pop()).toMatch(/^INVALID_CONFIG: The settings file is invalid/);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });

  it('refuses a data directory inside a Git workspace', async () => {
    const inside = path.join(path.resolve(import.meta.dirname, '..'), '.never-created');
    expect(await runCli(['--data-dir', inside, 'status'], { env, signals, output: text => lines.push(text), error: text => errors.push(text) })).toBe(1);
    expect(errors.pop()).toBe('UNSAFE_DATA_DIRECTORY: The data directory must be outside Git workspaces.');
  });

  it('passes per-run overrides to print mode and blocks a second process on the same profile', async () => {
    let release!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    let seen: unknown;
    const chat: CliDependencies['chat'] = async (request, context) => {
      seen = { request, overrides: context.overrides };
      await holding;
      return 0;
    };
    const first = run(['-c', '-p', 'hello', '--model', 'claude-x', '--permission-mode', 'plan'], { chat });
    await expect.poll(() => seen).toBeTruthy();
    expect(seen).toEqual({ request: { prompt: 'hello' }, overrides: { model: 'claude-x', permissionMode: 'plan', language: undefined, continue: true } });

    expect(await run(['login'], { login: async () => 0 })).toBe(1);
    expect(errors.pop()).toMatch(new RegExp(`^PROFILE_BUSY: .*\\(PID ${process.pid}\\)`));
    release();
    expect(await first).toBe(0);
    expect(await run(['status', '--model', 'x'])).toBe(1);
    expect(await run(['status', '-c'])).toBe(1);
  });

  it('takes over a lock whose process is gone, and releases its own lock when the terminal closes', async () => {
    const lock = path.join(dataDir, 'profile.lock');
    await writeFile(lock, '2000000000\n'); // no process has this id: left by a crash or kill -9
    const terminal = new EventEmitter();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const chat: CliDependencies['chat'] = async (_request, _context, signal) => {
      started();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return 0;
    };
    const session = runCli(['--data-dir', dataDir], { env, signals: terminal, output: text => lines.push(text), error: text => errors.push(text), chat });
    await running;
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.pid));
    terminal.emit('SIGHUP'); // terminal window closed or SSH dropped: end normally instead of being killed
    expect(await session).toBe(0);
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(terminal.listenerCount('SIGHUP') + terminal.listenerCount('SIGINT')).toBe(0);
  });

  it('keeps typed input per account and project directory, privately, without repeats', async () => {
    const mine = createHistoryStore(dataDir, 'cn:account-a');
    await mine.add('/work/a', 'first');
    await mine.add('/work/b', 'elsewhere');
    await mine.add('/work/a', 'second');
    await mine.add('/work/a', 'first'); // typed again: moves to the end
    expect(await mine.load('/work/a')).toEqual(['second', 'first']);
    expect(await createHistoryStore(dataDir, 'cn:account-b').load('/work/a')).toEqual([]);
    const [account] = await readdir(path.join(dataDir, 'accounts'));
    if (process.platform !== 'win32') expect((await stat(path.join(dataDir, 'accounts', account!, 'history.json'))).mode & 0o777).toBe(0o600);
  });

  it('keeps each task\'s transcript privately under its id, and drops transcripts of tasks no longer listed', async () => {
    const tasks = createTaskStore(dataDir, 'cn:account-a');
    const kept = '11111111-1111-4111-8111-111111111111';
    const orphan = '22222222-2222-4222-8222-222222222222';
    await tasks.appendTranscript!(kept, [{ kind: 'user', text: 'hi' }]);
    await tasks.appendTranscript!(kept, [{ kind: 'assistant', text: 'hello' }]);
    await tasks.appendTranscript!(orphan, [{ kind: 'user', text: 'never recorded' }]);
    await tasks.appendTranscript!('../escape', [{ kind: 'user', text: 'x' }]);
    expect(await tasks.readTranscript!(kept)).toEqual([{ kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'hello' }]);
    await tasks.save({ sessionId: kept, workingDir: '/work', target: 't', targetLabel: 't', agent: 'claude-code', providerId: 'p', model: 'm', title: 'hi', updatedAt: 1 });
    expect(await tasks.readTranscript!(orphan)).toEqual([]);
    const [account] = await readdir(path.join(dataDir, 'accounts'));
    const files = await readdir(path.join(dataDir, 'accounts', account!, 'transcripts'));
    expect(files).toEqual([`${kept}.jsonl`]);
    if (process.platform !== 'win32') expect((await stat(path.join(dataDir, 'accounts', account!, 'transcripts', files[0]!))).mode & 0o777).toBe(0o600);
  });
});

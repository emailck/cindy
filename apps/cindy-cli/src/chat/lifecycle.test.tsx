/**
 * 测试价值
 * - 生产入口与可观察结果：closeChatSurface + App + Ink 交互 TTY；保留 Static 历史，退出清除草稿/页脚后输出摘要，恢复 raw mode。
 * - Bug／规则依据：用户报告退出摘要与输入草稿、页脚及 shell 提示符混在一起；参考 gracefulShutdown 清理后才打印恢复提示。
 * - 现有覆盖缺口：App.test 的交互断言没有走 runChat 的退出阶段；这里验证生产生命周期与真实 Ink TTY 输出协议。
 * - 最小失败输入：保留一条 Static 历史，输入未发送草稿，原生光标停在草稿中间后退出。
 * - tier：unit（内存 TTY stream，真实 Ink renderer，无账号、网络或持久化）。
 * - 实测耗时：单文件 vitest Duration 1.63 秒（2 项，执行 172 ms；2026-11-16）。
 */
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ChatController } from './controller';
import { closeChatSurface } from './lifecycle';

describe('interactive terminal teardown', () => {
  it.each(['normal', 'without-controller-exit'] as const)('clears live UI before summary without replaying history (%s)', async reason => {
    const controller = new ChatController({ workingDir: '/project', language: 'en', permission: 'full',
      catalog: async () => ({ models: [], unavailable: [] }), openTask: vi.fn(), tasks: { list: async () => [], save: async () => {} } });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const raw: boolean[] = [];
    let output = '';
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode(mode: boolean) { raw.push(mode); }, ref() {}, unref() {} });
    stdout.on('data', chunk => { output += chunk.toString(); });
    const surface = (closing = false) => <App controller={controller} header="PRESERVED_HISTORY" closing={closing} />;
    const ui = render(surface(), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream, interactive: true, incrementalRendering: true, patchConsole: false,
      exitOnCtrlC: false, maxFps: 1000 });
    try {
      await controller.init();
      await ui.waitUntilRenderFlush();
      stdin.write('UNSENT_DRAFT');
      await ui.waitUntilRenderFlush();
      stdin.write('\u001b[D');
      await ui.waitUntilRenderFlush();
      expect(output).toContain('UNSENT_DRAFT');
      expect(output).toContain('\u001b[?25h'); // The native caret is active inside the live frame.
      const before = output.length;
      if (reason === 'normal') await controller.exit();
      await closeChatSurface(ui, surface(true), stdout as unknown as NodeJS.WriteStream);
      const cleanup = output.slice(before);
      expect(cleanup).toContain('\u001b[2K');
      expect(cleanup).toContain('\u001b[?1004l');
      expect(stripVTControlCharacters(cleanup).trim()).toBe('');
      expect(output.match(/PRESERVED_HISTORY/g)).toHaveLength(1);
      expect(output).not.toContain('\u001b[2J');
      expect(raw[0]).toBe(true);
      expect(raw.at(-1)).toBe(false);
      stdout.write('EXIT_SUMMARY\nSHELL_PROMPT> ');
      const finalOutput = output;
      stdin.write('LATE_INPUT');
      await setImmediate();
      expect(output).toBe(finalOutput);
      expect(output.endsWith('EXIT_SUMMARY\nSHELL_PROMPT> ')).toBe(true);
    } finally {
      ui.unmount(); ui.cleanup();
      stdin.destroy(); stdout.destroy();
    }
  });
});

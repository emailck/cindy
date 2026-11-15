/**
 * 测试价值
 * - 生产入口与可观察结果：desktopClosureViolations（build.mjs 用 esbuild metafile 调用）；返回的违规行决定构建失败并指出文件。
 * - Bug／规则依据：docs/cindy-cli-client-plan.md「构建门禁」：直接引用 Desktop 源码，上游合并后若引入 Electron
 *   或额外 Desktop 模块，必须在构建期失败，而不是运行时崩溃。
 * - 现有覆盖缺口：新门禁，无既有覆盖。
 * - 最小失败输入：允许名单内的 Desktop 文件新增 `electron` 导入；名单外的 Desktop 模块进入闭包。
 * - tier：unit（纯函数，表驱动）。
 */
import { describe, expect, it } from 'vitest';
import { desktopClosureViolations } from './desktop-closure.mjs';

describe('Desktop import closure guard', () => {
  it.each([
    ['allowed controller file with Node imports', { 'apps/desktop/src/main/remote-agent/controller/startRemote.ts': { imports: [{ path: 'node:os' }] } }, []],
    ['allowed file importing electron', { 'apps/desktop/src/main/remote-agent/executor/files.ts': { imports: [{ path: 'electron', external: true }] } },
      ['apps/desktop/src/main/remote-agent/executor/files.ts imports electron']],
    ['Desktop module outside the allowlist', { 'apps/desktop/src/main/device-link/index.ts': { imports: [] } },
      ['Desktop module outside the CLI allowlist: apps/desktop/src/main/device-link/index.ts']],
    ['Windows path separators', { 'apps\\desktop\\src\\main\\remote-agent\\host\\service.ts': { imports: [] } },
      ['Desktop module outside the CLI allowlist: apps/desktop/src/main/remote-agent/host/service.ts']],
  ])('%s', (_name, inputs, expected) => {
    expect(desktopClosureViolations(inputs)).toEqual(expected);
  });
});

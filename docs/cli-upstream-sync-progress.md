# CLI 官方更新同步进度（2026-11-13）

依据 [本次独立计划](cli-upstream-sync-plan.md)，不继承历史 CLI 台账。

## 重新规划时的快照

用户确认继续后，按本次独立计划恢复实现；重新规划时保留的草稿重新审查。
未操作运行实例、部署配置、镜像、已安装 CLI 或真实账号。

| 编号 | 状态 | 当前证据 / 待完成事项 |
| --- | --- | --- |
| SYNC-01 | 已完成 | 已核对生产调用链与当前 diff；按最小接口迁移生命周期，排除上游多账号、iMessage 和其它无关增量 |
| SYNC-02 | 已完成 | 原生请求15秒 / 刷新8秒；12例通过，真实内存transport虚拟时钟验证；CLI额度回归通过 |
| SYNC-03 | 已完成 | 上下文身份与消费时复核、拒绝后编号复用隔离、Claude自动开轮；Session 85例通过，单文件3.03s；maker-core类型检查通过 |
| SYNC-04 | 已完成 | 共享宿主与代理生产回归322例通过；新增proxy单文件47例、墙钟3.41s；共享宿主最终类型检查通过。Desktop类型检查按用户要求停止，未完成 |
| SYNC-05 | 已完成 | CLI manifest精确同步2.1.321，SDK保留0.3.292；默认禁遥测不变；环境/探针74例、Desktop认证额度47例通过；Linux资产校验和隔离help通过 |
| SYNC-06 | 已完成 | 按用户最终限定只验收CLI：最终105通过、5项原有跳过；CLI此前类型检查通过，未重复重型检查。Desktop类型检查未完成，不作通过声明 |

子任务汇报仅为待验收证据，不代表主 Agent 确认通过。后续先审查必要接口与 Claude 默认隐私
行为，再按新计划继续实现；保留与当前任务无关的已有内容，不整体覆盖文件。

## 继续实施

- lifecycle 负责共享宿主、Desktop 代理及生产入口回归；quota 负责额度与 Session 接口。
- claude 负责版本 manifest 和启动/探针/额度兼容核对；本轮保留现有遥测默认值，
  不将上游隐私行为变更混入版本更新，模型目录的未验证限制单独记录。
- 主 Agent 负责 CLI 集成回归、类型检查、整体 diff 审查和文档验收。

## 集成中发现与修正

- CLI 全部现有测试：`pnpm --dir apps/cindy-host exec vitest run --maxWorkers=1`，
  105 通过、5 跳过，42.03s。跳过的是依赖显式 `CINDY_CODEX_TEST_BINARY` 的原生进程用例，
  未为本轮关闭任何测试。最终跨包改动完成后按新增影响复核。
- Session 发送被拒后会回退数字 generation：已复现旧 context 随编号复用冒领新轮。
  在 WeakMap 内保留发送上下文有效性，消费排队终态时重新验证；不新增 wire 字段。
- 独立审查发现代理传入 AbortSignal 而共享 runClient 尚未实现该参数，正在补齐取消契约。
- 生产入口回归发现 Claude provider-initiated status 自动开轮判据缺失，正在补齐 Session 依赖。
- 同时类型检查导致本机内存压力，已停止本轮 maker-core/host/Desktop 类型检查和一次卫生检查，
  后续改为串行。此处停止仅针对本轮启动的验证进程，不涉及服务实例；被停止的检查不记通过。

## 当前验收证据

- `pnpm --dir packages/maker-core exec vitest run src/session.origin.test.ts --maxWorkers=1`：
  最终85通过，单文件3.03s；新增身份回归先红后绿。新用例未加入真实长等待。
- Desktop `groupRelay.test.ts`、`roundtrip.test.ts`、`proxyHandleClose.test.ts` 串行合跑：
  322通过（197/78/47），墙钟109.60s，收集86.30s。此前一次内存压力造成roundtrip收集超时，
  已在减少并发后完整通过，没有放宽timeout。proxy发现的真实失败由Session缺失自动开轮依赖修复。
- 新proxy文件单独47通过，墙钟3.41s、Vitest2.35s；fixture映射包导出到真实生产模块，
  避免初始化无关harness，使用1ms断言轮询；没有替换生命周期实现或重载模块。
- maker-core环境/模型探针74通过（1.98s）；Desktop Claude认证/额度/OAuth环境47通过
  （11.68s，其中既有大依赖收集10.32s）；CLI quota9通过（4.67s）。
- Claude Linux x64 2.1.321在临时空目录/隔离HOME验证资产大小、SHA256、版本和help参数，
  31.65s；资产已清理。没有进行真实登录、SDK模型调用或替换现有CLI。
- `pnpm --dir packages/maker-core exec tsc --noEmit`、`pnpm --dir apps/cindy-host typecheck`：通过。
- `pnpm check:test-hygiene`：PASS，356文件符合基线；`pnpm check:dev-docs`：10通过。
- 独立只读审查发现的callWithId参数遗漏已补，复核未确认新的P0/P1；本地取消只阻止尚未发出的
  部分，不撤回已发请求。`git diff --check`通过。

## 交付限制

本轮保留默认禁遥测，尚不能证明Claude feature flags中的新模型会全部出现在目录中。
只核验新CLI参数和现有适配契约，未实测SDK 0.3.292与新CLI的真实认证/推理配对。
macOS/Windows资产仅核对manifest；真实新旧双端、分享撤销、断线恢复仍待另行验收。
没有提交、部署、重启、替换镜像或修改当前运行实例。

## 用户最终约束与 CLI 最终验收

用户要求不运行 Desktop，随后明确只检查 CLI。已终止本轮 Desktop 类型检查，未启动过
Desktop 应用；后续没有执行 Desktop 或整仓检查，也没有操作任何运行实例。
本轮已完成的其它回归仅保留历史结果，不作为最终全端交付承诺。

最终仅在 apps/cindy-host 执行 Vitest：单 worker、文件串行、低CPU优先级、每个Node堆384MiB。
监控本轮进程组RSS：超过1GiB、系统可用内存低于768MiB或超过120秒即停止本轮检查。
实际105通过、5项原有原生二进制条件跳过，6文件全通过；墙钟10.71s，进程组峰值668MiB。
资源保护未触发。CLI类型检查沿用本轮最终生产改动后的通过结果，不再重复启动。
当前源码未提交、未部署。Desktop完整类型检查仍未完成。

## 后续明确授权后的实例替换

用户随后明确授权重建并替换当前 Claude CLI 实例，保留原虚拟机、凭证、配置与代理。
此前“不部署”的约束仅在该实例替换范围内被新授权覆盖；不运行 Desktop、不影响其它实例仍适用。

采用已有运行镜像作依赖基底，受限内存构建当前 CLI bundle，仅替换 bundle 和经大小/SHA256
核验的 Claude 2.1.321二进制。未重装全仓依赖；离线容器（无网络、384MiB内存）验证 CLI/Claude
版本及三个native依赖加载成功。构建过程已有image-resizer direct-eval警告，构建退出0。

旧实例正常SIGTERM退出，没有强杀；保留旧容器及旧镜像可回滚。新实例启动前逐项比较原数据卷、
完整环境（含代理）、主机标识一致，凭证未复制或输出。管理端所需原容器名与image tag继续有效。
新实例完成模型发现和relay握手；原生Claude auth status仍为loggedIn/claude.ai/Pro，
分享清单读取成功且原成员active；沿用代理的原生额度查询返回ready、两个窗口。
未发送模型消息，不把这些结果称为已完成外部客户端端到端生成验收。

部署标识与回滚容器名称只保存在仓库外本次部署记录，临时构建二进制副本已清理。
代码仍未提交；Desktop类型检查仍未完成。

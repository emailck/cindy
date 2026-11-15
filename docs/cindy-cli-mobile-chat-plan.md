# 手机直连 CLI 提供端：同账号纯对话

状态：P0 核实完成（代码证据），待用户确认后进入 P1。沿用 [CLI 工作约定](cindy-cli-working-agreement.md)；
CLI 第一阶段见 [CLI 计划](cindy-cli-plan.md)。

## 目标与非目标

手机在没有电脑在线时，直接用同账号 CLI 提供端（`apps/cindy-host`）上的 Claude Code 对话。

- 范围：**同账号**、**纯对话**（每轮 `toolsDisabled`，不读写文件、不执行命令）、**只做 Claude**。
- 非目标：跨账号分享给手机、工具执行、Codex / Pi、修改 Server、修改 system prompt、改变现有
  「手机经电脑使用分享供应商」的路径。

## P0 核实结果（2026-11-13，代码证据，未做线上实测）

| # | 问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 同账号手机能否通过 CLI 准入 | 能。非 scoped peer 按 owner 放行，不看对端平台 | `apps/cindy-host/src/runtime/index.ts` `authorized`、`controllerTrust` |
| 2 | 手机能否打开链路并调用远程 Agent 通道 | 能。CLI 接受 `link-open`（协议版本一致即可），`maker:remote-agent:v1` 在 CLI 通道表与共享 allowlist 中 | 同上 `link-open` 分支；`packages/device-link/src/allowlist.ts` |
| 3 | 中转是否需要改 Server | 同账号预计不需要：与手机调用电脑相同的同账号路由 | 推断，P4 线上实测确认 |
| 4 | 纯对话开关是否已在协议里 | 已有。`toolsDisabled` 经 `decodeSendOptions` 原样传到会话 | `packages/remote-agent-host/src/wire.ts:699,811` |
| 5 | Claude 是否真的不执行工具 | 是。每次 PreToolUse 由 hook 拒绝（`denyTextOnlyTool`）；仅在 `remoteHostId`（SSH）下拒绝该选项，CLI 本机运行不受影响 | `packages/maker-core/src/agents/claude-code/index.ts:2056,6461` |
| 6 | 开任务是否必须有真实工作区 | 不必。`virtualWorkspace: true` + 空 `projectFiles` / `ancestorFiles` 即可，影子目录由 CLI 建 | `runHost.ts` `open`（约 3420 行起）、`RemoteAgentOpenPayload` |
| 7 | 手机控制端能否直接复用现有实现 | 协议解析在 `packages/device-link`（零 Node 依赖）可复用；`controller/runClient.ts` 依赖 `node:zlib`，需拆出平台无关部分；open 载荷可用内联 `{ json }`，不必 gzip | `runClient.ts:12-13`；`runHost.ts` `resolvePayload` |

### P0 发现的两个必须处理的点

1. **设备托管模式启动时一定会反向请求控制端。** Claude 在设备托管下始终挂 `cindy_exec` MCP（经隧道回到控制端），
   SDK 启动就会发 MCP `initialize` / `tools/list` 反向请求（`claude-code/index.ts:1926`、`host/tunnel.ts`）。
   手机必须应答这些反向请求，否则启动卡在 MCP 超时。方案二选一（P1 定）：
   - A（倾向）：手机控制端对 `cindy_exec` 握手回空工具列表，对其他反向请求统一回错误。不改 CLI、不改 wire。
   - B：CLI 增加纯对话启动方式，不挂隧道 MCP。要新增能力声明，属于协议增量。
2. **现在的手机会把 CLI 当成普通电脑。** CLI 广播 `remoteControlEnabled: true`、平台 `linux`，本分支手机侧
   `isControllableDevice` 只排除手机平台，所以 CLI 会出现在「可控制电脑」里，打开后调用桌面通道得到
   `CHANNEL_NOT_ALLOWED`（代码推断，需真机确认）。设备列表（`DeviceView`）不带能力字段，手机只能在建链后从
   `link-accept.capabilities` 识别。计划：CLI 在 `link-accept` 追加 `cli-chat-v1` 能力（append-only，旧手机忽略），
   手机据此把它归为「CLI 对话」入口，不进电脑任务列表。

## 阶段

| 编号 | 内容 | 范围 | 验收 |
| --- | --- | --- | --- |
| MC-001 | P0 核实（本文） | 只读 | 已完成：上表证据 |
| MC-002 | CLI：`link-accept` 声明 `cli-chat-v1`；确认纯对话 open 与反向请求行为 | `apps/cindy-host/src/runtime/` | 集成测试走真实 `createCliHost` 入口：工具调用被拒、无反向执行、停止 / 重连 / 重启续上 |
| MC-003 | 公共：从 `runClient` / `poller` 拆出平台无关控制端（open / send / poll / stop / close / 反向请求应答） | `packages/remote-agent-host` | Desktop 原行为测试不变 |
| MC-004 | 手机：纯对话控制端 + 识别 `cli-chat-v1` 设备 | `apps/mobile/src/device-link/` | 单测；不改原生配置（不触发冷更） |
| MC-005 | 手机：Chat 入口、模型选择、消息列表、离线 / 停用提示 | `apps/mobile/app/`、`src/chat/` | Light / Dark 实现；i18n 与术语表门禁 |
| MC-006 | 真机端到端与文档回写 | 文档 | 真实账号手机 ↔ CLI 对话；未验证项如实登记 |

## 风险与待确认

- 协议：只新增 `cli-chat-v1` 一个 append-only 能力；其余用现有字段。按 `docs/dev-rules/protocol-compatibility.md`
  做新旧两端测试；自建中转不涉及新帧类型，仍需互通验证。
- 会话归属：历史在 CLI 的 Claude 原生会话里，手机只做本地缓存；手机换机 / 重装后的恢复方式在 MC-004 定。
- Claude 在被拒工具时可能多绕几步：靠 hook 硬拒保证不执行，体验问题在 MC-006 观察。
- 产品规则：同账号纯对话不触及 `provider-sharing.md`（那是跨账号）；如后续扩展到跨账号需先改该文 §3。

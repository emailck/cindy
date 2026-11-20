# Cindy CLI 使用端实施计划

状态：用户已确认（2026-11-15），CC-002～CC-006 本地实现完成，CC-007 真实账号验收待用户环境。协作沿用 [CLI 工作约定](cindy-cli-working-agreement.md)，
执行记录见 [进度](cindy-cli-client-progress.md)。提供端（`apps/cindy-host`）见 [CLI 提供端计划](cindy-cli-plan.md)。

## 目标与非目标

做一个像 Claude Code 一样在终端里交互使用的 Cindy 客户端：在当前目录下与**远端的 Agent** 对话，
远端 Agent 读写文件、执行命令时回到本机执行。主要目标是使用**其他账号分享来的供应商**，
同账号的远程供应商同样可用。

- 独立程序，与提供端 `cindy-host` 分开：独立入口 `cindy`、独立进程、独立数据目录与设备身份。
  一台机器通常只运行其中一种；技术上两者可以并存，互不抢锁。
- 已裁决（2026-11-15）：终端界面用 ink；命令为 `cindy`（交互，等同 `cindy chat`）、
  `cindy received join|list|leave`、`cindy login|logout|status`。
- 已裁决（2026-11-15）：默认权限档 full（未指定时等同 Desktop「完全访问」）；界面中英文切换
  （跟随系统语言，可用 `/lang` 或配置覆盖）；交互界面提供与 Claude Code 类似的斜杠命令，
  首要是选择模型，其余一并提供（见下文「斜杠命令」）。
- 本仓是个人 fork，上游不合并 CLI 代码，CLI 代码由本 fork 自行维护。因此：
  **不修改 Desktop、Mobile、Server 与跨端 wire**；Desktop 中不依赖 Electron 的控制端代码**直接引用源码**，
  不复制，使 `git merge upstream/main` 后上游修复自动生效。
- 非目标（首版）：本机运行 Agent；远端 Codex（需要本机 codex 与 exec-server 转发）；跨区域分享；
  本机 Cindy 工具（helper、记忆、定时任务、浏览器、插件）、托管 Skill、每轮改动对比、图片附件、
  fork、供应商组切换；手机端；分享者侧功能（仍由 `cindy-host share` 负责）。
  这些能力缺失时界面与文档如实说明，不在握手中虚报。

## 现状证据

- 2026-11-15 实测：esbuild 直接打包 Desktop `controller/startRemote.ts`、`executor/executor.ts`、
  `executor/gate.ts` 成功；闭包含 24 个 Desktop 文件、无 `electron` 导入，第三方依赖只有
  `@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk`、`diff`、`gray-matter`、`ipaddr.js`、`undici`。
- `startRemoteAgentSession(…, deps: StartRemoteAgentDeps)` 返回 maker-core `AgentSessionHandle`；
  依赖（invoke、poller、pool、rgPath、prepareMcp、collectProjectFiles、webFetch、credentialConsent 等）
  均为注入。权限档与凭证确认在 `executor/gate.ts`、`executor/credentialGrants.ts`。
- 需要自写的 Electron 绑定部分：`apps/desktop/src/main/device-link/index.ts` 的
  `openRemoteLink` / `remoteInvoke`（上线等待、关闭代次、`LINK_NOT_OPEN` 重开、无响应熔断）。
- 控制端握手能力 `CONTROLLER_CAPABILITIES`（同文件约 549 行）无法引用，需手工保持一致。
  其中 `PROVIDER_SHARE_RELAY_CAPABILITY`：分享者只接受声明它的控制端。Desktop 对没有订阅的
  设备经 `linkOpenCapabilities` 追加 `DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1`（对端不进入受控状态）。
  远程 Agent 走 `maker:remote-agent:v1` 轮询，不订阅 `maker:event` 推送，所以 CLI 只声明
  分享能力与后台链路；微批能力只影响订阅推送，CLI 不订阅、不声明，也不会让被控端为它保留逐帧流。
- 被控端（`packages/remote-agent-host`、Desktop dispatch）不按 `appVersion` 区分控制端，只按能力声明。
- 受邀者侧 `providerShareGuest.ts` 闭包达 2357 个 Desktop 文件（含 Electron），不能引用；
  协议部分已在 `@cindy/device-link`：`createProviderShareApi`、`parseProviderShareLink`、
  `parseProviderShareInvitationIntent`、`providerShareHostPeer`、`ProviderShareReceived` 等。
- 登录可复用 `apps/cindy-host/src/auth`（`createHostAuthService`、`runAuthCommand`）与
  `src/storage`（keyring 受保护存储），这些是本 fork 自有代码，CLI 直接引用，不复制。

## 架构

```
apps/cindy-cli (bin: cindy)
├─ 登录/存储/配置      → 引用 apps/cindy-host/src/{auth,storage}
├─ link/               自写：DeviceLinkClient 连接、presence、出站 openLink/invoke、恢复语义
├─ session/            自写接线：StartRemoteAgentDeps 实现 → 引用 Desktop startRemoteAgentSession
├─ share-guest/        自写薄层：基于 @cindy/device-link 的预览/申请/名单/退出/目标解析
├─ store/              自写：本地任务记录（远端会话 id、设备、供应商、模型、目录）
└─ tui/                自写：ink 界面
       ↓ 直接引用（不修改）
apps/desktop/src/main/remote-agent/{controller,executor}/**（Electron 无关闭包）
```

- 本端 presence 声明 `remoteControlEnabled: false`、不声明分享能力，不会被其他设备当成可控制的电脑。
- 数据目录默认放在用户目录下的 CLI 专属位置（必须在 Git 工作区外，可用参数或环境变量覆盖），
  keyring 使用与 `cindy-host` 不同的命名空间；需与提供端分别登录一次。
- 执行权限：沿用 Desktop 控制端的权限档（full / plan / normal）与确认语义；默认 full（用户裁决）。受邀者任务的凭证类操作按 `provider-sharing.md` §9 第 7 条，不论档位都要本机确认，
  提供「允许一次 / 本任务总是允许 / 拒绝」；「信任分享者」开关列入后续。
- 交互确认：远端 Agent 的确认与本机执行器发起的确认（凭证等）都经 `AgentSessionHandle.setInteractionResolver`
  同一通道（`permission` / `ask_user_question` / `plan_review`），TUI 实现这一个 resolver；中断或关闭时按
  `dismissed` 语义回答，不伪造用户选择。
- 构建门禁：CLI 构建时检查 Desktop 引用闭包，一旦出现 `electron` 或不在白名单内的 Desktop 目录即失败，
  并输出首个违规文件，用于上游合并后的快速定位。

## 斜杠命令（CC-005）

只提供远端会话句柄真实支持的操作；对方不支持（`methods` 中没有）时提示不可用，不假装成功。

| 命令 | 作用 | 依据 |
| --- | --- | --- |
| `/help`（或空输入框按 `?`） | 操作说明：按「命令 / 输入与发送 / 任务运行中 / 回答 Agent / 其他」分组列出命令与按键，键位列对齐 | — |
| `/model [id]` | 两步选择：先选供应商（同账号电脑与分享来的供应商；显示模型数与当前项，同名分享加「(2)」，连不上的来源置灰不可选），再选该供应商的模型（Esc 返回上一步，超过 10 项滚动显示）；只有一个供应商时直接进入第二步；带参数时按模型 id 或名称直接选择 | `maker:provider:list`、`handle.setModel`；同一电脑内热切换，换到另一台电脑时开始新任务 |
| `/effort [level]` | 推理档位 | `handle.setEffort`、模型 `efforts` |
| `/permissions [mode]` | 权限档（full / normal / plan） | `handle.setPermissionMode`、`setPlanMode` |
| `/plan` | 切换计划模式 | `handle.setPlanMode` |
| `/compact [说明]` | 压缩上下文 | `handle.compactSession`（对方支持时） |
| `/clear` | 关闭当前任务、开新任务 | `handle.close` |
| `/resume` | 列出本目录的历史任务并接回 | 本地任务记录 + 远端会话 id |
| `/status` | 账号、设备、供应商、模型、权限档、连接状态 | 本地状态 |
| `/cost` `/context` | 本任务用量与上下文占用 | `getUsageSnapshot`、`getContextUsage` |
| `/lang [zh\|en]` | 切换界面语言 | 本地配置 |
| `/theme [auto\|dark\|light\|ansi]` | 终端配色：自动（按终端背景）、深色、浅色、终端自带 16 色 | 本地配置 |
| `/exit` `/quit` | 退出（关闭链路与任务） | — |

快捷键：Enter 发送，运行中为排队（回合结束后逐条发送）；Ctrl+S 插话（`handle.steer`，不打断）；空输入框 ↑ 取回排队消息；
Esc 打断（`handle.abort`，队列暂停，空输入框 Enter 继续）；Shift+Tab 循环权限档；行尾 `\` 或 Ctrl+J 换行；↑/↓ 历史（多行输入先在行间移动）；
命令列表 ↑/↓ 选择、Enter 执行选中项；Alt/Ctrl+←→ 按词移动、Ctrl+W 删词、Ctrl+K 删到行尾、Delete 向后删；Ctrl+C 两次退出。
提问支持数字键与多选（空格勾选）；计划确认可直接输入修改意见。
非交互：`cindy -p "提示"` 输出最终回答后退出，`--model`、`--permission-mode` 可覆盖默认。
`cindy -c`（`--continue`）接着当前目录最近一次的任务，可与 `-p` 合用；只有原来的电脑、供应商与模型仍可用时才接回，
否则提示并保持当前任务不变（原生会话 id 只属于创建它的那条路由）。项目目录即启动目录；默认 full，不做目录信任确认（用户裁决 2026-11-15）。

## 任务与验收

| 编号 | 内容与修改范围 | 依赖 | 验收 |
| --- | --- | --- | --- |
| CC-001 | 本计划与进度台账 | 无 | 范围、证据、风险可执行；用户确认 |
| CC-002 | `apps/cindy-cli` 骨架：package、esbuild 构建、`cindy` 入口、数据目录、进程锁、`login/logout/status`（引用 cindy-host auth）、Desktop 闭包门禁 | 001 | 无 Electron 构建通过；help/version/status 可运行；门禁对注入的 electron 导入报错；秘密不进参数、日志 |
| CC-003 | `link/`：连接 relay、presence、设备与供应商列表（`maker:provider:list`、`maker:get-capabilities`）、出站 `openLink`（分享能力 + 后台链路）、`invoke` 恢复语义 | 002 | 通过真实 `DeviceLinkClient` + 模拟 relay：上线等待、重开、主动关闭后不自动重连、无响应快速失败；两个 peer 其一静默时另一个零感知（故障半径三问） |
| CC-004 | `session/` + `store/`：实现 `StartRemoteAgentDeps`，得到 `AgentSessionHandle`；项目说明同步、ripgrep、本地任务记录与续接 | 003 | 对接真实 `createRemoteAgentHost`（引用现有 cindy-host runtime 集成测试方式）：开任务、流式、工具回到本机执行、停止、续接 |
| CC-005 | `tui/`：ink 交互界面；流式输出、工具调用展示、权限确认、回答 Agent 提问、Esc 打断、`/model` `/resume` `/clear` `/exit`、`-p` 非交互 | 004 | 组件测试覆盖确认与提问的真实回调；终端浅/深背景可读（深色、浅色两套 Desktop 语义色 + 终端 16 色兜底，见进度「呈现与配色」）；未验证终端如实登记 |
| CC-006 | `share-guest/` 与 `cindy received join|list|leave`：预览信息完整展示、确认后申请、配对码、等待/撤回、名单刷新（暂停/移除）、退出；任务目标解析与凭证确认 | 003（使用依赖 004） | 假 REST + 真实 scoped 帧：批准前拒绝、批准后可用、暂停/移除后拒绝且迟到结果不恢复授权、换账号后迟到结果失效；凭证类操作在 full 档下仍要确认 |
| CC-007 | 集成验收 | 004–006 | 同账号：本机 CLI → 自己的 cindy-host（Claude）；跨账号：另一账号经分享使用同一 cindy-host。真实账号由用户操作，未验证项登记 |
| CC-008 | 文档与同步清单：CLI README、`repo-map.md`、`provider-sharing.md` 补充 CLI 受邀者端、上游合并检查清单 | 007 | `pnpm check:dev-docs` 通过；合并清单可执行 |

CC-005 与 CC-006 在 CC-004 的接口确定后可并行，文件范围互不重叠。

## 上游合并检查清单（每次 merge upstream/main 后）

1. CLI typecheck 与构建（含 Desktop 闭包门禁）通过；失败先看被引用模块的接口或依赖变化。
2. 对比上游 `CONTROLLER_CAPABILITIES` 与 CLI 声明；新增能力先判断 CLI 是否实现，未实现不声明。
3. 对比上游 `device-link/index.ts` 的 `remoteInvoke` / `openRemoteLink`、`providerShareGuest.ts`、
   `remote-agent/controller/deviceCatalog.ts`（模型目录投影）与 `controller/service.ts`（会话依赖接线）的行为改动，
   按需同步到 CLI 的 `link.ts`、`shares.ts`、`catalog.ts`、`session.ts`。
4. 跑 CLI 定向测试（unit + `src/remote.integration.test.ts`）；涉及恢复路径的改动复核故障半径。

## 实施偏差记录（2026-11-15）

- `deviceCatalog.ts`、`providerShareGuest.ts` 会经懒加载引入 Electron 的 device-link 模块，不能直接引用；分别以
  `catalog.ts`、`shares.ts` 按同一投影/流程重写，列入合并检查清单。`device-link/linkRecovery.ts` 为纯函数，加入引用名单。
- 未移植 Desktop 的设备无响应熔断：它用 `sessions:list` 探测，提供端（如 cindy-host）不开放该通道。CLI 沿用
  `invokePolicy` 的请求超时与远程 Agent 轮询自身的放弃时限；恢复动作只作用于单个对端链路。
- 分享来的供应商一律经分享者电脑运行，不做分享组直连执行分配（Desktop 在直连不可用时同样回落到这条路径）。
- 登录交互文案来自 cindy-host 的共享认证命令，仍为英文；其余界面文案中英双语。
- Agent 提问为多选时，首版按单选回答。
- 构建输出为 ESM（ink 依赖顶层 await）；ink 的 DevTools 模块在构建期替换为空模块。

## 风险与待确认

- 上游修改被引用模块的接口：编译期暴露，按清单适配。上游在闭包中引入 Electron：门禁拦截，需在 CLI 侧替换。
- 手工同步点（能力声明、出站恢复、受邀者流程）是长期维护成本，清单化处理，不宣称自动跟进。
- 安全：权限门禁与凭证确认原样引用，不弱化；CLI 只负责把确认呈现给用户并回传真实选择，不伪造批准。
- 产品规则：`provider-sharing.md` §4.1 第 3 步的申请前告知、§6.1 配对码、§9 第 7 条凭证确认在终端中等价呈现；
  §3「只能在电脑上申请和使用」CLI 属电脑端，不冲突。文档在 CC-008 补充。
- 文案语言：中英文切换（用户裁决）；产品术语按 `i18n/GLOSSARY.md`，「任务 / 对话 / 消息」按
  `task-and-conversation-naming.md`。
- 恢复路径改动按 `remote-and-mobile-adaptation.md` 故障半径三问验证，不扩大到整条 relay。
- 真实账号、两机互通和目标操作系统 keyring 需要用户环境，自动化不能替代。

## TUI 体验升级（2026-11-16，用户批准实施）

目标：以参考实现的字符测量、独立输入模型、紧凑呈现及按键作用域为依据，在现有 Ink 7 上升级。
保留现有任务、权限、排队、插话、存储与跨端协议；不整体引入参考项目的自维护渲染器。
现状入口：`chat/App.tsx`、`width.ts`、`markdown.ts`、`controller.ts`；已有 App/controller 测试为基线。
字符按 UTF-16 单位删除、固定预留 14 行与按行 Markdown 是此次要解决的具体缺口。

| 编号 | 内容 / 文件责任范围 | 依赖 | 验收 |
| --- | --- | --- | --- |
| TUI-0 | 主 Agent：规划、进度与集成基线 | 无 | 已有行为测试可复现，用户文件保留 |
| TUI-1 | 字符与输入：width、input 模型 | 0 | 中文、组合字符、emoji 不拆坏；视觉行移动；原文保留；占位符完整编辑 |
| TUI-2 | Markdown 与流式块：markdown、controller 流提交 | 0、1 的宽度接口 | 表格换行/窄屏键值呈现；跨片段列表/代码稳定；完整正文可达 |
| TUI-3 | 命令定义：commands；随后接入 controller | 0 | 帮助/补全同源；参数提示；原有执行语义不变 |
| TUI-4 | App 集成：input、动态高度、选择器搜索、按键作用域、轻分隔线 | 1–3 | 输入与选择项可见；候选滚动；模型/任务搜索；草稿和队列不丢 |
| TUI-5 | 主 Agent：类型、构建、定向测试、终端证据及 README | 4 | Light/Dark/ANSI、不同尺寸和流式回归；未实测平台明确登记 |

架构：ChatController 继续持有任务事实；字符测量作为公共纯函数，input 持有编辑与视觉映射，
commands 定义命令元数据，App 只处理布局与各交互上下文接线。
实现按文件责任隔离；App 和 controller 集成串行，避免覆盖。
风险：终端字形宽度存在差异，需能力降级；历史 Static 输出无法随主题重绘，保留既有语义；
本机凭证确认不能接收自由文本，面板搜索仅限 picker；原生光标接口先核验当前 Ink。
测试走真实 App/Controller 入口，复用已有文件；PTY 不使用账号或真实远端。
Windows/macOS、中文输入法和 SSH/tmux 无可用实机时登记待验证，不冒称完成。

### TUI 回归修复（2026-11-16）

- TUI-6：焦点进出序列 ESC[I / ESC[O 在 Ink 输入边界识别为终端事件，不能进入编辑文本；真实 App 回归覆盖分片、混合输入与字面/粘贴内容保留。以受维护的依赖补丁交付并重构建。
- TUI-7：退出时由单一生命周期入口清理活动帧和原生光标，再打印统计；保留已提交终端历史。正常退出、初始化失败均恢复终端；新增真实TTY退出回归。用户另行选择退出清屏行为时按新裁决实施。

## 分享信任持久化（2026-11-16，用户授权）

目标：接入Desktop已有的按分享信任语义，CLI重启仍有效；默认不信任，仅保存显式开启项。
边界：账号+本机数据目录+区域+shareId隔离；不修改Desktop、Server、wire或启动凭证排除。
实现：本机受保护偏好store；GuestShares校验官方名单后开关/展示，成功退分享或权威名单移除时清理；
已有credentialConsent.skip闭包每次操作读取当前状态，同账号供应商行为不变。
入口：`cindy received trust <memberId> on|off`，列表显示信任状态；TUI `/trust [on|off]`管理当前分享，支持运行中更改。

| 编号 | 内容与责任范围 | 验收 |
| --- | --- | --- |
| TRUST-1 | store与shares：账户隔离/原子落盘/权威名单清理 | 重启保持；离线不误清；退分享和移除清理；账号失效迟到结果无授权 |
| TRUST-2 | received命令、i18n、CLI帮助 | 精确memberId、on/off校验、状态可见；错误不假成功 |
| TRUST-3 | runtime/session、TUI命令接线 | skip实时生效，full不再额外确认；其他分享/普通权限/启动凭证排除不变 |
| TRUST-4 | 主Agent：集成测试/类型/构建/文档 | 新开/续接/开启/关闭可验证，产物重构建 |

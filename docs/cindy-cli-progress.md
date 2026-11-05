# Cindy CLI 提供端开发进度

依据 [实施计划](cindy-cli-plan.md) 与 [工作约定](cindy-cli-working-agreement.md)。

## 当前批次

2026-11-04：用户已授权实现。主 Agent 负责规划与集成，具体实现由子 Agent 承担。主模型沿用当前会话已获用户明确同意；子 Agent 按本地技能约定配置。沿用当前工作区，分支为 feature/cli-provider-host；没有提交或推送授权。

| 编号 | 状态 | 责任范围/负责人 | 改动与验证 | 下一步/阻塞 |
| --- | --- | --- | --- | --- |
| CLI-001 | 已完成 | 主 Agent；cli_contract | 公共包 @cindy/remote-agent-host、auth/store 端口和 CLI runtime 接口已定稿 | 实现中按证据调整 |
| CLI-002 | 已完成 | cli_entry；主 Agent 复验 | app 类型、构建、真实 help/version 通过；CLI 18 项通过，单文件 2.42 秒 | 实机使用见 CLI-007 |
| CLI-003 | 待验收 | cli_auth：auth；cli_storage：storage | Auth 22 项通过；storage 11 项通过；无明文回退 | 真实账号与目标 OS 凭证库待实测 |
| CLI-004 | 已完成 | cli_contract；主 Agent 集成检查 | 16 个迁移模块仅依赖导入变化；包类型通过；Desktop 19 文件 517 通过、1 项软链能力跳过 | 完整 Desktop 类型检查仍在整体验证中 |
| CLI-005 | 待验收 | cli_runtime：runtime 目录 | 模拟 relay 的真实 DeviceLink/宿主集成通过 | 官方账号设备发现待实测 |
| CLI-006 | 待验收 | cli_runtime；主 Agent/cli_contract 验证 | runtime 5 项通过；真实 Claude CLI 离线敏感读取/70秒确认通过 | 真实两机与模型供应商仍待验收 |
| CLI-007 | 待验收 | 主 Agent 集成、子 Agent 修复 | Desktop 类型、回归、CLI unit/integration、真实 CLI 离线测试均通过 | 线上身份、两机与 Linux 实测缺环境 |
| CLI-008 | 待验收 | cli_entry 文档/构建，主 Agent 验收 | README/地图、构建、Node22.22实际 help/version 已验证 | 第一阶段完整交付等待线上实测，未提交/推送 |

## 环境与风险

工作区没有 node_modules；现有全局 pnpm 为 11，不符合仓库 >=10.7 <11；Node 为 22.18.0。准备使用仓库 pin 的 pnpm 10.33.2，不修改全局工具。依赖未安装前不宣称类型检查或业务测试通过。

工作约定文档为前轮未提交成果，保留。现有认证协议不修改；最高执行权限不绕过设备身份和供应商准入。

## 验收记录

本批次尚无代码验收结果。

## 环境记录追加

已使用隔离 pnpm 10.33.2；首次安装发现已锁定 pi-ai 需要 Node >=22.19，当前 Node 22.18 不满足。改用隔离 Node 22.22.0 + pnpm 10.33.2 安装；新 workspace 需要更新 lockfile，正在执行正常 install --no-frozen-lockfile，未跳过脚本。

## 第一轮检查

Node 22.22.0/pnpm 10.33.2 正常安装完成，追加新 app 依赖后第二次安装通过。仓库现有 build script allowlist 跳过部分依赖脚本，未修改白名单。

存储隔离测试 11 项通过（未访问真实凭证），CLI 测试初批通过；测试 runner 契约 108 项通过。文档检查 10 项通过。其他类型检查与回归仍在进行，不计为通过。

独立审查发现并交回修复：临时认证故障不应永久退出、relay 拒绝未过期 JWT 时需强制刷新、native CLI 认证预检须清理冲突环境、启动/登录中断必须释放 profile 锁。稳定账号存储 scope 与本次登录代次已分离，避免历史目录随刷新变化。

check:test-hygiene 因新 origin/main 尚未获取而不能运行；SSH fetch 被远端关闭，正尝试只读 HTTPS 获取基线，不改 remote 地址。

## 公共宿主验收

- Desktop 定向回归：19 文件，517 passed / 1 skipped，764.76 秒；跳过是既有 Windows 文件软链能力探测。未改断言或超时。
- 新包 remote-agent-host 类型检查通过；maker-shared --lib ES2023 通过，但默认 ES2022 配置在未改动 botGroupProcess.ts:95 的 findLastIndex 上报既有错误，未改原配置。
- 最终测试运行器契约 90 项通过，27.91 秒；普通 CLI 单测与真实隧道 integration 分层。
- HTTPS 只读获取 origin/main 成功；test-hygiene 通过。
- CLI 构建与实际 help 运行通过；后续认证取消/刷新退避修复后须再构建，不把前一次结果当最终。
- 真实官方账号登录、真实 Claude 请求和 Linux 系统凭证库尚未验证。

## 最终集成检查进展

- 完整 Desktop typecheck 退出 0（隔离 Node 22.22.0 + pnpm 10.33.2）。
- Auth 最新 22 项通过，1.57 秒；包括退避、合并刷新、服务器冷却、待保存轮换结果恢复与退出 drain。
- CLI runtime 单 worker 5 项通过（真实共享宿主 + 本地 HTTP 隧道，模拟 relay/engine），最新已运行批次 22.23 秒，断言 409ms；后续模型 ID 共用归一化需最终复验。
- Desktop 模型发现归一化回归 39 项通过，5.99 秒。
- 文档检查最终 10 项通过；真实 Claude 二进制离线 fixture 正在执行，使用临时身份目录与本地假模型，不使用用户真实凭证。

## 必须保留的失败与未验证项

真实 Claude 离线用例 claudeHosted.e2e.test.ts 的 keeps a credential confirmation alive 失败：预期 asked 长度 1，实际 0；固定 Claude 二进制已启动，但没有进入预期确认流程。不能归为通过，也不能在缺乏基线证据时称为既有问题。正在只读诊断 fixture/事件。

线上端到端需要用户自行完成官方 Cindy 与 Claude 认证，当前未读取用户凭证或使用真实模型额度。Linux 系统凭证库、真实两机发现与重连、强制进程终止后的恢复未验收。

## 离线 E2E 诊断结果

已做隔离 HEAD 子图对照（恢复本次改动的 28 个 Desktop 生产 TS 模块，其余依赖与固定 CLI 共用）：当前和对照均 asked=0。真实请求都只有 ToolSearch/DeferredToolPlaceholder 等，没有 mcp__cindy_exec__；既有 fake endpoint 因检测不到 eager 工具直接回 ok，没有发起敏感文件读取。因此确认为固定 CLI 的延迟工具发现与既有 fixture 不匹配。只对 fixture 设置 ENABLE_TOOL_SEARCH=false，保留原断言和70秒确认等待，生产工具策略不改；重跑待结果。

CLI 最新 app 类型、构建、实际 help/version 通过；unit 51 项通过，4.60秒（首次该批使用系统 Node22.18，随后使用隔离22.22正式复验）。

## CLI 最终产物验证

使用隔离 Node 22.22.0：构建通过（4.61s），实际 help/version 退出0（0.1.0）；51项/3文件单 worker 全通过，6.69s。主 Agent 额外单独验证 CLI 文件18项通过，2.42s，满足单文件预算。Auth22项单独1.57s，Storage11项单独3.63s。

model-providers 类型检查通过；最终 diff --check 通过。构建仅有既有 image-resizer.ts direct eval 提示；未新增忽略或弱化门禁。当前 Node最低要求22.19，环境全局未修改。

## 本轮收尾（当前结论）

代码第一版已实现，不能将整个第一阶段标为全部完成：真实官方身份、目标 Linux 与两台机器的验收条件尚未提供。

- 真实 CLI 离线用例最终通过：固定 Claude 2.1.312 → SDK → 共享 host → 反向 MCP → 控制端敏感文件读取；保留原70秒等待，确认后连续读取成功。选中1通过，其余7为过滤或既有平台跳过；总264.53s，选中测试体77.81s。
- fixture 的 ENABLE_TOOL_SEARCH=false 只固定本地假模型所依赖的即时工具暴露方式，没有改变生产工具策略、断言或超时。修改前子图的同样失败证据已保留在上文；此前“正在定位”是历史记录，本项现已解决。
- 最终 CLI 51项unit、5项runtime integration通过；Desktop定向517通过/1能力跳过、模型发现39通过；Desktop/app/remote-agent-host/model-providers类型通过。
- maker-shared默认类型配置的既有ES2022/findLastIndex错误仍存在；指定ES2023时通过，未修改该历史配置。
- 构建及Node22.22上的实际help/version通过；未访问真实账号、未运行实际OS凭证库doctor、未发送真实模型请求。

### 下一轮验收所需条件

1. 目标运行机器上的Node22.19+、Claude可执行文件与有效原生登录或API配置；Linux还需可用并解锁的Secret Service。秘密由用户在目标环境输入，不能写入仓库或聊天。
2. 在CLI中完成官方Cindy登录，与桌面Cindy同账号；开启remoteAccessEnabled。
3. 桌面发现远程供应商，选择CLI来源后验证本机文件读写、命令、消息流、停止和提问。
4. 验证真实断线重连、CLI重启后同一任务历史恢复及账号撤销；当前自动化不能替代这些实机结论。

开发验收结束时尚未提交或推送。随后用户明确授权将本轮改动提交并推送到自己的 fork 的 feature/cli-provider-host 分支；提交带 DCO 签名，推送结果以 Git 远端核验为准。没有部署或 Docker 改动。后续工作从本台账继续，不重新复制另一套 Harness 或协议。
## 2026-11-05：真实 Google 登录验收

用户在浏览器完成官方 Google 授权后，CLI 轮询成功收到登录结果，输出 authenticated=true、region=global，并正常退出（exit 0）。随后在独立 CLI 进程执行 status，savedAuthentication=true，确认本次登录凭证已持久保存；该只读状态不代表已完成 refresh/relay 或模型验证。

此前通过聊天链接尝试出现 client_state 已被占用。使用无个人数据的独立授权尝试验证，先 poll 再 authorize 仍返回正常302，因此不能归因于轮询先行。最终通过本地文本提供未预请求的全新链接后成功；链接预访问/重复访问是候选原因，未取得证据确认具体来源。

本轮没有将邮箱、账号ID、令牌、设备ID或个人数据目录写入仓库。远程调用仍未开启；跨进程刷新、真实两机连接、目标 Linux 凭证库和 Claude 供应商认证继续待验收。

## 2026-11-05：Linux VPS 部署说明

新增[Ubuntu VPS 部署指南](../apps/cindy-host/DEPLOY.linux.zh-CN.md)，README 已链接并将第三方登录示例改为实际支持的 Google。指南覆盖版本校验、安装构建、固定 Claude runtime、专用用户 D-Bus/Secret Service、两套认证、tmux 运行与更新备份。没有新增无人值守部署脚本或明文凭证回退。

15 个 Bash 命令块经 bash -n 语法检查通过，文档检查 10 项通过；没有执行 Linux 安装命令，目标 VPS 与重启恢复仍待实测。指南明确 tmux 持续会话不是开机自动解锁/自启保证。本次说明和真实 Google 登录记录整理后，用户已明确授权提交并推送至 feature/cli-provider-host；远端结果以 Git 核验为准。

## Codex CLI 提供端接入

新增显式 `CINDY_HOST_AGENT=codex` 与 `CINDY_HOST_CODEX_BINARY`，默认仍为 Claude Code。
复用 maker-core CodexAgent 的原生 ChatGPT 登录、model/list 和 deviceHosted 执行环境，
以及共享 RemoteAgentHost 的开关、同账号准入、停止与远程工具隧道。无新增 wire 字段、
channel、自建中转适配或重试策略；两台真实机器互通仍待账号环境验收。
配置/恢复见 apps/cindy-host/README.md。测试覆盖两引擎的发现、权限保留、工具隧道与释放，
模型目录只发布原生可见型号。后续修正：原生 API Key 登录也可用，沿用 Codex config.toml 与进程环境中的中转配置；
不再强制 OAuth 凭证模式，API 目录使用独立 cli-codex 身份。跨账号分享仍不支持。

### 桌面发现兼容修正

桌面在 link-open 前读取 maker:provider:list，CLI 原先要求所有 invoke 已建链，导致设备
在线但供应商不可见。现在只有远程执行通道要求已建立控制连接；四个只读发现通道仍检查
同账号、远程开关、登录有效性和账号代次。无新增 wire 字段、重试或 relay 逻辑。回归
覆盖 Claude/Codex 的建链前发现及执行拒绝，真实桌面显示待重新启动 CLI 后确认。

### 模型选择器多引擎能力读取

桌面会同时探测 Claude/Codex/Pi，未启用引擎返回 null 会使整个选择器进入 error。
CLI 现对未启用引擎返回空模型、空推理/权限档位及 hasFastMode=false；启用引擎的
availableModels 从已发现目录投影。未启用引擎仍不列入 available-agents，执行仍拒绝。
复用既有 get-capabilities 响应结构，无新增协议或 relay 改动。回归覆盖三种能力查询。

### Codex 原生中转并发会话

cli-codex 是发现/授权身份，不是 maker-core 的 host 注入凭证路由。将它作为
providerId 传入会触发 provider-oauth，无 proxy 的 app-server 不能以此模式复用；
第二个会话因此报 Cannot switch Codex credential mode。CLI 现在在 start、fork、
setModel 接入边界移除展示 ID，继续使用原生 Codex 配置。外层供应商/模型/账号准入不变，
共享引擎的凭证隔离检查不改。原生 Codex 0.166.0 隔离假 API 配置实测：旧接线复现
1 active session 错误；修正后两个会话可同时打开并执行模型设置（不发送推理请求）。
回归位于现有 runtime.integration.test.ts，通过 CINDY_CODEX_TEST_BINARY 启用；
单文件 9.21s，其中原生回归 1.00s，其余为共享模块加载，维持 integration tier。

### 可靠传输长轮询阻塞与桌面分发复用

CLI onFrame 返回 invoke Promise，导致 10 秒 poll 占据可靠帧顺序交付/ACK，
后面的目录、上传和发送一起排队。旧接线在真实 DeviceLinkClient 的可靠帧回归中失败；
改为与 Desktop 共用 device-link 的 wireAsyncInboundDispatch 后，同一 peer 后续目录
请求在 poll 完成前返回，另一 peer 不受影响。业务错误由宿主错误处理器接收，执行状态
机继续负责幂等与最终回复；无新增帧、重试、授权或自建中转适配。临时正文事件计时已移除。

复用边界：Desktop 和 CLI 共用 DeviceLinkClient（传输、ACK/重传）、异步入站分发、
RemoteAgentHost（运行记录、调用幂等、隧道、poll/close）、hostedStartOptions 和原生
CodexAgent。CLI 仍负责本机账号、单供应商配置及明确的接口子集；它不是 Desktop 的
数据库/完整远控宿主。日志中的 sessions:list 等 CHANNEL_NOT_ALLOWED 不能用虚假空
数据消除，也不应以放开接口来修复传输阻塞。

### 本轮交付验证

CLI 构建、类型检查、67 项测试（含原生 Codex 双会话）通过；Device Link 类型检查、
Desktop 入站分发 125 项定向测试、文档与测试规范检查通过。未执行整仓 CI 或完整
Desktop 类型检查。用户完成 Windows Desktop 到 Linux Codex API 的真实调用，确认
供应商与模型可见、后续回复速度改善。对照日志中两次新任务的启动总时长约 99.7 秒
与 32.7 秒，不是同负载基准；后一次仍有约 21.1 秒上传与 9.6 秒会话就绪等待。
串行分块上传优化尚未实现，不宣称启动延迟已全部解决。

## Codex API 跨账号分享与 Docker 管理

新增 share link/list/approve/reject/pause/resume/remove，通过当前服务的私有 Unix socket
管理，不与 serve 竞争认证锁。Docker 后台服务不依赖 stdin/TTY，使用 docker exec
管理，日志只提示身份/请求 ID，配对码与邀请只返回管理终端。

官方分享 REST 与链接格式直接复用 device-link；成员准入判据抽到 providerShareAccess，
Desktop 与 CLI 同用。Desktop 的 providerShareUsageStore 下沉 remote-agent-host，
原路径保持重导出；复用成员代次落盘、清理门与用量账本，不复制一套。原生 Codex
访客使用 maker-core 既有隔离，每个访客运行独立引擎并在关闭时释放，模型出口复用
anthropic-compat-proxy，与 Desktop 相同组件；真实 Key/原生认证头只在代理内存中，
不写访客 auth.json。当前针对原生 Codex Responses API，订阅/Claude 分享、转分享
和供应商组尚未接入，相关路径不放行。既有同账号行为保留。无新增跨端帧或 channel，
Unix 管理通道仅限本机；自建 relay 无新合同。跨区是否可用继续由官方服务裁决。

验证用假 REST 成员与真实 scoped wire 帧，覆盖批准前拒绝、批准后发现、其它频道拒绝、
暂停后拒绝、本地移除后失败/迟到快照不能恢复授权。原生 Codex 0.159.2 与 0.166.0
配合本地模拟 Responses 上游验证访客生成、说明/凭证隔离与模型/令牌/撤销门禁。
Docker Compose 配置通过解析；本机磁盘空间不足以执行完整镜像构建，镜像内运行与
官方两账号最终验收仍待执行。安装遇到 ENOSPC 已清理可重建包缓存，依赖检查恢复。


### CLI 官方登录分享补齐（2026-11-05）

已接入 ChatGPT 与 Claude 原生官方登录的跨账号分享。Claude 只提供准入绑定，
由原生 CLI 自己读取、刷新凭证并直连；ChatGPT 使用既有 ephemeral 认证桥与受邀者
独占代理，原生 Codex 负责刷新，访问令牌仅在内存中使用，不复制到访客目录。
当前 ChatGPT 读取原生 auth.json，keyring-only 登录暂不支持；换账号需重启提供端。
分享审批、撤销及同账号通道沿用原协议，无自建中转适配变更。

验证：CLI typecheck 通过；5 文件 83 项测试通过（24.28 秒），包含真实 Codex 二进制
配合假凭证的 OAuth 访客启动、凭证文件隔离、API 访客生成及 OAuth 路由拒绝测试。
Claude 准入绑定测试覆盖模型范围、成员失效、release 与登出。没有使用真实官方账号，
ChatGPT/Claude 两账号实际生成、续期和容器运行仍待联调，不作为生产验收完成。

真实双账号联调补充：用户已确认 ChatGPT 官方登录分享可用。修复了 CLI 注入的
stdio cindy_memory 与桌面 HTTP MCP 隧道合并时的启动失败；原生 API/OAuth 回归均已
覆盖桌面携带 cindy_memory 的场景。Claude 官方账号实际生成和容器验收仍未完成。


### 分享的订阅剩余额度

CLI 接入现有 provider-share:insights:v1，只返回获准的订阅窗口，不扩展 relay 合同。
原生 Codex 查询 account/rateLimits/read，Claude 使用原生 get_usage 控制请求；不调用
模型、不读取 Claude 订阅凭证。2026-11-05 用户裁决默认开放额度，share quota off/on
按账号与供应商保存，关闭后的在途回包失效；用量明细仍不开放。API 供应商或读取失败
明确不可用，不按 token 用量推算剩余额度。纯额度/可见性单测 6 项通过，单文件 811ms。

验证补充：CLI 定向跨账号 wire 测试通过（仅选中准入/额度用例）；构建通过。
测试提供端重启后，真实 ChatGPT 账号已返回 ready 的 5 小时与每周剩余额度。
Claude 解析用例通过，但原生 Claude 账号额度查询尚未实测。未运行 Desktop 全量检查。


### 分享用量明细补齐

按用户要求，CLI 用量明细也默认开放；share usage off/on 与额度权限独立保存。
沿用现有 insights 协议，includeUsage=false 时不读历史，展开后才从共享账本投影
当前分享成员的日期、模型、轮次、输入/输出/缓存 token 和已有 SDK 金额；不返回
设备键、账号凭证、已删除成员或其他分享。只覆盖 CLI 已记录的分享用量，不伪造
分享者本人或账号在其他应用中的总用量。未知金额保持未知。行数与帧大小双重限界，
截断明确返回 coverageStart；撤权与关闭后重开均使在途结果失效。
额度/明细定向单测 9 项通过，单文件 2.73 秒；未运行 Desktop 全量检查。

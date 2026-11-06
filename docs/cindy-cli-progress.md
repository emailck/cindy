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

## Docker 管理面板实施

规划见 [CLI 计划新增阶段](cindy-cli-plan.md#2026-11-06单机-docker-管理面板新增授权阶段)。

2026-11-06：用户授权按 complex-task 开发最快可用版本；已确认每实例一种引擎，代理先预留。
初始工作区干净；Node/pnpm 与 Docker daemon 可用，依赖尚未安装。未执行真实账号登录。
管理工具作为本仓 `tools/cindy-host-manager` 的独立可部署 package，官方服务端不修改。

| 编号 | 状态 | 责任/文件范围 | 实际改动与证据 | 阻塞/下一步 |
| --- | --- | --- | --- | --- |
| MGR-001 | 已完成 | 主 Agent；本计划与进度 | 已读 CLI 认证、锁、share-control、Dockerfile；明确 API 与代理/持久化边界 | 按冻结合同派工 |
| MGR-002 | 已完成 | backend；manager server/auth/store/service | 9 项真实 HTTP/WS + SQLite 集成用例通过，3.35 秒；类型检查通过 | 已修登录取消竞态、凭证输出与停止失败状态 |
| MGR-003 | 已完成 | docker_runtime；manager docker-runtime/types、CLI 镜像 | 6 项单测、真实 Docker 双引擎 smoke 通过；CLI 镜像构建成功 | 真实账号与代理出口仍待外部验收 |
| MGR-004 | 已完成 | ui；manager web/package/build/README | 构建、类型检查、3 项 UI 单测与最终双模式浏览器检查通过 | 分块登录链接先红后绿，已验收 |
| MGR-005 | 已完成 | 主 Agent 集成；修正由原负责人实现 | 9 单元 + 9 集成用例、类型/构建、真 Docker、生产网页/后端联调、文档门禁与 diff review 通过 | 官方账号/代理验收不包含在这些结果内 |
| MGR-006 | 待验收 | 主 Agent；交付记录 | 已有 README 与可复现 Docker smoke；未发布或部署 | 真实账号登录、第二台客户端分享调用、真实代理尚未提供 |

计划偏差：首版按用户确认收敛单机，暂不建设节点代理/集群。没有提交、推送或部署授权。
验证记录将区分自动化、Docker 实测、界面目检与真实账号最终验收。

派工后检查：`pnpm check:dev-docs` 10 项通过（约 1.1 秒）。三名子 Agent 按指定配置发起，
未将请求配置当作主 Agent 实际模型确认。代理实现因现有出口协议限制收敛为 HTTP CONNECT，
可承载 HTTPS 目标；https:// 代理传输与 SOCKS 明确拒绝，变更理由已记入计划。

### 本轮集成证据与修正

- 用户再次确认：容器只运行 cindy-host CLI 与原生 Codex/Claude Code，不运行 Desktop、
  Electron 或 VNC。生产镜像已检查相应目录不存在；桌面版只作为容器外的业务调用端。
- 原有冻结安装被 host importer 的 sharp specifier 与根 override 不一致阻断；仅把锁文件
  中该 specifier 对齐现有 `^0.35.0`，解析版本仍是 `0.35.3`，未改原生 CLI 版本 pin。
  随后真实 Docker 镜像构建通过，Codex 0.166.0 / Claude Code 2.1.312 均能在镜像内启动。
- 真 Docker 测试发现空 native 数据卷的 copy-up 重置权限，导致登录无法落盘。适配器现在
  使用 NoCopy，实际验证每次挂载后仍为 UID 1000、0700；6 项运行器单测及双引擎 smoke 覆盖。
- 子 Agent 返回完成后，主 Agent/独立审查发现并修复：空 email 导致 Google/供应商登录失败、
  检查结果刷新丢失、旧登录取消释放新登录锁、失败创建无法恢复、撤销后终端输出、
  停止超时把运行状态覆盖成 error 导致停止按钮不可用。每项修正均由原负责人落地。
- 真实浏览器连接生产管理后端与 Docker：两种引擎都能创建独立容器并检查空认证；
  管理员初始化、登录、退出及浅/深色页面通过，未运行真实账号登录。另用 fake runtime
  验证网页登录 WS 输入、分享申请批准与邀请呈现；390px 页面无横向溢出。
- 可复现 Docker smoke 分两段：生产镜像验证原生版本/空认证；明显标注的 fixture 镜像验证
  TTY 输入/结束输出/取消、登录与运行互斥、分享 argv、SIGTERM、重启和原生数据保留。
  不把 fixture 通过当作官方 OAuth 或真实分享成功；本轮测试创建的容器/卷均已清理。
- 管理工具要求 Node 24+，其独立 npm 依赖审计无告警；CLI 镜像仍用原有 Node 22.22。
  镜像已有 sharp 0.35.3 的高危依赖公告，详见 Docker 说明；本轮未扩展为公共依赖升级。
- 全仓测试规范检查初次因根依赖未安装、缺少 TypeScript 无法运行；改用独立管理工具已安装的
  同类解析器依赖进行检查，356 文件基线检查通过（没有改基线）。测试私有数据目录使用 os.tmpdir()，本机默认临时目录
  存在外部 .git 标记，因此集成测试显式使用其它系统临时目录，不删除外部标记或放宽检查。

### 最终交付记录

- MGR-001 至 MGR-005 的本地实现验收完成；MGR-006 保持待验收，不把缺少真实账号与
  代理的外部验证标为完成。开发授权已执行，未提交、推送、发布或开启公网服务。
- 管理工具目录运行 `npm test`：9/9，通过（2.66 秒）；
  `TMPDIR=/var/tmp npm run test:integration`：9/9，通过（1.40 秒）；
  `npm run typecheck` 与 `npm run build` 通过，最终前端构建 2.45 秒。
- `pnpm check:dev-docs`：10/10；`git diff --check` 通过。
  `NODE_PATH=tools/cindy-host-manager/node_modules` 的绝对等价路径提供未安装的根 TypeScript
  解析器后，`pnpm check:test-hygiene` 356 文件通过；该门禁原扫描范围不含 tools，
  管理工具测试另经独立执行和人工价值审查。未运行整仓 Desktop/Mobile 测试或完整 CI。
- 最终 UI 回归：分块输出的残缺 HTTPS 授权 URL 不再提前显示；完整 URL 结束后才提供点击，
  OAuth 参数不截断。主 Agent 重新跑实际 HTTP/WS 浏览器流程通过，控制台无页面错误；
  Light、Dark 与 390px 布局已目检，界面明确是 Cindy CLI 实例。
- 本机已生成 `cindy-host:manager-dev` 镜像和管理工具 dist，便于后续本地启动；README 提供
  从源码构建 `cindy-host:local` 的标准步骤。临时测试服务已停止，测试容器/卷已清理。
- 下一步由管理员按 README 在私有目录初始化并启动管理页，亲自完成 Cindy 与所选原生
  CLI 的登录，再用另一账号的 Cindy 验证邀请、批准、实际生成与撤权；代理配置后分别验证
  原生登录、推理与分享转发。秘密不发送到聊天、不进入仓库。当前保持既有 sharp 依赖告警。

### MGR-007：管理后台部署（已完成）

用户明确授权部署与修改 Caddy。已核对 Caddy 活跃且管理端口空闲；工具安装阻塞已解除，
外部浏览器 MCP 已完成握手与页面读取。接下来安装独立产物/systemd 服务、追加单站点配置，
再验证域名 HTTPS、管理认证与 WS；不改其它站点，不把真实供应商调用标为已验收。

MGR-007 已完成：独立运行产物与专用服务账号已安装，systemd 开机启动，后台只监听回环。
新增一个 Caddy 站点并平滑 reload，原 Caddy 文件散列均未变。域名 HTTPS 200 且标准客户端
证书校验通过，HTTP 308 跳转。通过浏览器 MCP 实际读取 CLI 管理登录页；另验证管理员认证、
匿名 API 401、跨源写入 403、WebSocket Upgrade 到达应用层及退出会话失效。未创建真实
供应商登录或实例，MGR-006 的供应商业务验收仍待管理员完成。域名、服务路径、回滚与初始
密码读取位置只保留在本机私有部署记录；初始密码未进入仓库、聊天或服务日志。

### MGR-008：登录完成误报失败（已完成）

用户报告浏览器授权成功且 CLI 输出 authenticated=true，但终端状态为失败。仅查看 Docker
元数据确认该登录进程正常 exit0、临时容器已移除，未读取或保存真实终端输出/授权信息。
发现后端把尺寸调整失败发为致命 error，前端也允许迟到错误覆盖最终退出结果；同时审查
runtime 的清理异常覆盖退出码路径。已分别委派原 runtime/backend/UI 负责人按唯一文件范围
修复和补既有测试，主 Agent 做集成与部署。保留用户已登录实例及全部卷。

MGR-008A/B/C/D 已完成并更新已部署管理台：

- UI 回归先红后绿：exit0 后迟到 error/socket error 曾覆盖成功；结束后还会继续发送
  resize/input。现在最终退出结果稳定，活跃期尺寸调整失败只作本地化非致命提示。
- 后端真实 WS 回归先红后绿：exit0 后在途 resize 拒绝曾继续发致命 error；现在丢弃迟到
  结果，已结束登录忽略 resize/input。11 项后端集成通过，单文件墙钟 2.28 秒。
- Runtime 回归先红后绿：原生 exit0 后 remove 失败曾被 catch 改成 -1；现在把进程结果、
  输出排空和清理分开，仅发布一次最终退出码。真实非零仍保留，wait 失败核对容器退出元数据，
  不确定仍活跃的容器继续阻止并发。最终 11 项运行器测试通过（399ms）；6 项 UI 测试通过。
- 主 Agent 完成类型检查、全套管理工具测试、生产构建与 diff review；两引擎 Docker smoke
  通过。冗余 cleanup0 用例合并到时序矩阵，最终保留 17 单元 + 11 集成结果，未弱化断言。
- 更新前确认无活跃登录，备份原部署产物后只替换管理台 dist 并重启其 systemd 服务；
  CLI 镜像、实例和凭证卷不变。重启后的只读检查确认 Cindy 登录仍已保存，未代用户登录供应商。
  域名 HTTPS 恢复正常，浏览器 MCP 确认加载新前端资源；管理服务重启使原网页管理会话失效，
  用户刷新并重新登录管理台即可，已保存的原生认证不受影响。

### MGR-009：Codex 配置目录缺失（已完成）

确认 create 只创建/设置 native HOME 根目录，未创建显式 CODEX_HOME 子目录。已有空认证
smoke 只检查退出码非零映射为 missing，没有区分配置失败与真正未登录，这是覆盖缺口。
由 runtime 负责人修复初始化与状态判据、补真实 CLI smoke；主 Agent负责集成及部署。
不删除或重建用户实例，不复制凭证，不把真实授权链接写入仓库。

MGR-009A/B 已完成并部署：

- 使用实际固定版本 Codex 在隔离容器内复现：缺 CODEX_HOME 时 exit1 且配置加载失败；
  mkdir0700 后同为 exit1，但明确返回 Not logged in。原测试只看退出码的覆盖缺口已修正。
- 统一 prepareNative 在 create/start/check/openLogin 前执行，运行中检查走受管服务 exec；
  以实例 UID 补缺目录，不覆盖已有文件、不修改旧目录权限，使用 no-follow 目录检查。
  首版同时准备 Claude 原生目录，但旧实例缺目录模拟与实际 Codex 状态验证明确限定 Codex。
- Codex 只有明确的 Not logged in 才记 missing，其它配置错误为 unknown；不安全/不可写目录
  返回明确的 NATIVE_DIRECTORY_UNAVAILABLE，管理页有中英文提示，保留已有文件。
- 15 项运行器测试通过（509ms）；主 Agent 全套 21 单元 + 11 集成、类型检查、生产构建通过。
  真 Docker smoke 覆盖新目录、旧实例在 check/login/start/running-check 时修复、保留配置与
  标记文件、现有0750权限不被改写、拒绝 symlink，且原有登录最终状态/TTY/重启流程仍通过。
- 确认无活跃登录后备份并更新管理台产物。现有实例通过正式检查入口自动补齐目录，元数据
  验证为 UID1000、0700、可写；Cindy 登录仍已保存，供应商仍未登录。未读取或改写真实凭证，
  没有创建新实例或重新构建 CLI 镜像。HTTPS 正常，浏览器 MCP 确认新前端资源已生效。
- 下一步用户刷新管理页并重新发起供应商登录；无需重新登录 Cindy 或删除/重建实例。

### MGR-010：登录完成反馈与复制交互（已完成）

只读核验本轮供应商原生登录退出130，运行约291秒，无 Docker kill 事件；当前供应商认证
未保存、Cindy认证保留。没有读取真实终端正文或授权URL，尚未确定中断来自用户按键还是
原生行为。发现父页面没有订阅登录结束事件，且终端缺少明确的安全复制入口；委派 UI
负责人验证并修复交互/完成反馈，主 Agent执行集成与部署。

用户进一步明确终端只负责输出。已据此调整 MGR-010：UI 移除所有键盘输入转发；独立输入
表单仅处理显式单行回答，backend 拒绝 raw input/控制字符并与前端同步部署。最初“无选择
保留 Ctrl+C 中断”的方案已撤销。无法据退出130认定用户按过 Ctrl+C，原因仍未确认。

MGR-010A/B/C 完成并部署：

- 输出区 disableStdin 且完全移除 onData 转发，键盘/粘贴/Ctrl+C 不会输入 CLI；保留选区
  本地复制。需要原生回答时使用独立单行保密表单，提交立即清空；backend 拒绝原始 input、
  控制字符、多行、空值和超长值，禁止从输出区发送中断信号。
- 退出130显示中断；最终退出只回调一次，父页自动通过实际 check 读取认证状态，不把
  exit0直接记为已认证。检查绑定原实例与登录代次，注销/切换后的旧结果不生效；关闭完成的
  输出面板不丢检查结果，供应商选项直接显示 Codex/Claude Code。
- 主 Agent 验证 27 单元 + 12 后端集成通过，类型检查、构建通过。实际 Chromium + 生产
  HTTP/WS + 假原生运行器验证选区复制、无选区 Ctrl+C 与字符输入均不转发、独立回答提交后
  清空、原生结束自动检查并保留已保存状态。仅用合成输入，没有打开用户授权链接或读取凭证。
- 无活跃原生登录后备份并同步更新前后端产物；HTTPS 和浏览器 MCP 确认新资源已生效。
  更新后正式检查确认 Cindy仍已保存、供应商尚未登录；本次供应商退出130的具体触发来源
  未获确认，因此只记录事实，不认定用户复制操作为本次唯一原因。
- 用户刷新管理台后需要重新发起供应商授权，保持只读输出面板打开直至确认保存。此前已成功
  的 Cindy登录不必重做；原生账号/数据卷均未删除或重置。

### MGR-011：已登录实例显示未知（已完成）

代码确认 GET实例列表只返回容器运行状态；认证检查仅返回给当次动作且页面内存保存，
重新打开页面后没有自动恢复检查，所以已保存登录也显示未知。正式检查确认 Cindy已保存。
修复选中实例/现有刷新入口的自动核验，不把所有实例列表变成批量原生进程探测，不保存凭据。

### MGR-012：Cindy 与供应商账号展示（已完成）

用户追加要求展示账号。已确认 Cindy session store 只存受保护 refresh record，无可直接
显示的会员资料；Codex 原生 account/read(refreshToken:false) 和 Claude auth status JSON
可提供安全账号信息。已冻结白名单 accounts 协议并分工；旧 Cindy 数据将通过持锁的显式
资料刷新补齐，普通状态查询仍只读。展示缓存失败不影响主凭证提交，缺资料不会伪造账号。

MGR-011 与 MGR-012 集成验收完成并部署：

- 详情首次打开/创建后自动读取真实认证；手动刷新与聚焦仅检查选中实例，按实例/会话去重，
  活跃登录不争用profile；过期选择/退出账号的回包丢弃。实际浏览器重新加载后选中实例即可
  展示保存状态，避免仅靠旧页面内存。账号资料与认证状态一起更新，null可清旧身份。
- Cindy 增加独立的受保护展示快照（与当前 session 摘要绑定），默认 status仍只读。
  可选 status --refresh-account持锁restore/drain；展示缓存失败不影响主凭证提交。新增CLI
  参数/返回字段向后兼容，旧实例可补资料，不要求重登。发现并修复原有share-manager action
  类型未收窄：quota/usage由宿主处理，不能误入成员操作，未用强转绕过检查。
- Codex account/read(false) 在固定版本仍会解析远程workspace，故改为原生
  accountSession/list(refreshWorkspaceMetadata:false)，仅选择唯一当前活动账号。临时本机
  目录抑制探测的模型发现，不改变正式引擎配置；不推测套餐、不读取凭证文件。真实固定CLI
  配合明显假凭证验证请求计数0、认证文件字节不变、输出不含token/key/内部ID。Claude
  读取原生status JSON白名单；API Key仅显示登录方式，不显示密钥片段。
- CLI定向59项测试、CLI类型检查和构建通过；管理工具43单元+12集成、类型检查和构建通过。
  实际浏览器通过自动初次/刷新检查、两类账号投影、Light/Dark和390px无溢出；不保存真实
  身份截图。Cindy/供应商的真实名字邮箱不进入仓库或验证日志，只输出字段是否存在。
- 本次镜像在已验证基础镜像上增量替换同一已验证CLI产物，SHA一致，原生版本和依赖未升级；
  新镜像内status及显式refresh空账号检查通过，未重跑全量Docker源码构建。保留旧镜像和
  管理台产物备份。既有sharp依赖告警仍然存在，不宣称本轮已修复。
- 用户明确同意重启正在运行的CLI实例。按授权先优雅停止，更新镜像及管理台，再用原卷
  启动。正式检查两边认证均已保存：Cindy名称/邮箱、Codex ChatGPT邮箱均成功投影，实例运行中；
  HTTPS与浏览器MCP确认新资源。没有要求用户重登，没有删除账号或数据卷。
- 原MGR-006真实供应商调用验收仍不能由账号读取替代；本次只确认管理与账号信息链路，
  未主动发起付费模型推理或向任何人发送分享邀请。未提交/推送代码。

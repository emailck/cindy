# Cindy CLI 提供端实施计划

状态：实施中。协作遵循 [工作约定](cindy-cli-working-agreement.md)，当前事实见 [进度](cindy-cli-progress.md)。

## 目标与非目标

在无 Electron 窗口的 Node CLI 中运行远程 Agent 提供端。第一条完整路径是同账号的桌面 Cindy 使用 CLI 上的 Claude Code；项目文件、命令和工具留在桌面，官方认证与 Device Link 协议复用。Harness、原生上下文与会话行为保持原有实现。

不开发 Docker，不重建官方后台，不实现 SSH 项目工作区，不把现有评测用 cindy-headless 当作完整提供端。第一阶段不承诺跨账号分享、供应商组、所有 Harness 和 WebRTC 直连；这些能力不得在设备广播中虚报。后续扩展另立任务，不以第一阶段完成代表完整 Desktop 等价。

## 现状证据与设计

- `apps/desktop/src/main/remote-agent/host/runHost.ts` 的 RemoteAgentHostDeps/createRemoteAgentHost 已把引擎启动和准入注入；tunnel.ts 负责反向工具请求。
- `host/service.ts` 是 Desktop 业务接线，`maker-host/index.ts` 负责 Maker 装配，不能在 CLI 整体导入。
- `packages/maker-core` 与 `packages/device-link` 独立于 Electron，必须复用已有协议和引擎。
- `packages/auth-client` 有认证 API；Desktop authManager 使用 Electron 安全存储，必须提供独立宿主适配，不能复制桌面密文或存自定义明文凭证。
- `device-link/directLink.ts` 依赖隐藏页面，第一阶段使用既有 relay 通道，不宣称已实现直连。
- `apps/cindy-headless` 的台账明确未支持设备托管与账号生命周期。

采用 `apps/cindy-host`（@cindy/host）作为 CLI 与常驻入口，公共运行逻辑已按依赖闭包抽到 `packages/remote-agent-host`，Desktop 保留原路径兼容导出。纯权限/用量判据迁入 maker-shared，保持函数身份，避免 package 反向依赖 Desktop。

CLI 命令定稿为 login、logout、status、config show/set/reset、doctor、serve、help/version。第一阶段单个 Claude 来源通过明确环境变量选择 native 或 api-key 认证及二进制路径；不宣称已有任意供应商管理命令。认证必须先实现发现可用登录方式、登录结果/账号选择、刷新和退出；不能用假 token 替代真实链路。凭证采用 @napi-rs/keyring 的 OS 保护存储；Linux 必须有可用 Secret Service，禁止退回临时 keyutils 或明文。设备身份与 refresh record 持久化，access token 只驻内存。容器支持仍不在此阶段。

执行权限按用户要求支持最高档，保留对端身份、供应商与会话归属校验；需求提问仍回传桌面。遵守客户端最终执行权限，不在提供端伪造批准结果。VPS 保留引擎历史与必要影子目录，不挂载客户端真实项目。

## 任务与验收

| 编号 | 任务与预计修改范围 | 依赖 | 验收 |
| --- | --- | --- | --- |
| CLI-001 | 明确公共宿主接口、依赖闭包与第一阶段功能；本计划 | 无 | 有可执行模块边界，未决事项显式登记 |
| CLI-002 | 建立 CLI package、入口、配置和生命周期；apps/cindy-host | CLI-001 | 无 Electron 启动；参数与错误可诊断；SIGTERM 清理 |
| CLI-003 | 官方认证、受保护凭证、稳定设备身份；CLI auth/storage 模块 | CLI-001 | 登录/刷新/失效/退出语义正确，秘密不输出或明文存储 |
| CLI-004 | 提取远程宿主与 Desktop 兼容接线；公共 package、remote-agent 目录 | CLI-001 | 原有宿主行为测试通过，新增包无 Desktop/Electron 依赖 |
| CLI-005 | 设备连接、准入、模型目录与供应商配置；CLI device/provider 模块 | CLI-002、003、004 | 桌面能发现真实可用供应商，关闭/撤销阻断新请求 |
| CLI-006 | Claude Harness 装配、反向执行、会话存储；CLI runtime 模块 | CLI-004、005 | 桌面文件工具实际回传执行；流式输出、停止和提问可用 |
| CLI-007 | 集成、重连、重启、账号隔离与恢复验证；已有相关测试与 CLI 测试 | CLI-006 | 有观察结果证据；断线不重复执行写操作；重启可恢复身份和会话 |
| CLI-008 | 操作说明、构建与交付检查；CLI README、根脚本/锁文件必要更新 | CLI-007 | 从干净依赖到启动可复现；报告未验证的平台与线上环节 |

并行边界：CLI-003 与 CLI-004 可在公共接口明确后并行；不同文件由唯一子 Agent 负责，主 Agent 维护台账和集成。共享清单、锁文件和接口变更由主 Agent 协调唯一写入者。

## 验证与风险

优先复用 claudeHosted.e2e、hostLifecycle、roundtrip、connectionPool 和宿主相关测试。新测试通过真实生产入口验证新的生命周期/协议行为，按工程约定写测试价值与 tier。完成相关 package 类型检查和构建、文档检查及最终 diff review。

官方登录与真实模型验证需要用户认证或已配置测试身份；不读取私人凭据，不以 mock 通过冒充线上验收。环境缺失与账号缺失分别登记。认证轮换、持久数据、设备准入、协议兼容与提示词都是专项边界；实现前读取规则并说明变更影响，尽量不改 wire 与 system prompt。

完成标准是 CLI-001 至 CLI-008 的第一阶段目标全部有验收证据；任何阻塞不得标成已完成。

## 实施决策记录

- 2026-11-04：第一阶段为 Global 构建身份，使用仓库公共端点；不新增运行时区域选择或官方后端协议。
- Claude 模型列表必须来自真实 SDK/供应商发现，不能用空的 bundled anthropic models 或凭空推荐列表冒充可用模型；ID 归一化与 Desktop 共用。
- 最高权限是客户端未提供权限档位时的回退（映射 bypassPermissions），显式客户端档位优先，设备认证与供应商准入不变。
- SIGINT/SIGTERM 停止新工作，但已发出的凭证轮换须保存完再释放 profile 锁；服务端不响应会延迟优雅退出，强杀可能需要重新登录，不能保证强杀恢复。

## 2026-11-06：单机 Docker 管理面板（新增授权阶段）

本节扩展原第一阶段，不改写上文历史非目标。用户已授权开发：内部管理网页创建多个
cindy-host 实例，每个实例选择 Codex 或 Claude Code，通过网页完成 Cindy 和原生 CLI
登录、启停与分享；代理先预留可选配置。对应执行记录继续维护在
[CLI 进度](cindy-cli-progress.md#docker-管理面板实施)。

### 目标、边界与证据

- 首版为单台 Linux Docker 宿主机；独立可部署的管理工具放在 `tools/cindy-host-manager`，
  不进入 Desktop bundle、不修改官方 Server。管理后端是本机 Docker 管理客户端。
- 复用 `apps/cindy-host` 的 login/config/serve/share 命令、profile 独占锁、原生认证和
  Device Link；不增加跨端 wire、供应商组、任务调度或自动迁移。
- 每个逻辑实例有独立 Cindy profile 和原生 HOME/config 卷；引擎在创建时确定。
  初始化使用临时容器；服务使用独立常驻容器，二者绝不并发占用同一 profile。
- 已有 Dockerfile 只装配 Codex，Compose 固定单容器名；新增 Claude runtime 和镜像选择能力。
  原有 CLI 参数、数据卷、默认启动方式必须兼容。
- `status` 只说明保存了认证，不能冒充实时授权或 Device Link 就绪；分别显示容器状态、
  保存的登录状态与业务验证结果。分享列表必须读取正在运行的 share-control。
- 后台仅供受信管理员；浏览器不获得 Docker API、任意宿主路径或 shell 执行能力。
  登录终端只运行固定原生命令，不提供通用 shell；所有交互不记日志、不落数据库。
- 数据目录必须位于 Git 工作区外；SQLite、管理员密码散列和加密密钥权限受控。
  不使用真实个人账号做自动化测试，不在报告中记录个人地址、身份或凭据。

### 架构与冻结接口

管理工具采用 React/Vite、Node HTTP + WebSocket、SQLite；独立 package 与锁文件，不改
根 workspace 的依赖。Docker SDK 通过本机 Unix socket 访问 daemon，不向业务容器挂载 socket。
服务层通过可注入 DockerRuntime 接口调用适配器，HTTP 和浏览器不拼接 shell 命令。

API 均为同源 `/api`，JSON；失败 `{error:{code,message}}`，消息不得带原始 Docker 错误或凭证。
管理员使用 HttpOnly/SameSite cookie，写操作校验 Origin 与 CSRF；WebSocket 校验 Origin、
会话和登录操作所有权。会话不进 localStorage。生产部署使用 HTTPS 反向代理，默认只监听回环。

- `GET /api/session` → `{authenticated:boolean,csrfToken?:string}`。
- `POST /api/session` `{password}` → 同上；`DELETE /api/session` 退出并撤销其登录交互。
- `GET /api/settings` → `{image:string,proxyConfigured:boolean,proxyUrl:string|null}`（URL 不含凭据）。
- `PUT /api/settings` `{proxyUrl?:string|null,proxyUsername?:string,proxyPassword?:string}`；
  首版镜像由部署配置固定，网页不接受任意镜像/挂载/命令。
- `GET /api/instances` → `{instances: InstanceView[]}`。
- `POST /api/instances` `{name,engine:'codex'|'claude-code',proxyMode:'none'|'default'}` → `{instance}`。
- `GET /api/instances/:id` → `{instance}`；`PATCH` 仅改 name/proxyMode，运行中改代理返回须停止。
- `POST /api/instances/:id/actions` `{action:'start'|'stop'|'restart'|'check'}` → `{instance}`；
  按实例串行，忙时明确返回冲突，不重复执行，界面等待实际结果。
- `POST /api/instances/:id/login` `{target:'cindy'|'provider',method?:'google'|'email',email?:string}`
  → `{loginId}`；运行中拒绝并提示先停止；不自动杀正在工作的服务。
- `WS /api/logins/:loginId`：JSON server `{type:'output',data}`、`{type:'exit',code}`、
  `{type:'error',message}`（尺寸失败为非致命 warning）；client `{type:'answer',value}`（显式单行提交，拒绝控制字符）、`{type:'resize',cols,rows}`、
  `{type:'cancel'}`。只允许创建该登录操作的管理员会话连接；关闭、注销、过期清理临时容器。
- `POST /api/instances/:id/share` `{action:'list'|'link'|'approve'|'reject'|'pause'|'resume'|'remove'|'quota'|'usage',id?,code?}`
  → `{result}`；沿用原生命令结果，邀请/配对码只返回授权页面，不进入普通日志或审计数据。

InstanceView 基本字段：`id,name,engine,proxyMode,createdAt,state,error?`，其中 state 为
`stopped|running|busy|error|missing`；`authentication?:{cindy:'stored'|'missing'|'unknown',provider:'authenticated'|'missing'|'unknown'}`。
`running` 仅代表容器运行，UI 不标成“业务已就绪”。引擎/profile 身份不可原地替换。
分享读取按原生返回的 `{shares,usage}` 展示 requests/members；审批需要显式输入配对码。

DockerRuntime 由唯一适配器负责人定义并向服务负责人交接：create/inspect/start/stop/check/share/
openLogin，登录返回 input/resize/cancel 和输出/退出订阅。实例身份用 UUID 与受控 labels 校验，
只处理本工具所属容器/卷。禁止清理无归属资源；停止与重建不删卷。

### 代理与凭证边界

首版 HTTP CONNECT 代理为可选全局配置（http:// 上游，可承载 HTTPS 目标），各实例显式选择 none/default；配置没有设置时显示未配置，
不伪造已启用。代理用户名/密码加密存储，密钥仅在后台外置私有目录，GET 不回显密码。
设置供后续启动/登录使用，已有服务保留原进程环境并提示重启。容器内原生登录、CLI 与
Codex 分享转发使用一致的代理设置；loopback 保持直连。代理失败不静默删除配置重试直连。
HTTPS 代理传输（https:// 上游）、SOCKS、透明代理和容器任意子进程的强制出口管控不属于本次承诺。
检查已有分享出口适配后收敛到 HTTP CONNECT，避免不支持的代理协议回退直连；不修改公共代理协议。
未提供真实代理，验收使用本机假代理并明确真实出口未验证。

认证登录仍由原生 CLI 完成，网页只提供临时受认证终端。取消须停止对应登录进程并释放 profile，
不终止其它实例。服务优雅停止不能默认强杀；超时保留错误状态，不与活进程并发初始化。
存量锁不盲删：仅在确认同实例所有容器均停止且无未受管进程时才允许受控恢复。

### 稳定任务编号与验收

| 编号 | 范围与唯一责任 | 依赖 | 验收与验证方式 |
| --- | --- | --- | --- |
| MGR-001 | 主 Agent：本计划/进度、接口、风险 | 无 | 用户范围明确，接口可交接，未决事项不写成现状 |
| MGR-002 | 后端子 Agent：server/auth/store/service/API 与对应测试 | 001、适配器合同 | 管理员认证、CSRF/WS 所有权、实例串行、SQLite 重启保留、秘密不回显；生产入口测试 |
| MGR-003 | Docker 子 Agent：docker-runtime/types、适配测试、CLI 镜像/说明 | 001 | 两引擎隔离、固定命令登录/分享、停止保卷、容器归属校验、代理继承；真实 Docker smoke |
| MGR-004 | UI 子 Agent：web、独立 package/build 配置、README | 001 | 实例创建/登录终端/启停/分享/代理完整表单；Light/Dark、响应式、可访问性；构建与浏览器交互 |
| MGR-005 | 主 Agent 集成；修正委派原责任人 | 002、003、004 | 完整定向测试、类型/构建检查、真实容器假登录交互、未授权访问拒绝、双模式目检 |
| MGR-006 | 主 Agent 交付；操作文档由 UI/Docker 负责人补齐 | 005 | 干净部署步骤可重现；真实 Cindy/供应商账号与第二台客户端调用待用户环境验收，不冒充通过 |

具体功能由子 Agent 实现；主 Agent 维护文档、接口评审、集成与验收。已取得使用当前主 Agent
继续调度的用户同意；模型个人偏好不写入仓库。依赖安装只由指定负责人操作，不并发改锁文件。

### 风险、未决与阶段限制

- 管理后台能控制 Docker，属于宿主高权限入口；必须认证、限制同源并默认回环监听。
- 网页登录新增秘密输入通道，优先验证会话隔离、取消和不落日志；TLS 由部署入口提供。
- 官方账号登录/真实分享与容器代理出口需实际环境验收，不能用 mock 替代。
- 非正常关机的 profile 锁、凭证轮换、原生 CLI 版本差异分别报告；不保证强杀无损。
- 代理尚未提供；多节点、供应商池、无人值守迁移、数据销毁与发布均不在本轮授权内。
- 本轮不改 Device Link 恢复、wire 或 allowlist，自建中转合同不变。管理页面支持窄屏浏览；
  不新增手机 App 的管理入口，原有 Desktop/Mobile 使用提供端的业务链路保持原样。

## 管理面板部署阶段

用户已明确授权将管理后台部署到本机现有 Caddy 对应域名。MGR-007：安装独立运行产物、
受信本机 systemd 服务与 Caddy 反向代理，验证 TLS、登录保护及 WebSocket 转发。
保留现有 Caddy 站点；初始密码及实际域名/服务路径等环境信息只写仓库外的私有部署记录。
代理仍未配置；不代替用户完成供应商账号登录。部署入口验证与真实供应商业务验收分开记录。

## MGR-008：登录结束后误报失败的回归修复

触发：用户已看到原生 Cindy 认证成功输出，管理台仍显示登录进程失败。Docker 进程退出事件
验证 exitCode=0；不保存用户授权链接、身份信息或终端正文。

- MGR-008A（docker_runtime）：原生退出码与容器清理结果分离，清理错误不能重写已知退出码；
  输出排空后只发送一次最终结果。现有 runtime 测试复现 cleanup failure + exit0。
- MGR-008B（backend）：已结束登录忽略 input/resize，在途 resize 失败不得覆盖已知退出；
  活跃期的尺寸调整失败只发非致命 warning。真实 WS 集成覆盖时序。
- MGR-008C（ui）：最终退出结果保持稳定，结束后停止输入/resize；迟到连接错误不改成功/失败；
  活跃期 warning 不等同认证失败。现有组件测试先红后绿，i18n 同步。
- MGR-008D（主 Agent）：定向测试/构建/浏览器验证；确认无活跃登录再更新独立部署产物并
  重启管理服务。只更新管理台，不改变实例卷、原生账号、CLI 镜像或官方服务端。

验收：exit0 后迟到 resize/error/close 不出现失败；原生非零仍失败；未结束时断链不冒充成功；
清理失败不丢失真实结果，保留可恢复的资源；实际已保存认证的只读检查不泄漏秘密。

## MGR-009：Codex 原生配置目录初始化

用户原生 Codex 登录在授权开始前报 CODEX_HOME 不存在。create 仅初始化 HOME 根目录，
而显式 CODEX_HOME 需要已存在的子目录。修复必须覆盖新实例及已经保存 Cindy 认证的旧实例，
不能要求删卷/重建账号，不读取或重写原生凭据。

- MGR-009A（docker_runtime）：在受管容器内部用实例 UID 初始化缺失的原生目录；
  create/start/check/openLogin 通过同一判据，已有配置保留，不跟随不安全链接；
  原生状态检查不得把任意配置错误统一标为未登录。现有测试与真 Docker smoke补覆盖。
- MGR-009B（主 Agent）：验证固定版本原生 Codex 能加载新/旧配置目录并报告真实未登录；
  模拟旧实例缺目录时自动补齐，保留已有数据标记；构建并更新管理台，现有实例通过管理入口修复。

验收：新实例及旧实例均有实例 UID 可写的私有 Codex 目录；保留 Cindy 登录；真实 login status
明确为未登录而非配置加载错误；真实 OAuth 仍由用户亲自完成。

## MGR-010：原生登录中断与完成反馈

用户在供应商网页完成授权后管理台未给出明确下一步；元数据表明原生进程 exit130，
状态检查供应商认证未保存。网页授权与 CLI 换取/保存凭证不是同一步，不推断用户操作。

- MGR-010A（UI 子 Agent）：用户明确要求终端只输出，因此禁用键盘/粘贴向 stdin 转发，
  Ctrl/Cmd+C 仅作为页面复制，不保留无选区时的原生中断。退出130明确显示中断；
  只有关闭/取消操作结束活跃登录。确需验证码/授权码/账号选择时，通过独立保密单行表单
  显式提交，不在输出区键入。输入不持久化、不进日志，提交后立即清空。
  原生退出后通知父页自动检查已保存认证并展示结果，不将 exit0 直接视为已认证；
  供应商选择直接显示当前引擎名称。已有组件测试覆盖输出区只读、显式提交与真实 API结果。
- MGR-010C（backend）：私有 WS 用单行 answer 替代任意 input；拒绝控制字符/多行，
  服务端仅为明确提交追加回车。保留所属会话检查、退出状态与非致命 resize 行为。
  与网页一起部署；旧客户端必须刷新，不保留可发送原始控制键的入口。
- MGR-010B（主 Agent）：复核输入/剪贴板边界、检查回包与切换实例/退出账号的时序，
  本地浏览器验证；无活跃登录后部署。已完成的 Cindy 登录保持，供应商认证由用户继续。

用户操作原因若未获确认，报告只陈述退出码和认证状态，不把候选原因写成已证实根因。

MGR-010 计划变更：最初仅拟保护选区复制；用户随后明确输出区完全只读，因此取消原生键盘
转发，保留需要用户回答的原生登录步骤，但通过独立表单交接。该用户裁决优先于旧终端方案。

## MGR-011：重新打开实例后的认证状态

用户已完成 Cindy 登录，但重新打开管理页/实例显示未知。列表接口只检查容器是否运行，
不返回认证快照；页面原来只在手动检查或本次登录结束时读取认证，新页面内存为空便一直未知。
不把未知等同未登录，也不通过填默认 true 或持久化一份可能过期的认证结论解决。

- MGR-011A（UI）：进入实例详情时自动读取一次实际保存状态；刷新当前详情/页面恢复焦点时
  按现有刷新入口核验选中实例，不扫描所有实例、不加后台轮询。复用现有 check 与代次保护，
  不与活跃登录争用 profile。用户能看到检查中，只有读取失败/未核验时才未知。
- MGR-011B（主 Agent）：确认正式实例的真实保存状态；对首次打开、刷新、切换实例/退出账号、
  忙时不重复检查等行为做定向验证，构建与无活跃登录后的部署。保留只读输出与显式回答合同。

## MGR-012：账号标识展示

用户明确要求同时显示已登录 Cindy 和供应商账号。公开展示字段与凭证分开，不读取/回显
供应商凭证文件；不从聊天中抄录身份，不用旧账号名称冒充当前身份。

冻结返回：`RuntimeInspection.accounts?: {cindy: AccountIdentity|null, provider: AccountIdentity|null}`，
`AccountIdentity = {displayName?:string,email?:string,loginMethod?:'cindy'|'chatgpt'|'claude'|'api-key',plan?:string,organization?:string}`。
所有字段白名单、长度/控制字符校验；不含账号内部ID、令牌、密钥、头像请求或原始响应。
`check` 显式返回 null 清空不可用资料；运行状态 inspect 缺字段不意味着账号退出。

- MGR-012A（CLI/auth 负责人）：`status.runtime.account` 增加只读安全投影；认证成功登录/
  刷新时，在既有私有凭证 store 另键记录白名单快照，以当前序列化 session 的摘要绑定。
  只有快照与当前 session 匹配才显示。退出/失效不显示旧身份，旧记录无快照保持兼容。
  主 refresh record 必须先可靠提交，展示缓存失败不能导致已成功轮换的凭证丢失或登录失败。
  新增显式 `status --refresh-account`（可选 dependency refreshAccount）通过 profile 独占锁
  复用 auth.restore/drain 更新资料；普通 status 保持只读、不旋转令牌。运行中的 serve 拒绝
  第二进程 refresh，等待现有宿主刷新/下次受控重启，不以读账号为由抢锁。
- MGR-012B（Docker runtime 负责人）：读取 status 白名单资料；旧的已保存 Cindy 登录且
  停止时可进行一次显式资料补取，不要求用户重新登录；失败保留“已保存/资料不可用”。
  Codex 使用原生 app-server `accountSession/list {refreshWorkspaceMetadata:false}`，严格按
  activeSessionId 与 isActive 唯一匹配当前账号；不直接解析 auth.json、不执行模型请求。
  临时本机目录抑制探测进程的模型发现，固定参数、限时/限量、退出清理，仅输出安全投影。
  不使用会触发远程 workspace 查询的 account/read；套餐未实报就省略。Claude 复用
  `auth status --json` 的安全展示字段，API Key 模式只标方式，不展示部分 key。
- MGR-012C（UI）：在各账号状态旁显示名称、邮箱、登录方式和原生实报的套餐/组织；
  已保存但无资料时明确不可用。缺认证时不保留旧身份，采用 MGR-011 的选择/刷新核验。
- MGR-012D（主 Agent）：集成、定向测试、新 CLI 镜像构建；确认无活跃登录后更新管理台
  和镜像，停止的旧实例保留原卷，正式检查补取当前 Cindy资料。只验证返回字段存在，不把
  真实名称/邮箱写日志/仓库；供应商账号尚未登录时如实显示，实际新登录仍由用户操作。

本阶段新增本地可选命令/字段，原 CLI 参数、旧私有数据和 Device Link wire 保持兼容。
不改官方服务端、system prompt 或模型配置。旧镜像不支持新命令时回退为资料不可用，
不放宽权限或强迫重登。验证包含假资料中的 token/key 不可出现在输出、账号切换/退出清旧、
缓存写失败不影响凭证提交，以及原生 Codex fake 身份/空身份的本地 RPC 读取。

MGR-012 实现调整：固定 Codex 版本的 account/read 即使 refreshToken=false 仍会解析远程
workspace；运行时证据优先，改用明确跳过远程会员信息刷新的 accountSession/list，并通过
假凭证、网络 tripwire 和文件字节对比验证不产生网络请求或认证修改。账号展示目标不变。

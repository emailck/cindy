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

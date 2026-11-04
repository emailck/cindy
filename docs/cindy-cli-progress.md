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
# Cindy CLI 使用端开发进度

依据 [实施计划](cindy-cli-client-plan.md) 与 [工作约定](cindy-cli-working-agreement.md)。

## 当前批次

2026-11-15：用户裁决独立程序（`cindy`，与 `cindy-host` 分开两个进程）、ink 界面、命令命名、默认权限档 full、
中英切换，以及与 Claude Code 类似的斜杠命令（首要是选择模型，其余一并提供）。沿用分支 feature/cli-provider-host；
本批由主 Agent 直接实现（未委派子 Agent），偏差已记录。用户随后明确授权提交并推送（见文末「交付」）。

| 编号 | 状态 | 改动与验证 | 下一步/阻塞 |
| --- | --- | --- | --- |
| CC-001 | 已完成 | 计划、本台账；esbuild 打包实测 Desktop 控制端闭包无 Electron | — |
| CC-002 | 已完成 | `apps/cindy-cli` 包、ESM 构建、`cindy` 入口、数据目录/进程锁/设置、login/logout/status（引用 cindy-host 认证与存储）、Desktop 闭包门禁；中英文案 | — |
| CC-003 | 已完成 | `link.ts` 出站链路（声明分享能力 + 后台链路，恢复语义对齐 Desktop，引用 `linkRecovery.ts`）、`catalog.ts` 模型目录 | 真实中转待验收 |
| CC-004 | 已完成 | `session.ts` 接线 Desktop `startRemoteAgentSession`、`runtime.ts`、`store.ts` 本地任务记录 | 真实账号待验收 |
| CC-005 | 待验收 | `chat/controller.ts`、`chat/App.tsx`（ink）、`chat/print.ts`（-p）；斜杠命令、两步选模型、`-c` 续接、运行中排队/插话/打断、多选与计划意见、Shift+Tab、分组 `/help` 与 `?` | 真实终端目检待用户 |
| CC-006 | 待验收 | `shares.ts`、`received.ts`：预览告知 → 确认 → 配对码 → 轮询；list/status/withdraw/leave；任务目标解析 | 真实双账号待验收 |
| CC-007 | 进行中 | Windows 真实账号：登录、模型目录、同账号与分享任务、凭证确认、`-c`、插话/排队/打断、文件与命令工具通过；Linux（WSL）：构建产物、全部测试、代理 | 交互界面目检、分享申请/批准/撤销、Linux 真实账号任务、提供端为 cindy-host 的路径 |
| CC-008 | 已完成 | CLI README、`repo-map.md`、`provider-sharing.md` §3 补充、合并检查清单 | — |

## 验收记录

- 依赖：`pnpm install --no-frozen-lockfile` 新增 `apps/cindy-cli`（ink 7.1.1，React 沿用仓库 19.2.3；ink 8 需要 React ≥19.3）。
  锁文件改动限于新包及 ink 依赖，外加 `ws` 一处可选对等依赖的解析行变化。
- `pnpm --dir apps/cindy-cli exec tsc --noEmit`：通过（含被引用的 Desktop 源码）。
- 构建：`node scripts/build.mjs` 通过，闭包门禁通过；仅有 maker-core `image-resizer.ts` 既有 direct-eval 提示。
  构建产物实测：`--version`、`status`（中英）、未登录时 `-p` 返回 `AUTH_REQUIRED`（Windows 凭据管理器只读探测正常）。
- 单测 `vitest run --exclude '**/*.integration.test.ts'`：5 文件 19 项通过，2.39s。
  逐文件：cli 4 项 0.65s；desktop-closure 4 项；received 5 项 1.87s；controller 5 项 0.57s；App 1 项 1.85s。
  全部（含集成）最终一次：6 文件 20 项通过，6.55s。
- 集成 `src/remote.integration.test.ts`：1 项通过，7.85s（用例 0.43s，其余为 maker-core 模块收集，故放 integration tier）。
  覆盖真实 CLI 控制端 ↔ 内存中转 ↔ 真实 `createCliHost`：建链前读模型目录、默认 full 落为 `bypassPermissions`、
  远端假引擎经隧道读取本机文件后回答、一台静默对端不阻塞另一台（故障半径三问第 3 条）。
- 测试中发现并修复：闭包门禁原按 `apps/desktop/` 前缀匹配，而 esbuild metafile 路径相对构建目录（`../desktop/…`），
  门禁永远不会触发；改为以仓库根为 `absWorkingDir`，并在未发现任何 Desktop 输入时失败。
- `pnpm check:test-hygiene`：失败，21 条均为既有 Desktop / Mobile / maker-core 测试文件超出基线，与本批改动无关；
  本批新增文件没有被报告。未修改基线。
- 自查发现并修复：ink `<Static>` 只输出一次，工具结果晚于工具行到达时不会显示；改为从第一个未出结果的工具行起留在
  动态区直到结果到达或回合结束，边界只前进不后退。App 测试新增断言，撤掉修复时失败、恢复后通过。
- `pnpm check:dev-docs`：10 项通过；`git diff --check`：通过。

## 真实环境验收（2026-11-15，Windows，用户本机）

- 登录：CLI 独立浏览器登录（Google），未复用 Desktop 凭证（规则禁止复制 Desktop 密文）。第一次尝试返回
  AUTH_FAILED，当时错误码被统一隐藏、原因未确认；随后让 CLI 显示固定的协议错误码（不含服务端原文），第二次登录成功。
- 新增 `cindy models`（非交互列出模型），实际列出同账号 Desktop 的 Cindy AI 模型与另一账号分享来的 Anthropic 模型；
  同一分享者的另一份分享当时连不上，被单独列为「暂时连不上」。
- `cindy -p --model anthropic/claude-haiku-5-5`（经同账号 Desktop）：远端 Agent 经隧道读取 CLI 工作目录的文件并原样返回，34.5s。
- `cindy -p --model claude-haiku-5-5`（经分享来的供应商）：同样读取成功，27.5s。
- 分享任务读取 `.env`（假密钥）：本机执行器要求确认，-p 模式按拒绝处理，内容未出现在回答中，Agent 未绕过。
- 测试临时目录已删除。未运行交互界面（远程操作的终端不是 TTY）。

## 模型选择改为两步（2026-11-15，用户要求）

- 先选供应商再选模型；同名分享按出现顺序加「(2)」；连不上的来源列出但不可选；第二步 Esc 返回；长列表 10 行滚动。
- `/model` 不再把「正在读取模型」「暂时连不上」写进对话记录（选择框里已显示）。
- 新增/修改用例：controller「两步选择 + 返回」「同名编号 + 跳过不可选」，App「长列表滚动窗口」；全部 6 文件 22 项通过。
- 用与 `cindy models` 实际输出同结构的数据在内存终端渲染了两步界面（中文），布局符合预期；真实终端仍待目检。

## `-c` / `--continue`（2026-11-15，用户要求）

- 用户裁决：不加目录信任确认，默认 full；启动目录即项目目录（原有行为）。
- 新增 `-c`：接着当前目录最近一次任务，可与 `-p` 合用；目录里没有任务时提示并以非零退出。
- 修复既有问题：`/resume` 在记录的模型已不可用时仍会接管旧任务，把原生会话 id 交给当前另一条路由；改为只在原路由可用时接回。
  回归用例撤掉修复时失败、恢复后通过；全部 6 文件 23 项通过。
- 真实验证（Windows，同账号 Desktop，Claude Haiku 5.5）：第一个进程让 Agent 记住暗号，第二个进程 `-c -p` 未指定模型，
  自动沿用原模型并答出暗号；在另一个空目录 `-c -p` 提示没有之前的任务、退出码 1。临时目录已删除。

## 运行中输入、插话、打断与选择操作（2026-11-15，用户要求）

- 运行中 Enter 排队、回合结束后逐条发送；Ctrl+S 插话（handle.steer）；空输入框 ↑ 取回最后一条排队消息；Esc 打断后队列暂停、
  空输入框 Enter 继续；插话失败时消息放回队首，不丢失；Shift+Tab 循环权限档；提问支持数字键与多选；计划确认可输入修改意见。
- 用例：controller 新增「排队/暂停/插话/取回」「多选/计划意见/权限循环」，App 新增按键用例；全部 6 文件 26 项通过。
- 真实验证（同账号 Desktop，Claude Haiku 5.5，控制器 + 真实运行时，临时脚本已删除）：
  - 插话：Agent 完成正在执行的那条命令后放弃剩余计划，回复「插话收到」；运行中排队的消息在回合结束后自动发出并得到回答。
  - 打断：打断后 15 秒内远端没有再执行命令（6 条中停在第 1 条），排队消息保持暂停；同一任务随后正常回答。
- 按键本身只经内存终端测试，真实终端未目检（远程操作的终端不是 TTY）。

## 操作说明 /help（2026-11-15，用户要求）

- `/help` 改为分组的操作说明（命令、输入与发送、任务运行中、回答 Agent、其他），键位列按终端显示宽度对齐（中文按两列）；
  空输入框按 `?` 同样打开；启动提示与 `cindy help` 提到这两个入口。删除了旧的单行快捷键文案。
- App 新增「? 打开操作说明」用例；全部 6 文件 27 项通过；内存终端中文渲染目检对齐正确。

## Linux 验证（2026-11-15，WSL2 Debian 13 x86_64，临时 Node 22.22.0）

- 构建产物：`--version`、中文 help、默认数据目录 `~/.local/state/cindy-cli`、`status` 正常；无 Secret Service 时 `login` 返回
  CREDENTIAL_STORE_UNAVAILABLE 且不降级；显式 `CINDY_CLI_CREDENTIAL_STORE=file` 可用；非 TTY 运行交互模式返回 TERMINAL_REQUIRED。
- 全部测试在 Linux 上通过：6 文件 27 项（含集成：真实控制端、提供端、隧道与 Linux 执行器）。墙钟 56s 主要是跨 WSL/Windows 文件系统收集。
- 据此补充：启动时检测 ripgrep，缺失则提示（Linux 上本仓只带 win32 的 rg）；凭证报错提示显式文件存储选项；构建后给 `dist/cindy.mjs`
  加可执行位；`credentials-and-local-storage.md` 的 CLI 文件凭证例外扩展到 `apps/cindy-cli`（条件不变）。
- 未验证：Linux 上的真实账号登录与远端任务（需在 Linux 侧重新登录）、真实 Linux 终端中的 ink 交互、ARM64 / musl、macOS。
- 临时文件：WSL 内 `~/.cache/cindy-linux-test`（Node 与测试临时目录）、Windows 临时目录中的 Node 包与两个测试脚本，验证后删除。

## 代理（WSL 使用 Windows 代理，2026-11-15，用户要求）

- 诊断（只读）：Windows 系统代理 127.0.0.1:7890（监听所有地址）；`.wslconfig` 为 mirrored + autoProxy，WSL 已自动获得
  `http(s)_proxy`。经代理访问正常（两次 56MB 下载成功）；不走代理时极慢（同一中转握手 12.6s，curl 10s 超时），默认路由指向代理软件
  TUN 网卡 198.18.0.2。此前一次 curl 失败为偶发，未能复现。真正的问题是不读代理环境变量的程序，包括 CLI 自己（Node fetch 与 ws）。
- CLI 修复：新增 `proxy.ts`。登录与 REST 经 undici `EnvHttpProxyAgent`（显式传入代理与 NO_PROXY，避免它自行读取 process.env）；
  中转 WebSocket 复用 `@cindy/anthropic-compat-proxy` 的环境解析与 HTTP CONNECT / SOCKS5 agent；不支持的代理启动即报错。
  新增依赖 `undici ^8.3.0`（与 Desktop 一致）与工作区包 `@cindy/anthropic-compat-proxy`。登录被 Ctrl+C / SIGTERM 中断时报「已取消」，
  不再显示为请求超时。
- 测试：新增 `proxy.test.ts`（本机假代理验证 fetch 经过代理、WebSocket agent 选择矩阵、拒绝不支持的代理），初版因 EnvHttpProxyAgent
  自读 process.env 而失败，修复后通过；全部 7 文件 34 项通过。
- WSL 实测：中转 WebSocket 经代理 1.6s 得到服务端 401（预期，未带令牌），去掉代理 12.6s；`cindy login` 经代理连到认证服务并给出登录链接
  （未登录、链接未保留）；`https://` 代理被拒绝。临时 Node、探针与脚本已删除，WSL 已关闭。
- 未处理：`cindy-host` 的中转 WebSocket 同样不读代理环境变量（本轮未改）；WSL 内 `sudo` / `apt` 不继承代理需用户以 sudo 配置。

## 工具调用的跨平台情况（2026-11-15，用户提问）

- 机制：远端 Claude Code 自带的 Bash / Read / Write / Edit / Glob / Grep 等被禁用，换成经隧道回到 CLI 本机执行的 `cindy_exec` 工具
  （Desktop 执行器源码，直接引用）；用哪个工具、写什么命令由模型决定，CLI 告诉它平台、shell、系统版本、工作目录与是否 Git 仓库；
  搜索经 Bash 调用 rg / find。Linux 用 `$SHELL`（bash/zsh）→ /bin/bash → /bin/sh；Windows 用 Git Bash，找不到时退回 cmd。
- 发现并修复：① 模型经 Bash 调用 `rg` 依赖 PATH，此前只有内部 glob 用到内置 rg，现把内置或 `CINDY_CLI_RG` 指定的 rg 加入 PATH；
  缺失提示改为如实说明「会改用较慢的 grep/find」。② Windows 没有 Git Bash 时命令会落到 cmd 而模型仍按 bash 写，启动时提示安装
  Git for Windows 或设置 `CLAUDE_CODE_GIT_BASH_PATH`。
- 测试：集成用例新增经 `cindy_exec` MCP 的 Bash 调用，断言输出与工作目录内的写文件副作用；首次运行发现假引擎未处理 SSE 形式的
  MCP 响应（被测代码正确），修正假引擎。Windows（Git Bash）与 Linux（WSL，/bin/bash）均 7 文件 34 项通过。
- 真实验证（Windows，同账号 Desktop，Claude Haiku 5.5）：模型自行选择 Write → Edit → Bash（列目录、系统信息）→ Read，本机文件最终为
  「edited line」。模型提到远端看到的虚拟工作区路径很长、一次绝对路径被映射错后自行纠正——这是 Desktop 远程会话的路径映射行为
  （CLI 原样引用，Desktop 间远程任务相同），本轮未改。

## 呈现与配色：参考 Claude Code 的交互习惯（2026-11-15，用户要求）

- 用户要求参考 Claude Code 的显示、渲染与操作方式，只借鉴交互、不搬代码；实现完全基于现有 ink 界面，未读取任何 Claude Code 源码。
- 呈现：回复 `⏺` 起头、按行解析 Markdown（代码块状态跨流式片段延续，`code` 标记由控制器在提交片段时计算，`markdown.ts`）；
  工具行 `⏺ 名称(参数)` + `⎿` 摘要（`tools.ts`：Read 行数、Edit diff、Write 行数与预览、TodoWrite 清单、其余输出前 4 行 + 剩余行数、
  `<tool_use_error>` 去标签标红；项目目录内路径显示为相对路径；`mcp__a__b` 显示为 `a - b (MCP)`）；状态行带已用时间；
  页脚左侧权限档（full / plan）或「? 查看全部操作」、右侧模型。
- 操作：命令列表 ↑/↓ 选择、Enter 执行选中项；多行输入 ↑/↓ 在行间移动；按词移动与删除、Ctrl+K、Delete 向后删、Ctrl+A/E 改为行首行尾。
- 配色（用户追加要求「不只是黑白」）：`theme.ts` 深色 / 浅色两套取 Desktop token 值（Thinking/Heart Orange `#EA6B17`、info-700、
  status-success、error-fg、warning、text-secondary/tertiary、GitHub diff 前景与底色），`ansi` 用终端命名色。`auto` 启动时发 OSC 11 + DA1，
  等 DA1 回复后才交还 stdin（防止回复漏进输入框），探测期间 Ctrl+C 转为 SIGINT；不支持时用 `COLORFGBG`，再默认深色；
  终端颜色深度不足 256 色或设置 `NO_COLOR` 时用 `ansi`。新增 `/theme` 与配置键 `theme`。
- 兼容：配置文件新增 `theme` 键。读取端对未知键整体报错（既有设计），降级到本批之前的 CLI 版本会因 `theme` 报配置无效：降级前在新版本执行 `cindy config reset theme`，或手动删掉 `config.json` 里的 `theme`。
- 测试：App 新增「Markdown 与工具摘要」「输入编辑」「背景探测协议」「/theme」4 项，修改 1 项既有断言（`⎿` 后两个空格）；cli 配置用例加入 theme。
  CLI 全部 7 文件 41 项通过（见下方交付前检查）。
- PTY 实测（Linux，Node 24，xterm-256color + truecolor，临时脚本打包真实 App + 控制器、假会话）：浅色回复分片到达、深色、终端不支持 OSC 11
  三种情形均判断正确，输入框只收到用户键入的 `hi`、无回复泄漏；输出含 24 位色（Thinking Orange、两套 diff 底色）；用 pyte 回放成图目检
  深浅两套布局正常。临时脚本、虚拟环境与截图在会话临时目录，未进仓库。
- 未验证：真实终端（iTerm2、Windows Terminal、VS Code、tmux、SSH 远端）的背景探测与观感；Windows 控制台字体对 `⏵ ⏸ ✻` 等字形的支持。

## 折叠展开、确认预览、`@` / `!` / 粘贴与状态栏（2026-11-16，用户要求）

- 范围（用户裁决）：继续参考 Claude Code 的交互与显示（只借鉴交互，未读取其源码）；显示类全部做，操作只做 `@` 引用 / `!` 本机命令
  与粘贴（长文本折叠、图片），状态栏（上下文与 token 两行）加颜色与图标。
- 显示：
  - 思考过程：`thinking` 事件收齐后记一行 `∴ 思考了 4s`，内容只进 Ctrl+O 查看器；Subagent 的思考与文本不进主记录。
  - 连续 Read / Grep / Glob / LS 合成一行（`openGroupIndex`：最后一个分组之后只有思考行时仍可追加；视图在回合运行中不提交它）。
  - Subagent：带 `agentMeta.parentUuid` 的 `tool_use` 挂到发起它的 Task 行下（只留最近 3 条 + 计数），`agent_task_update` 的
    用量作为结束摘要（`完成（N 次工具调用 · tokens · 用时）`）。
  - 打断：仍在等结果的调用标「已打断」，并在打断处记 `⎿ 已打断 · 告诉 Agent 接下来做什么`（代替原来的独立提示行）。
  - Ctrl+O 查看器：在活动区逐项显示被折叠的完整内容（工具输出、diff、思考、本机命令输出），不往历史里追加；工具输出保留上限由 2 万字
    提高到 6 万字，超出时查看器注明。
  - diff：行号由本机文件定位（`readText`，≤2 MB；调用已执行时按新文本定位），整行改动前后各补 2 行文件上下文；成对的删/增行标出改动的词。
  - 确认框：Edit/MultiEdit 显示 diff（≤20 行）、Write 显示开头几行、Bash 显示完整命令（≤12 行）；路径摘要保持绝对路径（这是授权决定）。
  - Markdown 表格：流式时尾部的表格行先留在活动区，整张收齐后一次提交并按列对齐、超宽截断；OSC 8 超链接按终端探测开启。
  - 256 色终端：diff 底色原先被就近换成饱和的 `#870000` / `#005f00`（用户截图即此现象），改用调色板 52/22（深色）、224/194（浅色）。
- 操作：
  - `!命令`：本机 `$SHELL -c`（Windows：Git Bash，否则 cmd），去色码，Esc 停止整个进程组；输出（≤3 万字）在下一条消息前以英文说明
    「用户在自己电脑的项目目录里执行了…」随消息发送，`/clear` 丢弃。用户亲手执行，不属于 message-source 规则所指的非本人消息。
  - `@`：`rg --files`（遵守 .gitignore）→ `git ls-files` → 有界遍历（跳过 node_modules）列出文件与文件夹；发送时对本机存在的路径
    附 `mention` 块（绝对路径，由 Desktop 远程代理映射，与 Desktop 相同）。
  - 粘贴：超过 10 行或 2000 字插入占位符，发送时换回全文、记录里保留占位符；粘贴图片文件路径或 Ctrl+V / Alt+V 读剪贴板图片，以 `image` 块
    发送（本机路径，由 `encodeUserMessage` 读取并作为附件传给对方电脑，上限 20 MB）。剪贴板图片存于系统临时目录下本次运行的专用目录，
    退出时删除（credentials-and-local-storage「可丢弃的临时数据」）。
- 状态栏：上下文进度条（<60% 绿、60–80% 琥珀、≥80% 红）、本轮/平均速度信息蓝、费用绿；token 行 ↑ 输入 / ↓ 输出、缓存读写与命中率
  （≥70% 绿、30–70% 琥珀）。文案键由整句改为标签（`usage.context` 等），旧格式断言随之更新。
- 接口变化：`ChatController.submit/steer` 新增可选第二参数（显示文本、图片）；`popQueued` 返回整条排队消息；`ChatDeps` 新增
  `readText / statPath / listFiles / runLocal / clipboardImage`；`ClientRuntime` 新增 `rgPath`；新模块 `chat/local.ts`、`chat/viewer.ts`、
  `chat/width.ts`。`local.ts` 引用 Desktop `executor/shell.ts`（已在闭包允许名单内）。
- 测试：App.test 新增 2 项（折叠/展开/打断，`@` / `!` / 粘贴 / 图片路径），确认预览并入既有确认用例，Markdown 用例加表格并改为逐行流式
  （去掉表格暂缓逻辑时该用例失败，已验证先红后绿）；修改既有断言 4 处（状态栏新格式、`submit` 第二参数、`popQueued` 返回值）。
  为守 5 秒预算，等待由 20 ms 降为 5 ms，Esc 单独等 30 ms（Ink 对单独 Esc 的判定为 20 ms）。CLI 全部 7 文件 46 项通过。
- 手工验证（未进仓库）：真实子进程执行 `!` 命令（退出码、stderr 合并、去色码、Esc 200 ms 内停止 `sleep | cat` 整组）、文件列表回退路径；
  内存 TTY 渲染 + pyte 回放成图目检深浅两套（含 256 色 diff 底色）。
- 未验证：真实终端（含 SSH、Windows Terminal、iTerm2）里的观感与按键（Ctrl+O、Ctrl+V/Alt+V、粘贴的括号模式）、三平台剪贴板图片读取
  （本环境无图形界面）、远端 Agent 实际收到 `@` 引用与图片附件后的行为（需真实账号）、Windows 上 `!` 命令与 Git Bash。

## 进程锁残留（2026-11-16，用户反馈「进程退出后锁还在」）

- 原因：交互模式下 `withProfileLock` 不监听 SIGINT（假定 Ctrl+C 只由界面处理），也不监听 SIGHUP。界面接管终端之前（连接中、背景探测时）
  按 Ctrl+C，或关闭终端 / SSH 断线，进程按默认处理直接退出，`finally` 不执行，`profile.lock` 留下；崩溃与 `kill -9` 同样留下。
- 修复（`profile.ts`）：SIGINT / SIGTERM / SIGHUP 一律中止当前命令并正常收尾（界面接管后 Ctrl+C 是按键而非信号，行为不变）；信号中止的
  启动失败统一报 `COMMAND_CANCELLED`。启动时锁已存在则读其中的 PID：进程不存在（`kill(pid, 0)` 为 ESRCH）即接管；为防两个进程同时
  接管，先把旧锁改名移开、确认仍是同一把旧锁再删，否则放回。没有 PID 的锁 30 秒后才视为残留。进程仍在（含 EPERM）时提示 PID 与锁文件路径。
- 未改：「一个数据目录一个进程」的约束本身（凭证轮换 + 中转同一设备只保留一条连接，见对话结论）；cindy-host 的同名锁有同样问题，未在本次范围。
- 测试：cli.test 新增 1 项（残留锁被接管、SIGHUP 后锁被删除、监听器移除），既有并发用例断言 PID；撤掉接管或 SIGHUP 处理时新用例失败。
  构建产物实测：残留锁（不存在的 PID）自动接管；存活进程占用时报 PID；占用进程退出后可正常启动。

## 高优先级界面与操作优化（2026-11-16，用户确认范围）

- 计划确认：计划按 Markdown 渲染；超过可用行数时只显示开头并注明还有几行，Ctrl+O 查看器在计划确认期间可打开完整计划（Esc 只关查看器）。
- 确认框：Agent 发起的确认可以直接输入文字，Enter 即拒绝并以 `reason` 交回（maker-core 交给模型为
  「User denied this tool call via Cindy: …」，经远程代理原样传给对方电脑）。本机发起的确认（`metadata.hostOwnedConfirmation`，
  如分享供应商的凭证确认）走只返回是/否的 `confirm`，理由会丢失，因此不接受输入。确认、提问与计划期间不弹出 `/` 与 `@` 补全。
- 输入历史：发出的消息与命令按账号存于 `accounts/<hash>/history.json`（与任务记录同目录、0600、原子替换），按项目目录读取，
  去重后移到最新，最多 1000 条、单条 1 万字；粘贴文本存全文，图片占位符去掉。回答 Agent 的内容不进历史。Ctrl+R 反向搜索。
- 提醒：回合运行 ≥10 秒后正常结束，或运行 ≥10 秒时出现确认，向终端写响铃字符；新配置键 `notify`（`bell` 默认 / `off`）。
  兼容：配置读取对未知键整体报错（既有设计），降级到本批之前的版本前需 `cindy config reset notify`。
- 退出：界面关闭后打印「本任务：N 轮 · 输入/输出 tokens · 缓存命中 · 费用 · 工作时间」与 `cindy -c` 提示；/clear 后从零计。
- 状态栏：tok/s 只给数字上色（<20 红、20–50 琥珀、50–100 绿、≥100 蓝），标签与单位不变；用户先看了带色块的版本，要求只给数字上色。
- 测试：App.test 新增 1 项（Ctrl+R 搜索上次运行的输入、发送后记住），既有确认用例加入「输入即拒绝并带理由」「本机凭证确认不接受输入」
  「计划 Markdown 与 Ctrl+O 看全文」；controller.test 新增 1 项（短回合不响铃、长回合与等待确认响铃、退出汇总与 /clear）；cli.test 新增 1 项
  （历史按账号与目录隔离、去重、0600）。撤掉「输入即拒绝」或「长回合响铃」时对应用例失败。CLI 全部 7 文件 50 项通过；App.test 4.5 秒。
- 手工验证：深色主题下四档速度的数字颜色、中文退出汇总文案（内存 TTY + pyte 回放）。未验证：真实终端的响铃表现与 Ctrl+R 按键。

## 接回任务时重放之前的对话（2026-11-16，用户反馈「恢复会话只显示第一句话」，用户确认方案）

- 原因：本地任务记录只存标题，对话历史只在远端 Agent 的原生会话里；CLI 接回时不取回。远端的原生会话迁移接口不支持分享来的供应商
  （用户正在用），且各 Agent 格式不同，未采用。
- 方案（用户确认会在本机保存对话内容，与 Desktop 本机保存对话一致）：每个回合结束、切换任务与退出时，把本任务新显示的行追加到
  `accounts/<hash>/transcripts/<sessionId>.jsonl`（文件名只接受 UUID，0600；工具输出 4000 字、分组项 2000 字、思考 8000 字、本机命令 4000 字封顶；
  超过 4 MB 只留最近 2000 条）。只存消息、回复、工具调用、思考、打断标记、本机命令与错误提示，不存其他提示。
- 接回（`/resume`、`cindy -c`）先读记录：标题行「之前的对话」（太长时注明更早的条数），重放最近 300 条，再显示「已接回」；
  没拿到结果的调用显示为已打断。重放的行不会再写回记录。`-p -c` 不重放，只打印新的回答。
- 任务记录保存时，清理不在记录里的对话文件（超过 200 个任务被挤掉的、从未成功记录的）。
- 测试：controller.test 新增 1 项（重放内容与顺序、不重复保存、-p -c 只打印新回答），cli.test 新增 1 项（追加与读取、非 UUID 不落盘、
  清理无记录的对话文件、0600）。撤掉重放或重放后的「已保存位置」时对应用例失败。CLI 全部 7 文件 52 项通过。
- 未验证：真实账号下长任务的重放观感；本功能之前跑的任务没有本地记录，接回时只显示标题。

## 未验证项

- 跨账号分享的申请/批准/暂停/撤销流程未在真实环境运行（本次使用的是已存在的分享）；提供端为 cindy-host 的同账号路径未实测。
- 真实终端中的 ink 交互（中文输入法、窄窗口、真实终端里的浅色/深色）未目检；配色见「呈现与配色」，PTY 回放截图不等于真实终端目检。
- macOS / Linux 未运行；Linux 需要可用的 Secret Service。

## 验收所需（CC-007）

1. 提供端：已有的 `cindy-host`（Claude Code）在线、`remoteAccessEnabled true`。
2. 同账号：在另一台电脑 `cindy login` 后运行 `cindy`，`/model` 应列出该提供端的模型；发送消息并让 Agent 读写当前目录文件、
   执行命令；验证 Esc 打断、`/clear`、`/resume`、`/permissions normal` 下的确认框。
3. 跨账号：在提供端 `cindy-host share link` 生成链接；另一账号 `cindy received join '<链接>'`，核对配对码后在提供端
   `share approve`；之后 `/model` 中出现「来自 … 的分享」，运行任务并让 Agent 读取 `.env` 验证凭证确认；最后在提供端
   `share pause` / `remove`，确认 CLI 提示不可用。

## 交付（2026-11-15）

- 用户授权：README 与本台账更新后，提交并推送到 fork 的 `feature/cli-provider-host`（origin）。提交带 DCO 签名；提交号以 Git 为准。
- 提交前最终检查：`apps/cindy-cli` 类型检查、构建（含 Desktop 闭包门禁）、7 文件 34 项测试（Windows；Linux 同批通过）、
  `pnpm check:dev-docs`、`git diff --check`。`pnpm check:test-hygiene` 的 21 条失败均在既有 Desktop / Mobile / maker-core 文件，未改基线。
- 不在本次提交内：工作区里此前就存在、未跟踪的 `docs/cindy-cli-mobile-chat-plan.md`（不是本批产物，保持原样）。
- 仍待验收：真实终端交互目检、跨账号分享申请/批准/撤销、Linux 真实账号任务、macOS、提供端为 `cindy-host` 的同账号路径。

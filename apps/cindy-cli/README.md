# Cindy CLI（使用端）

在终端里像 Claude Code 一样使用**远端的 Agent**：同账号另一台电脑（含 `cindy-host` 提供端）上的供应商，
或其他账号**分享给你的供应商**。Agent 在对方电脑运行，读写文件、执行命令回到你这台电脑的当前目录执行。

与提供端 [`apps/cindy-host`](../cindy-host/README.md) 是两个独立程序：各自的进程、数据目录与设备身份，
需要分别登录。计划与验收见 [CLI 使用端计划](../../docs/cindy-cli-client-plan.md) 与
[进度](../../docs/cindy-cli-client-progress.md)。

## 工作方式

和 Claude Code 一样：在哪个目录启动，这个目录就是本次任务的项目目录。远端 Agent 的文件与命令以它为基准、在本机执行；
这个目录及上级目录的项目说明（`CLAUDE.md`、`AGENTS.md`、`.claude/` 下的规则、命令与 Skill）和个人 `~/.claude` 配置随任务同步；
`/resume` 与 `-c` 只看在这个目录开过的任务。默认权限档 full，不做目录信任确认（用户裁决）。

## 构建与安装

Node 22.19+。在仓库根目录安装依赖后：

```sh
pnpm --filter @cindy/cli build
node apps/cindy-cli/dist/cindy.mjs --version
# 可选：链接为全局命令 cindy
pnpm --dir apps/cindy-cli link --global
```

构建同时检查直接引用的 Desktop 源码闭包（见下文「维护」）；出现 Electron 或名单外的 Desktop 模块时构建失败。
远端 Agent 通过 Bash 调用 `rg` 搜索文件：CLI 会把 `CINDY_CLI_RG` 或仓库内 `apps/ripgrep-bin` 的 rg 加到 `PATH`，否则使用 `PATH` 里已有的 `rg`；
都没有时启动会提示，Agent 改用较慢的 `grep` / `find`。Windows 上的命令需要 Git Bash（见下文「Linux 与跨平台」）。

## 使用

```sh
cindy login                      # 官方 Cindy 登录（验证码只在交互中输入）
cindy                            # 在当前目录开始交互任务
cindy -p "总结这个仓库"            # 非交互：打印回答后退出
cindy -c                         # 接着这个目录最近一次的任务（可与 -p 一起用）
cindy received join '<分享链接>'   # 申请使用别人分享的供应商
cindy received list              # 分享给我的供应商
cindy models                     # 列出可用的远程模型（同账号电脑 + 分享来的供应商）
cindy status                     # 账号、语言、数据目录
```

交互界面的斜杠命令：`/model` 分两步，先选供应商（同账号电脑上的供应商与分享来的供应商，显示模型数量和当前项；
连不上的来源置灰），再选这个供应商的模型（Esc 返回上一步）；供应商、模型与 `/resume` 列表可直接输入文字筛选，Esc 先清除筛选，再返回；`/model <id>` 直接切换。其余命令：`/effort`、
`/permissions`（full / normal / plan）、`/plan`、`/compact`、`/clear`、`/resume`、`/status`、`/cost`、
`/context`、`/lang`（en / zh）、`/theme`（配色）、`/trust`（当前分享的长期信任）、`/help`、`/exit`。输入 `/` 会列出命令与参数提示，候选列表随窗口高度滚动；支持按名称、别名或说明筛选，↑↓ 选择，Tab 补全、Enter 执行选中的命令。

在交互界面里输入 `/help`，或在输入框为空时按 `?`，随时查看全部命令与按键操作（按场景分组）。

快捷键（与 Desktop「排队发送 / 插话」同一套语义）：

| 操作 | 按键 |
| --- | --- |
| 发送 | Enter；运行中按 Enter 为**排队**，当前回合结束后按顺序逐条发送 |
| 插话（不打断，当前动作完成后优先处理） | Ctrl+S；输入框为空时插话排队里的第一条 |
| 取回排队消息编辑 | 输入框为空时按 ↑ |
| 打断当前回合 | Esc（或 Ctrl+C）；排队消息随之**暂停**，在空输入框按 Enter 继续发送 |
| 切换权限档 | Shift+Tab（full → normal → plan） |
| 换行 | 行尾 `\` 再 Enter，或 Ctrl+J |
| 历史输入 / 命令补全 | ↑ / ↓（多行输入时先按终端实际折行移动），包括这个项目目录里以前运行时的输入；Ctrl+R 搜索历史（再按 Ctrl+R 找更早的，Enter 采用，Esc 取消）；输入 `/` 后 ↑↓ 选择、Tab 补全 |
| 编辑 | Alt+← / →（或 Ctrl+← / →、Alt+B / F）按词移动；Ctrl+W 删除前一个词；Ctrl+K 删除到行尾；Ctrl+A / E 行首行尾；Delete 删除光标后的字 |
| 引用文件 | 输入 `@` 列出项目里的文件和文件夹（遵守 `.gitignore`），↑↓ 选择，Tab 或 Enter 补全；发送时作为文件引用交给 Agent（与 Desktop 相同） |
| 本机命令 | 行首输入 `!`（输入框变色）后 Enter：在这台电脑的当前目录执行，输出显示在记录里，并随**下一条消息**发给 Agent；Esc 停止 |
| 粘贴 | 超过 10 行或 2000 字的粘贴显示为 `[粘贴的文本 #1，共 N 行]`，发送时换回全文；Ctrl+V（Windows Terminal 等占用 Ctrl+V 时用 Alt+V）粘贴剪贴板里的图片；粘贴或拖入图片文件的路径也会作为图片附上 |
| 展开 | Ctrl+O 打开查看器，看折叠起来的完整内容（工具输出、diff、思考过程、本机命令输出）；↑↓ / PgUp PgDn 滚动，←→ 上一项 / 下一项，Esc 关闭 |
| 退出 | 连按两次 Ctrl+C，或 `/exit` |

Agent 发起的选择：确认框（允许这一次 / 本任务总是允许 / 拒绝）用 ↑↓ + Enter 或数字键，Esc 视为拒绝；也可以直接输入希望 Agent
怎么做再按 Enter，即拒绝这一步并把这段话交给 Agent（本机发起的凭证确认只有允许与拒绝，不接受输入）；
Agent 的提问用 ↑↓ + Enter 或数字键选择，多选题用空格或数字键勾选、Enter 确认，也可以直接输入自己的回答；
计划确认里计划按 Markdown 显示，太长时只显示开头，Ctrl+O 查看完整计划；可以选「批准并开始 / 继续完善计划」，或直接输入修改意见按 Enter
（作为继续完善计划的反馈发给 Agent）。所有确认与提问都可按 Ctrl+O 查看完整说明、选项及操作预览，Esc 返回后再作选择；查看详情不会批准或拒绝操作。

回合运行超过 10 秒后结束，或运行中 Agent 等你确认时，终端会响铃（多数终端在窗口不在前台时会提示）；`cindy config set notify off` 关闭。
退出时清理输入框、活动状态栏并恢复终端模式，已输出的回复与工具记录保留在终端历史；随后打印本任务的轮数、token、缓存命中率、费用与工作时间，以及用 `cindy -c` 接着做的提示。

### 显示与配色

记录的呈现沿用 Claude Code 的习惯：回复以 `⏺` 开头并渲染 Markdown（粗体、行内代码、标题、列表、引用、表格，代码块做通用语法高亮）；
表格、列表、引用和代码块在流式活动区保留结构，块结束后再进入终端历史；表格按列换行，过窄或单元格过长时改为逐条键值显示，保留完整内容；终端支持超链接（OSC 8：iTerm2、WezTerm、
kitty、Ghostty、VS Code、Windows Terminal、VTE 系）时链接文字可直接点击，否则在后面括号里写出地址（`CINDY_HYPERLINKS=1|0` 可强制开关）。
工具调用显示为 `⏺ 工具(参数)`，下方 `⎿` 给出摘要——Read 只说读了多少行，Edit 显示带行号的 diff（行号来自本机文件，改动的词加深底色），
Write 显示写入行数与带行号的开头几行，TodoWrite 显示待办清单，其他输出显示前几行并注明还有多少行（Ctrl+O 展开）；
连续的 Read / Grep / Glob 合成一行（如 `读取了 3 个文件，搜索了 2 次`）；Subagent（Task）自己的工具调用显示在它下面（最近 3 条 + 还有几次），
结束后显示 `完成（N 次工具调用 · tokens · 用时）`；思考过程显示为 `∴ 思考了 4s`，内容在 Ctrl+O 里看；
运行中的工具圆点闪烁，成功为绿、失败为红；打断时还在等结果的调用标为「已打断」，并在打断处显示 `⎿ 已打断 · 告诉 Agent 接下来做什么`。
确认框会显示这一步要做什么：Edit 的 diff、Write 的开头几行、Bash 的完整命令。
状态行显示已用时间（如 `✻ 正在处理… (12s · Esc 打断 …)`），页脚左侧是非默认的权限档（完全访问 / 计划模式）或本机命令模式，右侧是模型。
页脚下方的状态栏来自 Agent 的用量事件，哪项 Agent 没报就不显示：

```
上下文 █████░░░░░ 45% 90k/200k  │  本轮 52 tok/s · 平均 48 tok/s  │  本任务约 $0.420
↑ 输入 12k   ↓ 输出 3.4k  │  缓存 读 1.2M · 写 80k · 命中 93%
```

上下文是最近一次模型请求的占用，进度条与百分比 <60% 为绿、60–80% 为琥珀、≥80% 为红（该考虑 `/compact`）；
tok/s 的数字按速度着色：<20 红、20–50 琥珀、50–100 绿、≥100 蓝；本轮速度在输出时是实时速度、
回合结束后是这一轮的平均；平均速度是本任务各轮输出 token 除以生成时间（不含工具等待）；费用是 Agent 报告的累计花费（Claude Code、Pi 会报，
Codex 与订阅套餐不报），对方电脑上的 Agent 进程重启后接着累计。宿主标记测速不可靠时不显示本轮速度、也不计入平均。
第二行是本任务的 token，各模型相加，进程重启后同样接着累计；输入不含缓存读写，命中率 = 缓存读取 ÷（输入 + 缓存读取 + 缓存写入），
与 Desktop 同口径，≥70% 为绿、30–70% 为琥珀。`/clear` 与 `/resume` 后从零开始。

配色与 Desktop 语义一致（运行中 Thinking Orange、完全访问 Heart Orange、计划模式与选中项为信息蓝、diff 为 GitHub 红绿底色），
分深色、浅色两套。默认 `auto`：启动时向终端查询背景色（OSC 11，查询与连接并行，不增加启动时间；终端不支持时按深色），
终端只支持 16 色或设置了 `NO_COLOR` 时改用终端自带配色。只支持 256 色的终端（经 SSH 连接、未转发 `COLORTERM` 时常见）
diff 底色改用调色板里最深（深色）/ 最浅（浅色）的红绿，避免被就近换成刺眼的饱和色。用 `/theme` 或 `cindy config set theme auto|dark|light|ansi` 固定选择；
切换只影响之后的输出，已经打印的内容保持原色。

输入按完整字符编辑：中文、组合重音和 emoji 不会因左右移动或删除被拆开；长粘贴与图片占位符作为整体移动和删除。长输入在有限高度内滚动，光标保持可见；确认面板打开时暂存当前草稿，关闭后恢复。输入框使用终端原生光标，输入法候选窗的实际位置仍取决于终端支持。窄窗口优先保留输入和确认选项。

### 权限

默认权限档 **full**（与 Desktop「完全访问」一致：Agent 的操作不再逐个确认），可用 `--permission-mode`、
`/permissions` 或 `cindy config set permissionMode normal` 改变。使用**分享来的供应商**时，凭证类文件
（密钥、`.env`、登录凭证等）与读取凭证的命令不论权限档都要你在本机确认（provider-sharing.md §9 第 7 条），
可选「本任务总是允许」。凭证类文件不会随任务启动同步给对方。

长期信任当前分享：在普通输入框执行 `/trust on`，重启后仍有效；`/trust` 查看状态，`/trust off` 关闭。若当前正在等待确认或提问，先处理或取消该面板再输入命令；开关不会自动回答已经弹出的确认。运行中切换对后续操作生效。

也可在 CLI 外管理：

```sh
cindy received list                       # 查看分享及成员 ID、信任状态
cindy received trust <memberId> on         # 长期信任这一个分享
cindy received trust <memberId>            # 查看状态
cindy received trust <memberId> off        # 关闭长期信任
```

启用后，这个分享的任务读取凭证文件、执行涉及凭证的命令不再额外确认；普通权限档仍生效。设置按账号、当前数据目录和分享隔离，存于账号目录的 `provider-share-trust.json`，只含区域、分享 ID 与显式开启项，不含凭证。退出分享或官方名单确认分享已移除时清理；网络失败不会误删。关闭长期信任不撤销已经单独给予的「本任务总是允许」授权。CLI 与 Desktop 使用各自数据目录，不互相改变设置。

### 申请分享

`cindy received join` 先显示分享者、供应商、Agent 运行位置和隐私说明，你确认后才发送申请；之后显示
**配对码**，对方核对后同意即生效，期间按 Ctrl+C 可停止等待（申请仍有效，可用 `received status` /
`received withdraw` 查看或撤回）。生效后在 `/model` 里选择「来自 … 的分享」。

## Linux 与跨平台

Windows 上已用真实账号验证；Linux 已在 Debian 13（WSL2，x86_64，Node 22.22）上验证构建产物与全部测试（含经本机 Bash 的命令执行），
Linux 上的真实账号远端任务、macOS、ARM64 与 musl 尚未实测。

- Node 22.19+：发行版自带的版本通常过旧，用 nvm、nodesource 或官方二进制包安装。
- 工具在本机执行：远端 Agent 的命令、读写文件都在你这台电脑的工作目录里执行；Linux 用 `$SHELL`（bash/zsh），Windows 需要 Git Bash
  （Git for Windows，或用 `CLAUDE_CODE_GIT_BASH_PATH` 指定），没有时启动会提示。
- ripgrep：`apt install ripgrep`（或 `dnf` / `pacman`）；没有时启动会提示，Agent 改用较慢的 `grep` / `find`。也可用 `CINDY_CLI_RG` 指定路径。
- 凭证：Linux 默认保存在当前用户数据目录的 `credentials/` 下（缺省 `~/.local/state/cindy-cli/credentials/`），
  无需安装钥匙串或配置环境变量。文件**不加密**，目录 0700、文件 0600，只认当前用户的普通文件。
  可设置 `CINDY_CLI_CREDENTIAL_STORE=keyring` 使用 Secret Service（需安装并解锁）。旧版钥匙串凭证保持原样，
  升级后可重新登录使用文件存储，或显式选择 keyring 继续使用原登录态。
- 数据目录默认 `$XDG_STATE_HOME/cindy-cli`（缺省 `~/.local/state/cindy-cli`）。如果主目录本身是 Git 仓库（如用 Git 管理 dotfiles），
  会因「数据目录不能在 Git 工作区内」被拒绝，请用 `CINDY_CLI_DATA_DIR` 指到仓库外。
- 代理：自动使用 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`（与 curl 同一惯例；本机地址直连）。登录与 REST 支持 HTTP 代理，
  中转 WebSocket 支持 HTTP CONNECT 与 SOCKS5；`https://` 代理等不支持的写法会在启动时报错，不会悄悄直连。
  WSL2 在 `.wslconfig` 里开启 `networkingMode=mirrored` 与 `autoProxy=true` 时，会自动拿到 Windows 的系统代理，无需另配。
- 按键：Ctrl+S（插话）在原始模式下不会触发终端的 XOFF 暂停；Shift+Tab、Esc 与 tmux / SSH 兼容。
- 构建后 `dist/cindy.mjs` 带可执行位，可直接运行或软链到 `PATH`。

## 设置与数据

- 数据目录默认：Windows `%LOCALAPPDATA%\Cindy CLI`，macOS `~/Library/Application Support/Cindy CLI`，
  Linux `$XDG_STATE_HOME/cindy-cli`（缺省 `~/.local/state/cindy-cli`）；可用 `--data-dir` 或 `CINDY_CLI_DATA_DIR`
  覆盖，必须在 Git 工作区外。同一数据目录同时只能有一个 `cindy` 进程（`profile.lock`，防止两个进程同时轮换登录凭证）；
  上一个进程异常退出（崩溃、`kill -9`、断电）留下的锁，在锁里记录的进程已不存在时会被自动接管。关闭终端或 SSH 断线时进程会正常收尾并删除锁。
  确实被占用时会提示占用进程的 PID。要同时开多个，用不同的数据目录（各自登录一次，在对方看来是两台设备）。
- Linux 凭证默认保存在用户数据目录的 `credentials/`；macOS / Windows 默认使用系统钥匙串。
  `CINDY_CLI_CREDENTIAL_STORE=keyring|file` 可显式覆盖（file 仅支持 POSIX）；切换不迁移或删除旧凭证。
  普通配置与凭证分开保存，`config show` 不会显示凭证。
- `cindy config set language zh|en`、`permissionMode full|normal|plan`、`deviceName 名称`；语言缺省跟随系统，
  `--lang` 只影响本次运行。`/model` 与 `/lang` 的选择会记住。
- 本地任务记录（用于 `/resume` 与 `-c`）：任务标识、远端会话 id、模型和第一条消息的前 80 个字符，以及**本任务在终端里显示过的对话**
  （你的消息、回复、工具调用摘要、思考过程、本机命令与错误；工具输出最多保留 4000 字），按账号隔离，存于数据目录
  `accounts/<账号>/transcripts/<任务 id>.jsonl`（0600，单个超过 4 MB 时只留最近 2000 条）。接回任务时先重放之前的对话（最近 300 条，
  更早的注明条数），`-p -c` 不重放。任务记录最多 200 个，超出或从未记录的任务连同对话记录一起删除。这份记录只在你这台电脑上，
  使用分享来的供应商时也不会传给分享者；远端 Agent 自己的原生会话不受影响。本功能之前跑的任务没有本地对话记录，接回时只显示标题。
- 输入历史（↑ 与 Ctrl+R）保存你发出的消息和命令（像 shell 历史一样，含 `!` 命令；对 Agent 提问与确认的回答不保存），按账号隔离、
  按项目目录区分，存于数据目录 `accounts/<账号>/history.json`（0600），最多 1000 条，单条最多 1 万字；粘贴的图片不保存。
- `cindy config set notify bell|off`：回合结束与等待确认时是否响铃（默认响铃）。

### 本机命令、引用与图片

- `!命令` 只在你这台电脑上执行（Linux / macOS 用 `$SHELL -c`，Windows 优先 Git Bash、否则 cmd），不经过 Agent 的权限档与确认；
  输出（去掉颜色码，最多 3 万字）随下一条消息发给 Agent，`/clear` 后丢弃。使用分享来的供应商时，这段输出与消息一样经过分享者的电脑。
- `@路径` 只在路径真实存在于本机时作为引用块发送；文件内容由 Agent 自己按需读取（读取经本机执行与确认）。
- 剪贴板图片：macOS 用 `osascript`，Windows 用 PowerShell，Linux 用 `wl-paste`（Wayland）或 `xclip`（X11）。图片先存到系统临时目录下
  本次运行专用的目录，发送时由中转读取并传给对方电脑（单张上限 20 MB），`cindy` 退出时删除该目录。通过 SSH 使用时读不到你面前那台电脑的
  剪贴板，请改为粘贴图片文件的路径。

## 首版不包含

本机运行 Agent；远端 Codex；跨区域分享（中国大陆版的分享链接会提示不支持）；Desktop 提供给远端的本机
Cindy 工具（helper、记忆、定时任务、浏览器、插件）、托管 Skill、每轮改动对比、PDF 读取、
供应商组切换与分享组直连执行。

## 维护（个人 fork）

上游不合并本程序，代码由 fork 自行维护。为让上游的 Desktop 修复在 `git merge upstream/main` 后自动生效，
远端会话、执行器、权限门禁、项目说明同步与链路恢复判据**直接引用 Desktop 源码**（不复制、不修改）；
允许名单在 `scripts/desktop-closure.mjs`。需要手工跟进的同步点与合并检查清单见计划文档。

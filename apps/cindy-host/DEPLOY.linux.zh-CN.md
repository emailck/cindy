# Ubuntu VPS 部署 Cindy host

本文面向 Ubuntu 22.04 / 24.04、glibc、x86_64 或 ARM64 VPS。目标是让桌面 Cindy
使用 VPS 上的 Claude Code，文件与命令工具仍回到发起任务的桌面执行。
当前支持同账号、Claude Code 或 Codex（每个进程选择一种）与 relay 通道；Docker 与 Codex Responses API 跨账号分享见 [Docker 部署与审批](DOCKER.zh-CN.md)；本页的密钥环方案不保证无人值守部署。

**验证边界**：仓库已完成 Windows 上的构建、CLI 检查与自动化测试，并完成一次真实
Global Google 登录及跨进程凭证存在性检查。本轮另已验证 Linux 构建、文件凭证登录及 Windows Desktop 到 Linux Codex API 的
真实两机调用。下文 Ubuntu Secret Service、SSH 断开后的进程保留与无人值守运行仍需
按目标环境验收，不能把文件凭证模式的结果当作密钥环模式已通过。当前证据见[进度台账](../../docs/cindy-cli-progress.md)。

Codex 配置参见 [Codex provider](README.md#codex-provider)，选择 Codex 时无需配置 Claude。

## 无密钥环的简化登录

接受凭证以当前用户私有文件保存（不加密）时，可以设置
`CINDY_HOST_CREDENTIAL_STORE=file`，按 [README](README.md#headless-linux-without-a-keyring)
登录。该模式跳过下文密钥环、D-Bus 和解锁步骤；每次启动命令保持相同环境变量和数据目录。
默认密钥环模式及其部署步骤仍保留。tmux 只用于需要断开 SSH 后保持前台服务的情况。

## 1. 准备专用普通用户与依赖

使用专用的普通 Linux 用户运行，不以 root 运行 Claude 或 Cindy。该用户需要自己的
HOME、可写的用户数据目录，以及访问 GitHub、npm、Claude 下载源、Cindy Global 与
Anthropic 服务的出站网络；无需为本方案开放公网入站服务端口。
在该用户的 SSH 终端中安装系统依赖：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils git git-lfs \
  build-essential python3 pkg-config libsecret-1-dev libdbus-1-dev \
  gnome-keyring dbus dbus-user-session tmux
git lfs install
```

本方案通过 `@napi-rs/keyring` 使用系统 Secret Service，不需要安装 Python keyring。
不要删除、覆盖现有 `~/.local/share/keyrings`。若该用户已有正在运行的密钥环，先复用
其会话与已知密码，或由管理员安排独立用户；不要为了照抄本指南启动竞争的密钥环实例。

## 2. 安装固定 Node 与 pnpm

最低 Node 为 **22.19**，建议与验收环境一致使用 **22.22.0**；pnpm 为 **10.33.2**。
已具备这些版本时直接核对，跳过安装。下面是专用新用户的用户目录安装示例，使用
[Node 官方 22.22.0 发行文件及校验清单](https://nodejs.org/download/release/v22.22.0/SHASUMS256.txt)：

```bash
case "$(uname -m)" in
  x86_64) CINDY_NODE_ARCH=x64 ;;
  aarch64|arm64) CINDY_NODE_ARCH=arm64 ;;
  *) printf '%s\n' '此指南仅覆盖 x86_64 / ARM64'; exit 1 ;;
esac
CINDY_NODE_TMP=$(mktemp -d)
CINDY_NODE_ARCHIVE="node-v22.22.0-linux-${CINDY_NODE_ARCH}.tar.xz"
(
  set -e
  cd "$CINDY_NODE_TMP"
  curl --fail --location --remote-name "https://nodejs.org/download/release/v22.22.0/$CINDY_NODE_ARCHIVE"
  curl --fail --location --remote-name https://nodejs.org/download/release/v22.22.0/SHASUMS256.txt
  sha256sum --check --ignore-missing SHASUMS256.txt
  mkdir -p "$HOME/.local/opt"
  test ! -e "$HOME/.local/opt/node-v22.22.0-linux-$CINDY_NODE_ARCH"
  tar -xJf "$CINDY_NODE_ARCHIVE" -C "$HOME/.local/opt"
)
```

仅在上述子 shell 成功退出、校验显示 `OK` 后继续；目标目录已存在时先核对其来源与
版本，不覆盖重装。临时下载目录由 `$CINDY_NODE_TMP` 指出，可在确认安装完成后自行清理。

```bash
export PATH="$HOME/.local/opt/node-v22.22.0-linux-$CINDY_NODE_ARCH/bin:$HOME/.local/bin:$PATH"
npm install --global --prefix "$HOME/.local" pnpm@10.33.2
node --version
pnpm --version
git lfs version
```

预期分别为 `v22.22.0`、`10.33.2` 与可用的 Git LFS。新登录终端需重新配置上述
Node/pnpm PATH；可以在自己的 shell 配置中保存这些**非秘密路径**。

## 3. 克隆 fork 分支、完整安装与构建

使用当前实现所在的 fork 分支；HTTPS 示例不需要把 GitHub token 写进 URL。
若仓库不可公开读取，使用用户已配置的正常 Git 认证，不在命令行中嵌入秘密。

```bash
mkdir -p "$HOME/src"
git clone --branch feature/cli-provider-host --single-branch https://github.com/emailck/cindy.git "$HOME/src/cindy"
cd "$HOME/src/cindy"
git lfs pull
git branch --show-current
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm --filter @cindy/host typecheck
pnpm --filter @cindy/host build
node apps/cindy-host/dist/cli.cjs help
node apps/cindy-host/dist/cli.cjs --version
```

记录实际 commit，便于更新与回退。安装失败就停在该步修复，不加 `--ignore-scripts`，
不只安装 `apps/cindy-host` 子目录，也不更改锁文件绕过失败。完整安装会准备本仓其它
应用的依赖与 runtime 下载，可能占用较多磁盘和时间；**不需要启动 Electron 窗口**。
已知构建可能出现既有 `image-resizer.ts` direct-eval 提示；其它错误不能直接忽略。

显式确保当前平台的仓库固定 Claude 二进制就绪，版本由 `tools/claude/latest.json`
决定，不运行更新 pin 的命令，也不另装会自动变更版本的 Claude 代替它：

```bash
pnpm install:claude
export CINDY_HOST_CLAUDE_BINARY="$PWD/apps/claude-code-bin/$(node -p 'process.platform + "-" + process.arch')/claude"
test -x "$CINDY_HOST_CLAUDE_BINARY"
"$CINDY_HOST_CLAUDE_BINARY" --version
```

Ubuntu x86_64 应得到 `linux-x64/claude`，ARM64 为 `linux-arm64/claude`。
后续命令中的二进制路径与仓库路径应保持一致。

## 4. 在 tmux 内建立持续存在的用户 D-Bus 会话

下面各步都在**同一个 tmux 窗格、同一个 D-Bus 子 shell**中执行。
先检查该专用用户有无已运行的密钥环：

```bash
pgrep -a -u "$(id -u)" -f gnome-keyring-daemon
```

无输出通常表示没有匹配进程（退出码 1）。有输出时先处理已有会话，不使用
`--replace`、删除 keyring 文件或清空密码来“修复”。专用用户没有现存实例时：

```bash
tmux new-session -s cindy-host
dbus-run-session -- bash --noprofile --norc
```

`dbus-run-session` 设置该子 shell 的 D-Bus 地址；bus 随子 shell 存活，退出子 shell
会结束 bus，不能只运行它后切回外层 shell 启动 Cindy。此用法来自
[D-Bus 官方手册](https://dbus.freedesktop.org/doc/dbus-run-session.1.html)。

在新的子 shell 中，准备秘密输入边界与稳定目录：

```bash
set +x
umask 077
case "$(uname -m)" in
  x86_64) CINDY_NODE_ARCH=x64 ;;
  aarch64|arm64) CINDY_NODE_ARCH=arm64 ;;
  *) printf '%s\n' '此指南仅覆盖 x86_64 / ARM64'; exit 1 ;;
esac
export PATH="$HOME/.local/opt/node-v22.22.0-linux-$CINDY_NODE_ARCH/bin:$HOME/.local/bin:$PATH"
node --version
pnpm --version
cd "$HOME/src/cindy"
export CINDY_HOST_DATA_DIR="$HOME/.local/share/cindy-host"
mkdir -p "$CINDY_HOST_DATA_DIR"
export CINDY_HOST_CLAUDE_BINARY="$PWD/apps/claude-code-bin/$(node -p 'process.platform + "-" + process.arch')/claude"
```

数据目录必须是 Git 工作区之外的绝对路径；如果 HOME 本身处于 Git 仓库，另选专用
目录后再继续。**此路径应保持稳定**：系统凭证项的 namespace 来自规范化数据目录的
哈希，换目录不会自动找到旧登录与设备身份。不要把数据移进仓库或复制桌面凭证文件。

## 5. 用非空密码解锁 Secret Service

Ubuntu 的 `--unlock` 从 stdin 读取密码，已有 login keyring 时解锁它；不存在时创建。
`--components=secrets` 只启用本方案需要的服务，`--daemonize` 使守护进程脱离终端。
参数依据：[Ubuntu 22.04 手册](https://manpages.ubuntu.com/manpages/jammy/man1/gnome-keyring-daemon.1.html)、
[Ubuntu 24.04 手册](https://manpages.ubuntu.com/manpages/noble/man1/gnome-keyring-daemon.1.html)。

下列密码是**该 Linux 用户密钥环的密码**，不是 Cindy 或 Google 密码。
已有 keyring 必须使用它的已有密码；新用户则选择并妥善保存一个非空密码。
不要开启 shell 跟踪、终端输入录制或把密码写进历史、脚本和环境文件。

```bash
unset CINDY_KEYRING_PASSWORD
IFS= read -r -s -p 'Keyring password (non-empty): ' CINDY_KEYRING_PASSWORD
printf '\n'
if test -n "$CINDY_KEYRING_PASSWORD"; then
  CINDY_KEYRING_CONTROL_DIR=$(mktemp -d /tmp/cindy-keyring.XXXXXX)
  export GNOME_KEYRING_CONTROL="$CINDY_KEYRING_CONTROL_DIR"
  printf '%s' "$CINDY_KEYRING_PASSWORD" | \
    gnome-keyring-daemon --daemonize --unlock --components=secrets \
      --control-directory="$GNOME_KEYRING_CONTROL" >/dev/null
  CINDY_KEYRING_START_RESULT=$?
  unset CINDY_KEYRING_PASSWORD
  printf 'keyring command exit: %s\n' "$CINDY_KEYRING_START_RESULT"
else
  unset CINDY_KEYRING_PASSWORD
  printf '%s\n' '空密码已拒绝；不要继续登录，重新执行本节。'
fi
```

先 `unset` 再 `read`，防止复用同名已导出的变量；输入变量不 export，密码只经 stdin
交给守护进程，`printf '%s'` 不附加换行。固定的控制目录变量由本地 `mktemp` 创建，
不执行守护进程打印的 shell 代码。控制 socket 在临时目录；加密 keyring 持久存于
该用户自己的 keyring 存储。不要删除正在使用的 socket 目录。

退出码 0 仍需后续凭证探测验证；密码错误、默认 collection 未解锁或 D-Bus 不可用时
不要改成空密码、复制明文 token 或覆盖旧 keyring。
[keyring 项目的无界面 Linux 说明](https://keyring.readthedocs.io/en/stable/#using-keyring-on-headless-linux-systems)
也要求保持会话总线并解锁密钥环；本文使用 Cindy 自身的原生存储实现。

## 6. 分别登录 Cindy 与 Claude

### Cindy：同账号 Google 浏览器登录

```bash
node apps/cindy-host/dist/cli.cjs login --social google
node apps/cindy-host/dist/cli.cjs status
```

当前构建连接 Global 服务；在自己电脑的浏览器中，使用与桌面 Cindy **同一个账号**
打开终端刚打印的完整登录链接。VPS 的 CLI 会继续轮询，成功后输出
`authenticated: true` 并正常退出；随后 `status` 的 `savedAuthentication: true`
表示凭证已保存。链接含短期授权状态，不要发到聊天、工单或日志里，也不要使用会预取
链接的分享入口。直接从终端复制到本地浏览器地址栏；过期或已消费的链接重新发起登录。
服务是否启用某登录方法以官方发现结果为准；不要把 GitHub 当成支持的 social provider。

### Claude：原生订阅或 API 二选一

原生订阅由**未修改的 Claude Code 自己**登录并管理凭证。执行：

```bash
export CINDY_HOST_CLAUDE_AUTH=native
"$CINDY_HOST_CLAUDE_BINARY" auth login --claudeai
"$CINDY_HOST_CLAUDE_BINARY" auth status --json
```

按原生 CLI 给出的无界面登录流程，在自己的浏览器完成操作；若当前 CLI 流程不适用该
VPS，停下核实它的官方登录方式。Cindy 不读取、搬运或代办 Claude 订阅凭证。
不要设置 `CLAUDE_CONFIG_DIR` 复制另一台电脑的登录，也不要把 Windows Credential
Manager / macOS Keychain 密文或 `.claude` 授权文件搬入仓库。

若使用 Anthropic API，跳过原生订阅登录。在同一子 shell 输入 API key：

```bash
export CINDY_HOST_CLAUDE_AUTH=api-key
unset CINDY_ANTHROPIC_KEY
IFS= read -r -s -p 'Anthropic API key: ' CINDY_ANTHROPIC_KEY
printf '\n'
if test -n "$CINDY_ANTHROPIC_KEY"; then
  export ANTHROPIC_API_KEY="$CINDY_ANTHROPIC_KEY"
  unset CINDY_ANTHROPIC_KEY
else
  unset CINDY_ANTHROPIC_KEY
  printf '%s\n' '未提供 API key；不要继续启动。'
fi
```

API key 仅进入当前可信进程环境，不写进配置、仓库、shell 配置或聊天。
保持此 tmux 会话仍有助于后续重启时重新输入；新登录终端、重启机器后需重新提供。
不要执行 `env`、`printenv` 或输出完整环境用于排障。原生订阅与 API 是不同计费路径。

## 7. 开启提供端、诊断与前台运行

```bash
node apps/cindy-host/dist/cli.cjs config set deviceName Ubuntu-VPS
node apps/cindy-host/dist/cli.cjs config set remoteAccessEnabled true
node apps/cindy-host/dist/cli.cjs doctor
```

`doctor` 返回非零时根据检查项处理，不能直接视作成功：

| 检查项 | 通过说明什么 | 尚不说明什么 |
| --- | --- | --- |
| `node` / `data-directory` | 版本及目录基本要求满足 | 服务已联网 |
| `remote-access` | 用户已显式开启提供端 | 任意账号均可访问 |
| `runtime` | 运行适配器已装入 | 已连上 relay |
| `credentials` | OS Secret Service 的写、读、删探测成功 | Cindy 已登录、refresh 成功或 relay 可用 |
| `cindy-login` | 存储中有登录记录 | 登录仍有效；`serve` 才进行恢复与刷新 |
| `claude` | Claude 认证与模型发现通过 | 已完成真实模型调用或桌面工具往返 |

确认这些检查通过后：

```bash
node apps/cindy-host/dist/cli.cjs serve
```

应先看到 `Cindy provider online (same-account Claude, relay transport).`，再看到
`Cindy host is ready. Press Ctrl+C to stop.`。这说明本次启动已完成 relay 握手；
持续在线情况还需桌面观察。桌面应登录相同 Global Cindy 账号，找到该 VPS 提供的
Claude 供应商并选择它，验证消息流、本机文件与命令、停止和提问确认。
最高权限仅在桌面未指定权限时作为 fallback，桌面明确权限、账号与会话归属校验仍然生效。

## 8. SSH 断开、停止与恢复

### 调整闲置 Agent 的保留时间

默认闲置 30 分钟后收回 Agent。可在提供方设置 `idleMinutes`（0～1440 的整数），
0 表示不因闲置收回；正在运行的任务不会被闲置回收，延长保留会持续占用内存和任务名额。
tmux 保持主进程运行，但不会关闭闲置回收。

先在原 tmux 窗格按 Ctrl+C 正常停止 `serve`，保持原数据目录和环境变量，再执行：

```sh
node apps/cindy-host/dist/cli.cjs config set idleMinutes 120
node apps/cindy-host/dist/cli.cjs config show
node apps/cindy-host/dist/cli.cjs serve
```

不希望闲置回收时改为 `config set idleMinutes 0`；恢复默认用
`config reset idleMinutes`（删除覆盖值）。配置在重启后生效；运行期间修改会返回
`PROFILE_BUSY`。这不改变断网、进程退出时的清理规则。

- **暂离 SSH**：在 `serve` 前台运行时按 `Ctrl+B`，松开后按 `D`，脱离 tmux；重新
  SSH 后使用 `tmux attach-session -t cindy-host` 返回原来的 D-Bus 窗格。不要在另一个
  SSH shell 里新建 D-Bus 后假定它能访问原来的已解锁服务。
- tmux 通常可跨 SSH 断开保留进程，但 VPS 的 logout/session 清理策略仍可能终止它；
  首次部署必须实际断开、重连验证。**机器重启不会自动恢复此方案**。
- **正常停止**：返回运行窗格按 `Ctrl+C`，等待回到 shell。不要首先 `kill -9`。
  已发出的凭证刷新要等权威响应并保存轮换结果，网络挂起时退出可能等待；强制杀进程
  可能要求重新登录，不能承诺无损恢复。
- **同会话重启**：进程完全退出后，在原 D-Bus shell 中再次运行 `serve`；API 模式的
  父 shell 会保留已导出的 key，Node 子进程的环境清理不会改写它。换新 shell、机器
  重启或自己显式 `unset ANTHROPIC_API_KEY` 后，需要按第 6 节重新输入。配置修改、login/logout 与
  serve 共享 profile 锁，修改前先停止对应 host。
- **重启服务器后**：恢复正确 PATH，在新 tmux/D-Bus 会话中使用旧密码解锁既有 keyring，
  保持相同 Linux 用户与相同数据路径，重新配置 Claude 环境再运行 `doctor` / `serve`。
  保存的 Cindy 登录可能需要重新认证，以实际 refresh 结果为准。

遇到 `PROFILE_BUSY`，先检查 tmux 窗格、`pgrep -a -u "$(id -u)" -f 'cli.cjs'` 及
`profile.lock` 中的 PID，并使用 `ps -p PID -o pid,user,lstart,args` 人工核实其身份与
启动时间；PID 可能已被复用。**不提供盲目删除锁的命令**。只有确认没有该 profile
的活进程、没有在途刷新且需要保留的数据已备份后，才由管理员处理确认为遗留的锁。
保留一个活着的旧进程同时删除锁，会导致同一凭证被并发轮换。

## 9. 更新与备份

1. 停止 `serve`，等待正常退出；记录当前 commit、Node/pnpm/Claude 版本和稳定数据路径。
2. 在仓库之外、仅本人可访问的位置备份该数据目录，并按 OS 既有安全备份机制保护
   Linux keyring 与自己的解锁密码。数据目录可能包含任务历史，按私密数据处理。
   仅备份数据目录不等于备份了系统凭证；不要导出明文 token。
3. 保持用户、HOME 与数据目录原位，检查 `git status --short`。有本地修改时先处理，
   不使用 `reset --hard`。工作区干净后，执行：

```bash
cd "$HOME/src/cindy"
git fetch origin feature/cli-provider-host
git merge --ff-only origin/feature/cli-provider-host
git lfs pull
pnpm install --frozen-lockfile
pnpm install:claude
pnpm --filter @cindy/host typecheck
pnpm --filter @cindy/host build
node apps/cindy-host/dist/cli.cjs --version
```

4. 重新核对固定 Claude 版本和环境，在原用户会话运行 `doctor` / `serve`，再从桌面做
   一次实际调用。更新失败保留数据和旧 commit，先核对存储兼容性再决定回退，不把旧
   数据覆盖到仍在运行的新进程上。

跨 OS / 换用户 / 改数据路径不是简单复制部署目录：凭证受 OS 和 profile namespace
约束。优先在目标系统重新登录，不能把另一台电脑的系统密文当作可移植凭证。
本文没有提供 systemd 自动解锁、开机自启或无人值守的保证；这些需要另行设计并实机验收。

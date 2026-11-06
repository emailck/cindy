# Docker 运行与供应商分享

当前容器为 Global 提供端，支持原生 Codex Responses API（包括中转）的直接账号分享。
分享复用官方一次性邀请与审批协议、桌面版的成员准入判据、持久成员代次/用量账本、
远程 Agent 宿主、访客隔离与 loopback 代理。CLI 也已接入 ChatGPT 官方登录与 Claude
官方订阅分享（配置与凭证边界见 README）；此容器流程仍以 Codex API 为例，
官方订阅的容器内运行尚未实测。此入口暂不提供转分享与供应商组。

## 构建与首次登录

从仓库根目录执行：

```bash
docker compose -f apps/cindy-host/compose.yaml build
```

镜像以普通用户运行，不开放公网管理端口。两个命名 volume 分别保存 Cindy 登录/设备身份
与 Codex 原生配置。不要删除 volume 来更新镜像，否则会丢失登录或任务数据。
构建时只复制代码和公开端点，凭证不能放入构建上下文或镜像。

首次启动先登录 Cindy 并打开提供端开关：

```bash
docker compose -f apps/cindy-host/compose.yaml run --rm cindy-host login --social google
docker compose -f apps/cindy-host/compose.yaml run --rm cindy-host config set remoteAccessEnabled true
```

浏览器链接在你自己的电脑打开。Cindy 凭证使用容器内的私有文件（目录 0700、文件 0600），
不加密；管理命令复用后台服务的认证，不再次登录。

把已经能工作的 Codex API 配置准备到 `codex-data` volume（容器内 `/var/lib/cindy-codex`）。
可以用独立容器的交互 shell编辑文件，或将你自己管理的、仓库外的 Codex 目录绑定到这个
路径；运行用户 UID 1000 必须能读写它。不要把主人的配置/凭证放到仓库里。中转 `base_url`、
模型等仍在原生 `config.toml` 中配置；API Key 用 Codex 原生登录保存，或通过容器运行环境
中的对应 `env_key` 注入。不要将真实 Key 写进 Compose 文件、命令参数或镜像。

例如进入配置 shell（不启动后台服务）：

```bash
docker compose -f apps/cindy-host/compose.yaml run --rm --entrypoint sh cindy-host
```

若使用仓库外、已安全保存的 Key 文件，可在宿主机通过只读挂载和标准输入登录：

```bash
docker compose -f apps/cindy-host/compose.yaml run --rm -T \
  -v /absolute/private/codex-api-key:/run/secrets/codex-api-key:ro \
  --entrypoint sh cindy-host \
  -c '/opt/cindy-host/codex/bin/codex login --with-api-key < /run/secrets/codex-api-key'
```

替换示例文件路径，并确保容器用户可读取它。真实 Key 不出现在参数或 shell 历史中。
已经通过绑定原生 Codex 目录提供认证时，无需再登录。准备完成后运行：

```bash
docker compose -f apps/cindy-host/compose.yaml run --rm cindy-host doctor
docker compose -f apps/cindy-host/compose.yaml up -d
docker logs -f cindy-host
```

## 生成链接与审批

以下命令在宿主机执行，后台服务无需 TTY，也不需要 `docker attach`：

```bash
docker exec cindy-host cindy-host share link
docker exec cindy-host cindy-host share list
```

`share link` 在当前终端返回一次性链接和到期时间；链接口令在 `#` 后，不写服务日志。
受邀者在自己电脑的 Cindy 打开链接并申请。服务日志会提示服务端核实过的身份、申请 ID 和有效期。配对码仅通过私有管理终端的
`share list` 查看，不写服务日志。你应与受邀者核对身份/配对码，再明确批准：

```bash
docker exec cindy-host cindy-host share approve REQUEST_ID 1234
docker exec cindy-host cindy-host share reject REQUEST_ID
```

将示例 ID 和配对码替换为真实申请。得到链接不等于获权，未批准时不能使用模型。
已批准的成员可管理如下：

```bash
docker exec cindy-host cindy-host share pause MEMBER_ID
docker exec cindy-host cindy-host share resume MEMBER_ID
docker exec cindy-host cindy-host share remove MEMBER_ID
```

暂停会停止该成员的运行，恢复后可重新使用；删除还清理该成员在本机的访客记录与镜像。
账本沿用桌面版，删除/重新批准按服务端 `joinedAt` 区分成员代次，清理完成前不开放新代次。
`share list` 同时列出申请、成员及累计用量。命令通过容器内权限 0600 的 Unix socket
请求正在运行的服务，不另开会旋转登录令牌的认证实例。

非 Docker 环境使用相同的 `cindy-host share ...` 命令，前提是同一数据目录的 `serve`
正在运行。若显示 `SHARE_CONTROL_FAILED`，先检查服务是否启动、数据目录是否一致，以及
请求 ID / 配对码是否有效。`SHARE_PROVIDER_UNSUPPORTED` 表示当前原生认证类型尚未接入
跨账号分享，不能通过放宽成员校验绕过。

## 验证边界

自动化验证使用假账号 API、假 Key 和本地模拟上游，包括审批/暂停/删除、跨账号协议帧、
本地管理 socket、原生 Codex 访客运行、主人的说明/凭证隔离及代理的模型/令牌检查。
实际官方服务的两账号审批与 Docker 镜像构建/运行，必须在可用环境执行后才能记为通过。

## 单机网页管理

`tools/cindy-host-manager` 为独立的本地管理工具；构建上面的同一个镜像后，在管理工具
配置中固定 `CINDY_MANAGER_IMAGE=cindy-host:local`。启动与管理员认证见该工具 README。
镜像运行的是无 Electron 的 Cindy CLI，不包含桌面界面、VNC 或浏览器管理端口。
镜像同时包含仓库 pin 的 Codex 和 Claude Code，默认入口仍为 `cindy-host serve` 和 Codex；
手动 Compose 用户的现有卷与路径不变。下载使用仓库已有校验器，不刷新版本 pin。

管理工具创建实例时固定一个引擎，并分配两份独立命名卷：Cindy profile，以及原生 CLI 的
HOME（包括 `.codex`、`.claude` 与 `.claude.json`）。两类登录分别由 Cindy 和对应原生 CLI
完成；后台只转接临时容器 TTY，不读取 Claude 凭证。业务容器不挂载 Docker socket，
不提供通用 shell，也不保存登录终端日志。停止和重新创建服务容器均保留两份卷。
管理端能控制本机 Docker，必须仅向受信管理员开放，远程使用时由 HTTPS 反向代理保护。

先停止实例，再打开任一种登录终端；完成登录后启动实例。启动会先执行固定的
`config set remoteAccessEnabled true` 命令，再启动独立服务容器。服务运行状态只说明
容器在运行；检查显示保存的 Cindy 登录与原生 CLI 认证结果，不代表 relay 已就绪。
分享管理只调用运行服务内的 `cindy-host share`，不会另起认证实例。

管理工具在创建及每次检查、登录、启动前，以实例 UID 1000 初始化缺失的原生目录：
Codex 的 `HOME/.codex` 或 Claude Code 的 `HOME/.claude`。新目录权限为 0700；
既有配置、凭证和目录权限保持原样。旧实例缺少目录时使用上述管理操作即可补齐，
无需删除卷或重新登录 Cindy。目录是链接、所有权不符或不可写时明确失败，不递归改权限。
Codex 状态仅将原生命令明确返回 `Not logged in` 视为未登录；其它非零结果显示未知，
不能用“未登录”掩盖原生配置加载错误。

可选代理首版支持 `http://` CONNECT 代理（包括 HTTPS 目标站点），同时下发
HTTP_PROXY/HTTPS_PROXY 及小写变量；localhost、127.0.0.1、::1 保持直连。`https://`
代理服务和 SOCKS 暂不支持，配置会被拒绝。代理仅对实例显式选择 default 的后续启动和
登录生效；原生 CLI、服务原生进程和 Codex 分享转发使用同样配置。Cindy 自身登录与
Device Link 继续使用既有网络路径；这不是强制出口隔离。代理地址必须在容器网络中可达，
容器内 localhost 指向容器本身。真实代理出口与真实账号登录须在部署环境验收。

停止仅发送 SIGTERM 并等待退出，不隐式 SIGKILL；超时明确失败并保留资源，不会并发启动
登录或覆盖 profile。取消登录也等待该临时容器实际退出。进程崩溃留下 `profile.lock` 时，
工具不会自动删除锁：管理员先确认该实例所有容器停止、没有其它进程或手工挂载使用这些卷，
再在受控运维终端恢复。不要通过删卷解决锁或认证问题。

2026-11-06 镜像验证发现现有 pin `sharp 0.35.3` 的 npm audit 高危报告：
`GHSA-rgj7-g3m4-5g8c`（libheif，影响 `<0.35.4`）与 `GHSA-wq5f-xc86-pv6w`
（librsvg，影响 `<0.35.5`）。这是既有直接依赖，管理工具未升级或放宽版本；需单独做
依赖升级与媒体回归，不能把当前镜像记为依赖审计全通过。

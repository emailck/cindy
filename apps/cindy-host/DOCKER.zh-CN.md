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

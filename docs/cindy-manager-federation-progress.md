# 单机 Manager 集中管理进度

依据：[独立实施计划](cindy-manager-federation-plan.md)。本次不参考或续写历史计划。

| 任务 | 状态 | 负责人/范围 | 证据与下一步 |
| --- | --- | --- | --- |
| FED-001 | 已完成 | 主 Agent：计划与本进度 | 已核对源码、测试和专项规则，冻结单机独立管理边界与网页 API |
| FED-002 | 已完成 | federation 子 Agent：federation 模块/store | 认证、连接、去重、登录租约已实现；独立审查修复 attach 确认丢失后的占锁 |
| FED-003 | 已完成 | wiring 子 Agent：server/main/集成测试 | 接线、模式和 CLI 完成；增补重连中的延迟登录和接入 5xx 回归 |
| FED-004 | 已完成 | ui 子 Agent：web；主 Agent 浏览器验收 | 电脑列表、概览、接入与撤销、原管理页复用；Light/Dark/390px 目检 |
| FED-005 | 已完成 | 主 Agent：集成/验证/说明 | 52 单元、22 集成、typecheck/build 通过；浏览器及交叉 review 完成 |

已有工作区包含其它 remote-agent/maker-core 的改动，本次不覆盖。
未部署、未修改正式实例和账号。

## 实际实现与审查

- 独立 `central` 模式无 Docker adapter；默认 `standalone` 保留原数据目录、实例表、管理员
  登录与所有本机能力。单机 ManagerService 同时服务本地和中央，不拆 Worker。
- 中央节点注册只保存 verifier；一次性码 10 分钟有效。单机先加密保存自行生成的连接
  凭证再交换，网络错误或网关 5xx 保留凭证并明确结果待核实；明确拒绝才移除未生效连接。
- 浏览器 session id 不传给单机，按节点转换为不透明 owner；连接代次、撤销记录和租约
  防止旧连接复活登录。已退出 owner 的登录取消，其他 owner 与 CLI 实例不受影响。
- 单机 journal 仅保存操作 ID、输入摘要及结果状态，不保存正文、Proxy 密码、终端输出或
  邀请内容。写操作不自动重发，重复 ID 返回需核实，不保证跨重启重放原始响应。
- scoped HTTP 和终端沿原白名单服务路径；终端继续只读，显式单行回答才进入原生 CLI。
- 交叉审查修复：attach 已执行但 ACK 丢失后发送 scoped detach，避免留下不可达的占锁
  登录；过期终端帧仅影响对应流；本地非法终端输入立即进入取消，消除 close 时序竞态。
- 前端按机器绑定 Api/WebSocket，切换和离线卸载管理页并清空敏感状态；电脑列表每 10 秒
  只读刷新，聚焦/网络恢复也读取。选中电脑滚动并聚焦对应管理区。

## 已有验证证据

- 独立包单元：52/52，通过（串行单 worker，8.43 秒）；包含 App 18 项、Terminal 8 项。
  UI 新增测试单文件独立运行 App 4.69 秒墙钟，Terminal Vitest 1.01 秒。
- 最终整套集成 22/22，通过（4.39 秒）：原单机 13 项、两节点生产 HTTP/WS 5 项、
  协议/生命周期 4 项。两份新增文件独立执行分别为 Vitest 1.70 秒、墙钟 2.19 秒；
  覆盖接入 5xx、延迟原生登录跨重连、写操作结果丢失、attach 确认丢失和不兼容版本。
- 最终 `npm run typecheck`、`npm run build` 通过（Vite 2.82 秒）；`git diff --check` 通过。
- `pnpm check:dev-docs`：10/10；`pnpm check:i18n-glossary`：通过，18 处既有 proposed
  术语提示非阻断；`pnpm check:test-hygiene`：通过（356 文件基线，未改基线）。
- 实际 Chromium + 三个隔离 loopback 服务 + 合成 runtime：中央列出两台机器；从中央
  打开 B 的实例、读取合成账号展示、点击启动；分别访问 A/B 本机 API 验证 B 已运行、A
  保持原状。控制台无错误。Light、Dark、390px 中文布局实机目检，无横向溢出。
  浏览器测试使用标准 Playwright Chromium 的默认安全设置。
- 构建产物 CLI 实测 `init` / `serve`：central 模式指定不存在的 Docker socket 仍成功启动，
  `/api/session` 正确报告 central 与未登录；随后优雅关闭。
- 临时测试账号、数据库及截图全部位于仓库外，未接触正式登录凭证或实例。
  三个浏览器验收服务与 CLI smoke 服务已关闭，其私有临时数据库已清理。

## 交付边界

代码与本地验收不代表已部署。未验证多台物理机、真实 HTTPS 反代后的跨网络连接、真实
原生 OAuth 登录或付费模型调用；Docker runtime 复用原实现，本次未重新运行真实 Docker
smoke。新增协议不改 Device Link/官方服务端，自建中转无变更。
接入/断开 CLI 复用数据目录锁，需先结束活跃原生登录并停止该单机 Manager 进程，然后
操作并重启 Manager；不停止或删除 CLI 实例、账号和数据卷。操作说明见 Manager README。

## 最终验收与下一步

FED-001 至 FED-005 的源码开发和本地验收完成。所有本轮差异已 review；专项交叉审查
发现的 attach 占锁问题已有生产入口回归，无未解决的已确认 P0/P1。现有其它工作区改动
保留。新增文件尚未提交，未执行 commit/push/部署或正式服务重启。

后续部署应使用独立中央数据目录，先更新单机 Manager，再逐台通过一次性码接入；
核验 HTTPS/WSS、真实两台机器、本地独立管理以及原生登录/分享。凭证和实例数据不搬迁。

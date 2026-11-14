# 单机 Manager 集中管理实施计划

状态：开发与本地验收完成，未部署。事实与验收见 [进度](cindy-manager-federation-progress.md)。
本计划独立制定，以当前代码及本次用户确认的需求为依据，不沿用历史计划。

## 目标与边界

多台机器各自运行完整的单机 Manager，拥有自己的管理员登录、实例目录、Docker、Cindy 与
原生供应商账号、Proxy 配置和数据。中央提供统一浏览与操作入口；请求由所属单机执行。
单机可以独立打开与管理；中央关闭不影响单机 HTTP 服务及已运行实例。
中央不调度任务，不持有原生账号凭证，不复制实例数据库，不迁移实例，不变更官方 Server、
Device Link、Desktop、Mobile 或模型运行协议。中央高可用与跨机故障接管不在本次范围。
本次授权为开发和本地验证；部署、重启正式服务、提交和推送不在本次实施动作中。

## 当前代码证据

- `tools/cindy-host-manager/src/server.ts`：会话/CSRF/Origin 校验、HTTP API、登录 WebSocket。
- `src/service.ts`：实例互斥和登录归属集中在单机 ManagerService，必须继续共用同一对象。
- `src/store.ts`：实例与加密 Proxy 使用本地 SQLite；不往 instances 表写中央远程投影。
- `src/docker-runtime.ts`：本机 Docker 与受归属校验的数据卷；集中管理不拆成 Worker。
- `web/App.tsx`、`web/api.ts`、`web/Terminal.tsx`：管理界面与登录交互可按机器绑定请求前缀复用。
- 已有 backend.integration、docker-runtime、App、Terminal 测试覆盖单机生产入口。

## 架构与接口合同

新增可选 central 运行模式；缺省保持 standalone。中央无需 Docker 可用即可管理远端。
每个单机最多主动接入一个中央，使用 WSS 长连接；仅本地回环测试允许 WS/HTTP。
中央网页使用自身会话与 CSRF，不能转发用户 Cookie 或单机管理员密码。
机器身份独立于浏览器身份：中央产生短期一次性接入码，单机显式接入后持久化独立凭证，
中央只保存其验证材料。单机连接凭证复用现有私有目录及 AES-GCM 存储，不放在命令参数、
URL、日志或仓库。支持中央撤销及单机主动断开，均不删除实例或停止运行中的实例。

网页 API：

- `/api/session` 增加可选 `mode: 'standalone' | 'central'`，旧调用兼容。
- `GET /api/federation/nodes` → `{nodes:[{id,name,online,lastSeen:string|null}]}`。
- `POST /api/federation/nodes` `{name}` → `{node,enrollmentToken,expiresAt}`，接入码只显示一次。
- `DELETE /api/federation/nodes/:nodeId` 撤销该节点，关闭其管理连接。
- `/api/federation/nodes/:nodeId/api/...` 转发原实例、settings、proxy/test API 的响应形状。
- `/api/federation/nodes/:nodeId/api/logins/:loginId` 转发登录 WebSocket。
- 接入交换及机器长连接端点独立验证机器凭证，不接受浏览器会话代替机器身份。

后端共享边界：通信模块提供 FederationHub（节点登记、撤销、请求和登录流转发）与
单机 Connector（显式白名单分发到同一个 ManagerService、管理连接生命周期）。HTTP 服务
负责中央浏览器会话授权，Connector 负责远程 owner 的作用域和有效性。
具体 TypeScript 接口由通信负责人先输出给接线负责人，避免消费者猜测接口。

只允许既有受管实例操作，不提供任意 URL、Shell、文件或 Docker 请求透传。协议握手必须
声明版本，不兼容明确拒绝。机器级连接代次隔离旧连接，浏览器 owner 隔离登录交互。
请求携带唯一操作 ID；网络中断或超时不自动重发写请求。单机核对操作 ID/输入摘要，
同一操作不得重复执行；跨进程结果不可证实时明确待核实，不伪造成功或重新执行。
持久操作记录不得保存登录输出、验证码、Proxy 密码或邀请内容。

本地和中央操作复用实例锁；远程登录有租约和断线清理，中央退出及会话过期撤销对应登录，
不得撤销其它本地/远程用户登录。取消失败不得释放仍占用 profile 的互斥。
中央不缓存持久账号数据；列表按机器隔离失败，不因一台离线阻断其他机器。离线保留
机器名称、最后在线时间，不能把离线解释成实例已停止。重连/页面聚焦恢复读取。

## 页面与配置

中央提供机器列表、全部实例概览、机器选择及接入/撤销入口。选中机器后复用现有单机管理
界面；页面请求及登录流绑定机器，切换时旧回包不得污染新机器。机器级 Proxy 与登录结果
仍以单机为准。界面中文/英文、Light/Dark 同时实现，复用语义 token；实机目检单列证据。
单机保留原入口；接入使用本地显式命令，从 stdin 读取一次性码；提供断开命令。
中央配置为显式启动选择，不能自动把原单机数据库解释成中央远程目录。

## 任务与验收

| 编号 | 任务 | 责任文件 | 验收 |
| --- | --- | --- | --- |
| FED-001 | 新计划与接口冻结 | 本计划/进度 | 符合完整单机独立管理边界 |
| FED-002 | 认证、反向连接、白名单 RPC、操作去重、远程登录生命周期 | 新 federation 模块、store.ts 必要扩展 | 两节点隔离、过期/重放/撤销拒绝、断线不重放写操作 |
| FED-003 | HTTP/WS 接线、运行模式、接入/断开命令 | server.ts、main.ts、后端集成测试 | 本地与中央共用锁/服务；中央无 Docker 可用；本地仍可单独使用 |
| FED-004 | 中央页面、机器切换、原页面/终端复用 | web/** | 正确路由、隔离旧回包、离线、双模式、中英文 |
| FED-005 | 集成 review、回归、说明与交付 | README、必要构建/测试配置、本进度 | 类型/构建/单元/集成通过；两节点生产入口验证 |

依赖：FED-001 → FED-002/003/004（先冻结接口）→ FED-005。
每个文件唯一负责人；具体实现由子 Agent 执行，主 Agent 维护文档、集成与验证。

## 验证与风险

测试使用明显虚构身份、仓库外私有临时目录及隔离端口，不读取正式账号。
新增用例通过生产 HTTP/WS、Connector、ManagerService 验证；运行时间和 tier 记录在进度。
验证节点 A/B 同名或同实例 ID 不串线、本地与远端互斥、身份撤销、退出清理、连接替换、
失联操作结果、进程重启、单机存量数据兼容。终端保持只读与独立单行回答合同。
运行独立包 typecheck、test、test:integration、build，文档和相关 i18n/测试卫生检查。
真实 Docker、多物理机、原生账号授权与真实部署分别记未验证，不能由 fake runtime 冒充。
新增权限仅作用于明确接入的单机 Manager；没有修改已部署凭证及历史 migration。

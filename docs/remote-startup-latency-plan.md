# 远程启动延迟修复

当前实施与现场事实见 [进度](remote-startup-latency-progress.md)。本轮直接修复，不依赖历史 CLI 开发计划。

目标：修复 CLI 启动诊断缺口、后续 Skill 分支未批量查询与 allocate 兼容问题。用户明确不修改 Desktop；不能仅据源码给现场 80.819 秒归因。

| 编号 | 责任与范围 | 验收 |
| --- | --- | --- |
| START-1 | host 子 Agent：CLI runtime logger、共享 startupTiming、execServer batch | CLI 实际输出固定字段阶段计时与版本；区分 shortcut 与 batch 计数；未知/权限失败真实转发 |
| START-2 | codex 子 Agent：CodexAgent、app-server host、CLI codex 接线 | 区分进程/initialize、隔离鉴权、能力查询、environment/add、thread/start；保留隔离与配置生效顺序 |
| START-3 | 已取消：Desktop 修改 | 本轮 Desktop 修改全部撤回，保持原调用链 |
| START-4 | 主 Agent：静态集成核对 | review 全部 diff；按用户限制不启动测试/类型检查；构建按后续授权限资源串行执行，明确未验证项 |
| START-5 | host 子 Agent：CLI 专用增量批量查询 | 后续 Skill 分支追加预取、精确 URI 去重；累计合成请求预算耗尽仍转发真实查询；Desktop 默认行为不变 |
| START-6 | host 子 Agent：CLI allocate 兼容 | 已授权 guest 返回现有 null 本机路径，不生成委托、不声明 directGuestExecution、不改变 open 权限检查 |

START-1/2 共享固定诊断事件名，接线由 START-1 唯一负责；不修改共享 wire。START-4 仅核查 CLI 相关改动。
用户反馈资源占满后停止并行验证，后续仅按明确授权限资源串行构建；测试与类型检查未重跑，未完成验证如实登记，不以 mock 冒充实机。
实际矩阵应比较同模型的同账号/跨账号、无 Skill/最小 Skill、首轮/第二轮及 Windows→Linux，分别测就绪、首文本、首轮完成。

风险边界：只记录固定阶段、耗时、结果、短关联 ID、计数与版本，不开放通用底层日志；不共享受邀者引擎、不移除隔离检查，不缩短超时、不减少 Skill 或关闭能力。后续用户已授权构建部署、管理台启动及本分支提交推送；未授权合并主干。本轮不改变 wire 或自建中转转发协议。

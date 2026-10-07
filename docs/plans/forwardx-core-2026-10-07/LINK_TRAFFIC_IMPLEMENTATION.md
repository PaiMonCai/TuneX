# 核心后续切片：FXP 每规则流量与额度事实

日期：2026-10-07。开发分支：`feat/forward-core-abcd`。基线：已推送的 ABCD `8b0abbc`，草稿 PR #75。支付继续后置。

## 1. 目标与事实链路

复用 ForwardX FXP 已有 TCP/UDP payload 计数，不另写一套模拟流量。入口的两类协议汇入同一 Forward 计数，出口不再计一遍；加密帧开销不是本轮计量口径。

链路：FXP 私有累计快照 → Agent 加密身份清单和持久化水位 → 节点认证 `POST /api/internal/node/link-traffic` → 数据库事务内更新 `LinkTrafficCheckpoint` 与现有 `TunnelTraffic` 日事实 → 现有仪表盘/流量趋势/Workspace 额度检查及 Link 详情。

`LinkTrafficCheckpoint` 是去重水位，不是第二份额度。额度仍读取 `TunnelTraffic.traffic`；不把 FXP 用量送入旧 Redis“同日只归档一次”缓冲，以免同一天后续增量被丢弃。

## 2. 身份、重试与删除

- 每次新 FXP 进程独立生成 128-bit producer；热更新保留同一 producer 和累计值。
- Agent 将 placement、节点、Workspace、Link 及 Forward 初次进入该进程时的 generation/digest 绑定在加密清单中。以后规则修改仍使用该不可变计量归属；新增规则先保存其清单，再更新子进程。
- 后端用不可变部署快照及入口 placement 核验每个 Forward，不靠请求自报节点 ID，也不要求业务 Forward 仍存在。因此删除后最后一批流量、旧进程积压和暂停后的事实仍可入账。
- 唯一水位为 node/producer/Forward/上海日期；整个批次先验证授权再在同一事务锁定水位和日事实。重复或任何计数字段倒退的报告不增加用量；改归属拒绝；写入或提交失败不返回存储 ACK。
- HTTP 成功不是确认：Agent 必须收到完整、相同的 accepted samples。拒绝重定向、缺字段、修改计数和超限响应；日志不包含凭据或原始子进程配置。
- 活动进程快照不会因为一次 ACK 被删除；已停止进程仅在当前完整持久化总量精确确认后回收。旧 ACK 不清除新流量，重启保留未确认 spool。

## 3. 运行与界面边界

沿用默认关闭的 `TUNEX_FXP_LINKS_ENABLED`。启用 Link runtime 时先验证私有统计目录，再恢复/启动进程；损坏、错身份、回放、存储失败或容量耗尽均保守停止，不能当成零流量继续服务。

新增迁移：`20261101005000_link_traffic_checkpoints`。先部署迁移和接收端，再升级 Agent/FXP；旧 Agent 不发送新协议，升级不会把 native 空统计冒充 FXP 事实。回滚统计端时保留新表与 Agent spool，先停止新 Link 转发，不能直接删除水位。

Link 详情显示双向累计 payload 字节、累计已接纳连接/UDP 映射次数和最近接收时间。计数是 decimal string，保留大整数。未收到水位显示未知，不显示假零；历史计数、最近收到积压报告都不代表 runtime 在线，也不等于当前并发数。

## 4. 不应夸大的保证

- FXP 每秒采样、每秒写快照；Agent 每 10 秒尝试发送。正常退出尝试刷新最后计数，但 Agent 的有界停止期限可能强杀尚在 drain 的进程；强杀或断电仍可能损失尚未采样/落盘的窗口，不能称为逐字节 crash-safe 财务计量。Linux 原子替换同步文件和父目录，Windows 仍要求服务账户私有 ACL。
- 日归属按采样时的 Asia/Shanghai 日期；日界附近一个采样窗口可能跨日。不是内核逐包时间戳统计。
- 已入账用量参与现有 reconcile 与租约检查。它不是跨节点预分配的严格实时流量池；上报/对账间隔和失联租约可能产生超额窗口。
- 私有 spool、producer 数和单进程 rule/day 条目均有上限。长期活动进程的已确认历史日期在线裁剪仍需后续独立切片；当前达到容量会停止而不是丢弃。500 条规则的持续多日运行必须在正式开放前验收这一边界。
- 新发布组合仍保持实验开关与公共矩阵 planned。Linux MySQL 并发事务、镜像及多 Agent 验收必须实际通过后再开放。

## 5. 验证与下一步

回归覆盖双向真实载荷、both 合并、活动 TCP 的周期计数、删除后最终计数、原进程积压重启恢复、重复/倒序/并发请求、跨租户/节点/出口负例、身份漂移、事务回滚和接口 ACK。

本轮本机没有 Docker/Linux 实例；真实数据库并发与多 Agent 证据以草稿 PR CI 为准。ABCD 首轮 CI 曾出现后端全量测试与 core-integration 失败，不能使用 Agent/web 单独通过替代整个 required 通过。

### 首轮门禁修复与本地证据

- 原 CI `37627547458` 的拓扑启动、凭据注册、四个 Agent 状态上报均成功；核心首败为创建 Link 返回 `503 link_operation_failed`。清理失败是另一问题，不能替代实际核心验收。
- 修复 `link-resource.ts` 错用遗留 `Node.version`：认证上报只写 `NodeStateReport.version`，新 Node 的遗留字段默认 `unknown`。现在准入读取当前报告版本与有效 FXP 能力；旧字段不能兜底放行缺失/未知报告，预期拒绝返回明确 409。新安装默认旧字段 + 有效当前报告已加入服务回归，真实拓扑确认仍由下一次 CI 提供。
- 修复既有 rollout/策略测试的事务锁、能力、端口协议 fixture，以及诊断/协议源码守卫；保留原失败/补偿断言，不下调 `required`。相关八个隔离套件经离线适配运行 219 项通过，不冒充完整数据库测试。
- 新 CI 独立创建并完整迁移 `tunex_link_traffic_test`；并发水位/日事实事务测试仅允许指定 loopback scratch URL，不使用环境中的业务库兜底。ABCD 验收增加真实报告准入、双向 payload 记账、同日后续增量、重复去重、删除后历史和重启 producer epoch；always 只归档闭集脱敏诊断，不上传配置、凭据或原始日志。

| 验证 | 本地结果与限制 |
| --- | --- |
| 后端 Link lifecycle + 流量事务/HTTP | 16 项通过；包含当前报告版本正反例，存储使用隔离 seam |
| Link 详情 API/UI | 47 项通过；未知/真零/大整数/陈旧与未来 receipt 独立于 readiness |
| backend/web TypeScript | 均通过 |
| FXP 原有及新增测试、Go vet、Linux amd64 构建 | 通过；33 个固定 upstream git blobs 校验一致，参考 `Forwardx/` 未修改 |
| Agent HTTP 交付/分组/部分失败重试 | 通过；只有完整精确存储 ACK 才调用本地确认 |
| 真实 FXP TCP/UDP 计数与共享更新 | 已通过单独真实二进制测试；共享 B 的 240 组 TCP/UDP 往返未断连/改变映射 |
| Agent 核心回归 + Go vet + Linux amd64 构建 | 六个核心包全部通过，含真实 FXP；Windows 原子替换通过 no-follow/共享删除句柄修复，未下调安全校验；非 Linux/Windows 的 FXP 统计保守拒绝 |
| Linux MySQL、镜像、多 Agent | 本机未运行；PR CI 必须实际通过 |

下一优先级：修复并重跑首版失败门禁 → 完成统计链路的 Linux 验收与长期 spool 裁剪 → 可信客户端来源透传/IP_HASH 和 FXP 多目标主备。复杂拓扑、运营和支付不抢占这些核心验收。

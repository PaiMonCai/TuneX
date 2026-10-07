# 当前转发能力与运行边界

更新：2026-10-08。ABCD 基线 `095089edd7ba2343cacc82aec2707435ad9c3876`，F1 接续 `7396f24`；对应 [PR #75](https://github.com/PaiMonCai/TuneX/pull/75) 开发分支，尚不代表正式发布。后续范围统一维护在 [开发方案](DEVELOPMENT_PLAN.md)。

## 资源与部署

普通原生 Forward 继续使用现有修订、rollout、reconcile 和恢复流程。RouteProfile 是线路模板；NodeGroup 是节点调度与访问池。

共享 FXP 使用独立 LinkResource，当前限定同一 Workspace 的两个自有节点。LinkVersion/LinkDeployment 保存不可变版本及合并部署快照，ForwardRevision 保存业务规则。一个编译器合并所有引用绑定，普通原生写入和恢复路径排除这些规则，避免另起明文监听。

连接不依赖业务规则存在：零规则时入口为 passive、ready=false，出口可以独立运行。当前支持规则 TCP、UDP、both；carrier 端口与业务监听分开。入口绑定范围为 wildcard、127.0.0.1 或 ::1，编译最多 500 条规则。

| 路径 | 当前支持 | 边界 |
| --- | --- | --- |
| 原生普通 Forward | TCP、UDP；TCP 客户端 TLS/WS 前端；DIRECT/RELAY | 普通 both 未开放。客户端 TLS/WS 不表示节点间 hop 已加密，legacy native hop 仅按私网/可信网络边界使用。 |
| 托管共享 FXP | 固定双节点、加密 TCP/UDP/both、规则复用 | 实验开关默认关闭，公共矩阵 planned；每绑定一个目标，尚无共享安全多跳/多出口。 |
| 原生目标池 | fallback、RR/random/weighted 选择及健康恢复 | 仅适用已有出口池路径，DIRECT 业务 API 仍为单目标；不能推广到 FXP。 |
| IP_HASH | 选择器和可信来源注入测试已有 | RELAY/EGRESS 生产来源链未完成，能力门禁关闭。 |

支持维度以 [core-contract.ts](../backend/src/integrations/forwardx/core-contract.ts) 为准；实验 Link 编译和节点准入见 [link-compiler.ts](../backend/src/integrations/forwardx/link-compiler.ts)。枚举中存在 GOST/WireGuard/更多驱动的名称不代表运行支持。

## 身份、授权、租约与端口

出口按 rule/protocol/target 精确授权；载体密钥只认证连接，不能授权任意目标。控制命令检查节点、Workspace、代次、摘要及有效租约；迟到 ACK 不确认更高修订。

Panel/Worker 用独立 `TUNEX_LINK_SEAL_KEY` 封存传输密钥。Agent 私有 state 使用独立 machine.key 加密缓存和持久墓碑，Link 配置不进入 legacy LKG。损坏缓存、错误身份、未授权响应和不完整权威快照不能借旧缓存恢复；只有规定的网络/5xx 情形允许租约内私有恢复。

Link 租约当前为 180 秒，续租检查期望修订、权限、流量额度和最新限制。策略撤销或额度耗尽产生 policy_blocked、停止续租及移除；策略恢复使用更高代次。失联不能无限延长旧缓存。

NodePortLease 与 Agent 守卫都检查 node/protocol/bind_scope/port 和 wildcard 重叠。TCP/UDP 可同号，精确重复或通配冲突拒绝；未知历史协议保守占两类。候选端口在应用前预留，失败补偿，旧槽位在确认运行清理后释放。

应用或删除成功后 Agent 在命令 ACK 前上报运行/端口事实；即时与周期报告串行采集发送。报告失败保留端口未知/旧占用，不能仅凭删除 ACK 推断端口已空闲。

## 更新与连接影响

| 变更 | 当前处理 |
| --- | --- |
| 新增/修改/删除一条业务规则 | managedReload 校验候选、等待精确 digest 确认；重建受影响规则，保持未变化规则的监听、TCP、UDP 映射、gate 和 bucket。 |
| 规则目标、限额、监听端口变化 | 受影响规则旧 TCP/UDP 明确关闭；新候选 bind 失败补偿旧规则。 |
| 协议或监听范围变化 | 不就地编辑，使用新规则与明确迁移。 |
| 载体端口/密钥或其他不可变载体配置 | placement 重启，可能影响全部引用规则；当前端点修改仅限从未部署且零引用，密钥轮换仅限零引用。 |
| 资源退役 | 引用必须为零，暂停规则仍算引用；先停入口，再停出口，持久 fence 后确认释放。 |

共享 A/B 实网验收证明指定业务变更保持未变化 B 的 TCP 会话及固定 UDP 目标 socket；不能据此宣传所有载体变更无损。确认超时、未知 digest 或补偿无法确认时保守停止，保留可诊断失败事实。

## 运行限额与状态

原生与 FXP 下发双向 bytes/sec、总并发、每来源 IP 并发，当前作用域为每规则、每入口 runtime。both 的 TCP/UDP 共享规则预算；UDP 并发是活跃映射。FXP 字段 maxIPs 表示每来源并发，不表示不同 IP 个数。

规则请求值 0 表示未另设规则上限，仍受 Workspace 天花板约束；Workspace 0 额度禁止转发。现有控制面额度检查与租约不等于多节点严格共享的带宽/连接预算池，也存在统计上报及租约生效窗口。

部署 ACK 是历史确认。当前运行事实必须匹配节点身份、代次、摘要、租约和报告新鲜度：缺观测为 unknown、过期为 stale、入口零规则为 passive；只有有效 ready=true 才表示 runtime Ready。Ready 不自动证明目标服务可达，统计接收时间也不证明正在运行。

<a id="traffic"></a>

## 流量统计与持久接收

只在入口累计业务 payload：client→target 为 bytes_in，target→client 为 bytes_out；TCP/UDP 按 Forward、Asia/Shanghai 日期合计，不计密文开销，不在出口重复上报。connections 是累计已接纳 TCP 连接/UDP 映射，不是当前并发。

每个新入口子进程生成随机 producer_id；支持 F1 的程序可在同一进程内切换到新的随机统计段。FXP 每秒采样写私有原子累计快照，正常退出做最后 flush；Agent 的加密 manifest 绑定节点、Workspace、Link 和每条规则在该统计段首次映射的 generation/digest。同段热更新、删除再加入不能重新归属旧计数；新段拥有独立身份，旧段计数不重置或重用。

Agent 校验 no-follow 私有文件、字段、数值及单调水位；在返回样本前持久化已见水位。每 10 秒通过节点 Bearer 身份重投，禁止重定向，子进程没有 Panel/节点凭据。一次请求保留一个 producer 的完整批次。

后端按历史不可变部署授权，不要求 Forward 仍存在；`node_id/producer_id/forward_id/date` 唯一水位与现有 TunnelTraffic 日事实在同一事务内增量更新。原生 SQL upsert、行锁和锁内更新处理 REPEATABLE READ 创建竞争；重复/旧计数不再入账，身份冲突或事务失败整批回滚，未提交不 ACK。

精确完整 ACK 后，Agent 仅回收已停止或已封存的统计段；仍可能增长的活动文件不删除。规则删除后的计数仍可重投并保留 Workspace 用量事实。当前详情按 Checkpoint 聚合历史生产者/日期，用 decimal strings 表示精确字节与连接数；缺数据为“尚未收到”，真实零才显示 0。至少 60 秒未更新保留旧值并说明过期。

F1 先探测实际 FXP 的 managed-traffic-rotation-v1 能力，再下发私有控制文件；旧程序沿用 v1。新协议 v2 表示活动段，v3 表示不可再增长的封存段。Agent 先加密保存 PreparedFrom 及新段授权映射，runner 在同一计数锁内先持久化新段空快照、再封存旧段、再切换计数。Agent 确认两个文件身份和版本后转移活动段，再按原 whole-producer 精确 ACK 回收。缺少封存段的后继文件、未知身份、缺行/回退仍拒绝，不能用“封存”绕过原水位检查。

旧日期、1024 条历史/规则映射阈值或段龄达到上限触发切换；`TUNEX_FXP_TRAFFIC_EPOCH_SECONDS` 可在 Agent 设置 30–86400 秒，默认 86400。规则变化触发的切换同时授权正在运行与候选规则，保留失败补偿的尾量。切换不重启子进程或监听，不重建 held TCP/UDP；网络断开时保留旧段，超过总容量则停止。

页面新增独立 traffic_status：当前段数、样本/映射数、私有文件大小、回收能力、最近确认及 collecting/backlogged/blocked/idle。容量数字放在支持详情；缺观测仍为未知。最近确认是内存观测，Agent 重启后可未知，不替代后端历史 receipt、租约或 Ready。

Windows 子进程先挂起创建、绑定 kill-on-job-close 后才恢复执行，防止启动时未受监管的进程产生监听和计数。若 Agent 在绑定前退出，可能留下尚未执行的挂起进程，需服务账户清理；首次启动中断留下普通 manifest 却无快照时，仍拒绝猜测尾量为零，需保留私有状态后明确恢复。

| 当前容量/精度边界 | 含义 |
| --- | --- |
| FXP 每段快照 2048 条 rule/day；文件最多 1 MiB | 新协议通过分段回收历史；旧程序仍有活动历史容量限制。 |
| Agent 128 个 producer；每 manifest 最多 2048 个规则映射 | 封存/停止且精确确认后回收；未确认段保留，离线积压有限，不静默丢弃。 |
| 单样本计数及双向合计受 MAX_SAFE_INTEGER 限制 | 历史详情聚合仍用精确 decimal strings，不转 Number。 |
| 一秒采样、正常停止 final flush | 强杀/崩溃可能丢失未采样/未持久窗口；当前不是精确崩溃安全的金融计量。 |
| 上海日按采样归属 | 不宣称逐包精确跨日分割。 |

容量、写盘或存储完整性失败时保守停止，不能删 spool、清水位或反复重启规避。升级接收端和统计迁移应早于新 Agent 启用；回退保留水位、私有 spool 与加密身份，详见 [部署说明](production-deploy.md)。

数据库 Checkpoint 与历史部署尚未自动归档/清理，它们继续提供重放防护、尾量授权和精确聚合。出现 v2 manifest 后，旧 Agent 无法安全读取；不能直接降级并清文件，必须先排空/保留统计并按兼容恢复流程处理。

实现入口：[link-resource.ts](../backend/src/services/link-resource.ts)、[link-traffic.ts](../backend/src/services/link-traffic.ts)、[schema.prisma](../backend/prisma/schema.prisma)、[Agent 生命周期契约](../agent/internal/linkrunner/README.md)、[FXP 来源与修改](../third_party/forwardx/README.md)。

# 当前转发能力与运行边界

更新：2026-10-08。源码基线 `095089edd7ba2343cacc82aec2707435ad9c3876`；对应 [PR #75](https://github.com/PaiMonCai/TuneX/pull/75) 开发分支，尚不代表正式发布。后续范围统一维护在 [开发方案](DEVELOPMENT_PLAN.md)。

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

每个新入口子进程生成随机 producer_id。FXP 每秒采样写私有原子累计快照，正常退出做最后 flush；Agent 的加密 manifest 绑定节点、Workspace、Link 和每条规则首次映射的 generation/digest。热更新、删除再加入不能重新归属已产生的旧计数。

Agent 校验 no-follow 私有文件、字段、数值及单调水位；在返回样本前持久化已见水位。每 10 秒通过节点 Bearer 身份重投，禁止重定向，子进程没有 Panel/节点凭据。一次请求保留一个 producer 的完整批次。

后端按历史不可变部署授权，不要求 Forward 仍存在；`node_id/producer_id/forward_id/date` 唯一水位与现有 TunnelTraffic 日事实在同一事务内增量更新。原生 SQL upsert、行锁和锁内更新处理 REPEATABLE READ 创建竞争；重复/旧计数不再入账，身份冲突或事务失败整批回滚，未提交不 ACK。

精确完整 ACK 后，Agent 仅回收已停止 producer；活动文件不删除。规则删除后的计数仍可重投并保留 Workspace 用量事实。当前详情按 Checkpoint 聚合历史生产者/日期，用 decimal strings 表示精确字节与连接数；缺数据为“尚未收到”，真实零才显示 0。至少 60 秒未更新保留旧值并说明过期。

| 当前容量/精度边界 | 含义 |
| --- | --- |
| FXP 快照 2048 条 rule/day；文件最多 1 MiB | 活动历史未裁剪，长期跨日或频繁规则变更会触发容量边界。下一开发首项是安全回收。 |
| Agent 128 个 producer；每 manifest 最多 2048 个规则映射 | 已停止并精确确认的 producer 可回收；未确认数据保留，不静默跳过。 |
| 单样本计数及双向合计受 MAX_SAFE_INTEGER 限制 | 历史详情聚合仍用精确 decimal strings，不转 Number。 |
| 一秒采样、正常停止 final flush | 强杀/崩溃可能丢失未采样/未持久窗口；当前不是精确崩溃安全的金融计量。 |
| 上海日按采样归属 | 不宣称逐包精确跨日分割。 |

容量、写盘或存储完整性失败时保守停止，不能删 spool、清水位或反复重启规避。升级接收端和统计迁移应早于新 Agent 启用；回退保留水位、私有 spool 与加密身份，详见 [部署说明](production-deploy.md)。

实现入口：[link-resource.ts](../backend/src/services/link-resource.ts)、[link-traffic.ts](../backend/src/services/link-traffic.ts)、[schema.prisma](../backend/prisma/schema.prisma)、[Agent 生命周期契约](../agent/internal/linkrunner/README.md)、[FXP 来源与修改](../third_party/forwardx/README.md)。

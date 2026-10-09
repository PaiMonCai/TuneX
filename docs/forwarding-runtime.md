# 当前转发能力与运行边界

更新：2026-10-09。ABCD 基线 `095089edd7ba2343cacc82aec2707435ad9c3876`，F1 接续 `7396f24`；对应 [PR #75](https://github.com/PaiMonCai/TuneX/pull/75) 开发分支，尚不代表正式发布。后续范围统一维护在 [开发方案](DEVELOPMENT_PLAN.md)。

## 资源与部署

普通原生 Forward 继续使用现有修订、rollout、reconcile 和恢复流程。RouteProfile 是线路模板；NodeGroup 是节点调度与访问池。

共享 FXP 使用独立 LinkResource，当前限定同一 Workspace 的两个自有节点。LinkVersion/LinkDeployment 保存不可变版本及合并部署快照，ForwardRevision 保存业务规则。一个编译器合并所有引用绑定，普通原生写入和恢复路径排除这些规则，避免另起明文监听。

连接不依赖业务规则存在：零规则时入口为 passive、ready=false，出口可以独立运行。当前支持规则 TCP、UDP、both；carrier 端口与业务监听分开。入口绑定范围为 wildcard、127.0.0.1 或 ::1，编译最多 500 条规则。

| 路径 | 当前支持 | 边界 |
| --- | --- | --- |
| 原生普通 Forward | TCP、UDP；TCP 客户端 TLS/WS 前端；DIRECT/RELAY；原生 both 候选 | both 默认关闭、首版仅 plain DIRECT/自有单跳 RELAY，需实际能力与自身验收。客户端 TLS/WS 不表示节点间 hop 已加密，legacy native hop 仅按私网/可信网络边界使用。 |
| 托管共享 FXP | 固定双节点、加密 TCP/UDP/both、规则复用、每规则有序多目标 | 实验开关默认关闭，公共矩阵 planned；多目标需要双方实际能力，尚无共享安全多跳/多出口。 |
| 原生目标池 | fallback、RR/random/weighted 选择及健康恢复 | 仅适用已有出口池路径，DIRECT 业务 API 仍为单目标；不能推广到 FXP。 |
| IP_HASH / PROXY | 共享 FXP TCP 来源切片 `47594c4` 已通过自身候选验收 | 须显式 `client_source` 及双方真实能力；UDP/both 拒绝。原生 RELAY 来源门禁不变。 |

支持维度以 [core-contract.ts](../backend/src/integrations/forwardx/core-contract.ts) 为准；实验 Link 编译和节点准入见 [link-compiler.ts](../backend/src/integrations/forwardx/link-compiler.ts)。枚举中存在 GOST/WireGuard/更多驱动的名称不代表运行支持。

## 身份、授权、租约与端口

出口按 rule/protocol/target 精确授权；载体密钥只认证连接，不能授权任意目标。控制命令检查节点、Workspace、代次、摘要及有效租约；迟到 ACK 不确认更高修订。

Panel/Worker 用独立 `TUNEX_LINK_SEAL_KEY` 封存传输密钥。Agent 私有 state 使用独立 machine.key 加密缓存和持久墓碑，Link 配置不进入 legacy LKG。损坏缓存、错误身份、未授权响应和不完整权威快照不能借旧缓存恢复；只有规定的网络/5xx 情形允许租约内私有恢复。

Link 租约当前为 180 秒，续租检查期望修订、权限、流量额度和最新限制。策略撤销或额度耗尽产生 policy_blocked、停止续租及移除；策略恢复使用更高代次。失联不能无限延长旧缓存。

NodePortLease 与 Agent 守卫都检查 node/protocol/bind_scope/port 和 wildcard 重叠。TCP/UDP 可同号，精确重复或通配冲突拒绝；未知历史协议保守占两类。候选端口在应用前预留，失败补偿，旧槽位在确认运行清理后释放。

应用或删除成功后 Agent 在命令 ACK 前上报运行/端口事实；即时与周期报告串行采集发送。报告失败保留端口未知/旧占用，不能仅凭删除 ACK 推断端口已空闲。

原生控制命令的删除/暂停先等待真实 Stop 和端口守卫释放（最长 5 秒），再发布报告并确认；本地普通移除仍异步。等待不持管理器锁，取消或 Stop 失败不确认完成、不释放仍占用的绑定；重复命令加入未完成关闭或重试失败 Stop。关闭完成后才能复用同号 TCP/UDP；新所有者、其他作用域或协议的占用不会随旧关闭被误清理。

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

原生 both 候选使用一个 ID/修订，创建或切入须服务端 `FORWARD_NATIVE_BOTH_ENABLED=true`、参与节点新鲜 `forward.protocol.both.native.v1`，并同时满足 TCP、UDP 权限。发现接口为已认证的 `/api/forwards/capabilities`；关闭开关不降级既有协议、不撤销合法恢复。中间跳/联邦/TLS/WS/来源组合拒绝；来源扩展没有借 F4 打开。原生 hop 仍不是加密载体。

原生 both 两监听完成绑定才准入，任一失败清理另一侧，不能半 Ready；同号替换需重建时会中断受影响规则，两协议目标同步更新。补偿仅重建仍获授权的旧修订，保持有效续租，绝不回滚已观察的所有权 epoch。运行流量是 TCP+UDP payload 聚合；连接数为 TCP，映射/包/丢弃为 UDP。现有出口目标账本以 TCP 拨号为证据，不能把它当成 UDP 应用健康。

同号重建时，Agent 的运行配置和 `used_ports` 数字汇总是同一监听的两类事实，不是两个端口持有者。数字汇总只有在真实协议、入口/出口方向和同 owner 的 active 持久租约匹配，且租约覆盖实际监听作用域时才能解释为本隧道占用；单独 runtime ID 或数据库行不够。未指定产品监听 IP 的 wildcard 租约可覆盖 Agent 配置的数据网 IP，具体 IP 租约不能覆盖 wildcard 或另一 IP。未知协议、其他持有者和显式无 owner/关闭中占用仍阻断申请，不通过删租约或忽略实际占用解决自冲突。

RELAY 的目标修改若同时要求入口重建，必须先 `prepare_egress` 获取真实 ACK 出口地址，再执行出口/入口 cutover。不能因为目标变化而跳过出口准备，导致 `next_hop_unresolved`。仅换出口目标且入口不重切的既有路径仍只在 CUTOVER 更新出口，不额外重建入口。

`connect_ip` 是节点公布的连接地址，不是规则的监听作用域。PATCH 修改目标或协议保持现有 `listen_ip`，不能把 wildcard 租约偷偷缩成具体 IP。失败补偿以失败候选修订删除 runtime，基线内容以更高修订恢复；删除栅栏不得占用恢复修订，迟到的失败候选仍被拒绝。

规则请求值 0 表示未另设规则上限，仍受 Workspace 天花板约束；Workspace 0 额度禁止转发。现有控制面额度检查与租约不等于多节点严格共享的带宽/连接预算池，也存在统计上报及租约生效窗口。

部署 ACK 是历史确认。当前运行事实必须匹配节点身份、代次、摘要、租约和报告新鲜度：缺观测为 unknown、过期为 stale、入口零规则为 passive；只有有效 ready=true 才表示 runtime Ready。Ready 不自动证明目标服务可达，统计接收时间也不证明正在运行。

## FXP 多目标与健康窗口

规则可选 `target_set` v1：1–10 个有序且不重复的 `{host, port}`、`fallback/round_robin/random/ip_hash` (IP_HASH: TCP + `client_source`)、10–3600 秒的失败/恢复窗口，以及 `probe:tcp|none`。原有 `target_host/target_port` 必须等于首项，只是兼容投影。未提供目标集的旧规则保持单目标；已有目标集编辑若被旧客户端省略，明确拒绝。退回单目标需提交只有一项的完整目标集修订。API、ForwardRevision 和 LinkDeployment 都保存完整目标及顺序。每个 runner 配置仍限 1 MiB，编译在持久化前检查字节预算；500 规则×10 目标是结构上限，不保证最长地址组合全部装入一个连接。

两节点都需通过真实 `-managed-target-capabilities` 探测并报告 `forward.targets.fxp.v1`；新建、更新及私有恢复均拒绝不支持的 runner。出口只从配置授权的 rule/protocol/完整目标集选择，Hello 不提供任意目标授权。复用 ForwardX FXP 的出口选择器及规则目标窗口语义，新增业务目标池适配；这不表示 ForwardX 原来的载体出口池本身就是业务目标集。

TCP 在新连接时选择，当前拨号失败可尝试其他合资格目标，不等待失败窗口；窗口决定何时停止优先尝试该目标。成功打断连续失败，恢复窗口期间暂不重新接纳。`none` 下新连接可以每目标最多每 5 秒发起一次半开试拨；试拨成功仅建立恢复证据，窗口完成前不承载业务 payload，全故障后的目标仍有恢复路径。已建立 TCP 不自动迁移。RR/random 按新连接或新 UDP 映射选择，不逐包选择。未知目标仍可尝试；全不可用不发送到未授权地址。

`probe:tcp` 明确探测每个目标的同 host/port TCP 监听，包括 UDP-only 规则；这是辅助 TCP 证据，不能证明 UDP 应用健康。纯 UDP 服务没有该辅助监听时使用 `none`，无响应保持未知，不因超时直接宣布故障。真实 UDP 回包能提供成功证据；无主动探测时没有自动发现静默停机的承诺。

UDP 来源映射固定目标。已确认失败时关闭受影响目标 socket，后续数据报选择其他合资格目标；保留原 FXP 会话、防重放窗口与返回加密序号，防止重建后 nonce 重用。旧 socket 的迟到回包不能穿过新映射。目标恢复不主动迁移仍健康的现有映射。目标集/策略修订则明确关闭受影响规则的旧 TCP/UDP，未变化 B 的监听、socket、预算与健康窗口保持。关闭的 UDP 会话保留有界、进程内的 rule/session 加密与重放历史到 10 分钟；同身份不能同时从另一 peer 建立映射。历史满时拒绝新身份，不提前驱逐有效防重放记录。这不是跨进程永久重放保护；重启沿用 FXP 原有随机会话与序号分配边界。

探测有固定工作池、超时和有界队列，500×10 目标不会创建无界 goroutine。目标状态独立于 listener Ready：unknown/healthy/suspect/recovering/unhealthy，选中索引表示最近一次连接/映射的选择，不代表所有现存会话。只有当前授权 digest、已部署规则/目标数量、节点/Workspace、代次、有效租约和新鲜报告全部吻合时才显示；缺观测保持未知。子程序仅输出脱敏索引和时间，Agent 不透传原始日志、地址或密钥。

## FXP TCP 可信来源与 PROXY

可选 `client_source` v1：`receive_proxy`、`trusted_cidrs`（最多 32 个 IPv4/IPv6 CIDR）、`send_proxy:off|v1|v2`。只支持业务 TCP；即使显式全关闭也保留来源配置与能力约束。旧规则不提供此字段时行为不变；已有配置被编辑客户端省略明确拒绝。关闭接收/发送需提交显式新修订，不能默默删字段。

- 不接收 PROXY 时，来源取实际入口 socket，应用 payload 不被当作来源声明。接收时，只允许配置的受信 socket 网段，必须收到有效 TCP4/TCP6 PROXY v1/v2 头；不受信来源、UNKNOWN/LOCAL、缺失/损坏头和无效端口拒绝。CIDR 掩码规范化，拒绝 /0、zone、IPv4-mapped IPv6 CIDR 和规范化后重复项；只信任实际需要的上游代理，不信任整个公网。
- 接收有最多 128 个在途头解析槽位、5 秒绝对截止时间，v1 最多 108 字节、v2 总计最多 536 字节；分片/慢头不会延长截止时间，也不会吞掉后续 payload。总 socket 并发先限，验证后再按有效原始 IP 准入，不能让上游用户共享代理节点的每 IP 预算。
- 两端必须由实际 `-managed-source-capabilities` 探测报告 `forward.client-source.fxp.v1`，运行时显式 `-managed-source-v1`。认证加密 Hello 包含版本、当前来源策略摘要和规范来源端点，并与 carrier/rule/protocol/目标授权一起校验；旧来源策略声明在变更后拒绝。信任边界是已授权的入口节点，不承诺阻止掌握载体密钥的恶意节点谎报客户端。
- 出口使用自己的绑定配置重建发送模式、版本和 IP_HASH 选择键，不采用 Hello 的任意选择键或发送开关，不修改 HTTP 头。目标服务必须支持 PROXY，否则开启发送会破坏握手。`off` 不给目标发送头，但内部来源仍可参与 IP_HASH。目标收到的是入口客户端/受信上游声明的端点，不是出口节点 IP。
- IP_HASH 使用规范客户端 IP、不包含临时端口；相同健康成员集合和顺序下选择稳定，成员/顺序或合资格健康状态变化可能重新映射。不同 IP 允许哈希碰撞，不保证每个客户端独占目标；失败后可尝试其他授权目标，既有 TCP 不自动迁移。缺少有效来源时拒绝，不静默退成 RR。
- 来源策略变更在同一入口/出口进程内应用，关闭受影响规则的旧载体和目标连接，保持未变化 B 的 TCP/UDP 和预算。目标拨号后、发送 PROXY 前重新核验当前授权及来源策略；头发送与撤销同步，并有 1 秒写截止，更新确认后不能再向新拨号的目标发送旧策略头。已经在撤销前发送的数据不能收回。详情展示的是**配置策略**，不把 desired、ACK、Ready 或目标健康冒充实时来源验证。目前不扩展原生 RELAY 或 UDP/both 来源组合。

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

# 以隧道转发为核心的后续开发方案

更新：2026-10-10。F1/F2 首切片、F3 共享 FXP TCP 来源和 F4 Linux 原生 both 限定组合已由 [PR #75](https://github.com/PaiMonCai/TuneX/pull/75) 合入 `main`（`ef159eb`），不等于 F0–F4 所有目标已完成。F5 开发分支 `feat/forward-link-maintenance` 的 [PR #76](https://github.com/PaiMonCai/TuneX/pull/76) 仍为未合并草稿；源码 `cdb8470` 的只读预览首切片通过自身 CI，迁移执行器尚未实现。ForwardX 对标基线：2.3.281，提交 `cb0ef0bb156dc114e4344c887328018491fbd638`。固定源码验收记录见 [测试说明](testing.md)，公开发布条件仍单独验收。

## 1. 目标和范围

先交付一套可持续运行的隧道转发面板：用户创建共享连接、绑定规则、调整目标和限额，能看到可信运行状态；目标或节点故障后按明确策略切换，重启后恢复，删除后真正释放资源。每个阶段都交付表单、API、部署、Agent 运行与实网验收的完整流程。

优先复用 ForwardX 已验证的业务处理：规则与连接分离、目标主备和健康窗口、PROXY 配置、链路成员、驱动选择与托管生命周期。已导入的 FXP 继续作为独立程序使用；新增适配尽量沿用上游实现和语义。TuneX 的 Workspace 授权、修订、租约、端口守卫及不可变快照继续负责控制面的一致性。

支付、套餐经营、优惠券、插件、AI、移动端、营销页面后置。核心功能需要的权限检查、密钥保护、运行观测和错误恢复随功能一起交付。既有外围功能的缺陷不因本方案而视为已修复；恢复相关开发时单独审查。

2026-10-09 用户调整：Windows 适配暂停，不作为下一阶段前置。原生 Agent LKG 是失联重启时的恢复缓存，不是已证明的转发性能优化；本轮不修改，仍记录 Windows 并发读取缺陷，但不以此阻塞限定 Linux 的 F5 开发。没有性能基线和明显收益时，不另起缓存优化工作包。

## 2. 当前能力与差距

下表已有运行能力属于已合并基线；只有 F5 预览属于未合并开发分支。“部分”表示必须看具体运行路径，验证范围见 [测试说明](testing.md)。ForwardX 的协议、载体、驱动也有组合限制，不能将其枚举做笛卡尔积后全部宣称支持。

| 核心能力 | ForwardX 参考处理 | TuneX 当前状态 | 后续工作 |
| --- | --- | --- | --- |
| 规则与共享连接分离 | 独立 tunnels，多个 rules 引用 | 已有 LinkResource、独立部署和规则引用 | 保留，扩展版本化变更和复杂拓扑。 |
| 加密双节点 TCP/UDP | FXP v1 TCP/UDP 运行与密钥 | 已导入真实 FXP，固定两个自有节点 | F0 收口发布条件，F6 扩展路径。 |
| TCP/UDP 同号与 both | 两种业务协议及 both | FXP 已有；普通原生 both 限定组合已合入 main 并通过 Linux 验收，默认关闭 | F0 发布准入；额外协议/拓扑组合单独开发。 |
| 双向速率限制 | FXP limitIn/limitOut | 原生与 FXP 已有每规则、每入口 runtime 限额 | 保留；多入口总预算另做分配。 |
| 总并发、每源 IP 并发 | FXP connGate；maxIPs 是每来源并发 | 已有；UDP 并发是活跃映射，共享 TCP 可信来源随 F3 补齐 | 原生来源扩展；不改成不同 IP 数量限制。 |
| 共享规则热更新 | 上游运行逻辑加 TuneX 托管更新 | A 更新时保持未变 B 的 TCP/UDP；载体变更仍重启 | F5 做在线载体迁移。 |
| 每规则流量及额度 | 方向计数和规则/用户聚合 | 已有入口累计、持久重投、水位去重、日事实入账 | F1 解决长期历史容量。 |
| 多目标主备 | rules 目标列表、fallback、故障/恢复窗口 | 原生出口池部分可用；FXP 最多 10 目标首切片已合入 main，实网已验收 | 长期/发布验收；UDP 辅助探测和映射切换边界见运行说明。 |
| RR/random/weighted | 目标或出口组策略 | FXP 新目标集支持 RR/random 且已实测；原生 weighted 保留现有路径 | 原生独立发布 gate；FXP weighted 后续按需求扩展。 |
| IP_HASH | 原始客户端来源参与选择 | 共享 FXP TCP 已验收并合入 main；原生 RELAY 门禁不变 | F3 原生来源仍待开发，不能推广证据。 |
| PROXY v1/v2 | 入出口接收/发送开关、版本与兼容性 | 共享 FXP TCP 受信接收和目标发送 v1/v2 已验收并合入 main | F3 原生来源扩展；UDP/both 暂拒绝。 |
| 部署/运行/可用状态 | 分开 desired、deployed、running、available | Link 已有代次/digest/租约匹配的运行事实 | F0/F8 加目标可达性和真实浏览器流程。 |
| 重启、失联、撤权恢复 | Agent runtime recovery | 已有加密缓存、持久墓碑、有限租约与 reconcile | 各阶段加入跨版本恢复及故障注入。 |
| 共享连接在线改端点/密钥 | 共享修改影响引用规则 | main 仍禁止已部署端点编辑，轮换限零引用；开发分支只读影响预览已验收 | F5 持久状态机、提交 CAS、双代迁移及补偿。 |
| 安全多跳 | chain、逐跳载体和成员 | 原生 RouteProfile 最多 3 节点；共享 FXP 固定 2 节点 | F6a。 |
| 多出口故障切换 | exit/failover groups | 调度候选和单条运行路径已有；共享多出口未完成 | F6b，先固定主备。 |
| 多入口同时服务 | entry groups | NodeGroup 是基础设施池，不能表示多入口部署 | F6c，最后做多活及预算分配。 |
| TLS/WSS/GOST 载体 | gostTunnelProtocol、tunnelRuntimePlan | 原生 TLS/WS 是客户端前端；GOST 载体 planned | F7a，明确 hop 加密与业务协议。 |
| FXP v2 / WireGuard | userspace WireGuard + FXP | 仅契约名称，未实现运行闭环 | F7b。 |
| nftables/iptables/realm/socat/nginx | 多执行驱动 | 未形成可管理的驱动集 | F7c，按实际需要选择接入。 |
| 批量规则操作 | 复制、编辑、导入导出、删除 | 普通 Forward 已有部分动作；批删有独立开关；Link 主要单条动作 | F8，贯穿阶段交付。 |
| 入口故障后的 DDNS | 原生 provider adapters | 当前 Cloudflare/Huawei 路径是 HTTP bridge，原生 token 单独不可用 | F6c 场景需要时接入真实 provider，独立验收。 |

## 3. 架构约束

保留 Bun/Hono/Prisma/MySQL/Redis/BullMQ、Next.js/React 与 Go Agent，不为功能对齐重写框架。

| 对象或维度 | 职责 |
| --- | --- |
| Forward / ForwardRevision | 业务监听、目标、协议、限额、启停与不可变业务修订。 |
| LinkResource / LinkVersion | 可复用连接的身份、载体、端点、版本；不重复拥有可变业务目标。 |
| LinkDeployment / placement | 单一编译器合并引用规则，产生不可变部署快照及各节点代次、摘要、租约。 |
| RouteProfile | 路由模板，不冒充独立运行的连接。 |
| NodeGroup | 节点调度和访问池，不冒充业务多入口/多出口组。 |
| business protocol | tcp / udp / both；与载体底层使用 TCP 还是 UDP 分开。 |
| client front / carrier / driver | 客户端 TLS/WS 前端、节点间载体、执行程序分别表达；仅开放有实网证据的组合。 |

同一个 runtime 只允许一个期望状态写入源。普通原生 reconcile 必须继续排除 Link 绑定，失败时不能自动启动一条明文替代路径。共享更新必须提供引用影响、CAS 校验、分阶段应用和补偿；迟到确认不能覆盖更高代次。

功能复用与 ForwardX API/线路互通是两个范围。本阶段承诺业务行为对齐；需要直接接入 ForwardX Agent、导入其完整数据库或建立跨面板线路时，另设版本/协议兼容工作包。

## 4. 开发工作包

### F0：发布基线与能力准入

依赖：对应候选通过选中范围 CI，并单独补齐发布专用验证。估算：2–4 工程人日。

- 选择明确的候选发布组合，记录 Panel/Agent/FXP 源码、镜像 digest 和实际版本；FXP 程序内部版本 2.2.117 与项目版本 2.3.281 分开记录。
- 基于认证 NodeStateReport 和构造成功的 runtime capability 准入；为每个新组合设置真实最低 Agent/runner 能力要求，拒绝过期报告、未识别版本和缺依赖节点。
- 清理支持矩阵中的旧阶段描述，区分实验运行能力与公开可用组合；F1 完成及发布验收通过后，再调整 planned/default-off。
- 在真实 Panel/API 上补 `/links` 创建、部署、绑定、冲突、部分失败、暂停/恢复、删除、Workspace 切换及流量详情的浏览器验收。前端 fixtures 保留作快速回归。

交付标准：候选 SHA 的 required 全绿；安装后的真实程序/能力与页面一致；旧 Agent 和功能关闭均明确拒绝；新鲜统计不替代 Ready。回退保持默认关闭，不修改旧 native 规则。

### F1：长期统计容量与安全回收——首个切片已验证

依赖：现有累计统计协议。估算：5–9 工程人日。

原有活动 producer 的历史日条目、删除过的规则映射和已见水位不会回收，2048 条上限不能支撑 500 条规则长期跨日运行。本轮通过同进程统计分段解决：runner 写入新段空快照，再封存旧段最终累计，原子切换后续计数；Agent 持久化准备身份和水位，精确数据库 ACK 后回收封存段。规则会话、监听和预算保持，旧段身份从不重用。协议及边界见 [运行说明](forwarding-runtime.md#traffic)。

首个切片已实现 Agent/FXP 分段、崩溃恢复、容量/确认观测及页面；包含 500 规则/30 模拟日、并发计数、迟到 ACK、真实 held TCP/UDP 测试，固定候选结果见 [历史切片证据](testing.md#历史切片证据索引)。真实跨日/长期运行与数据库历史归档仍分别留证，不能将首个切片等同整个 F1 交付。数据库水位和部署历史继续保留，尚未自动归档清理。

- 已实现 FXP 版本化分段协议：旧段封存后不再接收增量，新段以新身份累计；Agent 收到数据库提交后的全段精确确认，再删除旧段快照与授权映射。runner 不原地裁剪活动段或重用累计身份。
- 已实现加密 manifest 的准备记录、Rules/Last 水位和持久删除意图；完整验证所有文件后才恢复准备或回收。缺项和回退检测继续有效，未确认数据不能为了腾出容量而丢弃。
- 已覆盖晚到/重复 ACK、准备/封存各崩溃点、Agent 重启、配置回滚及并发计数；继续补真实跨日和持续绑定增删的长期运行证据。需要分批上传时，单独版本化批次完整性；当前 whole-producer ACK 规则保持有效。
- 后端保留累计水位的重放防护。数据库历史清理必须先设计已封存身份的拒绝/去重机制、保留周期和详情聚合；不能只删除 Checkpoint 让重投再次入账，也不能因清理丢掉页面累计。
- 已在页面与诊断提供统计积压、容量和最近确认的脱敏状态；确认时间为本次 Agent 运行的内存记录，重启后可能未知，不代替 Ready。容量不足保留计数并明确停用原因。

交付标准：500 条规则模拟连续 30 个上海日并反复新增/删除绑定，在线上传时文件/映射数量稳定；断网积压、迟到/重复/乱序回执及逐个崩溃点恢复不漏记、不重记；回收不重启共享载体，不切断持续 B TCP/UDP；磁盘满/损坏仍保守停止。保留至少一次真实跨日运行证据。

回退：接收端先兼容双协议，能力协商后启用裁剪；旧 Agent/runner 不消费新状态。迁移不可逆的本地格式出现后禁止直接降级，保留 spool 与数据库水位，走受控停止及兼容恢复。

### F2：FXP 多目标、主备与健康恢复——首个切片已验证

依赖：固定绑定身份和共享更新契约；开发可与 F1 并行，发布依赖 F1。估算：8–14 工程人日。

当前切片已冻结 `target_set` v1、双方真实 runner 能力门禁、完整授权/修订快照、出口选择、独立健康投影和表单。`probe:tcp` 是同地址端口辅助 TCP 探测；`none` 不把 UDP 静默判成故障。确认失败的 UDP 更换目标 socket，保留加密序号/防重放；恢复不移动健康映射。真实 Linux 多节点和数据库快照已由该候选 CI 验收，窗口抖动和旧 runner/客户端拒绝另有回归。此切片不打开公开 FXP，不包括 weighted/IP_HASH、多出口节点或已建立 TCP 自动迁移。

- 对齐 ForwardX 目标列表校验和优先顺序，首版每规则最多 10 个目标；增加版本化目标集、fallback/RR/random 与失败/恢复窗口。普通原生出口池继续使用已有选择器，不再另写一套相同语义。
- API 和修订快照保存完整目标集；单目标历史数据无损转换。Link 编译器生成规则授权目标集，出口核对 rule/protocol/allowed target，不能借多目标扩大到任意目的地址。
- 复用上游目标规划/运行处理，补 FXP 健康状态及绑定级选择。选择器共享纯逻辑即可，不能把需要 Go 第三方依赖的实现直接放入当前标准库 Agent。
- TCP 按新连接选择；UDP 按来源映射固定目标，故障后是否重建映射明示。已建立 TCP 无法无损迁移到另一目标，切换影响应在页面说明。
- 管理面显示每目标健康、选中目标、检查时间与恢复原因。目标未知和 UDP 探测无响应按明确策略处理，不能当作已失败或已健康。
- 共享热更新保存未变化规则、目标 socket 和预算；目标集变化只影响相关规则。新增目标先授权再使用，删除目标与在途旧版本的处理必须有明确顺序及补偿。

交付标准：真实 TCP/UDP/both 覆盖主目标停机、全故障、恢复、抖动、修改/删除目标和 Agent 重启；按窗口切换且不循环抖动；A 切换时 B 保持原 TCP/UDP；跨规则/跨租户/未授权目标被拒绝；页面结果与实际目标一致。

回退：新目标集有独立能力版本；旧节点拒绝新配置。需要退回单目标时创建明确修订并提示影响，不能在接收失败后偷偷选第一个目标。

F2 固定候选结果见 [历史切片证据](testing.md#历史切片证据索引)，不替代后续来源协议或新提交的验收。

### F3：可信客户端 IP、PROXY 与 IP_HASH——共享 TCP 首切片已验收

依赖：F2 的目标身份与选择接口；协议/信任设计可提前并行。估算：6–10 工程人日。

首个切片限定**共享 FXP TCP**。版本化 `client_source` 明确 socket/受信 PROXY、CIDR 和目标发送模式；实际 runner 能力控制双方准入，认证 Hello 绑定规则及来源策略摘要，出口重建选择键/发送模式而不采信客户端字段。IP_HASH 复用上游选择器；每源并发在验证来源后准入。UDP/both 明确拒绝此组合，原生 DIRECT/RELAY 来源扩展尚未纳入此切片，不将共享路径证据推广过去。Linux 四节点和数据库验收已通过；真实 Panel 浏览器仍待完成，fixtures 不替代；公开功能仍默认关闭。

- 区分入口 socket 原地址、可信上游 PROXY 声明和普通用户输入。配置 receive/send、入口/出口位置、v1/v2、受信网段与长度/超时边界；UDP 不支持的组合明确拒绝。
- 将可信来源放入经过认证、绑定规则的内部元数据。复用上游 PROXY 解析/发送处理并适配 TuneX 的身份校验，禁止出口用载体节点 IP 冒充客户端 IP。
- 把真实来源交给 IP_HASH 和需要原始来源的连接策略。没有该能力的路径继续拒绝 IP_HASH；不通过给目标端添加伪造 HTTP 头解决。
- 前端提示目标服务需支持 PROXY，以及设置错误会使握手失败；展示来源可用性，支持先预览再启用。

交付标准：两种真实客户端地址在 DIRECT/RELAY/FXP 上按声明组合稳定分配；IPv4/IPv6、v1/v2、伪造头、不受信来源、超长/慢头均覆盖；目标收到正确来源；来源缺失不能误报可用；健康目标集变更后的哈希行为确定且有说明。

回退：配置和元数据协议能力协商；旧节点拒绝新要求。撤销功能生成新修订并提示受影响连接，保持既有目标集授权。

### F4：普通原生 Forward 的 both——Linux 限定组合已验收并合并

依赖：现有协议/地址端口租约与运行限额。估算：5–8 工程人日。

- 将一个业务修订编译为 TCP/UDP 两个子 runtime；业务身份、限额和统计保持一条规则口径。原子预留两类端口，失败时完整补偿。
- 覆盖 create/update/dispatch、desired、restore、rollout/reconcile、suspend/resume/delete、诊断和事实上报；禁止只改枚举或创建接口。
- 页面只展示通过完整路径的组合。TCP 前端 TLS/WS 与 UDP 的组合另行定义，普通 both 首版限定 plain，不能用 TCP TLS 包装假装 UDP 已受保护。

交付标准：DIRECT 与 RELAY both 实网、同号 TCP/UDP、单侧冲突、半部署失败、重启恢复、删除及精确端口复用；两协议共享规则预算；未知历史协议继续保守占位；跨租户竞争不产生重复监听。

回退：新创建路径能力关闭，已发布 both 配置按版本保留兼容恢复；不能删除其中一个子 runtime 后把业务状态报成成功。

本切片契约：`both → mixed / connection_and_mapping`，legacy TunnelType 投影为空，不能假填 TCP。独立实际能力 `forward.protocol.both.native.v1` 与新鲜报告控制完整路径准入；Workspace 须同时授权 TCP 和 UDP。`FORWARD_NATIVE_BOTH_ENABLED=true` 只开放新建/切入 both，不阻止既有 both 的恢复与移除。禁止中间跳、联邦、TLS/WS 前端及客户端来源组合。

Agent 使用一个 ID、一个修订和 TCP/UDP 两个真实 OS 槽位；两子监听均成功才开放入口准入，半失败关闭已准备监听。目标变化首版完整重建，两协议不能分开热改；同号替换失败时重建旧已应用配置，重新验证有效续租及单调所有权围栏。失败候选不得改变当前运行的租约时钟。流量为两协议 payload 聚合，TCP 连接与 UDP 映射分项展示。真实验收新增 `scripts/integration/native-both.py`，不能用本机测试或前一切片 CI 代替。

2026-10-09 收尾并合入 `main`：同 runtime 占用归属、监听作用域、实际 applied 基线、补偿/重试栅栏、RELAY 实际 hop、Stop 完成后报告/ACK 已修正并验收。`ef159eb` 的 main CI 通过，含主分支 race 和最早支持数据库升级；固定提交及结果统一见 [F4 验收记录](testing.md#f4-本轮收尾证据)，不在开发方案重复测试流水账。

仅确认 plain DIRECT/自有单跳 RELAY 的 Linux 路径，不打开默认开关、不承诺新组合或生产发布。真实 Panel 浏览器、独立原生 A00 发布 gate、长期运行和跨版本升级条件仍按 F0/统一标准交付。Windows LKG 并发文件读取及诊断/脱敏测试问题已记录在 [验证边界](testing.md#windows-deferred)，按用户指示暂停，不作为当前 F5 前置；扩大 Windows 支持前另行加固验收。

### F5：共享连接在线端点变更与密钥轮换

依赖：F1/F2，稳定部署与统计归属。估算：6–10 工程人日。

首个切片为**只读影响预览与版本化迁移契约**：实际 `/links` 页面可预览端点/端口变更或密钥轮换，API 校验 Workspace、管理权限、期望版本与部署代次，返回全部引用（含暂停规则）、候选监听、现有持有端口、预期中断及状态 token。通过现有编译器检查候选，不创建版本/代次/密钥、不预留端口、不下发命令。活动 TCP/UDP 数没有可信实时来源时为未知；待暂停/删除或旧代次运行不能报成无影响。候选编号仅预测，预览 60 秒过期，超过 500 引用或 2048 现有占用明确拒绝，不截断引用集合。此切片没有迁移执行器，既有端点和密钥限制保持，完整 F5 尚未交付。证据见 [测试说明](testing.md#f5-影响预览首切片)。

后续依次实现：持久化迁移状态机及提交 CAS → 候选代次/双端实际能力与端口预留 → 出口准备与新鲜事实验证 → 入口切换及明确 drain 窗口 → 旧路径退役与端口释放 → 每个故障点的补偿、重启恢复与精确统计归属。不得把预览 token 当作授权或已有 Ready；执行时必须重新验证策略、引用、能力、运行事实和占用。

<a id="f5-next-slice"></a>

#### 下一切片：持久迁移状态机与提交 CAS（待开发）

先完成执行基础，不在此切片直接开放有引用维护：

1. 冻结迁移记录、阶段与终态契约，保存不可变旧/候选配置、引用修订和统计归属；明确 LinkVersion/LinkDeployment 与迁移记录的职责，避免第二个 desired 写入源。
2. 提交重新检查 Workspace、管理权限、功能开关、策略、双方新鲜能力、完整引用 CAS、运行基线及端口占用。拒绝过期/变更后的预览；token 不代替授权，也不分配版本或租约。
3. 定义同 Link 并发维护/业务编辑的互斥规则、幂等重试和单调代次围栏。重复提交不能创建第二个迁移；迟到命令/ACK 不能推进新阶段或释放新所有者端口。
4. 先验收事务回滚、并发冲突、重复提交、权限/策略漂移、Worker 重启及未知 runtime 的保守恢复。执行器接入前，页面保持 `execution.supported=false`，原端点/密钥门禁不放开。

随后分别交付候选预留/出口准备、入口切换/排空、旧代退役/故障补偿，各切片均增加自身的真实 Linux gate；双代窗口、跨代统计授权和升级/回退格式必须先冻结再实现。

- 已交付只读影响预览：引用规则、节点、端口、候选版本和预期中断；实时活动连接数保持未知，CAS 冲突重读，不覆盖别人更改。待执行器补齐才开放提交。
- 为同一 Link 建立候选 carrier generation：预留新端口/密钥、准备出口授权、确认入口切换、关闭旧路径并回收。双代重叠时间有界，旧代不能继续无限接收。
- 旧 TCP 会话在明确 drain 窗口内结束，UDP 按迁移策略重建。旧/新 producer 都有不可变身份和准确流量归属；已确认旧版本不替代新版本 Ready。
- 处理出口准备失败、入口切换失败、失联、迟到 ACK、撤权和升级重启；补偿失败保留降级事实及占用，不能先释放旧端口。

交付标准：有引用时可受控变更，页面显示进度与中断影响；各故障点可重试或回退；旧密钥按窗口失效，旧端口只有运行事实确认后释放；计数不重复，其他 Link 不受影响。

回退：保留旧已提交版本及租约到切换确认；旧版本已退役后采用更高代次恢复，禁止撤销持久 fence。

### F6：安全多跳与出口/入口组，按三步扩展

依赖：F1–F5 及 placement 生命周期。需要新的业务成员模型，不能继续用单一 ingress_node_id 表示多个同时所有者。

| 切片 | 改动与前端交付 | 实网验收 | 估算 |
| --- | --- | --- | --- |
| F6a：固定安全多跳 | 先固定 3 节点；Link 版本表达逐跳端点/载体，编译 transit placement；逐跳密钥和授权独立，入口/中间/出口逐项展示。 | TCP/UDP/both 真实贯通；任一中间跳失联、错误密钥、端口冲突、部署半失败、删除和重启；不可回落明文；统计只计一次。 | 8–14 人日 |
| F6b：固定多出口主备 | 显式出口成员、健康窗口、优先级及切回；每成员租约/端口/fence，预览受影响规则。先单活，后负载分配。 | 故障/恢复/抖动/全不可用、慢确认、分区及重启；仅授权目标可接流量；切换不重扣额度，旧 owner 按租约关闭。 | 8–14 人日 |
| F6c：多入口与按需 DDNS | 入口成员真实部署；定义规则预算与 Workspace 总预算如何分片/回收，严格预算要求本地额度租约；故障后按需接真实 DNS provider。 | 两入口同时传输、断网、回收/迁移份额、并发变更、撤权及旧缓存；不把完整预算发给每个入口；DNS 记录与当前入口事实一致。 | 10–18 人日 |

逐跳统一采用可执行的支持组合；不同载体混用先小范围验证。动态中间池、自动最优路径和复杂拓扑编辑器排在这些固定路径之后。Federation 延续独立信任/grant/lease，不自动加入共享 FXP 的所有拓扑。

### F7：更多载体和执行驱动

依赖：placement 托管、版本能力和 F6 的逐跳表达。按实际需求逐项选入，不将全部驱动合成一个发布。

| 切片 | 复用与实现边界 | 必须验证 |
| --- | --- | --- |
| F7a：GOST TLS/WSS | 复用 ForwardX gostTunnelProtocol 与运行计划，固定程序版本、校验资产、按命名空间管理进程/配置；先发布一种加密 TCP 组合，再覆盖 UDP/both。估算 6–10 人日。 | 双端身份校验、证书过期/轮换、错误凭证、重启、真实 TCP/UDP；明确 UDP 的承载机制和队头阻塞/MTU 限制。 |
| F7b：WireGuard + FXP v2 | 参考 userspace WireGuard/netstack，作为独立 runner 接入，保持当前 Agent 依赖边界；复用上游密钥/peer/MTU 校验。估算 10–18 人日。 | 真 UDP 加密、NAT、MTU/分片、双栈、peer 授权、删除回收、升级恢复与 CPU/内存/吞吐基线。 |
| F7c：系统及二进制驱动 | 每次选择一个 nftables/iptables/realm/socat/nginx；新增能力检测、配置语法校验、确定的对象命名、幂等 apply/remove 和失败回收。每驱动约 4–8 人日，依需求重估。 | 不修改宿主已有规则/进程；缺二进制或权限明确拒绝；TCP/UDP、占用、重启、删规则与回滚实测。内核操作通过可选受限 helper，普通 Agent 不统一增加 NET_ADMIN。 |

TFO、出站地址/接口、协议阻断和特殊伪装按驱动的实际能力单独排期；上线前列清支持组合。FXP v2 等功能的源码/API 互通需要额外验收，不因复用同名算法就承诺兼容。

### F8：转发日常操作与诊断，贯穿各阶段

依赖：对应功能的稳定 API 和修订契约；首个最小切片 3–5 人日，后续按范围拆分。

- 先完成规则复制、目标集批量编辑、按资源/节点/协议/状态筛选和错误定位；随后增加版本化导入导出、资源替换预览和批量删除进度。导出不含密钥，跨 Workspace 导入重新授权/分配端口。
- 批量动作返回逐项结果、修订冲突和可重试状态；Link 规则走专用服务，不能绕过共享编译器。批删沿用确认、权限与真实删除流程，不能手工清租约代替停监听。
- 页面区分期望启用、部署确认、runtime Ready、目标健康和统计接收；部署链路逐跳解释原因，目标不可达不能显示“可用”。
- 诊断串联入口监听→载体连接→出口→目标，保留有限事件和脱敏 Support Bundle；只扩展能帮助定位转发问题的数据。

交付标准：真实浏览器操作实际 API 和多 Agent；部分失败不会重复创建；批量修改 A 集合时无关 B 长连接保持；导入错误/越权/端口冲突有逐项结果，敏感信息不进入 UI 或导出。

## 5. 里程碑、依赖和并行

| 里程碑 | 范围 | 用户可见结果 |
| --- | --- | --- |
| M1：共享转发可长期使用 | F0 + F1 + F2 + F8 最小切片 | 加密共享连接长期稳定计量，多个目标自动主备，状态可判断；完成限定组合的发布验收。 |
| M2：来源与协议完整 | F3 + F4 | 可信来源、PROXY/IP_HASH 和原生 both 在明确支持的路径可用。 |
| M3：连接维护与安全多跳 | F5 + F6a/F6b | 有引用连接可维护；固定加密多跳、固定多出口主备。 |
| M4：更多组和载体 | F6c + 按需求选择 F7 | 多入口及预算分配、GOST/WireGuard 或特定驱动。 |

当前开发队列：**F5 状态机/CAS → 候选准备 → 切换/排空 → 退役/补偿 → F6a → F6b**。F1/F2 首切片、F3 共享 TCP、F4 Linux both 已合并，不重复列为尚未开始；F0 发布验收、F1 真实跨日/归档、F3 原生来源扩展仍未完成。F8 随每个阶段交付；F6c/F7 按真实场景选择，Windows/缓存优化暂停，外围经营功能后置。

开发关键路径是 F5 提交契约 → 候选出口 → 入口切换 → 旧代退役/补偿。公开发布另受长期计量、实际程序能力、真实 Panel 浏览器和跨版本验收约束；F5 CI 绿色不能绕过这些条件打开全量 FXP。前端/API/Agent 在字段、版本、信任和回退约定确定后并行实现，每个共享编译入口保留单一负责人。

各工作包人日是原始范围的工程工作量初估，**不是当前剩余工期**，含定向测试、真实网络验收和文档更新；假设现有 Linux Docker CI 可继续使用、无需框架迁移。M1 原始估算约 18–32 人日，不能直接折算为单人几天或多人的线性日历工期。复杂跨版本协议、容量问题或新依赖引入后，按剩余切片重新估算；完整 ForwardX 功能对齐不属于 M1。

## 6. 统一交付标准

每个工作包提交可审查的源码、数据/配置迁移、页面操作、能力门禁、部署顺序、回退方法和对应验收证据。涉及 vendor 时更新修改清单，保留上游来源、许可证与依赖声明，按实际分发核对源码访问安排。

发布需要候选 SHA 的 required、真实 Linux 多 Agent payload、MySQL/Redis 事务及异常恢复验收。关键场景包括 held TCP、固定来源 UDP 映射、共享 A/B 隔离、部分部署失败、断网、迟到 ACK、重复统计、重启、删除及端口复用。针对新场景扩展 gate，不用 mock/skip 或历史绿色结果代替。

长期测试同时记录资源数量、磁盘增长、CPU/内存、速率误差、连接/映射数与故障恢复窗口；先建立可重复基线，再给性能目标，不能凭源码声称已超过 ForwardX。真实浏览器验证创建到删除的完整流程；fixture、构建和单元测试的证据范围保持明确。

## 7. 源码入口与待确定事项

| 主题 | 当前 TuneX 入口 | ForwardX 对标入口（上述固定提交） |
| --- | --- | --- |
| 维度、版本与组合 | [core-contract.ts](../backend/src/integrations/forwardx/core-contract.ts)、[link-compiler.ts](../backend/src/integrations/forwardx/link-compiler.ts) | `shared/forwardTypes.ts`、`server/tunnelRuntimePlan.ts` |
| 共享编排 | [link-resource.ts](../backend/src/services/link-resource.ts)、[links.ts](../backend/src/routes/links.ts) | `server/routers/tunnels.ts`、`server/routers/rules.crud.ts` |
| 维护预览契约 | [link-maintenance.ts](../backend/src/integrations/forwardx/link-maintenance.ts)、[预览表单](../web/src/components/links/link-maintenance-preview.tsx) | 参考连接修改的引用影响；TuneX CAS/租约/迁移一致性单独约束。 |
| 运行与修改 | [linkrunner](../agent/internal/linkrunner/README.md)、[FXP 来源](../third_party/forwardx/README.md) | `forwardx-fxp/main.go`、`config_types.go`、`agent/actions.go` |
| 统计与容量 | [managed_traffic.go](../third_party/forwardx/forwardx-fxp/managed_traffic.go)、[traffic_store.go](../agent/internal/linkrunner/traffic_store.go)、[link-traffic.ts](../backend/src/services/link-traffic.ts) | `forwardx-fxp/traffic.go`、`server/hostTrafficRuntimePlan.ts` |
| 目标与来源 | [egress.go](../agent/internal/forwarder/egress.go)、[target-health.ts](../backend/src/services/target-health.ts) | `shared/exitStrategy.ts`、`server/routers/rules.crud.ts`、`server/routers/forwardGroups.ts` |
| 路由与多载体 | [route-profile-compiler.ts](../backend/src/services/route-profile-compiler.ts) | `server/gostTunnelProtocol.ts`、`server/forwardXWireGuard.ts`、`agent/wireguard_runtime.go` |
| 用户流程 | [Link 页面说明](../web/src/components/links/README.md) | `client/` 中的规则、连接和转发组页面 |

F1 回收握手、F2 UDP 探测/映射、F3 共享 TCP 受信来源和 F5 只读预览 v1 已冻结，见运行说明；数据库水位仍保留，归档策略另行确定。尚需冻结 F3 原生来源扩展、F5 提交/双代窗口/跨代统计、F6c 全局预算分配，不需要先重建整个产品。

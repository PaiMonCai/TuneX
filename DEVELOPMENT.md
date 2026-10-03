# TuneX V5 开发执行规范（Agent Handoff）

> **文档地位：本文件是 V5 唯一可执行开发方案。**
>
> 本文件面向将直接在仓库中编码、测试、提交、开 PR 的开发 Agent。它不是历史复盘，也不是产品宣传。
> 任何 Agent 接手 V5 时，应优先遵守本文件；若本文与旧 V3/V4 过程文档冲突，以当前 main 代码事实、
> 本文的 V4 frozen baseline 与最新已合并迁移为准。
>
> **不要再创建第二份 V5 路线图。** 设计决策、阶段状态、Gate 与下一步都更新在这里。

---

## 0. 当前接手点

日期：2026-10-04。

### 0.1 main 状态

V4.5 已完成技术闭环，V4 功能范围冻结。V5.0 Contract Freeze 已开工。

已验证发布链：

~~~text
CI #493           success
Integration #139  success
Release #30       success
V4-F5             PASS=133 / FAIL=0
~~~

V4 发布证据与历史细节不再重复写入本文件，统一查阅：

- docs/tunex-devmap-v3.md —— v3 底层架构基线；
- docs/release-notes-v4.md —— V4.5 已验证能力与边界；
- docs/release-record-v4.5.md —— V4.5 发布窗口、镜像与 Gate 证据；
- docs/production-deploy.md —— 生产部署与运维；
- scripts/v3-e2e/evidence/ —— Integration Gate 证据。

### 0.2 V5-WP0 已进入 main：禁止重做

`feature/v5-wp0-contract` 已通过 PR #29 合入 `main`（合并提交 `61a8615`）。
旧的候选分支引用（`b34cd9b` / CI #512）已失效，**不要**再去拉那条分支。

WP0 落地内容（已冻结，改动它等于破坏 V5.0 契约）：

- Forward 产品层 canonical protocol（`backend/src/services/forward-contract.ts`）；
- topology mode 与 protocol 正交；
- transport 由 protocol 派生，不成为第二份用户/DB 真相；
- Forward revision snapshot 保存 protocol fact；
- deprecated /api/tunnels 创建路径与 /api/forwards 双写 canonical protocol；
- 历史 tunnel_type 事实保留，不因旧枚举存在就自动开放；
- scheduler 在下发前 fail-closed 拒绝未开放 protocol；
- Agent ForwardProtocol typed contract（`agent/internal/forwarder/interface.go`）；
- LKG/snapshot 入口解析协议并 fail-closed；
- unsupported_protocol 前端可行动错误文案；
- 未实现 UDP / TLS / WS / QUIC。

**接手 Agent 的第一件事不是重做 WP0，而是确认它仍在 main 上生效。**

当前 WP：**V5-WP1 Capability Negotiation v2**（见 §5.2）。

接手新工作前的固定动作（§3.2）：

1. 拉取最新 main，确认 WP0 的契约文件仍在；
2. 阅读本 WP 相关现有代码与测试；
3. 搜索是否已经存在同名/同义实现（V5-WP1 已落地，不要重做协商层）；
4. 写出当前事实与目标差异；
5. 只在确认「没有第二套实现」后开始修改。

不允许复制粘贴已有 WP 的代码到另一条新分支制造双实现。

---

## 1. V4 Frozen Baseline：V5 绝不能破坏的事实

V5 是能力扩展，不是第二次重构。

### 1.1 用户产品模型

用户只面对：

~~~text
Node
Forward
~~~

Tunnel 保留为内部 desired/runtime 兼容资源，不重新成为第一层用户产品。

不得新增：

- 第二套用户侧 Tunnel 产品；
- 第二套 DIRECT engine；
- 第二套 RELAY engine；
- 第二套端口所有权；
- 第二套 Agent 控制通道；
- 第二套 desired state 真相源。

### 1.2 Node 身份与角色

一个实际 Agent 对应：

~~~text
immutable agent_id
        ↓
     one Node
~~~

Node role 只描述能力：

~~~text
INGRESS
EGRESS
BOTH
~~~

role 不是身份，不允许因为 role 改变创建第二条 Node 记录。

### 1.3 Forward 拓扑

固定两种基础拓扑：

~~~text
DIRECT:
client → ingress → target

RELAY:
client → ingress → egress → target
~~~

RELAY 固定铁律：

1. 先准备出口；
2. 出口 ACK；
3. 再启入口；
4. 任一步失败执行补偿；
5. 失败保留 Forward/Tunnel 数据，不物理删除业务资源。

### 1.4 状态真相链

继续复用：

~~~text
Forward desired state
        ↓
config revision
        ↓
outbound-only command
        ↓
Agent ACK / result
        ↓
applied revision
        ↓
reconcile
~~~

V5 的新能力必须挂在这条链上。

禁止：

- route 直接绕过 orchestrator 下发；
- 新协议自己维护另一份 revision；
- Agent 自己成为业务 desired 的权威来源；
- heartbeat timeout 直接修改 Forward desired；
- 自动恢复绕过 lease / revision / fencing。

### 1.5 Port ownership

端口继续由 NodePortLease / port guard 统一管理。

任何新协议、HA、multi-hop 都不得自行 bind 一个“不在 lease 系统里”的端口。

### 1.6 V4 durability / ops 约束

必须继续成立：

- LKG 只恢复最后已知良好 applied 配置；
- Panel 恢复后，Panel desired 重新成为权威；
- graceful shutdown：停止新连接 → bounded drain → 收敛 → 最终上报；
- diagnostics / Support Bundle 不泄露 secrets；
- capability 是“实现能力”，不是授权；
- RBAC、resource scope、quota、runtime admission 分层不混合；
- unknown/malformed 输入优先 fail-closed。

---

## 2. 仓库工作区地图

V5 常用代码位置：

~~~text
backend/
  prisma/schema.prisma
  prisma/migrations/
  src/routes/forwards.ts
  src/routes/tunnels.ts
  src/services/forward-contract.ts
  src/services/forward-service.ts
  src/services/forward-revision.ts
  src/services/scheduler.ts
  src/services/orchestrator.ts
  src/services/agent-capability.ts
  src/services/control-protocol/
  src/services/runtime-reconcile-sink.ts
  src/services/forward-capability.ts

agent/
  internal/forwarder/
  internal/manager/
  internal/control/
  internal/restore/

web/
  src/components/forwards/
  src/components/nodes/
  src/lib/forward-status.ts
  src/lib/types.ts

scripts/v3-e2e/
  existing V3/V4 real topology
  V5 继续复用该真实拓扑，不另造平行 integration 环境

.github/workflows/
  ci.yml
  integration.yml
  release.yml
~~~

如果某个文件与此地图不一致，以仓库当前目录为准，但不要为了“整理目录”顺手做大范围搬迁。

---

## 3. 开发 Agent 的工作纪律

### 3.1 一次只做一个 WP

每个 WP 独立分支：

~~~text
feature/v5-wp<N>-<topic>
test/v5-g<N>-<topic>
perf/v5-wp<N>-<topic>
~~~

不要把 WP1 + WP2 + WP3 混在一个巨型分支。

### 3.2 开工前固定动作

每个 WP 开始前：

1. 拉取最新 main；
2. 阅读本 WP 相关现有代码与测试；
3. 搜索是否已经存在同名/同义实现；
4. 写出当前事实与目标差异；
5. 只在确认“没有第二套实现”后开始修改。

### 3.3 进入/退出判断

每做一个抽象或重构都检查：

- 是否减少重复真相；
- 是否让后续协议更容易，而不是让 TCP 更难懂；
- 是否引入第二个状态机；
- 是否把 stream 生命周期错误套到 datagram；
- 是否把 topology、protocol、transport 混成一个枚举；
- 是否让旧 Agent / 旧 Forward 无故失效；
- 是否把 capability 当 authorization；
- 是否因为“未来可能需要”提前实现大接口。

如果改动导致大量条件分支、复制 TunnelManager、复制 Reconciler、复制 port ownership，应停止当前路线，回到 contract 重新设计。

### 3.4 Schema 规则

优先 additive migration。

每个 migration 必须同时考虑：

~~~text
empty DB
existing V4 DB
legacy rows
rollback / old binary compatibility
historical fact preservation
~~~

不要用 DB enum 承载会频繁扩展的协议集合，除非有非常明确的理由。

### 3.5 控制协议规则

跨 Panel/Agent 字段必须先冻结 contract，再写实现。

新增字段默认：

- additive；
- 可选；
- 旧实现可安全忽略或明确拒绝；
- unknown/malformed fail-closed；
- 不改变已有 revision / ACK 语义。

### 3.6 测试规则

任何 WP 至少需要：

- 单元测试；
- contract test；
- 旧 V4 回归；
- 对 unknown / malformed 的反例；
- 新 schema 的 empty DB migration；
- existing DB upgrade。

涉及真实 runtime 的 WP 还必须进 Integration Gate。

### 3.7 合并规则

满足全部条件才能合并：

~~~text
CI green
相关 Integration Gate green
无未解释 skipped
无临时兼容 hack
无范围外功能
文档状态已更新
~~~

单元测试通过不等于 WP 完成。

---

## 4. V5 总路线

固定顺序：

~~~text
V4.5 frozen baseline
        ↓
V5.0 Contract Freeze
        ↓
      V5-G0
        ↓
V5.1 Protocol Expansion
  WS/TLS → UDP → QUIC
        ↓
V5.2 Target Intelligence
        ↓
V5.3 Resilience / HA
        ↓
V5.4 Multi-hop
        ↓
V5.5 Federation
~~~

状态：

| 阶段 | 状态 | 说明 |
|---|---|---|
| V5-WP0 | MERGED | PR #29 → main `61a8615`；契约冻结 |
| V5-WP1 | DONE（待 Integration Gate 覆盖） | 能力协商 v2：manifest 契约 + 三维 runtime admission |
| V5-WP2 | DONE（待 Integration Gate 覆盖） | RuntimePlan 补全 + Agent Runtime Factory（StreamRuntime 显式化） |
| V5-WP3 | DONE | TCP 性能基线（DIRECT / RELAY）+ 锚点产物 + 采集器自检 |
| V5-WP4 / G0 | **GREEN：PASS=137 / FAIL=0** | 真实四 Agent 拓扑，452s |
| V5.1+ | **UNBLOCKED** | G0 全绿，按 §6 顺序开始 V5.1a WS/TLS |

---

# 5. V5.0 — Contract Freeze

V5.0 不交付 UDP / QUIC 等新用户能力。

目标：

> 在不破坏 V4 TCP DIRECT/RELAY 的前提下，把后续所有协议、HA、multi-hop 所依赖的契约先固定。

---

## 5.1 V5-WP0 — Forward / Protocol / Transport Contract

### 状态

候选实现已完成，见 §0.2。

### 最终目标模型

~~~text
Forward
  ↓
ForwardDesiredState
  ↓
ProtocolSpec
  ↓
TransportSpec
  ↓
RuntimePlan
  ↓
Agent Runtime
~~~

正交维度：

~~~text
topology:
  direct
  relay

protocol:
  tcp
  future tls/ws/udp/quic

transport:
  stream
  future datagram
~~~

transport 是 protocol 派生事实，不是第二个用户字段，也不是第二个 DB desired 字段。

### DoD

- Forward 是唯一产品对象；
- canonical protocol 已落库；
- revision snapshot 保存 protocol fact；
- topology 与 protocol contract test；
- transport 由 protocol 派生；
- legacy protocol fact 不丢失；
- legacy enum 值不等于产品支持；
- scheduler 下发前拒绝未开放协议；
- Agent 未开放协议 fail-closed；
- V4 客户端省略 protocol 时继续 TCP；
- V4 TCP DIRECT/RELAY 行为不变；
- 不实现任何新协议。

---

## 5.2 V5-WP1 — Capability Negotiation v2

### 状态

**DONE**（本文件记录实现落点，后续 Agent 不要重做）。

落地位置：

~~~text
backend/src/services/capability-manifest.ts   契约 + 规范化 + 三维判定
backend/src/services/runtime-admission.ts     三维准入的唯一实现（action+protocol+transport）
backend/src/services/node-state.ts            上报校验 / 落库（capability_manifest）
backend/prisma/migrations/20261014000000_v5_wp1_capability_manifest/
agent/internal/control/manifest.go            Agent 侧 manifest（从真实实现派生）
agent/internal/forwarder/interface.go         protocol → transport 注册表（parser 同源）
agent/internal/reporter/heartbeat.go          上报字段 capability_manifest
agent/v3runtime.go                            wiring 按「实际构造了什么」生成 manifest
web/src/lib/forward-status.ts                 runtime_capability_denied 的可行动文案
~~~

生效点（**两处，同一实现**）：

~~~text
scheduler.createRelayTunnel / reapplyRelayTunnel / reapplyDirectTunnel
    下发前、端口租约产生前：ingress（+ RELAY 的 egress）全量判定
agent-command-bus.OutboundAgentTransport.assertCapability
    入队前最后一道：按出站 config 里的 protocol 判定
~~~

错误码：

~~~text
Tunnel.apply_error_code = runtime_capability_denied
apply_error              = [runtime_admission:<reason>:<layer>] ...
reason ∈ upgrade_required | incompatible_agent | malformed_capability_manifest
       | protocol_not_supported | transport_not_supported | runtime_feature_not_supported
~~~

刻意**没有**复用 `unsupported_protocol`：那一个是「产品还没开放这个协议」（等版本 /
换协议），这一个是「这台节点还没实现」（升级 Agent / 换节点），下一步动作不同。

已明确的边界：

- `control_protocol_version` 由 1 升到 2；面板不按版本号做准入，只按 manifest 事实；
- 面板看不懂的 `schema_version`（未来 Agent）→ 按「未上报」处理 → V4 baseline 继续，
  新协议仍拒绝（不制造灰度升级期间的全网中断）；
- manifest 的 `diagnostics` 维度是**观测用**，诊断下发仍由 V4 动作能力判定，
  避免同一权限出现两套真相；
- 未接入 Support Bundle / 节点详情展示（属后续 WP 的展示面，不影响准入）。

### 目标

把 V4 的“动作能力列表”升级为可表达：

~~~text
control protocol version
command actions
product protocols
transport runtimes
runtime features
diagnostic features
~~~

同时保留旧 Agent 兼容。

### 当前 V4 事实

已有：

~~~text
NodeStateReport.control_protocol_version
NodeStateReport.capabilities
backend/src/services/agent-capability.ts
~~~

V4 capabilities 是 string[]，主要表达 command action。

现有语义必须保留：

- capabilities 缺失：旧 Agent，baseline action 可继续；
- capabilities 存在但坏形状：fail-closed；
- capabilities 存在但不含动作：明确不支持；
- credential rotation 晚于 reported_at：旧 advertisement 失效；
- capability 不授予任何 RBAC/resource 权限。

### V2 推荐新增契约

不要把旧 capabilities 从 array 原地改成 object。

使用 additive 字段，例如：

~~~json
{
  "control_protocol_version": 2,
  "capabilities": [
    "apply_tunnel",
    "remove_tunnel",
    "suspend_tunnel",
    "diagnose_tunnel"
  ],
  "capability_manifest": {
    "schema_version": 2,
    "protocols": ["tcp"],
    "transports": ["stream"],
    "runtime": [
      "hot_reload",
      "graceful_drain",
      "lkg_restore"
    ],
    "diagnostics": [
      "tunnel_probe",
      "node_snapshot"
    ]
  }
}
~~~

字段名若实现前发现已有等价命名，可复用已有命名，但语义必须一致。

### Agent 规则

manifest 必须从实际编译进二进制的实现事实生成。

禁止：

- 从环境变量随意声明能力；
- 从 Panel 下发内容反向“学会”能力；
- 预先广告 tls/ws/udp/quic；
- capability 与套餐权限绑定。

当前 WP1 完成后，Agent 仍只应广告：

~~~text
protocols: tcp
transports: stream
~~~

### Panel 规范化

新增纯函数层：

~~~text
normalizeCapabilityManifest
capabilityFactsFromStoredV2
decideProtocolCapability
decideTransportCapability
decideRuntimeCapability
~~~

必须区分：

~~~text
manifest absent
manifest malformed
manifest present but missing item
manifest stale after credential rotation
~~~

### Runtime admission

DIRECT：

~~~text
ingress Node
  must support:
    required command
    protocol
    transport
~~~

RELAY：

~~~text
ingress Node
egress Node
  both must support:
    required command
    protocol
    transport
~~~

任何一端不满足，在 command 入队前拒绝。

### 数据库

建议 additive：

~~~text
NodeStateReport.capability_manifest Json?
~~~

如果现有 NodeStateReport 已有更合适 JSON 承载位，可复用，但不得破坏 V4 capabilities array。

### 错误码

继续使用 runtime_admission 层。

必须可区分：

~~~text
upgrade_required
incompatible_agent
malformed_capability_manifest
protocol_not_supported
transport_not_supported
runtime_feature_not_supported
~~~

不要把所有错误压成“节点离线”。

### 测试

至少覆盖：

1. old Agent：无 manifest，TCP baseline 继续；
2. v2 Agent：tcp + stream 放行；
3. v2 Agent：manifest 缺 protocol → 拒绝；
4. v2 Agent：manifest 缺 transport → 拒绝；
5. malformed manifest → fail-closed；
6. stale advertisement after credential rotate → 按未上报处理；
7. RELAY 一端支持、一端不支持 → 整条拒绝；
8. capabilities 仍不能越过 RBAC/quota；
9. Agent 不能广告未实现 UDP/QUIC；
10. V4 diagnose / collect_diagnostics 行为不退化。

### DoD

~~~text
old Agent + new Panel   V4 baseline works
new Agent + new Panel   v2 facts used
malformed v2            fail-closed
unknown capability      fail-closed
TCP only                still the only product protocol
~~~

---

## 5.3 V5-WP2 — Runtime Abstraction

### 状态

**DONE**（本文件记录实现落点，后续 Agent 不要重做）。

落地位置：

~~~text
agent/internal/forwarder/interface.go   StreamRuntime（显式 stream 生命周期契约）
                                        Forwarder = StreamRuntime（类型别名，V4 零改动）
                                        protocolRuntimes：protocol → transport 注册表
agent/internal/forwarder/factory.go     ResolveRuntimeTarget / ParseForwardTransport
                                        BuildStream：protocol+transport 解析先于构造
                                        streamBuilders：protocol → 构造器注册表
                                        RegisteredBuilders()（与 advertised 集合同源）
agent/internal/manager/tunnel.go        buildLocked 改为经 factory 构造，不再自己 switch
                                        （mode 分派下沉到 buildTCPStream）
backend/src/services/forward-contract.ts  RuntimePlan 补全为纯计划
                                        buildForwardRuntimePlan(mode, protocol, facts?)
                                        forwardRuntimePlanViolations(plan)
backend/src/services/orchestrator.ts    下发用计划里的 protocol（不再硬编码 "tcp"）
backend/src/services/scheduler.ts       计划在下发路径成型、自检，并随成功结果返回
~~~

RuntimePlan 现在表达的六件事（全部纯数据，无 socket）：

~~~text
topology   direct | relay
protocol   tcp（当前唯一）
transport  由 protocol 派生（当前唯一：stream / connection）
revision   这份计划对应的 config revision
placement  ingress_node_id / egress_node_id / egress_pool_id
listener   host / port（null = 尚未确定）
upstream   targets[] / next_hop（RELAY 独有）
~~~

计划的成型点就是重点：RELAY 的 `next_hop` 只有出口 ACK 之后才存在（§1.3 铁律一），
所以计划在「出口已 ACK、入口尚未启动」那一刻成型并自检；自检不通过就撤出口 + 释放
租约后失败（`invariant_violated`），绝不让入口带着坏 hop 启动。

已明确的边界：

- `Forwarder` 保留为 `StreamRuntime` 的**类型别名**，V4 数据面与全部既有测试零改动；
  新代码应写 `StreamRuntime`；
- 只有 manager 一处做 transport 分派（`BuildStream` 内），不是"到处 type switch"；
- 没有新增 UDP/TLS/WS/QUIC Manager，也没有第二个 revision / port owner；
  `single_manager_guard_test.go` 以源码级守卫钉住这一点；
- WP2 **不实现**任何新协议：`FORWARD_PROTOCOLS` 仍只有 tcp，`streamBuilders` 仍只有 TCP；
- 计划自检是防御性 guard（当前事实组合下不可达），但 V5.1 起会真的被触发，
  逻辑本身由 `forward-runtime-plan-v5.test.ts` 逐条覆盖。

### 目标

让 TCP 当前实现显式成为 Stream Runtime，为未来 Datagram Runtime 留出正确边界。

**不是重写 TCP。**

### 当前事实

Agent 已有：

~~~text
forwarder.Forwarder
TunnelConfig
TunnelManager
DIRECT / RELAY / EGRESS TCP runtime
Drain
SetUpstream
Stats
~~~

其中若某些方法只适用于 connection/stream，不应强迫未来 UDP 实现同一语义。

### 目标结构

~~~text
RuntimePlan
   ↓
RuntimeFactory
   ↓
┌─────────────────┬──────────────────┐
│ Stream Runtime  │ Datagram Runtime │
│ TCP now         │ no impl in WP2   │
│ TLS/WS future   │ UDP/QUIC future  │
└─────────────────┴──────────────────┘
        ↓
single TunnelManager / reconcile ownership
~~~

### 实现要求

#### A. Stream contract 显式化

将当前 TCP 所需行为明确为 Stream contract。

可以通过兼容 alias/adapter 完成，避免一次性 rename 全仓库。

例如：

~~~text
StreamRuntime
  Start
  Stop
  Drain
  Running
  Stats
  SetUpstream
~~~

如果保留 Forwarder 名称，也必须在代码中明确其当前语义是 stream-specific，而不是声称 UDP 未来必须实现完全相同接口。

#### B. RuntimePlan

Panel 侧 WP0 的 RuntimePlan 继续扩展为“纯计划”，不含 socket 对象。

至少表达：

~~~text
topology
protocol
transport
placement
listener facts
upstream facts
revision
~~~

WP2 仍只生成 TCP/stream plan。

#### C. RuntimeFactory

Agent runtime 创建统一经过 factory：

~~~text
RuntimePlan / TunnelConfig
        ↓
protocol + transport dispatch
        ↓
TCP stream implementation
~~~

unknown protocol/transport 必须在创建 listener 前失败。

#### D. Manager 不复制

禁止新增：

~~~text
UDPManager
TLSManager
WSManager
SecondTunnelManager
~~~

未来 Datagram 也必须复用相同 desired/revision/lease/reconcile ownership，只在数据面 lifecycle 内分叉。

### 退出信号

如果为了抽象出现：

- 巨型 Runtime 接口；
- 大量不适用于 TCP 的空方法；
- 到处 type switch；
- manager 被复制；
- TCP 热重载路径被重写；

则停止并收缩抽象。

### 测试

- V4 TCP DIRECT 全回归；
- V4 TCP RELAY 全回归；
- Drain 不退化；
- SetUpstream 不退化；
- unknown protocol factory fail-closed；
- unknown transport factory fail-closed；
- manager 仍只有一个 revision owner；
- no listener created before validation。

### DoD

WP2 完成时用户仍只获得 TCP。

---

## 5.4 V5-WP3 — Performance Baseline

### 状态

**DONE**（本文件记录实现落点，后续 Agent 不要重做）。

落地位置：

~~~text
scripts/perf/v5-tcp-baseline.py       采集器（纯标准库）：DIRECT / RELAY 双拓扑
scripts/perf/v5-tcp-baseline.sh       入口：构建 Agent → 调用采集器
scripts/perf/test_v5_tcp_baseline.py  自检：统计口径 / 产物形状（CI 里跑这一条）
scripts/perf/README.md                怎么跑、怎么解读、已知边界
scripts/perf/baseline/v5-g0-tcp-anchor.json  锚点产物（相对比较用，不是合格线）
agent/internal/api/server.go          GET /debug/runtime（goroutine 等仪表）
~~~

为什么需要 `/debug/runtime`：**goroutine 数不在 /proc 里**。它是进程内的事实，
而"功能通过、runtime 泄漏 goroutine"正是基线要发现的退化之一；读
`/proc/<pid>/status` 的 Threads 会默默量成 OS 线程数，于是永远看起来没问题。

输出契约：JSON 是权威格式，CSV 是同内容的摊平视图；每个数值都带
`median / p95 / min / max / mean / count`，并附完整 `environment`
（CPU 型号 / 核数 / 内核 / `cgroup_cpu_max` / loadavg / go 版本 / git rev）。

已明确的边界：

- **不是 CI 门槛**：CI 只跑采集器的纯函数自检（`perf-harness` 作业），不跑端到端
  测量 —— 共享 Runner 上的毫秒级硬门槛只会制造随机红灯（见本节下文「规则」）；
- 假面板不实现命令队列（404），因此测的是 desired/restore/LKG 这条路径，
  不是命令下发路径；命令队列由 Integration Gate 覆盖；
- CPU 分辨率是一个调度 tick（通常 10 ms）：quick 档读数可能为 0，产物会用
  `cpu_resolution_note` 说明"低于分辨率"而不是"没测到"；
- 只覆盖 TCP/stream；V5.1a/b/c 各协议需要各自场景。

实测（本机 quick 档一次运行，锚点产物原值）：

~~~text
DIRECT throughput   median 71.01 MiB/s   p95 101.24   （并发 16：4.95 / 6.34）
RELAY  throughput   median 58.13 MiB/s   p95  94.24   （并发 16：4.15 / 5.82）
connect             median 0.04 ms（DIRECT） / 0.03 ms（RELAY）   p95 0.60 / 0.14
restart (panel)     median 20.99 ms   sources=[panel]
restart (lkg)       median 21.00 ms   sources=[lkg]
hot reload          apply 0.78 ms / effective 1.32 ms
graceful drain      idle 64.08 ms / held 10063.77 ms（有界排空上限）
ingress gauges      goroutines 14–16 / RSS ~15 MB / 本轮 CPU 0.31–0.34 s
~~~

回环 + Python 采集器的数字波动很大（同一份代码在不同时刻能差数倍），所以这些数
只在**同一台机器上做相对比较**才有意义；跨机器比较必须同时读 `environment`。

### 目标

冻结 V4/V5-G0 的 TCP 性能参照，避免后续“功能通过、性能退化”不可见。

### 新增位置

建议：

~~~text
scripts/perf/
  v5-tcp-baseline.sh
  v5-tcp-baseline.py
  README.md
~~~

不要把易波动 benchmark 直接混入普通 unit test。

### 至少测量

~~~text
DIRECT throughput
RELAY throughput
connection setup latency
concurrent connections
CPU
RSS
goroutine count
hot reload latency
restart/reconnect convergence
graceful drain duration
~~~

### 规则

第一阶段只建立：

- 可重复场景；
- JSON/CSV 输出；
- 环境信息；
- median / p95；
- baseline artifact。

不要一开始用脆弱绝对阈值阻断 CI。

### 后续 regression 方式

优先：

~~~text
relative regression
historical trend
large regression alert
~~~

而不是对共享 GitHub Runner 设毫秒级硬门槛。

### DoD

- baseline script 可重复执行；
- 输出可机器读取；
- 能区分 DIRECT / RELAY；
- 不需要生产凭据；
- 不记录 secrets；
- README 写明环境与解释方式。

---

## 5.5 V5-WP4 / Gate V5-G0 — Contract Compatibility Gate

### 状态

**GREEN：`V5-G0 TOTAL PASS=137 / FAIL=0`**（真实四 Agent 拓扑，耗时 452s，
evidence: docs/evidence/v5-g0-result-20261003.txt）。V5.1 解锁。

落地位置：

~~~text
scripts/v3-e2e/v5-g0.py                20 项检查（G0.1–G0.20），复用现有 docker 拓扑
.github/workflows/integration.yml      V4-F5 之后接 V5-G0（V5.1 之前必须绿）
docs/evidence/v5-g0-result-*.txt       每次运行的原始结果
~~~

#### Gate 抓到的四个真实缺陷（已全部修复并加守卫）

这四个都是「契约没守住，但没人会立刻发现」的类型——它们是 Gate 存在的唯一理由。

1. **7 处下发调用完全不传协议**（`runtime-reconcile-sink.ts`、`forward-rollout-exec.ts`
   的 cutover 与回滚重放）。Orchestrator 对缺省协议回落到 `tcp`，于是历史
   `wss`/`udp` Forward 会被当 TCP 真跑起来。现全部携带协议，并由
   `dispatch-protocol-v5.test.ts` 做源码级守卫。
2. **Agent 启动恢复快照把每条期望行写成 `protocol: "tcp"`**
   （`buildDesiredNodeSnapshot`）。这是唯一一条刻意绕过 orchestrator 的下发面，
   于是每次 Agent 重启都会把一条 `wss` 历史行**当 TCP 复活**——G0 的 LKG 用例
   每重启一次 Agent 就复现一次。现在该 builder 逐行解析协议，未开放的协议行被
   **省略**并记入 `skipped`（不静默）；纯函数 `desiredTunnelConfigFor` 由
   `desired-snapshot-protocol-v5.test.ts` 逐条钉住。
3. **`admitPersistedProtocol` 把「投影忘了选协议列」当成 V4 的「省略协议 ⇒ tcp」**。
   现在「行里完全没有协议事实」**fail-closed**；「省略＝tcp」只保留在下发**入口**
   （`reconciler` 的 desired 投影确实漏了这两列，已补）。
4. **reapply 不回填 canonical protocol**：V4 行重新编排成功后 `forward_protocol`
   仍是 NULL，所有读者永远回落 legacy 列。

另外把「协议值写成字面量」本身变成了 CI 守卫（`no source file writes a protocol
value as a literal`）：协议值只能来自契约常量或行本身。

#### 教训（写给下一个接手的人）

**「下发路径」不止 `dispatch*`。** G0 的三次红→绿迭代中，前两次修复都只覆盖了
`Orchestrator` 的调用点，而真正在线上复活的路径是 **Agent 拉取期望快照**这一条。
判断某处是不是下发面，问的是「Agent 会不会因为这里而开始听一个端口」，不是
「这里有没有 `dispatch` 这个词」。

#### 一处刻意**不**修的观察

`suspend` 停掉运行时但**保留端口租约**（端口留给 `resume`，§7.12「重试不换端口」）。
G0 的第一版「所有 inactive Forward 都不得持有租约」断言因此误报——已改成只检查
真正永远是缺陷的两种形态：悬空租约、以及「inactive 且 error」（被拒绝的配置）。

### 目标

证明 V5 新契约没有破坏 V4。

### 建议位置

复用当前真实拓扑：

~~~text
scripts/v3-e2e/v5-g0.py
~~~

Integration workflow 在 V4-F5 后增加 V5-G0。

不要复制整套 docker topology。

### 必须验证

~~~text
1. V4 TCP DIRECT 不退化
2. V4 TCP RELAY 不退化
3. old Forward 无需重建
4. old Agent + new Panel baseline works
5. new Agent executes V4 baseline
6. omitted protocol => tcp
7. explicit unknown protocol => reject before dispatch
8. explicit unknown transport => reject
9. malformed capability manifest => fail-closed
10. protocol/transport mismatch => reject
11. revision/ACK semantics unchanged
12. stale revision still rejected
13. LKG old schema safe
14. LKG new schema safe
15. Panel desired overrides LKG after reconnect
16. diagnostics still redacted
17. deprecated /api/tunnels TCP create still canonicalises correctly
18. existing DB migration preserves historical protocol fact
19. non-TCP historical fact is not accidentally admitted
20. no second listener / orphan lease after rejected config
~~~

### Gate 结果格式

~~~text
V5-G0 TOTAL PASS=<n> FAIL=<n>
~~~

FAIL > 0 时：

- 不开始 V5.1；
- 不用 skip 掩盖；
- 不把失败改成 warning；
- 修完后重新跑完整 G0。

---

# 6. V5.1 — Protocol Expansion

只有 V5-G0 全绿后才能开始。

固定顺序：

~~~text
V5.1a WS/TLS
   ↓
V5.1b UDP
   ↓
V5.1c QUIC
~~~

每种协议独立 Gate。

legacy TunnelType 中存在字符串，不代表协议已实现。

---

## 6.1 V5.1a — WS / TLS

### 第一任务：先冻结语义，不准从枚举名字猜

在编码前写清 mini-contract：

~~~text
What is user-visible protocol?
What is internal transport?
Where is TLS terminated?
Where are certificates owned?
Does WS wrap client-facing traffic or inter-node hop traffic?
How does DIRECT behave?
How does RELAY behave?
How are secrets rotated?
~~~

如果仓库现有产品要求无法唯一回答，不要靠猜测直接实现。

### WP5-A0 语义契约（已冻结，2026-10-03）

§6.1 要求编码前先唯一回答七个问题。下面是**答案 + 依据**：每条依据要么指向仓库
事实（文件:行），要么指向已经冻结的 V5 不变量。凡仓库事实无法唯一回答的，写成
「需要产品决策」并**不实现**，而不是靠枚举名字猜。

#### 1. 什么是用户可见协议？

`FORWARD_PROTOCOLS` 里的值（今天只有 `tcp`；V5.1a 增加 `tls`、`ws`）。
用户创建 Forward 时通过 `protocol` 字段选择，`routes/forwards.ts` 用
`z.enum(FORWARD_PROTOCOLS)` 校验 —— 所以「新增协议 = 改契约 + 改这一处白名单 +
它的 Gate」，没有第二条入口。

**不是**用户可见协议：`TunnelType` 里的 `mtcp / tunex / mtls / mwss`。这些是历史
wrapper/实现名（`prisma/schema.prisma` 的 `enum TunnelType`），WP0 已定：枚举里有
这个名字，不等于产品支持它。

#### 2. 什么是内部 transport？

`stream`（`FORWARD_TRANSPORTS`，`lifecycle: "connection"`）。tcp / tls / ws 都是
连接型，所以三者共用同一个 stream 运行时（§6.1「WS/TLS 属于 stream lifecycle；
复用 Stream Runtime」）。

**Agent 之间的那一跳仍然是裸 TCP**：`agent/internal/forwarder/singhop.go` 的
`Start()` 用 `net.DialTimeout("tcp", nextHop)` 连接下一跳。V5.1a **不改这一跳**：
前端 TLS 终止、WS 解帧之后，转发出去的仍然是一条普通字节流。理由：这一跳在运维
自己的信任域内，为一个新前端协议引入第二套跨节点传输 = 第二份 transport 真相 +
一个新的失败面，而它没有自己的 Gate。

#### 3. TLS 在哪里终止？

在**入口 Agent 的 listener**（面向客户端那一侧）。`protocol=tls` 的入口监听是一个
TLS server（Go `crypto/tls`，标准库，不新增依赖），握完手之后的明文流与今天的 TCP
隧道走完全相同的转发路径。

不终止 TLS 的地方：出口节点不终止、跨节点跳不做二次加密、面板不参与数据面。

#### 4. 证书归谁所有？

归**部署/运维**，以**节点上的文件**形式存在（Agent 的 state dir，与既有
`StateDir`/`LKGPath` 同一个布局）。Forward 只携带**路径**
（`tls: { cert_path, key_path }`），**绝不携带密钥material**。

依据：
- 面板没有 per-resource secret store；为证书新建一套，就会与
  `node_credential` + 部署层 env Fernet 形成第三套密钥系统（§1.1 禁止第二份真相）；
- §6.1 强制原则「certificate/key 必须进入现有 secret redaction」——
  `services/redaction.ts:55` 已经按形状删除 PEM 私钥块。让密钥只以路径形式流经
  控制面，redaction 是**兜底**而不是唯一防线。

#### 5. WS 包的是客户端流量还是跨节点跳？

**客户端流量**。WS 客户端连入口 listener，Agent 把 WS 帧解出来的**字节流**转给
target；跨节点跳不变。

因此 V5.1a 里 `ws` 是**分帧协议**，`tls` 是**传输安全**，两者正交：

~~~text
protocol（分帧/语义维度）:  tcp | ws
transport security（加不加 TLS）:  目前没有独立字段
~~~

`wss` **不**作为新的 protocol 值加入。理由：把「wss」当成一个协议名，正是 WP0 花
力气拆掉的混淆（topology / protocol / transport 三个维度混成一个枚举）。
`wss = ws + TLS 终止` 在语义上是成立的，但产品目前**没有**表达「这条转发要不要
TLS」的用户字段 —— 那是产品决策，**留作待定项**（见文末），本轮不猜、不实现。

#### 6. DIRECT 怎么表现？

~~~text
client → ingress listener(tcp | tls | ws) → 解密/解帧 → 裸 TCP → target
~~~

没有出口节点，没有跨节点跳。listener 的协议只是入口那一层的形态。

#### 7. RELAY 怎么表现？

~~~text
client → ingress listener(tcp | tls | ws) → 解密/解帧
       → 裸 TCP 一跳 → egress（EGRESS 池）→ target
~~~

出口节点只看见一条普通 TCP 流，**不需要知道**前端协议是什么；它的 EGRESS 行为、
目标池、负载均衡、健康视图全部不变。§1.3 铁律（先出口、出口 ACK、再入口、失败
补偿）对三种协议完全一致 —— 协议不改变编排顺序。

#### 8. 密钥/证书怎么轮换？

- **证书/私钥**：运维在节点上替换文件。Agent 在**构建/替换 listener 时**读取；
  轮换 = 一次配置重载（新 revision）。**重载失败必须保留上一份 applied 配置**
  —— 复用既有 replace-listener 路径（它已经在失败时保留旧配置），不新建 reload
  机制、不新建轮换表。
- **node_credential**：语义不变（轮换后旧的 capability advertisement 依旧失效）。
- 不引入第三套轮换系统。

#### 实施状态

| 子项 | 状态 | 说明 |
|---|---|---|
| WP5-A0 语义契约 | **DONE** | 本节上文，2026-10-03 冻结 |
| WP5-A1 TLS stream runtime | **DONE** | 见下（真实拓扑已验证） |
| WP5-A2 WS stream runtime | **DONE** | 见下（真实拓扑已验证） |
| WP5-A3 protocol diagnostics | **DONE** | 见下 |
| Gate V5-G1A | **GREEN PASS=73 / FAIL=0** | `scripts/v3-e2e/v5-g1a.py`，证据 `docs/evidence/v5-g1a-result-20261004.txt`（154s，真实四 Agent 拓扑） |

**WP5-A1 落地位置**

~~~text
agent/internal/forwarder/base.go       pipeTracker.listen 接缝（一个函数值，不是抽象层）
agent/internal/forwarder/singhop.go    NewSingleHopTLS：唯一区别是 listener
agent/internal/forwarder/factory.go    buildTLSStream：先加载证书，再构造 listener
agent/internal/forwarder/interface.go  ProtocolTLS + tls_cert_path/tls_key_path + Validate
agent/internal/forwarder/tls_test.go   握手/负例/热替换/排空（自签证书测试期生成，不入库）
backend/src/services/forward-contract.ts   tls 开白名单 + tlsPathsForProtocol
backend/src/services/control-protocol/validator.ts  tls_* 路径的形状校验（additive）
backend/src/services/orchestrator.ts   tls 字段只下发到面向客户端的那一跳
backend/src/services/agent-command-bus.ts  期望快照按行解析协议并携带路径
backend/src/services/scheduler.ts      重推/创建路径携带路径
backend/prisma/migrations/20261015000000_v5_wp5a1_tls_front        两列可空路径
backend/prisma/migrations/20261015000100_v5_wp5a1_tls_entitlement  上界与默认模板加入 tls
~~~

**真实拓扑验证**（evidence: docs/evidence/v5-wp5a1-tls-e2e-20261003.log）

~~~text
tls 无证书路径      -> 400 tls 转发必须提供证书与私钥路径
tcp 带证书路径      -> 400 只有 tls 转发可以携带证书/私钥路径
旧 Agent（未广告 tls）-> 502 runtime_capability_denied: protocol_not_supported   ← WP1 准入生效
新 Agent + 有效证书 -> 201，4s 内 active
TLS 握手 + 转发      -> 握手成功，目标回包 b'WP14-TARGET-A\n'
~~~

最后一条是 A1 的要害：TLS 在**入口 listener** 终止，解出来的明文流仍走同一条转发路径；
而倒数第二条证明「协议开放 ≠ 旧节点自动可用」——面板在入队前就拒绝了。

两个设计要点（容易被后续改动破坏）：

1. `tlsFields` **只**出现在 DIRECT / RELAY（面向客户端的那一跳）。EGRESS 保持裸 TCP
   listener：出口节点面对的是入口节点，跨节点跳按契约不变。把 tls 混进 EGRESS
   会让"TLS 在入口终止"这句契约失效。
2. 证书路径**只**随 `protocol=tls` 下发；tcp 携带路径会被拒绝而不是被忽略——
   否则线上会出现"Agent 必须主动忽略"的字段。

**WP5-A2 落地位置**

~~~text
agent/internal/forwarder/base.go       wrapConn 接缝（替代 A1 的 listen 接缝：一个机制覆盖两种前端）
agent/internal/forwarder/singhop.go    TLS 改用同一个接缝（tls.Server）
agent/internal/forwarder/websocket.go  握手 + 帧编解码（纯标准库，agent 无第三方依赖）
agent/internal/forwarder/factory.go    buildWSStream（ws 无额外配置，失败只按连接计）
agent/internal/forwarder/websocket_test.go  9 个用例
backend/src/services/forward-contract.ts    ws 开白名单 + legacy 投影可为 null
backend/src/services/control-protocol/types.ts  wire 词汇表加入 ws
backend/prisma/migrations/20261015000200_v5_wp5a2_ws_entitlement
~~~

**真实拓扑验证**（evidence: docs/evidence/v5-wp5a2-ws-e2e-20261003.log）

~~~text
ws create            -> 201，active
WS 握手              -> HTTP/1.1 101 Switching Protocols，Sec-WebSocket-Accept 校验通过
masked binary frame  -> 目标回包 b'WP14-TARGET-A\n'（opcode=0x2）
~~~

**A2 抓到的三个真实问题（都已修，且都不是"测试问题"）**

1. **握手期的字节上限把整条连接限死了。** 第一版用 `io.LimitReader(conn, 16KiB)`
   包住连接读握手——那 16 KiB 于是成了**整条隧道**的上限，任何客户端传过 16 KiB
   就被重置。现在按行读头部并单独限长，且复用同一个 `bufio.Reader` 给后续帧用
   （换成"另起一个 reader 读头部"会吞掉与头部同段到达的第一帧）。
2. **`ws` 在遗留枚举里不存在。** 数据库 `TunnelType` 只有 `wss`，没有 `ws`；
   第一次真实创建直接 500。写 `wss` 等于断言"WebSocket over TLS"，是假话；
   往枚举里加值又是 §3.4 明确劝退的"用 DB enum 承载会频繁扩展的协议集合"。
   于是把两个投影分开：**DB 列省略**（`legacyTunnelTypeColumn` 返回空对象，走列默认值），
   **wire 字段回落到协议名本身**（`wireTunnelTypeForForwardProtocol`）。
3. **wire 校验白名单也要加 `ws`。** 面板下发时被冻结的 payload 校验器拒了
   （`payload.tunnel.tunnel_type 必须是 tcp/mtcp/.../quic`）。wire 词汇表可以领先
   于 DB 枚举——这一点已写进 `types.ts` 的注释，避免下一个人再踩。

**V5.1a 之后的 V5-G0 回归重跑：GREEN PASS=137 / FAIL=0**

（证据 `docs/evidence/v5-g0-rerun-after-v51a-20261004.txt`。协议扩张最容易伤到的就是
V4 的兼容契约，所以 §5.5 要求每个协议阶段之后都要重跑这个 Gate。重跑时两处断言按契约
预期翻转：G0.5 现在要求 Agent 广告「本分支真正实现的协议集合」，G0.7 的"未开放协议"例子
从 udp 换成 quic —— 例子不跟着走，这条检查就会静默地不再检查任何东西。）

**V5.1a 收口（Gate V5-G1A 全绿）**

~~~text
G1A.1  tcp 回归                      旧协议未被新协议破坏
G1A.2  tls 正向                     真实证书 → 握手 → 字节回环
G1A.3  tls 负例                     证书不匹配 / 文件缺失 → fail closed，不建监听
G1A.4  ws 正向                      101 + 掩码帧 → 字节回环
G1A.5  ws 负例                      明文 HTTP / 垃圾字节不被升级，监听存活
G1A.6  证书轮换                     换文件 → 新连接用新证书；live 连接不断
G1A.7  热重载                       tls/ws 改目标：监听端口不动、流量继续
G1A.8  Agent 重启                   tls 监听自动恢复（路径随 desired state 回来）
G1A.9  Panel 重启                   数据面不受影响
G1A.10 旧 Agent 准入                未广告 tls/ws 的节点在入队前被拒
G1A.11 无密钥泄漏                   Agent 日志与支持包都不含私钥
G1A.12 优雅排空                     suspend 后不再接受新客户端
~~~

**Gate 一共抓出 7 个真实缺陷（未 skip、未降级）**

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | tls/ws 转发热重载必然失败 | rollout 路径传了协议、没传证书路径 | 共享 `dispatchFactsFromRow`（协议 + 该协议必需配置一次解析），四条下发路径统一 |
| 2 | Agent 重启后 tls 监听不回来 | restore 快照解码器不认识新字段 | `tunnelPayload` 补两列 + 解码器带过 |
| 3 | ws 转发无法改目标 | 遗留列默认 `wss` 被当协议事实读，策略层拒绝 | 四处策略读取改用 canonical protocol（`persistedForwardProtocol`） |
| 4 | 证书轮换后仍用旧证书 | 证书只在建 listener 时读一次，而热交换不重建 listener | `certReloader`：按文件戳在**每次握手**时重读；换坏文件保留上一份好的 |
| 5 | ws 创建 500 | 遗留 enum 无 `ws` | DB 列省略（走列默认）+ wire 字段回落协议名 + wire 词汇表加 `ws` |
| 6 | ws 转发改目标不生效 | 同上第 3 条（同一根因的另一条路径） | 同上 |
| 7 | 账单视图把 ws 显示成 wss | `traffic.ts` 直读遗留列 | 同第 3 条（改成 canonical，缺失时不臆造默认值） |

**这一阶段的教训（写给下一个人）**：三次"新增必需字段"的漏网都发生在**同一类位置** ——
下发/恢复/投影路径里"读到了协议、却没收下这个协议需要的配置"。所以现在的纪律是：
协议与它的必需配置**由一个函数一起解析**（`dispatchFactsFromRow`），任何路径都不许
自己拆开读第二次；新增必需字段时，改这一个函数 + 让它编译失败，就是全部工作。

Gate 自身也修了三个"看起来像产品缺陷"的问题：PEM/DER 比对、把 `raw` socket 在
`wrap_socket` 之后再设超时（EBADF）、以及两个 gate 进程并发跑（一个在种假 Agent
清单、另一个在创建 ws 转发）。第三个尤其值得记：**gate 会改动共享拓扑，必须自己
上锁**，否则它会把自身的并发问题报成产品故障。

#### V5.1a 实施范围（A1/A2/A3）

~~~text
WP5-A1  TLS stream runtime   protocol=tls：入口 TLS listener + 证书路径校验
WP5-A2  WS stream runtime    protocol=ws：入口 WS listener + 帧解包
WP5-A3  protocol diagnostics tls/ws 的协议专属诊断事实（握手失败原因等）
Gate V5-G1A                  见下
~~~

三项都必须：复用 stream 契约 / revision-ACK / 端口租约 / drain；不复制 manager；
Agent 只在**真正编译进二进制**时才广告 `protocols` 里的 `tls`/`ws`
（`forwarder.ImplementedProtocols()` 与 manifest 同源，WP1/WP2 已建立这条链）。

#### Gate V5-G1A（映射到可执行检查）

~~~text
TCP regression                  V5-G0 的 G0.1/G0.2 在 V5.1a 分支上重跑
TLS positive / negative         证书正确 ⇒ 握手成功且流量穿透；证书错误 ⇒ 明确拒绝
WS positive / negative          正常 upgrade + 帧往返；非 WS 请求 ⇒ 明确拒绝
malformed handshake             截断/垃圾字节 ⇒ listener 不崩、不泄漏、留诊断事实
certificate reload              换证书文件 + 新 revision ⇒ 新连接用新证书、live 连接不被强杀
bad certificate config          路径不存在/私钥与证书不匹配 ⇒ fail closed 且保留上一 applied
hot reload                      target 热替换（§13.3.4）在 tls/ws 下同样不重建 listener
drain                           有在途连接时 SIGTERM ⇒ 有界排空
reconnect / Agent restart       / Panel restart     V4 既有耐久性路径在 tls/ws 下不变
unsupported old Agent admission 旧 Agent 未广告 tls/ws ⇒ 面板在入队前拒绝
no secret in logs/support bundle 私钥内容不出现在日志、诊断、Support Bundle
~~~

#### 待定项（需要产品决策，本轮**不实现、不猜测**）

1. **是否需要「这条转发加不加 TLS」的用户可见维度**（即 `wss` / 任意协议 + TLS）。
   本契约已把两个维度拆开，缺的只是一个用户字段与它的默认值。
2. **证书供给方式**：目前定为「运维放文件 + Forward 携带路径」。若产品要求面板
   托管证书（上传/签发/自动续期），那是一个**新 WP**，并且必须自带密钥存储与
   轮换设计 —— 不允许顺手塞进 V5.1a。

### 强制原则

- WS/TLS 属于 stream lifecycle；
- 复用 Stream Runtime；
- 复用 revision/ACK；
- 复用 port lease；
- 复用 drain；
- 不复制 manager；
- certificate/key 必须进入现有 secret redaction；
- config reload 失败必须保留上一 applied；
- live connection 不因普通配置更新被无界强杀。

### 分阶段

推荐：

~~~text
WP5-A0 semantics contract
WP5-A1 TLS stream runtime
WP5-A2 WebSocket stream runtime
WP5-A3 protocol-specific diagnostics
Gate V5-G1A
~~~

### Gate V5-G1A

至少：

- TCP regression；
- TLS positive/negative；
- WS positive/negative；
- malformed handshake；
- certificate reload；
- bad certificate config；
- hot reload；
- drain；
- reconnect；
- Agent restart；
- Panel restart；
- unsupported old Agent admission；
- no secret in logs/support bundle。

---

## 6.2 V5.1b — UDP

> **契约已冻结（WP5-B0，2026-10-04）**：完整语义见
> [`docs/v5-1b-datagram-contract-draft.md`](docs/v5-1b-datagram-contract-draft.md)，
> 该文档由 `DEVELOPMENT.md` §6.2 的要求驱动写成，回答八个问题并列出未猜测的开放
> 产品决策；本文只保留结论与实施边界。拆分：
>
> ~~~text
> WP5-B0  datagram 语义契约         DONE（上文链接）
> WP5-B1  UDP DIRECT               **DONE**（Gate V5-G1B GREEN 76/0）
> WP5-B2  UDP RELAY                阻塞：跨节点跳的形态是开放产品决策，不猜
> Gate V5-G1B                      **GREEN PASS=76 / FAIL=0**（`scripts/v3-e2e/v5-g1b.py`，证据 `docs/evidence/v5-g1b-result-20261004.txt`）
> ~~~
>
> **已冻结的结论（摘要）**
>
> | # | 结论 |
> |---|---|
> | 协议/传输 | 用户选 `protocol=udp`；`transport=datagram` 由协议派生，不是第二个字段。`datagram` 之所以是传输而不是协议：传输维度本就定义为「字节/报文怎么走」，而协议是「谁在说话」 |
> | 生命周期 | stream 的单位是**连接**（有人关闭才结束）；datagram 的单位是**映射**（按空闲超时过期，目标侧没有可持有的对象——UDP 里没有 FIN 可观察）。因此 `ForwardTransportSpec.lifecycle` 增加了 `"mapping"` |
> | 会话 | 入口映射的键 = 监听标识 + **归一化后的客户端地址**；目标**永不**进入键；映射**永不**持久化（LKG 只恢复配置，不恢复映射） |
> | 三种结束方式 | 空闲过期、runtime 停止/进程退出，以及**明确指出：不存在显式关闭**。写下来是因为 TCP 的经验在这里会误导人 |
> | StreamRuntime 映射 | `Start`/`Stop`/`Running` 适用；`Stats` 适用但单个 int64 不够（需要每方向报文/字节、映射数、丢弃数）；**`Drain` 与 `SetUpstream` 明确禁止强加给 datagram**，替代物是"停止新建映射"（socket 保持打开，因为回程共享它）与 `Retarget` |
> | 端口所有权 | 仍走 NodePortLease + 端口守卫；但租约键是 `UNIQUE(node_id, port)` 而内核里 TCP/UDP 是两个命名空间 —— 因此冻结**保守规则：同一节点上 TCP 与 UDP 不共享端口号** |
> | 观测 | 不得假装存在"连接数"；事实走 V5-WP5-A3 的每隧道 `diag` 通道（`runtime_counts` 是**封闭键集**，加未知键会让整份上报 400） |
>
> **开放产品决策（不猜，等产品回答）**：UDP RELAY 的跨节点跳形态（裸 TCP + 分帧 / UDP 出口 / 5.1b 不做 RELAY）、空闲超时取值与可配置性、映射上限与超限行为、TCP 与 UDP 是否允许共用端口号、UDP 是否计费及计在哪个链上、IPv4/IPv6 绑定与 v4-mapped 归一化、udp+DTLS 这一正交维度、以及协议级的套餐开关。
>
> **实施边界（B1）**：只做 UDP **DIRECT**。`udp` 在 EGRESS/RELAY 上必须被**拒绝**并给出明确错误，而不是半实现 —— 跨节点跳的形态未冻结。
>
> **无第二条实现**：datagram runtime 是新类型（不复用 `pipeTracker` 的连接模型），但生命周期、端口守卫、清单派生、诊断通道**复用既有机制**，不另建一套。

UDP 是新的 Datagram lifecycle，不得套 TCP connection 模型。

### 目标生命周期

~~~text
listen packet
  ↓
derive client/session key
  ↓
lookup/create mapping
  ↓
forward packet
  ↓
receive response
  ↓
return to client
  ↓
idle expiry
  ↓
mapping cleanup
~~~

### 建议拆分

~~~text
WP5-B0 Datagram contract
WP5-B1 UDP DIRECT
WP5-B2 UDP RELAY
WP5-B3 UDP telemetry/accounting
Gate V5-G1B
~~~

### Datagram contract 必须定义

- mapping key；
- idle timeout；
- mapping ceiling；
- cleanup；
- target change 对 existing/new mapping 的语义；
- packet/byte accounting；
- IPv4/IPv6；
- error handling；
- restart/LKG；
- drain 对 datagram 的定义。

### UDP DIRECT 先于 UDP RELAY

先证明：

~~~text
client → ingress → target
~~~

再做：

~~~text
client → ingress → egress → target
~~~

不要同时调试两种拓扑。

### Gate V5-G1B

**执行结果：PASS=76 / FAIL=0**（真实四 Agent 拓扑；证据 `docs/evidence/v5-g1b-result-20261004.txt`）

覆盖：流协议回归（tcp/tls/ws 未被新协议破坏）、udp DIRECT 数据报往返、映射语义（两个客户端两条映射、目标不进键）、
空闲过期（按 runtime **自己上报**的超时等待，不猜常量）、udp+RELAY 被拒、畸形/超大报文、
旧 Agent 准入、Agent 重启、Panel 重启、TCP/UDP 不共享端口号、热重载（新映射走新目标且端口不动）、
诊断事实、无载荷泄漏、suspend。

**这一阶段抓到的真实缺陷**

| # | 缺陷 | 说明 |
|---|---|---|
| 1 | **A3 的诊断通道在生产里根本没接上** | `reporter.WithDiagnostics` 有实现、有单测，但 `v3runtime.go` 从未调用它 —— 单测直接构造 reporter，所以永远测不出"生产没接线"。症状是每条隧道的 `diag` 都不存在，只有端到端 Gate 能发现。 |
| 2 | 只改证书路径的 PATCH 被判成 metadata-only | 接口回 200，新路径既不落库也不下发 —— "轮换成功"却继续用旧证书。（web 侧发现，已在 A1 的修复提交里修掉） |
| 3 | udp+RELAY 面板不设防 | 边界只写在 Agent 一侧，面板可以建出一个永远不会生效的转发。已在纯校验层加 `datagram_relay_unsupported`。 |
| 4 | gate 自己的 UDP echo target 是一次性的 | busybox `nc -lu` 收一个报文就退出，gate 的"就绪探测"把它吃掉了 —— 于是每条数据报都超时，看起来像产品故障。gate 现在自带 echo 服务（可重复、可区分目标）。 |
| 5 | gate 会与自身并发 | 两个 gate 进程同时改共享拓扑（一个种假 Agent 清单、一个建 ws 转发）→ 幽灵故障。现在有单实例锁。 |

**关于 UDP 的开放决策**：B2（UDP RELAY）**未做**，因为跨节点跳的形态是开放产品决策（见 §6.2 与契约 §9.1）。
这不是"跳过"：契约冻结了 B1 只做 DIRECT，Gate 也把"RELAY 必须被拒绝"作为通过条件之一。
实现层为其余开放项选了**有文档、可注入**的默认值（空闲 30s、映射上限 1024、超限丢新映射、拨号 3s 上限、
读错误退避 20ms；最坏内存约 64 MiB/隧道）。

至少：

- one client；
- many clients；
- same/different source；
- bidirectional packet；
- idle expiry；
- mapping ceiling；
- target unavailable；
- target hot update；
- Agent restart；
- Panel outage；
- LKG restore；
- packet accounting；
- lease conflict；
- DIRECT；
- RELAY；
- old Agent rejected before dispatch。

---

## 6.3 V5.1c — QUIC

> **状态：契约已冻结（WP5-C0，2026-10-04），实现被架构决策阻塞。**
> 完整草案见 [`docs/v5-1c-quic-contract-draft.md`](docs/v5-1c-quic-contract-draft.md)。
>
> **§6.3 漏写的实现前置（最重要的事实）**：**Go 标准库没有 QUIC**。V5.1a/V5.1b 的七个
> 问题全落在「标准库能做什么」之内，所以契约写完就能开工；QUIC 不是 —— 一个真实前端
> 需要数据面的**第一份第三方依赖**，而「数据面零第三方依赖」（`agent/go.mod` 明文声明、
> README 反复声明、CI 离线构建依赖它）是一条**架构属性**，不是随手可改的实现细节。
>
> 已实测的代价（不选，只定价）：
>
> | 选项 | 代价 |
> |---|---|
> | 引入 quic-go | **13 个模块**（8 直接 + 5 间接），要求 `go 1.26.0` → 必须同时改 `agent/go.mod`(1.22)、`agent/Dockerfile`、CI 的 go-version；**离线构建消失** |
> | vendor 进仓库 | 保住离线构建，依赖图不变，仓库进数 MB 第三方源码，工具链三件套照样要动 |
> | 契约层关闭（只交付契约） | 零依赖属性一件不改，**唯一不需要改既有 Gate 的选项**；代价是 V5.1c 零能力 |
> | 推迟 | 与上一项的差别只是意图与重开条件；注意 `golang.org/x/net/quic` 自称 *not ready for production usage* 且不受 Go 安全策略覆盖，stdlib 方向**不是就绪的后路** |
> | 用 `crypto/tls.QUICConn` 自研 | 零依赖、不动工具链；代价是手写 RFC 9000/9001/9002 胶水，互操作成为主要风险 |
>
> **决定权在产品/架构，不在实现者**。因此 **V5.1c 标记为「阻塞：待依赖决策」，
> Gate V5-G1C 同样是阻塞项而不是待办 —— 没有端点就没有可断言的东西**。
> 不假装完成，也不为了「有进度」而选一条悄悄改掉架构属性的路。
>
> **§6.3 七问之外还缺两问（已补进草案 §7，冻结前必须回答）**：
> (a) QUIC 落在哪个 transport 槽 —— `stream` 与 `datagram` 都装不下它的工作单位
> （一条连接承载 N 条 stream），要么新增第三个 transport，要么把 `stream` 的定义改含糊，
> 而后者会让 `Drain`/在途口径/`SetUpstream` 同时变模糊；
> (b) QUIC 的 **ALPN** 取值（本仓库首次出现 ALPN 概念，`buildTLSStream` 今天只设 `MinVersion`）。
>
> **协议投影零迁移**：`quic` 已在 DB enum、wire 词汇表与 web 类型里；只缺 entitlement
> （`platform_ceiling` 不含 quic），否则协议开了也没人能创建 —— 与 V5.1b 同一教训。
>
> **翻转面比 UDP 大**：开 QUIC 要同批改 G0.5/G0.7 + 5 个 backend 测试 + 3 个 agent 测试
> + web 的「未开放协议」渲染/复制断言。

QUIC 只有 UDP Gate 全绿后开始（**该条件已满足：G1B = 76/0**；现在的阻塞是上面的依赖决策）。

### 强制先冻结

- QUIC 是用户协议还是内部 hop transport；
- termination point；
- TLS identity/certificate ownership；
- connection vs stream accounting；
- datagram 是否启用；
- migration 是否支持；
- 0-RTT 是否支持。

默认：

> 不因为库支持就自动开启 0-RTT、connection migration 或额外 QUIC 扩展。

### Gate V5-G1C

- basic handshake；
- invalid cert；
- reconnect；
- stream lifecycle；
- datagram behavior if enabled；
- drain；
- restart；
- LKG；
- old Agent admission；
- telemetry；
- secret redaction；
- TCP/UDP regression。

---

# 7. V5.2 — Target Intelligence

目标：先建立可靠事实，再让系统自动决策。

固定链：

~~~text
Observation
   ↓
Health Synthesis
   ↓
Decision
~~~

禁止：

~~~text
single timeout
   ↓
automatic failover
~~~

---

> **语义契约已冻结（WP5-C0，2026-10-04）**：与 §6.1/§6.2 同一纪律——每条结论要么指向仓库
> 事实，要么指向已冻结的 V5 不变量；仓库无法唯一回答的写进「开放产品决策」，**不猜**。
>
> **固定链与禁止项**（本节开头）：Observation → Health Synthesis → Decision。
> 禁止 single timeout → automatic failover：**一次超时永远不足以改变任何决策**。
>
> ### 冻结结论
>
> | # | 问题 | 结论与依据 |
> |---|---|---|
> | 1 | 谁观测 | **Agent**，不是 Panel。Panel 不能反连数据面（§13.5 分层 + Panel 不依赖数据面可达性），而 Agent 已经在节点上、已经在周期性上报。RELAY 的目标由**出口节点**观测——它是真正拨号的那一方 |
> | 2 | 观测什么 | **只观测出现在该节点 desired 状态里的 target**（禁止扫描未授权目标）。观测对象是 `host:port`，不是"某个用户的目标" |
> | 3 | 怎么观测 | 有界 TCP 连接（不是完整业务往返）：`timeout` 有界、并发有界、周期有界、带抖动避免全网同步。连接成功即 `reachable`，耗时即 `latency` |
> | 4 | 观测存在哪 | **独立投影**（`target_observation` 表），**绝不写 EgressTarget 的 desired 字段**。desired 表达"用户要什么"，观测表达"我们看到了什么"，两者不可互相改写 |
> | 5 | 观测的粒度 | **按 (观测节点, target) 二维**。同一 host:port 被两个节点观测是**两条不同的事实**（视角不同），不能合并成一条 |
> | 6 | 8 个事实 | `reachable`（上次探测是否连上）、`latency_ms`（连接耗时，不可达为 null）、`consecutive_success`/`consecutive_failure`（自上次状态翻转起的连续计数）、`success_rate`（最近 N=20 次探测的成功比例，由**观测方**计算并上报，Panel 不重算）、`last_observed_at`、`observation_source`（谁说的：node_id + 探测种类）、`observation_age` |
> | 7 | `observation_age` 是否存在库里 | **不存**。age 是 `now - last_observed_at`，在读取时计算——存下来的 age 在写入的那一刻就已经是错的 |
> | 8 | stale 判定 | `age > STALE_AFTER`（= 3× 上报周期）。stale 的观测**必须可识别**，并且在合成里等同于"没有证据"（→ `unknown`），而不是"继续沿用最后一次结果" |
> | 9 | Panel 重启 | 不能把旧观测当新鲜：重启后直到 Agent 重新上报之前，一切观测都按 stale 处理（age 会自然超过阈值）。**不引入"重启后信任缓存"的特例** |
>
> ### 统一状态与跃迁（WP6）
>
> ~~~text
> unknown     没有非 stale 观测（从未观测 / 证据全过期）
> healthy     reachable 且 success_rate >= HEALTHY_RATE 且 consecutive_failure == 0
> degraded    reachable 但成功率或延迟不达标，或 0 < consecutive_failure < FAILURE_THRESHOLD
> unhealthy   consecutive_failure >= FAILURE_THRESHOLD（默认 3）
> recovering  刚从 unhealthy 出来：consecutive_success >= RECOVERY_SUCCESSES（默认 2）
>             且 success_rate 尚未回到 HEALTHY_RATE
> ~~~
>
> - **迟滞（hysteresis）**：进入 `unhealthy` 要连续失败 N 次；离开 `unhealthy` 要连续成功 M 次
>   且成功率回升。**单次失败或单次成功都不改变状态**——这是本节"禁止 single timeout"的落地。
> - **warm-up**：新 target 从 `unknown` 起步；一次成功只到 `recovering`，
>   连续 `WARMUP_SUCCESSES`（默认 2）次成功才到 `healthy`。
> - **flap**：在 `FLAP_WINDOW` 内状态翻转超过 `FLAP_FLIPS` 次 → 合成结果标记 `flapping: true`
>   并压制为不超过 `degraded`。抖动是事实，不能被平均掉。
> - **partial visibility**：多个观测者对同一 target 的结论**取最坏**（可用性上的 fail-closed），
>   同时保留逐观测者明细——"一个节点说通、另一个说断"本身就是运维要看的信号。
> - **阈值集中**：所有阈值放在**一处**导出常量里（`TARGET_HEALTH_THRESHOLDS`），
>   每项注明它保护什么。禁止散落 magic number（§7.2 明确要求）。
> - **synthesis 永不改 desired**（§7.2 与本节禁止项）。
>
> ### 开放产品决策（不猜）
>
> 观测周期与并发上限的具体取值（实现取有界默认并注明）；是否保留观测历史（当前只存最新一条投影）；
> 多观测者时是否允许"多数表决"替代当前的最坏值；`success_rate` 的窗口长度是否随池规模调整；
> 是否需要把退化状态通知到用户（当前只落事实，不产生告警语义）。

## 7.1 V5-WP5 — Target Observation

### 事实

每个 target 至少需要：

~~~text
reachable
latency
consecutive_success
consecutive_failure
success_rate
last_observed_at
observation_source
observation_age
~~~

### 存储原则

observation 是事实，不是 desired。

不要直接修改 EgressTarget desired 字段表达“健康”。

优先建立独立 observation 投影，例如独立表/缓存对象；具体持久化方式由数据保留需求决定。

### 采集规则

- bounded timeout；
- bounded concurrency；
- 不扫描用户未授权 target；
- 诊断 target 必须来自已有 desired；
- stale observation 必须可识别；
- Panel restart 后不能把旧 observation 当新鲜。

---

## 7.2 V5-WP6 — Health Synthesis

统一状态：

~~~text
unknown
healthy
degraded
unhealthy
recovering
~~~

### 必须解决

- warm-up；
- jitter；
- flap；
- stale；
- partial visibility；
- restart；
- recovery hysteresis。

阈值应集中配置/常量化，不允许散落 magic number。

synthesis 仍不能改 desired。

---

## 7.3 V5-WP7 — Circuit Breaker / Advanced LB

只有 WP5/WP6 Gate 稳定后进入。

允许：

- circuit breaker；
- half-open probing；
- weighted health-aware routing；
- least-latency；
- least-load。

禁止：

- 单次失败永久摘除；
- observation 直接 delete target；
- LB 自己改 Forward desired；
- 用 Agent 本地状态覆盖 Panel desired。

### Gate V5-G2

至少：

- healthy → unhealthy → recovering → healthy；
- latency degradation；
- flap；
- stale observation；
- target restore；
- Panel restart；
- Agent restart；
- circuit open/half-open/close；
- LB 重新纳入恢复 target；
- desired target 列表始终不被 telemetry 改写。

---

# 8. V5.3 — Resilience / HA

V5.3 才允许系统自动改变“谁承载 Forward”。

---

## 8.1 V5-WP8 — DNS Dynamic Target

DNS 解析是 target input/observation，不是新的 desired 真相源。

必须定义：

- TTL；
- NXDOMAIN；
- multiple A/AAAA；
- IPv4/IPv6；
- address churn；
- stale fallback；
- existing connection/session；
- DNS failure。

DNS 结果不得直接覆盖用户输入域名。

---

## 8.2 V5-WP9 — Multi-Ingress HA / Fencing

Forward 保持单一业务对象。

内部允许：

~~~text
preferred ingress
standby ingress[]
ownership epoch / lease
active placement
~~~

### 必须先解决 split brain

危险场景：

~~~text
Panel sees A offline
        ↓
B takes over
        ↓
A was only partitioned and still listening
~~~

因此自动接管前必须有 fencing。

推荐契约至少包含：

~~~text
forward_id
placement_owner
epoch
lease_expires_at
revision
~~~

Agent 必须拒绝 stale epoch/ownership 的激活动作。

具体 lease/fencing 实现可结合现有 DB/Redis 机制，但不能依赖“最后写入者获胜”。

---

## 8.3 V5-WP10 — Automatic Failover / Failback

failover 必须是显式 policy。

决策输入至少：

- node reachability；
- observation freshness；
- target health；
- ownership epoch；
- lease；
- port availability；
- cooldown；
- previous failover state；
- operator policy。

heartbeat timeout 单独出现时仍不能直接迁移。

### Gate V5-G3

必须真实测试：

~~~text
hard disconnect
soft timeout
short flap
node restart
Panel restart
split brain
duplicate failover
failure during failover
old node recovery
manual failback
automatic failback
epoch fencing
lease expiry
port conflict
~~~

通过标准不是“能切换”，而是：

- 不双活；
- 不无限抖动；
- 不丢 desired；
- 能解释切换原因；
- 能恢复一致状态。

---

# 9. V5.4 — Multi-hop

用户仍只看到 Forward。

内部：

~~~text
Forward
  ↓
RoutePlan
  ↓
Hop 0 → Hop 1 → Hop 2
~~~

第一版只做线性路径。

---

## 9.1 V5-WP11 — RoutePlan / Link Contract

先冻结：

- hop identity；
- order；
- node placement；
- per-hop protocol/transport；
- per-hop port/link lease；
- revision；
- ownership；
- error attribution；
- telemetry aggregation。

第一版不要先建通用图数据库。

推荐先让 Forward revision snapshot 承载 ordered route facts，再根据真实重复需求决定是否独立持久化 Link。

---

## 9.2 V5-WP12 — 2-hop

先只做：

~~~text
ingress → middle/egress → target
~~~

验证：

- create；
- edit middle node；
- revision；
- partial apply；
- rollback；
- restart；
- reconcile；
- diagnostics；
- lease cleanup。

---

## 9.3 V5-WP13 — 3-hop

2-hop Gate 全绿后扩展到 3-hop。

第一版明确禁止：

- arbitrary graph；
- cycle；
- dynamic path finding；
- automatic shortest path；
- unlimited N-hop。

### Gate V5-G4

至少：

- 2-hop；
- 3-hop；
- middle hop failure；
- middle hop recovery；
- topology edit；
- stale revision；
- partial apply；
- compensation；
- orphan link/port cleanup；
- any Agent restart；
- Panel restart；
- per-hop diagnostics；
- telemetry 能定位失败 hop。

---

# 10. V5.5 — Federation

Federation 是最后阶段，也是独立安全边界。

概念：

~~~text
Panel A
   ↓ trust / grant
Panel B
~~~

在开始编码前必须回答：

~~~text
Forward ownership?
Node/capacity ownership?
Port lease ownership?
Quota authority?
Usage authority?
Billing/audit authority?
Revocation authority?
Partition behavior?
Conflict reconciliation?
~~~

---

## 10.1 V5-WP14 — Federation Identity / Trust

需要：

- Panel identity；
- credential issuance；
- rotation；
- revocation；
- trust scope；
- replay protection；
- audit。

不要自创未审计密码学协议。

优先使用成熟标准/库，且必须单独安全评审。

---

## 10.2 V5-WP15 — Resource Grant / Remote Lease

定义：

~~~text
grant
scope
capacity
expiry
remote lease
quota reservation
revocation
~~~

remote resource 不能被当成本地 Node 直接写入同一 ownership 模型，除非 ownership 语义已明确。

---

## 10.3 V5-WP16 — Usage / Partial Failure / Reconcile

必须处理：

- duplicate delivery；
- reordered messages；
- partition；
- stale grant；
- lease expiry；
- partial commit；
- retry；
- idempotency；
- reconnect reconcile；
- usage attribution。

### Gate V5-G5

至少：

~~~text
normal grant/use/revoke
credential rotate
credential revoke
quota exhaustion
lease expiry
Panel A offline
Panel B offline
network partition
duplicate messages
reordered messages
partial failure
reconnect reconcile
cross-tenant isolation
audit completeness
~~~

G5 关闭前 federation 不得标 production-ready。

---

# 11. V5.x Optional：不进入主线承诺

以下能力只有主线稳定后单独立项：

- WireGuard；
- mimic / camouflage 类数据面；
- Plugin Store；
- 移动端；
- 其它外部协议插件。

任何 V5.x 项目先回答：

1. 是否复用 Forward desired/revision/reconcile；
2. 是否需要新的长期 credential；
3. 是否改变 port/link ownership；
4. 是否引入新的 secret；
5. 是否有独立 Gate；
6. 第三方许可证是否允许当前实现方式。

无法回答时保持 proposal，不进入 Active WP。

---

# 12. 测试与 CI 规范

## 12.1 Backend

CI 等价目标至少包括：

~~~text
bun install / locked dependencies
prisma migrate deploy on empty MySQL
prisma generate
tsc --noEmit
bun test src
authorization/payment HTTP tests
existing DB migration
legacy backfill upgrade
~~~

任何 schema 改动必须让 empty DB 与 existing DB 两条都绿。

## 12.2 Agent

必须：

~~~text
go vet ./...
go test ./...
go build -buildvcs=false ./...
release cross compile
~~~

涉及并发/runtime 的改动应增加 race/并发覆盖；不能只验证 compile。

## 12.3 Web

必须：

~~~text
npm ci
npm run typecheck
forward/node/dashboard unit tests
npm run build
~~~

后端新增用户可见错误码时，前端 action map 必须同步；已有 contract test 会故意阻止两边漂移。

## 12.4 Integration

继续复用当前 workflow：

~~~text
V3 baseline
V4 F1
V4 F2
V4 F3
V4 F4
V4 F5
V5 G0
future V5 G*
~~~

新 Gate 应追加，不删除旧 Gate 来换取更快 CI。

---

# 13. 错误模型

错误必须告诉调用方：

~~~text
what failed
which layer
whether retry helps
what next action is
~~~

继续区分：

~~~text
RBAC
resource_scope
capability/quota
runtime_admission
control_protocol
data_plane
~~~

禁止把以下不同问题全部映射为同一个 500：

- Agent 太旧；
- 协议未开放；
- transport 不支持；
- 节点离线；
- quota；
- port conflict；
- target unhealthy；
- stale revision；
- fencing failure。

---

# 14. 安全与秘密

任何 V5 功能继续遵守：

- secret scan 必须绿；
- 私钥/token/password 不进入 diagnostics；
- Support Bundle 使用 allowlist + shape redaction；
- TLS/QUIC 若引入 key material，先定义 ownership/rotation/redaction；
- federation 单独安全评审；
- capability advertisement 不能成为授权来源；
- 用户输入不能让 Agent 变成任意网络扫描器。

---

# 15. 文档状态更新规则

每个 WP 合并后只更新三处：

1. 本文件状态表；
2. 对应 WP 的“状态/结果/已知边界”；
3. 若形成用户可见稳定能力，再更新 README/release notes。

不要把每次调试日志、每个中间 commit、每次 CI 重跑都堆回 DEVELOPMENT.md。

本文件只保留：

~~~text
current truth
hard invariants
next executable work
Gate evidence
known boundaries
~~~

历史过程交给 git history 与 release record。

---

# 16. Agent 提交模板

每个 PR 描述至少写：

~~~text
Work Package:
Depends-On:
Blocks:

Contract Changes:
Schema Changes:
Compatibility:
Rollback:

Tests:
Integration Gate:

V4 Frozen Baseline Impact:
Known Boundaries:
~~~

如果 Contract Changes 为空但实际改了 Panel/Agent wire shape，PR 不完整。

---

# 17. 当前下一步

~~~text
已完成：V5.0（G0=137/0）→ V5.1a WS/TLS（G1A=73/0）→ V5.1b B1 UDP DIRECT（G1B=76/0）
进行中：V5.2 Target Intelligence —— 契约已冻结（§7），WP5 观测 / WP6 合成在实现
阻塞中：V5.1b B2 UDP RELAY（跨节点跳形态待产品决策，当前语义是"必须被拒绝"）
        V5.1c QUIC（待依赖决策：引入库 / vendor / 契约层关闭 / 推迟，见 §6.3）
待开始：V5.2 WP7 + Gate G2 → V5.3 WP8/WP9/WP10 + G3 → V5.4 WP11/WP12/WP13 + G4
        → V5.5 WP14/WP15/WP16 + G5

下一阶段的可执行顺序：
1. 落地 V5.2 WP5（agent 观测 + 面板投影）与 WP6（纯合成 + 集中阈值）并各自提交
2. 写 WP5/WP6 稳定 Gate；通过后进入 WP7（熔断 + 健康感知 LB）
3. 跑 Gate V5-G2（含"desired 列表永不被遥测改写"）
4. V5.3 先冻结 fencing 契约（split brain 是最高风险项），再动代码
~~~

**禁止跳过 Gate、禁止用 skip 掩盖、禁止为了赶进度删 V4 Integration Gate。**

**禁止在 WP0 未进 main 时另写第二份 protocol contract。**

**禁止为了赶进度删除 V4 Integration Gate。**

---

# 18. 本文件已主动删除的旧内容

为让开发 Agent 能直接执行，本文件不再承载下列已经完成或重复的信息：

- V3 每个 WP 的历史开发步骤；
- V4 WP1–WP11 的逐次实现流水账；
- 已关闭 bug 的长篇根因记录；
- 旧分支/旧 Issue 编排；
- 已完成 migration 的逐字段解释；
- 已完成 UI 小项的逐条 checklist；
- V4 发布窗口重复记录；
- 已由 release notes / release record / git history 保存的历史证据。

需要追溯旧实现时去对应文档和 git history，不要把历史重新复制回本文件。

---

## 最终原则

TuneX V5 的开发顺序只有一句话：

> **先冻结契约，再证明兼容；先建立观测，再自动决策；先解决 ownership/fencing，再扩分布式拓扑。**

每一步都必须继续复用 V4 已经证明可靠的：

~~~text
Forward
desired/revision
ACK
LKG
port lease
reconcile
RBAC/resource scope
diagnostics
CI/Integration/Release
~~~

V5 的成功标准不是“支持的协议字符串更多”，而是：

> **能力边界扩大以后，系统仍然只有一份真相、一个控制链、一个 ownership 模型，并且故障行为可解释、可恢复、可验证。**

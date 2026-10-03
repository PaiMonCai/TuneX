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
| V5-WP4 / G0 | BLOCKED | 等 WP0–WP3 |
| V5.1+ | BLOCKED | G0 全绿前禁止进入 |

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

QUIC 只有 UDP Gate 全绿后开始。

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

当前唯一正确顺序：

~~~text
1. Review + merge feature/v5-wp0-contract
2. Start V5-WP1 Capability Negotiation v2
3. Complete WP1 tests
4. Start V5-WP2 Runtime Abstraction
5. Freeze V5-WP3 performance baseline
6. Build and pass V5-G0
7. Only then enter V5.1 protocol expansion
~~~

**禁止直接开始 UDP / QUIC。**

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

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

日期：2026-10-05。

### 0.1 main 状态

V4.5 已完成技术闭环，V4 功能范围冻结；V5-WP0 已进入 main。当前活动发布候选为 **PR #32 / `feature/v5-1b-udp-relay`**：V5.1–V5.5 主线与 WP17–WP21 的交付正在一次性收口。历史 Gate 证据已覆盖 G0/G1A/G1B/G2/G3/G4/G5/G6/G7；PR 合并前仍以“最终 head 的 Source CI + PR fast Integration 全绿”为放行条件。

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
- WP0 合入时未实现 UDP / TLS / WS / QUIC；**这是 WP0 的历史冻结点，不是当前能力状态**。后续 V5.1 已实现 TLS / WS / UDP（含单跳 UDP RELAY），QUIC 仍关闭。

**接手 Agent 的第一件事不是重做 WP0，而是确认它仍在 main 上生效。**

当前接手点：**PR #32 merge closure / 产品化收口**。Console Split、Route Profile、Federation、DDNS、公告/通知基础、延迟观测、订阅计费与安装器均已进入代码；不要按旧章节标题重复实现已经交付的 WP。当前真实缺口与下一步统一看 §17。

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

V4/V5 的**运行时核心业务对象**仍只有：

~~~text
Node
Forward
~~~

但从 V5.5 前置产品架构开始，前端必须区分“管理员配置资源”与“普通用户消费服务”：

~~~text
资源层（Admin）
Node / NodeGroup
        ↓
产品线路层（Admin 定义，User 选择）
Route Profile
        ↓
用户业务层
Forward
        ↓
执行层
ForwardRevision → RoutePlan → RuntimePlan / Lease / Agent
~~~

**Route Profile 不是第二套 desired/runtime 真相。** 它是可复用、可版本化的线路配置模板，只作为生成
Forward revision / RoutePlan 的输入。真正运行、回滚、reconcile、lease、ACK 与 applied revision 仍全部归
Forward 控制链。

普通 User Console 默认不暴露 raw Node / Agent / lease / revision 等运维概念；这些属于 Admin Console。
Node 仍是系统一等资源，但不要求普通用户直接管理 Node。

Tunnel 保留为内部 desired/runtime 兼容资源，不重新成为第一层用户产品。

不得新增：

- 第二套用户侧 Tunnel 产品；
- 第二套 DIRECT engine；
- 第二套 RELAY engine；
- 第二套 Route Profile runtime/state machine；
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
  src/app/dashboard/
  src/app/forwards/
  src/app/nodes/
  src/app/admin/
  src/components/forwards/
  src/components/nodes/
  src/components/admin/
  src/components/app-shell.tsx
  src/components/sidebar.tsx
  src/lib/forward-status.ts
  src/lib/types.ts

  V5-WP13.5 目标结构（迁移时保持 URL/权限兼容，不做无关重写）：
  src/app/(user)/
  src/app/(admin)/
  src/app/(auth)/
  UserShell / AdminShell 使用共享 design system，但导航、信息架构与权限入口分离

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

### 4.1 V5.6+ 产品化扩展（**已进入交付 / 收口**）

> 这五个 WP 已不再是“只写了契约”的候选项。当前状态以代码、Gate 与各契约的交付记录为准。
> 纪律不变：一次一个 WP、契约先于实现、运行时能力必须回到既有 Forward desired/revision/reconcile 链。
>
> | WP | 主题 | 契约（单一真相） | 当前状态 |
> |---|---|---|---|
> | WP17 | 入口/出口组（Route Profile selector）+ DDNS 联动 | `docs/v5-wp17-entry-exit-group-ddns-contract.md` | **DONE**：17.1–17.5 已交付；Gate **V5-G6 = 72/0** |
> | WP18 | 公告系统 + 通用通知渠道 | `docs/v5-wp18-announcements-notifications-contract.md` | **MOSTLY DONE**：公告、Email/Webhook/Telegram、账本/RBAC 已落地；剩事实类 Forward 拒绝/恢复触发器接入 worker reconcile |
> | WP19 | 延迟观测 / 链路拓扑 / Looking Glass | `docs/v5-wp19-latency-observability-contract.md` | **PARTIALLY DONE**：diag、历史、拓扑、Looking Glass 已落地；延迟历史 Web 图表待补；带宽压测明确不做 |
> | WP20 | 订阅周期与流量周期结算运行时 | `docs/v5-wp20-subscription-billing-runtime-contract.md` | **DONE**：DoD 1–9 关闭；Gate **V5-G7 = 33/0** |
> | WP21 | 一键安装器（独立文档站/下载加速本期不立项） | `docs/v5-wp21-installer-and-docs-site-contract.md` | **DONE（PR 静态/桩化层）**：bootstrap/install + production docs + installer-static（196 项）；干净宿主机真实安装仍是发布环境验证 |
>
> **WP20 子项状态**（契约 §5.1–§5.9；一次一个 WP、每个 WP 一个提交）：
> WP20-1 计费时钟纯函数 ✅ ｜ WP20-2 账本与归属 schema ✅ ｜ WP20-3 周期结算 tick ✅ ｜
> WP20-4 支付 → 发放接线（`grantPolicyFromPurchase`）+ 续期执行器 ✅ ｜ WP20-4b 套餐 ↔ 策略绑定入口 ✅ ｜
> WP20-5 到期降级与可观测 ✅ ｜ WP20-6 流量口径统一 ✅ ｜ WP20-6b `GET /api/me/capabilities` ✅ ｜
> WP20-7 流量倍率 **不立项**（仅当 O3 选 B 才立项）。
> 门禁 **V5-G7**（`scripts/v3-e2e/v5-g7.py`，**自带一次性环境**：临时 MySQL 容器 + `migrate deploy`
> + 真库 DoD 场景，跑完删容器；不依赖也不触碰真拓扑）—— 33 断言全绿，证据
> `docs/evidence/v5-g7-result-20261005.txt`。**DoD 1–9 全部关闭**；DoD 10（真拓扑 e2e）与
> DoD 11（本登记）分别由既有门禁与本次改动覆盖。**G7.7/G7.8 不覆盖**并附理由（建 Forward 的占位
> 顺序需要真面板 + 真 Agent 编排；没有面板时硬编 DB 级近似只会给出'看起来通过'的错觉 ——
> 门禁的价值在于独立重算，不在于覆盖率的数字）。
>
> **本批裁决里被判为「既有缺陷」的三处**（都不是新功能，是"写了但没接线"）：
>
> 1. `diag` 白名单陷阱（WP19-F）：Agent 已上报 UDP/TLS/WS 协议诊断，面板 `ReportedTunnel`
>    没有该字段、全仓零消费点 ⇒ 数据面事实"上报 200、库里 JSON 有、界面永远读不到"；
> 2. `preferred_node_id` 恒为 null（WP17）：自动回切永不可能发生；
> 3. `workspacePolicyAssignment` 全仓只有一个写入点 `policy-service.ts` 的
>    `assignDefaultPolicy`（WP20）：**当前完全没有「支付 → 发放策略」的接线**。
>    → **已修（WP20-4）**：新增 `grantPolicyFromPurchase` 作为第二个（也是唯一新增的）写入点，
>    购买路径在同一事务内接线，并由 DoD 2 的断言**按函数名**钉住这两处（不按会腐烂的行号）。
>
> 另有两处沉睡半成品被点名（属"替换而非并存"，不得再叠一层）：`SystemConfigName` 里
> 已含 `NOTICE*` 三个键并由 `routes/public.ts` 免认证下发，而 `web/src` 零消费者；
> `DNSProvider` / `InNodeGroupDNS` 是遗留死 schema（全仓 `ddns` 命中 0，两表唯一生产
> 引用是 `routes/admin-extended.ts` 的 `deleteMany`）。

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

#### 第五处（WP17.5 的 Gate 在真拓扑里发现）：HTTP 轮询型 Agent 掉线后 `node.status` 永不翻转

- **症状**：把一台走 HTTP 轮询的入口 Agent 停掉，`node.status` **一直**是 `active`（实测 4 分钟不翻转），
  只有 `node_state_report.reported_at` 变陈旧。
- **根因**：`inactive` 的唯一写入者是 **websocket 断开**路径（`socket/offline-detector.ts` 消费
  `dc:<gid>:<nodeId>` 标记，其前缀常量本身就叫 `DISCONNECT_MARKER_PREFIX_LEGACY`）。HTTP 轮询型
  Agent 从不写这个标记（Redis 里实测无任何相关键）⇒ 这条判定对它们**结构性地**不生效。
- **影响面（实测修正过，不是推断）**：**展示层**。`deriveConnection()` 把"在线"定义为
  `status === "active"` **且** `last_seen_at` 落在 `CONNECTION_ONLINE_WINDOW_MS`(90s) 内，所以
  候选节点判定（`requireOnline`）**本来就有新鲜度保护**，不会因此把死节点当活的。真正的问题是
  **库里那一列会在很长时间里说反话**（面板显示"活着"，判定说"离线"）—— 同一件事有两份相反答案。
- **修法**：在同一个 10s 的 `cron_check_node_offline` 里加**与断开标记无关的第二遍**：按上报新鲜度
  批量置 `inactive`，并且
  ① **用与 `deriveConnection` 同一个窗口常量**（两个阈值就是两份真相）；
  ② 把 **`last_seen_at IS NULL` 一并覆盖** —— SQL 三值逻辑下 `last_seen_at < cutoff` 对 NULL
     **不成立**，只写严格比较会留下一类"永远显示 active 却被派生判定成离线的节点"（e2e 库里就有两台
     这样的预置节点，是**只读探针** `SELECT … WHERE status='active' AND last_seen_at < NOW() - INTERVAL 90 SECOND`
     发现的）；③ 计数单独列出（`flipped_stale`），不并进标记触发的 `flipped`：两个信号源混成一个数，
     就看不出"哪一类节点在掉线"了。

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

> **契约已冻结（WP5-B0，2026-10-04；§9 的产品决策于 2026-10-05 冻结）**：完整语义见
> [`docs/v5-1b-datagram-contract-draft.md`](docs/v5-1b-datagram-contract-draft.md)，
> 该文档由 `DEVELOPMENT.md` §6.2 的要求驱动写成；本文只保留结论与实施边界。拆分：
>
> ~~~text
> WP5-B0  datagram 语义契约         DONE（上文链接；§9 八项决策已冻结）
> WP5-B1  UDP DIRECT               **DONE**（Gate V5-G1B GREEN 76/0）
> WP5-B2  UDP RELAY                **DONE**（2026-10-05 真拓扑全绿 77/0，见下）
> WP5-B3  UDP telemetry/accounting 未开工（分片重组与 packets 计费都在这里）
> 计费口径的订阅运行时**见 WP20 契约**（`docs/v5-wp20-subscription-billing-runtime-contract.md`）：
> 周期结算 tick（先占位后执行 + 崩溃接管）、流量窗口口径、额度周期语义（生效周期 = 声明的最长周期）；
> **packets 计费仍属 B3**，不在 WP20 范围内。
> Gate V5-G1B                      **GREEN PASS=77 / FAIL=0**（`scripts/v3-e2e/v5-g1b.py`，证据 `docs/evidence/v5-g1b-result-20261005.txt`，隔离拓扑 + 本分支镜像）；**B1 的 76 条一条未删**，新增的是 B2 把原「udp RELAY 必须被拒」翻转成「单跳 udp RELAY 必须建立，且客户端的数据报真的穿过跳」——翻转是明写的（契约 §12.5 第 5 条），不是静默删除
>
> **B2 真拓扑闭环记录（2026-10-05）**
>
> ~~~text
> V5-G1A  PASS=73 / FAIL=0     stream 基线（tcp/tls/ws）未被 B2 破坏
> V5-G1B  PASS=77 / FAIL=0     首次全绿
> ~~~
>
> 两次真跑各抓到一个**只可能被真实数据报暴露**的缺陷，都记在契约 §12.5（第 8、9 条）：
> ① 出口的取证地址在多宿节点上取的是"另一张网"的地址 ⇒ 出口丢弃每一个跳报文，而控制面全绿；
> ② 该地址必须由入口**发布**、面板在入口 ACK 之后**抬 revision 重发出口腿**来纠正，而这条
> 字段要穿过五个逐字段重建的边界（少一个就静默失效 ⇒ 已有机械守卫）。
> ~~~
>
> **§9 冻结摘要（2026-10-05，逐条依据见契约 §9）**
>
> | # | 决策 |
> |---|---|
> | 跳形态 | 候选 (b)：**datagram 端到端**，出口监听 UDP。裸 TCP + 分帧被拒（那是第二套跨节点传输）；不做 RELAY 的候选 (c) 代价更大。先例：Forwardx FXP 的出口侧就是 UDP 监听 |
> | hop 头 | 固定 **16 字节**（magic / version / mapping_id / generation）：入口只有一个 socket，映射身份必须在带内 |
> | 目的地址 | **永不进带内**，出口只按自己的目标池发送 —— 即使源地址可伪造，出口也不是任意中继 |
> | 来源取证 | 出口**只接受配对入口节点地址**的报文；UDP 没有握手，这条是 datagram 跳必须新增的 |
> | 单报文上限 | **1264 字节载荷**（16 + 1264 = 1280 = IPv6 最小 MTU），超长丢弃并计数；**分片重组留 B3** |
> | 空闲超时 | 沿用 B1 的 30s（可注入），**不新增 per-Forward 列** |
> | 映射上限 | 沿用 B1 的 1024，超限**丢弃新来源的报文**并计数 |
> | TCP/UDP 同号 | **不共享**（沿用既有冻结）；想 `53/tcp` + `53/udp` 的用户会拿到两个不同端口号 —— 写进用户可见边界 |
> | 计费 | v1 **只做观测**，packets 不入账（属 B3） |
> | IPv4/IPv6 | 沿用 B1（v4-mapped 归一 + `listen_host` 语义） |
> | udp+DTLS | 不做，是独立维度（需安全评审） |
> | 套餐开关 | 沿用能力策略的 `tunnel_types`，不新增机制 |
>
> **明确不做（B2 边界）**：跨面板（federation）的 UDP 腿、hop 加密、分片重组、
> TCP/UDP 同号 —— 每一项都有各自的 WP 与 Gate。
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
> **产品决策状态**：原先那八条"不猜清单"已于 2026-10-05 全部冻结（见上文 §9 冻结摘要
> 与契约 §9），本节的"开放产品决策"已无遗留项。
>
> **实施边界（B1，已完成）**：只做 UDP **DIRECT**。`udp` 在 EGRESS/RELAY 上必须被
> **拒绝**并给出明确错误，而不是半实现 —— 这是 B1 当时的边界。
> **实施边界（B2，已解冻）**：按契约 §12 实施 udp RELAY（datagram 端到端跳）；
> 单报文 1264 字节上限、hop 明文、无分片、无跨面板 UDP 腿都是 B2 的**明确边界**，
> 不是"暂时没做"。
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

**关于 UDP 的决策状态（2026-10-05 更新）**：B2（UDP RELAY）**已解冻**——跨节点跳的形态
于 2026-10-05 冻结为"datagram 端到端（egress 监听 UDP）"，见 §6.2 与契约 §9.1/§12。
B1 期间"RELAY 必须被拒绝"是那一步的通过条件，B2 会**同时**改掉面板与 Agent 两侧的
拒绝判据，并保证不删除 Gate V5-G1B 的现有 76 条断言。
实现层为其余项选了**有文档、可注入**的默认值（空闲 30s、映射上限 1024、超限丢新映射、
拨号 3s 上限、读错误退避 20ms；最坏内存约 64 MiB/隧道），B2 **沿用**这些值而不是另立一套。

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
> **决定（2026-10-04，已采纳）**：**保持数据面零第三方依赖，V5.1c 实现推迟**。
> 理由：零依赖是可审计性、离线构建与供应链的核心属性，而 QUIC 是**纯增量**协议 ——
> 不阻塞任何其它阶段，所以它是最不该拿架构属性去换的那一项。契约已经冻结（本文），
> 将来引库时不必重新讨论语义，只需做依赖决策 + 回答 transport 槽与 ALPN 两问。
>
> 因此 **V5.1c = 「契约已冻结 / 实现推迟（架构决策）」**，**Gate V5-G1C 同样是阻塞项
> 而不是待办** —— 没有端点就没有可断言的东西。`quic` 继续留在协议白名单之外，
> 面板对它 fail-closed（与 `wss` 同一条路径），不假装完成。
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
>   且成功率回升。**单次失败或单次成功都不可能造成"判死"或"宣告恢复"**——这是本节
>   "禁止 single timeout"的落地。
>
>   **两处口径必须写清楚，否则实现者只能猜（WP6 实现时两条都真的被问到）**：
>   1. 「单次失败不改变状态」与 `degraded` 行（`0 < cf < N`）字面冲突。取**状态表为准**：
>      单次失败**可以**到 `degraded` —— `degraded` 是**可见但不判死**的状态，
>      而 `unhealthy` 才是"判死"，单次失败永远到不了它。同理单次成功最多回到
>      `recovering`，**永远直接回不到 `healthy`**。
>   2. `recovering` 是 `unhealthy` 的**唯一出口**。状态表字面上允许 `unhealthy → healthy`
>      直通，但 Gate V5-G2 的链路是 `unhealthy → recovering → healthy`；采用后者，
>      **每次合成只走一条跃迁**。代价是恢复后多经历一个上报周期的 `recovering`，
>      收益是"恢复"这件事在观测上永远可见，不会被一次采样抹掉。
> - **相位（全序）**：`unknown < healthy < recovering < degraded < unhealthy`。
>   契约只说"取最坏"，没给全序；这个顺序是 fail-closed 的选择：不美化任何视角，
>   且 `unknown` 比 `healthy` 差（"没有证据"不能等同于"健康"）。
> - **压制方向**：flap 只把 `healthy`/`recovering` 向上压到 `degraded`；
>   **`unhealthy` 绝不会被压下来**（把真实故障放宽成"只是抖动"是最危险的错误方向），
>   `unknown` 也不参与压制。
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
> ### 实现选定的默认值（可注入；不是冻结的产品决策）
>
> 开放项的取值先由实现选定并集中在 `backend/src/services/target-health-thresholds.ts`
> 与 `agent/internal/targetobs/observer.go`，每一项都注明它保护什么、改一个数即可调整：
>
> | 项 | 值 | 保护什么 |
> |---|---|---|
> | `FAILURE_THRESHOLD` | 3 | 进 `unhealthy` 的唯一入口；一次超时永远到不了 |
> | `RECOVERY_SUCCESSES` | 2 | 防"一次好探测就回到服务" |
> | `WARMUP_SUCCESSES` | 2 | 防"从未被验证就当健康" |
> | `SUCCESS_RATE_WINDOW` | 20 | 观测窗口；散点失败接成功率、成串失败接连败计数 |
> | `HEALTHY_RATE` | 0.9 | `healthy` 的成功率下限 |
> | `LATENCY_DEGRADED_MS` | 3000 | 与观测器 `DefaultTimeout=3s` 同源：连得上但不能用 |
> | `STALE_AFTER_MS` | 90000（=3×上报周期） | 超过即"没有证据"，也是"面板重启后旧观测不得当新鲜"的根据 |
> | `REPORT_INTERVAL_MS` | 30000 | 与 Agent 心跳/观测同频，不引入第二条时间真相 |
> | `FLAP_WINDOW_MS` / `FLAP_FLIPS` | 600000 / 4 | 明显长于一次真实恢复周期；只压 healthy/recovering |
> | 观测间隔/超时/并发/抖动 | 30s / 3s / 8 / ±5s | 有界，避免全网同步与探测风暴 |
>
> ### 其余开放产品决策（不猜）
>
> 是否保留观测历史（当前只存每个 (节点,目标) 的最新一条投影）；
> 多观测者时是否允许"多数表决"替代当前的最坏值；
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

### V5-WP7 冻结机制（WP7-C0，2026-10-04）

§7.3 只列了"允许/禁止"，没说机制；机制不冻结，实现者只能各写一套。以下为冻结结论：

**状态模型只有一个**：健康状态来自 WP6 的合成（面板侧），Agent **不得**自己再定义一套
"什么叫健康"。Agent 侧允许存在的是**机制**，不是第二套状态模型。

**熔断器状态机（Agent 侧机制，三态）**

~~~text
closed     正常参与选择
open       被跳过；持续 BREAKER_COOLDOWN 后进入 half_open
half_open  放行**一条**连接：成功 → closed；失败 → 回到 open 且退避翻倍（上限 BREAKER_MAX_COOLDOWN）
~~~

- **进入 `open` 的条件是面板说 `unhealthy`**，不是本地的单次失败 —— "单次超时永不判死"
  在两侧都成立；
- `degraded` / `recovering` / `unknown` **不打开熔断器**，只影响加权；
- **全部目标都 open 时**仍然要选一个（选"最不坏"的那个）并记录这个事实：
  "一个都不选"等于把可用性判死，比"选了最差的"更糟；
- 熔断器只影响**选择顺序**，永不改写 desired 列表，永不删除目标。

**加入身份（join identity）**：面板的 `targetKeyOf` 与数据面的 `forwarder.TargetKey` 是**同一个身份**
（trim / 小写 / 去根点 / 去方括号 + `:port`），两侧必须同步。**任何一个改了而另一个没改，症状是
"面板说健康、Agent 找不到这个目标" —— 健康被静默丢弃，看起来跟"没有健康信号"一模一样**。
所以两条平行数组**只按这个身份连接**，不按 dialer 的原始拼写。

**加权选择（健康感知）**：同一策略内的优先级为
`healthy > recovering > degraded > unknown > unhealthy`，同级内按既有策略（weight / order）
与观测事实（`least-latency` 用观测延迟；`least-load` 用 Agent 自己的在途计数）决定。
`unknown` 排在 `degraded` 之后、`unhealthy` 之前 —— 没有证据不等于好，但也不等于已证实故障。

**线形状（加法）**：出口下发载荷里新增一个与 `targets` **平行**的数组，而不是往
`targets[i]` 里塞字段：

~~~json
"targets":      [ { "host": "...", "port": 443, "weight": 1, "order_by": 10 } ],
"target_health":[ { "host": "...", "port": 443, "state": "healthy",
                    "latency_ms": 12, "age_ms": 4000, "evidence": true } ]
~~~

理由：desired 与 health 是两类事实，塞进同一个元素里，下一次改动就说不清哪个字段属于
哪一类；平行数组让"desired 一个字节没变"这件事在结构上可见。旧 Agent 忽略未知字段，
因此是纯加法。

**WP7 实现期裁决（2026-10-04，Lead 定案）**

| # | 问题 | 裁决 |
|---|---|---|
| 1 | `half_open` 是"放行一条"还是"提升优先级" | **放行额度（allowance）**，不是提升。把一个被面板判 unhealthy 的目标**提前**给一条连接，既违反上面的加权顺序，又等于把流量推向已知坏目标 |
| 2 | 面板后来改口说 healthy 是否直接关闭熔断 | **不**。§7.3 只给了**一条**出口：探测成功。面板改口只提升 rank，仍然要探测 |
| 3 | 没有 `target_health` 的载荷是否保留旧熔断状态 | **清空**。"没有该字段 ⇒ 行为与今天完全一致"必须在任何时刻都成立，而且不留一个比载荷活得更久的状态。代价（一次健康读失败会暂时关掉熔断）可接受，因为失败时也确实没有信号 |
| 4 | `evidence` 是否额外参与判定 | **不**。WP6 契约里 `evidence=false` ⇒ `state=unknown`，它无法再加一条状态没说的规则 |
| 5 | 被强制选择（全部 open）的那次连接结果，能否解开半开 | **能**。拨到目标本身就是证据，无论它是不是探测连接 |
| 6 | 跨边界身份 | **冻结为 `TargetKey`**（见上），并已写进本节 |
| 7 | least-latency / least-load 平手裁决 | §7.3 是"允许"不是"必须"：**本轮不实现**，记为后续项。理由是自动延迟裁决会改变既有策略行为，超出"健康只改选择顺序" |
| 8 | `forced_picks` 目前只有 Agent 自己可见 | 记为**后续项**。"我们正在服务一个面板判为 unhealthy 的目标"对运维是重要事实，应当最终可见于面板（加法字段） |

### Gate V5-G2

**执行结果：PASS=23 / FAIL=0**（证据 `docs/evidence/v5-g2-result-20261004.txt`）

观测对象是**客户端体验**而不是内部状态：e2e 里 Agent 的管理端口是关的，所以门禁用一条真实
RELAY（池里一个会应答的目标 + 一个会拒绝的目标）来测——没有健康感知选择时，负载均衡会把
连接平摊到两者，约一半客户端连接失败。

~~~text
G2.1  面板结论              一个 healthy、一个 unhealthy
G2.2  熔断真的在起作用      经 RELAY 的连接不再落到被判 unhealthy 的目标上（≥90%，轮询基线约 50%）
G2.3  desired 未被改写      池的期望行全程逐字节不变；unhealthy 的目标仍在视图里
G2.4  全 unhealthy 仍服务   全部熔断时连接仍被**接受**（强制选最不坏），而不是直接拒绝
G2.5  LB 重新纳入           目标恢复后流量回到它身上
G2.6  Agent 重启            健康是活状态，服务自动恢复
G2.7  面板重启              desired 不变、数据面照常
~~~

**这一阶段抓到的三个真实缺陷 —— 同一个类别**：**一个新事实有两条投递路径，只给其中一条补上了。**

| # | 缺陷 | 症状 |
|---|---|---|
| 1 | 面板只在**命令下发**带健康，**重连快照**不带 | Agent 一重启就从快照重建 → 熔断静默失效 |
| 2 | Agent 的 **restore** 用 `SetPool`（只有 targets）而不是 `SetPoolAndHealth` | 同上，重启即失效 |
| 3 | Agent 的**快照解码器**不认识 `target_health` | 同上；而"有时候连接失败"看起来像网络抖动，不像配置缺失 |

前两次同源缺陷在 V5.0（协议）与 V5.1a（证书路径）各出现一次，这是第三次。因此这条纪律现在
写成硬规则：**新事实必须同时出现在"命令"与"快照"两条投递路径上，并且解码器要认识它**。

**其余 Gate V5-G2 的原始清单覆盖情况**：`healthy → unhealthy → recovering → healthy`（G2A.3/G2A.4/G2A.5 + G2.1/G2.5）、
`latency degradation`（合成侧由 WP6 单测覆盖，端到端不构造延迟退化）、`flap`（WP6 单测）、
`stale observation`（G2A.6）、`target restore`（G2.5）、`Panel restart`（G2.7）、`Agent restart`（G2.6）、
`circuit open/half-open/close`（WP7 单测 18 例 + G2.2 端到端）、`LB 重新纳入恢复 target`（G2.5）、
`desired 列表始终不被 telemetry 改写`（G2.3，端到端逐字节断言）。

### Gate V5-G2（原始清单）

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

### V5.3 冻结契约（WP8/9/10 的共同前提，2026-10-04）

§8 只说"必须定义"，没给规则。以下为冻结结论；**V5.3 的任何代码都以它为准**。

#### 一、归属与租约（WP9 的核心，也是 split brain 的唯一防线）

~~~text
placement lease（每个 Forward 一行）
  forward_id          哪个 Forward
  owner_node_id       当前承载者
  epoch               单调递增的所有权世代
  lease_expires_at    租约到期时刻（DB 时钟）
  revision            该租约对应的配置 revision
~~~

- **Agent 必须拒绝 stale epoch**：它记住自己见过的最高 epoch（本地持久化），
  任何 `epoch < 已见最高` 的激活动作一律拒绝并上报原因。这条是**防 split brain 的
  最后一层**——即使面板判错、网络分区导致双主，被降级的那台也不会继续服务；
- **不许最后写入者获胜**：租约变更必须走"epoch + 1"的显式迁移，不能靠覆盖字段；
- **租约到期即停**：owner 必须在 `lease_expires_at` 之前续约，续不上就**停止服务**
  （fail-safe）。"可能还有另一个主"比"短暂中断"更危险；
- **两阶段交接**：新 owner 只能在旧租约**已过期或被显式吊销**之后激活。
  "先给新的、再收旧的"必然产生双主窗口。

#### 二、故障转移必须是显式 policy（WP10）

自动迁移**必须同时**满足下列全部条件（缺一不可）：

~~~text
1. 节点不可达**且**超过 stale 阈值（heartbeat 超时单独出现**不足以**迁移）
2. 观测新鲜度可用（不能拿陈旧观测当依据）
3. 健康问题不是"目标本身坏了"（目标坏 → 换入口节点毫无帮助，只会掩盖故障）
4. 备用节点有可用端口（端口租约可用）
5. 冷却期已过（同一 Forward 的迁移冷却）
6. 运维策略允许自动迁移
~~~

**回切（failback）**：首选节点连续 `FAILBACK_HEALTHY_CHECKS` 次判定健康、且冷却期已过，
才允许回切；回切是一次**正常的归属迁移**（epoch + 1），不是特例路径。

#### 三、DNS 是输入/观测，不是第二个 desired 真相源（WP8）

- **解析在 Agent 侧**（拨号的是它），面板**不解析**、不缓存解析结果；
- 用户输入域名**永远是** desired 里存的那份，DNS 结果**绝不覆盖**它；
- TTL 尊重但有下上限（防腐烂 TTL 与抖动）；解析失败 → 用**上一次成功解析的地址集**
  作为 stale fallback，并标记其年龄（不是静默使用，也不是立刻判死）；
- `NXDOMAIN` = 这个目标当前**不可达**（一条证据），**不是**删除目标的理由；
- 多个 A/AAAA、IPv4/IPv6：全部可用，具体拨号顺序交给 Go 的 dialer（不自己实现 happy eyeballs）；
- 地址漂移：下一次解析自然拿到新地址；**已有连接不受影响**（DNS 变化永不强杀连接）。

#### 三·补：WP10 实现期裁决（2026-10-04，Lead 定案）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 回切的条件集 §8 没穷举 | **要求 2/3/4/5/6 + N 次健康，不要求条件 1**。条件 1 问的是"owner 是否失联"，而回切的前提恰恰是它已经恢复 —— 要求它自相矛盾 |
| 2 | `FAILBACK_HEALTHY_CHECKS` 取值 | **3**。比 WP6 的 `RECOVERY_SUCCESSES`(2) 多一拍：回切的触发证据比"目标恢复"更弱（它要推翻一次归属决策） |
| 3 | "连续健康判定"由谁按什么节奏累计 | **由调用方传入**（`failback.healthy_checks`），模块不发明节奏 —— 第二条时间真相是本项目反复禁止的 |
| 4 | 冷却边界（`>=` vs `>`） | 冷却用 `elapsed >= COOLDOWN`（到点即放行），§7 的 stale 用严格 `>`（"还成立吗"）。两者**刻意不同**：一个问"我可以动了吗"，一个问"这个证据还算数吗" |
| 5 | 条件 3 的归因：全部坏消息都来自正在失联的 owner 时 | **仍然拦住**（fail-closed），并额外给出解释性理由 `target_side_evidence_owner_only`。理由：RELAY 下 owner 往往就是唯一观测者，放宽等于"owner 失联 + 它的最后观测说目标坏了 → 照样迁移"，而那会把**目标故障**伪装成**节点故障**，迁移只是把流量送到另一个同样连不上目标的节点（§7.3 明确禁止）。运维可以**手动**迁移 —— 手动路径本来就不在此模块内 |
| 6 | 结构前提（目的地存在/在线、epoch 可读） | 与六条件分开成 `preconditions` ✅ 对：它们不是"策略判断"，是"能不能谈" |
| 7 | 两阶段交接不在此模块 | ✅ 对：模块看不见租约，只输出 `(expected_epoch, next_epoch)` 供调用方 CAS；租约侧由 `claimLease` 强制，两者在调用方汇合 |

#### 三·补二：WP8/WP9 落地位置与遗留

**已实现（提交可见）**

~~~text
agent/internal/ownership/     fence（持久化高水位，agent-id 键、原子写）+ guard（激活闸门）+ deadline（租约时钟）
agent/internal/targetdns/     TTL 缓存解析器（单飞、上下限、失败回退上一份好地址并带年龄）
agent/internal/manager/       闸门装在 manager 上：Apply / ReplaceListener / 快照 / 启动恢复 / 本地管理面**同一实现**
agent/internal/reporter/      状态上报响应里的续约回程（逐条容错解码；空数组只表示"没有新信息"）
backend/placement-lease.ts    租约表与服务；backend 侧认领在**与 epoch 附着同一处**（调用方不可能忘记）
~~~

**WP10 执行器（已提交，与 G3 同一提交）**

`backend/src/services/failover-executor.ts`：`now → 读事实 → decideFailover → CAS → 认领目的节点 → patchForward 迁移`。
**没有第二套下发**：迁移走的就是用户在界面上改入口节点的那条路（`node_migration` 计划），
用例用**真实纯规划器**证明（desired=新入口/applied=旧入口 ⇒ acquire_port + cutover_ingress(新) +
drain_ingress(旧) + release_old_lease(旧)）。

**它的端到端用例抓到一个会静默失效的真 bug**：读路径最初只带出 `reachable`、丢掉 `last_seen_at`，
于是策略**永远无法**证明"不可达且超过 stale 阈值" ⇒ 自动迁移一次都不会发生，而所有单测全绿。
这正是本项目反复出现的那一类（"实现了但不接线/读不到"）。

**round 5 发现的三个真实缺陷（未修，下一轮必修 —— 它们让"自动故障转移"在真实场景下不可用）**

| # | 缺陷 | 证据 | 为什么严重 |
|---|---|---|---|
| F1 | **Agent 的出口池可能变空，而面板发布的是正确的目标；reconcile 不修复这种漂移** | 面板 `buildDesiredNodeSnapshot(4)` 明确给出两个目标，而 agent 上报 `egress_pools: {}`；重启该 agent 立刻恢复 | 转发静默失效（连上但无数据），而"隧道还在列表里"让 reconcile 认为一切正常 |
| F2 | **租约失效是粘住的**：隧道被栅栏停掉后，agent 不再上报它 ⇒ 上报驱动的续约永远续不到 ⇒ reconcile 又不重发（`resent: 0`）⇒ 服务一直停 | 实测：`lease_expires_at` 落后 83s、转发超时；worker 日志 `findings: 4~6, resent: 0` | 这正是实现者提醒过的场景。**我此前"读代码确认不粘"是错的**：代码路径确实存在（重发会认领并续约），但**重发从未发生**。"路径存在" ≠ "路径被走到" —— 与死代码接线是同一类错误，而我当时没有端到端验证就下了结论 |
| F3 | **`resent: 0` 而 `findings > 0`** | worker 日志每拍都是 `findings: 4~6, resent: 0, failed: 0~1` | reconcile 看见了问题却不重发，需要查清是 finding 种类不触发重发，还是 sink 拒绝。这是 F1/F2 的共同上游 |

**F2 已修并端到端验证（2026-10-04）**

修法：**续约的依据从"它上报了那条隧道"改成"这个节点还活着"**（一次上报证明节点活着；面板已经知道它持有
哪些租约）。同时续约改为 fail-soft：租约存储抖动绝不能把上报打成 500 —— 上报承载遥测/健康/隧道列表，
是主要功能，续约是面板自己的记账。

**验证（精确到边界，不要读成"F2 全修好了"）**：把 tunnel 2 的租约手工推到 5 分钟前 →
**75 秒后它被节点自己的上报续到 +82 秒**（修之前这个值会在负数上停留数分钟）。

**但服务并没有因此恢复**：续约只能延长"授权"，不能把已经被栅栏停掉的隧道**重新启动** —— 那需要一次新的
下发，而面板没有发（F3）。所以准确的结论是：
**F2 的"租约自锁"已修 ✅；"隧道停机后无人重启"这一半仍在 F3**。两者必须一起修，否则"停不下来"会变成
"停了起不来"。

**F1/F3 与"熔断看起来没生效"是同一个根因（round 6 的定性结论，下一轮修）**

实测链条：
- 面板视角完全正确：`target-a:3030 = healthy`、`target-a:9 = unhealthy`（cf=43）、观测新鲜（26s）；
- 但转发仍间歇失败（8 次连接里 3 次返回空）；
- **重启出口 agent 后立刻 8/8 成功** —— 因为新配置带着健康事实，熔断器随即生效。

结论：**不是熔断器坏了，而是"已应用的配置"会与 desired 漂移，而 reconcile 不修这种漂移。**
现在的漂移判定只回答"那条隧道在不在、revision 对不对"，不回答**内容对不对**（目标池内容、健康数组、
归属 epoch）。于是：
- F1（池变空）→ 隧道"在"，所以健康；
- 健康数组过期 → 隧道"在且 revision 对"，所以不重发；
- F3（`resent: 0`）→ 正是这个判定的直接后果，而不是另一个独立缺陷。

**修法（下一轮）**：把 reconcile 的漂移判定从"存在性"扩展到"**内容**"——比较 agent 上报的目标池/健康/epoch
与 desired 之间是否一致，不一致就按同 revision 重发。这样 F1、F3 与"熔断看起来没生效"一次解决，
且不需要任何新的下发机制。

**round 8：F1 已修完并**端到端双向验证** ✅，F2 续约自锁已修 ✅

| 缺陷 | 状态 | 证据 |
|---|---|---|
| **F1** 内容漂移（池/健康过期而 reconcile 不修） | **已修 ✅** | 给池加第三个目标 → **agent 的池在 1~2 个 reconcile 周期内变成 3 个**；删掉后 → **退回 2 个**（双向都验证） |
| **F2** 租约自锁 | **已修 ✅** | 手工把租约推到 5 分钟前 → 75s 内被节点自己的上报续到 +82s |
| **F3** `resent: 0` | **已定性并修掉根因 ✅** | 直接调用 sink 复现出真实原因：**出口腿也去认领归属**，而归属持有者是入口节点 ⇒ 两阶段规则正确地拒绝 ⇒ 整条重发路径永久失败。规则没错，是问错了对象 |

**F3 的教训**：这不是"机制坏了"，是**建模错了**。placement lease 每条 Forward 只有一个持有者；RELAY 下
持有者是**客户端连的那台入口节点**（它的 listener 就是服务本身，被降级时必须停的也是它），而出口节点
是一份**资源**。现在认领只发生在 DIRECT 与 RELAY 的**入口腿**，EGRESS 配置完全不带归属事实 —— 这也与
Agent 侧一致：栅栏管的是"谁在服务客户端"。

**顺带解释**了"熔断看着没生效"：出口重发被永久阻塞 ⇒ agent 的池与健康数组**永远无法被刷新** ⇒ 一个
apply 时正确的配置会一直陈旧下去。

**round 7 进展（历史记录）：内容漂移判定已实现，并已追到最后一跳**

已提交：漂移判定从"存在性 + revision"扩展到**内容**（池目标集合、健康数组），并补上了**输入接线**
（`egress_pools` 之前根本没从上报里取出来，所以新规则永不触发 —— 与"实现了但没接线"第四次同类）。
新判定在同 revision 重发（内容不属于 revision）。

**端到端构造验证**（给池加第三个目标 → desired 内容变化）：
- `findings` 从 4 涨到 6 ✅ **漂移被检测到了**；
- `resent: 0` 但 `failed: 1` ✅ **重发确实被尝试了一次并失败**；
- agent 的池仍是 2 个目标 ✅ 说明那一跳失败了。

⇒ 现在的问题精确到了**一跳**：sink 的 `resendSameRevision` → `orchestrator.dispatchEgress` 抛错。
worker 的汇总日志只打 `failed: 1`，**不打 finding 的 detail**，所以下一步要先让这一跳的失败原因可见
（例如 worker 打印 `resend_skipped` 的 detail，或直接在容器里调用 sink 复现）。这是下一轮的**第一个动作**。

**仍未修**：
- **F1**：reconcile 的漂移判定要包含**池内容**（现在只比隧道列表，"runtime 存在"就认为健康）；
- **F3**：`resent: 0` 而 `findings > 0` 的根因未查清。已排除一个假设：`pickAgentTunnel` 在 relay 任一侧
  缺失时返回 null（所以"半边缺失无漂移"不成立）；直接调用 `executeReconcile` 的诊断在容器内挂住，
  需要换一种方式（例如给 worker 打开 finding 级日志）继续查。

**V5.3 剩余（下一次要做的三件事，已定方向，不再给实现者猜）**

| # | 缺口 | 决定 |
|---|---|---|
| 1 | **自动迁移循环**（谁周期性调用执行器） | 挂在 reconcile 既有节拍上（不新开时间心跳）；与 `resumeRollouts` 同一处，先恢复未完成的 rollout，再评估迁移 |
| 2 | **三个决策输入没有存储归属** | ① 运维策略（auto_failover/auto_failback）→ 复用既有 settings 存储（不新增表）；② preferred/standby 目的节点 → **由调度器在同一入口节点组内挑选非现任节点**（这是调度关注点，不需要存储）；③ 回切健康计数 → 由观测事实推导（连续 N 次判健康），默认 fail-closed（0 ⇒ 自动回切不发生，直到接线） |
| 3 | **迁移这条腿不能离线端到端测** | 在 `forward-service` 增加依赖注入的 `applyPlacementChange(tunnelId, workspaceId, nodeId, deps)`（与 `RolloutDeps` 同风格），让"迁移"整链可离线断言；`patchForward` 本身保持不动，避免改动用户路径 |

**两条来自实现者的面板侧缺陷（都已修）**

1. **TTL 与上报周期相等**（30s == 30s）：截止时刻恰好落在下一次上报**发出**的瞬间，而续约
   要等往返回来。于是每个周期都有一个窗口，那一刻租约**确实**已过期 —— Agent 的扫描忠实地
   看到并停掉隧道（每隧道每周期 1~10%）。已改为 **90s = 3 × 周期**，并且测试断言的是规则
   （`>= 3 × 上报周期`）而不是数字。
2. **假过期是否会粘住**：不会 —— reconcile 的重发走 `dispatchDirect`/`dispatchIngress`，
   两者现在先认领，而**现任认领会无条件续约**（包括已过期的租约），因此重发的配置带的是
   新截止时刻，而不是 Agent 会正确拒绝的旧截止时刻。这一条是**读代码验证**的，不是假设。

**已知边界（如实记录）**

- 租约过期即停意味着：面板失联超过一个 TTL 后，从 LKG 缓存恢复的节点在面板回来之前**不服务**。
  这是 §8 冻结的 fail-safe 方向（"可能还有另一个主人"比"短暂中断"更危险），但它**确实**改变了
  可用性权衡，需要让运维知道（§13.3 的缓存便利被有意压过）；
- DIRECT/RELAY 的 `remote_host` 仍由 Go dialer 每次拨号解析（本阶段范围是出口目标）；同一套
  缓存的注入点已经留好（`SingleHopForwarder` 的 dial）；
- stdlib 读不到 DNS 记录 TTL，所以使用"策略 TTL + 上下限"并在常量处注明这是**偏差**。

#### 四、V5.3 的 Gate（G3）要证明的

`hard disconnect` / `soft timeout` / `short flap` / `node restart` / `Panel restart` /
**`split brain`（旧节点仍然在监听）** / `duplicate failover` / `failover 期间再次失败` /
`old node recovery` —— 其中 **split brain 必须真的构造出来**：让旧节点在分区中继续服务，
然后验证它在下一次收到更高 epoch 时拒绝继续，而新节点在旧租约过期前**不会被**激活。

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

**执行结果：PASS=37 / FAIL=0**（证据 `docs/evidence/v5-g3-result-20261004.txt`）

**split brain 是"构造出来"的，不是绕着它断言**：门禁故意把租约推成过期（这正是分区在面板看来
的样子 —— 什么都没续约），然后**不通知旧节点**，验证它自己停下来：

~~~text
G3.1  基线                    一个 RELAY 真的在服务，且存在归属租约
G3.2  两阶段拒绝早接管        租约还活着时，接管被拒（not_expired），owner/epoch 一个字节没变
G3.3  **split brain 不可能发生** 让租约自然失效 → 旧主人**自己停止服务**（不靠面板指令）
G3.4  失效后可以接管          新主人认领成功，epoch 恰好 +1
G3.5  epoch 单调              每次成功认领只 +1，永不回退
G3.6  竞态安全                同一世代的两个认领不可能都赢；世代只按成功次数前进
G3.7  恢复                    归属还回去后，转发重新服务（走既有 reconcile 路径）
G3.8  desired 未被改写        迁移改的是"谁承载"，不是"指向什么"（配置与目标逐字节不变）
G3.9  面板重启                归属既不会被复活也不会被遗忘，数据面照常
G3.10 heartbeat 单独不足以迁移 策略对"心跳陈旧但观测不可用"给出 hold，真实租约一动不动
~~~

**这一阶段的三处关键设计（都已提交）**

1. **归属迁移必须是 CAS**：读后写会让两个候选节点各自把 epoch 从 N 写成 N+1 —— 两行都自称
   同一世代。现在把"读到的那个世代"作为写入前提，输的一方拿到 `lost_race`（与 `not_expired`
   区分：一个是"再等等"，一个是"重新读、重新决定"）；
2. **认领与 epoch 附着在同一处**（`claimOwnership` 在两个下发路径的入口）：调用方不可能忘记
   认领，而忘记认领 = Agent 的栅栏永远不生效（"实现了但没接线"本项目已出现两次）；
3. **迁移顺序不可交换**：CAS → 给目的节点认领 → 走**既有** `patchForward`（用户在界面上改入口
   节点走的就是这条路，planRollout 出 `node_migration`）。反过来在物理上不可行：下发路径的
   `claimOwnership` 会在旧租约还活着时拒绝下发；若能推下去，就是新主人与旧主人同时服务。
   代价是认领与激活之间的**短暂中断** —— §8 明确选择的取舍。

**残留风险（明确记录，不隐藏）**：认领之后若迁移被拒（409/VALIDATE）或下发失败，旧节点已被栅栏
挡住、新节点还没服务 ⇒ 服务中断，直到 worker 续跑该 rollout。**不做补偿**，因为 epoch 永不回退
（回退等于把双主窗口重新打开）。

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

### V5.4 冻结契约（WP11-C0，2026-10-04）

§9.1 列了九个"必须先冻结"的项但没给结论。以下为结论；**V5.4 的任何代码以它为准**。

| # | 项 | 冻结结论 |
|---|---|---|
| 1 | **hop identity** | `(forward_id, hop_index)`，`hop_index` 从 0 起、0 = 面向客户端的那一跳、N-1 = 拨号到目标的那一跳。**身份是位置，不是节点** —— 同一位置换节点是拓扑编辑，不是新 hop |
| 2 | **order** | 严格线性、`hop_index` 递增。**禁止**分支、环、任意图、动态寻路、自动最短路、无限 N 跳（§9.3 已禁止，这里再次明确）。第一版上限 **3 跳** |
| 3 | **node placement** | 相邻两跳之间必须存在 **NodeBinding**（复用 V4 的绑定，不新增"链路许可"概念）。hop 0 = 入口、hop N-1 = 出口；中间跳必须与服务它的那一跳有绑定 |
| 4 | **per-hop protocol/transport** | **跳间一律 stream / 裸 TCP**（与 §6.1/§6.2 对 tls/ws/udp 的"跨节点跳保持裸 TCP"完全一致，不新增第三种跳间传输）。Forward 的 protocol 只作用于 **hop 0**（面向客户端），目标侧协议只作用于 **hop N-1** |
| 5 | **per-hop port/link lease** | 每一跳的入向 listener 各自持有**自己的端口租约**（既有 NodePortLease，键仍是 (node, port)）。因此一条 N 跳 Forward 持有 N 份租约；释放与孤儿清理是 rollout 的一部分，**G4 要验证"孤儿链路/端口被清掉"** |
| 6 | **revision** | **整条路由只有一个 revision**（有序路由事实承载在 Forward revision snapshot 里，不建通用图库 —— §9.1 的推荐）。**禁止 per-hop revision**：那允许"部分链路的版本互不匹配"的活配置，而路由必须是一个整体 |
| 7 | **ownership** | **只有一个归属持有者：hop 0**（沿用 WP9 的 placement lease）。中间跳与出口跳是**资源**，不是 owner —— 这正是 round 8 修 F3 时得到的教训（把出口当 owner 会让两阶段规则正确地拒绝每一次下发） |
| 8 | **error attribution** | 每一次下发/ACK 失败都必须带 **`hop_index` + 节点 id**。没有它的错误在 3 跳下无法定位（G4 明确要求"遥测能定位失败跳"） |
| 9 | **telemetry aggregation** | 逐跳事实**分开保留**，聚合结论取**最坏的那一跳**（与 §7 的 partial visibility 同一规则）；聚合**不得**抹掉"哪一跳坏了" |
| 10 | **partial apply** | 部分跳已应用、其余未应用 ⇒ 整条路由**不得**报告为 active，并必须点名失败的那一跳；补偿按**逆序**拆除已应用的跳（先出口后入口的铁律在 N 跳上的推广：**正向先远后近，拆除先近后远**） |

**无第二套实现**：跳与跳之间的一段就是一次既有的 ingress↔egress 下发，因此 N 跳路由是**既有下发原语的组合**，
不是一套新的命令通道。若实现时发现必须新写一条下发链路，那是设计信号，先报告再动手。

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

**执行结果：PASS=25 / FAIL=0**（2026-10-05，PR #30 四 Agent Integration）。

本次 merge-closure 同一 HEAD 还验证了：

~~~text
V4 REST     PASS=67  FAIL=0
V4 S10      PASS=58  FAIL=0
V4 F1       PASS=32  FAIL=0
V4 F2       PASS=37  FAIL=0
V4 F3       PASS=21  FAIL=0
V4 F4       PASS=58  FAIL=0
V4 F5       PASS=133 FAIL=0
V5 G0       PASS=137 FAIL=0
V5 G4       PASS=25  FAIL=0
~~~

G4 关闭时额外确认的 durability 事实：

- `middle_node_id` 进入 immutable Forward revision snapshot，拓扑编辑不会丢失旧/新 middle 事实；
- 3-hop → 1-hop 会重新切 ingress、撤旧 transit runtime、释放旧 middle 端口租约；
- middle Agent / ingress Agent 重启都从 desired snapshot 恢复**同一条三跳路径**，不会静默退化成单跳；
- compensation 与 reconcile 都认识 middle，三跳重放顺序为 egress → middle → ingress；
- V5.3 ownership fencing 与 V4 ingress migration 已统一为显式 handoff：先撤旧入口并释放旧 owner，再激活新入口；
- 长时间离线 / reinstall 时，现任 owner 在 startup desired snapshot 前续约自己的 lease，恢复不会因过期 deadline 自锁；
- UDP DIRECT 已是正式能力（G1B=76/0），因此 G0 manifest 正确包含 `udp` + `datagram`；UDP RELAY 仍按产品边界 fail-closed。

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

## 9.4 V5-WP13.5 — Console Split / Route Profile Contract Freeze

这是 **V5.5 Federation 的前置产品架构工作**。它不改 V5.4 的 G4 结论，也不允许为了 UI 重写
Forward / revision / rollout / lease / reconcile。

### 9.4.1 Console 边界

Web 产品表面正式拆成两个控制台，共享组件库与视觉 token，但不再把全部功能长期堆进
`AppShell(adminMode)`：

~~~text
User Console
  Overview
  Forwards
  Routes / 可用线路
  Billing
  Support
  Settings

Admin Console
  Overview
  Infrastructure
    Nodes
    Node Groups
    Capacity / Health
  Network
    Forwards
    Route Profiles
    Targets / Diagnostics
  Users / Workspaces / Permissions
  Commerce
    Plans / Orders / Payments / Usage
  Operations
    Audit / Alerts / Support
  Federation
    Peers / Trust / Grants / Remote Leases / Usage
  System
    Settings / Security / Version
~~~

推荐 Next App Router 边界：

~~~text
src/app/(user)/
src/app/(admin)/
src/app/(auth)/
~~~

要求：

- UserShell / AdminShell 的 sidebar、topbar、dashboard 信息密度分别设计；
- shared UI / form / table / chart 可以复用，不复制 design system；
- 前端 route guard 只负责 UX，**backend RBAC / workspace scope 仍是安全真相**；
- Federation 只进入 Admin Console，不向普通用户暴露 trust / grant / remote lease；
- 普通用户默认只看到“线路是否可用、延迟、流量、套餐与可行动错误”，不展示 lease epoch 等内部字段。

### 9.4.2 Route Profile 定位

Route Profile 是**可复用、可版本化的产品线路模板**：

~~~text
Node / NodeGroup
        ↓
Route Profile
        ↓
Forward
        ↓
ForwardRevision
        ↓
RoutePlan
        ↓
RuntimePlan
~~~

它解决“管理员编排线路，用户消费线路”，但**不拥有 runtime 生命周期**。

Route Profile 第一版字段语义至少包括：

~~~text
id / name / description
visibility
enabled
version

ingress selector
ordered transit[]
egress selector

ingress policy
egress policy
health / placement constraints
required capabilities
~~~

Route Profile **不得拥有**：

~~~text
Agent runtime
NodePortLease / placement lease
Forward lifecycle
applied revision
traffic counter
独立 reconcile
独立 restart/stop state machine
~~~

### 9.4.3 Route Profile 与 RoutePlan 的区别

~~~text
Route Profile = 可复用的意图/模板
RoutePlan     = 某个 Forward revision 已解析出的具体执行路径
~~~

例如：

~~~text
Route Profile:
  香港入口组
      ↓
  SG-01
      ↓
  日本出口组 (least_conn)

某次 RoutePlan:
  HK-02
      ↓
  SG-01
      ↓
  JP-03
~~~

运行时必须使用**确定的具体节点事实**，不能让 Agent 自己从 NodeGroup 随机挑选。

### 9.4.4 第一阶段支持边界

按复杂度递增实现，不一次开放任意动态图：

1. 已有基线：fixed ingress + ordered fixed transit[] + fixed egress；
2. 下一步：Ingress NodeGroup + failover/fencing；
3. 再下一步：Egress NodeGroup + `fallback / round_robin / random / least_conn / ip_hash`；
4. dynamic middle pool / arbitrary graph / shortest-path routing 继续关闭。

Transit 第一版保持 ordered fixed nodes；不要让每个 middle 同时成为动态 NodeGroup，避免候选路径组合爆炸。

### 9.4.5 版本与变更传播

共享 Route Profile 的编辑**不得静默重写正在运行的 Forward**。

必须遵守：

~~~text
RouteProfile vN
      ↓ 修改
RouteProfile vN+1
      ↓
Impact Analysis
      ↓
显式 rollout / apply
      ↓
new ForwardRevision
      ↓
RoutePlan snapshot
~~~

因此实现 Route Profile persistence 时，Forward revision snapshot 必须能够解释“本次计划来自哪个
Route Profile / version”，但 applied runtime 不能依赖随后可变的模板内容。

### 9.4.6 Visibility / entitlement

Route Profile 至少预留三类产品可见性：

~~~text
INTERNAL   仅管理员内部使用
ASSIGNED   仅指定 Workspace / Plan 可选择
PUBLIC     所有满足条件的用户可选择
~~~

套餐/Workspace 的用户侧授权优先指向 **Route Profile / capability entitlement**，不要重新发展成
“普通用户直接拿 Node 权限”的主产品模型。

### 9.4.7 Web 交互性能与状态表达

Console 重构必须保留“先可操作、后补重数据”的交互原则：

- 页面 shell / 基础列表先响应，流量、实时状态、趋势图延后并行加载；
- 大列表使用服务端分页/筛选，不下载全量数据再浏览器分页；
- 创建/编辑尽量就地完成，避免无必要的页面跳转；
- Route Profile 编辑器使用入口/中转/出口明确角色、拖拽有序 transit、即时 capability/permission 校验；
- 用户状态表达至少区分 desired / applying / running / available / degraded / failed，不把所有异常压成一个 ERROR；
- Admin 可以展开 revision / lease / Agent ACK / diagnostics，User 只展示可行动的产品状态。

### 9.4.8 实施顺序

WP13.5 拆成两个独立改动面，禁止混成一次大重构：

~~~text
WP13.5A Console Boundary
  route groups / UserShell / AdminShell / navigation / guard tests
  不改变 backend business capability

WP13.5B Route Profile Foundation
  contract / schema / version / visibility / entitlement
  compiler 输入接现有 RoutePlan
  不建立第二套 runtime state machine
~~~

完成 WP13.5 后再进入 WP14 Federation；Federation 页面从第一天就只落在 Admin Console。

---

# 10. V5.5 — Federation

Federation 是最后阶段，也是独立安全边界。

**进入条件：§9.4 Console / Route Profile 产品边界已冻结。** Federation 的产品表面只属于 Admin Console；
跨 Panel 资源不得因为 UI 方便而复制成本地 Node / Route Profile runtime。

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

### 10.0 契约冻结与当前状态（2026-10-05）

九个所有权问题的正式答案、错误码闭集、分区行为矩阵与第一阶段不开放项，已冻结在
**`docs/v5-wp14-16-federation-contract.md`**（本文件不再重复那 200 行）。一句话版本：

> 发起方（home panel）拥有 Forward 的期望状态与 rollout 账本；承载方（host panel）拥有自己的
> Node / 端口租约 / Agent 控制链；跨面板资源**只作不透明引用**，绝不复制成本地 node / lease 行。
> 容量、配额与用量以 host 为准；撤销以 host 的 grant 为权威且不可逆；分区一律 fail-closed，
> **禁止**静默回落到本地节点。

状态：

| 项 | 状态 | 说明 |
|---|---|---|
| WP14 身份 / 信任 / 签名 | **DONE** | 面板身份（Ed25519，私钥 AES-256-GCM 密文落地，密钥由 HKDF(AUTH_SECRET) 派生）、一次性 token 握手 + HMAC proof（防中间人冒充对端）、请求签名（JWS over raw body）+ 时间窗（60s 偏移容忍 / 300s 上限）+ 回执去重与幂等（**瞬态失败不留快照**）、密钥轮转（先通知后切换 + 24h retiring 宽限）、撤销（不可逆 + 级联停服 + panel 进程内即时生效 + 可用新 token 重建信任）、两侧审计 |
| WP15 授予 / 远端租约 | **DONE（含产品级接线）** | grant（epoch 单调 + scope/capacity fail-closed + suspend/revoke 语义分离）、远端租约状态机（reserved→active→releasing→released/expired/revoked/failed）、端口一律走 portPool、失败补偿不留孤儿；M2M 与 Admin 端点；**Forward 可声明远端出口腿**（`federated_egress_peer`）并由既有 rollout 流程建立/改版/补偿/释放，入口 next_hop 只认 host 返回的 `node_address:port` |
| WP16 用量 / 部分失败 / 对账 | **DONE（周期对账已接 worker）** | `usage_id` 去重 + 首写胜 + 归因不一致进 unattributed（不补 0）、到期/撤销清理、placement 重发、**已收敛行有界探活**（不可达 → degraded，恢复 → active，每拍上限 20）、到期**本地**转终态（零远端调用）、每拍可打印汇总 |
| Gate V5-G5 | **GREEN：PASS=206 / FAIL=0（连跑两遍逐行一致）** | 真两面板拓扑（两个 Panel、各自 DB/worker/Node/Agent、真实 Ed25519 签名 M2M）；19 个场景 / 206 条断言，含 Forward 级 G5.16–G5.19。同一镜像上 G0 = 137/0、G4 = 25/0。证据：`docs/evidence/v5-g5-result-20261005.txt` |
| Gate V5-G0（回归） | **GREEN：137/0** | 同一镜像、G5 的两轮分区模拟之后运行 ⇒ "`federated_egress_peer=NULL` 路径逐字节不变"在真实四 Agent 拓扑上成立 |
| Gate V5-G4（回归） | **GREEN：25/0** | 同上；证明 G5 的破坏性操作没留下残留 |

**一条容易漏掉、但决定联邦是否真的可用的不变量**：host 侧必须把它的联邦腿**发布进自己的权威
desired 快照**（`federation_lease.applied_config` + `buildDesiredNodeSnapshot` 追加）。
只在命令路径下发是不够的 —— Agent 的 reconcile 会正确地删掉"不在权威期望状态里的 runtime"，
于是远端腿会活不过一个上报周期，而面板两侧账本都还显示 active（用户看到的是"系统说活着、
链路不通"）。**同一份事实必须有两条投递路径**（命令 + 快照），这是 V4 已经在协议、证书路径、
健康数组上反复学到的那条。

WP15 第一版**明确不做**（fail-closed）：远端 ingress / 远端 transit / 跨面板 3+ 跳、
`tls` 远端出口（证书是节点本地文件，apply 形状未冻结这一维）。
（远端 ingress 的服务层与 HTTP 路由均已打通，但产品级创建路径目前只接线了远端 egress；
远端 ingress 仍不开放。）

已明确**不开放**（继续 fail-closed）：跨面板 3+ 跳 / 任意图、跨面板自动 failover、
远端资源的本地结算、多 Panel 信任的传递闭包。

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

从 PR #32 起，CI 分成**开发快线**与**主干/发布全量回归**，不再让每次小提交串行重跑全部历史 Gate：

~~~text
Pull Request
  Source CI
    backend / web / agent / race / secret / installer / perf-harness
  +
  Fast Integration
    real topology setup + baseline verify
    V5-G1B protocol regression
        ↓
      merge

main
  Source CI
      ↓
  Full Integration / release qualification
    V3 baseline
    V4 rollout + F1/F2/F3/F4/F5
    V5 G0 / G1A / G1B / G4 / G5
    unified image smoke
      ↓
    Release
~~~

历史 Gate **没有删除**，只是从开发内循环移到 main 的 release qualification。新增 Gate 应按失败面放进合适层：快速且高价值的协议/核心回归可进 PR；重型、多 Panel、破坏性场景放 main / release。不得靠删除断言、skip 或改弱判据换取绿色。

Agent CI 的并发/runtime 安全线固定包含 `go test -race ./...`。Feature branch 不再同时跑 push CI 与 PR CI，避免同一 SHA 重复消耗 runner。

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
历史已验证能力（2026-10-05）：
V5.0   G0  = 137/0
V5.1a  G1A = 73/0
V5.1b  G1B = 77/0（UDP DIRECT + 单跳 UDP RELAY；独立拓扑证据）
V5.2   G2  = 23/0
V5.3   G3  = 50/0
V5.4   G4  = 25/0
V5.5   G5  = 206/0（连跑两遍逐行一致）
V5.6   G6  = 72/0（DDNS / ingress placement）
WP20   G7  = 33/0（订阅计费运行时）

PR #32 merge-closure 状态：
- Source CI：最新已完成轮次全绿（backend / web / agent / race / secret / installer / perf）。
- PR Fast Integration：baseline verify 已绿；G1B 暴露的是 CI harness 自包含问题，不是已确认的数据面回归：
  ① host-run 环境没有历史 `g0-runner`；
  ② internal Docker network 未显式填写 IPAM Gateway；
  ③ G1B 单独运行时此前隐式依赖 G1A 留下的 byte-echo listener。
- `dbebb2a` 已把 G1B 改成自包含：从运行中 Agent 反查实际 network/subnet 并推导 host bridge 地址，
  同时由 G1B 自己启动 stream regression 的 echo target。最终 head 仍须重新跑绿后才能合并。

已经落地：
- User / Admin / Auth Console Boundary + Route Profile；
- TLS / WS / UDP DIRECT / UDP RELAY；
- Target Intelligence、HA/fencing、自动 failover/failback、2/3-hop；
- Federation 的 identity/trust/grant/remote lease/usage + 产品级 remote egress；
- WP17 DDNS；
- WP18 公告 + Email/Webhook/Telegram + 投递账本（事实触发器最后接线除外）；
- WP19 diag / latency history / topology / Looking Glass（Web 历史图表除外）；
- WP20 subscription billing runtime；
- WP21 installer + production deploy docs + static/dry-run verification。

当前产品收口优先级：
1. 让 PR #32 的最终 Source CI + Fast Integration 全绿并合并；
2. 接完 WP18 Forward 拒绝/恢复事实通知 → 既有 worker reconcile 节拍；
3. 补 WP19 延迟历史 Web 图表/产品展示；
4. 把发布流水线继续演进为“Build once → test candidate artifact → promote same digest”，避免 Release 再次重建不同字节；
5. Federation / Looking Glass 在宣称 production-ready 前做独立安全评审。

明确仍不开放（fail-closed）：
- QUIC；
- UDP 分片重组、packets 计费、hop AEAD/MAC、跨面板 UDP 腿；
- remote ingress 的产品级创建路径、remote transit、跨面板 3+ hop / arbitrary graph；
- 跨面板自动 failover、tls remote egress、多 Panel 信任传递闭包；
- 生产业务链上的主动带宽压测。
~~~

可执行硬约束：

1. 不得再引入第二套路由模型、第二套状态机、第二份 desired 或第二个端口所有权；
2. 联邦只走 `docs/v5-wp14-16-federation-contract.md`，跨 Panel 资源不复制成本地 Node / lease；
3. 每个新增能力必须挂回既有 Forward desired → revision → ACK → applied → reconcile 链；
4. Gate 失败先区分产品缺陷与 harness 缺陷；两者都要修，但不得通过删断言/skip 伪造绿色；
5. PR 走快线不等于删除历史覆盖：V4/V5 重型 Gate 保留在 main / release qualification。
~~~
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
>
> 产品层同时遵守：**管理员编排资源与线路，用户消费 Route Profile 与 Forward；模板可以复用，运行时真相不可复制。**

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

> **能力边界扩大以后，系统仍然只有一份真相、一个控制链、一个 ownership 模型，并且故障行为可解释、可恢复、可验证。
> **历史记录说明（2026-10-05）**：以下 `round 33` 及更早内容仅用于追溯调试过程，
> 已被 §9.3 的 **G4=25/0** 与 §17 的当前状态取代。不得把其中的 `23/2`、`进行中`、
> `下一轮` 等文字当作当前开发状态；当前真相只看上面的 Gate 结果与“当前下一步”。

**round 33（历史）：诊断缺口关闭时 G4=23/2，后续已在 merge-closure 收敛到 25/0**

**关闭的产品缺口**：`POST /forwards/:id/diagnose` 现在把三跳路由**拆成两段**
（`ingress_to_middle` + `middle_to_egress` ✅ 每段各自点名两端节点与各自期望的 runtime ✅）。
**"失败的那一段就是失败的那一跳"** —— 这就是"能定位失败跳"的实现方式 ✅
G4.3 的 `it names the failing hop (hop 1 / the middle node)` **由失败转为通过** ✅

中间跳的监听端口从**它自己的端口租约**里读（`(node_id=middle, tunnel_id, status=active)` ✅），
而不是在 tunnel 行上加一列 —— "哪个节点持有哪个端口"这件事本来就归租约表所有，第二个家就是漂移的开始 ✅

**过程中我自己犯的两个错（都留下了教训）**：

1. 我假设租约表有 `direction` 列 —— 它**没有**（方向由节点在拓扑里的角色决定，不重复存储）✅
   Prisma 直接拒绝，而**路由层把它变成了一个普通的 500** ✅ 教训：**500 时要看服务端日志，
   不要从状态码猜原因；也不要假设表的列名** ✅
2. 门禁的"中间节点真承载中转 runtime"仍然失败 —— 但 G4.2/G4.3 已经证明流量**确实**经过中间跳 ✅
   ⇒ 这是**门禁侧的 id/上报判据**问题（不是产品问题）✅ 下一轮先把该节点上报里的**真实 id** 读出来，
   再决定是判据写错还是上报缺项 ✅

**剩余两条**：① 门禁的中间跳 runtime 判据 ✅ ② 改回单跳后客户端未在超时内恢复（端口从 21005 → 21006 的
过渡问题 ✅ 与 round 19 那类"重切入口"同源 ✅）。

**round 32：三跳路径**端到端跑通了**（G4 23/2），并暴露一个真实的诊断缺口**

**本轮两处修复**：

1. **装上仪器**：创建失败现在打印**失败在哪一步**与整条轨迹。此前 502 body 把 `steps`/`failedStep`
   整条丢掉，于是"出口之后哪一步失败"只能猜 —— 而**那一步的失败会泄漏已经发出的出口 runtime**，
   让泄漏连续三轮看起来像"端口分配有 bug"。第一行输出就点名了元凶：
   `failed_step=apply_transit error_code=invariant_violated`。
2. **中间跳不是调度候选**：候选按**节点组**筛（`inNodeGroupId`/`outNodeGroupId`），而中间跳是用户显式
   选定的放置事实、通常属于**第三个**组 —— 在候选列表里永远找不到它。改为按 id 直读（与"绑定后的
   入出口必须落在指定节点"同一口径：**已确定的放置不参与重新调度**）。修后创建返回 **201 + active** ✅

**G4 = 23 PASS / 2 FAIL**，其中**最关键的三条一起通过**：`客户端拿到数据` ✅ + **`它曾经在服务`** ✅ +
**`停掉中间跳后失败`** ✅ —— 这三条合起来才是"中间跳真的在链路上"的证据（上一轮我正是为此加强了断言）✅

**剩余两条**：

| 失败 | 性质 |
|---|---|
| **诊断不点名失败跳**：`POST /forwards/:id/diagnose` 返回的 segments 只有 `ingress_to_egress`（node 3），**完全不认识中间跳** | **真实产品缺口** ✅（G4 明确要求"遥测能定位失败跳"）。同属"一次事实多条路径"：诊断路径没跟着 V5.4 学会中间跳 |
| 门禁的"中间节点真的承载中转 runtime" | **门禁缺陷**：节点上报是 30s 一拍，创建刚返回时还是上一拍 ⇒ 立刻断言会把"上报没刷新"读成"没下发"。已改为**等待**该 runtime 出现 |

**round 31：环境重置后得到可信读数 —— 三跳创建本身仍然失败，且失败后会留下出口 runtime**

**本轮修掉的产品缺陷**：**从未成功应用过**的转发不得被发布成期望状态 ✅
（`applied_revision IS NULL` ⇒ 不发 ✅；有值 ⇒ 照发，因为那是"更新失败、上一版本仍在运行"的契约 ✅）。
反向的那半写在同一条注释里，避免下一个人只改一半 ✅ + 源码级断言（它活在一个数据库查询里，别的地方不会发现它被改回去 ✅）。

**环境重置 + 可信读数**（清掉调试遗留行、重开 agent、两个 agent 的上报只剩合法 runtime ✅、基线转发正常 ✅）：

- **`G4.1 三跳路由可创建` 失败（502）** ⇒ 创建失败**不是**（仅仅是）环境被污染 ✅
- **创建会把出口腿发出去（`tunex-277-egress applied port=22001 revision=2`）然后失败，且不撤它** ✅
  ⇒ **每一次尝试都在毒化下一次**（22001 被永久占住 ✅ 而分配器查租约、认为可用 ✅）

**下一轮的第一个动作（仪器已经确定）**：创建路径的失败**没有暴露步骤**（API 响应里 `steps: null` ✅，
而我猜的 `create_relay_tunnel_record` 表并不存在 ✅）。要先**找到或补上**创建路径的步骤台账 ✅，
读出"出口之后到底哪一步失败了" ✅，再让**那条**失败路径也走统一拆除 ✅。
（round 27/28 的统一拆除覆盖的是我知道的那些分支 ✅；这一条显然不在其中 ✅。）

**round 30：修掉一个真实的裁剪盲区（已端到端验证），并证实"一个端口两个真相源"**

**修掉的产品缺陷（有证据链）**：`restore.Reconcile` 只遍历 `TunnelManager.IDs()`，而**纯出口节点**上那个集合是
**空的** —— 出口 runtime 活在 `EgressManager` 的池表里。因此"节点离线期间被删除的 Forward"的出口 runtime
**永远裁不掉**，一直占着监听端口。修法：两侧用**同一份**权威 id 集合裁剪 ✅ 并加两个用例（孤儿必撤 ✅ /
在期望集合里的**不得**撤 ✅，否则每次重连都会拆掉在跑的转发 ✅）。
**端到端验证**：重新部署后，agent 上报里的 `tunex-272-egress` **消失** ✅（`has272: 463 -> 0`）✅

**另一个我自己的错误（编译器抓到）**：我第一版新增了一个 `EgressManager.IDs()` —— 它**已经存在** ✅
（而且更好：有序 ✅）。这正是我一直在修的"同一事实的第二份实现"，这次由编译器抓住 ✅

**证实了 round 28 假设的**更窄形式**：一个端口有两个真相源**

用**干净的 agent** 复现出确凿证据：

~~~text
tunnel 273/275: apply_status=error, egress_port=22001, egress_node_id=4   ← 面板仍把它们算作"期望"
agent 上报:     仍然持有 22001
分配器:         查的是数据库租约 ⇒ 认为 22001 可用
~~~

⇒ 一次**失败创建**（没有基线可回）会留下：① 一行 `error` 状态的 DB 行 ✅ ② 节点上一条仍被发布的 runtime ✅
③ 一个"租约已释放但端口仍被占用"的分歧 ✅。**面板侧还缺最后一环：失败且无基线的创建不该继续出现在快照里**
（拆除路径已在 round 27/28 补齐，缺的是"别再发布它"这一半 —— 同样是一次事实两条路径）✅

**环境已被我自己的调试创建污染**（22001 上的遗留行与 runtime）⇒ 本轮 G4 的读数在**清理环境之前不可信**
（16/9，连单跳路径都被拖成 `error`）。下一轮必须**先重置环境再测量**，并且把门禁自身的 fixture 清理改为
**只走 API**（现在的 `deleteMany` 是孤儿的另一个来源）✅

**round 29：round 28 的假设被证据否掉 —— 孤儿另有其因（已重新定性）**

round 28 我写下的假设是"快照恢复了 `error`/`pending` 的行"。**本轮验证后否掉**：

- 实测出口 agent 的**上报**里仍有 `tunex-272-egress`（该 Forward 的 DB 行早已删除 ✅），而 DB 里只剩 2 条 relay 行；
- Agent **本来就有**协调逻辑：`internal/restore/resolve.go` 的 `Reconcile()` 会移除"不在权威期望集合里"的 runtime，
  而且它注释里明确写了**不**在快照来自缓存时调用（缓存不是权威）；
- 但那个孤儿**没有被清掉** ⇒ 要么它从未拿到一份**新鲜且不含 272** 的快照，要么拿到后协调没跑。

⇒ 正确的下一步诊断是**两条日志**：Agent 侧"快照拉取是否成功/是否来自缓存"，与面板侧"给 node 4 发布的 id 集合里是否还有 272"。

**顺带纠正孤儿的主要来源**：门禁的 `cleanup_fixtures` 既走 `DELETE /api/forwards/:id`（会撤 runtime ✅），
又**直接 `deleteMany` 删行**（不会撤 runtime ✅）。后者 + 我早前那些失败的创建，就是环境里孤儿的来源。
**产品侧的泄漏路径本轮已修**（创建失败的统一拆除、删除/挂起撤中间跳）；剩下的是"手工/脚本直接删行"这一类，
以及上面那条待查的协调链路。

**round 28：三条拆除路径补上中间跳；创建仍然失败 —— 但根因已定性为一个**端口归属的真相源分歧**

本轮的修复（都已提交）：

| 修复 | 内容 |
|---|---|
| **创建失败的统一拆除** | `reapplyRelayTunnel` 里每个失败分支各写一次内联拆除，V5.4 加了中间跳之后**没有一个分支记得撤它**。现在收敛成**一个** `teardownDispatched()`，逆序（先中间后出口）+ 释放租约，所有分支都走它 |
| **删除 / 挂起也撤中间跳** | 实测泄漏：`tunex-268-egress` 仍然活在 22001 上，而它的 Forward 行早已删除 ⇒ Agent 正确地拒绝后续每一次分配到 22001，症状看起来像"端口分配有 bug" |
| **G4.3 的断言加强** | 先断言**它曾经在服务**；否则"停掉中间跳后失败"在路由根本没通时也会通过（上一轮的假阳性） |

**创建仍然失败，而根因是一个真实的设计分歧（下一轮的第一个动作）**

三跳创建每一次都以 `apply_status=error`、`applied_revision=0` 收场。把 `error` 态的遗留行清掉、重启出口 agent 之后，
失败**换了端口但没消失** ⇒ 这不是 fixture 噪声，而是：

> **"这个端口归谁"有两个真相源。** 分配器只看 **port lease**（DB），而 Agent 的端口守卫来自它**从快照恢复的
> runtime 列表** —— 后者包含 DB 里仍存在但**从未真正应用成功**的行（`error` / `pending`）。于是分配器把一个
> Agent 仍然守着、DB 里却没有租约的端口发出去，Agent 正确地拒绝。

修法方向（下一轮）：让两侧对同一问题用同一份事实 —— 要么**快照只包含已应用成功的 runtime**（`error`/`pending`
的行不该被恢复），要么**分配器也把"该节点上仍有 runtime 认领的端口"算作占用**。前者更小且更符合契约：
**没有应用成功的东西不该在节点上运行**。

**round 27：创建路径学会中间跳（走**同一份实现**）→ 暴露出下一个真实缺陷**

修法：把"怎么发一条中间跳"抽成**唯一实现** `Orchestrator.dispatchTransit`，rollout 的
`prepare_transit` 与创建路径**都调用它**。编排保持在两处（它们职责确实不同：一个应用已批准的 revision，
一个创建 Forward），但**事实的实现只有一处** —— 两次编排是合法的，两套"怎么发中间跳"才是静默分叉的开始。

**G4 随之从"流量绕开中间跳"变成"创建真的去发中间跳了"**，并立刻暴露下一个缺陷：

~~~text
egress_apply_rejected: WP14-OUT-A-NODE 拒绝 apply_tunnel：manager: port 22001 is already used by another tunnel
~~~

**这是一次失败创建留下的端口守卫**：上一次三跳创建失败（G4.2 那次）**没有把已经发出去的出口 runtime 撤掉**，
于是 Agent 侧的端口守卫仍然生效；DB 里的端口租约已经释放，于是下一次分配又选中 22001，而 Agent 正确地拒绝。
⇒ **创建失败的清理不完整**（我的中转失败分支会撤出口，但更早的失败路径未必），这是下一轮要修的。

**另外发现门禁自身的弱点（必须修）**：`G4.3`「停掉中间跳后客户端失败」在**路由根本没通**时也会"通过" ——
它必须**先断言它曾经在服务**，否则一个完全不可用的路由会让这条断言变成假阳性。
这与本阶段反复得到的教训同源：**断言的强弱决定它能不能区分两种世界**。

**round 26：G4 门禁建成并跑出第一条真实结论 —— 22 PASS / 2 FAIL**

门禁六条用例（`scripts/v3-e2e/v5-g4.py`，证据 `docs/evidence/v5-g4-result-20261004.txt`）：

| 用例 | 结果 |
|---|---|
| G4.1 三跳路由可创建（中间跳落库、两端就位） | ✅ |
| G4.2 客户端拿到数据、路由报告已应用 | ✅（**但见下：通过的原因不对**） |
| G4.3 停掉中间跳后客户端失败 / 诊断点名 hop 1 | ❌**失败** / ✅ |
| G4.4 缺任一段许可被拒且说明原因 | ✅ |
| G4.5 「中间节点真的承载中转 runtime」/ 改回单跳后 runtime 消失 / 行不再声明中间跳 | ❌**失败** / ✅ / ✅ |
| G4.6 改回单跳后客户端仍然通（V4 路径无回归） | ✅ |

**这两条失败是真结论，不是门禁噪声**：实测中间节点（node 5）的上报里**完全没有 runtime**
（`has_any=0`），而客户端照样拿到数据 ⇒ **流量绕过了中间跳**，走的是既有单跳路径。

**根因**：**创建路径不认识 `middle_node_id`**。创建走的是它自己那套编排（一次性发入口+出口），
而**只有 rollout 计划里才有 `prepare_transit`** —— 也就是说"知道中间跳"的那条路只有一条。

**这正是本项目最常见的缺陷形态，只是这次发生在创建流程内部**：同一个事实有两条投递路径
（创建 / rollout），只补了一条。前面几次是协议、证书路径、健康数组、池内容、路由 schema；
这次是创建路径。

**顺带得到一个测试教训（值得留下）**：G4.2 的"客户端拿到数据"**通过的原因不对** —— 单跳路径也能满足它。
真正能证明"中间跳在链路上"的只有两条断言：**中间节点是否承载 runtime** 与**停掉它是否使客户端失败**。
前者我写了（G4.5 第一条 ✅ 抓到了），后者也写了（G4.3 ✅ 抓到了）。**"端到端通了"本身不构成"多跳通了"的证据。**

**下一轮第一个动作**：让创建路径也认识中间跳（把创建交给 rollout 计划，或在创建里补发中转腿）→ 重跑 G4 → 期望全绿 → V5.4 收口。

**round 22-24：V5.4 的下发、计划与准入（已提交）**

| 提交 | 内容 |
|---|---|
| `a586678` | **路由下发**：`dispatchRoute` 按 `RoutePlan` **先远后近**发，每一跳都是既有原语（出口指向真实池；中间跳指向下一跳；入口指向上一个） |
| `17d589a` | **计划与执行器学会中间跳**：`acquire_port` + `prepare_transit`；下一跳解析拆成 `resolveHopAddress`（入口的下一跳是中间跳、中间跳的下一跳是出口 —— 这两个不同，我第一版两个都写错了） |
| `dc047c3` | **补偿拆除中间跳** + **打开多跳准入** + 源码级断言钉住接线 |

**为什么补偿里必须撤中间跳**：它的形态与出口跳相同（监听 + 拨号到下一跳）⇒ 漏撤会留下**孤儿中转链路**：
照旧监听、照旧接受连接，把流量转给一个已经被拆掉的下一跳。**不报错**，只静默占着端口与许可 ——
这正是 G4 要验的一项。

**V5.4 剩余（下一轮起点）**

1. **API 表面**：`ForwardCreateInput` / `ForwardPatchInput` 还没有 `middle_node_id` ⇒ **今天无法通过 API 创建
   三跳路由**。要加：输入字段 + 落库 + `currentDesiredConfig`/candidate 带上它 + 与 `NodeBinding` 同样
   的相邻许可校验（创建时对 (hop0→hop1) 与 (hop1→hopN) 各查一次绑定）。
2. **G4 门禁**（真实四 Agent 拓扑）：2 跳/3 跳端到端（客户端经 3→5→4 拿到数据）+ **失败跳定位**
   （停掉中间跳后诊断必须点名 hop 1）+ **孤儿链路/端口清理**（改路由后中间跳的 runtime 必须消失，
   从该节点的上报里可验）+ 缺绑定被拒。

**round 20：V5.4 的路由准入接进 rollout 路径（整条路由已知的那一层）**

契约层之前"存在但无人询问"—— 正是本项目反复付代价的"实现了但没接线"。现在它在 `registerRollout`
里、**加载完放置事实之后、任何副作用之前**执行（与 runtime 拒绝同一位置，因此被拒绝的路由不留痕）。

**位置本身就是要点**：我先试了"每条腿各自准入"并回滚 —— `dispatchIngress` 看不到出口节点，按腿判定会
把**每一个 RELAY** 都拒掉（28 个用例失败）。路由是一个整体，检查也必须是。

接线过程中浮出两个设计问题，**改的都是代码而不是测试**：

1. **单跳不得要求预先存在 Binding**。round 16 我核对到线上拓扑确实有 `node_binding (3 -> 4)`，于是把
   这条要求套到单跳上 —— 但那是**创建之后**的状态：RELAY 首次部署时 Binding 还不存在，而 rollout 计划里
   本来就有 `ensure_binding`，**创建它正是那次 rollout 的工作**。正确的问法不是"绑定存不存在"，而是
   "**谁负责创建它**"：单跳由 rollout 创建 ⇒ 准入不管；三跳的中间跳是新增链路，必须先有许可 ⇒ 准入必查。
   （实测：套在单跳上直接 34 个用例失败。）
2. **部分实现的 DB 端口不该炸掉整条路径**：绑定加载器把可选链放高了一层
   （`db.nodeBinding?.findMany(...)`），于是"有 `nodeBinding` 但没有 `findMany`"的替身会让
   `registerRollout` 抛 TypeError，而不是退化成"不知道任何绑定"。

**本轮结束时的一个诚实记录**：部署后 e2e 的 relay 处于下线状态（`apply_status=pending`、`config_revision=8`、
`applied_revision=7`）。期间查到两个真实现象，都值得下一轮接着看：

- 两台 agent 的控制拉取曾一度 `connection refused`（面板正在重启）—— 这类**部署瞬态**会让转发看起来
  "无人修复"，而面板 `/healthz` 反而是绿的；
- rollout 37（revision 7）报 `phase=done` 且无错误，而 DB 显示 `active`、两台节点都不服务 —— 这正是
  round 15 记下、当时无法复现的"账本说好、事实说坏"。**现在它有可复现的取证路径**：rollout 台账 +
  finding 明细 + **agent 自己的日志**（本轮第一次用 `docker logs` 看 agent，立刻看到了那条 refused）。

**round 19 结果（历史）：V5-G3 全绿 50/0 → V5.3 收口**

### ✅ V5.3 完成（2026-10-04，round 19）

**Gate V5-G3：PASS=50 / FAIL=0**（证据 `docs/evidence/v5-g3-result-20261004b.txt`）

| WP | 内容 | 状态 |
|---|---|---|
| WP8 | DNS 动态目标（TTL 缓存、单飞、失败回退上一份好地址并带年龄、IP 直连绕过解析、双栈按序尝试） | ✅ |
| WP9 | 归属栅栏（租约 + 持久化 epoch 高水位 + CAS 迁移 + 两阶段交接 + 到期即停） | ✅ |
| WP10 | 故障转移（六条件纯策略 + 执行器 + 自动循环挂在既有 reconcile 节拍 + 回切） | ✅ |

**门禁证明的完整安全故事**：分区构造 → owner **自己停**（无任何指令）→ 愈合后 reconcile 恢复 →
两阶段拒绝早接管 → 真实接管 **epoch+1** → 竞态安全（同一世代不可能两个赢家）→ desired 未被改写 →
面板重启安全 → heartbeat 单独不足以迁移 → **自动迁移（无人工干预）** → **新主人真的开始服务** →
**被栅栏挡住的老主人不在服务**。

**这一阶段修掉的真实缺陷（按发现顺序）**：续约缺回程 · TTL 与上报周期相等 · 续约按"上报的隧道"续（自锁）·
认领与 epoch 未同处 · 归属迁移是读后写而非 CAS · 出口腿错误地认领归属 · reconcile 只比"存在性"不比"内容"·
漂移判定的输入没接线 · 把 `dispatchEgress` 挂在错误的对象上 · 回滚原地重放基线版本被 Agent 正确拒绝 ·
**入口重切时没有重新准备出口（导致新主人永远不服务）** · 以及若干门禁自身的缺陷。

**round 18 结果：A 已落地（回滚 = 新世代），而 G3.11 的真正阻塞点被定位到**一行条件**

A 已按第三种方案实现并提交（`8138391`）：回滚产生新世代（`max(base, target) + 1`）、为新世代复制基线快照、
三处重放都用它、**只有补偿完全成功才**把 `config_revision/applied_revision/apply_status` 一起前进、
无基线时保持旧语义。两个补偿用例断言的是**旧契约**，已按新契约改写（这是契约变更，提交信息里写明）。

**但 G3.11 仍然是 49/1** —— A 是真实缺陷，却不是那个阻塞点。新的 rollout 台账把真正的阻塞点指了出来：

~~~text
forward_rollout#36 (tunnel 2, revision 5, base 4)
  last_error:          RELAY 缺少 next_hop
  compensation_error:  baseline snapshot revision=4 不存在
~~~

**真正的阻塞点（下一轮的第一个动作，预计一行条件 + 一个用例）**

`prepare_egress` 只在**出口侧发生变化**时才被排入计划：

~~~ts
if (relay && (impact.egress_node_change || impact.egress_target_change || impact.mode_change)) {
  push("prepare", "prepare_egress", { ... });   // 只有这里会 recordNextHop(...) 登记 egress host
}
~~~

而**只换入口节点**的迁移（failover 走的就是这条）恰恰不在这个条件里 ⇒ **没有 `prepare_egress` ⇒ 没有登记
egress host ⇒ `resolveNextHop` 返回 null ⇒ `next_hop_unresolved` ⇒ 入口 cutover 失败 ⇒ 新主人永远不服务**。

修法：把"入口将要重切"也纳入出口 prepare 的条件（`impact.ingress_node_change`）。这也与铁律的措辞一致 ——
**没有 next_hop 就不允许启入口**，所以入口要重切时，出口的"可寻址地址"必须被重新确认一次（该步骤同 revision
幂等，重放是 no-op）。

**第二条（属于我自己的 fixture 损伤，不是产品缺陷）**：`baseline snapshot revision=4 不存在` —— 我早前
"强制一个新 revision" 的修复只改了 `config_revision`，没有写快照行。它顺带证明了新代码在缺基线时**如实失败**
而不是静默退回旧路径。

**round 17 结果（历史）：A 的正确修法比"改个版本号"更深**

**round 16 结果：A 的修法已定案（未落地）、B 被降级为"未验证的假设"**

**A（补偿重放被拒）—— 正确的修法比"改个版本号"更深，本轮只定案**

第一次尝试（`replayRevision = max(base_revision, target_revision)`）**被现有测试挡住，而测试是对的**：

```text
CUTOVER 失败 ⇒ compensating → 补偿撤新 runtime + 重放基线
  expect(dispatchDirect[0].revision).toBe(6)   ← 基线版本；我改成 7 后失败
```

把它改成 7 会**让台账说谎**：revision 7 的含义是"用户的新配置"，而实际跑的是基线内容 ——
面板会认为新配置已生效。这正是本项目反复修的那一类"账本与事实不一致"，只是这次由我自己制造。

**但保持 6 也确实是坏的**（Agent 单调拒收更低的 revision ⇒ 补偿永远失败 ⇒ rollout 停在 degraded）。
两难说明**回滚在单调版本系统里必须产生一个新的世代**：

| 方案 | 结果 |
|---|---|
| 重放 `base_revision`（现状） | Agent 正确地拒绝为 `stale_revision` ⇒ 补偿永远失败 ⇒ 转发停在 degraded |
| 重放 `max(base, target)` | Agent 接受，但**内容的版本号说了谎** ⇒ 面板认为新配置已生效 |
| **产生新世代 `max(base, target) + 1`，内容 = 基线** | 两者都成立：内容回到基线、版本继续向前、台账与事实一致 ⇒ **正确** |

**下一轮要按第三种做**（一次完整的改动，不要半个）：
1. 计算 `rollbackRevision = max(base_revision, tunnel.config_revision) + 1`；
2. **复制基线快照行**成新 revision 的 `forwardRevision`（否则后续 rollout 的基线查找会报"不存在"）；
3. 三处重放（egress/ingress/direct）都带 `rollbackRevision`；
4. 成功后把 `tunnel.config_revision` 写成 `rollbackRevision`（**只有成功才写**，保持"台账跟随事实"）；
5. 更新那两个补偿用例：它们断言的是**旧契约**（"原地重放基线版本"），新契约是"回滚产生新世代" ——
   这是**契约变更**，必须在提交信息里写明，而不是悄悄改测试。

**本轮实际落地：没有。** 编辑过程中我误删过 `if (!baseline)` 守卫（在发现**行数 2092 -> 0** 之后回滚），
随后按上面的分析做了三处替换并让两个用例失败，证实方案二不值得，于是**再次整体回滚**，工作区恢复
HEAD（1712 全绿）。教训：大文件上的外科式编辑**每一步都要核对行数与类型检查**；重建要用
`git show HEAD:backend/src/...`（我第一次用错路径前缀拿到空串）。

**B（面板账本与事实不一致）—— 降级为未验证的假设，不得当成缺陷**

上一轮我写下的证据只到"面板说 active 而两侧都不服务"这一步。而"reconcile 完全没发现"这一半，
证据来自**别的窗口**（那些窗口的原因已各自定位），并且我自己的修复动作
（把 `applied_revision` 直接置成 `config_revision`）恰好会**掩盖**漂移检测 —— 也就是说测量被修复动作污染了。
下一轮顺序：先落地 A → 重跑 G3 → 看迁移是否走完；B 只在**可复现状态**下重新取证。

**round 15 结果：G3 = 49 PASS / 1 FAIL —— 自动迁移本身已完全通过，剩余 1 项是"迁移没完成"**

通过的（这一阶段最关键的几条）：分区构造 ✅ → **owner 自己停** ✅ → 愈合后恢复 ✅ → 两阶段拒绝早接管 ✅ →
真实接管 epoch+1 ✅ → 竞态安全 ✅ → desired 未改写 ✅ → 面板重启安全 ✅ → heartbeat 单独不迁移 ✅ →
**`the loop migrated ownership away from the dead owner BY ITSELF`** ✅ → **epoch 恰好 +1** ✅ →
**放置跟着归属走** ✅ → **被栅栏挡住的老主人确实不在服务** ✅。

唯一失败：**"新主人没有在服务"** —— 而它的原因由**rollout 自己的台账**完整给出：

~~~text
forward_rollout#35 (tunnel 2, revision 3, strategy=node_migration)
  phase: degraded
  last_error_code: compensation_failed
  last_error:      RELAY 缺少 next_hop            ← 迁移的 rollout 在 cutover 时拿不到 next_hop
  compensation_error: replay egress: 拒绝 stale_revision（期望 revision=2，当前 revision=4）
~~~

**两个新的、范围明确的真实缺陷（下一轮修）**

| # | 缺陷 | 证据 |
|---|---|---|
| **A** | 迁移触发的 rollout 失败后，**补偿把"基版本"当成重放目标**，而该行已经前进到更高的 revision ⇒ 补偿被 `stale_revision` 拒绝 ⇒ 转发停在 `degraded`，两侧都不服务 | 上面那段 `compensation_error` |
| **B** | 之后**面板的账本与事实不一致**：`apply_status=active`、`applied_revision == config_revision`，而两台节点都没有这条 runtime；reconcile 对它**没有产生任何 drift** ⇒ 直到**强制一个新 revision** 才恢复 | 实测：DB 显示 active，两侧 21002 都是 ConnectionRefused；强制 revision 后立刻 4/4 恢复 |

缺陷 B 是"面板相信自己的账本而不是 agent 的报表"这一族里最危险的一种：**它让一个已经下线的转发看起来完全健康**。
它的上游很可能是 A（迁移失败留下的中间态），但"失败之后无人发现"是独立的问题，必须单独修。

**round 14 结果（历史）：自动故障转移已被证明可行**

**round 13 结果：自动迁移的**决策**已经被证明是对的，卡在"过期后的第二次尝试"**

worker 日志（现在所有级别都打印）给出了完整答案：

~~~text
action=hold blockers=owner_reachable                       ← owner 还没 stale
action=move  blockers=                                      ← **六条条件全部为真、零 blocker**
failover waiting (old_lease_still_live) {"detail":"旧租约仍由节点 3 持有，08:28:01 才过期：等待，不强行交接"}
~~~

也就是说：**策略判定正确、执行器正确地拒绝强行交接、并且给出了等待原因** ✅ 这正是 §8 两阶段交接的设计行为。
剩下的是**租约到期之后的下一次尝试应当完成认领与迁移**，而那一拍没有发生（等待窗口内没有后续的
`move`/`moved` 日志）。

另有一个独立实测（本轮做的对照实验）：**owner 停掉后租约确实停止推进** —— 运行中每 20~25s 前进 30s
（上报节奏 ✅），停掉后 4 次采样固定在同一个时间戳，同时 `last_seen_at` 从 0 老化到 75s ✅。
所以"续约机制"这一侧是干净的；要查的是**到期后那一拍为什么没再尝试**（下一轮的仪器已经就位：
sweep 的每一拍决策与结果都会打印，包括 `evaluated/moved/held` 汇总）。

**round 12 结果（历史）：fixture 修对了（blocker 从 2 降到 1），但 G3.11 仍未跑完**

两处 fixture 改动**已被证据验证是正确方向**：把池改成全健康目标 + 把备用节点放进 owner 所在的入口节点组之后，
worker 日志里的 blocker 从

~~~text
action=hold blockers=target_side_failure,no_standby_candidate   ← 改之前
action=hold blockers=owner_reachable                            ← 改之后
~~~

**只剩一个 `owner_reachable`** —— 也就是说策略的其余五条（观测新鲜度、目标侧归因、端口可用、冷却、策略开关）
**全部通过** ✅ 剩下的只是等 owner 真的 stale 这一步。

**但 G3.11 这轮没跑完**：进程在等待期间被外部终止（日志停在两行 PASS、没有 FAIL 行），因此
**自动迁移本身仍未得到验证**。下次要用一次不被打断的运行把它跑完。

fixture 已被还原（node 5 回组 5、池恢复两个目标），拓扑干净。

**round 11 结果（历史）：G3 = 44 PASS / 2 FAIL，两项都定位清楚（都不是产品缺陷）**

1. `G3.6` —— **门禁脚本陈旧**：断言在本地修好了但忘了 `docker cp` 到 runner，那一轮用的仍是旧副本。
2. `G3.11`（自动迁移）—— 补上可观测性之后**一行日志就看清了**：

~~~text
[worker] failover: failover decision {"tunnel_id":2,"detail":"action=hold blockers=target_side_failure,no_standby_candidate"}
[worker] failover sweep: {"evaluated":1,"moved":0,"held":1}
~~~

**两个 blocker 都是产品在正确地说不**：池里还留着**永远不应答**的目标 `target-a:9` ⇒ 策略判定"问题在目标侧"，
而迁移修不好目标（§8 明确禁止用它掩盖目标故障）；候选节点必须是**同一入口节点组**内的非现任节点，
而 e2e 里 node 3 与 node 5 **分属不同组**。所以下一轮要改的是**fixture**（池只含全健康目标 + 在 owner 组内
放一台可用入口节点），**不是代码** —— 把 blocker 放松到让门禁过去，恰好会删掉让自动迁移安全的两个保护。

**本轮的真正收获是可观测性**：worker 的 failover 日志回调**只打 warn/error**，而"hold / 正在等租约"这类结果
按 INFO 汇报（**正确的等待不是警告**）⇒ 一次"自动迁移没发生"的门禁失败**在日志里完全无痕**。已改为
**所有级别都打印**并在每拍输出 `evaluated/moved/held`。规则与这一阶段反复学到的是同一条：
**决策不留痕的机制，与从未运行过的机制无法区分。**



---

## 17.5 round — "端口已经空了，谁也拿不到"：端口守卫的三次收敛

**症状**（CI 上反复红，且每次红的样子都不同）：
V4 rollout 门禁一次红 8 条、V5-G5 一次红 15 条、V4 rest 门禁红 3 条、`git push` 两轮之间"红了又绿"。
共同点只有一个：**某条路由建不起来**，而错误码离原因很远（`apply_status=error` / `502`）。

**证据链**（每一环都是读出来的，不是猜的）：

1. 门禁 S7 只报 `502`。先补诊断，才拿到真正的错误码与现场：
   ~~~text
   tunnel:  error | code=port_port_taken   rollout: phase=failed err=port_port_taken
   ingress used_ports: [21001, 21002, 21003]
   ~~~
2. 面板本机读 DB（`node_port_lease` 已 released）⇒ 端口是空的；agent 读自己的守卫 ⇒ 端口被占。
   **同一个端口，两个事实来源**。
3. Agent 自己的上报是决定性证据：
   ~~~text
   node_state_report.used_ports = [22000, 22001]      ← 守卫认为两个端口都被占
   node_state_report.tunnels    = [tunex-2-egress]    ← 实际只有 22000 有 runtime
   ~~~
   面板于是把 22001 发给下一条路由，Agent 正确地拒绝：
   `manager: port 22001 is already used by another tunnel`。

**三次收敛**（每次都由上一次没覆盖到的缝推动）：

1. **守卫改成派生状态**（`10dfe61`）。原来 `usedPort` 由散落各处的 mark/release 手工维护，漏一条路径就留下
   "没人监听、却谁也拿不到"的端口。改为每次改动 `tunnels` 后按事实重建：
   `守卫 = {还有 runtime 在听的端口} ∪ {Stop 已发起、监听尚未关闭的端口}`。
2. **挂账加上界 + 自愈**（`0470367`）。第二道缝：drain 挂账只在 `Stop()` 返回时清账，清账一旦没跑到就**永久**占着 ——
   而它与"内核是否还占着"早已脱节。挂账改为带上界（30s，远大于 drain 上界 3s），过期即失效、以内核为准；
   端口检查前先重建一次，过期挂账不能挡回一次合法分配。
3. **占用检查排除"本隧道自己的 runtime"**（`cd83a4c`）。第三道缝出在面板侧：让分配器先问 Agent 是对的，
   但不区分持有者就变成**自冲突** —— 把 Forward 的 `listen_port` 改成它**当前正在使用**的那个值
   （幂等编辑 / 失败重试 / 门禁"还原夹具端口"）会被自己挡回去，症状是 502 `port_taken`，
   而那个端口明明就是这条隧道自己的腿在听。

**留下的判据**（写给下一次）：端口归属只有一个权威方向 —— **Host/Agent 的守卫是事实，面板的发放必须服从它**；
面板可以与它不一致（drain 窗口、残留、漂移），但只能"少发一个"，绝不能"多发一个"。
`capability ≠ authorization` 的另一个面：**DB 里没租约 ≠ 端口可用**。

**顺带修掉的两个"测试会随时间翻转"的坑**：
- `federation-lease` 的并发认领用例用夹具时间戳造 pending intent，却没固定"现在" —— 真实时间越过 60s 接管窗口后
  它就从"拒绝重投递"变成"接管"（与改动无关地变红）。注入 hooks 统一带 `now: () => NOW`。
- `v5-g1a.py` 的 401 重认证分支调用了 3 参 `record()`，把真正的 401 掩盖成看不懂的 `TypeError`。

**门禁诊断补强**（这一轮最值的投资）：S7 失败时打印响应体、`tunnel.apply_error`、
Agent 上报的 `used_ports` 与 runtime 列表（`id@port rRev`）、rollout 台账；G4.1/G4.5 打印响应体。
**没有这些，前面三轮都只能靠猜。**

**结果**：`cd83a4c` 上 CI / Integration / Release **全绿** —— v3 基线、V4 全套（rollout/REST/S10/F1–F5）、
V5-G0、V5-G4、双面板 bootstrap、V5-G5（206 断言）全部通过；agent `go test ./...` 12/12 包、
backend `bun run test:unit` 2017 pass / 0 fail、`bunx tsc --noEmit` exit 0。

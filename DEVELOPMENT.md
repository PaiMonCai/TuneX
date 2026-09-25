# TuneX v3 唯一开发方案

> **文档地位：本文件是 TuneX 唯一可执行的开发方案（Single Source of Truth）。**
>
> 后续功能设计、Issue、分支、PR、验收与发布均以本文件为准。不得再创建第二份路线图、迁移方案或并行开发计划。
>
> `docs/tunex-devmap-v3.md` 是 **v3 目标架构约束**：规定产品最终形态和关键能力，但不是执行清单。若其中旧目录、旧传输方式或早期实现细节与当前代码事实冲突，以本文件的迁移安全规则为实施准则，同时不得改变 v3map 的核心产品语义。
>
> `docs/production-deploy.md` 是运维手册；`reports/` 是历史验证证据。它们都不是开发路线。

---

## 1. 后续唯一方向

TuneX 后续停止横向堆叠非核心功能，主线统一为：

**在现有多租户 SaaS 底座上完成 v3 网络架构升级。**

v3 的目标不是重写整个项目，而是保留已经稳定的 Workspace、权限、策略额度、流量、认证、CI 和生产运维能力，把网络层升级为明确的节点角色、隧道模式、运行绑定、可靠编排和可恢复的数据面。

### 1.1 v3 不可改变的产品约束

以下约束来自 `docs/tunex-devmap-v3.md`，后续实现不得偏离：

- Node 具备 `INGRESS / EGRESS / BOTH` 三种角色。
- Tunnel 具备 `DIRECT / RELAY` 两种模式。
- DIRECT：客户端 → 入口节点 → 目标。
- RELAY：客户端 → 入口节点 → 出口节点 → 目标池。
- RELAY 必须 **先准备出口，再启入口**。
- 出口目标由出口节点侧统一维护，支持热更新；修改目标池不得要求重建整条隧道。
- 入口端口是用户可见端口；出口端口是节点间内部通信端口。
- 心跳超时只标记离线，不自动迁移用户隧道。
- 节点删除/失效不得物理删除用户隧道数据，应进入可解释的暂停/错误状态。
- UDP、WS/TLS、QUIC、高级负载均衡、多跳、DNS 等均在 TCP RELAY 稳定后独立验收，不得因枚举存在就宣称支持。
- 工单、返佣、支付扩展、隧道链等不进入当前 v3 主路径。

### 1.2 当前阶段边界

当前 `main` 已经具备并继续保留：

- Workspace / Membership / Invite 多租户底座。
- API、Redis、Socket、Worker 的 workspace 作用域。
- CapabilityPolicy / WorkspacePolicyAssignment / NodeGroupGrant。
- 额度原子判定。
- 邮箱验证、密码重置、限流、CSRF、密钥隔离。
- 当前 Socket.IO + engine 的真实 TCP 配置链路。
- 流量采集、落库、workspace 聚合和 Dashboard 展示。
- CI、生产 Compose、Caddy、备份/恢复/回滚工具。
- 团队自定义角色基础能力。

这些属于 **现有底座**，不是 v3 要重新实现的内容。除阻断性 bug、安全问题和 v3 依赖外，不再单独扩展旧架构。

---

## 2. v3 总体架构

### 2.1 角色与运行绑定

`NodeGroup` 与 `Node` 的语义必须分开：

- **NodeGroup**：授权、调度候选池、展示分组和兼容旧配置 room。
- **Node**：真正运行隧道的物理实例。
- **Node.role**：节点能力的最终真相源。
- `NodeGroup.node_type` 只作为 legacy 兼容字段，v3 新逻辑不得把它作为最终方向判定。

Tunnel 必须持久化实际运行节点：

```text
Tunnel
├─ in_node_group_id      # 候选组/授权组
├─ ingress_node_id       # 实际入口节点
├─ egress_node_id        # RELAY 实际出口节点；DIRECT 为 null
├─ tunnel_mode           # direct | relay
├─ ingress_port
├─ egress_port
├─ desired_status
├─ apply_status
├─ config_revision
└─ apply_error
```

**禁止只保存 NodeGroup、不保存实际 ingress Node。** 否则组内多个 Agent 重启时无法判断隧道真正属于谁。

### 2.2 出口目标模型

保留 v3map“目标池属于出口节点”的语义，但增加轻量 `EgressPool` 层，避免一台出口节点永远只能服务一个业务目标集合：

```text
Node (egress/both)
└─ EgressPool
   └─ EgressTarget[]
```

规则：

- 每个出口 Node 自动拥有一个 `default` pool，初期 UI 可以完全隐藏 Pool 概念。
- Tunnel RELAY 指向 `egress_pool_id`。
- `EgressTarget` 包含 host、port、weight、order、status。
- 目标修改只更新 EgressManager 的目标快照，不重建监听。
- 第一版负载均衡支持 `round / rand / weighted_round`；其余高级策略后置。
- 任何时刻至少保留一个 active 且 weight > 0 的目标，否则拒绝应用新目标快照。

### 2.3 数据平面

第一阶段 v3 只新增 **TCP RELAY**，不同时重写已经可用的 DIRECT。

```text
现有 DIRECT:
Client → current engine → target

v3 RELAY:
Client → Ingress RelayForwarder
       → Egress EgressForwarder
       → EgressPool / Targets
```

原因：先验证新增架构，不把 RELAY 上线和 DIRECT 重写绑定为同一次高风险迁移。

RELAY 稳定后再单独执行 DIRECT v3 化，最终统一到同一 TunnelManager / Forwarder 模型。

---

## 3. 控制平面：期望状态 + 出站长连接 + ACK

### 3.1 默认不开放公网 Agent 管理端口

TuneX 的核心约束是私网 Agent **只需出站连接控制面**。因此 v3 默认控制链路不得要求：

```text
Panel → Agent公网IP:9090
```

Agent 可以保留本机/私网调试 HTTP API，但它不是生产默认控制通道。

生产控制平面采用 Agent 主动建立的持久连接。初期可以复用当前 Socket.IO 传输，逐步升级成独立的 `tunex-v3` 结构化命令协议；以后是否替换为原生 WebSocket/mTLS，不影响命令语义。

### 3.2 命令协议

所有变更必须使用结构化命令，不再以“整份配置是否恰好变化”作为唯一一致性机制。

最小 envelope：

```json
{
  "command_id": "uuid",
  "resource": "tunnel",
  "resource_id": 123,
  "revision": 17,
  "action": "apply",
  "expires_at": 1790000000,
  "payload": {}
}
```

Agent ACK：

```json
{
  "command_id": "uuid",
  "resource_id": 123,
  "applied_revision": 17,
  "status": "applied",
  "error_code": null,
  "error": null
}
```

硬规则：

- incoming revision < applied revision：拒绝 stale。
- incoming revision == applied revision：幂等 ACK，不重复重建。
- incoming revision > applied revision：原子应用后 ACK。
- 配置失败必须返回结构化错误码。
- 断线重连后由控制面按 desired state + revision 补偿，不依赖“最后一次 emit 是否成功”。

### 3.3 节点身份

每个节点必须有独立 credential。服务端从 credential 得出 node identity，**不得使用一个全局 token 后再相信 body 自报 node_id**。

节点凭据必须：

- 可撤销、可轮换。
- 与 Node / Workspace 绑定。
- 不明文写日志。
- 不从用户请求传入的 node_id 推断身份。
- 后续可平滑升级为 mTLS。

---

## 4. 状态机与编排

### 4.1 Tunnel 是期望状态，不是一次 HTTP 操作

禁止采用“DB 先写 active → 下发失败就物理删除 tunnel”的模式。

建议状态：

```text
desired_status:
  active | inactive

apply_status:
  pending
  applying
  active
  error
  suspended
```

必要字段：

- `config_revision`：控制面期望版本。
- `applied_revision`：最近确认已应用版本（可由运行状态表维护）。
- `apply_error_code` / `apply_error`。
- `last_applied_at`。
- `ingress_node_id` / `egress_node_id`。

失败时保留 Tunnel，前端展示原因并允许 Retry。

### 4.2 RELAY 编排铁律

创建或恢复 RELAY：

1. 完成 DB 校验与额度事务。
2. 绑定 ingress / egress Node。
3. 申请并持久化端口占用。
4. 生成 revision N。
5. 向 Egress 发送 apply，等待 ACK N。
6. Egress 成功后向 Ingress 发送 apply，等待 ACK N。
7. 两端均成功后 `apply_status=active`。
8. 任一步失败进入 `error`，执行补偿，但不删除业务记录。

修改出口：

1. 准备新 Egress。
2. 新 Egress ACK。
3. 更新 Ingress next-hop。
4. Ingress ACK。
5. 撤旧 Egress。
6. 释放旧端口。

目标池热更新只更新 Egress target snapshot，不重建 ingress listener。

### 4.3 Reconciler

新增控制面 reconciler，周期对比：

```text
DB desired state
vs
Agent reported/applied state
vs
Port ownership
```

Reconciler 只做幂等修复和告警，不擅自迁移节点。

---

## 5. 端口所有权

### 5.1 单一物理端口只能有一个 owner

旧方案按 ingress / egress 分 Redis namespace 会让 BOTH 节点同端口双绑。v3 禁止这样设计。

物理唯一键必须等价于：

```text
(node_id, port) UNIQUE
```

方向只是 lease 元数据：

```text
NodePortLease
├─ node_id
├─ port
├─ tunnel_id
├─ kind        # ingress | egress
└─ status
```

数据库以 `UNIQUE(node_id, port)` 提供最终一致性保证；Redis NX 只用于快速并发抢占/短事务协调，不作为长期唯一真相源。

### 5.2 旧 allocator 的迁移边界

- 存量 Socket.IO DIRECT 保持现有端口，不强行重排。
- v3 开始的所有新物理端口统一进入 NodePortLease。
- `socket/port-allocator.ts` 只做 legacy 兼容，不能继续为 v3 新资源独立创造另一套所有权。
- 黑名单在 API 校验和分配服务两层验证。
- Agent 上报 active ports，用于对账，不作为端口归属真相源。

---

## 6. Schema 迁移原则

所有 v3 数据库改动采用 **expand-and-contract**：

1. 只新增兼容字段/表。
2. 回填。
3. 新代码双读/必要时双写。
4. 灰度切换。
5. 稳定一个发布周期后再停止旧写路径。
6. 最后才讨论清理 legacy 字段。

生产回滚默认：

```text
关闭 v3 feature flag
→ 回滚 Backend/Web/Agent 镜像
→ 保留新增 schema
→ 存量 DIRECT 继续运行
```

**禁止把“DROP 新列/逆迁移数据库”作为普通代码回滚的前置条件。**

---

## 7. 并行开发执行矩阵

> **本节是强制开发编排规则。**
>
> TuneX v3 不采用“全团队 Step N 做完才能开始 Step N+1”的单线程模式。后续采用：
>
> **契约先冻结 → 多工作流并行开发 → 依赖门控合并 → 集成 Gate 验收。**
>
> Step 编号继续保留，但它表示 **Work Package（WP，工作包）ID**，不是全团队唯一执行游标。
>
> 核心原则：
>
> - **可以并行开发，不代表可以无依赖合并。**
> - 每个 WP 只对自己的范围负责。
> - 依赖未满足时，PR 可以提前开发、提前评审，但必须标记 blocked，不得合入 main。
> - 合并前必须基于最新 main rebase/merge-base 校验，并重新跑完整 CI。
> - 任何共享契约一旦冻结，修改它必须显式通知所有依赖 Track，并更新本文件。

### 7.1 四条长期并行 Track

TuneX v3 团队按以下 Track 并行推进：

| Track | 负责范围 | 主要目录 |
|---|---|---|
| **Track A — Data / Backend Foundation** | Schema、迁移、端口所有权、基础服务 | `backend/prisma`、`backend/src/services` |
| **Track B — Agent / Data Plane** | Agent runtime、RELAY、协议执行、运行态 | `agent/` |
| **Track C — Control Plane / API** | 控制协议、节点会话、编排、Reconciler、API | `backend/src/socket`、`backend/src/routes`、相关 services |
| **Track D — Web / QA / Release** | 管理端/用户端 UI、E2E、灰度、发布验收 | `web/`、`scripts/`、CI、reports |

同一时间允许多个 Track 活跃，只要满足依赖矩阵。

---

### 7.2 Work Package 依赖矩阵

| WP | 工作包 | Track | 可以开始开发 | 可以合并 main |
|---|---|---|---|---|
| WP0 | 架构/文档冻结 | Shared | 已完成 | ✅ 已完成 |
| WP1 | v3 Schema 契约 | A | WP0 | ✅ 已完成（分支 `feature/v3-wp1-schema` 已 push，CI 全绿） |
| WP2 | Legacy Backfill / Upgrade | A | WP1 schema 设计冻结后 | **WP1 已合并** |
| WP3 | NodePortLease / Port Allocator | A/C | WP1 schema 设计冻结后 | **WP1 已合并** |
| WP4 | Agent v3 Runtime 骨架 | B | WP0；不依赖 DB 实现 | WP1 已合并或确认无 schema 耦合 |
| WP5 | TCP RELAY Data Plane | B | **WP4 接口冻结** | **WP4 已合并** |
| WP6 | v3 Command / Revision / ACK 协议 | B/C | WP0；协议字段冻结即可 | WP1 已合并；WP4 接口兼容 |
| WP7 | Node Credential / Session / State Report | B/C | WP6 协议冻结 | WP6 已合并 |
| WP8 | Scheduler + RELAY Orchestrator | C | WP3/WP5/WP6 接口冻结后 | **WP2 + WP3 + WP5 + WP7 已合并** |
| WP9 | Reconciler / Retry / Recovery | C | WP8 接口冻结 | WP8 已合并 |
| WP10 | Admin Node / Egress API | C | WP1；credential 部分等 WP7 | WP7 已合并 |
| WP11 | Tunnel RELAY API | C | WP8 API/service contract 冻结 | **WP8 + WP9 已合并** |
| WP12 | Admin Web | D | WP10 API contract 冻结后，可先 mock | WP10 已合并 |
| WP13 | Tunnel Web | D | WP11 API contract 冻结后，可先 mock | WP11 已合并 |
| WP14 | Real E2E / Grey Release | D/Shared | 测试环境可提前搭建 | **WP5 + WP7 + WP8 + WP9 + WP10 + WP11 + WP12 + WP13 已合并** |
| WP15 | DIRECT v3 Migration | B/C | WP14 验收方案冻结 | WP14 验收通过 |
| WP16+ | UDP / WS/TLS / QUIC / Advanced | 多 Track | WP14 后按独立 RFC/contract | 各自前置 Gate 通过 |

**重要：** “可以开始开发”是允许团队成员创建分支、写代码、开 Draft PR；“可以合并 main”才是硬门槛。

---

### 7.3 当前并行开发窗口

WP1 已完成（见 §7.4 交付记录）。当前同步窗口为：

WP1 合并后立即扩展并行窗口到 **WP2 + WP3**，B/C Track 继续推进：

#### Track A
`feature/v3-wp2-legacy-backfill`（WP2）、`feature/v3-wp3-port-lease`（WP3）

依赖已满足（WP1 已合并）。注意：

- WP2 只能做**确定性**回填，不得猜测 Node.role（WP1 的 `role` 列可空正是为此留的）。
- WP3 的端口所有权以 `NodePortLease.UNIQUE(node_id, port)` 为最终真相，
  Redis NX 抢占锁统一取 `RedisKeys.portLeaseLock`（见 `src/tenant-scope.ts`）。

#### Track B
`feature/v3-wp4-agent-runtime`

WP1 已合并，Prisma 类型已生成，可按最终字段开发；仍需满足：

- 不依赖未落库的具体 Prisma 字段。
- 不改 legacy DIRECT 行为。
- runtime interface 使用 v3map / DEVELOPMENT 已冻结的语义。

#### Track C
`feature/v3-wp6-control-contract`

可以同步定义：

- command envelope；
- revision 语义；
- ACK/error contract；
- transport-agnostic types/tests。

但暂不实现最终 orchestrator，不要求 Panel 主动连 Agent。

#### Track D
`test/v3-wp14-e2e-harness`

可以提前搭建不依赖功能实现的测试基础设施：

- 三机拓扑脚本；
- Target A/B 测试服务；
- NAT/仅出站 Agent 场景；
- 日志/指标采集；
- E2E fixture。

该分支不得伪造“功能已通过”，只交付测试 harness。

**当前建议团队分工：**

```text
开发者 A → WP2 Legacy Backfill → WP3 NodePortLease / Port Allocator
开发者 B → WP4 Agent v3 Runtime（WP5 依赖它）
开发者 C → WP6 Control / Revision / ACK 协议 → WP7 Node Credential
开发者 D → WP14 E2E Harness / QA infrastructure
```

WP1 已合并（见 §7.4），WP2 + WP3 已解锁；WP5 已实现待合入（§7.8），WP7/WP8 的合并门槛不变。

> 注：本节措辞里的「已合并」指代码已交付并 CI 全绿。WP1 尚未由 maintainer
> 合入 `main`——本仓库的 PAT 无建 PR 权限，需在 Web 端开
> `feature/v3-wp1-schema → main` 的 PR。合入前 WP2/WP3 的 PR 可以开发评审，
> 但按 §7.2 的硬门槛不得合入 main。

---

### 7.4 WP1 — v3 Schema 契约

**Track：A**

目标：一次定清后续所有模块依赖的数据结构。

必须包含：

- Node.role = ingress / egress / both
- per-node credential 所需字段
- Tunnel.tunnel_mode
- Tunnel.ingress_node_id
- Tunnel.egress_node_id
- Tunnel.egress_pool_id
- Tunnel.ingress_port / egress_port
- desired/apply 状态
- config_revision / applied_revision
- apply_error_code / apply_error / last_applied_at
- EgressPool
- EgressTarget
- NodePortLease
- `UNIQUE(node_id, port)`

只做 additive migration，不删除 legacy 字段，不改变现有 DIRECT runtime。

**已决定项（契约，后续模块不得偏离）：**

- 三张新表与 Node/Tunnel 的 v3 增量列**全部可空**或随新表新建，无一处
  `MODIFY` 旧列，因此 §6 的回滚路径（保留新增 schema，回滚镜像）成立。
- `Node.role` 可空且**不回填**：存量角色不可确定性推断，`role === null` 表示
  「尚未声明」，v3 代码不得把它默认成 ingress。WP2 同样禁止猜 BOTH。
- `NodePortLease` 的 `UNIQUE(node_id, port)` 是端口所有权唯一真相，
  `lease_type` 只是元数据（否则 BOTH 节点同端口双绑）。Redis NX 抢占锁只是
  短事务协调（见 `tenant-scope.ts` 的 `portLeaseLockKey` 使用约束）。
- 新表**不冗余 `workspace_id`**：归属沿 `Node → node_group → workspace_id`
  单向上查，DB 里只存一份归属真相；scope 统一经 `nodeScope()` 派生。
- `Tunnel.remote_host / remote_port` 由存量 `forward_addresses[0]` 幂等回填
  （字符串数组 / 对象数组两种历史形态；解析不出即留 NULL，不写 0 端口）。
  RELAY 隧道不填这两列——目标在 `EgressTarget` 上。
- `desired_status / apply_status` 用 `VARCHAR(20)` 而非枚举：DB 列先落地，
  应用层状态机（§4.1 的 pending/applying/active/error/suspended）随 WP8 编排器
  一起收敛，避免现在加枚举、WP8 又要 `ALTER` 改它。

DoD：

- empty DB migrate；✅（迁移 `20260926040000_v3_schema_contract` 在空库全量通过）
- Prisma generate；✅
- backend typecheck；✅（`tsc --noEmit`，0 error）
- schema review；✅（下方评审记录）
- full CI green。⏳ 等 push 后的 CI 验证

**已知留白（有意，非缺口）：**

- `per-node credential` 字段（§7.4 要求）由 **WP7** 落地：本包只冻结了
  credential 的**作用域语义**（`nodeRegisterBlockKey` 走 global 段，
  因为防爆破发生在身份解析之前）。建列等 WP7 的 schema 一起，避免现在加一列
  没人写、也没法验证。
- `ingress_node_id / ingress_port` 没有新增列：`tunnel.in_node_group_id` +
  `tunnel.listen_port` 已是既有的等价物（入口组授权 + 用户可见端口）。
  但 §2.1「禁止只保存 NodeGroup、不保存实际 ingress Node」的**实际入口节点**
  仍未落列——它属于 WP8 Scheduler 的产出，WP1 只加 `egress_node_id`
  （RELAY 必需的出口侧）。这一条必须在 WP8 schema 设计时补齐，不能沿用
  NodeGroup 顶替。

**Schema review 记录（WP1 自查，逐条对着 §2.1/§2.2/§4.1/§5.1 核过）：**

| 审查项 | 结论 |
|---|---|
| `Node.role` 是节点能力最终真相源（§2.1） | ✅ 新增可空枚举列 + 索引；NodeGroup.node_type 保持 legacy 不动 |
| 只保存 NodeGroup、不保存实际 ingress Node 的禁令 | ⚠️ `egress_node_id` 已落；`ingress_node_id` 属 WP8（见上「已知留白」） |
| `EgressPool → EgressTarget[]` 层级（§2.2） | ✅ 新表 + `UNIQUE(node_id, name)`（每节点含自动 `default` 池唯一） |
| 目标热更新不重建隧道（§2.2） | ✅ 池无 revision 列，版本由 `Tunnel.config_revision` 驱动 |
| 至少一个 active 且 weight>0 的目标才允许应用（§2.2） | ✅ 应用层不变式（schema 注释已标注），不在 DB 层强约束 |
| Tunnel 是期望状态而非一次 HTTP 操作（§4.1） | ✅ desired/apply/revision/error 全套落列；失败不删记录 |
| 单物理端口一个 owner（§5.1） | ✅ `UNIQUE(node_id, port)`，方向只是元数据；实测同节点同端口不同方向的插入被拒 |
| 删节点不物理删用户隧道（v3 铁律） | ✅ `tunnel_egress_node_id` / `tunnel_egress_pool_id` 均 `ON DELETE SET NULL`；实测删节点后隧道行保留、指针置 NULL |
| expand-and-contract（§6） | ✅ 迁移内零 `DROP`、零 `MODIFY` 旧列；回滚只需回滚镜像 |
| 存量 DIRECT 零影响（§7.5） | ✅ 只加列/表/索引；配置生成路径（config-generator / port-allocator）未改一行 |

---

### 7.5 WP2 — Legacy Backfill / Upgrade

**Track：A，可与 WP3/WP4/WP6 并行。**

目标：证明现有数据库升级不破坏 DIRECT。

必须验证：

- 存量 Tunnel → direct；
- tunnel 数量不变；
- listen port 不变；
- forward_addresses 不变；
- workspace/user/policy 关系不变；
- Node.role 只能做确定性回填，不能猜 BOTH；
- 旧 Agent 仍能获取 legacy config。

DoD：empty DB + legacy fixture + v3 upgrade fixture 全部通过。

---

### 7.6 WP3 — NodePortLease / Port Allocator

**Track：A/C，可与 WP2/WP4/WP6 并行。**

DB `UNIQUE(node_id, port)` 是最终真相；Redis NX 只做并发协调。

必须实现：

- acquire / release / holder / reconcile；
- ingress/egress 共用同一物理 namespace；
- BOTH Node 同 port 冲突；
- legacy DIRECT port 不可被抢占；
- user-specified port 与 auto port 走同一规则。

DoD：

- 并发分配无重复；
- Redis 丢锁后 DB unique 兜底；
- orphan lease 可 reconcile；
- 完整 backend tests。

---

### 7.7 WP4 — Agent v3 Runtime 骨架

**Track：B，可与 WP1/WP6 并行开发。**

建立：

- Forwarder interface
- TunnelManager
- EgressManager
- local port guard
- revision state interface
- graceful stop

禁止：

- 不改 legacy engine；
- 不接最终 Panel orchestration；
- 不实现 Web/API。

DoD：Go 单测覆盖 start/stop/idempotency/concurrency/stale revision state。

---

### 7.8 WP5 — TCP RELAY Data Plane

**Track：B；依赖 WP4。**

实现：

```text
Client
→ Ingress RelayForwarder
→ Egress EgressForwarder
→ Target Pool
```

首批策略：

- round
- rand
- weighted_round

必须支持 Target snapshot 热更新而不中断 listener。

DoD：

- 真实 TCP 双进程测试；
- 双向大/小流量；
- disconnect cleanup；
- target fail 可观测；
- hot update；
- BOTH port conflict；
- 无 goroutine 泄漏。

**状态：✅ 已实现（待合入 main，见分支 `feature/v3-wp5-tcp-relay`）。**

落地要点（`agent/internal/`）：

- `forwarder/relay.go` — `RelayForwarder` 监听 `ingressPort` 并转发到 `nextHop`；
  每连接独立 byte 计数，连接结束即结算（disconnect cleanup 的计量口径）。
- `forwarder/egress.go` — `EgressForwarder` 监听 `egressPort`，从 selector 选 target
  后 dial；dial 成功/失败、延迟、异常文案都记入 target 账本（target fail 可观测），
  每连接字节数也归属到具体 target。wrapper conn 转发 `CloseWrite/SetDeadline`
  等可选接口，保证 TCP 半关闭语义不被计量层破坏。
- `forwarder/pipe.go` — 双向 copy，up-front 选定向账本计数器，连接对共享一个计数器。
- `forwarder/interface.go` — `LBStrategy` 解析同时接受长枚举名与面板小写拼写
  （`round` / `rand` / `weighted_round` 等）。
- `manager/lb.go` — `round` / `rand` / `weighted_round` 三种策略；
  加权用「权重 slots 预展开」，上限 1024，避免超大权重占用内存；
  `UpdateTargets` / `SetPool` 只换 balancer，不重启 listener。
- `manager/egress.go` / `manager/tunnel.go` — Egress/Tunnel 管理，`TargetStats`
  桥接到 forwarder 账本；WP4 同端口替换 bug 已修（bind 自身为权威校验）。
- `api/server.go` — `PATCH /node/targets` 热更新入口已接入。

测试（`go test` 全绿，`-race` 通过）：

- `internal/forwarder/forwarder_test.go` — 单 forwarder 行为（含 Stats 轮询到精确总量，
  修掉历史 flaky 断言）。
- `internal/manager/lb_test.go` — 三种策略、别名解析、权重上限、并发安全性单测。
- `internal/manager/dataplane_test.go` — 真实 TCP 双进程端到端：双向大/小流量、
  disconnect cleanup、target fail 可观测 + 恢复、hot update 不重启 listener、
  BOTH 端口冲突双向拒绝。

---

### 7.9 WP6 — Command / Revision / ACK Contract

**Track：B/C，可与 WP1/WP4 并行。**

统一命令：

- apply_tunnel
- remove_tunnel
- update_targets
- suspend_tunnel
- state_request
- command_ack

统一字段：

- command_id
- resource/resource_id
- revision
- action
- expires_at
- payload
- applied_revision
- status
- error_code/error

硬规则：

- stale revision reject；
- equal revision idempotent ACK；
- newer revision atomic apply；
- expired command reject。

控制 transport 仍由 Agent 主动出站，不引入公网 Agent HTTP 管理依赖。

---

### 7.10 WP7 — Node Credential / Session / State Report

**Track：B/C；依赖 WP6。**

状态：**已实现，待 CI 验证**（分支 `feature/v3-wp7-node-credential`）。

实现：

- per-node credential；
- hash at rest；
- rotate / revoke；
- server-side node identity；
- state report；
- reconnect snapshot。

落地位置（单一事实源，改动前先读这几处）：

- `backend/src/services/node-credential.ts` —— 签发 / 校验 / 轮换 / 撤销，
  以及 `authenticateNode`（server-side node identity）。**hash at rest**：
  DB 只存 `sha256(明文)` hex（`CHAR(64)` 唯一列），明文只在 issue/rotate
  的响应体出现一次。不回落 `node_group.token`（组 token 冒充组内任意节点
  的口子就是这么来的）。
- `backend/src/services/node-state.ts` —— 上报校验 + upsert（每节点一行，
  `NodeStateReport @@unique([node_id])`）+ `buildReconnectSnapshot`。
- `backend/src/routes/internal-node.ts` —— `POST /api/internal/node/state`、
  `GET /api/internal/node/snapshot`，Bearer 节点凭据，校验规则与 CSRF /
  认证 / 限流豁免**四处同步**（auth.ts、csrf.ts、rate-limit.ts、本文件）。
- `backend/src/routes/admin.ts` —— `/api/admin/node/:id/credential[/rotate|/revoke]`，
  明文唯一出口。
- `backend/prisma/migrations/20260925120000_node_credential` —— 纯
  expand-and-contract：`node` 加四个可空/默认列 + 新表 `node_state_report`。
- `agent/internal/reporter/heartbeat.go` + `agent/v3runtime.go` —— Agent 侧
  上报（`--node-credential` / `NODE_CREDENTIAL`）；没有凭据的节点保持旧
  heartbeat 形态不变。

DoD（每条都有对应单测，见 `backend/src/services/__tests__/node-credential.test.ts`）：

- A token 不能冒充 B —— 认证按哈希唯一列等值查找，命中行即身份；
- revoked token 不能重连 —— `credential_revoked` 优先级高于哈希比对；
  撤销保留哈希，面板才能把「撤销」和「瞎猜」区分开（清哈希会把所有
  失败压成 `invalid_credential`，管理员无从判断要不要人工介入）。想彻底
  抹掉一把钥匙 → rotate；
- rotate 后旧 token 失效 —— rotate 覆盖哈希列，旧 sha256 立即查不到；
- token 不写日志 —— 服务层零 console；Redis 防爆破键也是哈希；
  `services/audit.ts` 的 `SENSITIVE_RE` 命中 *credential* 会丢 metadata；
- NAT Agent 只靠出站连接工作 —— 上报由 Agent POST 上来，下发走 Socket.IO，
  服务层不 import 任何传输层（单测静态断言）。

---

### 7.11 WP8 — Scheduler + RELAY Orchestrator

**Track：C；集成型工作包。**

开发可以在 WP3/WP5/WP7 接口冻结后提前开始，但**不得在这些依赖合并前进入 main**。

创建顺序固定：

```text
auth/quota
→ desired Tunnel=pending
→ bind ingress/egress Node
→ acquire ports
→ revision++
→ apply Egress
→ Egress ACK
→ apply Ingress
→ Ingress ACK
→ active
```

任何失败：

- 保留 Tunnel；
- apply_status=error；
- 写结构化错误；
- 执行补偿；
- 不物理删除。

---

### 7.12 WP9 — Reconciler / Retry / Recovery

**Track：C；依赖 WP8。**

对比：

- DB desired state
- config revision
- Agent applied state
- NodePortLease
- Node online state

只允许自动：

- 重发相同 desired revision；
- 补齐缺失 runtime；
- 清理确认无主 lease；
- 记录 error/warning。

默认禁止自动：

- 换 Node；
- 换端口；
- 迁移用户 Tunnel；
- 心跳超时即删除资源。

---

### 7.13 WP10 / WP11 — API Track

**Track：C。**

#### WP10 Admin API

可以在 WP1 合并后较早开始：

- Node role；
- credential rotate/revoke；
- EgressPool / EgressTarget CRUD；
- runtime/state query。

credential 相关 endpoint 的合并依赖 WP7。

#### WP11 Tunnel RELAY API

依赖 WP8/WP9：

- DIRECT / RELAY mode；
- explicit ingress；
- egress/pool；
- retry/suspend/resume/delete；
- 所有运行操作统一走 orchestrator。

禁止 route 自己写第二套下发逻辑。

---

### 7.14 WP12 / WP13 — Web Track

**Track：D。**

Frontend **允许在后端实现未完成时提前并行开发**，条件是使用已经冻结的 API contract + mock。

#### WP12 Admin Web

- Node role；
- credential state；
- Egress Pool/Target；
- runtime diagnostics。

可在 WP10 contract freeze 后开始，合并依赖 WP10。

#### WP13 Tunnel Web

- DIRECT / RELAY；
- ingress / egress；
- pool；
- pending/applying/active/error/suspended；
- retry；
- runtime binding/port。

可在 WP11 contract freeze 后开始，合并依赖 WP11。

**前端不得自己发明字段或临时 API。** Contract 改动必须回到对应 Backend WP。

---

### 7.15 WP14 — Real E2E / Grey Release

**Track：D/Shared。**

测试 harness 可以从当前阶段提前并行开发；正式验收必须等待所有核心 WP 合入。

最低拓扑：

```text
Control Plane
Ingress Agent
Egress Agent
Target A
Target B
```

至少一个 Agent 必须位于 NAT/私网，仅可主动出站。

正式 Gate 必测：

- legacy DIRECT no regression；
- TCP RELAY；
- Egress-before-Ingress；
- weighted target；
- hot update；
- Agent restart；
- control reconnect；
- Panel restart；
- stale revision；
- credential revoke；
- port conflict/exhaustion；
- workspace isolation；
- BOTH Node；
- suspend/resume；
- change Egress；
- backup/restore；
- old Agent compatibility。

只有 WP14 通过后，relay 才允许从白名单灰度扩大。

---

### 7.16 WP15 — DIRECT v3 Migration

**Track：B/C；依赖 WP14。**

迁移顺序：

1. 新建 DIRECT 可选择 v3 runtime，flag 默认关闭。
2. 对照 legacy DIRECT。
3. 灰度新 DIRECT。
4. legacy allocator 不再负责新 Tunnel。
5. 分批迁移存量 DIRECT。
6. 稳定一个发布周期。
7. 最后才删除 legacy path。

禁止为了回滚方便做 destructive DB downgrade。

---

### 7.17 WP16+ — 后续协议与高级能力

WP14 之后按独立工作包继续并行，但每个能力必须自己走：

```text
contract
→ implementation
→ tests
→ real E2E
→ feature flag
→ grey release
→ stable
```

优先顺序仍为：

1. UDP
2. WS/TLS
3. QUIC
4. advanced LB
5. DNS
6. multi-ingress HA
7. automatic failover
8. multi-hop

同一底层模块冲突严重的能力不得强行并行。

---

### 7.18 PR / Branch 并行规则

推荐命名：

```text
feature/v3-wp1-schema
feature/v3-wp2-backfill
feature/v3-wp3-port-lease
feature/v3-wp4-agent-runtime
feature/v3-wp5-relay-dataplane
feature/v3-wp6-control-contract
feature/v3-wp7-node-session
feature/v3-wp8-orchestrator
feature/v3-wp9-reconciler
feature/v3-wp10-admin-api
feature/v3-wp11-tunnel-api
feature/v3-wp12-admin-web
feature/v3-wp13-tunnel-web
test/v3-wp14-e2e-harness
```

PR 必须写：

```text
Work Package: WPx
Track: A/B/C/D
Depends-On: WP...
Blocks: WP...
Contract Changes: yes/no
Runtime Changes: yes/no
Migration Impact:
Rollback:
Tests:
```

如果依赖未合并：

- PR 标记 Draft 或 blocked；
- 可以 review；
- 可以跑自己的 CI；
- **不能 merge**。

依赖合并后：

1. 更新到最新 main；
2. 解决 contract drift；
3. 重跑完整 CI；
4. review 依赖是否已满足；
5. 才能 merge。

---

### 7.19 Integration Gate，而不是“单一游标”

项目不再维护“全团队唯一当前 Step”，改为维护 **Integration Gate + Active WP Set**。

Gate 定义：

```text
Gate F0  文档/架构冻结                 ✅
Gate F1  Schema Contract merged         ⏳
Gate F2  Runtime Foundations merged     ⏳
Gate F3  RELAY Control Plane integrated ⏳
Gate F4  API/Web integrated             ⏳
Gate F5  Real E2E passed                ⏳
Gate F6  DIRECT v3 migrated             ⏳
```

当前：

```text
Active WP:
- WP1 Schema
- WP4 Agent Runtime（可并行，受 WP1 merge gate 约束）
- WP6 Control Contract（可并行，受 WP1/WP4 compatibility gate 约束）
- WP14 E2E Harness（仅测试基础设施）

Next unlock after Gate F1:
- WP2 Backfill
- WP3 Port Lease
- WP10 Admin API foundation
```

这就是后续团队开发的统一并行模型。


---

## 8. 开发硬规则

### 8.1 一个 PR 只做一个 Work Package

- 团队可以同时开发多个 WP，但**单个 PR 只能属于一个 WP**。
- 禁止在 WP3 PR 顺手开发 WP12 UI，也禁止在 WP6 PR 顺手实现 WP8 orchestrator。
- 跨 Track 的共享 contract 改动必须单独说明影响面。
- blocker 修复可以跨 WP，但必须是独立 PR，并标明受影响 WP。
- 并行开发以“低耦合”为前提；如果两个 PR 长期修改同一核心文件，应重新拆接口，而不是靠反复解决冲突维持并行。

### 8.2 Schema 优先且只做兼容迁移

- 先 schema / migration，再服务层，再 API/UI。
- 生产字段删除必须独立 PR。
- migration 必须测试空库 + 升级库。

### 8.3 单一真相源

- 节点能力：`Node.role`。
- 实际运行位置：`Tunnel.ingress_node_id / egress_node_id`。
- 端口归属：`NodePortLease`。
- 授权：Workspace RBAC + CapabilityPolicy + NodeGroupGrant。
- 期望运行态：Tunnel desired state + revision。
- Agent 当前态：ACK/state report。

禁止新增第二套互相推断的事实源。

### 8.4 安全默认

- 新能力默认关闭 feature flag。
- 私网 Agent 默认不要求入站端口。
- Credential 每节点独立。
- 日志不写 token、完整目标凭据或敏感 payload。
- 跨租户负面测试与正常功能测试同等重要。
- 支付保持可选、默认关闭，不进入核心授权判断。

### 8.5 兼容优先

- v3 第一阶段不重写现有 DIRECT。
- 新协议不能静默改变旧 Agent 行为。
- 不依赖数据库逆迁移完成代码回滚。
- 任何 legacy 字段删除都发生在“停止读 → 停止写 → 观察 → 删除”的最后一步。

---

## 9. CI 与发布门槛

任何 v3 PR 至少满足受影响范围的全部检查；合入主线的阶段性 PR 必须整套 CI 全绿：

### Backend

- Prisma migrate（空库）
- legacy upgrade fixture
- Prisma generate
- TypeScript typecheck
- Bun tests
- workspace / auth / policy / v3 negative tests

### Web

- `npm run typecheck`
- unit tests
- `npm run build`

### Agent

- `go vet ./...`
- `go test ./...`
- `go build ./...`
- Linux amd64 / arm64 release build

### 集成验收

- WP5 起的数据平面能力必须增加真实网络测试，不能只依赖 mock。
- WP14 Real E2E Gate 通过之前，RELAY 不得作为默认公开能力。
- 并行 PR 各自 CI 通过不等于集成完成；跨 Track 能力必须在对应 Integration Gate 再验一次。

---

## 10. 分支、PR 与提交约定

分支名必须与 Work Package 对应，使用第 7 节统一命名，例如：

```text
feature/v3-wp1-schema
feature/v3-wp2-backfill
feature/v3-wp3-port-lease
feature/v3-wp4-agent-runtime
feature/v3-wp5-relay-dataplane
feature/v3-wp6-control-contract
feature/v3-wp7-node-session
feature/v3-wp8-orchestrator
feature/v3-wp9-reconciler
feature/v3-wp10-admin-api
feature/v3-wp11-tunnel-api
feature/v3-wp12-admin-web
feature/v3-wp13-tunnel-web
test/v3-wp14-e2e-harness
```

禁止创建“v3-next”“v3-all”“next-stage”这类把多个 WP 混在一起的总分支。

PR 标题：

```text
feat(v3-wp5): implement TCP relay data plane
```

PR 描述必须包含：

- Work Package / Track。
- Depends-On / Blocks。
- Contract Changes。
- 改动范围与明确未实现范围。
- 数据迁移影响。
- 回滚方式。
- 测试证据。
- 是否改变 v3map 约束；正常情况下答案必须是“否”。

并行 PR 可以同时存在，但只有依赖已经进入 main、分支已经更新到最新 main、完整 CI 重新通过以后才允许合并。

---

## 11. 文档治理

仓库只允许以下几类长期文档：

1. **`DEVELOPMENT.md`**：唯一开发方案和当前执行方向。
2. **`docs/tunex-devmap-v3.md`**：v3 产品/架构约束，不记录执行进度。
3. **`docs/production-deploy.md`**：生产运维手册。
4. **`reports/`**：历史验证/测试证据，不作为未来路线。
5. 局部 README：只说明某个脚本或测试工具的使用方法。

禁止再新增：

- `PLAN*.md`
- `ROADMAP*.md`
- 第二份 migration plan
- 与本文件并行的“下一阶段开发方案”

需要改变方向时，**直接修改本文件并通过 PR 审查**。

---

## 12. 当前开发状态

当前已经进入 **并行开发模式**，不再使用单一 Step 游标。

### 当前 Integration Gate

```text
Gate F0  文档/架构冻结                 ✅
Gate F1  Schema Contract merged         ⏳ 当前关键 Gate
Gate F2  Runtime Foundations merged     ⏳
Gate F3  RELAY Control Plane integrated ⏳
Gate F4  API/Web integrated             ⏳
Gate F5  Real E2E passed                ⏳
Gate F6  DIRECT v3 migrated             ⏳
```

### 当前允许并行启动

```text
Track A: feature/v3-wp1-schema
Track B: feature/v3-wp4-agent-runtime
Track C: feature/v3-wp6-control-contract
Track B/C: feature/v3-wp7-node-credential （WP7，依赖 WP6 已合并）
Track D: test/v3-wp14-e2e-harness
```

其中：

- **WP1 是当前最高优先级合并 Gate**。
- WP4/WP6 可以立即开发和评审，但如果最终依赖 WP1 的 contract，必须等待 WP1 合并、更新到最新 main 后才能合并。
- WP7 依赖 WP6 已合并的 Control Contract；它自己的合并同时解锁 WP8 / WP10。
- WP14 当前只允许建设测试 harness，不得提前宣称 RELAY 验收完成。
- Gate F1 通过后，立即解锁 WP2、WP3、WP10 foundation，并继续保持 Track B/C 并行。

后续开发、分支、PR 和合并判断全部以第 7 节的 **依赖矩阵 + Integration Gate** 为准。
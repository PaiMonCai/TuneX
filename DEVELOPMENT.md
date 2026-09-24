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

## 7. 固定开发执行流水线

> **本节不是建议顺序，而是强制执行顺序。**
>
> 后续所有开发都必须从当前步骤向下推进。除安全漏洞、主支阻断性 bug 外，**Step N 未合并到 main 且 main CI 未全绿，不得开始 Step N+1**。
>
> 每一步都从最新 `main` 新建分支；通过评审和完整 CI 后 squash merge；合并后再创建下一步分支。禁止长期堆积多个相互依赖的未合并功能分支。

### 7.1 总顺序

| Step | 对应阶段 | 目标 | 主要产物 |
|---|---|---|---|
| 0 | S0 | 架构与文档冻结 | 本文件 + v3map 约束 |
| 1 | S1-A | 定义 v3 数据模型 | Prisma schema + additive migration |
| 2 | S1-B | 存量数据回填与升级验证 | legacy fixture + backfill tests |
| 3 | S2 | 统一物理端口所有权 | NodePortLease + allocator service |
| 4 | S3-A | Agent 运行时骨架 | Forwarder / TunnelManager / EgressManager |
| 5 | S3-B | TCP RELAY 数据面 | RelayForwarder / EgressForwarder + 本地网络测试 |
| 6 | S4-A | v3 命令协议 | command envelope + revision + ACK |
| 7 | S4-B | 节点身份与重连 | per-node credential + state report + replay |
| 8 | S5-A | 调度与 RELAY 编排 | scheduler + orchestrator |
| 9 | S5-B | Reconciler 与恢复 | retry / reconcile / restart recovery |
| 10 | S6-A | 管理端 Node/Egress API | role / pool / target CRUD |
| 11 | S6-B | 用户 Tunnel API | direct/relay create/update/retry/suspend |
| 12 | S7-A | 管理端 Web | Node role + Egress target UI |
| 13 | S7-B | 用户 Tunnel Web | DIRECT/RELAY UI + runtime state |
| 14 | S8 | 三机真实 E2E 与灰度 | real network acceptance + relay flag |
| 15 | S9 | DIRECT v3 化 | DIRECT 迁入统一 runtime |
| 16+ | S10 | 协议与高级能力 | UDP → WS/TLS → QUIC → advanced LB → DNS → HA → multi-hop |

下面每一步都定义“允许做什么”和“禁止顺手做什么”。

---

### Step 0 — 文档与架构冻结

**状态：✅ 已完成。**

已经完成：

- `DEVELOPMENT.md` 成为唯一开发方案。
- `docs/tunex-devmap-v3.md` 只作为目标约束。
- 删除旧 `PLAN.md` 和旧 migration plan。
- 固化 v3 的关键原则：
  - Node role 是节点能力真相源；
  - Tunnel 持久绑定 ingress / egress Node；
  - 端口物理唯一；
  - desired state + revision + ACK；
  - Agent 主动出站连接控制面；
  - RELAY 先出口后入口；
  - 数据库 expand-and-contract。

**进入 Step 1 的条件：** main CI 全绿。

---

### Step 1 — V3-S1A：只建立 v3 Schema

**建议分支：** `feature/v3-s1a-schema`

**目标：** 先把以后所有模块依赖的数据契约定死，不写业务编排。

#### 只允许修改

- `backend/prisma/schema.prisma`
- 新 Prisma migration
- 必要的 migration fixture 定义
- 与 schema 编译直接相关的类型测试

#### 必须新增

**Node：**

- `role: ingress | egress | both`
- credential hash / credential version / revoked_at（具体字段名可按现有 user-key 设计统一）
- `last_seen_at` 若当前模型没有可靠运行态时间

**Tunnel：**

- `tunnel_mode: direct | relay`
- `ingress_node_id`
- `egress_node_id`
- `egress_pool_id`
- `ingress_port`
- `egress_port`
- `desired_status`
- `apply_status`
- `config_revision`
- `applied_revision`（若决定放运行态表，需在本步一次定型）
- `apply_error_code`
- `apply_error`
- `last_applied_at`

**新增模型：**

- `EgressPool`
- `EgressTarget`
- `NodePortLease`

#### Schema 硬约束

- `NodePortLease @@unique([node_id, port])`
- 一个 `EgressPool` 只能属于一个 Node。
- Tunnel 的 ingress/egress 外键必须能明确恢复实际运行实例。
- DIRECT 允许 `egress_node_id / egress_pool_id / egress_port = null`。
- RELAY 所需字段是否暂时 nullable 由迁移兼容决定，但服务层最终必须校验完整。
- 所有新增列/表都是 additive，不删除旧列，不改旧 DIRECT 的实际行为。

#### 本步禁止

- 不写 Agent。
- 不写 port allocator。
- 不改 Tunnel API 行为。
- 不改 Web。
- 不启用 RELAY。
- 不改现有 DIRECT config-generator。

#### DoD

- 空库 `prisma migrate deploy` 通过。
- `prisma generate` / `tsc --noEmit` 通过。
- migration 不 DROP 任何 legacy 列。
- schema review 明确所有唯一约束与 onDelete 行为。
- main CI 全绿后才能进入 Step 2。

---

### Step 2 — V3-S1B：存量数据回填与升级兼容

**建议分支：** `feature/v3-s1b-backfill`

**目标：** 证明真实旧库能安全升级，而不是只证明空库能创建。

#### 主要工作

- 扩展现有 `tests/fixtures/create-upgrade-db.sql` 或增加专用 v3 legacy fixture。
- 回填存量 Tunnel：
  - `tunnel_mode = direct`
  - 保留原 listen/forward 语义
  - 不凭空指定错误的 ingress Node
- 回填 Node.role：
  - 能根据旧 `NodeGroup.node_type` 唯一确定的才自动映射；
  - 无法确定的保持需要管理员确认的安全状态；
  - 不允许“猜” BOTH。
- 为已有入口监听建立兼容端口占用基线；如果此时不正式写 NodePortLease，则必须留下明确迁移标记供 Step 3 接管。
- 写升级巡检 SQL / 自动测试。

#### 必须验证

升级前后：

- Tunnel 总数相同。
- ACTIVE DIRECT 数量相同。
- 原 listen_port 不变化。
- `forward_addresses` 不变化。
- Workspace / user / policy 外键关系不变化。
- 旧 Agent 继续能读到旧配置。

#### 本步禁止

- 不让新字段参与运行时选择。
- 不切控制通道。
- 不开始 RELAY。

#### DoD

至少同时通过：

1. 空库 migrate；
2. 当前 CI legacy fixture migrate；
3. v3 特殊 legacy fixture migrate；
4. upgrade verification script；
5. 完整 backend tests。

通过后，**v3 schema 才算真正成立**。

---

### Step 3 — V3-S2：统一物理端口所有权

**建议分支：** `feature/v3-s2-port-lease`

**目标：** 在任何 RELAY 代码出现之前，先解决“哪个 Node 的哪个端口属于谁”。

#### 实现

新增类似：

`backend/src/services/node-port-lease.ts`

核心 API 应保持小而稳定：

- `acquire(nodeId, tunnelId, kind, range, preferred?)`
- `release(...)`
- `renew/reserve(...)`
- `holder(nodeId, port)`
- `reconcile(...)`

#### 一致性规则

- DB `UNIQUE(node_id, port)` 是最终真相。
- Redis NX 用于并发优化，不替代 DB 唯一约束。
- ingress 与 egress **不能分物理 namespace**。
- BOTH Node 的同一 port 永远只能有一个 listener owner。
- 用户指定端口和自动分配端口必须走同一服务。
- PORT_BLACKLIST 统一定义，API 与 service 双重检查。

#### 存量处理

- 已运行的 legacy DIRECT 端口不能被新分配器抢占。
- 可以通过初始化 lease、legacy reservation 或查询兼容层实现，但最终不能存在两个 allocator 都认为自己有分配权。

#### 测试

- 100+ 并发申请同一小区间不重复。
- Redis 丢锁时 DB unique 仍能兜底。
- ingress/egress 同 Node 同 port 冲突。
- 不同 Node 同 port 合法。
- release 只能释放自己的 lease。
- crash 后 reconcile 能识别孤儿 lease。

#### 本步禁止

- 不写 RELAY forwarder。
- 不改 Web。
- 不切 DIRECT。

---

### Step 4 — V3-S3A：Agent v3 Runtime 骨架

**建议分支：** `feature/v3-s3a-agent-runtime`

**目标：** 建立新 Agent runtime 的内部边界，但先不做完整 RELAY 网络链路。

#### 新模块

建议：

```text
agent/internal/v3/
├─ forwarder/
│  └─ interface.go
├─ manager/
│  ├─ tunnel.go
│  ├─ egress.go
│  └─ ports.go
└─ state/
   └─ revision.go
```

允许根据当前仓库组织调整目录，但职责不能混回 legacy engine。

#### 本步实现

- Forwarder interface：Start / Stop / Stats / Mode。
- TunnelManager：按 tunnel_id 管理运行实例。
- EgressManager：管理目标池 snapshot。
- 本地 used-port 二次保护。
- revision state 存储接口。
- graceful stop 与进程退出清理。

#### 本步禁止

- 不接 Panel command。
- 不改 Socket.IO 协议。
- 不改 legacy engine。
- 不写 Web/API。

#### DoD

Go 单测覆盖：

- Add / duplicate Add；
- Stop 幂等；
- 同 port 冲突；
- manager 并发安全；
- stale revision 状态接口。

---

### Step 5 — V3-S3B：TCP RELAY 数据面

**建议分支：** `feature/v3-s3b-relay-dataplane`

**目标：** 不依赖控制面，先证明 Agent 数据面本身正确。

#### 实现

- RelayForwarder：
  `listen ingressPort → dial egress nextHop`
- EgressForwarder：
  `listen egressPort → choose target → dial target`
- 双向 copy + cancellation。
- round / rand / weighted_round。
- 目标池原子热更新。

#### 本地验收拓扑

```text
test client
   ↓
Ingress Agent process
   ↓
Egress Agent process
   ↓
Target A / Target B
```

必须是实际 TCP socket，不允许只有 mock Conn。

#### DoD

- 大小数据双向收发正确。
- 客户端主动断开无 goroutine 泄漏。
- Target A 下线时错误可观测。
- 热更新 target 不关闭 listener。
- weighted_round 有统计测试。
- BOTH 节点端口冲突被拒绝。
- `go test -race` 若 CI 环境允许，应纳入该模块测试。

---

### Step 6 — V3-S4A：结构化控制协议 + Revision + ACK

**建议分支：** `feature/v3-s4a-control-protocol`

**目标：** 在现有 Agent 主动出站连接上增加 v3 命令协议，不建立 Panel→Agent 公网 HTTP 依赖。

#### 命令

至少：

- `apply_tunnel`
- `remove_tunnel`
- `update_targets`
- `suspend_tunnel`
- `state_request`

统一 envelope 必须包含：

- command_id
- resource / resource_id
- revision
- action
- expires_at
- payload

#### Agent ACK

至少：

- command_id
- resource_id
- received_revision
- applied_revision
- status
- error_code
- error

#### 硬规则

- stale revision 拒绝。
- equal revision 幂等 ACK。
- newer revision 原子 apply。
- 命令过期拒绝。
- malformed payload fail closed。
- apply 完成以后再更新 applied_revision。

#### 本步禁止

- 还不由用户 API 直接创建 RELAY。
- 不做最终 orchestrator。
- 不做 Web。

---

### Step 7 — V3-S4B：节点身份、认证、重连与 State Report

**建议分支：** `feature/v3-s4b-node-session`

**目标：** 让“谁在连控制面”与“这台 Agent 当前真正运行什么”都可信。

#### 实现

- 每 Node 独立 credential。
- credential hash at rest。
- rotate / revoke。
- Agent handshake 由 credential 映射到 server-side Node identity。
- 不信任 payload 自报 node_id。
- Agent 周期 state report：
  - version
  - role
  - active tunnel ids
  - active ports
  - applied revisions
- reconnect 后控制面获得完整 runtime snapshot。

#### DoD

- A Node token 不能冒充 B Node。
- revoked credential 重连失败。
- rotate 后旧 credential 失效。
- token 不出现在日志。
- NAT/私网 Agent 只靠出站连接即可工作。

---

### Step 8 — V3-S5A：Node Scheduler + RELAY Orchestrator

**建议分支：** `feature/v3-s5a-orchestrator`

**目标：** 第一次把 DB desired state、port lease、Agent command 串起来。

#### Scheduler

负责：

- 从 NodeGroup 候选中挑选实际 ingress Node。
- 检查 Node.role。
- 检查 active/last_seen。
- explicit node 优先。
- 自动选择规则必须 deterministic，可解释。
- 选中后立即写入 `Tunnel.ingress_node_id`。
- RELAY 同理绑定 `egress_node_id`。

#### Orchestrator 创建顺序

```text
1 DB quota/auth validation
2 create desired Tunnel = pending
3 bind ingress / egress Node
4 acquire ingress / egress port leases
5 increment config_revision
6 send Egress apply
7 wait Egress ACK
8 send Ingress apply
9 wait Ingress ACK
10 mark active
```

任何失败：

- 保留 Tunnel；
- `apply_status=error`；
- 写结构化 error；
- 补偿已应用的一端；
- 释放不再使用的 lease；
- 不物理删除 Tunnel。

#### DoD

用 fake transport + real DB 测试顺序：

- Egress ACK 前绝不 apply Ingress。
- Egress fail → Ingress 不启动。
- Ingress fail → Egress 被补偿。
- retry 不产生第二个 lease。
- 同一 request 重试不重复创建 runtime。

---

### Step 9 — V3-S5B：Reconciler、Retry 与重启恢复

**建议分支：** `feature/v3-s5b-reconciler`

**目标：** 让系统不依赖“一次请求必须成功”。

#### Reconciler 对比

- DB desired state。
- Tunnel revision。
- Agent state report。
- NodePortLease。
- Node online state。

#### 只允许的自动动作

- 重发相同 desired revision。
- 补齐 Agent 缺失 runtime。
- 清理确认无主的 lease。
- 将异常记录为 error / warning。

#### 默认不允许

- 自动换 Node。
- 自动换端口。
- 自动迁移用户隧道。
- 因心跳短暂丢失删除 Tunnel。

#### Restart 恢复

Agent 重启后只能恢复：

`Tunnel.ingress_node_id == self.id`

或者：

`Tunnel.egress_node_id == self.id`

禁止再按整个 NodeGroup 把隧道恢复到每台机器。

#### DoD

- Agent kill → restart 后恢复。
- 控制连接断开 → reconnect 后 converge。
- control plane restart 后 converge。
- 多次 reconcile 幂等。
- NodeGroup 多 Node 不重复监听。

---

### Step 10 — V3-S6A：管理端 Node / Egress API

**建议分支：** `feature/v3-s6a-admin-api`

**目标：** 先让管理员能够正确配置 v3 基础资源。

#### API

- Node role read/update。
- credential rotate/revoke。
- EgressPool CRUD。
- EgressTarget CRUD。
- target status / weight / order。
- Node runtime/state report 查询。

#### 权限

仍走现有平台 admin / workspace 权限体系，不创建 v3 私有权限旁路。

#### DoD

- workspace / admin 权限负面测试。
- 非 egress/both Node 不能启用 EgressPool。
- 最后一个 active target 不能被无保护地停用。
- target 热更新能产生正确 revision/command。

---

### Step 11 — V3-S6B：Tunnel RELAY API

**建议分支：** `feature/v3-s6b-tunnel-api`

**目标：** 到这一步，用户 API 才第一次正式允许创建 RELAY。

#### POST /api/tunnels

新增：

- tunnel_mode
- explicit ingress_node_id（可选）
- egress_node_id / egress_pool_id（RELAY）
- 继续兼容 legacy DIRECT 请求体

#### 操作

- create
- update target/pool/node
- retry
- suspend
- resume
- delete

所有动作都调用 orchestrator，不允许 route 自己写一套下发逻辑。

#### 安全

必须继续经过：

```text
workspace membership
→ role permission
→ capability policy
→ node-group grant
→ node role
→ port ownership
→ orchestrator
```

#### DoD

- 跨 workspace 读写拒绝。
- viewer 写操作拒绝。
- policy 不允许 relay 时拒绝。
- 无可用 Egress/Target 时明确 4xx。
- create 成功返回的是 desired/runtime 状态，而不是假定“写 DB = 在线”。

---

### Step 12 — V3-S7A：管理端 Web

**建议分支：** `feature/v3-s7a-admin-web`

只实现管理员需要的 v3 配置：

- Node role Badge / 编辑。
- credential rotation 状态。
- Egress Pool / Target 编辑器。
- Node 在线、revision、active tunnel/port 诊断。

**禁止同时改用户 Tunnel 创建页。**

DoD：

- typecheck。
- unit tests。
- production build。
- 空态、错误态、离线态完整。

---

### Step 13 — V3-S7B：用户 Tunnel Web

**建议分支：** `feature/v3-s7b-tunnel-web`

实现：

- DIRECT / RELAY 模式切换。
- Ingress / Egress 选择。
- Target Pool 选择。
- pending / applying / active / error / suspended。
- retry。
- 实际 ingress/egress Node 与端口展示。
- apply_error 可读提示。

UI 不自行判断授权，以 capabilities + 服务端响应为准。

---

### Step 14 — V3-S8：真实三机 E2E + 灰度发布

**建议分支：** `feature/v3-s8-e2e`

最低环境：

```text
Control Plane
Ingress Node
Egress Node
Target A
Target B
```

至少一个 Agent 必须放在 NAT/私网，只能主动出站。

#### 必跑场景

1. legacy DIRECT 创建/访问不回归。
2. TCP RELAY 连通。
3. Egress-before-Ingress 时序。
4. weighted target 流量分布。
5. target 热更新。
6. Agent 重启恢复。
7. Agent 网络断开/恢复。
8. Panel 重启恢复。
9. stale revision。
10. credential revoke。
11. port conflict。
12. port exhaustion。
13. 两 workspace 隔离。
14. BOTH Node。
15. suspend/resume。
16. 修改 Egress Node。
17. 备份 → 恢复 → DIRECT/RELAY 状态检查。
18. 旧版本 Agent 与新 Panel 的兼容行为。

#### 灰度规则

- 默认 `relay_enabled=false`。
- 第一轮只对白名单 workspace/node 开放。
- 观察错误率、端口冲突、ACK 延迟、流量一致性。
- 验收通过后才允许默认开启。

这一步不过，**不允许开始 DIRECT v3 化**。

---

### Step 15 — V3-S9：DIRECT 迁入 v3 Runtime

**建议分支：** `feature/v3-s9-direct-runtime`

顺序：

1. 新建 DIRECT 可选择 v3 runtime，但 feature flag 默认关闭。
2. 对照 legacy DIRECT 的 TCP 功能。
3. 灰度新建 DIRECT。
4. 停止让 legacy allocator 为新 Tunnel 分配端口。
5. 存量 DIRECT 分批迁移。
6. 至少一个稳定发布周期后，才允许删除 legacy read/write path。

在确认所有存量实例迁完之前：

- 不删 `forward_addresses`。
- 不删旧 engine。
- 不删旧 config generator。
- 不做 destructive migration。

---

### Step 16+ — V3-S10：协议与高级能力逐项开发

S10 不允许一次性“全做完”，每一项重新走：

```text
设计约束
→ schema/API（如需要）
→ Agent
→ tests
→ real E2E
→ feature flag
→ 灰度
→ 稳定
```

固定顺序：

1. **UDP**
2. **WS/TLS**
3. **QUIC**
4. **高级 LB**：least_conn → least_traffic → ip_hash
5. **DNS**
6. **多入口 HA / 手动故障迁移**
7. **自动故障迁移**（只有监控与状态机足够稳定后）
8. **多跳 / Tunnel Chain**（只有明确产品需求后）

任何后项不得因为“顺手”提前塞进前项 PR。

---

### 7.2 每一步统一工作流程

每个 Step 都严格执行：

```text
A. 从最新 main 创建对应 feature/v3-* 分支
B. 只实现该 Step 的范围
C. 本地/分支测试
D. 创建 PR
E. 对照本文件逐条 review
F. CI 全绿
G. squash merge main
H. main push CI 再次全绿
I. 更新本文件中的“当前执行步骤”
J. 删除/停止使用已合并源分支
K. 才能创建下一 Step 分支
```

如果 PR 出现以下任意情况，**不合并**：

- 属于后续 Step 的功能提前进入。
- 新增第二套开发计划/roadmap。
- 用新字段重新推断实际 Node，而不是使用明确 binding。
- 绕过统一 port lease。
- 绕过 Workspace RBAC / CapabilityPolicy / NodeGroupGrant。
- 要求公网开放 Agent 管理端口才能工作。
- 没有 revision/ACK 就声称控制面可靠。
- 测试或 CI 失败。
- 破坏 legacy DIRECT 且没有对应迁移步骤。
- 数据库回滚依赖 DROP 列才能恢复代码。

### 7.3 当前执行游标

开发文档里必须始终只保留一个“当前执行游标”。

**当前：Step 1 — V3-S1A Schema。**

因此当前允许创建的下一条开发分支只有：

```text
feature/v3-s1a-schema
```

在它合入并且 main CI 全绿前，Step 2 及以后全部视为“未授权提前开发”。


---

## 8. 开发硬规则

### 8.1 一次只做一个切片

- PR 必须写明 `V3-Sx`。
- 禁止在 S2 PR 顺手开发 S7 UI 或 S10 协议。
- blocker 修复可以跨切片，但必须在 PR 说明原因。

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

### 阶段验收

S3 起必须增加真实网络测试，不能只依赖 mock。
S8 之前 RELAY 不得作为默认公开能力。

---

## 10. 分支、PR 与提交约定

分支名必须与当前 Step 对应，优先使用本文件第 7 节给出的固定名称，例如：

```text
feature/v3-s1a-schema
feature/v3-s1b-backfill
feature/v3-s2-port-lease
feature/v3-s3a-agent-runtime
feature/v3-s3b-relay-dataplane
feature/v3-s4a-control-protocol
feature/v3-s4b-node-session
...
```

不得创建“下一阶段总分支”一次堆多个 Step。

PR 标题：

```text
feat(v3-s3): implement TCP relay data plane
```

PR 描述必须包含：

- 所属切片。
- 改动范围。
- 未实现范围。
- 数据迁移影响。
- 回滚方式。
- 测试证据。
- 是否改变 v3map 约束；正常情况下答案必须是“否”。

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

## 12. 当前下一步

**当前执行游标：Step 1 — V3-S1A Schema。**

当前唯一允许的新功能分支：

```text
feature/v3-s1a-schema
```

这一 PR **只做数据模型与 additive migration**：

1. 定义 Node.role 与节点 credential 字段。
2. 定义 Tunnel 的 mode、实际 ingress/egress binding、端口、desired/apply 状态与 revision 字段。
3. 新增 EgressPool / EgressTarget / NodePortLease。
4. 补齐唯一约束、外键和安全的 onDelete 行为。
5. 通过空库 migrate、Prisma generate、TypeScript typecheck 和完整 CI。

这一 PR **不做**：

- legacy backfill（属于 Step 2）；
- port allocator（Step 3）；
- Agent runtime / RELAY（Step 4–5）；
- 控制协议（Step 6–7）；
- API / Web（Step 10–13）；
- DIRECT 迁移、UDP、QUIC、支付等后续能力。

Step 1 合并到 main 且 main push CI 再次全绿以后，才把执行游标更新为 **Step 2 — V3-S1B Backfill**。

从现在开始，后续全部开发都以第 7 节的 Step 顺序为准。

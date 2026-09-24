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

## 7. 唯一实施路线

后续 Issue、分支和 PR 必须标注所属切片。除 blocker 外，不跨阶段提前开发后续能力。

### S0 — 架构冻结与文档收口

状态：**✅ 完成**

交付：

- 本文件成为唯一开发方案。
- v3map 明确为架构约束。
- 删除旧 `PLAN.md` 和旧 v3 migration plan。
- 固化 ingress binding、状态机、revision/ACK、统一端口所有权、出站控制通道。

DoD：仓库不存在第二份可执行开发路线。

### S1 — v3 Schema（全 additive）

状态：**下一阶段**

新增/调整：

- `Node.role = ingress | egress | both`
- Node 独立 credential / credential version
- `Tunnel.tunnel_mode`
- `Tunnel.ingress_node_id`
- `Tunnel.egress_node_id`
- `Tunnel.egress_pool_id`
- `Tunnel.ingress_port / egress_port`
- desired/apply 状态、revision、error 字段
- `EgressPool`
- `EgressTarget`
- `NodePortLease`

同时定义 legacy 映射：

- 存量 Tunnel 一律 `direct`。
- 存量 DIRECT 不改变运行通道。
- Node role 从现有组信息安全回填；无法可靠判定的节点保持待管理员确认，不猜。
- migration 必须可重复在空库与升级库执行。

DoD：

- Prisma generate/typecheck 通过。
- 空库 migrate 通过。
- 至少一份真实结构的 legacy fixture 升级通过。
- 回填后存量 DIRECT 数据数量、端口、目标不变。
- 不 DROP 旧字段。

### S2 — 统一端口所有权

实现 NodePortLease + 分配服务。

DoD：

- 同 Node 同 port 无论 ingress/egress 都不能重复。
- 两个控制面实例并发申请不重复。
- 用户指定端口与自动端口走同一冲突规则。
- 黑名单双层校验。
- 存量 DIRECT 不被重新分配。
- 对账测试覆盖 DB / Redis / Agent 三方差异。

### S3 — Agent TCP RELAY 数据面

新增：

- Forwarder interface。
- RelayForwarder。
- EgressForwarder。
- TunnelManager。
- EgressManager。
- round / rand / weighted_round。
- 原子 apply / stop。
- active ports + applied revision 状态上报。

暂不迁移现有 DIRECT engine。

DoD：

- Go unit tests 覆盖 start/stop/idempotency/stale revision。
- RELAY 本地双进程 TCP 双向流完整。
- target 热更新不断 listener。
- 空 target snapshot 被拒绝。
- BOTH 节点端口冲突被本地 manager 二次阻止。

### S4 — v3 控制协议与 ACK

在 Agent 主动出站连接上实现：

- apply_tunnel
- remove_tunnel
- update_targets
- suspend_tunnel
- state_report
- command_ack

DoD：

- 不开放公网 Agent 管理端口也能完成全部控制。
- 重复 command 幂等。
- 乱序 revision 不回退。
- 断连重连后能补齐 desired state。
- 节点凭据撤销后立即无法重新认证。

### S5 — Orchestrator + Reconciler

实现：

- ingress/egress Node 调度与持久绑定。
- RELAY 两阶段 apply。
- 错误状态与 retry。
- 修改出口的无损切换。
- 周期 reconcile。
- node offline 只标状态，不自动迁移。

DoD：

- Egress 未 ACK 时 Ingress 绝不开始监听。
- 任一步失败均有可解释状态，不物理删除 Tunnel。
- Agent 重启只恢复绑定给自己的 Tunnel。
- 同 NodeGroup 多 Node 不会重复恢复同一 Tunnel。
- retry 不产生重复 listener / port lease。

### S6 — Backend API

新增/改造：

- Node role 管理。
- EgressPool / EgressTarget CRUD。
- Tunnel DIRECT / RELAY 模式参数。
- ingress / egress explicit selection 与自动调度。
- retry / suspend / resume。
- 运行状态与错误查询。

权限必须继续复用 Workspace RBAC + CapabilityPolicy + NodeGroupGrant。

DoD：

- 跨 workspace 访问全拒绝。
- RELAY 无可用 egress/target 时给明确 4xx。
- 角色/策略/额度/端口判定在服务端生效。
- API 不依赖前端隐藏保证安全。

### S7 — Web UI

实现：

- Node role Badge 与能力编辑。
- Egress 默认目标池编辑器。
- 创建 Tunnel 的 DIRECT / RELAY 切换。
- RELAY 入口/出口选择。
- apply_status / apply_error / retry。
- 详情页显示实际运行 Node 与端口。

DoD：

- typecheck、unit test、production build 全过。
- error / pending / active / suspended 状态均有明确 UI。
- 移动端不阻塞核心创建与诊断路径。

### S8 — 真实 E2E 与灰度

最低环境：

- 1 控制面。
- 1 Ingress。
- 1 Egress。
- 2 个可区分 Target。
- 至少一个 Agent 处于 NAT/私网，仅可主动出站。

必须验证：

- DIRECT 存量链路不回归。
- RELAY 完整路径。
- 先出口后入口时序。
- Egress target 热更新。
- Agent 重启恢复。
- 控制连接断线重连。
- 错误 credential。
- 端口冲突/池耗尽。
- 两 workspace 同 ID/同端口场景不串租户。
- 备份/回滚后存量 DIRECT 可继续服务。

通过后才允许默认开启 `relay_enabled`。

### S9 — DIRECT v3 化

只有 S8 稳定后才开始。

把新建 DIRECT 从 legacy engine 迁到 v3 TunnelManager；经过至少一个灰度周期后，再迁存量 DIRECT。

DoD：

- 同一状态机/revision/port lease 控制 DIRECT 与 RELAY。
- 与旧 DIRECT 功能逐项对照，无协议/限速/目标语义倒退。
- legacy engine 只有在所有存量实例迁完后才进入删除候选。

### S10 — 协议与高级能力

按独立工作包顺序推进：

1. UDP
2. WS/TLS
3. QUIC
4. 高级 LB（least_conn / least_traffic / ip_hash）
5. DNS
6. 多入口 HA / 故障迁移
7. 多跳（只有真实需求后）

每项都必须独立威胁建模、E2E、性能基线和回滚方案。

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

推荐：

```text
feature/v3-s1-schema
feature/v3-s2-port-lease
feature/v3-s3-relay-agent
feature/v3-s4-control-protocol
...
```

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

当前主线从 **V3-S1 Schema** 开始。

在 S1 完成之前，不开发 v3 UI、不切新 DIRECT、不加入 UDP/QUIC，也不扩大支付/工单/返佣等非核心模块。

S1 的第一份 PR 应只完成：

1. v3 schema additive migration。
2. legacy 数据安全回填。
3. Prisma / migration 测试。
4. 不接 Agent、不改 UI、不启用 RELAY。

这将作为 TuneX 后续所有 v3 开发的统一起点。

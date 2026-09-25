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

TuneX 的核心 v3 网络架构升级、WP14 Real E2E Gate、WP15 DIRECT v3 Migration，以及 V4 的 Node + Forward 产品层收敛均已进入 `main`。

当前主线从“迁移旧架构”切换为：

**稳定单一 v3 runtime 与 V4 Node + Forward 产品面；新增协议和高级能力统一进入 WP16+ 独立工作包。**

后续仍保留已经稳定的 Workspace、权限、策略额度、流量、认证、CI 和生产运维底座。网络层的事实源已经收敛为 Node 角色、Forward/Tunnel desired state、具体 ingress/egress binding、NodePortLease、revision/ACK 和 Reconciler；不得重新引入第二套 DIRECT engine、第二套端口所有权或第二套用户侧 Tunnel 产品模型。

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

### 1.1.1 用户产品模型：Node + PortForward

从本阶段开始，用户侧不再把 `Tunnel` 当作需要手工创建的第一层资源。产品语义固定为：

```text
Ingress Node
├─ PortForward（不选择出口） → DIRECT
└─ PortForward（选择已绑定出口） → RELAY

Egress Node
└─ 必须先与某个 Ingress Node 建立 Binding，才能被该入口的 PortForward 选择
```

硬规则：

- **一个实际 Agent = 一个不可变 `agent_id` = 一条 Node 记录**。角色不是身份；同一 Agent 可以是 `ingress`、`egress` 或 `both`。
- `node_id` 只作为用户可读名称/标签，可修改；`agent_id` 由 Panel 创建 Node 时生成，安装、角色切换、hostname 变化都不得改变。
- `both` 节点不拆成两个 Agent。它可以自己承担 DIRECT/RELAY ingress，也可以作为其它入口节点绑定的 egress。
- 同一条 PortForward 不允许把相同 Agent 同时选成 ingress + egress；这种“自中继”没有额外网络语义，应直接使用 DIRECT。
- Ingress / BOTH 节点可以独立创建端口转发。
- 创建 PortForward 时 `egress_node_id = null` 即 DIRECT。
- 指定 `egress_node_id` 即 RELAY，但该出口必须与入口存在有效 `NodeBinding`。
- Egress 节点不能独立创建用户监听端口；它只作为入口节点的可选出口能力。
- 用户界面统一使用「节点 / 端口转发 / 绑定出口」术语，不再要求用户先创建 Tunnel。
- `Tunnel` 继续保留为**内部 runtime / desired-state 对象**，承载 revision、ACK、NodePortLease、Reconciler 与历史流量；不得为 PortForward 再造第二套数据面状态机。
- 第一版 `PortForward.id` 可以直接映射内部 `Tunnel.id`；对外 API 做 projection，数据库无需立刻复制一张业务真相表。
- 每条 RELAY PortForward 的目标属于该转发自己的 EgressPool；出口节点本身不再要求预先配置业务目标。

### 1.1.2 节点创建与一键安装

Node 生命周期改为「Panel 先创建 → 机器后注册」：

1. Panel 创建 pending Node，只确定 NodeGroup、角色与端口范围；`connect_ip` 可为空。
2. Panel 生成一个 **10 分钟、一次性** enrollment token，只存哈希。
3. UI 立即展示可复制的一键安装命令；命令携带短时 enrollment token、不可变 agent_id 和当前可读 node_id，长期 node credential 不出现在该命令中。
4. 安装脚本先确保 Docker Engine 可用，并拉取 Panel 配置的专用多架构 `tunex-agent` 镜像；镜像拉取失败时不得消费 enrollment token。
5. 节点以 enrollment token 调用机器端 enroll API；服务端原子消费 token，并签发真正的 per-node credential。
6. 安装脚本把 credential 写入宿主机 root-only `/etc/tunex-agent/agent.env`，容器只读挂载该文件，不通过 Docker 环境变量明文注入长期凭据。
7. Agent 容器使用 `--network host`，让 DIRECT/RELAY 动态监听端口直接绑定宿主机网络；默认 `--restart unless-stopped`。
8. Agent 后续只使用 per-node credential 做 outbound command/state/desired；enrollment token 永不复用。
9. 重新安装必须由 Panel 显式生成新的 enrollment token；新 token 会撤销该节点尚未使用的旧 token。

安全约束：

- enrollment token / node credential 明文都不得落数据库、日志、审计 metadata 或 URL query。
- credential 是认证真相；agent_id 是运行实例一致性校验。Agent 上报 agent_id 时必须与该 credential 绑定的 Node.agent_id 相同，否则拒绝。
- 安装命令可以包含短时 enrollment token，但不得包含长期 credential。
- enroll 端点必须并发安全：同一 token 最多一个请求成功。
- Panel 不主动连接 Agent；一键安装不得重新引入公网 9090 依赖。
- Agent 使用独立 `ghcr.io/paimoncai/tunex-agent:<sha>` slim multi-arch 镜像；生产应通过 `TUNEX_AGENT_IMAGE` 与 Panel 镜像钉同一 git sha。
- 安装器不得把长期 node credential 放进 `docker run -e` 或容器元数据；凭据只允许存在于 root-only 宿主机文件与进程内存。
- Agent Docker 容器必须使用 host network；不得通过预声明固定 `ports:` 映射模拟动态转发端口。

### 1.2 当前阶段边界

当前 `main` 已经具备并继续保留：

- Workspace / Membership / Invite 多租户底座。
- API、Redis、Socket、Worker 的 workspace 作用域。
- CapabilityPolicy / WorkspacePolicyAssignment / NodeGroupGrant。
- 额度原子判定。
- 邮箱验证、密码重置、限流、CSRF、密钥隔离。
- Agent → Panel outbound-only command / desired / ACK 控制链路，以及由 TunnelManager 承载的统一 TCP DIRECT/RELAY v3 runtime。
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

`EgressPool` 继续作为内部 runtime 目标容器，但用户侧 V4 产品模型不要求先创建或选择 Pool。
普通 RELAY PortForward 的目标属于**该 Forward 自己**，控制面负责创建一个系统管理的
单成员 EgressPool：

```text
Forward (RELAY / Tunnel runtime)
├─ egress_node_id
└─ implicit EgressPool  (system managed, e.g. forward-<tunnelId>)
   └─ EgressTarget(host, port, weight=1)
```

规则：

- 普通 Forward 创建只让用户选择实际 Ingress / Egress Node 与目标 host/port；
  **不得要求用户填写 NodeGroup ID 或 EgressPool ID**。
- 每条普通 RELAY Forward 使用独立的系统管理 Pool，挂在所选 Egress Node 上；
  不得让多条目标不同的 Forward 共用一个全局 `default` Pool，否则修改其中一条目标
  会污染其它转发。
- Tunnel runtime 继续通过 `egress_pool_id` 指向该 Pool，Agent / Orchestrator
  无需增加第二套目标模型。
- 删除使用 `forward-<tunnelId>` 规则创建的系统 Pool 时，应随 Forward 一起回收；
  显式创建的高级共享 Pool 不按该规则自动删除。
- Admin 高级界面仍可维护显式多目标 EgressPool / EgressTarget；这是高级能力，
  不进入普通 Forward 创建流程。
- `EgressTarget` 继续包含 host、port、weight、order、status。简单 Forward 首版
  只有一个 active target；高级多目标负载均衡独立演进。
- Pool 的默认策略可继承 Node.lb_strategy，目标快照热更新仍不得要求重建 ingress listener。
### 2.3 数据平面

当前 `main` 已完成 WP15，DIRECT 与 RELAY 不再由两套 engine 承载：

```text
DIRECT:
Client → Ingress SingleHopForwarder → Target

RELAY:
Client → Ingress SingleHopForwarder
       → Egress EgressForwarder
       → EgressPool / Targets
```

当前硬规则：

- DIRECT / RELAY ingress 都由 `TunnelManager` 创建和持有，统一走 revision / ACK / desired restore。
- DIRECT 与 RELAY 的差异只在 upstream：DIRECT 指向用户目标，RELAY 指向已编排的 Egress runtime。
- 旧 DIRECT engine、旧独立 forward 路径和 Agent 内第二份 `usedPorts` 已删除。
- 端口所有权统一由 `NodePortLease` + Agent TunnelManager 的共享 port guard 承载。
- 生产控制链路为 Agent 主动轮询/上报的 outbound-only HTTP；Panel 不依赖 Agent 公网管理端口。
- EGRESS 仍使用专用 `EgressForwarder`，因为它负责目标池负载均衡，不属于单跳转发。

因此后续新增协议或高级能力必须扩展这一套 runtime，不得重新复制一套 DIRECT/RELAY 数据面。

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

节点 enrollment 与运行凭据必须严格分层：enrollment 只负责**首次/重新安装时换取 credential**，不能直接调用 state/commands/ACK/desired API；credential 也不能反过来生成 enrollment。

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

### 5.2 WP15 完成后的端口边界

WP15 已完成旧 allocator 独占路径的迁移。当前约束为：

- 所有新建 DIRECT / RELAY runtime 都必须通过 `NodePortLease` 获取或复用物理端口。
- 存量 DIRECT 的可见监听端口在升级时保持不变；升级验证必须证明同端口恢复而不是重新分配。
- `UNIQUE(node_id, port)` 是数据库最终所有权约束；同一 Tunnel 同方向 resume/reapply 允许幂等复用自己的 lease。
- Agent TunnelManager 对 DIRECT / RELAY / EGRESS 共用一份物理端口 guard，BOTH Node 不允许同端口双绑。
- 黑名单在 API 校验和分配服务两层验证。
- Agent 上报 active ports 只用于对账，不作为端口归属真相源。
- 不得重新引入 `socket/port-allocator.ts` 一类独立长期所有权实现。

---

## 6. Schema 迁移原则

所有 v3 数据库改动采用 **expand-and-contract**：

1. 只新增兼容字段/表。
2. 回填。
3. 新代码双读/必要时双写。
4. 切换读/写真相源。
5. 按发布窗口停止旧写路径（不设额外灰度阶段，见 §7.16 WP15 与 §8.5）。
6. 最后才讨论清理 legacy 字段。

生产回滚默认：

```text
直接回滚 Backend/Web/Agent 镜像到上一版本
→ 保留新增 schema
→ 上一版本镜像自带其需要的读/写路径，存量隧道继续运行
```

> §7.16 决定删除 legacy engine 后，代码里不再保留「v3 / legacy」运行期开关，
> 因此回滚不依赖关闭某个 flag，而是整组镜像回退。

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

| WP | 工作包 | Track | 当前状态 | 备注 |
|---|---|---|---|---|
| WP0 | 架构/文档冻结 | Shared | ✅ 完成 | 开发约束与单一计划已冻结 |
| WP1 | v3 Schema 契约 | A | ✅ 完成 | Schema foundation |
| WP2 | Legacy Backfill / Upgrade | A | ✅ 完成 | 存量 DB additive 升级 |
| WP3 | NodePortLease / Port Allocator | A/C | ✅ 完成 | 物理端口单一所有权 |
| WP4 | Agent v3 Runtime | B | ✅ 完成 | TunnelManager runtime |
| WP5 | TCP RELAY Data Plane | B | ✅ 完成 | RELAY data plane |
| WP6 | Command / Revision / ACK | B/C | ✅ 完成 | revisioned control contract |
| WP7 | Node Credential / State | B/C | ✅ 完成 | per-node credential + state/desired |
| WP8 | Scheduler + Orchestrator | C | ✅ 完成 | concrete ingress/egress binding |
| WP9 | Reconciler / Retry / Recovery | C | ✅ 完成 | same-revision controlled repair |
| WP10 | Admin Node / Egress API | C | ✅ 完成 | admin/runtime management |
| WP11 | Tunnel Runtime API | C | ✅ 完成 | 历史 runtime API；V4 用户产品使用 Forward API |
| WP12 | Admin Web | D | ✅ 完成 | 管理端节点/runtime diagnostics |
| WP13 | Tunnel Web | D | ✅ 完成 | 历史产品层；V4 已收敛到 Forward |
| WP14 | Real E2E / Release Gate | D/Shared | ✅ 完成 | outbound-only DIRECT/RELAY Integration |
| WP15 | DIRECT v3 Migration | B/C | ✅ 完成 | legacy DIRECT engine 已删除（`cdfc3f9` + `95d4c6c`） |
| WP16+ | UDP / WS/TLS / QUIC / Advanced | 多 Track | 按需启动 | 每项单独 contract + tests + real E2E + release gate |

**重要：** “可以开始开发”是允许团队成员创建分支、写代码、开 Draft PR；“可以合并 main”才是硬门槛。

---

### 7.3 当前并行开发窗口

WP0–WP15 的核心迁移链已经结束，当前没有“等待前置 Gate 才能启动”的核心迁移 WP。

当前允许并行的工作只有两类：

#### 稳定化 / 兼容收尾

- V4 用户产品入口固定为 `/nodes` + `/forwards`；Tunnel 只作为内部 runtime / desired state。
- Web 已停止调用旧 `/api/tunnels` 与 node-scoped Forward API。
- Backend 仍暂留 `/api/tunnels` 与 `/api/nodes/:ingressId/forwards`，均返回 deprecation / successor headers。
- 这些兼容路由在仓库内没有新的产品调用方；删除它们是**外部 API breaking change**，应单独 PR、单独发布说明，不与功能开发混合。
- `web/src/components/forwards/__tests__/legacy-tunnel-compat.test.ts` 只用于兼容窗口守护；兼容路由删除时一并删除。

#### WP16+ 新能力

UDP、WS/TLS、QUIC、advanced LB、DNS、multi-ingress HA、automatic failover、multi-hop 按 §7.17 独立 contract / tests / real E2E / release gate 推进。

**当前默认没有 Active Core WP。** 如果没有明确的新能力 contract，优先做生产稳定化、可观测性、部署演练和兼容 API 生命周期管理。

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

**实现：**

- 迁移 `20260926120000_v3_legacy_backfill`：**零 DDL，只含 DML**（三条幂等
  `UPDATE`）。它是 WP1 之后的第二道防线——WP1 迁移跑完的那一刻，新代码写入的
  行不带任何 v3 列值（`routes/tunnels.ts` 的 tunnel.create 不写 tunnel_mode /
  remote_host；`socket/index.ts` 与 `routes/admin-extended.ts` 的 node.create
  不写 Node.role），这些行 WP1 的回填语句覆盖不到，本迁移在它们被创建**之后**
  运行把它们补齐。因为只做 UPDATE，回滚镜像时不需要逆迁移（§6）。
  - `tunnel_mode`：剩余 NULL 且**不带 egress 指针**（`egress_node_id` /
    `egress_pool_id` 双 NULL）的行 → `direct`。判定比 WP1 严：带 RELAY 指针
    却缺 mode 是「写了一半的 v3 行」，留给 WP8，不被草率标成 direct。
  - `remote_host` / `remote_port`：`forward_addresses` 首目标回填，端口取最后
    一个冒号后片段（IPv6 冒号不误判）、host 剥掉 `[]`。解析不出（无端口 /
    非数字 / 空数组 / 越界）一律留 NULL，**绝不写 0 端口**。与 WP1 的回填
    SQL、`socket/config-generator.ts#normalizeForwardAddresses`、
    `routes/tunnels.ts` 的 FORWARD_RE 完全一致。
  - `Node.role`：按**节点组被哪些隧道引用的观测事实**确定性回填——只被 in 组
    引用 → `ingress`；只被 out 组引用 → `egress`；in/out 都引用、或没有任何
    隧道引用 → **留 NULL**（组内多节点谁走哪个方向无法从组级观测推出）。
    判定依据不是 `NodeGroup.node_type`（§2.1：该列只是 legacy 兼容字段），
    也不看 `tunnel_chain`（chain 是同一条隧道的附加跳，参与节点不可推出）。
    `'both'` 永远不写：那是「单机兼任」的显式管理动作，不是能从数据里推导的
    事实；留 NULL 让管理员在面板显式设置，成本远低于把未声明节点误判成兼任。
    幂等靠外层 `role IS NULL` 限定：管理员已显式设置（含 `both`）的行永不被回改。

- 测试 `backend/tests/legacy-backfill.test.mjs`（`TUNEX_DB_TEST=1`）：
  三条防线各用一个匿名库，互不污染。
  - **① 空库**：legacy 基线 + 全量 v3 迁移全部 apply，`_prisma_migrations`
    逐条 `finished_at` 非空。
  - **② legacy fixture**：`fixtures/legacy-backfill-rows.sql` 灌**纯存量数据**
    （只写 legacy 列）→ 升 v3 → `fixtures/legacy-backfill-post-v3.sql` 追加
    v3 列已存在才能构造的引用。断言 §7.5 的全部「不变」：10 条隧道的
    `listen_port` / `forward_addresses` / `user_id` / `workspace_id` / in-out
    组指针逐字不变，user / workspace / member / node_group / node 的关系不变；
    同时断言回填结果（3 ingress + 1 egress、2 行保持 NULL、整库无 `both`）。
  - **③ v3 upgrade fixture**：同一条 `migration.sql` 重放三次，数值与计数不变；
    管理员显式设置过的 `relay` / `both` 永不被回改。
  - **旧 Agent 兼容**：直接驱动真实的 `buildInNodeConfig` /
    `normalizeForwardAddresses`，证明下发的仍是 `listen_port` +
    `forward_addresses`，且**不含**任何 v3 字段（tunnel_mode / remote_host /
    apply_status）。配置生成路径本身未改一行。

DoD 核对：

| 验收项 | 结论 |
|---|---|
| 存量 Tunnel → direct | ✅ 9/10 → `direct`，唯一例外是带 egress 指针的半条 v3 行（留给 WP8） |
| tunnel 数量不变 | ✅ 回填前后 COUNT(*) 与逐行 id 一致 |
| listen port 不变 | ✅ 逐条断言 19001…19010 原样 |
| forward_addresses 不变 | ✅ 字符串 / 对象 / IPv6 / 多目标四种形态逐字不变 |
| workspace/user/policy 关系不变 | ✅ user / workspace / workspace_member / node_group / node 的关系与归属逐条断言 |
| Node.role 确定性回填，不猜 BOTH | ✅ 只按组用途观测判定；混挂组与无隧道组留 NULL；整库 `role = 'both'` 计数恒为 0 |
| 旧 Agent 仍能获取 legacy config | ✅ 真实 `buildInNodeConfig` 输出仍以 `forward_addresses` + `listen_port` 为准，无 v3 字段泄漏 |
| empty DB + legacy fixture + v3 upgrade fixture 全部通过 | ✅ 12 tests / 0 fail（本地一次性 mysql:8.4 容器实测） |
| full CI green | ⏳ 等 push 后的 CI 验证（CI 新增一步 `node --experimental-strip-types --test tests/legacy-backfill.test.mjs`） |


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

**状态：✅ 已实现，分支 `feature/v3-wp3-port-allocator` 已 push，CI 全绿（5 jobs，含 `portPool.test.ts` 42/42 在 backend job 内实跑）。**

交付物（`backend/src/services/portPool.ts`，708 → 现 825 行）：

| 符号 | 语义 |
|---|---|
| `acquirePort` | `revive-or-create`：先按 `status='released'` 守卫原子认领已释放的行，认领不到再 `create`；撞 P2002 = 真被占用 → 下一候选 |
| `releaseLease` | 软删除（`status='released'` 保留行）；三粒度 `leaseId` / `tunnelId` / `nodeId` |
| `leaseHolder` | 按 `(node_id, port)` 定位持有者；**签名里刻意没有 Redis**——「锁在不在」与「端口归谁」是两个问题 |
| `reconcileLeases` | 回收两类孤儿：悬空 tunnel_id、过期预分配（含 NULL expiry） |
| `reconcileLeaseLocks` | SCAN 清理残留锁 key；只清理不判定，`acquire` 的正确性从不依赖它 |

DoD 逐条落地（`backend/src/services/__tests__/portPool.test.ts`，42 tests / 318 assertions 全绿）：

- **并发分配无重复**：50 并发同节点 → 50 个互异端口；10 并发抢同一 user-specified 端口 → 恰 1 成功，其余 9 个 `port_taken`；
- **Redis 丢锁后 DB unique 兜底**：两种形态都验证——① Redis `set` 永远返回 null（抢不到锁）；② Redis set/del/scan 全部抛异常（Redis 整体宕机）。两种下分配仍正确且互斥，证明锁只是优化；
- **orphan lease 可 reconcile**：悬空 tunnel、过期预分配（含 NULL expiry）、预分配默认 TTL 兜底、`dryRun` 不写、revive 后端口可再分；
- **黑名单生效**：9 个端口（22/80/443/3306/5432/6379/27017/9090/9191）全清单；区间打散剔除；user-specified 指定黑名单 → `port_blacklisted` 而非静默改分；
- **ingress/egress 双池隔离**：`sameLeaseTarget` 不看 `lease_type`，同 `node_id` 必互斥（BOTH 双绑被禁），跨 `node_id` 同端口天然可各自持有；
- **legacy DIRECT 不可被抢占**：`AcquirePortInput.reservedPorts` 灌入存量 DIRECT `listen_port` 后，自动分配与 user-specified 都不再碰；显式抢占 → `port_taken`，且不静默改分别的端口；
- **user-specified 与 auto 同一规则**：`portCandidates` 共用；差别只在候选集长度（`[port]` vs 全区间），判定本身无白名单绕过项。

关键设计决定（写进了 portPool.ts 头注，供 review 时对齐）：

1. **锁 key 单一真相源**：`leaseLockKey` 直接调 `RedisKeys.portLeaseLock`（`tenant-scope.ts`），本文件不拼字符串；
2. **scope 只经 `nodeScope()` 派生**：`NodePortLease` 无 workspace_id 列，归属沿 `Node → node_group → workspace_id` 单向上查；
3. **预分配必须有 TTL**：`tunnel_id` 是 `ON DELETE SET NULL` 软外键，NULL expiry 的预分配会让 reconcile 永远收不回它，故缺省按 `PREALLOC_TTL_S`（15 min）兜底；
4. **不接路由/HTTP、不接 agent bind 探测、不做 role 校验**：端口 OS 层可用性由 agent `EADDRINUSE` 反馈，控制面只保证自己不再重复分配。

LEGACY 交接（见 `src/socket/port-allocator.ts` 头注与 `config-generator.ts` 导入处）：

- 旧 `socket/port-allocator.ts` 是**入口组内**确定性分配（依据 `@@unique([listen_port, in_node_group_id])`），
  与新 portPool 的**单节点**分配（依据 `@@unique([node_id, port])`）作用域不同、不通用；
- 它分配的 DIRECT `listen_port` **没有 `node_port_lease` 行**，因此调用 portPool 的一方
  必须把同节点这些端口经 `AcquirePortInput.reservedPorts` 灌入——那种撞号没有任何 DB 约束兜底，
  比 v3 内部撞号危险得多。WP8 编排器切流时这条是硬要求。

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

状态：**✅ 已合并 main 并经 CI 验证**（WP7 Node Credential / Session / State Report）。

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

**状态：✅ 已实现，分支 `feature/v3-wp8-scheduler` 已 push（依赖 WP3/WP5/WP6/WP7 接口；WP9 Reconciler 依赖本包的接口冻结）。**

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
- `apply_status=error`；
- 写结构化错误；
- 执行补偿；
- 不物理删除。

**落地位置（单一事实源，改动前先读这三处）：**

- `backend/src/services/scheduler.ts` —— §7.11 十条步骤的编排主体。auth/quota
  走既有 `capability-policy` + `policy-service` + `node-group-access`；bind 阶段
  用 `pickNode`（role 覆盖 + **WP7 身份闸门** + 在线优先 + id 最小）；
  端口经 `portPool.acquirePort`（legacy DIRECT `listen_port` 按 §7.6 灌
  `reservedPorts`）；下发走 {@link Orchestrator}。失败统一收进
  {@link CreateRelayFailure}，`persistFailure` 只 update 不 delete。
- `backend/src/services/orchestrator.ts` —— RELAY 双下发（先 Egress 后 Ingress，
  两端共用 revision N，Agent 侧 id 带 `-egress` / `-relay` 方向后缀）。
  命令经 WP6 `createCommand` + `ControlValidator`，ACK 也要过闸门；
  `removeTunnel` 用 revision+1 保证补偿撤得动。
- `backend/src/services/__tests__/scheduler.test.ts` —— 离线单测（内存 DB /
  Redis / 假 Agent 三个替身，零外部依赖）。

**关键设计决定（review 对齐用）：**

1. **orchestrator 不 import portPool**：端口所有权是 WP3 的领域，编排器只消费
   已拿到的端口号。否则「入口下发失败要不要释放出口端口」这类编排补偿会被
   端口分配的并发/对账逻辑污染。
2. **身份闸门落在 bind 阶段且复用 WP7 `decideNodeAuth`**：§3.3 的三条判定
   （未签发 / revoked / 哈希不等）只有一份实现。没有有效凭据的节点**不降级
   放行**（心跳抖动还可以等 ACK，身份缺口没法等），错误码
   `node_credential_missing` 且**不可重试**——用户重试不会让节点多出一把
   凭据，必须管理员到 WP10 端点补签。
3. **补偿顺序与下发相反**（Egress 后进先出）：已 ACK 的 Egress 必须先撤，
   否则它继续占着出口端口收流量；端口租约随后释放，不等 WP9 的
   15 分钟预分配 TTL。
4. **`PENDING_SCHEMA_COLUMNS` 显式留白**：`Tunnel.ingress_node_id` 列（§2.1
   「禁止只保存 NodeGroup」）尚未落库，本包**不自行 ALTER**（§8.2 顺序：
   schema 先行，需独立 additive migration PR）。常量存在的意义是让手滑写错
   列名在 review 时一眼可见。实际入口节点暂存于返回值
   `ingressNodeId`，列落地后由 migration + 一次落库补上。

DoD 核对（`scheduler.test.ts` 59 tests / 243 assertions 全绿，`tsc --noEmit` 0 error）：

| 验收项 | 结论 |
|---|---|
| 十条步骤严格有序，任一时刻「下一步」未允许被执行 | ✅ A1–A7 逐步断言执行顺序与落库状态 |
| 铁律一：Egress 先于 Ingress（含 next_hop 因果） | ✅ A2/A3；`dispatchIngress` 无 next_hop 直接拒（E2） |
| 铁律二：两次独立下发、同 revision N、各自 command_id | ✅ A4；id 带方向后缀（D8） |
| stale revision 被 WP6 闸门拒绝 | ✅ A5 |
| 失败保留 Tunnel + `apply_status=error` + 结构化错误 + 补偿，零 delete | ✅ B1/B2/B13/B14 + `dbCalls` 全程无 delete |
| 补偿先撤已 ACK 的 Egress（revision+1） | ✅ B3/B6 |
| 补偿释放全部端口租约（不等 reconcile TTL） | ✅ B4/B5/B10 |
| 端口分配集成（WP3）：两端各取、UNIQUE(node_id,port)、user-specified 同规则、legacy 保留、黑名单、区间耗尽 | ✅ C1–C10 |
| WP7 身份闸门：未签发 / revoked → `node_credential_missing` 且不可重试 | ✅ B13/B14/D1/D1b |
| 跨租户 fail-closed / RELAY 必须给出口组 / 出口池归属 | ✅ F2/F3/F4/F5 |
| full CI green | ⏳ 等 push 后的 CI 验证（ci.yml 已显式加入 `bun test scheduler.test.ts`） |

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

**实现（服务层 + 离线单测，已随本分支交付）：**

- `backend/src/services/reconciler.ts`：五份事实的对比与动作闸门。
  - 纯判定（`computeDrift` / `planTunnelActions` / `decideAutoAction`）与副作用
    （`executeReconcile`）分离；副作用全部走注入依赖，下发通道（`ReconcileSink`）
    由 WP8 编排器接线，**未注入时只记录不假装成功**。
  - `AUTO_ACTIONS` / `FORBIDDEN_AUTO_ACTIONS` 两个常量把 §7.12 的两条清单钉成
    穷尽数组；`decideAutoAction` 是唯一闸门，未知动作 fail-closed。
  - 重发的 revision 恒等于 `tunnel.config_revision`（测试 D 组锚定任何路径下
    都不抬高）；`error` 态受 `DEFAULT_RETRY_BACKOFF_MS` 退避保护，避免 Agent
    持续失败时控制面自我 DDoS。
  - 节点不可达（`status=inactive` / 上报过期 / 归属节点缺失）⇒ 全线不自动修，
    只产 `node_unreachable` finding；端口租约回收**复用 WP3 `reconcileLeases`**
    的孤儿判定，不复制第二套规则。
  - `config_revision = null` 的 legacy DIRECT 完全不在视野内（§5.2：legacy
    路径的真相在 config-generator / legacy allocator）。
- `backend/src/services/__tests__/reconciler.test.ts`：36 个离线用例（无
  MySQL / Redis / 网络），覆盖对比逻辑、白名单四项、禁令四项、revision 不抬高、
  节点不可达降级、legacy 不受影响、多隧道统计。
- CI（`.github/workflows/ci.yml`）散装单测步骤已加入 `reconciler.test.ts`。

**与 WP8 的边界（未在 WP9 内完成，等编排器接线）：**

- `ReconcileSink.resendSameRevision` 的生产实现（WP6 `createCommand` 信封 +
  transport）、worker 的周期调用（cron job）、以及把 finding 接到告警通道。
- reconciler 只声明「用哪个 revision 重发」，**不自己拼命令信封**：§7.13 禁止
  第二套下发逻辑，重发必须和控制面走同一条编排出口。

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

状态：**✅ 已合并 main 并经 CI 验证**（merge `2e7e9b4`）。

实现（service：`backend/src/services/node-admin.ts`，路由：
`backend/src/routes/node-admin.ts`，挂载于 `app.route("/api/admin", nodeAdminRoutes)`）：

- Node role：`PATCH /api/admin/node/:id/role`（role 必填，`port_range_min/max`
  与 `lb_strategy` 可选；节点获得出口能力时自动补建 `default` 池，取消出口
  角色时须先清池）；
- credential 状态读端点（**只查状态，绝不下发明文或哈希**，issue/rotate/revoke
  仍归 WP7）：
  - `GET /api/admin/node/:id/credential` —— 单节点状态；
  - `GET /api/admin/node/credentials` —— 全量状态 + 运行态摘要
    （`?role=` / `?online=` / `?stale=`）；
- EgressPool CRUD：
  - `POST /api/admin/node/:id/pools`、`GET /api/admin/node/:id/pools`、
    `PATCH /api/admin/node/pools/:poolId`、`DELETE /api/admin/node/pools/:poolId`、
    `GET /api/admin/node/pools`；
- EgressTarget CRUD：
  - `POST /api/admin/node/pools/:poolId/targets`、
    `GET /api/admin/node/pools/:poolId/targets`、
    `PATCH /api/admin/node/targets/:targetId`、
    `DELETE /api/admin/node/targets/:targetId`、
    `PUT /api/admin/node/pools/:poolId/targets`（整批替换，面板「保存池」）；
- runtime/state query（读 `node_state_report`）：
  - `GET /api/admin/node/:id/state`、`GET /api/admin/node/:id/detail`、
  - `GET /api/admin/node/states`（`?role=` / `?online=` / `?stale=`）。

`:id` 既接受数字主键也接受字符串 `node_id`（`resolveNodeId`）。

所有路径都落在 `nodes` 资源的 `/admin/node` 前缀下——`adminPermissionGuard`
按资源前缀 fail-closed 授权，前缀不对会 403。

防御性不变式（`poolHasViableTarget` / §2.2 硬规则）：

- 每个池至少保留一个 `active` 且 `weight > 0` 的目标：改 `weight=0`、把最后
  一个可用目标改成 `inactive`、删除最后一个可用目标、整批替换成空集，一律
  409 而不是让下发拿到空快照；
- `ingress` 角色不配池（无出口能力）；池被隧道引用时拒绝删除（409）；
- 自报角色（`state_report.role`）不覆盖面板 `node.role`，只报
  `role_mismatch`；
- 未配置 per-node `port_range` 时不回落节点组端口区间。

WP10 边界（不与 WP8/WP9 抢）：

- 本包只写 **desired state**；不做下发、不提 socket、不 import control-protocol
  或 portPool（由单测逐条守住）；
- 隧道运行状态 / retry-suspend-resume 归 WP11（unified orchestrator）。

测试：`backend/src/services/__tests__/node-admin.test.ts`（74 例全绿，纯内存
DB 替身，不连 MySQL/Redis/net；含对上述不变式的反向断言）。

#### WP11 Tunnel RELAY API

依赖 WP8/WP9：

- DIRECT / RELAY mode；
- explicit ingress；
- egress/pool；
- retry/suspend/resume/delete；
- 所有运行操作统一走 orchestrator。

禁止 route 自己写第二套下发逻辑。

**状态：✅ 已合并 main（merge commit `39a9c32`）。**

交付范围：

- 服务层：`backend/src/services/tunnel-api.ts`（期望状态 CRUD + 状态查询 +
  动作编排；`db` / `loadPolicy` / `applyCreate` / `applyReapply` / `orchestrator`
  全部可注入，离线单测无需 `mock.module`）。
  - `createTunnel`：DIRECT 落 `tunnel_mode=direct` 无编排；RELAY 先落
    `apply_status=pending` 再交 WP8 `createRelayTunnel`（§7.11 十步 + 补偿）。
    编排失败时**不删行**（§4.1），只把结果翻成 502 + `apply_error_code`。
  - `runTunnelAction`：retry（仅 `error`）/ suspend（幂等拒绝重复）/
    resume（`suspended`|`error`）/ delete（任意态）。前两者经 WP8
    `reapplyRelayTunnel` 对**已存在**的 tunnelId 重新下发；delete 经
    `orchestrator.removeTunnel` 撤两端（revision+1 绕开 Agent 的 stale 闸门）
    后再删行，补偿失败不阻断显式用户动作。
  - `updateTunnel`：RELAY 不得清空出口组（按**更新后**的 mode 判定，
    同 PATCH 里既改 mode 又清组的组合也拦得住）；转发目标形态校验。
- 编排入口复用：`backend/src/services/scheduler.ts` 新增
  `reapplyRelayTunnel(tunnelId, orchestrator, deps)` —— 复用模块内既有
  `pickNode` / `allocateTunnelPort` / `dispatchEgress` / `persistFailure`
  阶段函数，§7.11 编排顺序仍是单一真相源（`createRelayTunnel` 强制建新行，
  无法重入既有 tunnelId，故不能拿它做 retry）。
- 进程级接线：`backend/src/services/relay-wiring.ts` 惰性单例
  `getOrchestrator()`。取不到时停在 pending，**不假装成功**（§7.13），
  由 WP9 reconciler 的 `fill_missing_runtime` 稍后补发。
  已知过渡态（已在文件头如实记录）：WP7 per-node credential 是「验哈希」
  而 `tokenForNode` 是「发明文」，方向相反，暂以环境变量兜底。
- 端点：`backend/src/routes/tunnels.ts` 追加 v3 前缀一组
  （`GET /v3/modes`、`GET /v3`、`POST /v3/relay`、`GET /v3/:id/state`、
  `POST /v3/:id/{retry,suspend,resume}`、`DELETE /v3/:id`）。与 legacy
  路径分开，同一 URL 下不会出现两种语义。handler 只做解析/鉴权/调服务层，
  文件内无 `createCommand` / `dispatch*` / transport 调用（单测 E 组静态锚定）。
- 测试：`backend/src/services/__tests__/tunnel-api.test.ts` 33 条
  （CRUD、状态操作兼容矩阵、越权 404 不泄漏存在性、失败保留 Tunnel、
  未接线不假成功、结构约束），`bun test` 全绿；存量 12 条环境相关失败
  与 `main` 基线逐条一致（非本包引入）。

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

**状态：✅ 已完成（分支 `feature/v3-wp12-admin-web` 已 push，未开 PR）。**

交付范围：

- 路由：`/admin/nodes`（列表，新增角色徽章列 + 行内详情入口）与 `/admin/nodes/[id]`
  （详情；与既有 `/admin/[segment]` 动态段共存，实测 Next 16 无冲突）。
- 角色 / 端口区间：`role` 三元（ingress / egress / both）+ 「未声明」独立选项，
  显式 `null` 原样提交，**不得默认成 ingress**（§7.1：存量行「不改 / 不猜」）；
  端口区间 `port_range_min/max` 与默认池策略 `lb_strategy`（仅 egress/both 显示）。
- Credential：状态徽章（未签发 / 有效 / 已吊销）+ 签发、轮转、吊销三个动作，
  各自带确认弹窗（说明后果）；明文只在签发/轮转响应里出现一次，
  UI 复制后关窗即失，不写入 localStorage / URL / toast 正文。
- Egress Pool / Target：池 + 嵌套目标的增删改，`host:port` 分列、去重、范围校验。
- Runtime diagnostics：`/admin/nodes/:id/state` 最近一条上报（版本、revision、
  隧道快照、出口池快照、占用端口、最近错误）。
- 后端 WP10 未落地期间：mock 契约先行（`src/mocks/*`），详情页显著标注 MOCK；
  后端合并后删除 mock 分支即可，页面零改动。
- 测试：`web/src/components/admin/__tests__/wp12-node-management.test.ts`
  25 条 contract 单测（bun test，无 DB/浏览器依赖），已接入 CI web job。

#### WP13 Tunnel Web

- DIRECT / RELAY；
- ingress / egress；
- pool；
- pending/applying/active/error/suspended；
- retry；
- runtime binding/port。

可在 WP11 contract freeze 后开始，合并依赖 WP11。

**前端不得自己发明字段或临时 API。** Contract 改动必须回到对应 Backend WP。

**状态：✅ 已合并 main（merge commit `8997fb0`）。** WP11 已在 main（§7.13），契约已验证对齐。

交付内容（`web/src/`）：

| 能力 | 落点 |
| --- | --- |
| 列表 + DIRECT/RELAY mode 列 + apply 徽章 + 三种过滤（apply_status / tunnel_mode / pending_only）+ 关键字 | `components/tunnels/tunnel-list.tsx` |
| 详情（编排面板：状态/revision/两端节点/出口端口/出口池/错误原因/步骤回放/运行按钮） | `components/tunnels/tunnel-detail.tsx` + `components/tunnels/tunnel-orchestration-panel.tsx` |
| 创建（DIRECT/RELAY 选择、出口组、出口池候选、RELAY 下转发目标非必填） | `components/tunnels/tunnel-create-dialog.tsx` |
| v3 契约类型 + api 层（retry / suspend / resume / egress-pools） | `lib/types.ts`、`lib/api.ts` |
| mock 端点 + v3 seed（5 条隧道覆盖 5 种 apply 态、2 个出口池） | `mocks/handler.ts`、`mocks/data.ts`、`mocks/state.ts` |
| i18n（zh/en，`tunnel.v3*` 词条约 50 条） | `lib/i18n.ts` |
| mock 契约验证（44 断言全过） | `scripts/verify-wp13-tunnel-mock.ts` |

关键不变式（实现即约束）：

1. `tunnel_mode` / `apply_status` 为 NULL 的行 = 补列前存量隧道，UI 必须渲染「未声明 /
   无编排」，**不得**默认成 direct / active（§7.1 不改不猜）。
2. 运行操作按 §4.1 状态机启用：error → retry、active → suspend、suspended → resume；
   retry 重放相同 revision（不抬高），resume 与配置变更使 revision +1。
3. 详情/列表的状态真相是 `apply_status`；legacy `status` 开关列并行展示，不被替代。
4. error 态必须可解释（`apply_error_code` + `apply_error` + 步骤回放）且保留记录，不物理删除。

**Backend 侧（WP11）已在 main，前端 mock 与真实端点的差异：** mock 只覆盖 §4.1 主路径与常见拒绝，
未模拟编排超时重入、波长高并发下发、端口耗尽等真实竞争；这些竞争由 WP11 的服务层单测与
WP14 Real E2E 覆盖，前端契约层（types.ts / api.ts）无需改动。

#### V4 产品层收敛（Node-first + Forward）

WP13 的 Tunnel Web 已完成其 v3 技术验证使命；V4 不删除 Tunnel runtime，而是把用户产品层
收敛成 Node + Forward：

- `/nodes` 只负责 Agent 生命周期、角色、安装与 Ingress→Egress Binding；
  不在节点页维护 Forward CRUD。
- `/forwards` 是唯一用户业务入口，同时承载 DIRECT 与 RELAY；创建时直接选择实际 Node。
- `/api/forwards` + `ForwardService` 是新的用户业务 API / Service 单一入口；
  旧 `/api/nodes/:ingressId/forwards` 只在兼容窗口保留并委托同一个 Service。
- `/tunnels` Web 路由只做重定向；旧 `/api/tunnels` 继续作为兼容 API，但响应显式
  `Deprecation` / successor headers，不再承载新 UI。
- Forward 详情、流量、运行操作全部通过 `/api/forwards/:id*`，UI 不再引用 TunnelDetail。
- RELAY 创建允许在同一流程内完成出口绑定；没有可用出口节点时才回到 Node 管理。
- Forward 列表提供 mode / apply-status / keyword 过滤与工作空间级监控摘要
  （总数、DIRECT/RELAY、active/pending/suspended/error、累计流量）。
- 移除 Web 端 node-scoped Forward client；等兼容窗口结束后再独立删除后端旧路由，
  不在同一 PR 里把兼容删除与产品 UI 重构绑在一起。
- V4.3 收尾删除旧用户侧 `components/tunnels/*` UI 与 `api.tunnels` /
  用户侧 `egressPools` client；`/tunnels` 页面只保留到 `/forwards` 的重定向。
- legacy Tunnel mock/API 契约测试迁入
  `components/forwards/__tests__/legacy-tunnel-compat.test.ts`，只用于兼容窗口守护，
  不再代表用户产品界面。
- Admin 的 `/admin/tunnels` 继续保留运行诊断/管理能力，它与用户侧 Forward 产品入口
  是不同层级，不参与上述删除。

V4 的单一边界仍是：

```text
UI Product Layer
→ /api/forwards
→ ForwardService
→ Tunnel desired/runtime
→ Scheduler / Orchestrator
→ Agent TunnelManager
```

因此 V4 是**产品与控制面解耦**，不是重写 Agent 或复制一套 Forward runtime 表。

---

### 7.15 WP14 — Real E2E / Release Gate ✅

**Track：D/Shared。状态：已完成并进入 main Integration。**

WP14 最终收敛为一条可重复、自动化、不能伪造通过的真实网络 Gate。CI 会启动真实 Backend / Worker / Ingress Agent / Egress Agent / Target A / Target B，并验证至少一个 Agent 只通过主动出站控制链路工作。

当前正式自动 Gate（`scripts/v3-e2e/setup.sh` + `verify.sh`）覆盖：

- T0：控制面、Worker、双 Agent、双 Target 拓扑健康；
- T1：Agent 无 host 管理端口，Panel 不接数据网，证明 outbound-only 控制约束；
- T2：DIRECT / RELAY concrete ingress/egress binding、revision ACK 与 NodePortLease 完整；
- T3：真实 TCP DIRECT 与 RELAY 数据面，且目标不串台；
- T4：DIRECT suspend / resume，原端口与 durable lease 保持；
- T5：Ingress/Egress Agent 重启后从 desired snapshot 恢复 DIRECT / RELAY；
- T6：per-node credential 鉴权与节点级 desired-state 隔离；
- T7：Workspace / NodeGroup 跨租户负面隔离；
- T8：生产 Worker 确实调度 `cron_reconcile_v3`。

此外 Integration 还要求：

- Agent Docker image build + smoke test；
- unified TuneX image build；
- unified runtime smoke test；
- production/development Compose wiring validation。

主分支 `3f4b905` 对应 CI、Integration、Release 均已通过。

早期 §7.15 的 18 项清单把“核心发布 Gate”“高级 LB/拓扑能力”“运维灾备演练”混在了一起。当前以以上自动化 Gate 作为 **WP14 完成标准**；weighted target / hot update / change Egress 等高级能力继续由对应 service/unit/E2E 与 WP16+ contract 承担，backup/restore 属于 `scripts/ops/` 与生产演练，不再阻塞 WP14 状态。

---

### 7.16 WP15 — DIRECT v3 Migration ✅

**Track：B/C；状态：已完成。**

WP15 已按“删除，不并存”的决定执行完成：

- merge `cdfc3f9`：删除 legacy engine，DIRECT 全面走 v3 runtime；
- follow-up `95d4c6c`：补齐 concrete ingress binding、outbound-only Agent command bus、DIRECT/RELAY 统一编排、desired restore、Reconciler 接线、NodePortLease 幂等 resume 和真实 Integration Gate。

当前唯一执行路径：

```text
DIRECT → TunnelManager → SingleHopForwarder → Target
RELAY  → TunnelManager → SingleHopForwarder → Egress runtime → Target
```

DoD 已落地：

- Agent 不再存在第二套 DIRECT data-plane engine；
- DIRECT / RELAY 共用 TunnelManager、revision / ACK、desired restore 与共享 port guard；
- `NodePortLease` 覆盖 DIRECT / RELAY 实际端口并防止物理端口双绑；
- DIRECT 创建、retry/resume/suspend/delete 都走 persisted runtime binding 和 v3 orchestrator；
- Reconciler 只按已持久化 topology 重放同 revision，不重新猜 Node；
- 旧 Agent 兼容按发布版本边界处理，不通过保留第二套 runtime 实现；
- DB 仍保持 additive，正常回滚方式是回滚整组镜像而不是 destructive schema downgrade。

“legacy”一词后续只允许用于历史数据库升级 fixture、兼容 API 或文档历史说明，不得代表仍存在一套 legacy DIRECT runtime。

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

项目继续使用 **Integration Gate + Active WP Set**，但核心迁移 Gate 已全部关闭：

```text
Gate F0  文档/架构冻结                 ✅
Gate F1  Schema Contract merged         ✅
Gate F2  Runtime Foundations merged     ✅
Gate F3  RELAY Control Plane integrated ✅
Gate F4  API/Web integrated             ✅
Gate F5  Real E2E passed                ✅（WP14）
Gate F6  DIRECT v3 migrated             ✅（WP15）
```

当前 Active Core WP：

```text
- none
```

后续出现 WP16+ 时，为该能力单独建立 contract 和 Integration Gate；兼容 API 删除也必须作为独立 breaking-change PR 处理。

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

### 8.5 回滚路径：镜像，不是双实现

- 代码回滚 = 回滚 Backend/Web/Agent 镜像到上一版本，**不**在代码里长期保留
  「走新实现 / 走旧实现」的运行期双分支。双实现等于两套真相，比回滚成本更高
  （本条由用户决定，见 §7.16 WP15 的新定义）。
- DB 仍坚持 additive（§6）：保留新增 schema，禁止把 DROP 列 / 逆迁移当作
  普通代码回滚的前置条件。
- WP15 的 legacy DIRECT engine 已删除。后续仍保留的 legacy/compat 仅指历史升级 fixture
  与 deprecated HTTP API；删除兼容 API 时按独立 breaking-change 发布处理。

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

- 数据平面能力必须增加真实网络测试，不能只依赖 mock。
- WP14 已完成；当前 main 的 CI → Integration → Release 链必须持续保持全绿。
- 任何 WP16+ 跨 Track 能力都必须新增或扩展对应真实 Integration Gate，不能只靠单元测试宣称可发布。
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

核心 v3 / V4 收敛阶段已经完成。当前 `main` 的发布链为：

```text
PR CI + Integration
→ merge main
→ main CI
→ main Integration
→ Release
```

### 当前 Integration Gate

```text
Gate F0  文档/架构冻结                 ✅
Gate F1  Schema Contract merged         ✅
Gate F2  Runtime Foundations merged     ✅
Gate F3  RELAY Control Plane integrated ✅
Gate F4  API/Web integrated             ✅
Gate F5  Real E2E passed                ✅（WP14）
Gate F6  DIRECT v3 migrated             ✅（WP15）
```

### 已完成的核心 Work Package

```text
WP0  架构/文档冻结             ✅
WP1  v3 Schema 契约            ✅
WP2  Legacy Backfill           ✅
WP3  NodePortLease / Allocator ✅
WP4  Agent v3 Runtime          ✅
WP5  TCP RELAY Data Plane      ✅
WP6  Command / Revision / ACK  ✅
WP7  Node Credential / State   ✅
WP8  Scheduler + Orchestrator  ✅
WP9  Reconciler / Retry        ✅
WP10 Admin Node / Egress API   ✅
WP11 Tunnel Runtime API        ✅
WP12 Admin Web                 ✅
WP13 Tunnel Web（历史产品层）   ✅
WP14 Real E2E / Release Gate   ✅
WP15 DIRECT v3 Migration       ✅
V4   Node + Forward 产品层收敛 ✅
```

### 当前 Active WP

```text
Active Core WP:
- none
```

当前维护重点：

1. 保持 Node = infrastructure、Forward = user business、Tunnel = internal runtime 的边界；
2. 生产部署、升级、回滚、备份/恢复与告警演练；
3. 管理 deprecated compatibility API 的生命周期；
4. 新能力进入 WP16+，按独立 contract → implementation → tests → real E2E → release gate 推进。

### Compatibility API（P1）

仓库内新的 Web 产品代码已经不依赖旧接口。当前仍暂留：

- `/api/tunnels`
- `/api/nodes/:ingressId/forwards`

两者均带 deprecation / successor headers，并委托现有 Forward/Tunnel service，不存在第二套 runtime。对应兼容测试为
`web/src/components/forwards/__tests__/legacy-tunnel-compat.test.ts`。

从仓库内部依赖看可以删除，但这会破坏仓库外旧客户端，因此**不是普通清理提交**。删除时必须：

- 单独 breaking-change PR；
- 明确发布说明与版本边界；
- 同时删除兼容 mock/test；
- 新集成一律只使用 `/api/forwards`。

后续开发、分支、PR 和合并判断继续以第 7 节的依赖规则与 Integration Gate 为准。

# TuneX 开发方案（V4 已收口 / V5 下一阶段）

> **文档地位：本文件是 TuneX 唯一可执行的开发方案（Single Source of Truth）。**
>
> 后续功能设计、Issue、分支、PR、验收与发布均以本文件为准。不得再创建第二份路线图、迁移方案或并行开发计划。
>
> `docs/tunex-devmap-v3.md` 是 **已完成的 v3 架构基线约束**：规定底层 Node / Tunnel / runtime 的关键语义。V4 已于 2026-10-03 完成技术收口；本文件继续作为唯一开发方案，保留 V4 的冻结基线，并由 §14 承接 V5。若旧文档中的目录、传输方式或产品入口与当前代码事实冲突，以本文件和 `main` 为准，同时不得破坏已经稳定的 v3/V4 runtime 不变式。
>
> `docs/production-deploy.md` 是运维手册；`reports/` 是历史验证证据。它们都不是开发路线。

---

## 1. V4 已完成：产品基线

TuneX 的核心 v3 网络架构升级、WP14 Real E2E Gate、WP15 DIRECT v3 Migration，以及 V4.0 的 Node + Forward 产品入口收敛均已进入 `main`。2026-10-03，最终收口提交 `dd95713` 通过 CI #493 → Integration #139 → Release #30，V4 技术范围正式冻结。

V4 的完成定义为：

**细节优化 + 功能补全 + 生命周期闭环。**

V4 不是第二次架构重写，也不以增加 UDP / QUIC / multi-hop 等新协议为主目标。它要把已经能跑的 TCP DIRECT / RELAY 做成完整、可编辑、可维护、可监控、权限边界清晰的产品。

V4 的优先级固定为：

1. **Forward 完整生命周期**：创建时可设置的业务字段，创建后原则上全部可编辑；业务资源 ID 不因修改而变化。
2. **Agent 热重载**：Forward 修改通过 revision / desired state 下发，Agent 不因普通配置修改重启进程或容器。
3. **Node 托管生命周期**：采用 V4 托管版模型，区分 Connection / Lifecycle / Health，并支持维护、停用、退役和安全删除。
4. **Agent 主动状态上报**：继续沿用 outbound-only 控制链，扩展现有 `NodeStateReport`，为节点监控和健康判断提供事实。
5. **监控与交互补全**：让错误可解释、可行动；让 Dashboard、Forward、Node 页面围绕用户任务而不是内部 runtime 字段组织。
6. **权限模型收敛**：在产品资源和生命周期稳定后，最后统一澄清 Workspace RBAC、资源作用域、Capability/Quota、NodeGroupGrant 的边界，并决定 NodeGroup 的最终用户语义。
7. **稳定发布与兼容收尾**：真实 E2E 覆盖编辑/热重载/维护/退役；deprecated API 是否移除由独立 breaking-change 决策，不夹带在普通功能 PR 中。

后续仍保留已经稳定的 Workspace、认证、策略额度、流量、CI 和生产运维底座。网络层的事实源已经收敛为 Node 角色、Forward/Tunnel desired state、具体 ingress/egress binding、NodePortLease、revision/ACK 和 Reconciler；V4 **不得**重新引入第二套 DIRECT engine、第二套端口所有权、第二套用户侧 Tunnel 产品模型或另一套 Agent 控制链。

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
| V5 | Advanced Networking / Resilience / Federation | 多 Track | V4.5 stable 后启动 | 每项单独 contract + tests + real E2E + release gate |

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

#### V5 新能力

UDP、WS/TLS、QUIC、advanced LB、DNS、multi-ingress HA、automatic failover、multi-hop、Panel federation 等统一按 §7.17 的 V5 路线独立 contract / tests / real E2E / release gate 推进。

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

早期 §7.15 的 18 项清单把“核心发布 Gate”“高级 LB/拓扑能力”“运维灾备演练”混在了一起。当前以以上自动化 Gate 作为 **WP14 完成标准**；weighted target / hot update / change Egress 等高级能力继续由对应 service/unit/E2E 与 V5 contract 承担，backup/restore 属于 `scripts/ops/` 与生产演练，不再阻塞 WP14 状态。

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

### 7.17 V5 — 高级网络能力、韧性与联邦

V4.5 stable 后，协议、高级网络能力与跨控制面能力统一进入 V5；每个能力必须自己走：

```text
contract
→ implementation
→ tests
→ real E2E
→ feature flag
→ grey release
→ stable
```

V4.5 之前不以“参考项目已有”作为提前引入高级协议的理由。优先顺序调整为：

1. UDP
2. WS/TLS
3. QUIC
4. target health / latency observation
5. circuit breaker / advanced LB
6. DNS
7. multi-ingress HA
8. automatic failover
9. multi-hop
10. Panel federation / cross-workspace external sharing（单独架构评审）

其中 target health/latency **先做观测，再做自动决策**：先让用户看见目标可达性、延迟、失败次数和恢复事实；circuit breaker / automatic failover 必须在观测数据稳定、误判边界和恢复策略有 Real E2E 后才允许自动切流。

Panel federation 不属于 V4-WP10 NodeGroup 重构。WP10 只冻结单控制面内的 RBAC / Resource Scope / Grant；跨 Panel 信任、远端 lease、远端配额与分布式 reconcile 必须留在 V5 单独设计。

同一底层模块冲突严重的能力不得强行并行。

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

v3 迁移阶段当前没有 Active Core WP：

```text
- none
```

V4 的 Active Plan、并行 Track 与 Gate 已迁移到第 13 节；V4.5 stable 后统一进入 V5，为新协议/高可用/联邦能力单独建立 contract 和 Integration Gate。兼容 API 删除仍必须作为独立 breaking-change PR 处理。

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

任何 V4 PR 至少满足受影响范围的全部检查；合入主线的阶段性 PR 必须整套 CI 全绿：

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
- 任何 V5 跨 Track 能力都必须新增或扩展对应真实 Integration Gate，不能只靠单元测试宣称可发布。
- 并行 PR 各自 CI 通过不等于集成完成；跨 Track 能力必须在对应 Integration Gate 再验一次。

---

## 10. 分支、PR 与提交约定

第 7 节以下命名保留为 v3 历史示例。**当前 V4 新分支必须使用 §13.9 的 `feature/v4-wp*` / `test/v4-wp*` 命名。** v3 历史命名例如：

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

禁止创建“v3-next”“v3-all”“v4-all”“next-stage”这类把多个 WP 混在一起的总分支。

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

核心 v3 runtime 与 V4.0 Node + Forward 产品入口已经稳定进入 `main`。当前发布链保持：

```text
PR CI + Integration
→ merge main
→ main CI
→ main Integration
→ Release
```

### 已完成的历史 Gate

```text
Gate F0  文档/架构冻结                 ✅
Gate F1  Schema Contract merged         ✅
Gate F2  Runtime Foundations merged     ✅
Gate F3  RELAY Control Plane integrated ✅
Gate F4  API/Web integrated             ✅
Gate F5  Real E2E passed                ✅（WP14）
Gate F6  DIRECT v3 migrated             ✅（WP15）
V4.0     Node + Forward 产品入口收敛    ✅
```

### V4 当前执行状态

```text
V4-WP0  V4 产品/团队开发方案冻结             ✅
V4-WP1  Forward Revision Foundation           ✅ main
V4-WP2  Agent Hot Reload Primitives           ✅ main
V4-WP3  Forward Rollout Orchestrator          ✅ main
V4-WP4  Forward Edit Product UX               ✅ main
Gate F1 Forward Fully Editable/Hot Reload     ✅ 完成

V4-WP5  Node Lifecycle Foundation             ✅ main
V4-WP6  Agent Telemetry & Node Health         ✅ main
V4-WP7  Node Lifecycle Product UX             ✅ main
V4-WP8  Monitoring & Actionable Diagnostics   ✅ main
V4-WP9  Scale & Interaction Polish            ✅ main

Gate F2 Managed Node Lifecycle + Telemetry     ✅ 完成
Gate F3 Monitoring / Scale / UX Complete      ✅ 完成

V4-WP10 Authorization + NodeGroup Model       ✅ main
Gate F4 Authorization / NodeGroup             ✅ 完成（PASS=58 / FAIL=0）
V4-WP11 Stable / Ops Hardening                ✅ main
Gate F5 Durability / Ops / Capability         ✅ 完成（PASS=133 / FAIL=0）
V4.5 Stable 技术发布闭环                      ✅ CI #493 / Integration #139 / Release #30
```

### 2026-10-01 恢复开发：WP10 / WP11 进度快照

**这一节的结论只区分两种证据：**
（a）本机可运行的自动验证（typecheck + 单元/路由测试）；
（b）必须在真实多 Agent 拓扑里跑的 Gate。
**本机没有 Docker daemon，因此（b）全部标注为"未运行"，不得当作通过。**

已完成并经本机自动验证：

```text
V4-WP10 权限内核              backend typecheck + 新增 90+ 测试通过
   · 非 owner 绑定自定义角色 = 替换基础权限（悬空/跨空间/损坏引用 fail-closed）
   · forward:* 为规范键，legacy tunnel:* 兼容读取；显式 false 优先
   · 新旧 Forward/Tunnel/Node 入口共用同一资源级判定，成员仅能改自己创建的转发
   · 批量动作逐项鉴权（拒绝项不写库、不发命令）
   · 自定义角色 CRUD + 成员角色分配（含权限子集约束、owner 保护、绑定中不可删）
   · 重装（reinstall/enroll）不再重写既有 role/端口区间/地址/出口目标
   · 转发编辑与 retry/resume 走真实能力+额度+资源授权准入（不占用创建数量额度）
   · Web 从服务端投影有效权限；403 不再跳登录页；Forward 按 creator 控制操作

V4-WP11A Agent 耐久性          go vet + go test ./... 全绿（新增 20+ 用例）
   · 本地已知良好配置（LKG）缓存：0600/0700、原子写、schema+agent_id 校验、拒绝符号链接
   · 仅"面板不可达"才回退缓存；401/403/404、载荷损坏、身份不符一律 fail-closed
   · 只有真正 applied 的转发进入缓存；全部失败不清空既有缓存
   · 面板恢复后进行权威对账，清理面板已不再列出的 runtime（缓存来源绝不作为裁剪依据）
   · 统一关机原语：先拒绝新配置 → 关闭监听（新连接立即被拒）→ 单一截止时间排空
     → 超时强制关闭 → 有界最终状态上报

V4-WP11B 控制协议协商          backend 1210 测试通过 + agent 全绿（新增 20+ 用例）
   · Agent 上报 control_protocol_version 与 capabilities，能力清单**由 execute 的
     真实分支派生**；测试逐一驱动清单里的动作，证明"上报的"与"实现的"不会漂移
   · 未实现的契约动作（update_targets / state_request）明确不上报
   · 面板校验器白名单投影这两个字段；坏形状 → bad_capabilities（拒绝，不退化成"未上报"）
   · 落库 control_protocol_version / capabilities（迁移 20261012000000，SQL 由
     prisma migrate diff 生成）；admin 单节点与全量视图原样投影，null ≠ []
   · 下发前闸门：未上报 → 只放行协议冻结的基线动作；上报了但不含该动作 → 拒绝；
     空清单 → 连基线也拒绝；库里的坏形状 → 拒绝（不是放行）
   · 重装会让旧上报失效：凭据签发晚于最后一次上报 ⇒ 视为未上报（避免"用上一个
     进程的能力描述去放行新动作"）
   · 闸门在入队之前失败，不产生任何队列写入

V4-WP11B 命令通道加固          backend 1210 测试通过（含 12 个 ACK 绑定用例）
   · 只有"本面板确实下发且未过期"的 command_id 才接受 ACK（伪造 command_id → 400）
   · 首答优先（重复 ACK 不能改写已存结果）；applied_revision 超前于下发版本被拒
   · 超时/消费后清理 pending，迟到 ACK 不可被当作后续命令的答案
   · Agent 侧校验 envelope 的 resource_id / revision 与 config 一致，过期时间非法即拒

V4-WP11D 运维脚本修复           bash -n 全过；回归守卫写在 F5 Gate 内
   · restore.sh：改用 docker inspect 定位 Redis 卷（compose inspect 不是 v2 子命令）
   · restore.sh：恢复期间停止 backend/worker/web，EXIT trap 保证一定重启
   · restore.sh：不再用 mysql --force 掩盖 SQL 错误
   · backup.sh：去掉 config.tar.gz 二次压缩；BGSAVE 超时改为 fail-closed
   · backup.sh / restore.sh：口令改用 env: 传递，不再出现在 argv
   · rollback.sh：健康门改为 /readyz（MySQL+Redis）；端口按实际栈解析；新增迁移兼容自检
   · 开发栈 Redis 改回 RDB（与生产一致），否则替换 dump.rdb 的恢复是"假恢复"
```

**真实拓扑 Gate 结果（2026-10-02，四 Agent 拓扑 `scripts/v3-e2e`）：**

```text
v3 baseline verify        PASS=51 / FAIL=0
V4-F1 rollout             PASS=30 / FAIL=0
V4-F1 rollout REST        PASS=67 / FAIL=0 / DEFECT=0
V4-F1 S10 中断/恢复        PASS=58 / FAIL=0 / LIMITED=0 / DEFECT=0
V4-F1 topology            PASS=32 / FAIL=0
V4-F2 managed node        PASS=37 / FAIL=0
V4-F3 product closure     PASS=21 / FAIL=0
V4-F4 authorization       PASS=58 / FAIL=0
V4-F5 durability/ops      PASS=133 / FAIL=0  ← 含升级闭环、Forward/Node 诊断、
                                               关机排空、能力协商、运维脚本与
                                               真实备份/恢复演练（F5.13）
```

两个新 Gate 已接入 `.github/workflows/integration.yml`（F3 之后依次执行）。
证据文件：`scripts/v3-e2e/evidence/v4-gate-f4-result.txt`、`v4-gate-f5-result.txt`。

**首次真实运行在 F4/F5 里查出的真实产品缺陷（均已修复并补测）：**

```text
1. 状态上报 targets:null 被拒 → 该节点上报永久 400（F5 首次运行暴露）
   Go 的 nil slice 序列化为 null，而校验器把 null 当成类型错误。受影响的是
   **每一条 RELAY 入口隧道**，即面板会永久失去这些节点的遥测/健康判定。
   修复：校验器把 null 与「缺该键」视为同一事实；Agent 侧对空目标改用
   omitempty，不再产出 null。两侧各加回归测试。

2. 停机期间重启的 Agent 永不与面板对账（F5.5 首次运行暴露）
   恢复来源是本地缓存时，进程从未观察到"拉取失败"，因此首次成功拉取不会触发
   对账 —— 面板已删除的转发会一直跑下去。修复：控制循环记录"启动即来自缓存"
   并在面板可用后立即对账（event-only 刷新也补齐：管理器加变更钩子，缓存随
   真实变更更新，而不是只靠 5s 周期采样）。

3. 批量动作的拒绝项用了另一套错误码（F4.9 首次运行暴露）
   单资源端点用 `forbidden`，批量项却回 `permission_denied`，前端需要两套映射。
   修复：统一为 `forbidden`，并补 `error_layer`。
```

**第二轮子代理审计发现并已修复的真实缺陷（安全相关优先）：**

```text
1. RELAY 诊断会直连业务出口端口（P0）
   "入口↔出口"那一段的目标是出口节点的业务 EGRESS listener：拨它会触发真实
   业务连接（accept → 选目标 → 建上游 → 计入业务连接与 Stats），所以"诊断不占
   业务连接/不计流量"的说法当时并不成立。修复：该段改为**只核对两端上报的运行态
   事实**（运行时是否存在、revision 是否收敛）并标注 method=node_facts、
   verified=false，报告与"下一步"都不再声称该段可达；出口→目标一段仍直探目标。

2. 诊断结果没有与请求绑定（P1）
   pending 记录原来只有 command_id/action/revision，ACK 也不回显绑定；且诊断的
   revision 为 0 时整段校验被跳过。修复：pending 先于入队写入、携带 expires_at 与
   期望目标集；Agent 回显 action/resource_id；结果必须**完整且一一对应**请求目标
   （缺项/多项/重复/未请求目标一律拒绝），否则"没探到 B"会被读成"链路正常"。

3. 诊断契约只加了枚举，validator 没有对应 case（P1）
   `CommandPayload`/`ACTION_PAYLOAD_KEYS`/`validatePayload` 都没有诊断分支，
   `ControlValidator.execute` 还会把只读动作送进变更路径（应用 revision 闸门、推进
   状态）。修复：补齐 payload 白名单与值域校验、补只读 dispatch，并由
   issueAgentDiagnose 走同一份契约校验，不再靠 `as unknown` 旁路。

4. LKG 缓存会复活已删除的转发（P1）
   Save 拒绝空快照 + SnapshotOf/RefreshCache 在"最后一个转发被删/暂停"后返回 nil，
   于是磁盘上永远留着旧配置；面板停机重启时它就被恢复回来。修复：区分两种答案——
   **权威的空**（写入墓碑）与**未知（nil）**（拒绝覆盖）；缓存改为记录
   manager 真实 running 集合（幂等 retarget 不会再写入从未生效的新 payload）。

5. 快照校验过松 + nil 崩溃
   Snapshot.Validate 只校验 version/ID/mode；IDSet 在 nil 接收者上先 len() 会 panic。
   修复：严格校验版本标识、revision>0、重复 ID、target 上限与 cfg.Validate；
   IDSet 先判 nil。

6. 脱敏层的性能与顺序问题
   base64 规则的 lookahead 会在长值上近似二次扫描（200×4KB 需要数秒），且已知密值
   是在截断之后才清除的（可能只清掉一部分）。修复：改为匹配后再判字符类、正则输入
   先封顶、已知密值在任何截断之前清除、保留 Date 时间戳、修正递归深度被重置的问题。
```

**F4/F5 Gate 脚本自身也修了若干缺陷**（首次运行时才暴露）：历史断言查询用了不存在的
`forward_id` 列；`data` 为数组时 `layer()` 崩溃；`expect()` 在拼错误信息时对非 dict
响应体调 `.get`；compose 调用误用容器名导致 stop/start 静默失败；`up` 连带启动依赖
服务把"面板停机"场景变成"面板健康"；断言的端口/目标选错导致连接探针无输出。

**F5 DoD 逐项状态（不得笼统宣称"F5 完成"）**：

```text
LKG runtime cache                ✅ 实现 + Gate F5.2/F5.3/F5.4 真实覆盖
graceful drain / shutdown        ✅ 实现 + Gate F5.6 真实覆盖（关闭监听/排空/强制收敛/最终上报）
protocol capability 协商          ✅ 实现 + Gate F5.9 真实覆盖（含迁移与投影）
agent reinstall 关系保持          ✅ 既有 F2 + Gate F4.42 覆盖
agent upgrade 闭环               ✅ 已实现并由 Gate F5.11 真实覆盖：
                                   `POST /api/nodes/:id/upgrade-command` 渲染升级脚本
                                   （先拉取后停机 → SIGTERM 优雅排空 → 复用宿主 agent.env
                                   与 LKG 目录重建 → 身份校验 → 失败自动回退）。脚本不含
                                   凭据、镜像引用经过校验、变量做 shell 净化。真实拓扑上
                                   验证了：排空期间新连接被拒、重建后 agent_id/node 行不变、
                                   既有 Forward 再收敛、以及**用回退锚点真的换回旧镜像**后
                                   数据面恢复。
Forward/Node diagnose            ✅ Forward 与 Node 两级都已实现并由 Gate F5 真实覆盖：
                                   · F5.10 Forward 诊断（DIRECT 直探 / RELAY 分段）；
                                   · F5.12 Node 诊断：新增只读动作 `collect_diagnostics`，
                                     Agent 侧 internal/selfinfo 按**白名单**自述版本/进程/
                                     运行中 runtime/LKG 状态，面板侧先用上报新鲜度**判活**
                                     （离线直接结构化返回，不下发命令、不等超时）。真实
                                     Gate 验证了自述事实、报告不含配置目标与凭据、停机节点
                                     有界返回且带解释。
                                   历史说明（Forward 诊断的分段语义）：
                                   DIRECT 直探目标；RELAY 分段——"入口↔出口"一段只核对
                                   两端上报的运行态事实并标注 verified=false（**不拨业务
                                   监听端口**，否则会产生真实业务连接），出口→目标一段仍
                                   直探。
Support Bundle                   ✅ Panel 侧：白名单逐字段投影 + 确定性脱敏两道防线、
                                   按调用者权限裁剪 forward/audit 段落、条数与字节上限并显式
                                   标记 truncated。**Agent 侧**：collect_diagnostics 的自述
                                   事实作为独立段落并入产物（版本/进程/listeners/LKG 状态），
                                   离线时产物照常生成并写明"为什么没有这一段"。
                                   未含：容器内 service 状态/系统路由表（需要额外探针，
                                   当前不在白名单内）。
full real E2E                    ✅ F1–F5 全部真实通过（见上表）
backup/restore 演练               ✅ Gate F5.13 在真实栈上跑完整链路（备份 → 打 canary →
                                   恢复 → canary 消失、行数/迁移表与备份一致、面板与
                                   Agent 恢复可用）。演练查出并修掉 6 个真实缺陷，
                                   详见 docs/release-notes-v4.md
兼容 / 回滚 / 文档                ✅ 兼容端点保留（旧权限键/旧路由/字段别名都不删）、
                                   rollback/backup/restore 脚本已修并有守卫测试；
                                   发布说明见 docs/release-notes-v4.md（列明已验证能力与
                                   明确的已知边界，不写未验证的事）
前端入口（Track D）               ✅ Forward 详情内嵌诊断面板；Node 页面内嵌诊断 /
                                   支持包下载 / 升级命令生成；渲染不变量与 mock 契约均有
                                   单测，且已进 CI 的测试目录清单
```

**Gate 套件可重复性（本轮修，两处同类缺陷）**：

```text
· 拓扑 Gate：只清入口 A 上第一个同名残留 → 被中断的运行把残留留在入口 B，迁移到
  B 时收到 409 port_conflict。现在两端都清，并显式断言"入口端口开始前是空闲的"。
· 升级 Gate 的回退锚点不能取自"节点当前跑的标签"：那会让用例自我指涉——上一次运行
  留下的标签被当成新基线，节点被永久钉在测试标签上（随后 S10 的镜像断言就失败了）。
  锚点改为**环境基线镜像**，并显式断言节点起点就是基线。
· rest Gate：S3 故意迁移 listen_port 却不还原 → 下一次 v4-gate.sh 拿 state.json 的
  原始端口探针，得到"基线读不到 marker"，把夹具漂移报成产品失败。现在收尾有 S7
  还原步骤并断言原始端口真实可读、revision 已收敛。

实测：先跑 rest（67/0）再跑 v4-gate.sh（30/0）与反向顺序都通过，Gate 结果不再依赖
运行顺序。这两处都属于"报告看起来像产品缺陷、实际是夹具/环境"，必须修掉，否则
Gate 的结论无法被信任。
```

**Gate 脚本对"上一次被中断"的健壮性（本轮修）**：拓扑 Gate 原来只删除
**入口 A** 上第一个同名残留转发，而上一次被中断的运行把残留留在了**入口 B**，于是
迁移到 B 时收到 409 `port_conflict` —— 产品行为是对的，报告却像产品缺陷。现在两端
都清、并显式断言"入口端口在开始前是空闲的"（F1.0），把夹具问题与产品问题分开。

**本轮（WP11A 收口 + WP11B 升级闭环）修掉的真实缺陷**：

```text
1. 生产下发入口没有关机闸门
   Apply 有 closing 检查，但控制面实际走的是 ReplaceListener / HotSwapUpstream ——
   两个入口都没有。shutdown 之后仍可能重新 bind listener。修复：三个入口同一个锁内
   先拒后动，并补"closing 之后 ReplaceListener 必须被拒"的反例测试。

2. 关机顺序错：先 fsync/上报，最后才关监听
   原顺序是 RefreshCache（磁盘 fsync）→ BeginShutdown → 等最多 3s 上报 → 才关
   listeners。也就是说 SIGTERM 之后新 TCP 还能进来，且"最终上报"描述的不是关完后的
   事实。修复：拆成两阶段——BeginShutdown + CloseListeners 同步先做（新连接立刻被
   拒），再做有界的缓存快照与上报，最后用**同一个绝对 deadline**排空并强制关闭；
   总时长仍受 ShutdownTimeout 约束。

3. 强制关闭只关客户端连接，对端不作声就永远卡住
   PipeConns 双向拷贝，只 Close 客户端时若对端忽略 FIN，上游读会一直阻塞，handler
   与 shutdown 都会越过 deadline。修复：连接对的两端都登记并在 deadline 时一起关闭；
   新增"永不作声的对端"测试。

4. 缓存写并发无护栏
   Shutdown 把 rt.cacheTick 置 nil 而 writer goroutine 仍在读该字段（竞态 + 可能 nil
   deref），且多个写入者可能让旧快照 rename 覆盖新快照（把"最后已知良好"往回滚）。
   修复：writer 捕获局部 ticker、Shutdown 用 WaitGroup join、所有写入共用一个 mutex，
   恢复路径也走同一把锁；补并发写入完整性测试。
```

**WP11C 本轮补完（Node 诊断 + Agent 侧 Bundle 段落）**：

```text
· 新增只读动作 collect_diagnostics（冻结契约的一部分：ACTION_SPECS、payload 白名单、
  只读 dispatch、能力协商、ACK 结果校验全部到齐）。它的 payload 是**空的**——
  一个"带参数的自检"就是远程管理面。
· Agent 侧 internal/selfinfo 是白名单采集器：版本/角色/agent_id/进程事实/运行中的
  runtime（id、mode、端口、revision）/LKG 状态目录事实。**刻意无法返回**配置值、
  目标地址、凭据、环境变量、文件内容或命令输出；列表与字符串都有上限，截断显式可见。
· 状态目录探针用节点**自己的** agent_id 校验缓存——用空 id 校验会永远报"无效"，
  把一个健康节点变成假故障（实现时先写成空 id，被测试抓出来后修正）。
· 面板侧先判活：上报超过 75 秒即 `offline`，直接返回事实与下一步，**不下发命令、
  不等 20 秒超时**（这正是审计指出的"对离线节点无限 pending"）。
· Support Bundle 并入该段落；离线时产物照常生成，并用 `agent_facts_error` 说明缺因。
```

**WP11 逐项状态已全部收敛到 ✅（含明确记录的边界），因此 F4 / F5 可以按证据关闭。**

**上述三项现已全部实现并由真实 Gate 覆盖**（本节保留原缺口清单是为了让"为什么需要
它们"有据可查）：

```text
WP11B 控制协议能力协商      ✅ NodeStateReport.control_protocol_version / capabilities
                              全链路（迁移、列、投影、面板协商闸门），Gate F5.9 覆盖
WP11B Agent 升级闭环        ✅ 面板渲染升级脚本（先拉取后停机 → 优雅排空 → 复用宿主身份
                              重建 → 身份校验 → 失败回退），Gate F5.11 覆盖
WP11C Diagnose / Support    ✅ Forward 诊断（分段，业务端口不探测）、Node 诊断
                              （collect_diagnostics 白名单自述 + 面板先判活）、
                              Support Bundle（白名单 + 双重脱敏 + 权限裁剪），
                              Gate F5.10 / F5.12 覆盖
```

**关于 "V4.5 Stable"——发布窗口与自动发布链均已闭环（2026-10-03）**：

```text
发布窗口基线  14305c8
最终收口提交  dd95713
演练          面板升级（readyz 200 + 22 migrations/schema up to date）
              回滚双向（:14305c8 ↔ 上一镜像，健康闸门与迁移兼容性检查均通过）
              Agent 升级（发布镜像 + 安装布局：换镜像不换 agent_id、能力清单齐全）
最终 Gate     F4 58/0 · F5 133/0；F5.13 backup → mutate → restore → verify 全通过
自动发布      CI #493 success → Integration #139 success → Release #30 success
GHCR Panel    ghcr.io/paimoncai/tunex:latest
              ghcr.io/paimoncai/tunex:dd957131204ee6a7c34c5b3aa101cc64cd28b23f
              digest sha256:384c90ce03d8a44e06f0204074737059e2f7f25be732b4fcd4c7767365e3bcb0
GHCR Agent    ghcr.io/paimoncai/tunex-agent:latest
              ghcr.io/paimoncai/tunex-agent:dd957131204ee6a7c34c5b3aa101cc64cd28b23f
              digest sha256:89d8ff23131a7448dcd1dd869d487dedeabb9a1b25118e67d8b7f08d2a28b3ea
记录          docs/release-record-v4.5.md
```

因此 **V4 技术范围正式关闭**；后续功能开发从 §14 V5 Roadmap 开始。

### 2026-09-28 暂停前状态（历史）

**2026-09-28 主线状态：**

- PR #23 的 reconcile / `applied_revision` 收敛修复已进入 main，S10 双账本收敛证据为
  **PASS=58 / FAIL=0 / LIMITED=0 / DEFECT=0**；
- PR #25 的 role / port-range impact fail-closed 修复已进入 main；
- PR #26（head `62cadf4`，merge `e99ddb6`）把 F2/F3 正式 Gate 接入 Integration；
- PR #26 **CI #36340990649：success**；
- PR #26 **Integration #36340990654：success**；
- 同一 Integration 的完整证据：
  - v3 verify：**PASS=51 / FAIL=0**；
  - V4 rollout：**PASS=30 / FAIL=0**；
  - V4 REST：**PASS=64 / FAIL=0 / DEFECT=0**；
  - V4 S10 interruption/recovery：**PASS=58 / FAIL=0 / LIMITED=0 / DEFECT=0**；
  - V4-F1 topology：**PASS=31 / FAIL=0**；
  - **V4-F2 managed-node closure：PASS=37 / FAIL=0**；
  - **V4-F3 product closure：PASS=21 / FAIL=0**；
  - unified image build / smoke / Compose validation：success。
- 因此 **Gate V4-F2 与 Gate V4-F3 正式关闭**，V4.2 / V4.3 完成；
- F1～F3 已全绿，V4-WP10 Authorization + NodeGroup Model 已解除阻塞；\n- **2026-09-28 起项目开发暂时暂停**，当前没有 Active WP；恢复开发时从 **V4-WP10** 继续，不跳过 Gate F4；
- 高级协议、target intelligence、HA/failover、multi-hop、federation 等不进入 V4，
  已统一迁入第 14 节 **V5 Roadmap**。

**2026-09-26 V4.1 / Gate V4-F1 最终收口：✅**

PR #22 的最后一个代码承载 head `7836d20` 已通过 **CI #439** 与
**Integration #112**。Gate 证据不再只覆盖 target/listener 等基础编辑，而是同时包含：

- 既有 `v4-gate.sh` / `v4-gate-rest.sh`：target host/port、listen port、
  multi-field single revision、stale expected_revision 409、失败保留旧 applied、
  suspend/resume；
- `v4-gate-s10.sh`：此前 F1 closure 的证据为 **PASS=57 / FAIL=0 / LIMITED=1 / DEFECT=0**；
  后续 PR #23 又把同一路径强化为 runtime ledger + rollout ledger 双收敛见证，
  最新为 **PASS=58 / FAIL=0 / LIMITED=0 / DEFECT=0**；
- `v4-gate-topology.sh` 四 Agent 拓扑：**PASS=31 / FAIL=0**，真实完成
  **DIRECT→RELAY、RELAY 更换 Egress、RELAY→DIRECT、Ingress migration**，并同时断言
  runtime 退场、Binding、NodePortLease 唯一性和最终 ledger 收敛。

至此 V4.1 正式完成；截至 2026-09-28，V4-F2 / V4-F3 已关闭；随后项目进入暂停状态，恢复开发时从 **V4-WP10** 继续。

### V4 开发暂停快照

**暂停日期：2026-09-28。**

暂停不是取消路线图。当前冻结点：

```text
F1 ✅
F2 ✅
F3 ✅
→ PAUSED
→ resume at V4-WP10
→ Gate F4
→ V4-WP11
→ Gate F5 / V4.5 Stable
→ V5
```

暂停期间不启动新的 V4/V5 Work Package；已有代码、migration、Integration Gate 和
部署脚本保持可运行状态。恢复时先基于最新 main 重跑 CI / Integration，再继续 WP10。

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

V4 后续开发、分支、PR 和合并判断以第 13 节的 Work Package、并行波次与 Integration Gate 为准；第 7 节只保留 v3 历史迁移记录。

---

## 13. V4 产品完成度开发方案

> **本节是当前团队的 Active Plan。**
>
> 第 7 节 WP0–WP15 保留为 v3 历史迁移记录；从本节开始，新开发统一使用 `V4-WPx` 编号。任何与本节冲突的旧“下一步”描述，以本节为准。

### 13.1 V4 版本里程碑

| 版本 | 目标 | 对应 WP | Release Gate |
|---|---|---|---|
| **V4.0** | Node + Forward 产品入口收敛 | 已完成 | ✅ |
| **V4.1** | Forward 全字段编辑 + Agent 热重载 | V4-WP1～WP4 | ✅ Gate V4-F1 |
| **V4.2** | 托管 Node 生命周期 + Agent 状态监控 | V4-WP5～WP7 | ✅ Gate V4-F2 |
| **V4.3** | Dashboard / 诊断 / 列表规模化 / 交互补全 | V4-WP8～WP9 | ✅ Gate V4-F3 |
| **V4.4** | 权限模型 + NodeGroup 最终语义 | V4-WP10 | Gate V4-F4 |
| **V4.5** | Agent 耐久性 / 运维升级 / 诊断闭环 + 稳定版、兼容与发布收尾 | V4-WP11 | Gate V4-F5 |

V4.1～V4.5 是产品完成度里程碑，不表示每个小版本都必须单独改变数据库主版本。所有数据库改动继续遵守 expand-and-contract。

### 13.2 V4 团队 Track

V4 延续四条长期 Track，但职责切换为产品完成度：

| Track | V4 负责范围 | 主要目录 |
|---|---|---|
| **Track A — Data / Contract** | additive schema、Revision snapshot、Node lifecycle 字段、StateReport 扩展、迁移 | `backend/prisma`、shared types |
| **Track B — Agent / Runtime** | Forward hot-reload、listener/upstream 切换、graceful drain、LKG runtime persistence、Agent telemetry / upgrade primitives | `agent/` |
| **Track C — Control Plane / API** | Forward update/preview、rollout orchestrator、Node lifecycle、health synthesis、diagnostics/support task、权限 resolver | `backend/src/services`、`backend/src/routes` |
| **Track D — Web / QA / Release** | Forward/Node 产品 UI、Dashboard、诊断入口、Support Bundle、分页筛选、E2E、发布 Gate、文档 | `web/`、`scripts/`、CI |

并行原则：

- Contract 可以先冻结，Backend / Agent / Web 随后并行实现。
- Web 可以基于冻结 contract + mock 提前开发，但不能在 Backend contract 未进入 main 时自行发明字段。
- Agent 与 Control Plane 可以并行，但任何 command payload / ACK 变化必须先在对应 contract PR 中冻结：Forward/Node 基础协议归 V4-WP1 / V4-WP5；V4-WP11 新增 Diagnose / Upgrade / Support 动作时必须先做 WP11 contract 变更，禁止实现先行。
- 两个 PR 如果持续修改同一个核心文件，必须重新拆边界；不靠反复解决 merge conflict 维持“伪并行”。

### 13.3 Forward 编辑模型（V4.1 硬约束）

#### 13.3.1 产品语义

**Forward 是长期业务资源，不是一次性配置。**

创建时由用户设置的业务字段，创建后原则上全部允许编辑：

- `name`
- `mode: direct | relay`
- `ingress_node_id`
- `egress_node_id`
- `listen_port`（含“自动分配”语义）
- `target_host`
- `target_port`

以后创建表单新增新的普通业务字段时，默认也必须进入编辑模型；如果某字段创建后不可改，必须在 contract 中说明物理原因，不得因为实现方便而禁止编辑。

Forward 编辑不得通过“删除旧 Forward + 创建新 Forward”实现：

- `Forward.id / Tunnel.id` 保持不变；
- 历史流量和审计上下文保留；
- NodeBinding 是可复用基础设施关系，修改/删除 Forward 不自动删除 Binding；
- RELAY 系统管理的 `forward-<tunnelId>` EgressPool 随当前 revision/topology 管理，不暴露给普通用户。

#### 13.3.2 Revision Snapshot

V4-WP1 必须为**运行态相关配置**引入不可变 Revision Snapshot。实现仍挂在内部 Tunnel runtime 上，不创建第二张用户业务真相表。

概念模型：

```text
Forward / Tunnel #123
├─ desired revision = 18
├─ applied revision = 17
├─ Revision 17 = 最后成功运行的完整 runtime config
└─ Revision 18 = 用户最新保存的完整 desired config
```

Revision 至少能恢复：

```text
mode
ingress_node_id
egress_node_id
requested listen_port / auto
target_host
target_port
```

要求：

- Revision snapshot 不可原地修改；同一 `(tunnel_id, revision)` 唯一。
- Tunnel 当前字段可以继续作为最新 desired projection / compatibility projection，但不能是唯一历史依据。
- rename 等纯 metadata 修改不要求重启 runtime；是否记录 product history 可独立处理，但不得为了改名触发无意义的 Agent listener 重建。
- Backend/Worker 重启后，只靠 DB revision + Agent state report + NodePortLease 就能继续/补偿 rollout。
- Reconciler 永远朝**最新 desired revision**收敛，不依次 replay 用户维护期间产生的中间旧 revision。

#### 13.3.3 Update API 与并发控制

保留产品入口：

```text
PATCH /api/forwards/:id
```

V4 扩展为可修改全部 Forward 业务字段。请求可以是 partial patch，但 Backend 必须：

```text
读取当前 desired config
→ 合并 patch 得到一份完整候选 config
→ 对完整 config 一次性校验
→ 生成一个新 revision
→ 一次 rollout
```

禁止把一次用户编辑拆成多个独立 PATCH 形成临时非法状态。

更新请求必须支持 optimistic concurrency（例如 `expected_revision`）。如果页面基于旧 revision 保存：

```text
409 revision_conflict
→ 返回/提示最新 revision
→ 用户刷新后重新确认
```

对于拓扑变化，Backend 应提供 preview/validation 能力，让 UI 在提交前知道：

- 是否改变外部访问地址；
- 是否需要新的 NodeBinding；
- 新端口是否可用；
- 哪些 Node 参与 PREPARE / DRAIN；
- 是否会造成 listener replacement；
- 明确的 warning / blocking reason。

具体 endpoint 名在 V4-WP1 contract 冻结，但校验逻辑只能有一个 Service 实现，preview 与真实 update 不得各写一份规则。

#### 13.3.4 Hot Reload 分类

Agent **进程/容器不因 Forward 编辑重启**。不同修改按下列策略执行：

| 修改 | Rollout | 用户可见影响 |
|---|---|---|
| 名称 | Control Plane only | 无数据面影响 |
| Target Host / Port | 原 runtime 热换 upstream/target snapshot | 旧 TCP 连接继续；新连接走新目标 |
| RELAY Egress | prepare 新 Egress → cutover Ingress → drain/cleanup 旧 Egress | Ingress listener 保持 |
| DIRECT → RELAY | 先准备 Egress，ACK 后切 Ingress upstream | Ingress listener 保持 |
| RELAY → DIRECT | Ingress 切直连 target，ACK 后撤旧 Egress | Ingress listener 保持 |
| Listen Port | 先申请/监听新端口 → cutover → drain/释放旧 lease | 外部端口改变 |
| Ingress Node | 新 Ingress 完整 prepare → ACK → effective ingress 切换 → 旧 Ingress drain | 外部 IP/地址可能改变，不能宣称客户端无感 |
| 多字段同时改 | 一个完整 revision / 一个 rollout plan | 禁止暴露中间半配置状态 |

“热重载”的保证是 Agent 进程不重启；涉及 listener/Node 迁移时允许创建新的 runtime 实例并 drain 旧实例。

#### 13.3.5 统一 Rollout 五阶段

所有 runtime 相关 Forward 编辑统一建模为：

```text
VALIDATE
→ PREPARE
→ CUTOVER
→ DRAIN
→ CLEANUP
```

失败规则：

- VALIDATE / PREPARE 失败：旧 applied revision 完全不动。
- PREPARE 成功、CUTOVER 前失败：回收新资源，旧 runtime 继续。
- CUTOVER 后失败：优先 compensation 回最后 applied revision。
- compensation 成功：业务继续跑旧 revision，产品状态展示“更新失败，上一版本仍运行”。
- compensation 失败：进入 degraded/error，由 Reconciler 或人工 Retry 修复。
- Cleanup 必须幂等；Backend 重启后可继续清理，不得因为进程中断永久泄漏 NodePortLease / Egress runtime。

#### 13.3.6 Suspended / Maintenance 编辑

Forward 处于 suspended 时允许编辑：

```text
保存最新 desired revision
→ 不启动 runtime
→ resume 时只应用最新 revision
```

Node 处于 maintenance 时，如果某次编辑需要该 Node：

- 用户仍可保存 desired config；
- 不要求把每个中间 revision 依次下发；
- UI 标记“等待节点退出维护”；
- Node 恢复 active 后由 Reconciler 应用最新 desired revision。

### 13.4 Node 托管生命周期（V4.2 硬约束）

V4 采用 **托管版 Node 生命周期**。Node 不再只用一个 `status` 表达全部含义。

#### 13.4.1 三层状态

```text
Connection:
  waiting | online | offline

Lifecycle:
  active | maintenance | disabled | retiring

Health:
  healthy | warning | error | unknown
```

语义：

- **Connection**：由 Panel 收到 Agent 上报的时间、credential 状态等事实推导；不是用户可编辑状态。
- **Lifecycle**：用户/管理员的期望管理状态；V4 新增独立字段，**不得复用现有 legacy `Node.status` 同时表示连接与生命周期**。
- **Health**：Backend 根据事实计算；Agent 只上报原始状态，不允许一句 `health=healthy` 成为最终真相。

#### 13.4.2 Lifecycle 行为

**active**

- 正常承载 Forward；
- 接受新的 desired revision；
- 可作为合法 Ingress/Egress 候选。

**maintenance**

- 用于服务器升级、重启、检查；
- 已存在 runtime 尽量保持，不做隐式删除；
- 不接受需要立即应用的新 runtime 变化，新的 desired revision 可以保存并等待；
- 退出维护后 Reconciler 只应用最新 desired revision。

**disabled**

- 明确表示这台 Node 不再接受新的业务/拓扑选择；
- 不能作为新 Forward、新 Binding 或迁移目标；
- 不得静默级联删除现有 Forward；已有依赖如何处理必须在 UI 中显式展示并由用户处理。

**retiring**

- 删除前的退役阶段；
- 不接受新业务；
- 展示并锁定依赖清单；
- 只有 Ingress Forward、Egress Forward、Binding、有效 runtime/lease 等依赖清空后才允许物理删除。

#### 13.4.3 Node 可编辑字段

V4 用户侧必须补齐 Node 生命周期操作：

- 修改 `node_id` 显示名；
- 修改 `role: ingress | egress | both`；
- 修改端口范围；
- 重新安装 Agent；
- 进入/退出 maintenance；
- disabled / re-enable；
- 进入 retiring；
- 删除；
- credential rotate / revoke 的合适入口；
- 查看 Agent version / 是否建议升级。

`agent_id` 永久不可编辑。重新安装仍是同一个 Node/agent identity，不重建业务资源。

角色或端口范围修改必须先做 impact check。例如 BOTH → EGRESS 时，如果它仍作为 Ingress 承载 Forward，Backend 必须阻止或要求先迁移，不得修改后再让业务随机报错。

Node 删除永远不隐式级联删除 Forward。

#### 13.4.4 Agent 自动状态上报

V4 继续使用 outbound-only Agent → Panel 通道，扩展**现有** `NodeStateReport`，不得新造第二套 Node 监控真相。

状态报告至少覆盖：

- `agent_id` / Node identity 校验；
- Agent version、启动时间/uptime；
- hostname、OS、arch；
- latest known/applied revision 摘要；
- DIRECT / RELAY ingress / Egress runtime 数量；
- active Forward / runtime 快照；
- 实际占用端口；
- 最近 runtime/apply error；
- CPU / memory / disk / load 的轻量当前值。

V4 第一阶段不把 Agent 做成完整 Prometheus exporter。系统资源指标用于诊断和 warning，核心监控事实仍是：

```text
Agent 是否在上报
→ desired/applied 是否一致
→ runtime 是否存在
→ 端口是否真实占用
→ 是否存在 apply/runtime error
```

Backend 根据这些事实计算 Health：

- `healthy`：Connection online，关键 runtime/revision 一致，无持续错误；
- `warning`：在线但 revision 落后、部分 Forward error、版本落后或资源接近阈值；
- `error`：Agent/runtime 初始化失败或关键 runtime 持续不可用；
- `unknown`：尚未安装/没有足够报告。

Offline 是 Connection 状态，不等价于 Health=error。

### 13.5 V4 权限模型目标（V4.4，最后实施）

NodeGroup 暂时保持当前实现，**V4-WP10 之前不做大规模 NodeGroup 重构**。先把 Forward 与 Node 生命周期做稳定，再决定 NodeGroup 最终是“用户组织对象、调度对象、权限对象”中的哪几个角色。

V4 的权限判断必须按五层拆开：

```text
1. Authentication   谁在调用？
2. Workspace RBAC   这个身份能对该类资源做什么动作？
3. Resource Scope   这个具体资源是否属于/授权给当前 Workspace？
4. Capability/Quota 当前 Workspace 是否拥有该能力、是否超额度？
5. Runtime Admission 当前 Node/Binding/Port/Lifecycle 是否满足运行条件？
```

硬规则：

- **CapabilityPolicy/Quota 不是 RBAC。** “套餐允许 20 条 Forward”不能回答“这个 member 能不能删除别人的 Forward”。
- **Node role/lifecycle/online 不是权限。** 它们属于 runtime admission。
- **NodeGroupGrant 是资源作用域/共享机制，不应承担用户身份角色的职责。**
- Agent credential 是机器身份认证，不参与普通用户 Workspace RBAC。
- 用户侧资源名统一为 `forward`；兼容期内部仍可映射旧 `tunnel` permission，但 V4-WP10 必须给出最终迁移方案。
- 权限拒绝、能力拒绝、额度拒绝、运行条件拒绝必须使用可区分的错误码，Web 才能给用户正确下一步。

V4-WP10 必须先做“权限矩阵 + 资源作用域 + NodeGroup 语义”设计 PR，审查通过后才允许改 schema/API。禁止一边改 NodeGroup 一边临时发明权限规则。

### 13.6 V4 Work Package 依赖矩阵

| WP | 工作包 | Track | Depends-On | 主要 DoD |
|---|---|---|---|---|
| **V4-WP0** | Product / Team Contract Freeze | Shared | V4.0 | ✅ 本节冻结后作为唯一计划 |
| **V4-WP1** | Forward Revision Foundation | A/C | WP0 | revision snapshot、full update contract、expected_revision、preview/validation、迁移测试 |
| **V4-WP2** | Agent Hot Reload Primitives | B | WP1 contract | target/upstream 热换、listener replacement、drain、幂等 revision |
| **V4-WP3** | Forward Rollout Orchestrator | C/B | WP1 + WP2 | VALIDATE→PREPARE→CUTOVER→DRAIN→CLEANUP、compensation、Reconciler 恢复 |
| **V4-WP4** | Forward Edit Product UX | D | WP1 contract；merge 依赖 WP3 | 创建表单=编辑能力全集、impact warning、running-vs-desired、copy/result UX |
| **V4-WP5** | Node Lifecycle Foundation | A/C | WP0 | lifecycle schema/API、impact check、maintenance/disabled/retiring/delete contract |
| **V4-WP6** | Agent Telemetry & Node Health | B/C | WP5 state contract；Agent 部分建议在 WP2 后 | 扩展 NodeStateReport、health synthesis、版本/资源/runtime 状态 |
| **V4-WP7** | Node Lifecycle Product UX | D | WP5 + WP6 | 安装等待闭环、维护/停用/退役、依赖预览、Node 详情监控 |
| **V4-WP8** | Monitoring & Actionable Diagnostics | C/D | WP4 + WP7 | Dashboard 异常入口、用户状态语义、错误→下一步、隐藏默认内部 revision 细节 |
| **V4-WP9** | Scale & Interaction Polish | C/D | WP4 | server pagination/filter/sort、Egress filter、auto-port 提示、复制 Forward、Binding usage、必要批量操作 |
| **V4-WP10** | Authorization + NodeGroup Model | Shared | WP4 + WP7 + WP8 + WP9 | 权限矩阵、resource scope、Capability 分层、NodeGroup 最终语义与兼容迁移 |
| **V4-WP11** | Agent Durability / Ops / Diagnostics / Stable Gate | Shared/B/C/D | WP10 | LKG runtime cache、graceful drain、protocol capability、Agent 重装/升级、Forward/Node diagnose、Support Bundle、全量 Real E2E、兼容/回滚/文档、V4.5 release |

### 13.7 团队开发步骤与并行波次

V4 不按“所有人等一个 Step”开发，但合并有明确 Gate。

#### Wave 0 — Contract Freeze

```text
V4-WP0
→ 本开发方案进入 main
→ V4 API / state / product invariants 冻结
```

#### Wave 1 — 两条 Foundation 并行

```text
Track A/C: V4-WP1 Forward Revision Foundation
Track A/C: V4-WP5 Node Lifecycle Foundation
```

两者可以由不同开发者并行，但 schema migration 必须协调顺序，禁止双方各自重写同一 migration。

WP1 contract 冻结后：

```text
Track B: V4-WP2 Agent Hot Reload
Track D: V4-WP4 Forward UI 可用 mock 提前开发
```

WP5 state contract 冻结后：

```text
Track C: Node lifecycle service/API
Track D: V4-WP7 Node UI 可用 mock 提前开发
```

#### Wave 2 — Runtime Integration

```text
WP1 + WP2
→ V4-WP3 Forward Rollout Orchestrator
→ Real E2E 扩展
→ Gate V4-F1
```

Gate V4-F1 至少真实验证：

- target host/port 热修改；
- listen port 修改；
- RELAY 换 Egress；
- DIRECT ↔ RELAY；
- Ingress migration；
- multi-field single revision；
- stale expected_revision 409；
- update 失败时旧 applied revision 继续运行；
- suspended edit + resume 最新 revision；
- Backend/Agent 重启后 rollout/reconcile 可恢复。

WP3 进入 main 且 Gate 绿后，WP4 才能最终 merge。

**Gate V4-F1 final closure（2026-09-26）：✅** PR #22 的代码承载 head
`7836d20` 已通过 CI #439 与 Integration #112。既有 rollout/rest/S10 Gate 全绿，
其中 S10 总账为 **PASS=57 / FAIL=0 / LIMITED=1 / DEFECT=0**；新增四 Agent
`v4-gate-topology.sh` 为 **PASS=31 / FAIL=0**，真实验证 RELAY 换 Egress、
DIRECT ↔ RELAY 与 Ingress migration，同时检查数据面、runtime 退场、Binding、
NodePortLease 和 ledger 收敛。因此本节列出的 V4-F1 最低验收项均已闭环，
**V4.1 可标记完成。该句只记录历史 closure；当前实际游标以 §12 为准：关闭 V4-F2 / V4-F3。**

#### Wave 3 — Managed Node

Agent Track 在 WP2 稳定后进入 V4-WP6，避免两个大 Agent PR 同时长期修改 TunnelManager/上报主循环。

```text
WP5 + WP6
→ V4-WP7
→ Gate V4-F2
```

Gate V4-F2 至少验证：

- waiting → online → offline；
- active ↔ maintenance；
- maintenance 期间保存 Forward，新 revision 等待；
- 退出 maintenance 后只收敛到最新 revision；
- disabled 不接受新业务；
- retiring 显示依赖并阻止有依赖删除；
- Agent 重装保持 agent_id / Node / Forward 关系；
- role/port-range 修改 impact check；
- state report / health / version / runtime/port facts 正确。

**当前状态（2026-09-28）：WP5～WP7 已进 main，Gate V4-F2 已正式关闭（PASS=37 / FAIL=0）。**

F2 closure 已按既定顺序完成：

```text
role/port-range impact fail-closed
→ waiting / online / offline
→ maintenance latest-revision convergence
→ disabled admission rejection
→ retiring dependency/delete gate
→ reinstall preserves agent_id / Node / Forward
→ state report / health / version / runtime / port facts
→ Gate V4-F2 = green
```

最终真实 Integration：**PASS=37 / FAIL=0**。

#### Wave 4 — Product Polish

```text
V4-WP8 Monitoring
+
V4-WP9 Scale/Interaction
→ Gate V4-F3
```

重点不是增加新协议，而是让现有功能在真实规模下好用：

- Dashboard 优先显示异常、离线、等待安装和快捷操作；
- Forward/Node 普通页面使用产品状态，不默认暴露 raw revision/desired internals；
- 错误必须给下一步动作；
- Forward 列表改为服务端分页、筛选、排序；
- 创建后清晰展示最终访问地址/auto port；
- Binding 删除前显示使用量；
- Tunnel 术语从普通用户文案中清理。

**当前状态（2026-09-28）：WP8 / WP9 已进 main，Gate V4-F3 已正式关闭（PASS=21 / FAIL=0）。**

F3 不重复证明 F1/F2 的 runtime 正确性，重点验证产品闭环：

- 大列表分页/过滤/排序稳定且结果无重复/漏项；
- Dashboard needs-attention 与 Node/Forward 真实状态一致；
- 错误项能跳到可执行的下一步；
- copy Forward / batch retry-suspend-resume / Binding usage 的权限与失败结果可解释；
- 普通产品页面不依赖 raw revision 才能理解当前状态；
- 真实 Integration 拿到的最终访问地址与数据面一致。

F3 closure 使用真实产品 API 验证了分页/跨页稳定排序、mode/egress 筛选、Binding usage + 409、
auto-port 最终地址真实数据面、batch suspend/resume、Dashboard attention 与 summary，
最终 **PASS=21 / FAIL=0**。

#### Wave 5 — Permission / NodeGroup

Gate V4-F1～F3 已全绿；**V4-WP10 现已解除阻塞并成为当前开发入口。**

顺序固定：

```text
现状审计
→ 权限矩阵
→ Resource Scope 模型
→ Capability/Quota 分层
→ NodeGroup 最终语义
→ Compatibility Plan
→ Schema/API migration
→ Web
→ Negative E2E
```

不得先改 NodeGroup 表结构再补权限设计。

##### WP10 实施契约（恢复开发，待代码与负向 Gate 验证）

以下设计沿用现有表与 workspace 所有权，不创建第二份路线图。实施顺序仍为设计审查、代码、Web、负向验收。

| 身份 | Forward read/create | Forward update/delete/action | Node/Binding read | Node/Binding/enrollment manage | Workspace 管理 |
|---|---|---|---|---|---|
| owner | 允许 | workspace 内全部 | 允许 | 自有资源允许 | 全部，owner 保护规则保留 |
| admin（无自定义角色） | 允许 | workspace 内全部 | 允许 | 自有资源允许 | 保留现有 admin 权限，不能提升/移除 owner |
| member（无自定义角色） | 允许 | 仅自己创建的 Forward | 允许 | 拒绝 | 只读 |
| viewer（无自定义角色） | 仅 read | 拒绝 | 允许 | 拒绝 | 只读 |
| 非 owner 且绑定 custom role | 只认显式布尔 true 的权限 | 显式动作授权适用于当前 workspace 内资源 | 只认 node:read | 只认 node:manage，仍须 owned scope | member/settings/audit 各自独立键 |

- owner 是固定 break-glass 身份；非 owner 绑定自定义角色后**替换**基础角色权限，不做未授权回退。悬空、跨 workspace 或损坏角色引用拒绝，不因数据异常恢复 admin/member 权限。
- `forward:read/create/update/delete` 是规范产品权限键；旧 `tunnel:*` 按相同动作兼容读取。两键同时存在时规范键优先，包括显式 false；写入规范化为 forward 键。兼容 API 使用同一判定与 creator/scope 规则，不删除旧端点。JSON 权限无需破坏性 schema 迁移，旧 Panel 回滚前应恢复角色权限备份，避免旧 Panel 不认识 forward 键。
- middleware 只做 workspace/action 初筛；需要 creator 的 update/delete 在加载 workspace-scoped 资源后再判定。batch 逐项判定，拒绝项不得触发修改或 Agent 命令。自定义角色不能绕过作用域、额度、生命周期或平台管理员权限。
- NodeGroup 最终语义为 **workspace-owned 节点组织/授权容器 + scheduler 候选池**，不是 Agent 身份或角色。Node.role 为能力真相。保留 node_type 作为 legacy 默认值，不从它推导已创建节点角色。
- NodeGroupGrant 保留为 personal workspace 的显式方向 use grant；不扩散到 team，不授予 enrollment、credential、Binding 或节点管理权。Node/Binding 管理要求 owned group。当前 Forward 只使用 owned Node/Binding；共享组继续通过兼容 runtime API 使用，不伪装成已支持跨 workspace Binding。
- 拒绝响应保留既有 `code` 并增加可区分 `error_layer`：authentication、rbac、resource_scope、capability、quota、runtime_admission。越界 ID 返回 404；权限拒绝 403。运行状态和 capability 不得代替 RBAC。
- 负向验收必须覆盖：固定四角色、custom replacement/invalid role、canonical/legacy key 冲突、creator 与非 creator、新旧 API、批量部分拒绝、跨 workspace ID、revoked grant、Bearer personal-only、能力/额度/运行态独立拒绝。

#### Wave 6 — V4 Stable

V4-WP11 不再只是“最后再跑一次 E2E”，而是把现有控制器架构补成可长期运维的系统。WP11 拆成四个可独立 PR/分支推进、最终共同关闭 F5 的子阶段：

##### WP11A — Agent Durability

- Agent 保存**最后成功 applied** 的 runtime snapshot（LKG，last-known-good）；
- LKG 必须版本化、原子写入、权限收紧，禁止持久化 credential/token；
- Agent/主机重启且 Panel 暂时不可达时，可从 LKG 恢复已成功运行过的 runtime；
- Panel 恢复后仍以 Panel desired revision 为最终权威，正常 reconcile 到最新 desired；
- remove/suspend/retarget 等成功 applied 后必须同步更新/删除对应 LKG，禁止“配置已删但缓存复活”；
- SIGTERM / maintenance / upgrade 共用一个 graceful drain primitive：
  close listeners → 不接新连接 → 等待既有 TCP 连接归零或超时 → final report/flush → stop；
- 明确“不承诺跨进程 socket handoff”，drain 是有界窗口，不是假装零中断。

##### WP11B — Agent Operations

- 在现有 `NodeStateReport` 增加可选的 `control_protocol_version` 与
  `capabilities`，继续坚持“只扩展一个状态真相源”；
- Panel 下发新动作前先做 capability check，不支持时返回结构化
  `incompatible_agent` / upgrade-required 类错误，禁止靠未知命令失败来猜；
- Docker-first 安装不采用“进程自覆盖二进制”作为主升级方式；
- 标准升级闭环：
  `maintenance → drain → recreate/update Agent → same agent_id → reconnect → desired/applied converge → active`；
- Agent reinstall / upgrade 必须保持 Node、agent_id、Forward/Binding 关系；
- 升级失败必须回到可解释状态并保留旧运行版本/恢复路径；
- 多 Node 升级后续支持 rolling waves，先小批、确认健康再继续，禁止一次性全量打掉数据面。

##### WP11C — Diagnostics

新增产品级 **Forward / Node Diagnose**，继续走现有 outbound-only command/ACK 通道，不新建第二套 Agent 管理协议。

Forward Diagnose 最低事实：

```text
DIRECT:
runtime exists
→ listener bound
→ desired/applied revision match
→ target resolve/connect
→ latency/error

RELAY:
Ingress runtime/listener
→ Ingress ↔ Egress path
→ Egress runtime
→ Egress → target reachability
→ 每一段 latency/error
```

诊断 probe 必须是 side-channel：

- 不计业务流量；
- 不占用户连接额度；
- 不经过业务 bandwidth limiter；
- 有单 probe timeout、target 数量和并发硬上限；
- result 必须绑定原 command/resource/revision，过期或不匹配结果拒绝；
- UDP 等无法可靠验证的协议不得伪装成“已确认可达”。

新增 **Support Bundle**：

- Panel 侧汇总 NodeStateReport、desired/applied、ForwardRollout、最近 audit / panel log；
- Agent 侧按白名单采集版本、process/boot 信息、listeners、routes、service status、
  必要日志和有限网络事实；
- 所有字段和文本二次 redact `token/password/secret/private key/authorization/cookie/credential`；
- 每命令输出、单 Agent 输出、总 Bundle 都有大小上限；
- 每命令和整个 task 都有 timeout；
- offline Node 明确返回 offline，不无限 pending；
- Bundle 只用于诊断，不成为新的运行态真相源。

##### WP11D — Stable Gate

最终 F5 必须覆盖：

- 全量 V4 Real E2E；
- Panel online / temporarily unavailable 下 Agent restart；
- LKG 恢复后 Panel 回归、revision 再收敛；
- SIGTERM graceful drain：新连接拒绝、已有 TCP 在窗口内可结束；
- Agent reinstall / image upgrade 保持 agent_id / Node / Forward 关系；
- old Agent + new Panel / new Agent + old Panel 的 capability/version skew；
- diagnose 的真实 reachable / timeout / refused 路径；
- Support Bundle 不泄露 credential/token；
- 生产部署 / Panel 升级 / 镜像回滚 / backup-restore 演练；
- orphan EgressPool / NodePortLease / stale runtime 检查；
- deprecated `/api/tunnels` 与 node-scoped Forward API 的外部兼容窗口决策；
- 如果决定删除旧 API，单独 breaking-change PR + release notes；
- README / production deploy / migration notes；
- 仓库 LICENSE / NOTICE / third-party attribution 策略明确后再标记 V4.5 stable。

Gate V4-F5 通过后才标记 V4.5 stable。

### 13.8 V4 Integration Gates

```text
Gate V4-F0  Product / Team Contract Frozen          ← V4-WP0
Gate V4-F1  Forward Fully Editable + Hot Reload     ← WP1–WP4  ✅
Gate V4-F2  Managed Node Lifecycle + Telemetry      ← WP5–WP7  ✅
Gate V4-F3  Monitoring / Scale / UX Complete        ← WP8–WP9  ✅
Gate V4-F4  Authorization / NodeGroup Model Stable  ← WP10
Gate V4-F5  Durability / Diagnostics / Ops / Compatibility Stable ← WP11
```

只有对应 Gate 通过，才宣称该 V4 里程碑完成。单个 PR CI 绿不等于 V4 Gate 通过。

### 13.9 V4 分支与 PR 约定

新分支统一：

```text
feature/v4-wp1-forward-revisions
feature/v4-wp2-agent-hot-reload
feature/v4-wp3-forward-rollout
feature/v4-wp4-forward-edit-web
feature/v4-wp5-node-lifecycle
feature/v4-wp6-node-telemetry
feature/v4-wp7-node-lifecycle-web
feature/v4-wp8-monitoring
feature/v4-wp9-product-polish
feature/v4-wp10-permissions-nodegroup
feature/v4-wp11-agent-durability
feature/v4-wp11-agent-operations
feature/v4-wp11-diagnostics
test/v4-wp11-stable-gate
```

PR 描述在原有模板基础上增加：

```text
V4 Work Package:
V4 Milestone:
Product Behavior Changes:
Desired/Applied Revision Impact:
Node Lifecycle Impact:
Hot Reload / Drain Impact:
Permission Impact:
Migration Impact:
Rollback:
Tests / Real E2E:
```

禁止用一个“v4-all”分支同时开发 WP1～WP11。

### 13.10 V4 明确暂缓

以下内容不因为 V4 开发或参考项目已有而顺手加入：

- UDP；
- WS/TLS 新数据面；
- QUIC；
- advanced multi-target LB 自动决策；
- DNS；
- multi-ingress HA；
- automatic failover；
- multi-hop；
- Panel federation / 跨控制面共享；
- WireGuard / mimic 类额外数据面；
- Plugin Store / 移动端等非核心产品面。

V4-WP11 只允许一次性 Diagnose probe 返回目标可达性/延迟事实；**持续 target health /
latency observation、circuit breaker 与 automatic failover 全部属于 V5**。高级网络能力统一进入 V5。除非某能力是
Forward 编辑、Node 生命周期或稳定性 Gate 的阻断项，否则不得抢占 V4-F2～F5 的主线资源。

### 13.11 外部参考项目吸收规则

V4.5 的 durability / diagnostics 方向参考当前 fork 的三个项目，但
`DEVELOPMENT.md` 与 TuneX 自身 contract 永远是唯一开发真相源：

- **RelayPanel**：重点参考 config cache、protocol-version guard、rule diagnose、
  graceful shutdown/drain、Agent upgrade 生命周期与 CI/E2E 组织方式；
- **FLVX**：重点参考流式 diagnosis、tunnel quality observation、批量产品交互和
  federation 的“资源 grant/port/quota/expiry/usage”语义；
- **ForwardX**：重点参考 LKG runtime persistence、self-test、Support Bundle、
  upgrade waves、runtime recovery 与大量负面/恢复测试。

实现原则：

1. **吸收行为/状态机/测试场景，不复制产品复杂度。** TuneX 不因参考项目存在
   multi-hop、WireGuard、插件、支付等能力而改变 V4 范围。
2. **不引入第二套真相源。** LKG 是 last-applied availability cache，不取代
   Panel desired；Support Bundle 是诊断产物，不取代 NodeStateReport；
   diagnose result 是一次测试事实，不取代 Health synthesis。
3. **不引入第二套控制协议。** Diagnose / upgrade / support request 优先扩展现有
   outbound-only command + ACK/result contract。
4. **许可证 fail-closed。** RelayPanel 当前为 Apache-2.0；FLVX 当前修改部分为
   GPLv3；ForwardX 当前为 AGPL-3.0-only。GPL/AGPL 项目默认只参考设计和测试思路，
   未经明确 license review 不直接复制实现代码。
5. **授权治理仍 fail-closed。** V4 技术发布链已经闭环，但仓库根目录当前仍未放置
   `LICENSE` / `NOTICE`。在仓库自身许可与 third-party attribution 策略明确前，
   V4 的 “Stable” 只表示技术基线稳定，不表示授予对外开源/再分发许可；V5 开发也不得绕过这条约束。


---

## 14. V5 Roadmap — Advanced Networking / Resilience / Federation

V5 的技术启动条件 **Gate V4-F5 通过并标记 V4.5 stable** 已于 2026-10-03 满足。V5 不反向扩大 V4 范围；V4 的 frozen baseline（Forward / Node 产品模型、desired/applied + revision/ACK、LKG、drain、diagnostics、authorization、CI → Integration → Release）必须继续保持。

V5 的定位不是第二次架构重写，而是：

> **在 V4 单一控制链与单一 runtime 真相源上，逐层扩大协议、观测、容错、拓扑与跨控制面能力。**

仓库许可与 third-party attribution 继续按 §13.11 独立 fail-closed。

### 14.1 总体执行顺序

| 阶段 | 主题 | 核心交付 | 进入下一阶段的硬门槛 |
|---|---|---|---|
| **V5.0** | Contract Freeze | 协议/Transport 抽象、Capability v2、Stream/Datagram 边界、兼容矩阵、性能基线 | **Gate V5-G0 全绿** |
| **V5.1a** | WS / TLS | 在 Stream Runtime 上扩展 TLS / WebSocket | 独立 WS/TLS Gate 全绿 |
| **V5.1b** | UDP | Datagram Runtime、session mapping、idle timeout、packet accounting | 独立 UDP Gate 全绿 |
| **V5.1c** | QUIC | 建立在 UDP + TLS 基础上的 QUIC runtime | 独立 QUIC Gate 全绿 |
| **V5.2** | Target Intelligence | 持续 target health / latency observation、health synthesis、circuit breaker、advanced LB | **Gate V5-G2 全绿** |
| **V5.3** | Resilience / HA | DNS 动态目标、multi-ingress HA、fencing、automatic failover/failback | **Gate V5-G3 全绿** |
| **V5.4** | Multi-hop | 内部 RoutePlan / Link、2-hop → 3-hop、拓扑迁移与恢复 | **Gate V5-G4 全绿** |
| **V5.5** | Federation | Panel federation、grant、remote lease/quota/usage/revocation、跨控制面 reconcile | **Gate V5-G5 全绿 + 独立安全评审** |
| **V5.x** | Optional Data Plane / Ecosystem | WireGuard / mimic 类数据面、Plugin Store、移动端等 | 每项单独架构评审与 Gate |

固定依赖顺序：

```text
V4.5 frozen baseline
        ↓
V5.0 Contract Freeze
        ↓
      V5-G0
        ↓
WS/TLS → UDP → QUIC
        ↓
V5.2 Target Intelligence
        ↓
V5.3 HA / Failover
        ↓
V5.4 Multi-hop
        ↓
V5.5 Federation
```

**禁止跳阶段。** 尤其在 V5-G0 关闭前，不进入 UDP / QUIC 实现；在 target observation 稳定前，不进入 automatic failover。

---

### 14.2 V5.0 — Contract Freeze

V5.0 是当前唯一 Active Phase。它的目标不是交付新的用户协议，而是冻结后续所有 V5 能力共同依赖的扩展契约。

#### V5-WP0 — Forward / Protocol / Transport Contract

用户产品模型继续保持：

```text
Forward
```

禁止为 UDP / TLS / QUIC / multi-hop 再创建第二套用户侧 Tunnel/Forward 产品对象。

内部模型按以下层次收敛：

```text
Forward
  ↓
ForwardDesiredState
  ↓
ProtocolSpec / TransportSpec
  ↓
RuntimePlan
  ↓
Agent Runtime
```

冻结原则：

- `Forward` 仍是用户唯一业务对象；
- `Tunnel` 继续承担内部 desired/runtime 兼容语义，不另造第二份业务真相；
- protocol 与 transport 必须是显式契约，不允许在各 service/route 里散落 `if protocol === ...`；
- future multi-hop 只允许扩展内部 `RuntimePlan` / `RoutePlan`，不得改变用户侧资源身份；
- DIRECT / RELAY 仍是拓扑语义，不能与 TCP / UDP / QUIC 这类传输协议混成同一个枚举维度；
- schema 变更优先 additive；旧 Agent / 旧 Forward 必须有明确兼容路径。

DoD：

- 数据模型 / API / Agent config 的字段归属冻结；
- DIRECT/RELAY 与 protocol/transport 的正交关系有契约测试；
- 未知 protocol / transport fail-closed；
- V4 TCP Forward 无迁移即可继续运行。

#### V5-WP1 — Capability Negotiation v2

V4 已有 `control_protocol_version` + `capabilities`，V5 必须扩展而不是替换。

目标形态允许表达：

```text
control protocol version
transport capabilities
runtime capabilities
diagnostic capabilities
optional feature/version ranges
```

示意：

```json
{
  "control_protocol_version": 2,
  "capabilities": {
    "transport": ["tcp", "tls", "ws"],
    "runtime": ["hot_reload", "graceful_drain"]
  }
}
```

硬规则：

- Panel 在**入队前**完成 capability admission；
- 旧 Agent 未上报 v2 时走明确兼容矩阵，不得猜能力；
- “未上报”与“明确不支持”必须保持不同语义；
- Agent 只能广告真实可执行能力，能力列表必须由实现分支或同一事实源派生；
- unknown / malformed capability fail-closed；
- 不允许通过“下发后失败”代替 capability negotiation。

#### V5-WP2 — Runtime Abstraction

数据面分成两类生命周期：

```text
Forward Runtime
├─ Stream Runtime
│  ├─ TCP
│  ├─ TLS
│  └─ WebSocket
│
└─ Datagram Runtime
   ├─ UDP
   └─ QUIC
```

共享：

- desired state / revision / ACK；
- NodePortLease / port guard；
- authorization / quota admission；
- reconcile；
- health / telemetry；
- LKG / graceful shutdown；
- diagnostics / Support Bundle。

不得共享错误的生命周期假设：

```text
Stream:
listen → accept → dial → bidirectional copy → close

Datagram:
listen packet → session mapping → packet forwarding
→ idle timeout → mapping cleanup
```

禁止为了 UDP 把 TCP 的 connection abstraction 强行泛化成一个无法表达真实生命周期的“大接口”；也禁止复制第二套 TunnelManager / desired/reconcile 控制链。

#### V5-WP3 — Performance Baseline

V5.0 必须先冻结 V4 TCP 基线，之后每种新能力才能判断“功能正确但性能退化”。

至少记录：

- throughput；
- connection establishment latency；
- concurrent connections；
- CPU / RSS；
- goroutine 数与泄漏；
- hot reload latency；
- interruption / reconnect convergence；
- DIRECT vs RELAY 开销。

原则：

- correctness Gate 与 performance baseline 分开；
- 第一阶段只做可重复测量与回归阈值，不追求极限 benchmark；
- 环境波动大的指标先记录分布/趋势，不用脆弱的单点绝对值阻断 CI。

#### V5-WP4 / Gate V5-G0 — Contract Compatibility Gate

G0 是进入任何新协议实现前的硬门槛。

必须真实验证：

```text
V4 TCP DIRECT                不退化
V4 TCP RELAY                 不退化
旧 Forward                   无需重建即可工作
旧 Agent                     能继续连接新 Panel
新 Agent                     能执行 V4 baseline
unknown capability           fail-closed
unknown protocol             不下发
revision / ACK               语义不变
LKG old schema               可安全读取/迁移或明确拒绝，不 crash
LKG new schema               不覆盖 Panel desired truth
diagnostics / support bundle 不因新契约泄漏额外敏感字段
```

**V5-G0 FAIL > 0 时禁止开始 V5.1。**

建议分支：

```text
feature/v5-wp0-contract
feature/v5-wp1-capability
feature/v5-wp2-runtime-abstraction
perf/v5-wp3-baseline
test/v5-g0-contract
```

---

### 14.3 V5.1 — Protocol Expansion

协议扩展固定按：

```text
WS / TLS
   ↓
UDP
   ↓
QUIC
```

推进。原因是 WS/TLS 仍属于 Stream 生命周期，先用它验证 V5-WP2 的抽象是否正确；UDP 引入真正不同的 Datagram 生命周期；QUIC 同时依赖 UDP、TLS 与连接/stream 状态，因此最后实现。

#### V5.1a — WS / TLS

目标：

- TLS termination / passthrough 的边界先冻结后实现；
- WebSocket 明确是 transport/framing 能力，不复制 Forward 产品模型；
- TCP/TLS/WS 共用 Stream Runtime 的 listener / revision / drain / telemetry 基础设施。

退出条件：

- TCP baseline 全绿；
- TLS 独立正反向 Gate；
- WS 独立正反向 Gate；
- certificate/config reload 的失败必须保留旧 applied；
- graceful drain 与 hot reload 不退化。

若实现 WS/TLS 时需要复制整套 TunnelManager / Reconciler，应停止并回到 V5-WP2 修正抽象，而不是继续堆代码。

#### V5.1b — UDP

新增 Datagram Runtime：

- source/session mapping；
- idle timeout；
- NAT-like mapping cleanup；
- packet / byte accounting；
- target selection；
- target change 后的新 session 与既有 session 语义；
- Agent restart / Panel outage / LKG restore。

UDP Gate 必须覆盖：

- 单向 / 双向 packet；
- 多客户端同源/异源；
- idle expiry；
- mapping 上限；
- target unavailable；
- hot update；
- restart / outage；
- packet accounting；
- BOTH 节点端口冲突。

#### V5.1c — QUIC

QUIC 只有在 UDP Gate 关闭后开始。

至少冻结：

- QUIC termination vs transport relay 边界；
- connection / stream / datagram 的统计口径；
- certificate / key material 的存储和下发边界；
- graceful drain；
- 0-RTT 是否支持（默认不因库支持就自动开放）。

每种协议都有独立 Gate；不得用“UDP 已通过”代替 QUIC 验证。

---

### 14.4 V5.2 — Target Intelligence

V5.2 固定遵循：

```text
Observation
   ↓
Health Synthesis
   ↓
Decision
```

先观测，后自动决策。

#### V5-WP5 — Target Observation

持续采集：

- reachability；
- latency；
- consecutive failures / successes；
- success rate；
- active / recent connections；
- last observation / observation source。

观测事实不得直接改 desired state。

#### V5-WP6 — Health Synthesis

把多个 observation 合成为稳定状态，例如：

```text
unknown
healthy
degraded
unhealthy
recovering
```

必须处理：

- flap / jitter；
- stale observation；
- startup warm-up；
- partial visibility；
- Panel restart。

#### V5-WP7 — Circuit Breaker / Advanced LB

只有 observation + synthesis Gate 稳定后才允许加入：

- circuit breaker；
- weighted health-aware routing；
- least-latency / least-load 等高级策略；
- recovery probing / half-open。

禁止因为一次 timeout 立即永久摘除 target。

#### Gate V5-G2

真实 Gate 至少覆盖：

- healthy → unhealthy → recovering → healthy；
- 延迟升高但仍可达；
- 单 target / 多 target；
- target flap；
- stale telemetry；
- Panel/Agent restart；
- hot target update；
- circuit breaker open / half-open / close；
- advanced LB 在 target 恢复后的重新纳入。

---

### 14.5 V5.3 — Resilience / HA

V5.3 才允许真正改变“故障后由谁承载业务”的自动决策。

#### V5-WP8 — DNS Dynamic Target

DNS 解析属于 target observation/input，不允许绕过 desired/runtime 真相源。

必须明确：

- TTL；
- NXDOMAIN；
- 多 A/AAAA；
- address churn；
- stale DNS fallback；
- IPv4 / IPv6；
- DNS 变化与已有连接/session 的关系。

#### V5-WP9 — Multi-Ingress HA

Forward 仍是单一业务对象，内部允许：

```text
preferred ingress
standby ingress(es)
ownership / lease epoch
```

必须有 fencing/epoch/lease 机制避免：

```text
Panel 认为 A 已死
→ B 接管
→ A 实际仍在监听
→ split brain
```

#### V5-WP10 — Automatic Failover / Failback

自动迁移必须是显式 policy，默认不能把“heartbeat timeout”直接等价为“允许迁移”。

决策输入至少包含：

- node reachability；
- observation freshness；
- ownership epoch；
- port availability；
- target health；
- policy / cooldown；
- previous failover state。

#### Gate V5-G3

必须包含真实故障恢复：

```text
硬断链
软超时
短时抖动
节点重启
Panel 重启
双活冲突
重复 failover 请求
failover 中再次失败
旧节点恢复
manual vs automatic failback
lease/epoch fencing
```

G3 不只验证“能切过去”，还必须验证**不会同时承载、不会无限抖动、能解释为什么切换**。

---

### 14.6 V5.4 — Multi-hop

multi-hop 不得复活第二套产品模型。

用户仍然看到：

```text
Forward
```

内部才允许：

```text
Forward
  ↓
RoutePlan
  ├─ Hop A
  ├─ Hop B
  └─ Hop C
```

#### V5-WP11 — RoutePlan / Link Contract

先冻结：

- hop identity；
- hop order；
- per-hop transport；
- endpoint ownership；
- port/link lease；
- revision propagation；
- error ownership；
- telemetry aggregation。

Link/Transport 是否独立持久化，只在明确能减少重复资源且 ownership 可证明时才引入。

#### V5-WP12 — 2-hop

第一版只做固定 2-hop，覆盖：

- create；
- hot edit；
- middle-hop replacement；
- rollback；
- restart/reconcile；
- per-hop diagnostics。

#### V5-WP13 — 3-hop

2-hop Gate 关闭后再扩 3-hop。

V5.4 第一版**不做任意图 / 环 / 动态路径算法**；先证明线性 RoutePlan 的生命周期正确。

#### Gate V5-G4

必须验证：

- 2-hop / 3-hop 建立与拆除；
- 中间 hop 失败；
- 中间 hop 恢复；
- topology edit；
- stale revision；
- partial apply；
- compensation；
- lease cleanup；
- Panel / 任一 Agent restart；
- telemetry / diagnostics 能定位具体失败 hop；
- 不产生 orphan listener / orphan link。

---

### 14.7 V5.5 — Federation

Federation 是独立的分布式控制面阶段，必须最后做，并单独安全评审。

概念上：

```text
Panel A
   │ grant / credential / lease
   ▼
Panel B
```

必须先回答 ownership：

- Forward 谁拥有；
- Node / remote capacity 谁拥有；
- port lease 谁分配；
- quota 谁判定；
- usage 谁计量；
- billing/audit 事实源在哪；
- revoke 由谁发起、多久生效；
- 两个 Panel 断网后谁可以继续服务；
- reconnect 后如何 reconcile 冲突。

#### V5-WP14 — Federation Identity / Trust

- Panel identity；
- credential issuance / rotation / revoke；
- trust scope；
- replay protection；
- audit。

#### V5-WP15 — Resource Grant / Remote Lease

- resource grant；
- expiry；
- remote port/capacity lease；
- quota reservation；
- revocation。

#### V5-WP16 — Usage / Partial Failure / Reconcile

- usage attribution；
- duplicate delivery；
- network partition；
- stale grant；
- partial commit；
- retry / idempotency；
- reconcile ownership。

#### Gate V5-G5

必须有：

- normal grant/use/revoke；
- credential rotate/revoke；
- quota exhaustion；
- lease expiry；
- one Panel offline；
- network partition；
- duplicate/reordered messages；
- partial failure；
- reconnect reconcile；
- cross-tenant isolation；
- audit completeness。

G5 关闭前不允许把 federation 当作生产可用能力。

---

### 14.8 V5.x — Optional Data Plane / Ecosystem

WireGuard / mimic 类数据面、Plugin Store、移动端等不进入 V5 主线承诺。

任何 V5.x 项目必须先回答：

1. 是否复用 Forward + desired/revision/reconcile；
2. 是否需要新的安全边界；
3. 是否引入新的长期 credential；
4. 是否影响现有 port/link ownership；
5. 是否有独立真实 Gate；
6. 第三方许可证是否允许实现方式。

否则保持 proposal，不进入 Active WP。

---

### 14.9 V5 通用硬规则

1. **V4 frozen baseline 永远是回归门槛。** 每个 V5 Gate 前先证明 V4 TCP DIRECT / RELAY、LKG、drain、diagnostics、authorization 仍然成立。
2. **先契约、后实现。** 跨 Agent/Panel 的新字段与动作先冻结 contract，再并行开发。
3. **先观测、后自动决策。** target health/latency 稳定之前不得上线 automatic failover。
4. **每种协议独立 Gate。** TCP / TLS / WS / UDP / QUIC 不互相代替验证。
5. **不引入第二套真相源。** 新 observation、RoutePlan、remote grant 都必须明确其与 Panel desired 的关系。
6. **不引入第二套控制链。** 新能力继续复用 outbound-only command / desired / ACK / result / reconcile。
7. **错误必须可解释。** capability、protocol、target、HA、hop、federation 的失败都要结构化到可行动错误层，而不是只留日志。
8. **任何自动恢复都有 fencing。** HA/multi-hop/federation 不允许靠“最后写入者获胜”处理双活。
9. **性能退化必须可见。** correctness pass 不等于性能可接受。
10. **许可证继续 fail-closed。** 仓库自身 LICENSE / NOTICE / third-party attribution 未明确前，不把技术 Stable 描述成对外开源授权。

---

### 14.10 V5 分支、PR 与合并规则

V5 分支使用：

```text
feature/v5-wp<N>-<topic>
test/v5-g<N>-<topic>
perf/v5-wp<N>-<topic>
```

例如：

```text
feature/v5-wp0-contract
feature/v5-wp1-capability
feature/v5-wp2-runtime-abstraction
perf/v5-wp3-baseline
test/v5-g0-contract
```

PR 必须继续包含：

- Work Package / Track；
- Depends-On / Blocks；
- Contract Changes；
- schema / compatibility impact；
- rollback；
- unit/integration evidence；
- 对 V4 frozen baseline 的影响；
- 对后续 Gate 的影响。

合并原则：

- 单个 WP 的 CI green ≠ 阶段完成；
- 跨 Track 能力必须经过对应 V5-G*；
- 任何阶段 Gate 未关闭，不得把下一阶段能力混入同一个 PR；
- deprecated V4 API 的删除仍需独立 breaking-change 决策，不夹带在 V5 普通功能 PR。

---

### 14.11 当前执行状态

截至 2026-10-03：

```text
V4.5 frozen baseline        ✅ CLOSED
CI / Integration / Release  ✅ 全链闭环
V5 技术启动条件             ✅ 满足

ACTIVE:
V5.0 Contract Freeze        🟡 开始

NEXT:
V5-WP0 Forward/Protocol Contract
V5-WP1 Capability Negotiation v2
V5-WP2 Runtime Abstraction
V5-WP3 Performance Baseline
V5-WP4 / Gate V5-G0

BLOCKED UNTIL G0:
V5.1 WS/TLS / UDP / QUIC
V5.2 Target Intelligence
V5.3 HA
V5.4 Multi-hop
V5.5 Federation
```

**下一步唯一允许的开发动作：完成 V5.0 的 contract freeze 与 Gate V5-G0；不要直接开始 UDP / QUIC。**


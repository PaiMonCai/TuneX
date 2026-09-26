# V4-WP3 — Forward Rollout Orchestrator 开发报告

- Work package: **V4-WP3 Forward Rollout Orchestrator**（Track C/B，Wave 2 入口）
- Baseline: `feature/v4-wp2-agent-hot-reload` tip **`d3b6779`**（WP2 实现完成态）。`git merge-base --is-ancestor 74f97cd HEAD` 通过 ⇒ WP1 契约 `74f97cd` 与 WP2 全部 commit 均为本分支祖先，血缘写死于 §4。
- Worktree: `/opt/TuneX-v4-wp3`，分支 `feature/v4-wp3-forward-rollout`
- 规范依据: `DEVELOPMENT.md` §13.3.5（统一 Rollout 五阶段）、§13.3.4（Hot Reload 分类）、§13.3.2（Backend/Agent 重启后可继续/补偿 rollout）、§13.3.6（suspended/maintenance 编辑）、§13.6（WP3 DoD）、§13.7（Wave 2 + Gate V4-F1 十项真实验证）、§13.9（分支/PR 约定）
- **本报告先于实现提交**；实现按本报告 §5「实现切片」逐 commit。
- 当前状态：**WP1 已并入 `main`**（`main` @ `619be00d`，"Merge V4-WP1 Forward Revision Foundation into main"）。**WP2 尚未并入 main**：本分支 base 取的是 WP2 的 pre-merge tip `d3b6779`（本报告撰写期间另一代理把 `origin/main` 合进 WP2，得到 `135bbb6`）。因此：本分支**不 merge main、不推送、不实现 WP3**；摘到新 main 的动作归集成代理（§4）。
- 血缘事实：`git merge-base --is-ancestor 74f97cd HEAD` 通过 ⇒ WP1 契约 `74f97cd` 为祖先，WP1 的内容已在本分支内；缺的只是 main 上的那个 merge commit `619be00d` 本身。

---

## 1. 现状盘点（这是全部设计决策的出发点）

写代码前先把「谁已经做了什么、缺什么」钉死。三份契约文件 + 真实后端/Agent 路径核对结果：

### 1.1 WP1 已交付（`74f97cd`，本分支祖先）

| 事实 | 位置 |
|---|---|
| 不可变 snapshot `forward_revision`（`@@unique([tunnel_id, revision])`、`desired_status`、`targets` Json 快照、无 FK 的节点/池列） | `backend/prisma/schema.prisma` `model ForwardRevision` |
| `tunnel.desired_revision_id`（可空、无 FK）+ 兼容投影列同步 | 同上 `model Tunnel` |
| `mergeForwardCandidate` / `validateForwardCandidate(+WithDb)` / `computeForwardImpact` / `createForwardRevision` / `nextRevisionNumber` / `handleRevisionConflict` | `backend/src/services/forward-revision.ts` |
| `PATCH /api/forwards/:id` 全字段 + `expected_revision` → 409 + `POST /:id/preview` | `backend/src/routes/forwards.ts` |
| `patchForward` / `previewForwardUpdate` / `resolveForwardCandidate`（preview 与 update 同源） | `backend/src/services/forward-service.ts` |
| `impact` 已含五阶段全部计划输入：`listener_replacement` / `nodes_prepare_drain` / `target_change` / `egress_target_change` / `ingress_node_change` / `mode_change` / `changes_external_address` / `binding_required` / `desired_address` | `forward-revision.ts#computeForwardImpact` |

**WP1 的收敛出口（必须替换的现状）**：`patchForward` 落库后直接 `reapplyDirectTunnel` / `reapplyRelayTunnel`（`scheduler.ts`）——这两个函数是**创建路径**的编排器：它们自己 `bind_nodes`（可重新选节点）、自己 `allocateTunnelPort`、自己 `config_revision = 读回 + 1`、失败时 `desired_status=inactive` + `apply_status=error`。语义上是"重推一遍创建"，不是"按预先生成的 revision 滚动"。

### 1.2 WP2 已交付（`d3b6779`，本分支 HEAD）

| 事实 | 位置 |
|---|---|
| `PlanForwardSwap(old,new) → SwapPlan{Strategy, DrainOld, FreeOldPort, Upstream, Reason}`，纯函数 | `agent/internal/manager/swap.go` |
| `TunnelManager.HotSwapUpstream(id, addr)` / `ReplaceListener(cfg)` / `DrainTunnel(id, timeout)` / `DrainAllTunnels(timeout)` / `ListenerReplacementNeeded(id,cfg)` / `UpstreamOf(id)` | 同上 |
| `applyRoutedLocked` = manager 锁内**唯一**路由点；两个 apply 面（`control.apply_tunnel`、`POST /tunnel`）都直接调 `ReplaceListener`，不再各自算 plan | 同上 |
| revision 三态（newer → apply / equal → 幂等 no-op / older → `ErrStaleRevision`）经 `ReplaceListener` 复用，语义不变 | 同上 + `tunnel.go#isStale` |
| `Forwarder.Drain` 有界、不可逆、drain 后端口仍绑定（留给 manager 释放）；`Stop()` 后 `releasePortAfterStop` 持锁释放、owner-aware | `forwarder/base.go`、`manager/tunnel.go` |
| `HotSwapUpstream` **不过 revision 闸门**（WP2 报告 §2.2 不变式 2 明文，WP3 若要闸门须自己包一层，不得改 WP2 原语） | `swap.go` 注释 |

### 1.3 现存的 reconciler / 下发链（WP3 必须与之共处，不得重写）

| 组件 | 现状 | 对 WP3 的意义 |
|---|---|---|
| `reconciler.ts` | 纯判定 + 白名单动作（`resend_same_revision` / `fill_missing_runtime` / `release_orphan_lease`）。**严禁** `switch_node` / `change_port` / `migrate_tunnel` / `delete_on_stale`；节点不可达 ⇒ 什么都不做 | WP3 的恢复**不是**往 reconciler 加动作，而是让 rollout 记录本身可续跑（§3.4） |
| `runtime-reconcile-sink.ts` | `resendSameRevision` 读 tunnel 投影列重新 dispatch，校验 `config_revision === revision` 才发 | 这是"当前"的恢复路径，只支持整条重发，**没有五阶段、没有补偿、没有 drain 顺序** |
| `orchestrator.ts` | `dispatchEgress` → `dispatchIngress`（铁律顺序）+ `dispatchDirect` + `removeTunnel(revision+1, 幂等)`。错误码 `agent_unreachable` / `agent_rejected` / `ack_invalid` / `ack_failed` / `revision_mismatch` / `node_unaddressable` | WP3 五阶段直接复用这 4 个方法，**不新增 wire action**（WP2 明确零新增 wire 语义） |
| `agent-command-bus.ts` | outbound-only：`enqueueAgentCommand`(Redis) → Agent pull → ACK 写回 Redis → `waitAgentCommandAck`（TTL 120s / 15s 轮询）。`buildDesiredNodeSnapshot(nodeId)` 是 Agent 启动恢复源 | CLEANUP/补偿必须用**同一** transport；Redis 只是 transport 状态，DB 仍是 canonical |
| `scheduler.ts` | 十步 `SCHEDULER_STEPS` + `StepRecord` + `persistFailure`/`persistSuccess`；`createRelayTunnel` / `reapplyRelayTunnel` / `reapplyDirectTunnel` | 五阶段步骤记录与 `StepRecord` 同构；WP3 **复用其错误码命名空间**，不造第二套 |
| `portPool.ts` | `acquirePort(preferred)` 幂等（同 tunnel/direction 复用、否则 revive）；`releaseLease({leaseId|tunnelId|nodeId})`；`reconcileLeases` 回收悬空+过期 | PREPARE 的端口动作 + CLEANUP 的 lease 回收都走它 |
| `tunnel-api.ts` | retry / suspend / resume / delete。suspend 发 `remove_tunnel` 到两端并 `config_revision+1`；delete 撤两端 + `releaseLease` + 删行 | suspend 不吃五阶段（§3.6）；但它的 `config_revision+1` 与 WP3 的 revision 账本必须共存 |
| WP1 `patchForward` 落库后现状 | `apply_status=pending` → 若 `getOrchestrator()` 非空则**同步** reapply（一次） | **WP3 的接入点**：替换为"登记 rollout + 交给 rollout runner"，失败语义改为 §3.2 |

### 1.4 结论：缺的正是五阶段本身

- 上游已冻结构：目标 config（WP1 snapshot + impact 字段）、每跳能力（WP2 原语 + 判定）、传输与账本（orchestrator + validator + command bus）、恢复底座（reconciler + reconcileLeases）。
- 缺的是把它们按 `VALIDATE → PREPARE → CUTOVER → DRAIN → CLEANUP` 串起来、且**每一步都可从 DB 续跑**的一层；缺 compensation（回退到 applied revision）；缺五阶段与现有 reconciler 的边界划分。

---

## 2. 范围（Scope）

### 2.1 In scope（WP3 交付）

| # | 交付物 | 说明 |
|---|---|---|
| S1 | **五阶段状态机（持久化）** | `forward_rollout` 表记录 phase/steps/attempts/phase_state，重启后可续跑（§13.3.2） |
| S2 | **计划生成 `planRollout(desired_snapshot, current_state)`** | 纯函数：把 WP1 `impact` + WP2 `SwapPlan` 语义 + 节点维度展开成逐步计划（谁 PREPARE、谁 CUTOVER、谁 DRAIN、谁 CLEANUP） |
| S3 | **五阶段执行器 `executeRolloutPlan`** | 每阶段一个已注入 transport/portPool 的 runner；失败按 §13.3.5 分流 |
| S4 | **compensation** | CUTOVER 后失败 → 回退到 last applied revision 的 snapshot；失败 → degraded/error + 可观测 |
| S5 | **Reconciler 恢复接缝** | rollout 可续跑（resume/retry）+ CLEANUP 幂等；**不改** `reconciler.ts` 白名单与禁止清单 |
| S6 | **接入 `patchForward`** | 落库后从"同步 reapply"改为"登记 rollout 并触发 runner"；保持 WP1 的 API 契约与错误码不变 |
| S7 | **定向测试** | 离线单测（纯计划 + 状态机 + 假 transport 全矩阵）+ 真实 loopback Agent 测试（control/manager 已具备的模式）+ MySQL 迁移测试 |

### 2.2 Out of scope（明确不做）

- **不改 wire 协议**：不加新 `CommandAction`，不加新 envelope 字段。五阶段只是 backend 对既有 `apply_tunnel` / `remove_tunnel` 的编排顺序。
- **不改 WP1 契约**：`forward_revision` 表、`PATCH/preview` 形状、`impact` 字段、错误码集合一律不动。WP3 只**读** snapshot、**写** rollout 侧状态。
- **不改 WP2 原语**：`manager/swap.go` 的六个方法签名与语义不变。若实现中确需"带 revision 闸门的 upstream 热换"，在 **backend 侧**包一层（下发的 revision 本身就是闸门），不在 agent 侧改。
- **不改 `reconciler.ts` / `runtime-reconcile-sink.ts` 的语义**：不新增 auto action、不放宽禁止清单。WP3 的恢复走"rollout 续跑"独立路径，reconciler 保持 §7.12 口径。
- **不改 `web/`**（WP4 独占）：不碰 `web/` 一行。若需 UI 展示 rollout 状态，只在本报告 §7 记契约需求，交给 WP4。
- **不碰 `agent/` 的 tunnel 数据面逻辑**：WP2 已冻结。WP3 对 agent 的增量仅限 §5 C8 的 drain 命令面（若最终裁决需要，见 §6 R4）。
- 不改部署配置（`docker-compose*.yaml` / `Caddyfile*`）、不改限流规则表、不做 UDP/QUIC/TLS/多目标 LB（§13.10）。
- 不做 Node lifecycle 联动编排（WP5/WP8 的地盘）：WP3 只**读** `node.lifecycle` 做 VALIDATE 判定，不实现维护期重试队列（WP5 已明文"由 WP3/WP8 的 rollout orchestrator 决定何时下发"，本报告 §3.6 给出最小接缝）。

### 2.3 WP3 与 §13.3.5 的落地映射（本报告的核心约定）

| §13.3.5 规则 | 落地位置 | 判据 |
|---|---|---|
| VALIDATE 失败：旧 applied revision 完全不动 | `planRollout` 纯函数 + VALIDATE 阶段零副作用 | 计划生成失败 ⇒ 不写任何 rollout 行、不动 tunnel 行 |
| PREPARE 失败：回收新资源，旧 runtime 继续 | PREPARE 阶段只做"可回收"的动作：新端口 lease / 新 NodeBinding / egress 侧 apply，失败即 `releaseLease` / 记账下一轮 CLEANUP | 新资源句柄全部记为 `prepared[]` |
| CUTOVER 后失败：优先 compensation 回 last applied revision | CUTOVER 阶段捕获 → compensation 计划（对 applied snapshot 重新 dispatch）+ `ingress` 优先 | compensation 目标 = `tunnel.applied_revision` 对应的 snapshot（WP1 `listForwardRevisions` 可取） |
| compensation 成功：业务继续跑旧 revision，状态展示"更新失败，上一版本仍运行" | `apply_status=error` + `apply_error` 文案带 `previous_revision`；`config_revision` **保持**为新 revision（desired 不回退） | WP1 的"崩溃保留 desired"语义 |
| compensation 失败：degraded/error，由 Reconciler 或人工 Retry 修复 | 新 phase `degraded` + `compensation_error`；reconciler 现有动作 + 人工 retry | reconciler 不改 |
| Cleanup 必须幂等；Backend 重启后可继续清理 | CLEANUP 每步带幂等键（`(tunnel_id, phase, resource_key)`），重复执行走"已清"分支 | 启动恢复时先跑 CLEANUP 再跑未完成 phase |

---

## 3. 契约设计

### 3.1 为什么需要新表而不是复用 `apply_status`

`tunnel.apply_status` 是**单值状态机**（pending/applying/active/error/suspended），表达不了"这一跳到了哪个阶段、哪些资源已分配、补偿到哪一步"。§13.3.2 要求"Backend/Worker 重启后，只靠 DB revision + Agent state report + NodePortLease 就能继续/补偿 rollout"——这句话成立的前提是**阶段进度本身已落库**。因此新增一张 `forward_rollout`：

```prisma
model ForwardRollout {
  id          Int      @id @default(autoincrement())
  tunnel_id   Int
  tunnel      Tunnel   @relation(fields: [tunnel_id], references: [id], onDelete: Cascade)
  /// 本次 rollout 的目标 revision（= tunnel.config_revision 的瞬时值）
  revision    Int
  /// 回退基线：启动本次 rollout 前的 applied_revision（compensation 目标）
  base_revision Int?
  phase       String   @db.VarChar(20)  // validate|prepare|cutover|drain|cleanup|done|failed|compensating|degraded
  /// 阶段步骤记录（JSON：StepRecord[]，与 scheduler.SCHEDULER_STEPS 同构）
  steps       Json?
  /// 已分配/待回收资源句柄（ leaseId / bindingId / egress 命令 id …）
  prepared    Json?
  /// 每个 CLEANUP 项的幂等键执行结果
  cleaned     Json?
  attempt     Int      @default(0)
  last_error_code String? @db.VarChar(64)
  last_error   String?  @db.VarChar(500)
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt

  @@index([tunnel_id, revision])
  @@index([phase])
  @@map("forward_rollout")
}
```

- **expand-and-contract**：纯新增表 + tunnel 侧 relation；不 DROP / 不 MODIFY；回滚代码即整体回滚，不需要逆迁移（§6）。
- **不建第二套真相**：`revision` / `base_revision` 只引用 tunnel 行既有的两个整数；snapshot 内容仍读 `forward_revision`。本表只记"流程进度"，不复制任何 runtime 事实（§8.3）。
- 一条 tunnel 同一时刻**至多一条**未完成 rollout：由服务层 `updateMany where phase in (active set)` 抢占；DB 层面不加唯一键（允许历史多行，便于排障）。

### 3.2 `planRollout`：纯函数（本包的核心）

输入：`ForwardCandidateConfig` desired snapshot（WP1）、当前 applied snapshot（WP1 `listForwardRevisions`）、节点/端口事实（复用 `ForwardCandidateContext` 同源查询）、WP2 判定在 backend 的**镜像**。

输出（`RolloutPlan`）：

```ts
type RolloutPhase = "validate" | "prepare" | "cutover" | "drain" | "cleanup";

interface RolloutStep {
  phase: RolloutPhase;
  kind:
    | "validate"          // 零副作用
    | "acquire_port"      // ingress / egress 端口（幂等 preferred）
    | "ensure_binding"    // RELAY 新 NodeBinding
    | "prepare_egress"    // EGRESS 侧 apply（RELAY）
    | "cutover_ingress"   // 入口 apply（= WP2 ReplaceListener 目标）
    | "cutover_egress"    // EGRESS 侧切换（换节点/换池时）
    | "drain_ingress"     // 旧入口 drain（端口迁移/节点迁移）
    | "drain_egress"      // 旧 EGRESS drain
    | "release_old_lease" // 旧端口租约释放（等 drain 完）
    | "drop_old_egress"   // 撤旧 EGRESS runtime
    | "release_binding"?; // 本期不做（§13.3.1：Binding 不因 Forward 修改自动删）
  node_id?: number | null;      // Node.id
  direction?: "ingress" | "egress";
  port?: number | null;
  idempotency_key: string;      // `${tunnel}:${revision}:${phase}:${kind}:${node_id}:${port}`
  meta?: Record<string, unknown>;
}

interface RolloutPlan {
  revision: number;
  base_revision: number | null;
  strategy: "metadata_only" | "target_hot_swap" | "listener_replace" | "node_migration" | "mode_switch" | "noop";
  steps: RolloutStep[];
  blocking: { code: string; message: string }[];  // 非空 ⇒ VALIDATE 失败，不执行
  warnings: string[];
}
```

**判定表（与 §13.3.4 逐行对应；`listener_replacement` 等输入取自 WP1 `computeForwardImpact`，节点维度展开成本表的 steps）**：

| §13.3.4 修改 | strategy | steps（ ingress / egress 两维展开） |
|---|---|---|
| 名称（metadata） | `metadata_only` | **不生成 rollout**（WP1 已不生成 revision；此处防御性分支只记 noop） |
| Target Host/Port（direct） | `target_hot_swap` | PREPARE: `validate`；CUTOVER: `cutover_ingress`(同端口)；DRAIN/CLEANUP: 无（WP2：旧 forwarder 即存活者） |
| Target Host/Port（relay，池内目标） | `target_hot_swap` | CUTOVER: `prepare_egress`(先装池) + `cutover_egress`；DRAIN: 无 |
| Listen Port（direct 或 relay） | `listener_replace` | PREPARE: `acquire_port`(新)；CUTOVER: `cutover_ingress`(新端口)；DRAIN: `drain_ingress`；CLEANUP: `release_old_lease` |
| Ingress Node 迁移 | `node_migration` | PREPARE: `validate` 新节点 + `acquire_port`(新节点)；CUTOVER: `cutover_ingress`(新节点, **新 listener**)；DRAIN: `drain_ingress`(旧节点)；CLEANUP: `release_old_lease`(旧节点) + `drop_old_egress`(若旧 egress 一起迁) |
| Egress Node 迁移（relay） | `node_migration` | PREPARE: `validate` + `ensure_binding`(新 pair) + `prepare_egress`(新节点)；CUTOVER: `cutover_egress`(新) → `cutover_ingress`(next_hop 更新)；DRAIN: `drain_egress`(旧)；CLEANUP: `release_old_lease`(旧 egress 端口) + `drop_old_egress`(旧) |
| DIRECT → RELAY | `mode_switch` | PREPARE: `validate` + `ensure_binding` + `prepare_egress`；CUTOVER: `cutover_ingress`(upstream 从 target 变 next_hop，**同 listener**，§13.3.4) → `cutover_egress`；DRAIN: 无；CLEANUP: `drop_old_egress`(若此前有) |
| RELAY → DIRECT | `mode_switch` | PREPARE: `validate`(direct 目标)；CUTOVER: `cutover_ingress`(同 listener 换 upstream)；DRAIN: `drain_egress`(旧)；CLEANUP: `drop_old_egress` + `release_old_lease`(egress 端口) |
| 多字段同时改 | 以上策略的**合并** | 一次 revision ⇒ 一个 plan；步骤按 §13.3.5 顺序去重排序（同 phase 内 PREPARE 全部先于 CUTOVER） |
| 端口 + 入口节点同时改 | `node_migration` | 两者合并为新节点新端口（一次 cutover），不拆成两次 rollout |

两条硬约束：

1. **CONP 顺序（corridor-next-hop 铁律）**：RELAY 的 steps 中 `prepare_egress` 一定早于 `cutover_ingress`——否则入口先指向一个还不存在的 next_hop。这与 `orchestrator.ts` 现存铁律（`dispatchEgress` 必须先于 `dispatchIngress`）一致，WP3 不制造新的顺序例外。
2. **没有任何步骤对同一资源产生互斥顺序**：同一 phase 内步骤可重排（便于未来并行 PREPARE）；跨 phase 严格有序。

### 3.3 五阶段执行器

每个 runner 都是 `(step, ctx) => stepOutcome`，ctx 注入 `transport`（= `Orchestrator`）、`portPool`、`db`。所有写库经一个 `commitRollout(rolloutId, patch)`，patch 是追加式（`steps.push` / `prepared.push` / `cleaned.push`），因此**并发安全且可续跑**：重启后读回 rollout 行，按 `steps` 中已完成集合决定下一步。

| phase | 动作 | 失败分流（§13.3.5） |
|---|---|---|
| VALIDATE | 跑 `planRollout`；`blocking` 非空即失败 | → `failed`，tunnel 行不动（`apply_status` 保留、`applied_revision` 保留） |
| PREPARE | `acquire_port`（`acquirePort({preferred})`，幂等）/ `ensure_binding` / `prepare_egress`（EGRESS apply，ACK 后不切入口） | 失败 → 释放本轮 `prepared` 的 lease / 撤已 ACK 的 egress → `failed`；`apply_status` 记 `error` + `apply_error_code`，**`applied_revision` 不动、tunnel 旧 runtime 继续** |
| CUTOVER | `cutover_ingress`（旧实例由 agent 内部正确路由）；失败 → §3.4 compensation | → `compensating` |
| DRAIN | `drain_ingress` / `drain_egress`（WP2 `DrainTunnel` 语义；backend 侧用 `remove_tunnel` 表达"停止接受新连接后等待在途退出"——见 §6 R3） | drain 失败只记 warning（在途连接已由 kernel 超时兜底），**不阻塞**CLEANUP |
| CLEANUP | `release_old_lease`（等 drain 完成后）/ `drop_old_egress`（`removeTunnel`，幂等 revision+1） | 幂等重试；失败记 `degraded` 但不影响已生效的新 revision |

### 3.4 compensation

```ts
async function compensate(rollout): Promise<CompensationResult>
```

1. 读 `base_revision`（若无 snapshot：按 WP1 的兼容投影列合成基线，与 `currentDesiredConfig` 同口径）。
2. 用 `orchestrator.removeTunnel({ revision: revision + 1 })` 撤掉**本次已切过去的新** runtime（两端），再对 `base_revision` 的完整 snapshot 重新 dispatch。revision 用 `base_revision + 1` 的可见值由 WP2/stale 闸门保证不被当作 stale——**关键**：Agent 侧 `isStale(next, current)` 判 `next < current` 才拒；撤旧用 `revision+1` 已是现有 `removeTunnel` 的做法（`orchestrator.ts` 注释），重放基线直接用**基线 revision 本身**会同 revision ⇒ `ReplaceListener` 判 equal ⇒ **幂等 no-op，什么都不做**，这正是我们要的"基线还在跑就别动它"。
3. 结果分流：
   - 成功 ⇒ `apply_status=error`、`apply_error` 含 `rollout_id` + `previous_revision`、`config_revision` 保持目标 revision（desired 不回退）。
   - 失败 ⇒ `phase=degraded` + `compensation_error`；此时由现有 reconciler 的 `resend_same_revision` + 人工 Retry 继续。**不改** reconciler 白名单。

### 3.5 Reconciler 恢复接缝（本包与 reconciler 的边界）

WP3 **不修改** `reconciler.ts`、`runtime-reconcile-sink.ts` 的语义。接缝是：

- Worker 的 `cron_reconcile_v3` 之前（或作为其同轮的第一步）调用 `resumeRollouts()`：扫描 `phase in (prepare|cutover|drain|compensating)` 的非 done rollout，按 `id` 升序逐个续跑。续跑 = 重放未完成 steps（幂等键去重）。
- CLEANUP 的幂等由 `cleaned` 数组 + 各步骤自身幂等性保证（`releaseLease` 对已 released 是 no-op、`removeTunnel` 对未知 id 是 no-op——两者都已在代码注释里写明）。
- 被动触发：`patchForward` 落库后立即跑一次 runner（同步），失败留给下轮 worker。
- **reconciler 与 rollout 的分工**：reconciler 只处理"同 revision 重发"与"缺失 runtime 补发"（现状不变）；rollout 处理"跨阶段推进/补偿"。若两者同时触及同一 tunnel，reconciler 的 `resendSameRevision` 读到的新 revision 与 rollout 目标 revision 一致 ⇒ Agent 侧按 revision 三态收敛，不会双份生效。

### 3.6 suspended / maintenance 的接缝

- **suspended**（§13.3.6）：`patchForward` 在 `apply_status === "suspended"` 时仍生成 revision，但 rollout 计划落到 `phase=done` 的 noop（desired 已存，不启 runtime）。`resume` 时（`tunnel-api.ts` 现有路径置 `apply_status=pending` + `desired_status=active`）worker 的 `resumeRollouts` 对该 tunnel 重新生成 plan 并执行——这就是"resume 时只应用最新 revision"。
- **maintenance**（§13.3.6 + WP5 契约）：VALIDATE 阶段的准入判定读 `node.lifecycle`（列名/枚举值与 WP5 迁移 SQL `ALTER TABLE node ADD COLUMN lifecycle ENUM('active','maintenance','disabled','retiring')` 逐字一致）。非 `active` ⇒ `blocking: { code: "node_in_maintenance" | "node_retiring" | "node_disabled" }`，rollout 停在 `prepare` 前的 `waiting` 态；WP5 已明文"由 WP3/WP8 决定何时下发"。**最小接缝**：`waiting` 态 rollout 由 `resumeRollouts` 每轮重试 VALIDATE，节点恢复 `active` 后自然放行。**不在本期**做独立的重试队列（WP5 只提供 `nodeAdmission` 谓词，不实现 orchestrator 的延后重试队列，本包同样只做最小实现）。

### 3.7 API / 可观测面（不加新端点）

- **不新增对外端点**。五阶段对用户不可见（§13.7 Wave 4 才要求产品状态语义化）。
- `forwardView` 的**既有字段零改动**（WP4 已依赖）：`apply_status` 取值集合仍是 `pending/applying/active/error/suspended`——WP3 的 `failed/degraded/compensating` 归并为 `error` + `apply_error_code`，`rollout_id` 放进 `apply_error` 文本。这样 WP4 无需改动即可展示"更新失败，上一版本仍运行"。
- **本报告给 WP4 的契约交接**：若 WP4 想在详情页展示"正在滚动"（`apply_status=applying` + `desired>applied`），已有字段即足够；若想要 rollout 阶段明细，需要 WP3 v2 增加只读字段——记入 §7，不在本期扩张。

---

## 4. 分支血缘与并行边界（写死，供集成代理）

```
main (619be00d = 9a489b5 + WP1 merge)
  └── feature/v4-wp1-forward-revisions (74f97cd)   ← WP1 契约冻结点，已 merge 进 main
        └── feature/v4-wp2-agent-hot-reload (d3b6779) ← WP2 实现 tip
              └── feature/v4-wp3-forward-rollout (HEAD = d3b6779 + 本报告)

（WP2 分支侧另有 135bbb6 = merge origin/main；本分支刻意不摘 main，见上文）
```

- 基线由 `git worktree add /opt/TuneX-v4-wp3 -b feature/v4-wp3-forward-rollout d3b6779` 创建；`git merge-base HEAD 74f97cd == 74f97cd`，`git merge-base --is-ancestor d3b6779 HEAD` 通过，`git rev-list --count 74f97cd..HEAD` 当前含 WP2 的 13 个 commit **加本报告 C1**。
- **WP3 不得 merge 到 main 早于 WP2**：WP1 已进 main（`619be00d`），WP2 尚未。WP3 分支暂驻 WP2 pre-merge tip `d3b6779`。WP2 进 main 后，集成分支用 `git merge origin/main` 把 WP3 摘到新 main 上（保留血缘；不改写历史、不强推）。
- 文件边界（硬约束）：只写 `backend/**`（迁移 + `src/services/forward-rollout*.ts` + 既有文件的**最小**接线）与 `reports/v4-wp3-plan.md`（本文件）。若实现中必须改 `agent/`（预期不需要）或 `web/`（绝对不允许）——**停下来报告**。
- 推送纪律：普通 push，**绝不 force**。

### 4.1 并行冲突风险（写前预判，避免踩坑）

| 并行分支 | 已知改动 | 与 WP3 的交集 | 冲突处理约定 |
|---|---|---|---|
| WP4 `feature/v4-wp4-forward-edit-web`（`5ee4709`，base 74f97cd；origin 已到 `69e866c` = merge origin/main） | `web/src/mocks/handler.ts`、`web/src/components/forwards/**`、`web/src/lib/types.ts` 的 Forward 段 | 无文件交集 | 无需处理；WP4 已声明"不碰 backend 一行" |
| WP5 `feature/v4-wp5-node-lifecycle`（`5f11c9d`，base 9a489b5；分支侧另有 `1f60965` = merge origin/main） | `backend/prisma/schema.prisma`（`Node` + 新枚举）、`backend/src/services/node-lifecycle.ts`（新）、`backend/src/routes/node-lifecycle.ts`（新）、`backend/src/app.ts`、`backend/src/__tests__/lifecycle-db-stub.ts`（新）、`backend/package.json`（test glob 修正） | **`schema.prisma`** 与 `backend/package.json` | WP3 的 schema 块只出现在 `model Tunnel` 增量区 + 新 `model ForwardRollout`；WP5 的块只在 `model Node` + 新枚举 ⇒ 按块解冲突，双方保留。**`backend/package.json` 只取 WP5 那行 test glob 修正**（本分支基于 WP2，尚未含该修正）——集成时代理须注意回填。迁移目录各自独立（WP3 用 `20261009xxxxxx_v4_wp3_forward_rollout`，与 WP5 `20260927000000` 不撞） |
| 未来 WP6/WP8（node telemetry） | `node-state.ts` / health synthesis | 仅**读** `node-state.ts` 的既有类型，不写 | 不处理，届时按 §13.7 Wave 3 顺序 |

---

## 5. 实现切片（每片一个 commit）

| Commit | 内容 | 边界 |
|---|---|---|
| C1 | `reports/v4-wp3-plan.md`（本报告） | 仅文档 |
| C2 | Prisma additive migration + `schema.prisma`（`forward_rollout` 表 + `Tunnel` relation 反向边） | 仅 `backend/prisma/**` |
| C3 | `services/forward-rollout.ts`：类型 + `planRollout` 纯函数 + `RolloutPlan` 判定表 + 离线单测 `__tests__/forward-rollout-plan.test.ts` | 新文件 + 新测试 |
| C4 | 同文件追加：`executeRolloutPlan` 五阶段 runner（注入 `transport`/`portPool`/`db`）+ `compensate` + 步骤/资源记账 + 单测 `__tests__/forward-rollout-execute.test.ts`（假 transport 全矩阵） | 只改 forward-rollout.ts + 新测试 |
| C5 | `services/forward-rollout-recovery.ts`（新）：`resumeRollouts` / `sweepCleanups`（纯 IO 编排，复用 C4 的 runner） + 单测 | 新文件 + 新测试 |
| C6 | 接线 `services/forward-service.ts` 的 `patchForward`：把"synchronous reapply"替换为"登记 rollout + 触发 runner"；保持 API 契约/错误码不变；既有 `forward-revision.test.ts` 全绿 | 只改 forward-service.ts（最小 diff） |
| C7 | 接线 `src/worker.ts` 的 `cron_reconcile_v3`：同轮先调用 `resumeRollouts()`（失败不影响后续 reconcile） | 只改 worker.ts |
| C8 | 迁移测试 `tests/forward-rollout-migration.test.mjs`（CI 的 MySQL backend job 执行） | 仅 `backend/tests/**` |
| C9 | 报告同步实际切片与验收结果 | 仅文档 |

`test:unit` 是目录 glob（`bun test src/services/__tests__/ src/__tests__/`），C3/C4/C5 的测试文件**自动进入 CI**；`backend/tests/*.test.mjs` 同理自动进入 `bun run test`。**本次不改 `.github/workflows/ci.yml`**（与 WP1/WP2/WP4 相同的高频冲突规避，也避免 WP5 已改 `backend/package.json`  staleness）。

**实现顺序的硬约束**：C2 → C3 → C4 → C5 → C6 → C7，任何一片不得在上一片 CI 绿之前开工。C6/C7 的 diff 必须保持"可逐行评审"的最小形态：`patchForward` 只把 `reapplyDirectTunnel/reapplyRelayTunnel` 两行换成 `registerRollout(...)`，`worker.ts` 只在 `cron_reconcile_v3` case 顶部加两行。

---

## 6. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | `scheduler.ts` 的 reapply 仍被 `createForward` 使用（创建路径），WP3 只改 PATCH 路径 ⇒ 同一 tunnel 有两条编排入口 | 创建与编辑语义分叉 | 本期只改编辑路径（§13.7 Wave 2 要求）。创建路径迁到 rollout 是**后续独立切片**，在本报告 §7 交接给集成代理；不在本期混做（§8.1 一个 PR 一个 WP） |
| R2 | `tunnel-api.ts` 的 suspend/delete 路径直接发 `remove_tunnel`，与 CUTOVER/DRAIN/CLEANUP 的时序可能交叉（用户在滚动中 suspend） | 端口租约/runtime 双份 | CLEANUP 的 `drop_old_egress` 与 delete 的 `remove_tunnel` 都幂等（未知 id no-op）；rollout 表加 `tunnel` 存在性检查，rollout 行的 tunnel 已删 ⇒ `phase=done` 跳过。suspend 语义见 §3.6（走 noop rollout） |
| R3 | backend 侧没有"drain 后等待在途退出"的同步原语：WP2 的 `DrainTunnel` 在 agent 侧，wire 上只有 `remove_tunnel`（它会 `Stop()`，即 drain + 关监听） | DRAIN 阶段语义弱化为"remove" | 本期把 DRAIN 实现为 `remove_tunnel`（已在 `tunnel-api.ts#suspend` 用过该表达）。**wire 不加新 action**。若 Gate V4-F1 要求"drain 期间端口仍保留"，须扩 wire——记为 §7 交接项，本期不做 |
| R4 | 若确实要 wire drain 原语，就要动 `agent/` | 越界（WP2 独占） | **先停下来报告**，由主会话裁决是否开独立 WP3b；不得在本分支内改 agent |
| R5 | `config_revision` 被 suspend（`tunnel-api.ts` 的 `+1`）与 WP1 的 `createForwardRevision`（`max+1`）双写 | rollout 的 `revision` 与 snapshot revision 脱钩 | rollout 行只记 `revision` 与 `base_revision` 的**数值**，执行时以 snapshot 为准（`listForwardRevisions(revision)` 取不到 ⇒ VALIDATE 失败并记 `revision_conflict`）。suspend bump 的 revision 没有 snapshot ⇒ 该 tunnel 的编辑 rollout 会先回退到投影列基线合成（WP1 已有同口径逻辑） |
| R6 | Gateway 竞态：`patchForward` 同步触发 runner，用户在 15s ACK TTL 内多次保存 | rollout 排队覆盖 | 同期至多一条未完成 rollout（`updateMany where phase in active` 抢占），后到者 `409 revision_conflict`（WP1 已实现该闸门） |
| R7 | WP5 的 lifecycle 准入依赖：`nodeAdmission` / `lifecycleAcceptsBusiness` / `businessRejectionCode`（`services/node-lifecycle.ts`）在 WP2 基线上不存在，import 会编译失败 | WP3 未合并前引不到 | VALIDATE 用**本地等价常量**：放行集合 `["active"]`、阻断码 `node_in_maintenance` / `node_retiring` / `node_disabled`（与 WP5 `node-lifecycle.ts#businessRejectionCode` 逐字一致，`disabled` 即为 WP5 的 fail-closed 兜底）。注释标"WP5 并入后改为 import `nodeAdmission`"。**理由**：评审必须能对着两处代码确认语义零漂移，而不是靠一句描述 | WP5 并入 main 后由 §7.3 项替换 |
| R8 | 空库/升级库迁移测试里 `forward_rollout` 与 WP5 迁移的顺序 | `migrate deploy` 失败 | 两者都纯 additive（无 MODIFY/DROP），顺序无关；迁移目录时间戳不撞 |
| R9 | secret-scan | CI 红 | 报告/测试不含真实口令；测试 URL 一律变量拼装 |

---

## 7. 依赖 Gate 与交接项

### 7.1 本包启动前置

| Gate | 状态 | 说明 |
|---|---|---|
| WP1 `feature/v4-wp1-forward-revisions` 并入 main | ✅ 已满足（`619be00d`） | WP1 契约内容已在本分支内（血缘祖先 `74f97cd`）；分支缺的只是 main 上的 merge commit 本身 |
| WP2 `feature/v4-wp2-agent-hot-reload` 并入 main | ❌ 未满足 | WP2 分支侧已含 main（`135bbb6 = merge origin/main`），但**尚未** merge 回 main。本分支 base 是 `d3b6779`（pre-merge tip）——这个选择正确：它不含 `619be00d`，因此"本分支尚未摘到新 main"在血缘上是显式的、可被集成代理验证的 |
| WP1 + WP2 CI 绿 | ✅（WP1 run 36184882122；WP2 每 commit 一跑；WP1→main 合并后 main CI 亦已跑过） | — |
| 主会话确认"WP2 可 merge main" | ❌ | 合并 main 动作由主会话/集成代理执行，本分支不自行 merge |

**注意**：WP2 进 main 后，`135bbb6` 与本分支的 merge-base 仍是 `d3b6779`，集成代理须用 `git merge origin/main`（不是 rebase）把本分支摘到新 main——保留 WP1/WP2 血缘，与 WP2 报告 §4 的做法一致。

### 7.2 WP3 自身出口 Gate

- 本分支 CI 三 job（backend / web / agent）全绿；backend job 的 `prisma migrate deploy` + integration 步骤通过。
- PR 描述按 §13.9 模板补齐：`Desired/Applied Revision Impact` 写"新增 rollout 记账表，不动 revision 生成规则"；`Hot Reload / Drain Impact` 写"消费 WP2 原语，不改 agent"；`Rollback` 写"纯代码回滚，无 DB downgrade"。
- **Gate V4-F1 的十项真实验证归属**：§13.7 列出的十项中，九项需要 WP3 的 rollout 真实跑通（target host/port 热修改、listen port 修改、RELAY 换 Egress、DIRECT↔RELAY、Ingress migration、multi-field single revision、update 失败旧 applied 继续运行、suspended edit + resume、Backend/Agent 重启后恢复）。因此 **WP3 的"实现完成"≠ Gate V4-F1 通过**；Gate 由集成代理用 v3-e2e harness 扩展（见 7.3）执行，结论写入 WP3 报告的 C9。
- WP3 进 main 且 Gate V4-F1 绿后，WP4 才能最终 merge（§13.7 明文）。

### 7.3 交接给后续代理的项（本报告明确不做）

| 项 | 归属 | 内容 |
|---|---|---|
| 创建路径也走 rollout | 后续独立切片 | `createForward` 的 `reapplyDirectTunnel/reapplyRelayTunnel` 迁到 rollout，消灭 R1 |
| wire drain 原语 | 需主会话裁决 | R3/R4：`DrainTunnel` 的 panel 侧表达；若要做须动 `agent/` ⇒ 独立 WP3b，且 WP2 原语语义不变 |
| rollout 阶段明细的只读 API 字段 | WP4/WP8 | `apply_status` 保持现有五值；阶段细节若要展示需 WP3 v2 加只读字段 |
| WP5 `lifecycle` import 替换 | WP5 并入后 | R7 的本地常量改为 `import { NODE_LIFECYCLES }` |
| E2E 扩展 | 集成代理 | `scripts/v3-e2e/verify.sh` 追加 T9+（五阶段真实断言：改端口后旧端口在 drain 期间仍保留、RELAY 换 Egress 不断连、重启后 rollout 续跑）；`backend/tests/v3-e2e/{direct,relay}.e2e.test.mjs` 追加同源断言。**不得**用"改绿/跳过"方式让 Integration 通过（README §6 明禁） |
| `backend/package.json` 回填 WP5 的 test glob 修正 | 集成代理 | 本分支基于 WP2，尚不含 WP5 的 `test:unit` 修正 |

---

## 8. 验证与回滚

- 验证：CI 三 job 全绿 + backend job 迁移与 integration 步骤；local 只跑单文件 `bun test src/services/__tests__/forward-rollout-*.test.ts`（skill 纪律：小内存机器不跑 tsc / next build / 多文件 bun test）。
- 回滚：纯代码 + additive 表，**不需要 DB downgrade**（§6/§8.5）；`forward_rollout` 表与 rollout 行保留无害。R1/R3 的"半迁移"状态（创建路径未迁）不影响回滚，因为 rollout 表只是旁路记账。

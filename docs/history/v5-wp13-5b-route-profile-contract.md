# V5-WP13.5B — Route Profile 契约（FROZEN）

> **状态：FROZEN（2026-10-05）**，对应 `DEVELOPMENT.md` §9.4.2–§9.4.6 / §3.4 / §13。
> 本文是 Route Profile 的**唯一语义来源**：字段、版本与变更传播、visibility/entitlement、
> 编译到 `RoutePlan` 的规则、错误码分层，以及与 Forward / RoutePlan / NodeGroup 的边界。
> 实现（schema / service / API / 测试）若与本文冲突，以本文为准并回来改契约，而不是
> 让实现悄悄改写语义。
>
> 与 §9.4.2「Route Profile 定位」的关系：本文不改 §9.4 的结论，只把它变成可实现、
> 可测试、可拒绝的形态。行号/符号名的引用以当前工作树的**符号名**为准。

---

## 0. 一句话定位

~~~text
Route Profile = 可复用、可版本化的**模板 / 意图**（管理员编排线路）
RoutePlan     = 某次 ForwardRevision 已经解析出的**具体执行路径**（具体节点事实）
~~~

Route Profile 是 `Node / NodeGroup → Route Profile → Forward → ForwardRevision → RoutePlan
→ RuntimePlan` 这条链上的**模板层**，也是这条链上唯一允许被反复编辑的一层。
它把「模板」与「已应用的运行时事实」用 `version` + `Impact Analysis` + 显式 `apply`
隔开：**编辑模板永远不触碰正在运行的 Forward**。

---

## 1. Route Profile 拥有什么 / 不拥有什么（冻结）

### 1.1 拥有（唯一真相）

~~~text
模板意图       ingress selector / ordered transit[] / egress selector
路径策略       ingress policy / egress policy
准入约束       health / placement constraints
能力要求       required capabilities
产品属性       name / description / visibility / enabled
版本账本       version（1 起单调递增）+ 每个版本的不可变快照
授权归属       ASSIGNED 的 workspace / plan 授权行
~~~

### 1.2 **不拥有**（硬边界，写成代码就是禁止项）

~~~text
Agent runtime                    —— 归 Forward / rollout / orchestrator
NodePortLease / placement lease  —— 归 Node 与 Forward 的 rollout
Forward lifecycle                —— 归 Forward（desired_status / apply_status）
applied revision                 —— 归 tunnel.config_revision / applied_revision
traffic counter                  —— 归 traffic 管线
独立 reconcile                   —— 禁止：复用既有 reconciler / scheduler
独立 restart / stop 状态机       —— 禁止：Route Profile 没有状态机
~~~

**推论（可执行断言）**：Route Profile 表里没有 `status` / `applied_*` / `traffic_*` 列；
`apply` 只能通过既有 `patchForward`（→ `createForwardRevision` → `registerRollout`）产生
效果，本 WP **不新增下发通道、不新增状态机、不新建第二套路由模型**。

---

## 2. 字段语义（第一版）

| 字段 | 类型 | 语义与约束 |
|---|---|---|
| `id` | int | 主键 |
| `workspace_id` | int | 资源域。跨 workspace 一律 404（不泄露存在性） |
| `user_id` | int | 创建者（审计归属，与 NodeGroup 同口径） |
| `name` | varchar(120) | 同 workspace 内唯一；改名不 bump version |
| `description` | varchar(500)? | 自由文本 |
| `visibility` | varchar(20) | `INTERNAL` \| `ASSIGNED` \| `PUBLIC`。**字符串列 + 应用层校验**（§3.4：不用 DB enum 承载会扩展的集合）；未知值 fail-closed |
| `enabled` | bool | 关闭后：不再允许 apply / 不再对用户可见；**已应用的 Forward 不受影响** |
| `version` | int | 当前已发布版本号，1 起单调递增。模板内容变更**只能**通过发布新版本 |
| ingress selector | json | `{kind:"fixed_node",node_id}` 或 `{kind:"node_group",node_group_id,strategy}` |
| ordered transit[] | json | **有序**数组，元素只允许 `{kind:"fixed_node",node_id}`（第一阶段） |
| egress selector | json? | 同上；`null` = DIRECT（出口就是 ingress 那一跳） |
| ingress policy | json? | 端口/监听/协议等入口侧策略（应用层校验，未知键 fail-closed） |
| egress policy | json? | 出口侧策略（同上） |
| constraints | json? | health / placement 约束（见 §4.3） |
| required capabilities | json? | 字符串数组；解析出的每个节点都必须满足（§4.4） |
| `published_at` | datetime? | 当前版本的发布时间 |
| `created_at` / `updated_at` | datetime | 审计 |

版本不可变行 `route_profile_version` 保存该版本**完整模板内容**（`body` json）+
`change_summary` + `created_by_id`：这是「这条 revision 当时用的是什么」的唯一可回溯源。
`route_profile` 行上的模板列是**当前版本的投影**（与 `tunnel` ↔ `forward_revision`
的投影模式一致），不是第二份真相。

---

## 3. 版本与变更传播（冻结）

~~~text
RouteProfile vN
      ↓ 发布新版本（POST /:id/versions）
RouteProfile vN+1            ← 模板侧；此时运行中的 Forward 一个字节都没变
      ↓
Impact Analysis（只读）
      ↓
显式 apply / rollout（POST /:id/apply，forward_ids 必须显式列出）
      ↓
new ForwardRevision（既有 createForwardRevision）
      ↓
RoutePlan snapshot（既有 RoutePlan）
~~~

规则：

1. **内容变更只能产生新版本**。`PATCH /:id` 只能改 `name / description / visibility /
   enabled`，不改模板内容 —— 与 Forward 的「纯 metadata 不生成 revision」同一条纪律。
2. **不要静默重写**。任何 Forward 的运行时配置只由 `apply` 改变；编辑共享模板本身
   不触发下发、不 bump 任何 `tunnel.config_revision`。
3. **显式 apply**。`apply` 必须显式给出 `forward_ids[]`（不提供「应用到全部」的隐式形式），
   并对每个 Forward 做 `expected_revision` 闸门；冲突返回 409 而不是覆盖。
4. **快照可解释**。`apply` 成功时写入 provenance：`route_profile_id` /
   `route_profile_version` / 解析出的具体跳（`resolved_hops`），落在
   `forward_revision`（不可变快照列）与 `route_profile_application`（申请账本）两处。
   运行期因此永远能回答「这次为什么发到这些节点」。
5. **applied runtime 不依赖可变模板**。已应用的 Forward 只读自己的 revision snapshot；
   模板随后被编辑 / 禁用 / 删除都不得改写它的行为。
6. **无自动 rollout**。本 WP 不做「发布即全量生效」；版本传播是运营动作，不是副作用。

---

## 4. 编译规则（Route Profile → 具体节点 → RoutePlan）

编译器只做**一件事**：把模板 selector 解析成具体节点事实，然后交给既有的
`buildRoutePlan` / `routeViolations` / `admitRoute` / `routeSteps`（`services/forward-route.ts`）。
**不得**新建第二套路由模型、图搜索或状态机。

### 4.1 selector 形态

~~~text
{ kind: "fixed_node", node_id }
{ kind: "node_group", node_group_id, strategy }
~~~

- ingress：`fixed_node` 或 `node_group`；`strategy ∈ {failover, round_robin, random, least_conn, ip_hash}`
- transit[]：**只允许 `fixed_node`**，且顺序即跳序（§9.4.4 第 4 条：不让每个 middle 变成动态
  候选池，避免组合爆炸）。出现 `node_group` ⇒ `unsupported_topology`（fail-closed）。
- egress：`fixed_node` 或 `node_group`；`strategy ∈ {fallback, round_robin, random, least_conn, ip_hash}`
- `egress` 缺省（`null`）= DIRECT：`buildRoutePlan` 把 hop N-1 定为 ingress 自己。

### 4.2 候选解析（确定性优先）

候选节点事实由**调用方**作为事实传入（编译器不读库、不猜）：`node_id / node_group_id /
role / status / lifecycle / health / region / load / capabilities`。

~~~text
fixed_node           → 该节点；不存在 / 不在候选事实里 ⇒ no_eligible_node
failover             → 按 (order_by, id) 第一个 eligible；没有 ⇒ no_eligible_node
round_robin          → 以调用方给出的 rotation_seed（如 forward_id）取模，确定性可复现
random               → 编译期抽一次，随后**冻结进快照**（运行期绝不重抽）
least_conn           → 取 load 最小者（并列时按 (order_by, id) 决胜，保证确定性）
ip_hash              → 以调用方给出的 hash_key 取模（同一 key 稳定映射同一节点）
fallback             → 同 failover 的「按序取第一个 eligible」
~~~

**确定性是硬要求**：同一个模板 + 同一份候选事实 + 同一个 seed，必须得到同一个具体节点。
「随机」只在编译那一刻发生一次，结果立刻落快照 —— 运行期没有任何随机挑选
（§9.4.3：运行时必须使用确定的具体节点事实，不能让 Agent 从 NodeGroup 随机挑）。

### 4.3 constraints（health / placement）

~~~text
exclude_node_ids[]      显式排除
allowed_lifecycles[]    允许的 lifecycle；**缺省 = 只允许 active**（fail-closed）
require_health[]        允许的健康态（取值域与 node-health.ts 的 NODE_HEALTHS 一致：
                        healthy / warning / error / unknown）；缺省 = 不额外要求
require_node_binding    相邻跳是否必须有 NodeBinding（默认 true，交由 admitRoute 判定）
~~~

未知的约束键 **fail-closed**（`invalid_input`），不静默忽略。

**合格与否只用既有 `nodeAdmission`（§13.4.2 的唯一实现）**，本层不新增第二套准入规则：
maintenance / disabled / retiring / 未安装凭据（waiting）都不是合格候选。「活节点」由
**显式** `require_health` 表达 —— 既有 `nodeAdmission` 允许「已安装但当前离线」的节点
作为候选（它可能在 apply 窗口内重连），把这一点写在这里而不是悄悄改严。

### 4.4 required capabilities

解析出的每个具体节点都必须满足 `required_capabilities`；不满足的候选被过滤，
一个都不剩 ⇒ `capability_unavailable`。capability 是**准入事实**，不是授权
（§14：capability advertisement 不能成为授权来源）。

### 4.5 编译输出

~~~ts
{
  placement: { ingress_node_id, egress_node_id, middle_node_id, tunnel_mode: "direct"|"relay" },
  plan: RoutePlan,          // 既有 buildRoutePlan 的产物
  steps: RouteStep[],       // 既有 routeSteps 的产物（先远后近）
  provenance: { route_profile_id, route_profile_version, resolved_hops: [{hop_index, role, node_id}] }
}
~~~

`admitRoute` 以 `{ multiHopImplemented: true }` 调用 —— 与 `forward-rollout-exec.ts`
的既有调用点同一位（V5.4 的计划/执行/补偿/准入四件已齐）。

### 4.6 第一阶段支持边界（§9.4.4）

| # | 形态 | 本 WP |
|---|---|---|
| 1 | 固定 ingress + ordered fixed transit[] + 固定 egress | ✅ 支持 |
| 2 | Ingress NodeGroup + failover / fencing | ✅ 支持（failover / fallback 解析即冻结） |
| 3 | Egress NodeGroup + fallback / round_robin / random / least_conn / ip_hash | ✅ 支持 |
| 4 | dynamic middle pool（transit 用 NodeGroup）/ 任意图 / 最短路 | ⛔ **关闭**，`unsupported_topology` fail-closed |

### 4.7 三个实现期定案（2026-10-05，与上面同等效力）

1. **不必为「跳」再存一份**：`resolved_hops` 就是快照自己的
   `ingress_node_id / egress_node_id / middle_node_id`（用 `buildRoutePlan` 可逐字还
   原成有序 hop 列表）。因此 `forward_revision` 只新增
   `route_profile_id / route_profile_version` 两列；**带申请语义**的 hop 列表落在
   `route_profile_application.resolved_hops`（apply 账本）。
2. **放置比较必须规范化**：DIRECT 的计划里 `egress == ingress`（同一台机器的两个面），
   而 `tunnel.egress_node_id` 列按定义是 NULL。比较「有没有变」时必须先把 DIRECT 的
   出口规约成 null（实现里由唯一的 `samePlacement` 承担），否则每次重编译都会被误判成
   「出口变了」。
3. **apply 有两种合法结果**：解析结果 ≠ 当前放置 ⇒ 产生新 revision（`runtime_changed: true`）；
   解析结果 == 当前放置 ⇒ 不产生新 revision（既有编辑路径判为 metadata-only），
   但**仍然落地「来源模板 + 版本」**并回报 `runtime_changed: false` ——
   第一次把某条 Forward「认领」到一个本来就选对的模板时，这件事必须查得到。

---

## 5. Impact Analysis 的口径（只读）

~~~text
scope = "referencing_forwards"
affected = tunnel.route_profile_id == 该 Route Profile 的 Forward
~~~

**为什么不是「所有可能被这个模板铺到的 Forward」**：模板是意图，某条 Forward 是否属于它
只能由一次显式 apply 建立（§9.4.5）。按「可能」猜一遍等于把意图当事实，运维会看到一份
他没同意过的受影响清单。所以第一次 apply 之前该列表为空 —— 那是正确答案，不是缺失。

impact 的每一次调用都必须**只读**：不触发下发、不写 revision、不写 rollout、不改指针。
用例里用「调用前后 `forward_revision` / `forward_rollout` 行数一致」钉住这一点。

---

## 6. Visibility / entitlement（冻结）

~~~text
INTERNAL   仅本 workspace 成员（管理面）可见可用
ASSIGNED   仅被显式授权的 Workspace / Plan 可选
PUBLIC     所有满足条件（enabled + capability）的用户可选
~~~

- 授权对象是 **Route Profile**，不是 Node / NodeGroup。用户侧 entitlement 指向
  Route Profile / capability，**不发展成「普通用户直接拿 Node 权限」**。
- `ASSIGNED` 的授权行：`route_profile_assignment(route_profile_id, target_type
  ∈ {workspace, plan}, target_id, active)`。`target_type` 用字符串列（可扩展），
  `target_id` 不加 FK（授权对象的删除不得改写已授权的事实）。
- 套餐/计费侧的接入**不在本 WP**：本 WP 只提供判定函数与授权行，不新建计费真相。
- 判定顺序：`enabled` → 可见性（INTERNAL/ASSIGNED/PUBLIC）→ capability。
  任何一步未知/缺失都 **拒绝**（fail-closed），不默认放行。

---

## 7. 与 Forward / RoutePlan / NodeGroup 的边界

| 问题 | 答案 |
|---|---|
| 谁拥有 Forward 生命周期？ | Forward（`tunnel` + rollout）。Route Profile 只提供意图 |
| 谁挑具体节点？ | `apply` 那一刻的编译器，结果立刻落 ForwardRevision 快照 |
| Agent 能自己挑吗？ | **不能**。下发永远是具体节点事实 |
| Route Profile 能改正在跑的 Forward 吗？ | **不能**，只能通过显式 apply 生成新 revision |
| NodeGroup 成员变化会自动改路由吗？ | 不会。NodeGroup 只是模板里的候选来源；已应用的快照不随之变化 |
| 三跳（middle hop）归谁？ | 仍归 RoutePlan / ForwardRevision 的 `middle_node_id`（V5.4），Route Profile 只提供模板 |
| 删除 NodeGroup / Node 呢？ | 影响的是**后续编译的候选**；历史快照保留（无 FK，历史事实优先） |

---

## 8. 错误码分层（§13）

每条错误都回答：失败在哪层 / 是否可重试 / 下一步动作。

| code | HTTP | error_layer | 重试 | 下一步 |
|---|---|---|---|---|
| `invalid_input` | 400 | `resource_scope` | 否 | 修正 payload（未知/畸形输入一律 fail-closed） |
| `unsupported_topology` | 422 | `capability` | 否 | 把 transit 改成 fixed node（dynamic middle pool 关闭） |
| `profile_not_found` | 404 | `resource_scope` | 否 | 刷新列表（跨 workspace 同样 404） |
| `forbidden` | 403 | `rbac` | 否 | 申请 workspace 角色 |
| `profile_not_visible` | 403 | `capability` | 否 | 申请 entitlement（ASSIGNED 授权） |
| `profile_disabled` | 409 | `capability` | 否 | 启用该 Profile |
| `version_conflict` | 409 | `resource_scope` | 是（刷新后） | 重新读取当前 version 再发布 |
| `profile_in_use` | 409 | `resource_scope` | 否 | 先解除 Forward 引用 |
| `no_eligible_node` | 409 | `runtime_admission` | 是 | 修节点健康 / 约束 |
| `capability_unavailable` | 409 | `capability` | 否 | 换节点组或降低能力要求 |
| `binding_missing` | 409 | `runtime_admission` | 否 | 由既有 rollout PREPARE 建立绑定 |
| `rollout_conflict` | 409 | `runtime_admission` | 是 | 等待在途 rollout 结束 |
| `db_unavailable` | 503 | `data_plane` | 是 | 稍后重试 |

**禁止**把上述任一情况压成 500（§13）。未知 visibility / 未知 selector kind / 未知
约束键 / 未知 strategy 全部走 `invalid_input` 400，不得静默降级为默认值。

---

## 9. 存储（additive）

~~~text
route_profile                身份 + 当前版本投影（visibility 字符串列）
route_profile_version        每个版本的不可变 body（唯一真相）
route_profile_assignment     ASSIGNED 的 workspace / plan 授权行
route_profile_application    apply 账本：tunnel/revision ← profile/version + resolved_hops
tunnel.route_profile_id      该 Forward 当前来源模板（可空，不加 FK）
tunnel.route_profile_version 该来源模板上次 apply 的版本
forward_revision.route_profile_id / _version
                             不可变快照里的 provenance（可空，不加 FK）
                             —— 具体跳就是本行的 ingress/egress/middle（见 §4.7 第 1 条）
~~~

迁移纪律（§3.4）：**只新增、只加可空列**，不改既有列、不加 DB enum、不删数据；
empty DB / existing V4 DB / legacy rows / 回滚（旧二进制忽略新列）/ 历史事实保留 全部成立。
复合索引**必须显式命名**：MySQL 标识符上限 64 字符，Prisma 默认名会超长（实测 P3018 / 1059）。

---

## 10. 非目标（本 WP 明确不做）

~~~text
Web 编辑页面（WP13.5A 完成后另派）
套餐/计费的 entitlement 落库与扣费
自动 rollout（发布即生效）
dynamic middle pool / 任意图 / 最短路
Route Profile 自己的 reconcile / 状态机 / 流量计数
Federation 的资源授权（WP14+，只复用本契约的 entitlement 方向）
~~~

---

## 11. 冻结声明（含实现期定案）

本文冻结后，下列问题不再需要重新讨论（改动它们等于改契约）：

1. Route Profile 是模板，RoutePlan 是已解析的执行路径；
2. 模板编辑不静默重写运行中的 Forward，传播必须显式 apply；
3. provenance 必须能从 ForwardRevision 回答「来自哪个 profile / version / 哪些节点」；
4. transit 第一版只允许 ordered fixed nodes，dynamic middle pool fail-closed；
5. visibility 三类，用户侧授权指向 Route Profile / capability，不指向 Node；
6. Route Profile 不拥有 runtime / lease / lifecycle / applied revision / 流量。

---

## 12. 实现与验证落点（本 WP 交付物）

| 交付 | 位置 |
|---|---|
| 契约（本文） | `docs/v5-wp13-5b-route-profile-contract.md` |
| 编译器（纯函数） | `backend/src/services/route-profile-compiler.ts` |
| 服务（CRUD / 版本 / impact / apply / visibility） | `backend/src/services/route-profile.ts` |
| HTTP 面 | `backend/src/routes/route-profiles.ts`（`/api/route-profiles`，workspace 域 RBAC） |
| 离线契约测试（selector / 反例 / visibility / 与 buildRoutePlan 一致性） | `backend/src/services/__tests__/route-profile.test.ts`（`bun test src`） |
| HTTP / DB 契约测试（RBAC、跨 workspace、impact 只读、apply provenance、发布不重写、消费可见性） | `backend/tests/route-profile.test.mjs`（`node --test`，需 `TUNEX_DB_TEST=1`） |
| 迁移 | `backend/prisma/migrations/20261021000000_v5_wp13_5b_route_profile/` |

**测试为什么要分两处**：`bun test src` 里多个文件用 `mock.module` 替换共享模块
（db / auth / scheduler…），同一进程内会互相污染；DB/HTTP 用例按仓库既有口径放在
`backend/tests/*.mjs`，由 `node --test` 每文件独立进程执行（这也是 CI `bun run test`
的覆盖面）。

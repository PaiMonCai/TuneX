# V4-WP5 Node Lifecycle Foundation — 开发报告

**Work Package**: V4-WP5（`DEVELOPMENT.md` §13.4 / §13.6 / §13.7）
**分支**: `feature/v4-wp5-node-lifecycle`
**Worktree**: `/opt/TuneX-v4-wp5`
**Baseline**: `origin/main` = `9a489b5`
**范围声明**: 只做 Node lifecycle schema/API、impact check、maintenance/disabled/retiring/delete contract 与测试。
**不做**: WP6 telemetry Agent 扩展（不碰 `agent/`）、WP7 web UI（不碰 `web/`）、部署配置、生产 DB/容器、WP1 的 Forward revision 文件。

---

## 1. 现状盘点（main = 9a489b5 的既有事实）

### 1.1 `Node` 模型的三个状态混淆点

`backend/prisma/schema.prisma` `model Node`（L377-454）：

| 列 | 语义 | 现状 |
|---|---|---|
| `status Status @default(active)` | legacy 连接态（active/inactive） | 被 `socket/offline-detector.ts` 翻转：60s 防抖后 `node.status = inactive`。也**同时**被 `routes/admin-extended.ts` 的 PATCH /nodes/:id 当普通业务字段写 |
| `role NodeRole?` | ingress/egress/both | 可空，v3 不回填（§7.1「不改不猜」） |
| `node_credential_hash` / `credential_revoked` | 机器身份 | fail-closed 认证 |

**V4 冲突点（§13.4.1 明文禁止）**：`Node.status` 当前**一个列同时承担连接态与管理期望态**。WP5 必须新增独立的 `lifecycle` 列，`status` 保持原义（连接态推导输入之一），绝不复用。

### 1.2 现有节点写入口（WP5 只可新增、不可重写）

| 入口 | 文件 | 是否可改 |
|---|---|---|
| `PATCH /api/admin/node/:id/role` | `routes/node-admin.ts` L117 | 只增量（加 lifecycle 校验），不改既有 field 语义 |
| `POST/PATCH/DELETE /api/nodes/:ingressId/*` | `routes/nodes.ts` | WP5 负责 nodes route 的增量改动 |
| `POST /api/node-groups/:id/nodes` | `routes/node-groups.ts` L149 | 不改（WP1 之外），但读它建的节点 |
| `POST /api/admin/nodes`、`PATCH /api/admin/nodes/:id`、`DELETE /api/admin/nodes/:id` | `routes/admin-extended.ts` | admin-extended 有 `node_id` 改名能力——**与 §13.4.3「修改 node_id 显示名」同一功能，但无 lifecycle 门禁** |

### 1.3 三层状态的既有事实源（V4 引用，不新建）

| 层 | 状态 | 事实源 | 现有推导代码 |
|---|---|---|---|
| Connection | waiting / online / offline | Agent 上报 + credential | `routes/nodes.ts` `nodeView()` L114-121：`status==="active" && lastSeen≤90s && hasCredential && !revoked` |
| Lifecycle | active/maintenance/disabled/retiring | **无**（本次新增） | — |
| Health | healthy/warning/error/unknown | `node_state_report` + desired/applied | `services/reconciler.ts` 已有 revision_behind / missing_runtime / node_unreachable / error_state 判定；WP6 才做合成 |

**关键结论**：Connection 已有可信推导（`nodeView`），WP5 **只复用不改写**；Health 的原料（reconciler drift）已存在，WP5 只做只读投影，完整的 health 合成留给 WP6。

---

## 2. 状态契约（WP5 冻结，WP6/WP7 依赖）

### 2.1 新 schema 字段

```
model Node {
  lifecycle NodeLifecycle @default(active)   // 用户期望管理态
  lifecycle_updated_at DateTime?
  lifecycle_note String? @db.VarChar(255)    // 进入 maintenance/retiring 的原因
  ...
}

enum NodeLifecycle {
  active
  maintenance
  disabled
  retiring
}
```

**为什么新增列而不是复用 `status`**（§13.4.1 硬约束）：`status` 是连接态推导输入（offline-detector 翻转它），lifecycle 是用户期望态。两者混在一列会让「维护中的节点掉线」既可以是连接事实也可以是管理动作，无法区分。

**为什么不复用 `Status` 枚举**：`Status` 只有 active/inactive 两值。扩展它会同时影响 User/Tunnel/EgressPool/NodeGroupGrant，超范围。

### 2.2 三层状态投影（API 响应契约）

`GET /api/nodes` 的每条 node 增加：

```jsonc
{
  // ...既有字段不变...
  "lifecycle": "active",              // 新列，V4 唯一真相
  "lifecycle_updated_at": "...",
  "connection": "online",             // waiting | online | offline（既有 nodeView 推导，WP5 显式命名）
  "accepts_new_business": true        // lifecycle ∈ {active} 且 connection != waiting
}
```

- `connection`：**不改推导逻辑**，只把既有 `online` 布尔显式化为三态（有 credential=false → waiting；有 credential 且 online → online；否则 offline）。
- `accepts_new_business`：WP5 新增的**单一准入谓词**，是 §13.4.2 的代码落点。WP1/WP8 的 Forward 创建必须调它，不得各自判 lifecycle。

### 2.3 Lifecycle 行为矩阵（状态机）

```
                    ┌──────────────┐
        ┌──────────►│   active     │◄─────────┐
        │           └───┬───▲──────┘          │
        │   maintenance │   │ resume          │
        │           ┌───▼───┴──────┐          │
        │           │  maintenance │          │
        │           └───┬───▲──────┘          │
        │      disable  │   │ enable          │
        │           ┌───▼───┴──────┐          │
        └───────────│   disabled   │──────────┘
          retire    └───┬───▲──────┘
                    ┌───▼───┴──────┐
                    │   retiring   │  → delete（仅当依赖为空）
                    └──────────────┘
```

合法迁移（服务层显式白名单 `LIFECYCLE_TRANSITIONS`）：

| from → to | 附加条件 |
|---|---|
| active → maintenance | 无 |
| maintenance → active | 无（退出后 Reconciler 只应用最新 desired revision，WP3/WP8 负责） |
| active → disabled | 无 |
| disabled → active | 无 |
| maintenance → disabled | 允许（不要求先退出维护） |
| disabled → maintenance | **拒绝**：disabled 语义是「不再接受新业务」，进入维护没有意义 |
| active → retiring | 无 |
| disabled → retiring | 允许（disable 后退役是正常路径） |
| maintenance → retiring | 允许 |
| retiring → 任意 | **拒绝**：retiring 是单向门。要回退只能先删除或（未来 WP7）提供显式 cancel——本期不做 cancel，契约上留空 |

`retiring → *` 拒绝的理由：删除操作是 retiring 的唯一出口，允许回退会让「依赖已锁定」的承诺失效。WP7 UI 因此**不得**提供「取消退役」按钮（契约冻结）。

### 2.4 准入谓词（`accepts_new_business` 的判定）

| lifecycle | 新 Forward / 新 Binding / 迁移目标 | 最大 desired revision 应用 |
|---|---|---|
| active | ✅ | ✅ |
| maintenance | ❌（`code: "node_in_maintenance"`，409） | 延后：保存可，Reconciler 不应用 |
| disabled | ❌（`code: "node_disabled"`，409） | ❌ |
| retiring | ❌（`code: "node_retiring"`，409） | ❌ |

`maintenance` 的「保存可、等待应用」：§13.4.2 明文「新的 desired revision 可以保存并等待」。因此 createForward 遇到 maintenance 节点返回 409 拒绝**创建**（本期 contract），但**存量** Forward 的 revision 仍可写入 DB（routes/forwards.ts 的 PATCH 路径），由 WP3/WP8 的 rollout orchestrator 决定何时下发。WP5 只提供谓词，不实现 orchestrator 的延后重试队列。

---

## 3. Impact check 契约

### 3.1 `POST /api/nodes/:id/lifecycle` 的 impact payload

每个 lifecycle 变更请求响应里带 `impact`，让 UI **在提交前**就能展示后果：

```jsonc
{
  "data": {
    "node": { "...": "...", "lifecycle": "maintenance" },
    "impact": {
      "ingress_forward_count": 3,     // 作为 ingress 承载的 Forward 数
      "egress_forward_count": 1,      // 作为 egress 承载
      "binding_count": 2,             // 涉及该节点的 NodeBinding 数
      "active_port_lease_count": 4,   // 未释放的 NodePortLease
      "egress_pool_count": 1,
      "blockers": []                  // 阻止这次变更的具体原因（见 3.3）
    }
  }
}
```

`GET /api/nodes/:id/impact` 单独提供同一份 impact（不变更状态，供 UI 预演）。

### 3.2 Role / port range 变更的 impact check（§13.4.3 硬要求）

`PATCH /api/admin/node/:id/role` 增加守卫（现有 `updateNodeRole` 已有一半）：

| 变更 | 阻断条件 | 错误码 |
|---|---|---|
| BOTH/both → ingress | 仍有 Forward 以它为 egress | `node_still_used_as_egress` |
| BOTH/both → egress | 仍有 Forward 以它为 ingress | `node_still_used_as_ingress` |
| ingress → BOTH/both | 无（获得能力，无害） | — |
| 收缩 port range | `active_port_lease_count` 落在新区间外且对应 Forward 未删 | `port_range_would_orphan_leases` |

现有 `updateNodeRole` 的守卫 1（丢出口能力前清池）保留；WP5 加 Forward 维度。

### 3.3 Delete contract（§13.4.3「Node 删除永远不隐式级联删除 Forward」）

`DELETE /api/nodes/:id` 前提（全部满足才允许，任一不满足 409 + `blockers`）：

1. `lifecycle === "retiring"`（必须先显式退役）
2. `ingress_forward_count === 0`
3. `egress_forward_count === 0`
4. `binding_count === 0`（以该节点为 ingress 或 egress 的 NodeBinding）
5. `active_port_lease_count === 0`
6. `egress_pool_count === 0`

响应：`{ "data": { "deleted": true, "id": N } }`。

**显式不做**：级联删 Forward、自动解绑、自动释放租约、删 NodeGroup。这些全部要求用户先在 UI 里显式处理（§13.4.2 disabled 条）。

### 3.4 Credential 入口

`agent_id` 永久不可编辑；重新安装 = 复用 `createNodeEnrollment`（既有 `POST /api/nodes/:id/enrollment`）。WP5 **不新增** credential 端点（已有 issue/rotate/revoke 在 `/api/admin/node/:id/credential*`），只在 `nodeView` 里把 credential 状态投影为 `credential_state: "never"|"active"|"revoked"`（与 node-admin 的 `credentialStateOf` 同口径，不泄漏哈希）。

---

## 4. API 端点清单（全部新增，不改既有 URL 语义）

| 方法 | 路径 | 状态码 | 说明 |
|---|---|---|---|
| GET | `/api/nodes` | 200 | 响应体增加 `lifecycle` / `connection` / `accepts_new_business` / `credential_state`（既有字段全部保留） |
| GET | `/api/nodes/:id/impact` | 200/404 | 依赖影响预演（不改状态） |
| POST | `/api/nodes/:id/lifecycle` | 200/400/404/409 | 变更 lifecycle，body `{ lifecycle, note? }`，响应带 impact |
| GET | `/api/admin/node/:id/lifecycle` | 200/404 | 管理端读取（含 transitions 可用集） |
| DELETE | `/api/nodes/:id` | 200/404/409 | 物理删除（gates 见 3.3） |

**为什么放 `/api/nodes/:id` 而不是 `/api/admin/node/:id`**：lifecycle 是**用户侧**资源操作（§13.4「用户/管理员的期望管理状态」），与 enrollment/binding 同级。admin 侧的读端点只用于面板巡检，写仍以用户侧为准——与 WP10「角色改在 admin、凭据在 admin、生命周期在用户侧」的分工一致。

**RBAC**：`/api/nodes/*` 走既有 `resolveWorkspaceAccess`，`resource: "node"`，action = read（GET）/ update（POST lifecycle、DELETE）。不新增权限键（WP5 不做权限模型，那是 WP10）。删除走 `delete` action。

**限流**：lifecycle 变更/删除是敏感写，新增一条规则插在 `api-global` 之前（用户维度，60s/10 次）：

```ts
{ name: "node-lifecycle", windowSeconds: 60, max: 10, methods: ["POST", "DELETE"],
  match: (p, m) => (isPost(m) || isDel(m)) && /^\/api\/nodes\/[^/]+\/(lifecycle)?$/.test(p),
  scope: "user" }
```

### 4.1 错误码表（WP5 全新增，按 §13.5「可区分的错误码」）

| code | HTTP | 含义 | UI 下一步 |
|---|---|---|---|
| `invalid_transition` | 409 | 非法 lifecycle 迁移 | 展示合法迁移集 |
| `node_in_maintenance` | 409 | 维护中不接受新业务 | 提示退出维护或等待 |
| `node_disabled` | 409 | 已停用不接受新业务 | 提示重新启用 |
| `node_retiring` | 409 | 退役中不接受新业务 | 提示先处理依赖或取消退役流程 |
| `node_not_retiring` | 409 | 删除前必须先退役 | 提供「进入退役」入口 |
| `node_still_used_as_ingress` | 409 | 仍承载 ingress Forward | 列出 Forward 让用户迁移 |
| `node_still_used_as_egress` | 409 | 仍承载 egress Forward | 同上 |
| `port_range_would_orphan_leases` | 409 | 收缩端口区间会使租约悬空 | 提示先删除占用该端口的 Forward |

---

## 5. 迁移策略

### 5.1 本包新增 migration

`backend/prisma/migrations/20260927000000_v4_node_lifecycle/migration.sql`

- `ALTER TABLE node ADD COLUMN lifecycle ENUM('active','maintenance','disabled','retiring') NOT NULL DEFAULT 'active'`;
- `ADD COLUMN lifecycle_updated_at DATETIME(3) NULL`;
- `ADD COLUMN lifecycle_note VARCHAR(255) NULL`;
- `CREATE INDEX node_lifecycle_idx ON node(lifecycle)`。

**默认值 `active` 的理由**（与 schema 默认字段一致但需说明）：存量节点的业务语义就是「正常承载」（它们今天确实在跑 Forward）。这不是「猜」，是把现状写成默认值。列注释里写清。

### 5.2 与 WP1 并行 schema 冲突的合并策略（先写死，合并时照做）

WP1（`feature/v4-wp1-forward-revisions`，worktree `/opt/TuneX-v4-wp1`）会改 `schema.prisma` 的 `Tunnel` 与可能新增迁移。WP5 只碰 `Node` + 新 enum。

**合并规则（WP5 → main 时执行）**：

1. `schema.prisma`：先 rebase 到最新 main（届时含 WP1），再**手工增量**加 WP5 的 `Node` 字段与 `NodeLifecycle` enum。不得用 `--ours`/`--theirs` 整文件选边——两边都在 `model Node` / 文件尾部加内容，选边必丢一套。
2. **migration 目录不重名**：WP5 用 `20260927000000_v4_node_lifecycle`。若 WP1 用了同一时间戳前缀，WP5 改为推迟一档（如 `20260927010000_v4_node_lifecycle`）并保留自身 SQL 不变。
3. 两边 migration 的 `migration_lock.toml` 不冲突（同一 provider 行，内容相同）。
4. `Node` model 内：WP1 若也加字段，冲突块按「双方都保留」合（两套字段正交，见 skill 的合并策略）。

---

## 6. 测试计划

### 6.1 新增离线单测（`bun test`，不连 DB/Redis）

`backend/src/services/__tests__/node-lifecycle.test.ts`：

| 组 | 断言要点 |
|---|---|
| 迁移矩阵 | 9 种合法 + 3 种非法（disabled→maintenance、retiring→*）× 每格的 code |
| accepts_new_business | 4 lifecycle × connection 三态的组合真值表 |
| 影响统计 | ingress/egress forward、binding、lease、pool 五类计数的 where 语义 |
| delete gates | 6 道 gate 逐条缺失时的 code；lifecycle != retiring 时 `node_not_retiring` |
| role impact | BOTH→ingress 有 egress forward → 拒；无则过 |
| port range impact | 收缩区间包含 active lease → 拒 |
| 纯函数无 IO | 模块顶层不 import db/redis |

`backend/src/routes/__tests__/node-lifecycle-routes.test.ts`：

| 组 | 断言要点 |
|---|---|
| 响应形状 | `/api/nodes` 的每个 node 含 lifecycle/connection/accepts_new_business |
| 错误码透传 | service 错误 → HTTP 状态 + code 字段 |
| 凭据纪律 | 响应 JSON 不含 `node_credential_hash`、不含 43 位 base64url |
| 边界 | 非法 id → 400；不存在 → 404 |
| RBAC 前缀 | `resolveAdminRoute` 对 admin 读路径解析到 `nodes` 资源 |
| 限流 | `selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/nodes/1/lifecycle", "POST")?.name === "node-lifecycle"`，且 DELETE 同规则；反锚定多段不命中 |
| 无下发能力 | 服务与路由源码不 import socket/control-protocol/portPool（沿用 WP10 的静态断言模式） |

### 6.2 CI 集成

`test:unit` = `bun test src/services/__tests__/ src/__tests__/`。

新测试放 `src/services/__tests__/` 会被自动纳入；路由测试放 `src/routes/__tests__/`（新目录）**不会**被 `test:unit` 的 glob 覆盖 → 需在 `backend/package.json` 的 `test:unit` 加 `src/routes/__tests__/`。

**冲突预案**：WP1 也可能改 `test:unit` 脚本。合并时保留双方路径（skill：ci.yml 同款冲突解法——合并而非选边）。

不新增 DB 集成测试（`tests/*.test.mjs` 需要 MySQL；§5 迁移由 CI 的 `prisma migrate deploy` 覆盖）。

---

## 7. 风险与已采取的规避

| # | 风险 | 规避 |
|---|---|---|
| R1 | `Node.status` 与 lifecycle 两列并存期，`admin-extended.ts` 的 PATCH 仍写 `status` 且不带 lifecycle 门禁 | 本期只加新列与读投影；不动 admin-extended。已知限制记入 PR 描述 |
| R2 | `nodeView` 的 online 推导（90s 窗口）与 offline-detector 的 `status` 翻转口径不同 | 不改推导。`connection` 只做命名化，两者差异由 WP6 health 合成统一 |
| R3 | WP1 并行改 `schema.prisma` | §5.2 的合并策略先冻结；migration 时间戳不重名 |
| R4 | memory 小（3.9G，4 核），本地跑不动 tsc/build | 本地只跑 `bun test <单文件>`；typecheck/build/test 全量交 CI |
| R5 | rate-limit 规则顺序错误导致 lifecycle 写操作被 api-global 按 600/min 放行 | 新规则插在 `api-global` 之前；测试反锚定 |
| R6 | `retiring` 无 cancel 出口，用户误点后无法回头 | 契约显式拒绝 `retiring → *`，并在 PR/UI 契约里写明「退役前需清空依赖」；WP7 不得提供取消按钮 |

---

## 8. 分期实施顺序

| Step | 内容 | 边界 |
|---|---|---|
| S1 | `schema.prisma` + migration + `NodeLifecycle` 导出常量 | 只动 schema 与 migration 目录 |
| S2 | `services/node-lifecycle.ts`（迁移矩阵、impact、delete gates、准入谓词）+ 单测 | 新文件 + 新测试，不 import db 以外副作用 |
| S3 | `routes/nodes.ts` 增量（lifecycle/connection/accepts_new_business 投影 + 5 个端点）+ 路由单测 + rate-limit 规则 + package.json test:unit | 只改 nodes.ts / rate-limit.ts / package.json |
| S4 | admin 读端点 + rebuild main 后全量验证 + push + PR | 只改 `routes/node-admin.ts` 增量 |

每步一个 commit，功能边界内闭合（不出现「改了 schema 但没测试」或「测试引用不存在的导出」的中间态）。

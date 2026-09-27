# V4-WP5 Node Lifecycle Foundation — 开发报告（基于最新 main 重审刷新）

**Work Package**: V4-WP5（`DEVELOPMENT.md` §13.4 / §13.6 / §13.7）
**分支**: `feature/v4-wp5-node-lifecycle`
**Worktree**: `/opt/TuneX-v4-wp5`
**Baseline（审查对象）**: `origin/main` = `da4ba86`（V4.1 收口）
**历史实现（审查对象，不盲 merge）**: `1f60965` = 旧 WP5 分支 tip（含 `2eb5534` schema / `af8541a` service / `389dcf7` routes），其 parent 链基于 `af5c22f`..`619be00`（WP1 合并前的 main）

范围声明：只做 Node lifecycle schema/API、impact check、maintenance/disabled/retiring/delete contract 与测试。
**不做**：WP6 telemetry（不碰 `agent/`）、WP7 web UI（不碰 `web/`）、部署配置、生产 DB/容器、WP1 的 Forward revision 文件。

---

## 1. 审查结论：历史实现 vs 最新 main

### 1.1 历史分支未合并的内容与最新 main 的冲突面

| 历史 commit | 内容 | 与 `da4ba86` 的关系 |
|---|---|---|
| `2eb5534` | `enum NodeLifecycle` + `Node.lifecycle/lifecycle_updated_at/lifecycle_note` + migration `20260927000000_v4_node_lifecycle` | **migration 目录时间戳与 main 已有 `20260927090000_v4_wp1_forward_revisions` 不冲突**，但 SQL 全文可直接复用；schema 的 `model Node` 增量块需要手工重放（main 的 Node 已含 v3 全部字段，无同名新列） |
| `af8541a` | `services/node-lifecycle.ts`（776 行，776 行的迁移白名单 / admission / deleteGates / checkRoleChange / lifecycleView） | 纯新文件；其 `db` 注入面（`LifecycleDb`：node/tunnel/nodeBinding/nodePortLease/egressPool）与 main 的 schema 完全对齐；`NODE_SELECT` 的字段在 main 的 `Node` 上都存在 |
| `389dcf7` | `routes/node-lifecycle.ts` + `backend/package.json` 的 `test:unit` 改为 `bun test src` + `src/__tests__/lifecycle-db-stub.ts` + 路由测试 | `package.json` 改动在 main 已由 WP1 落地过同样变更（见 1.2）；共享替身是 WP1/WP10 之外**新增**的进程级 db mock |

### 1.2 与最新 main 的差异（决定「不盲 merge」的具体点）

1. **main 已前进两个里程碑**（V4.1：WP1 revision / WP2 hot reload / WP3 rollout / WP4 UX + Gate F1）。历史分支的基线停在 WP1 合并前，直接 merge 会把 V4.1 的四个 WP 全部卷进冲突。
2. **`forward-rollout.ts` 已内置 lifecycle 等价口径**（`ROLLOUT_ADMITTED_LIFECYCLES` / `lifecycleBlocksForward` / `ROLLOUT_LIFECYCLE_BLOCKING_CODES`，L245-269）。这是 WP3 在「本分支没有 WP5 lifecycle 列」的前提下写的**本地常量镜像**，注释明确要求「WP5 并入后改为 import `NODE_LIFECYCLES` / `nodeAdmission`，语义零漂移是评审要对着两处代码确认的」。→ **本期必须兑现这个 import**，否则同一判定存在两处实现（正是 §13.4.2 要消除的漂移形态）。
3. **`forward-rollout-exec.ts` L462 同样留了 R7 本地口径注释**（`lifecycle: (rec.lifecycle as ...) ?? undefined`）。它依赖 `include: { ingress_node: true, egress_node: true }` 整行返回，`lifecycle` 列在 schema 落地后**自动出现在 include 结果里**，因此该行无需改写即可拿到真值——但要在测试里钉住「exec 会把节点的 maintenance 传成阻断码」。
4. **`test:unit` 已是 `bun test src/services/__tests__/ src/__tests__/`**。历史分支把它改成 `bun test src`（为了覆盖它自己新建的 `src/routes/__tests__/`）。skill 记录了 WP1 由此踩过的坑：`src/**/__tests__/` 未加引号时 `**` 在 sh 下退化成单层 `*`。**本期沿用 `bun test src`**（Bun 自己递归匹配，无 shell glob 依赖；本机实测 27 files / 755 pass）。
5. **`nodeView()`（routes/nodes.ts L97-131）已有 90s 在线窗口推导**，历史 service 的 `deriveConnection` 就是对它的命名化。main 的该函数未变，可直接复用口径。

### 1.3 结论

历史实现的**服务层契约设计**（迁移白名单、准入谓词三态、六道删除闸门、role/port-range 影响检查、哈希绝不外泄）与 §13.4 逐条对齐，质量可复用；**交付形态需按最新 main 调整**：

- schema/migration 的 SQL 与注释可原样搬（expand-and-contract、注释论证完整）；
- 服务层按 `da4ba86` 的现有依赖风格重放（仍是纯函数 + `LifecycleDeps` 注入，不 import socket/control-protocol/portPool）；
- 路由沿用**已存在的 admin 挂载点** `/api/admin/node/:id/...`（`permissions.ts` 的 `nodes` 资源 `apiPrefixes: ["/admin/node", "/admin/nodes"]` 天然覆盖，不新增权限键——与 WP10 node-admin.ts 同一决策）；
- **新增历史分支没做的接线**：把 `forward-rollout.ts` / `forward-rollout-exec.ts` 的本地镜像改成 import WP5 单一实现（§13.4.2「唯一代码落点」）；
- 共享 db 替身（`src/__tests__/lifecycle-db-stub.ts`）按 main 现状重建：main 的 `services/__tests__/node-admin.test.ts` 用**函数级注入**、无 `mock.module`，因此替身只需服务路由单测自用，且必须与 node-admin 的替身**互不注册对方的模块**（避免 skill 记录的 mock.module 进程级踩踏）。

---

## 2. 本报告相对历史报告的偏差（先写死，实现照此交付）

| 项 | 历史报告/交付 | 本期交付 | 理由 |
|---|---|---|---|
| 端点前缀 | admin `/api/admin/node/:id/lifecycle|impact` | 同左（保留） | main 已有 `/api/admin/node/:id/role|detail|state`，同前缀天然落 `nodes` 资源；WP10 已确立该先例 |
| 用户侧投影 | 历史**未**改 `routes/nodes.ts` | 本期**做**：`GET /api/nodes` 增加 `lifecycle`/`connection`/`accepts_new_business`/`lifecycle_note`/`lifecycle_updated_at` | §13.4.3「用户侧必须补齐 Node 生命周期操作」的前置；`nodeView` 是唯一投影点，增量纯加法 |
| rollout 镜像 | 历史分支基线无此代码 | **接线**：`forward-rollout.ts` 改 import `nodeAdmission`/`businessRejectionCode`；exec 的 `lifecycle:` 行保留（现在会拿到真值）并补测试 | 消除 §13.4.2 的双实现漂移；历史报告的 R7 在此兑现 |
| rate-limit 规则 | 历史决定不加（§6.3） | 加一条 `node-lifecycle`（60s/10 次，PATCH+DELETE，插在 `api-global` **之前**）+ 反锚定测试 | main 的 `api-global` 是 600/min user 维度，lifecycle 写是管理态变更（可把整节点停用），历史报告 R5 的担忧成立；skill 明确「规则必须排在 api-global 之前，否则静默失效」 |
| 共享 db 替身 | 历史用 `mock.module` 进程级共享 | 仅路由层测试用 `mock.module`；服务层沿用 **函数级注入**（node-admin.test.ts 同款） | main 的既有纪律；`mock.module` 只在一处注册，避免多文件互相 clobber |
| health 投影 | 无 | 无（WP6） | §13.4.4 明文 Health 由 WP6 合成 |

---

## 3. 实现切片（每片一个 commit，按依赖顺序）

| # | commit | 内容 | 边界 |
|---|---|---|---|
| S1 | `feat(v4-wp5): node lifecycle schema + enum (expand-and-contract)` | `schema.prisma` 增量 + migration `20260927150000_v4_node_lifecycle`（新时间戳，避开 main 已有目录）+ migration 测试 | 只动 `backend/prisma/` |
| S2 | `feat(v4-wp5): lifecycle state machine + impact check + delete gates` | `services/node-lifecycle.ts` + `services/__tests__/node-lifecycle.test.ts` | 新文件；不 import db 以外副作用 |
| S3 | `feat(v4-wp5): admin lifecycle routes + nodes projection + rate-limit rule` | `routes/node-lifecycle.ts` + `routes/nodes.ts` 增量 + `app.ts` 挂载 + `middlewares/rate-limit.ts` 规则 + 路由测试 | HTTP 面 + 一条限流规则 |
| S4 | `feat(v4-wp5): rollout admission consumes the single lifecycle predicate` | `forward-rollout.ts` 改 import + `forward-rollout-exec.ts` 注释/测试 + 现有测试对齐 | 消除双实现 |
| S5 | `test(v4-wp5): migration/contract 验证 + CI 接线核对` | `tests/node-lifecycle-migration.test.mjs`（expand-and-contract + 存量行零改动 + 列可空性）+ 核对 `test:unit` 覆盖 | 只加测试 |

回滚策略：expand-and-contract，代码回滚即整体回滚，**不需要 DB downgrade**。

---

## 4. 测试计划与 CI 接线核对

- 离线单测（`bun test`，不连 MySQL/Redis）：迁移矩阵真值表、准入三态真值表、删除闸门逐条、role/port-range impact、哈希绝不外泄、路由错误码透传、`selectRule` 反锚定、源码不 import 下发层。
- DB 迁移测试：`tests/node-lifecycle-migration.test.mjs`（`TUNEX_DB_TEST=1` 门控），断言存量 `node` 行零改动、`lifecycle` 默认 `active`、新列可空、第二次 `migrate deploy` no-op、无 DROP/MODIFY。
- **CI 覆盖核对（交付后必须做）**：用 `gh run view <id> --log` 确认每个新测试文件以 `##[group]<相对路径>:` 出现在 CI 日志里——`test:unit` 是显式路径，新目录不自动进 CI（skill：V4-WP1 的 7 条断言曾因此一次都没跑）。

---

## 5. 风险与规避

| # | 风险 | 规避 |
|---|---|---|
| R1 | `admin-extended.ts` 的 PATCH 写 `status` 不带 lifecycle 门禁 | 本期不动 admin-extended；已知限制记录在案（与历史报告一致） |
| R2 | `mock.module` 进程级踩踏 | 替身只在路由单测注册一次；服务层走函数注入 |
| R3 | 与并行 WP（WP6/WP7）改 `routes/nodes.ts` | `nodeView` 增量是纯加法；WP7 只读新字段 |
| R4 | rate-limit 规则顺序 | 规则插在 `api-global` 前 + `selectRule` 反锚定测试钉死顺序 |
| R5 | 本地内存小，跑不了 tsc/build | 本地只跑 `bun test`；typecheck/DB 测试交 CI |
| R6 | retiring 无 cancel 出口 | 契约显式拒绝 `retiring → *`；WP7 不得提供取消按钮 |

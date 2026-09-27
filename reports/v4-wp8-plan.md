# V4-WP8 Monitoring & Actionable Diagnostics — 开发报告

**Work Package**: V4-WP8（`DEVELOPMENT.md` §13.6 依赖矩阵 / §13.7 Wave 4 / §13.8 Gate V4-F3）
**分支**: `feature/v4-wp8-monitoring`
**Worktree**: `/opt/TuneX-v4-wp8`
**基线**: `origin/main` = `5881b3f0fc80e14fdf1e88e688471b1d833b5703`（WP7 merge，前置 WP4 / WP7 已在 main）
**Track**: C/D（Backend 读投影 + Web 产品面）

范围（§13.6 WP8 主要 DoD + §13.7 Wave 4 硬性条目）：

- Dashboard 优先显示**异常 / 离线 / 等待安装**入口与快捷操作；
- **普通用户状态语义**：用户侧 Node 三层状态（Connection / Lifecycle / Admission）可用，不再只有 `online` 布尔；
- **错误 → 下一步动作**：Forward 失败必须给出可执行动作，而不是只回显原文；
- **默认隐藏 raw revision / desired internals**：普通页面不默认暴露 `config_revision` / `applied_revision` / `desired_status`；
- Forward 普通页面的**产品状态**语义（不再直接画 `apply_status` 原始枚举值）；
- 409 `condition` 被消费（前端按码给下一步，不落回笼统「保存失败」）；
- 必要轮询与文案、契约测试。

**不做**（边界）：不改 Prisma schema / 不新增 migration、不碰 `agent/`、不做 WP9 的分页筛选（已在 main）、不做 WP10 权限矩阵、不部署生产、不本地 build/typecheck（交 CI）。

**硬约束**：前端**只翻译不判定** —— 三层状态一律消费后端 `deriveConnection` / `nodeAdmission`（`services/node-lifecycle.ts`）与 WP6 `reasonAction`、WP7 `CONDITION_ACTION`，不在前端复刻第二套判据（§13.4.1「不允许一句 health=healthy 成为最终真相」）。

---

## 1. 调研结论（对分析代理发现的独立核对）

| # | 分析代理发现 | 核对结果 | 证据（main `5881b3f`） |
|---|---|---|---|
| F1 | Dashboard 只聚合计数 | ✅ 成立 | `web/src/components/dashboard/dashboard-body.tsx` 仅 4 张 StatCard + 流量图 + 前 5 条 Forward 表；`backend/src/routes/dashboard.ts` 的 `/stats` 只回 `active_nodes/total_nodes` 等计数；**没有任何异常入口**（离线/等待安装/维护中/失败 Forward 都不可见） |
| F2 | 用户 `/api/nodes` 未透 lifecycle/connection/admission，且**自带第二套在线判定** | ✅ 成立且比描述更严重 | `backend/src/routes/nodes.ts` 的 `nodeView()` 在路由层**重写**了 `status==="active" && last_seen<=90s && has_credential && !revoked` 的在线判据；`nodeSelect` 不含 `lifecycle`；返回体只有 `online/has_credential/registered`。`services/node-lifecycle.ts` 的 `deriveConnection` 注释自称「复用 routes/nodes.ts nodeView 的口径」—— 实际是**两份实现，靠人工保持一致** |
| F3 | Forward 页直接显示 raw `apply_status` | ✅ 成立 | `forward-workspace.tsx:1215`、`forward-detail.tsx:178/261` 把 `apply_status` 原样画进 Badge（`active`/`error`/`pending`…）；`dashboard-body.tsx:185` 同样 |
| F4 | 详情暴露 revision | ✅ 成立 | `forward-detail.tsx` 的「运行态」卡默认展示 `config_revision`/`latest_revision`、`applied_revision`、`last_applied_at`、`desired_status`（264–274 行） |
| F5 | 错误只显示原文，409 condition 未消费 | ✅ 成立（读路径有兜底、写路径没有） | `forward-detail.tsx:283` 只回显 `apply_error_code: apply_error` 字符串；`forward-workspace.tsx` 的 create/patch 失败只 `toast.error(err.message)`。**唯一的 exception** 是 `forward-edit-dialog.tsx` 的 409 `revision_conflict` 分支（消费 `data.latest_revision`）—— 但 `nodeAdmission` 系列的 409（`data.condition = node_in_maintenance / node_waiting_install / …`，见 `forward-service.ts:140`）**完全没有被消费** |
| F6 | web CI 只测三个目录 | ✅ 成立 | `.github/workflows/ci.yml` web job：`bun test src/components/dashboard/__tests__/ src/components/admin/__tests__/ src/components/forwards/__tests__/`。放 `src/components/nodes/__tests__/` 的新测试**一次都不会跑** |
| F7 | 前端必须复用后端判定 | ✅ 采纳为设计约束 | `web/src/lib/node-lifecycle.ts` / `node-health.ts` 已明确「前端绝不重新实现 canTransition / nodeAdmission」；WP7 已建 `conditionAction`（`node-lifecycle-i18n.ts:304`）与 WP6 的 `reasonAction`（`node-health-i18n.ts:370`） |

**额外发现（本次核对新增，纳入交付）**

| # | 发现 | 影响 |
|---|---|---|
| N1 | `routes/nodes.ts` 的 `nodeView` 与 `services/node-lifecycle.ts` 的 `deriveConnection` 是**同一判据的两份实现**（F2） | 两处任一处改窗口/凭据规则就会分叉。WP8 的「用户三层状态」是修掉它的天然时机：改为**只调用** `deriveConnection` |
| N2 | 后端 `send()`（`routes/forwards.ts:72`）错误体是 `{ error, code, apply_error_code, data }`，**没有顶层 `message`**；而 web `finalize()`（`lib/api.ts:280`）只读 `message`，取不到就回落 `Request failed with status 409` | 真实后端下 Forward 写操作的**人读原因会丢**，只剩状态码。mock 的 `fail()` 恰好带 `message`，所以 mock 演示掩盖了它。WP8 的「错误 → 下一步」必须先修这条 |
| N3 | `node-lifecycle` 路由的错误体是 `{ error, message, code, condition?, dependencies? }`（顶层），而 `forwards` 的 condition 在 `data.condition` 里 | 前端错误解析器必须**同时**容忍两种已知形状（`lifecycleErrorInfo` 已经这么做了，可复用其读法），不能只认一种 |

## 2. 设计决策（实现照此交付）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **三层状态的判定权 100% 在后端**：用户 `/api/nodes` 直接返回 `lifecycle` / `connection` / `accepts_new_business` / `admission_rejection`，前端只渲染 | F2+F7。前端复刻 `deriveConnection` 必然分叉（同一 90s 窗口写在两处就已经是隐患） |
| D2 | **`nodeView` 改为调用 `deriveConnection` 与 `nodeAdmission`**，删除路由层的重复判据；`online` 保留为 `connection === "online"` 的兼容投影 | N1。列表页与旧客户端仍读 `online`，改成派生值不破坏契约 |
| D3 | **新增 `GET /api/dashboard/attention`**（用户侧、workspace 作用域）返回可直接渲染的**待办条目**：每条含 `kind` / `severity` / `reason_code` / `next_action_code` / `target`（Forward 或 Node 的 id）。判定复用既有服务（`nodeAdmission`、`apply_error_code` + `isRetryable`） | F1 的根因是「没有聚合口径」。放在后端才能避免前端把同一批规则再写一遍；`reason_code` 用既有码（HealthReasonCode / LifecycleConditionCode / SchedulerErrorCode）而不是新造一套 |
| D4 | **前端错误 → 动作 = 码 → 文案的翻译层**：`reasonAction`（WP6）与 `conditionAction`（WP7）**直接复用**；Forward 侧新增 `applyErrorAction` 表，键集钉死为后端 `SCHEDULER_ERROR_CODES`，并对 `isRetryable` 分流（可重试 → 给「重试」，不可重试 → 指向管理员/套餐） | F5+N2。重试语义属于编排知识（后端已有 `RETRYABLE` 集合），前端只翻译 |
| D5 | **修 `finalize()` 的人读原因**：错误消息按 `message → error → 状态码兜底` 顺序取 | N2。不修就无法「给下一步」——拿不到原因只能给状态码 |
| D6 | **raw revision / desired internals 默认折叠**：详情页的「技术细节」（`config_revision` / `applied_revision` / `last_applied_at` / `desired_status` / `desired_revision_id`）进 `<details>` 折叠块，默认收起；列表页不出现 revision | §13.7 Wave 4「Forward/Node 普通页面使用产品状态，不默认暴露 raw revision/desired internals」。信息不删除（排障仍要），只是不再默认糊在脸上 |
| D7 | **产品状态投影只由前端 `forwardProductStatus()` 做一次**，列表 / 详情 / Dashboard 共用同一实现 | 三处各写一遍必然出现「列表说失败、详情说同步中」 |
| D8 | **新测试落在已被 CI 覆盖的目录**：web 侧进 `dashboard/__tests__` 与 `forwards/__tests__`（F6），或同步更新 `ci.yml` 的分目录列表；后端进 `backend/src/**/__tests__`（`bun test src` 递归覆盖） | 交付的测试必须真的被执行 |
| D9 | mock 与后端**同形**：mock 的 `/nodes` 也返回三层状态、mock 增加 `/dashboard/attention`；mock 里判定规则注明「以后端为准」 | mock 是前端演示与契约测试的运行环境（WP6/WP7 先例） |
| D10 | 词条单列 `web/src/lib/attention-i18n.ts`，不落 `i18n.ts` | 与 WP6/WP7 同一决策，避免大字典冲突 |

## 3. 切片与提交（每片一个 commit）

| # | commit | 内容 | 边界 |
|---|---|---|---|
| S0 | `docs(v4-wp8): plan report` | 本报告 | 只加 `reports/` |
| S1 | `feat(v4-wp8/s1): user node three-layer projection reuses backend judgement` | `backend/src/routes/nodes.ts`：`nodeSelect` 加 `lifecycle`；`nodeView` 改为调 `deriveConnection` / `nodeAdmission`，输出 `lifecycle` / `connection` / `accepts_new_business` / `admission_rejection`，`online` 变派生。测试 `backend/src/routes/__tests__/nodes-projection.test.ts` | 只碰 backend 用户侧读投影；不改 schema |
| S2 | `feat(v4-wp8/s2): dashboard attention endpoint` | 新增 `backend/src/services/attention.ts`（聚合判定，复用 `nodeAdmission` + `isRetryable`）+ `backend/src/routes/dashboard.ts` 的 `GET /attention`；测试 `backend/src/services/__tests__/attention.test.ts` | 只加读端点 |
| S3 | `feat(v4-wp8/s3): web monitoring lib (types, api, product status, error→action)` | `web/src/lib/types.ts` 增量、`lib/api.ts`（`dashboard.attention` + 错误消息兜底 D5）、`lib/forward-status.ts`（产品状态单实现 D7）、`lib/attention.ts`（条目归类/排序/链接）、`lib/attention-i18n.ts`（含 `applyErrorAction`，键集对齐 `SCHEDULER_ERROR_CODES`） | 只碰 `web/src/lib/` |
| S4 | `feat(v4-wp8/s4): dashboard attention panel + quick actions` | `web/src/components/dashboard/attention-panel.tsx` + `dashboard-body.tsx` 接线（异常/离线/等待安装入口 + 快捷操作）；`nodes` 用户页状态渲染改用后端三层字段 | 只碰 dashboard / nodes 组件 |
| S5 | `feat(v4-wp8/s5): forward product status, error next step, hide raw internals` | `forward-detail.tsx`：产品状态 + `applyErrorAction` 下一步 + 409 `condition` 消费 + 「技术细节」折叠（默认收起）；`forward-workspace.tsx`：状态列改产品状态、create/patch 失败按码给下一步 | 只碰 forwards 组件 |
| S6 | `feat(v4-wp8/s6): mock parity for three-layer status + attention` | `web/src/mocks/state.ts`（节点生命周期已在）、`handler.ts`（`/nodes` 三层投影 + `/dashboard/attention`） | 只碰 `web/src/mocks/` |
| S7 | `test(v4-wp8/s7): monitoring contract tests` | `web/src/components/dashboard/__tests__/wp8-attention.test.ts`、`web/src/components/forwards/__tests__/wp8-forward-status.test.ts`（含 CI 目录反查断言） | 只加测试 |
| S8 | `docs(v4-wp8): delivery outcome` | 回填本报告 §6/§7（真实 SHA、CI run、未完成项） | 只改 `reports/` |

回滚：纯读端点 + 前端投影，无 schema/migration 变更；回滚镜像即回滚。

## 4. DoD 映射

| §13.6/§13.7 要求 | WP8 落点 |
|---|---|
| Dashboard 优先显示异常、离线、等待安装和快捷操作 | S2 `/dashboard/attention` + S4 面板（离线节点 / 等待安装节点 / 维护·停用·退役节点 / 失败 Forward / 长期 pending），每条带目标链接与动作按钮 |
| Forward/Node 普通页面使用产品状态，不默认暴露 raw revision/desired internals | S3 `forwardProductStatus()` 单实现 + S5 折叠「技术细节」（默认收起）+ 列表页状态列改产品状态 |
| 错误必须给下一步动作 | S3 `applyErrorAction` + S1/S5 的 `conditionAction`/`reasonAction` 复用；S3 D5 修错误消息丢失 |
| 普通用户状态语义（§13.4.1 三层） | S1 用户 `/api/nodes` 三层投影 + S4 nodes 页渲染 |
| 409 condition 被消费 | S5：Forward 写操作按 `condition` 给下一步；`revision_conflict` 保留既有「刷新后重新确认」 |
| 必要轮询 | 用户节点列表 / Dashboard 待办刷新沿用 WP7 的 `INSTALL_POLL_INTERVAL_MS` 口径（10s，30min 上限），不新增第二套轮询常量 |
| 契约测试 | S1/S2 后端 + S7 web，全部落在 CI 已覆盖的目录（D8） |

## 5. 测试计划

- **后端**（`bun test src`，CI 递归覆盖）：`deriveConnection` 三种连接 × lifecycle 四态 × 凭据/撤销矩阵；`nodeView` 输出键集与 `online` 派生一致；attention 聚合（离线、等待安装、维护中、失败 Forward、`isRetryable` 分流）；**反查断言**：注意力条目只来自后端判定函数，不存在前端可见的第二套规则。
- **web**（`bun test`，落 `dashboard/__tests__` 与 `forwards/__tests__`）：`forwardProductStatus` 对 `(apply_status, config/applied revision, suspended)` 的组合表；`applyErrorAction` 键集 == 后端 `SCHEDULER_ERROR_CODES`（源码正则反查，防止后端加码而前端漏词条）；`conditionAction`/`reasonAction` 复用而非复制（源码级断言）；attention 条目 → 链接/排序；**CI 目录反查**：断言新测试文件所在目录在 `.github/workflows/ci.yml` 的 `bun test …` 列表里。
- **不做**：本地 `npm run build`、本地全量 `tsc --noEmit`（按项目与用户约束，交 GitHub Actions）；不本地镜像构建。

## 6. 交付结果（实现后回填）

见 S8 提交；本报告 §7 记录未完成项与 Gate 风险。

## 7. Gate / 风险（实现后回填）

- Gate V4-F3 的真实 E2E 不在本 WP 内闭环，本 WP 只提供 Dashboard / 普通页面产品面与错误动作。

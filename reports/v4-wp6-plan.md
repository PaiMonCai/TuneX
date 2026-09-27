# V4-WP6 Agent Telemetry & Node Health — 开发报告

**Work Package**: V4-WP6（`DEVELOPMENT.md` §13.4.4 / §13.6 / §13.7 Wave 3）
**分支**: `feature/v4-wp6-agent-telemetry`
**Worktree**: `/opt/TuneX-v4-wp6`
**基线**: `origin/main` = `65529d6`（WP5 已并入，CI 36284437876 绿）
**范围**: Agent 上报契约的遥测扩展 + 后端 health synthesis + 版本/资源/runtime 状态读面 + 测试。
**不做**: WP7 的 web UI（`web/`）、WP9 的列表分页/筛选（`routes/forwards.ts`、web 列表页）、生产 DB/容器。

---

## 1. 调研结论：主干现状 vs WP6 DoD

### 1.1 主干已有的（复用，不重造）

| 事实 | 落点 |
|---|---|
| 上报唯一入口 | `POST /api/internal/node/state` → `services/node-state.ts`（凭据即身份，`agent_id` 为不可变运行实例护栏） |
| 上报真源表 | `node_state_report`（每节点一行 upsert）：`version / role / reported_revision / tunnels / egress_pools / used_ports / last_error / reported_at` |
| 三层状态中的两层 | `services/node-lifecycle.ts` 的 `deriveConnection`（waiting/online/offline）+ `Node.lifecycle`（active/maintenance/disabled/retiring） |
| 前端可见的 Lifecycle API | `GET /api/admin/node/:id/lifecycle`，文件注释已写明 `health —— 本期不回（WP6 telemetry）` |
| runtime id 口径 | `services/reconciler.ts` 的 `runtimeId(tunnelId, direct\|ingress\|egress)` |

### 1.2 差距（WP6 必须补的四件事）

1. **上报契约缺 §13.4.4 明列的字段**：`agent_id`/Node identity 校验、version 已有；但 **启动时间/uptime、hostname/OS/arch、known vs applied revision、DIRECT/RELAY-ingress/RELAY-egress runtime 数量、CPU/memory/disk/load、错误计数与时刻** 主干都没有。`reported_revision` 只表达「已应用」，无法区分「面板在推但节点应用不了」。
2. **Health 完全没有**：`healthy|warning|error|unknown` 在主干无任何实现（`node-admin.ts` 只有 `isStaleState` 这种单点事实判定）。
3. **`offline ≠ error` 这条硬约束没有落点**：主干把「连接」与「状态」混在 `Node.status` 一处表达，WP5 已把 Connection 与 Lifecycle 拆开，Health 必须成为**第三个独立结论**，且不得由 Agent 自报。
4. **「版本是否建议升级」无基线**：`Node.version` 只有一个字符串，没有可比对的目标版本，也没有「落后」判定。

---

## 2. 设计决策（先写死，实现照此交付）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **扩展既有 `NodeStateReport`，不新增第二套监控真源**（§13.4.4 明文） | 新表/新端点会让「state report 说 A、监控说 B」，而 §13.4.4 的核心事实链（是否在上报 → desired/applied 是否一致 → runtime 是否存在 → 端口是否真实占用 → 是否存在 apply/runtime error）只能有一份输入 |
| D2 | Agent 只报**事实**，Health 由后端合成；载荷里**没有** `health` 字段 | §13.4.4：「不允许一句 `health=healthy` 成为最终真相」 |
| D3 | 新增列**全部可空、无默认值**；缺失 = NULL = 「未知」，空对象/空数组 = 「现在是空的」 | 给默认值会把「旧 Agent 没报内存」渲染成「内存 0%」，把未知说成健康是监控最坏的失败模式 |
| D4 | JSON 列未上报用 `Prisma.JsonNull` 而不是 `{}` | `{}` 会被读成「有采样但字段全缺」，与「根本不报」混淆 |
| D5 | health 判定是**纯函数**（无 IO、无 DB、无时钟依赖，`now` 注入） | 判定要能被穷举单测钉死；DB 读面单独一层，便于 WP7/WP8 复用同一份结论 |
| D6 | `error_count`/`last_error_at` 入 `snapshotFingerprint`，`host_metrics` 不入 | 同一个错误反复出现时内容不变但计数会动；资源每 30s 必变，纳入就等于指纹永远不同、失去「无变化」信号 |
| D7 | 判定阈值（内存/磁盘/负载/错误持续窗口）显式成 `HealthThresholds` 接口，可覆盖 | 部署方可按机器规格调；测试不必钉具体数值 |
| D8 | runtime id 由 `reconciler.runtimeId` **导出复用**（不是复制字符串拼接） | 两处各拼一次，Agent 侧改规则就会出现「reconciler 说落后、health 说没运行」的分叉 |
| D9 | health 读面独立成 `services/node-health-service.ts` + `routes/node-health.ts`，只**消费** `node-admin.resolveNodeId` | WP9（列表面）与 WP10（权限/NodeGroup）之后都要动 node-admin 的查询面；WP6 只读三张表，避免三方在同一函数里冲突 |

---

## 3. 切片与提交

| # | 内容 | 边界 |
|---|---|---|
| 1 | **Agent 上报契约**：`internal/reporter/telemetry.go`（host identity / 轻量资源采样 / runtime counts / revision ledger）+ `resources_linux.go`（`syscall.Sysinfo`+`Statfs`+`/proc/self/statm`，纯标准库）+ `!linux` 回退 + heartbeat `StatePayload` 接线 + control 侧错误账本 | 只碰 `agent/`；不改下发/apply 主循环 |
| 2 | **后端遥测落库 + health synthesis**：schema/migration 增量列、`validateStateReport` 遥测段 fail-closed 校验、`telemetryColumns` 映射、`services/node-health.ts`（纯判定）、`services/node-health-service.ts`（读面投影）、`routes/node-health.ts`（单节点 + 全量巡检） | 只碰 `backend/src/services`、`backend/src/routes`、`prisma/`；不碰 `web/`、不碰 forwards |

每个切片 `bun test src`（全量）+ `tsc --noEmit` + `go test ./...`/`go vet` 本地自证后提交，CI 复核。

---

## 4. DoD 逐项映射（§13.4.4「状态报告至少覆盖」）

| §13.4.4 要求 | 落点 |
|---|---|
| `agent_id` / Node identity 校验 | 既有 `submitStateReport`（`agent_id_mismatch` → 401），WP6 不改语义 |
| Agent version | `node_state_report.version`（既有列）+ health 的 `agent_version_behind` / `agent_version_unknown` |
| 启动时间 / uptime | `agent_started_at`（unix 秒 → Date；uptime 由面板用**面板时钟**推导，不信 Agent 时钟做算术） |
| hostname、OS、arch | `hostname` / `os` / `arch` |
| latest known / applied revision 摘要 | `known_revision`（新）+ `reported_revision`（既有）；`revision_pending = known > applied` |
| DIRECT / RELAY ingress / Egress runtime 数量 | `runtime_counts` JSON（`{direct, relay_ingress, relay_egress, total}`；未知种类**拒绝**，因为少算一类会让「runtime 是否都在跑」失真） |
| active Forward / runtime 快照 | 既有 `tunnels` + health 的 `runtime_missing`（desired active 但快照里没有 → `error`） |
| 实际占用端口 | 既有 `used_ports`（投影到 `telemetry.used_ports`） |
| 最近 runtime/apply error | 既有 `last_error` + 新 `error_count` / `last_error_at` → `agent_errors_ongoing`（窗口内 = error）与 `agent_errors_historical`（= warning）；Forward 的 `apply_status=error` → `forward_apply_error` |
| CPU / memory / disk / load 轻量值 | `host_metrics` JSON → `resource_memory_high` / `resource_disk_high` / `resource_load_high`（只到 warning，绝不单独升级为 error；字段缺失不判定） |

Health 四态（§13.4.4 语义逐条）：

| 态 | 触发面 |
|---|---|
| `healthy` | online + 快照新鲜 + revision 一致 + 无持续错误 + 资源未近阈值（理由列表为空） |
| `warning` | 在线但 revision 落后 / Forward 历史错误 / 版本落后 / 资源接近阈值 / 上报过期 / 自报角色与面板不一致 |
| `error` | 窗口内仍有错误（持续错误）/ desired active 但 runtime 不存在 / Forward 上次应用失败 |
| `unknown` | 尚未安装（无凭据）/ 从未上报 / 离线（**Offline 是 Connection，不等于 Health=error**，§13.4.4 末句）；此时保留已知的 warning 理由而不抹平 |

---

## 5. 剩余 Gate / 未完成

- **V4-WP7**（Node Lifecycle Product UX）消费本 WP 的 `GET /api/admin/node/:id/health` 与 `?health=` 巡检；WP6 的**后端/Agent 切片不做** web UI（Web 呈现切片见 §6）。
- **V4-WP8** 的「人工确认诊断」需要真实多节点故障数据样本；WP6 只保证理由码与严重度稳定。
- **Gate V4-F2** 的真实验证（waiting→online→offline、maintenance 期间保存 Forward、退出维护只收敛最新 revision…）由 WP7/WP8 阶段的 E2E 承担；WP6 提供的事实面是它的输入。
- 本地不跑全项目 tsc/镜像构建（限内存）；以 `bun test src` + `tsc --noEmit` 的分包自证 + GitHub Actions 为准。

---

## 6. Web 呈现切片（§13.4.4 的读面）

范围：**只碰 `web/`**。把 §1–§4 定下的后端结论渲染进**既有**节点 UI，新增消费
`GET /api/admin/node/:id/health`（单节点）与 `GET /api/admin/node/health`（全量巡检）。
后端/Agent 契约不动。本切片与 §1–§4 的后端审查修复一并由收尾代理提交为 WP6 收尾
commit（分支 `feature/v4-wp6-agent-telemetry`）。

### 6.1 新增

| 文件 | 作用 |
|---|---|
| `web/src/lib/node-health.ts` | 纯展示逻辑：徽章映射、比例/字节/时长/端口区间格式化、runtime 计数条目、资源行、`hasReasonCode`。无 React / 无网络，可离线单测 |
| `web/src/lib/node-health-i18n.ts` | 四态/连接/生命周期/严重度/flags/字段名 + 16 个 reason code 的中英词条 |
| `web/src/components/admin/node-health-panel.tsx` | 展示组件：徽章、flags、reasons（可操作）、版本/身份/revision/runtime/资源/错误六区块 |
| `web/src/components/admin/node-health-manager.tsx` | 取数组件：客户端拉 health，失败保留上一份视图 |
| `web/src/mocks/node-health.ts` | mock 侧 health 投影（镜像后端形状与规则），供 mock 模式与契约测试 |
| `web/src/components/admin/__tests__/wp6-node-health.test.ts` | 38 条契约 / 纯逻辑 / 接线断言 |

### 6.2 修改

| 文件 | 作用 |
|---|---|
| `web/src/lib/api.ts` | `api.admin.nodeHealth` / `nodeHealthList`；`RequestOptions.unwrap`（fleet 是 `{data,total,summary}` 信封，通用解包会把 summary 丢掉） |
| `web/src/lib/types.ts` | WP6 health 类型（view / telemetry / reason / flags / summary）；`NodeStateReport` 补扩展列；`Node.lifecycle`；`NodeRuntimeTunnel.id` 由 `number` 校正为 **runtime id 字符串**（与 `parseReportedRuntimes` 判据一致） |
| `web/src/components/admin/node-detail-manager.tsx` | 详情页挂 `<NodeHealthManager />` |
| `web/src/components/admin/nodes-manager.tsx` | 列表新增「健康」列 + 全量四态概览条；列表刷新后同步健康；取数失败静默回落为「-」 |
| `web/src/components/admin/node-runtime-panel.tsx` | 仅加注释划清边界（原始上报快照 vs 派生判定），行为未变 |
| `web/src/mocks/handler.ts` | mock 路由 `GET /admin/node/health`、`GET /admin/node/:id/health` + `healthWorld` 投影助手 |
| `web/src/mocks/data.ts`、`web/src/mocks/state.ts` | 演示上报种子（只给 sg-out-01；不动 WP12 用 id=4 的空态断言） |

### 6.3 判断

- **不重算判定**：面板不比较版本、不比阈值，否则就是 §13.4.4 禁止的第二套真相。`hasReasonCode(view, "agent_version_behind")` 只决定是否显示「建议升级」徽章。
- **未知 ≠ 0**：扩展列缺字段时不出行 / 显示 `-`，绝不渲染成 0（旧 Agent 不报内存时显示「内存 0%」会误导）。
- **offline 不画成故障**：连接态用中性徽章；`connection !== online` 且无 error 级理由 → 整体 `unknown`（§13.4.4 末句）。
- **词条不落 `i18n.ts`**：WP9 正在改 `i18n.ts` 的 forward 词条，WP6 词条单列 `node-health-i18n.ts`，两分支不在同一处收口。
- **mock 时钟用 `seed.now`**：与整套演示数据同一基准，否则固定时间戳会随真实时间变旧、同一会话内自相矛盾。

### 6.4 验证

- `bun test src/components/admin/__tests__/wp6-node-health.test.ts` → **38 pass / 0 fail**（223 断言）。
- `bun test src/components/dashboard/__tests__/ src/components/admin/__tests__/ src/components/forwards/__tests__/`（CI web 步的原命令，`web/node_modules` 指向 `/opt/TuneX/web/node_modules`）→ **131 pass / 0 fail**。
- `bun test`（全量 web）→ **131 pass / 0 fail**。改动前无 `node_modules` 时的 1 fail / 1 error（`forward-edit-dialog.test.ts` 找不到 `react/jsx-runtime`）是**环境**问题：接上依赖后转绿，与本次改动无关。
- `tsc --noEmit`（web，接上依赖后）→ **exit 0**。首轮报出一处真实类型错误并已修：`web/src/mocks/node-health.ts` 把 `NodeRuntimeTunnel` 直接 `as Record<string, unknown>` 触发 TS2352（该接口无字符串索引签名），改为 `as unknown as Record<string, unknown>`——上报是外部输入，坏形状仍须能安全读。
- `tsc --noEmit`（backend）→ **exit 0**；`bun test src`（全量 backend unit）→ **947 pass / 0 fail**。
- `bun scripts/ci/secret-scan.mjs` → OK（387 个跟踪文件，仅既有弱口令告警，不阻断）。
- 无本地 `next build`（按任务约束，交 CI web 步验证）。
- 与 WP9 合并安全：对 `api.ts` / `types.ts` / `i18n.ts` / `handler.ts` 做三方合并（base=`origin/main`）**无冲突**，合并结果可解析且两侧功能共存（已固化为测试用例）。

### 6.5 Web 切片剩余 Gate

1. **后端联调**：确认真实 `/admin/node/health` 信封与单节点 `{data: view}` 形状与本文假设一致（含 `port_not_bound` / `flags.ports_bound` 契约修订）。
2. **`next build`**：`tsc --noEmit` 已在本地转绿，构建仍只由 CI 的 `npm run build` 验证（本地不 build）。
3. **组件级渲染测试**：现有 web 测试无 jsdom 环境，面板 DOM 未在浏览器中断言（mock 覆盖了取数与投影）。
4. **`i18n.ts` 收敛**：WP6 词条暂存独立文件，建议两个分支合并后统一并入。
5. **列表健康列刷新**：当前只在首屏与列表 CRUD 后刷新；定时轮询属 WP8 范围。

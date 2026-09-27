# V4-WP7 Node Lifecycle Product UX — 开发报告

**Work Package**: V4-WP7（`DEVELOPMENT.md` §13.4 / §13.6 / §13.7 Wave 3）
**分支**: `feature/v4-wp7-node-lifecycle-ux`
**Worktree**: `/opt/TuneX-v4-wp7`
**基线**: `origin/main` = `2b923a5`（V4-WP6 已并入的 main）
**Track**: D（Web / QA）

范围：把 V4.2 的托管 Node 生命周期做成**用户可用**的界面——安装等待闭环、
维护/停用/退役操作 UI、依赖预览、Node 详情监控。
**不做**：不改后端/Agent 契约、不改 schema/migration、不碰 `agent/`、不碰
生产容器与 DB、不做 WP8 的 Dashboard/诊断入口、不做 WP9 的分页筛选。
**硬约束**：WP7 只**消费** WP5 的 lifecycle API 与 WP6 的 health API，
不另造健康或准入判定（§13.4.1 / §13.4.4）。

---

## 1. 调研结论：可复用的既有事实（不重造）

| 事实 | 落点（main 已有） |
|---|---|
| 生命周期字段 | `Node.lifecycle`（enum `NodeLifecycle`，默认 `active`，WP5） |
| 生命周期读视图 | `GET /api/admin/node/:id/lifecycle` → `{ data: NodeLifecycleView }` |
| 生命周期写 | `PATCH /api/admin/node/:id/lifecycle` body `{ lifecycle, note? }` → `{ data: { node, view } }` |
| 迁移白名单 / 准入谓词 | `services/node-lifecycle.ts` 的 `canTransition` / `allowedTransitions` / `nodeAdmission` / `deleteGates`（**唯一代码落点**） |
| 依赖统计 | `GET /api/admin/node/:id/impact`（`?next_role=&port_min=&port_max=&current_role=`）→ `{ data: { impact, role_check } }` |
| 物理删除 | `DELETE /api/admin/node/:id/lifecycle`（前置 `retiring` 且依赖清空） |
| 三层状态（Health 层） | `GET /api/admin/node/:id/health` + `GET /api/admin/node/health`（WP6，已在本分支 main 中） |
| health UI 基建 | `web/src/lib/node-health.ts`、`node-health-i18n.ts`、`node-health-panel.tsx`、`node-health-manager.tsx`（WP6） |
| 安装命令 | `POST /api/admin/node/:id/enrollment` → `NodeEnrollmentIssued.install_command`（WP7 早期已合并） |
| 凭据 | `POST /api/admin/node/:id/credential[/rotate|/revoke]`（`node-credential-panel.tsx`） |

**关键观察**：WP5 的 `/api/nodes`（用户侧投影）**没有**落地计划里写的
`lifecycle/connection/accepts_new_business` 字段（实测 `routes/nodes.ts` 无
`lifecycle` 引用）。因此 WP7 的界面一律走**管理端** `/api/admin/node/:id/*`
（WP5/WP6 已实现的真实端点），不在本 WP 里改后端。

## 2. 设计决策（先写死，实现照此交付）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **判定全部来自后端**：UI 只渲染 `allowed_transitions` / `accepts_new_business` / `admission_rejection` / `health` / `reasons`。前端不比较版本、不重算 `canTransition` | §13.4.1「Agent 只上报原始状态，不允许一句 health=healthy 成为最终真相」；两套判据必然分叉 |
| D2 | **依赖预览只读 `/impact`**，不在前端复刻五类计数 | impact 的唯一实现是 `getNodeImpact`；前端再查一次表就是第二套统计 |
| D3 | **删除闸门做成「预览 + 服务端裁决」**：UI 用 impact + lifecycle 提前禁用并列出要清什么，但最终以 `DELETE` 的 409 `code/condition/dependencies` 为准 | 前端预览只是体验优化，不能成为安全边界 |
| D4 | **安装等待闭环 = 轮询 `connection`**，到达 `online` 即闭环；`waiting`→「等待安装」，`offline`（有凭据但掉线）→「已安装但掉线」 | `deriveConnection` 口径唯一（90s 窗口）；前端不发明第二套在线判定 |
| D5 | **`retiring` 是单向门**：不渲染「取消退役」按钮（WP5 R6 明文要求） | 契约显式拒绝 `retiring → *`，给一个必失败的按钮是骗用户 |
| D6 | **offline ≠ 故障**：连接徽章用中性样式，`maintenance`/`disabled` 用非红色徽章 | §13.4.4 末句；维护中正常关机不该看起来像事故 |
| D7 | 词条单列 `node-lifecycle-i18n.ts`，不落 `i18n.ts` | 与 WP6 同一决策，避免与并行分支在同一处收口 |
| D8 | mock 只**镜像形状与关键规则**，并在注释里标注「以后端为准」 | mock 模式是前端演示与契约测试的唯一运行环境（WP6 先例） |

## 3. 切片与提交（每片一个 commit）

| # | commit | 内容 | 边界 |
|---|---|---|---|
| S0 | `docs(v4-wp7): plan report` | 本报告 | 只加 `reports/` |
| S1 | `feat(v4-wp7): node lifecycle types + api client + display logic` | `lib/types.ts` 增量、`lib/api.ts` 四个方法、`lib/node-lifecycle.ts`（纯逻辑）、`lib/node-lifecycle-i18n.ts` | 只碰 `web/src/lib/` |
| S2 | `feat(v4-wp7): mock lifecycle/impact endpoints` | `mocks/node-lifecycle.ts` + `mocks/handler.ts` 路由 + `mocks/state.ts` 种子 | 只碰 `web/src/mocks/` |
| S3 | `feat(v4-wp7): node lifecycle panel + dependency preview + install waiting` | `components/admin/node-lifecycle-panel.tsx`、`node-lifecycle-manager.tsx`、`node-install-waiting.tsx` + 接线详情页与列表页 | 只碰 `web/src/components/admin/` |
| S4 | `test(v4-wp7): lifecycle UX contract tests` | `components/admin/__tests__/wp7-node-lifecycle.test.ts` | 只加测试 |

回滚：纯前端，回滚镜像即回滚；无 DB 影响。

## 4. DoD 映射（§13.4.3「V4 用户侧必须补齐 Node 生命周期操作」）

| §13.4.3 要求 | WP7 落点 |
|---|---|
| 重新安装 Agent | 安装等待闭环对话框（生成 enrollment + 轮询到 online），详情页可重开 |
| 进入/退出 maintenance | lifecycle 面板的 `allowed_transitions` 按钮 + note |
| disabled / re-enable | 同上（`disabled → active` 在合法表内） |
| 进入 retiring | 同上（单向门，无取消） |
| 删除 | 面板删除入口 + impact 预览 + 409 依赖清单透传 |
| 修改 role / 端口范围 impact check | 面板 role/port 表单提交前调 `/impact?next_role=&port_min=&port_max=`，`role_check` 不通过即阻止并给出原因 |
| 查看 Agent version / 是否建议升级 | 复用 WP6 health 卡的 `agent_version_behind` 徽章与 `expected_version` |
| 依赖预览 | impact 五类计数 + 阻塞原因清单（`dependencies`） |
| Node 详情监控 | 详情页 lifecycle 面板 + WP6 health 卡 + impact 预览同页呈现 |

## 5. 测试计划

- 纯逻辑单测（`bun test`，不起浏览器）：迁移按钮推导、单向门无取消、
  impact 条目/阻塞判定、准入拒绝码 → 下一步文案、安装等待阶段机、
  `deleteGates` 预览与服务端 409 一致、未知码退化。
- mock 契约测：`/admin/node/:id/lifecycle`（GET/PATCH/DELETE）、`/impact`
  的形状与错误码（400 invalid_input / 404 / 409 invalid_state +
  dependency_blocked）。
- 接线断言：源码层面确认详情页挂了 lifecycle 管理、列表页保留健康列。
- 本地不跑 `next build`、不跑全量 `tsc`（按项目约束与用户要求）；CI 负责
  typecheck/build。

## 6. 剩余 Gate / 未完成

1. **后端联调**：确认真实 `GET /api/admin/node/:id/lifecycle` 的
   `NodeLifecycleView` 与 `PATCH` 的 `{ node, view }` 信封与本文假设一致。
2. **Gate V4-F2 的真实 E2E**（waiting→online→offline、maintenance 期间保存
   Forward、退出维护只收敛最新 revision、retiring 依赖阻止删除）由
   WP7/WP8 阶段的 E2E 承担；WP7 只提供 UI 输入面。
3. **`next build`** 只由 CI 验证（本地不 build）。
4. **组件级渲染测试**：现有 web 无 jsdom 环境，DOM 交互未在浏览器中断言
   （mock 覆盖取数与投影）。
5. 定时轮询（列表页健康/生命周期自动刷新）属 WP8 范围。

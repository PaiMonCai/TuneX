# V4-WP4 — Forward Edit Product UX 开发报告

- Work package: **V4-WP4 Forward Edit Product UX**（Track D，Wave 2，mock 阶段）
- Baseline: `feature/v4-wp1-forward-revisions` @ `74f97cd`（WP1 contract 冻结点；CI 绿：run 36184882122）
- Worktree: `/opt/TuneX-v4-wp4`，分支 `feature/v4-wp4-forward-edit-web`（基于 74f97cd，不带 WP3/WP5 内容）
- 规范依据: `DEVELOPMENT.md` §13.3（Forward 编辑模型硬约束）、§13.3.4（Hot Reload 分类）、§13.6（WP4 DoD）、§13.7（Wave 1「Track D 可用 mock 提前开发」）、§13.9（分支/PR 约定）
- 本报告先于实现提交；实现按本报告「实现切片」逐 commit。

---

## 1. 范围（Scope）

### 1.1 In scope（WP4 mock 阶段交付）

| # | 交付物 | 对应 DoD |
|---|---|---|
| S1 | **编辑表单 = 创建表单字段全集**：Forward 详情页编辑器覆盖 `name` / `mode` / `ingress_node_id` / `egress_node_id` / `listen_port` / `target_host` / `target_port`，缺一项即不算「创建后可全编辑」 | 创建表单=编辑能力全集 |
| S2 | **impact warning**：保存前调用 WP1 的 `POST /api/forwards/:id/preview`，把 §13.3.3 要求的影响面（外部访问地址变化 / listener 重建 / 参与 PREPARE·DRAIN 的节点 / 端口状态 / 是否需要新 NodeBinding）渲染成用户可读的 warning 面板；阻断性 error 直接禁止保存 | impact warning |
| S3 | **running-vs-desired**：详情页显式对照 `config_revision`（desired）与 `applied_revision`（applied），落后时展示「待应用」而不是内部 revision 数字堆砌；§13.4/Wave 4 的「不默认暴露 raw revision internals」在 mock 阶段只做到状态语义化，不删信息 | running-vs-desired |
| S4 | **copy/result UX**：监听地址/目标地址/预览预测地址一键复制；preview 的 `desired_address` 作为「保存后访问地址」展示；保存成功回执带新 revision；`409 revision_conflict` 的下一步动作（刷新后重新确认） | copy/result UX |
| S5 | **mock 契约升级到 WP1 形状**：`src/mocks/handler.ts` 的 `PATCH /forwards/:id` 从「只改 name」升级为全字段 patch + `expected_revision` 409 + revision 递增；新增 `POST /forwards/:id/preview` 返回同一 `impact`/`validation` 形状 | 隔离 mock（不依赖真后端） |
| S6 | **定向测试**：`src/components/forwards/__tests__/forward-edit.test.ts`（mock 契约 + 编辑表单互斥映射），经 CI web job 既有的 `bun test src/components/forwards/__tests__/` 自动纳入 | 测试 |

### 1.2 Out of scope（明确不做）

- **不实现 WP3 五阶段 rollout**：UI 只消费 WP1 已冻结的 `impact` 契约（`metadata_only` / `listener_replacement` / `nodes_prepare_drain` / `desired_address` …），不自己推导 rollout 计划，不发 VALIDATE/PREPARE 类请求。
- **不碰 `agent/`**：WP2 Track 拥有 agent 目录；本 PR 无 Agent 侧改动。
- **不碰 `backend/`**：WP1 已冻结 preview/update 的 service 与 route；本 PR 不改后端一行代码（含 schema / migration / routes / services）。发现契约缺口只记录到本报告 §6，不在本分支内扩张。
- **不做 WP7/WP8/WP9 的 Node 生命周期 UI、Dashboard 异常入口、服务端分页/复制 Forward/批量操作**：§13.7 Wave 3/4 的事。
- **不做真后端联调 / E2E**：mock 阶段；CI web job 只跑单测 + `next build`（与 WP1 相同的边界）。
- 不改部署配置（`docker-compose*.yaml` / `Caddyfile*`）、不改 `.github/workflows/ci.yml`（web job 的测试 glob 已覆盖新文件，避免与并行 WP 的测试列表冲突）、不改 `web/src/lib/i18n.ts` 之外的既有页（只改 forwards 相关 3 个文件）。

### 1.3 WP4 与 §13.3.1「创建后可全编辑」的落地方式

创建表单当前收集的字段 = `name` / `mode` / `ingress_node_id` / `egress_node_id` / `listen_port` / `target_host` / `target_port`。编辑弹窗必须收集**同一集合**（`listen_port` 空 = 自动分配语义由后端归一化，前端把空串显式映射成 `null`，与 create 一致），因此「编辑能力 ⊇ 创建能力」是一条可断言的契约，写进测试而非靠人工核对。

§13.3.3「禁止把一次用户编辑拆成多个独立 PATCH」由前端结构性保证：编辑弹窗一次提交**一个** patch 对象（全字段），不做「先存名字再存端口」的分步保存；`expected_revision` 取详情页当前 `config_revision`，保存后按响应刷新。

## 2. 契约使用（WP1 冻结，WP4 只读）

| 契约 | 用法 |
|---|---|
| `PATCH /api/forwards/:id` | 一次全字段 patch；带 `expected_revision` = 打开编辑器时的 `config_revision` |
| `POST /api/forwards/:id/preview` | 同 body；打开编辑器与每次字段变更后调用，用于渲染 impact warning；不写库 |
| `ForwardView.config_revision` / `applied_revision` / `apply_status` | running-vs-desired 对照；`latest_revision` 与 `config_revision` 同值，m存 |
| `409 revision_conflict` + `data.latest_revision` | 提示最新 revision + 「刷新后重新确认」按钮 |
| `impact.changes_external_address` / `listener_replacement` / `ingress_node_change` / `egress_node_change` / `mode_change` / `target_change` / `listen_port_change` / `nodes_prepare_drain` / `binding_required` / `port_status` / `desired_address` / `metadata_only` | warning 面板逐项渲染 |
| `validation.errors` / `warnings` / `reasons` | errors → 阻断保存；warnings → 黄色提示 |

前端**不重新实现**任何校验/影响面规则：只做「字段是否为空 / 端口是否 1..65535 / direct 是否误填 egress」这类**形态**预检（减少无效请求），语义判定一律等 preview 返回。这保证 preview 放行 ⇔ PATCH 接受（§13.3.3 单一实现的 UI 侧镜像）。

---

## 3. mock 契约升级（`web/src/mocks/handler.ts` + `state.ts`）

mock 必须与 WP1 冻结的后端契约同形，否则 UI 在 mock 模式下验证的东西没有意义。

| 项 | 升级内容 |
|---|---|
| `PATCH /forwards/:id` | 接受全字段 patch（`name`/`mode`/`ingress_node_id`/`egress_node_id`/`listen_port`/`target_host`/`target_port`）；读取当前行 → 合并出完整候选 → 用**同一份** mock 校验函数校验 → 通过才落库 |
| `expected_revision` | 传入且与 `tunnel.config_revision` 不等 → `409 { code: "revision_conflict", data: { latest_revision } }`，**不写库** |
| 纯 name patch | 不 bump `config_revision`、不触发 runtime 收敛（§13.3.2） |
| 非纯 name patch | `config_revision + 1`、`applied_revision` 保持（→ apply_status `pending`，mock 假 Agent 半拍后 ACK 到 active，与既有 mock 语义一致） |
| `POST /forwards/:id/preview` | 同 body；返回 `{ current, candidate, impact, validation }`，不写库 |
| mock 影响面计算 | 复刻 WP1 `computeForwardImpact` 的判定口径（metadata_only / listen_port_change / ingress_node_change / mode_change / target_change / listener_replacement / changes_external_address / nodes_prepare_drain / desired_address），**只做 UI 需要的最小真子集**，并在注释里标注「以后端为准」 |
| revision 快照 | mock 事务内 `push` 一条 `{ tunnel_id, revision, ... }`（新增 `forwardRevisions` store 字段？——**否**，见下） |

**关于 mock 是否存 revision snapshot**：WP1 的真实性由后端迁移测试保证；mock 的价值是让 UI 跑在**形状正确**的契约上。因此 mock 只维护 `tunnel.config_revision` 计数与「desired 指针由当前行承担」的简化语义，**不引入第二张 revision 表**（避免 mock 里长出一套 WP1 的平行实现，反而 diverging）。`desired_revision_id` / `latest_revision` 字段照常返回（前者指向 `revision-<tunnelId>-<n>` 的稳定字符串投影即可满足 UI 展示；UI 不依赖它的精确值）。

## 4. UI 改动（`web/src/components/forwards/` + `lib/types.ts`）

### 4.1 `forward-detail.tsx`

| 区块 | 改动 |
|---|---|
| 头部 | 「修改名称」按钮 → 「编辑转发」；保留 retry/suspend/resume/delete |
| Basic info | 新增「保存后访问地址」复制按钮（取 `impact.desired_address`，未预测时禁用并说明原因）；`listen_port` 展示 `auto` 语义 |
| Runtime | 新增 **running-vs-desired** 行：`applied < config` → 「待应用（desired N / applied M）」徽标；`apply_status === "active"` → 「已应用」；`suspended` → 保持既有文案 |
| 编辑弹窗 | 全字段编辑器 + 实时 preview impact 面板 + 保存 |

### 4.2 新组件 `forward-edit-dialog.tsx`

- 表单字段与创建弹窗（`forward-workspace.tsx` 的 create dialog）**同源同序**：name → mode → ingress（relay 时才有 egress）→ listen_port → target_host → target_port。
- `mode` 从 relay 切 direct 时清空 `egress_node_id`（direct 必须 null）；从 direct 切 relay 时要求显式选 egress（与 WP1 `mode_topology_mismatch` 对齐）。
- `listen_port` 空串 → 发送 `null`（= 自动分配），占位文案沿用创建表单的 `autoPort`。
- **预览闸门**：字段变更后（debounce ~300ms）调 `api.forwards.preview(id, patch)`；返回 `validation.ok === false` 时保存按钮禁用并把 `errors` 逐条列出；`ok === true` 时展示 impact warning 列表。
- `expected_revision` = 打开时的 `config_revision`；保存成功后 `setForward(updated)` + `router.refresh()`。
- 文案全部走 `t()`，新增 key 落在 `i18n.ts` 的 `forward` 段（zh + en 双语）。

### 4.3 `types.ts`

- `ForwardPatchInput` 扩展为 WP1 冻结的全字段 + `expected_revision`。
- `PortForward` 增加 `desired_revision_id` / `latest_revision`（WP1 forwardView 已返回）。
- 新增 `ForwardPreviewResult` / `ForwardImpact` / `ForwardValidation` / `ForwardPreviewConfig` 前端镜像类型。

### 4.4 不在本 PR 内

- `forward-workspace.tsx` 只做**零改动**（列表页筛选/创建已有实现，WP9 才做服务端分页）——除测试需要外不改。
- 不动 `tunnels` legacy 页面、admin 页面、dashboard。

## 5. 测试计划

| 层 | 用例 | 执行者 |
|---|---|---|
| mock 契约单测 | ① 全字段 PATCH 合并当前 desired 后校验，非纯 name patch 使 `config_revision + 1`；② 纯 name patch 不 bump revision；③ `expected_revision` 过期 → `409 revision_conflict` + `data.latest_revision`，且行未被修改；④ `mode: direct` 带 `egress_node_id` → 400 `mode_topology_mismatch`；⑤ relay 缺 binding → 409 `binding_required`；⑥ 端口占用 → 409 `port_conflict`；⑦ `listen_port: null` = 自动分配（端口区间可用时 auto）；⑧ preview 不写库且 `impact` 字段与 §13.3.3 对齐（改 target → `target_change` 且 `listener_replacement=false`；改 listen_port → `listener_replacement=true` + `changes_external_address=true`；改 ingress → `nodes_prepare_drain` 含新旧两端）；⑨ preview 的 `validation.errors` 与 PATCH 的拒绝原因一致（同一条 forbid rule）；⑩ `desired_address` 预测形如 `ip:port`，端口 auto 时仍给确定值 | CI web job `bun test src/components/forwards/__tests__/` |
| 表单契约单测 | ⑪ 编辑表单字段集 ⊇ 创建表单字段集（从源码抽取 key 集合做断言，防止回归成「只能改名」）；⑫ direct↔relay 切换的字段互斥映射（切 direct 必须清 egress；切 relay 必须显式选 egress）；⑬ `listen_port` 空串序列化为 `null` | 同上 |

本地只跑**单文件** `bun test src/components/forwards/__tests__/`（web job 的 glob 子集）。typecheck 与 `next build` 全交 CI（小内存机器不跑 tsc/build）。

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| mock 与 WP1 后端 diverging（UI 在 mock 绿、真后端红） | Gate V4-F1 才发现 | mock 契约测试的用例名/错误码/impact 字段与 WP1 后端测试逐条同名；本报告 §3 的升级表即契约映射表；WP3 集成时以真实后端重跑同一断言集 |
| 全字段编辑器让用户误以为保存=生效（实际还要 rollout） | 产品语义混乱 | impact 面板明示「保存后会按下面方式滚动」；running-vs-desired 区块显示待应用；保存成功文案说「已保存新版本，正在应用」而非「已生效」 |
| `expected_revision` 被前端误传（用 `applied_revision` 当 expected） | 409 风暴 | 只从 `config_revision` 取；单测锁定来源 |
| mock 里 `nodes_prepare_drain` / `desired_address` 语义比后端弱 | UI 断言过松 | 断言只覆盖 UI 消费的形状与方向，不断言后端才有的精确值；注释标注「以后端为准」 |
| `i18n` 新增 key 漏翻 en | 英文环境见 key 原文 | 新增 key 全部 zh+en 成对写入（单次 patch 同时改两段） |
| 与 WP5 的 `web/src/lib/types.ts` 冲突 | 合并冲突 | 本 PR 只碰 `PortForward` / `ForwardPatchInput` / 新增 Forward*Preview* 类型段；WP5 若改同文件的其他 interface，按行段解冲突（WP5 拥有 Node 相关段，本 PR 拥有 Forward 相关段） |
| `ci.yml` 与并行 WP 的测试列表冲突 | CI 红 | 不改 `ci.yml`；新测试落在既有 glob `src/components/forwards/__tests__/` 内 |

## 7. 给集成代理的契约交接

- **WP3**：本 PR 的 UI 只消费 WP1 的 `impact` 契约。WP3 Orchestrator 落地后，UI **不需要改字段名**；若 WP3 需要在 preview 里追加字段（如 `rollout_plan`），新增字段即可，WP4 已渲染的布尔/数组继续有效。
- **V4-F1 gate**：§13.7 Wave 2 要求 stale `expected_revision` → 409 与「update 失败时旧 applied revision 继续运行」。前者本 PR 提供 UI 闭环（刷新后重新确认）；后者属于 WP3 后端语义，UI 侧只负责展示 apply 失败态与重试入口（已有）。
- **合并顺序**：WP4 只能在 Gate V4-F1 之后 merge 到 main；在此之前以本分支独立存在，`gh pr create` 若因 PAT 403 失败则只给 compare URL。

## 8. 验证与回滚

- 验证：CI 三 job（backend / web / agent）全绿；web job 的 `bun test src/components/forwards/__tests__/` 与 `next build` 通过。
- 回滚：纯前端 + mock 改动，代码回滚即整体回滚，无 DB / 无 migration 影响。

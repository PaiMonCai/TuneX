# V4-WP1 — Forward Revision Foundation 开发报告

- Work package: **V4-WP1 Forward Revision Foundation**（Track A/C，Wave 1）
- Baseline: `main` @ `9a489b5`（docs: align historical v3 sections with active V4 plan）
- Worktree: `/opt/TuneX-v4-wp1`，分支 `feature/v4-wp1-forward-revisions`
- 规范依据: `DEVELOPMENT.md` §13.3（Forward 编辑模型硬约束）、§13.6（WP1 DoD）、§13.7（Wave 1）、§13.9（分支/PR 约定）
- 本报告先于实现提交；实现按本报告的「实现切片」逐 commit。

---

## 1. 范围（Scope）

### 1.1 In scope（WP1 交付）

| # | 交付物 | 说明 |
|---|---|---|
| S1 | **不可变 Revision Snapshot** | 新表 `forward_revision`：`@@unique([tunnel_id, revision])`，行一经写入不可原地修改；至少可恢复 §13.3.2 要求的全部运行态相关配置 |
| S2 | **Tunnel 侧 desired 指针** | `tunnel.desired_revision_id`（可空，无 FK，理由见 §3.2）：指向最新 desired snapshot；`config_revision` / `applied_revision` 维持现状作为 Agent  wire 版本计数器 |
| S3 | **全字段 update contract** | `PATCH /api/forwards/:id` 由「只改 name」扩展为 §13.3.1 全部业务字段（name / mode / ingress_node_id / egress_node_id / listen_port / target_host / target_port） |
| S4 | **`expected_revision` 乐观并发** | 入参 `expected_revision: number`；不匹配 → `409 revision_conflict` + `data.latest_revision`，不落任何库 |
| S5 | **preview / validation 单一实现** | `POST /api/forwards/:id/preview` 与真实 update 调用同一个纯校验函数；规则只有一份 |
| S6 | **Additive Prisma migration** | 只加新表 + 可空列，不 DROP / 不 MODIFY 旧列；存量行零影响，不需要逆迁移 |
| S7 | **定向测试** | 离线单测（服务层 + 契约）+ 迁移测试（MySQL integration，CI 执行） |

### 1.2 Out of scope（明确不做）

- **WP3 rollout orchestrator**：不实现 VALIDATE→PREPARE→CUTOVER→DRAIN→CLEANUP 五阶段、不做 compensation、不做 Reconciler 恢复逻辑重写。WP1 只把新 desired revision 落库并把 `apply_status` 置为 `pending`，由**现有** reconciler（`runtime-reconcile-sink.ts` + `reconciler.ts` 的 `resend_same_revision` / `fill_missing_runtime`）按新 revision 收敛。
- **WP2 Agent hot reload**：不碰 `agent/`，不改命令信封。
- **WP4 Web UX**：不改 `web/` 页面（仅可能补 mock 契约类型，见 §7.3，默认本次不做）。
- 不改部署配置（`docker-compose*.yaml` / `Caddyfile*`）、不触碰生产 DB/容器、不改限流规则表、不改 `tunnels.ts` deprecated 路由实现（兼容层只透传新入参）。
- 不做 UDP / QUIC / TLS / 多目标 LB 产品化（§13.10）。

### 1.3 WP1 与 §13.3.3「禁止把一次用户编辑拆成多个独立 PATCH」的落地方式

单次 PATCH 的语义固定为：

```
读取当前 desired config（latest revision snapshot）
→ 合并 patch 得到一份完整候选 config
→ 对完整 config 一次性校验（preview 与 update 同一个函数）
→ 生成一个新 revision（不可变）
→ 更新 desired 指针 + 兼容投影列 + config_revision++
→ 一次 rollout 收敛（WP1：交给既有 reconciler；WP3：换成 orchestrator）
```

纯 metadata 修改（当前只有 `name`）**不生成 revision、不 bump `config_revision`、不触发任何 runtime 收敛**——§13.3.2 明文禁止为改名触发无意义的 listener 重建。

---

## 2. 契约（Contract，WP1 冻结）

### 2.1 Revision Snapshot 数据模型

`Forward`（产品对象）= `Tunnel` 行（内部 runtime 记录），**不创建第二张用户业务真相表**（§13.3.2 硬约束）。Revision 只挂 runtime 配置快照：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | Int PK | |
| `tunnel_id` | Int, **FK → tunnel(id) ON DELETE CASCADE** | revision 随 Forward 共存亡；历史流量/审计由 `tunnel_traffic` / `audit_log` 独立承载（§13.3.1） |
| `revision` | Int | 单调递增，与 `tunnel.config_revision` 同值 |
| `name` | VarChar(255) | 保存时的名称（便于回放/对账） |
| `mode` | TunnelMode（复用既有枚举） | `direct` / `relay` |
| `ingress_node_id` / `egress_node_id` | Int? **无 FK** | 快照不可变：节点被删时历史行不得被 `SET NULL` 抹掉（对照 `node_port_lease.tunnel_id` 的无 FK 先例，见 schema model 注释） |
| `listen_ip` | String? | 兼容投影同源 |
| `listen_port` | Int? | `NULL` = 用户请求「自动分配」（与 create contract 同义，见 §2.3） |
| `target_host` / `target_port` | String?/Int? | DIRECT 目标 |
| `egress_pool_id` | Int? **无 FK** | RELAY 出口池；理由同节点列 |
| `egress_port` | Int? | RELAY 节点间内部端口 |
| `targets` | Json? | RELAY 保存时刻的 active EgressTarget 快照（池内目标改动不重建隧道，但 revision 必须能还原目标集） |
| `desired_status` | String(20) | 保存这一刻的期望状态（`suspended` 编辑 = 存 desired 不启 runtime） |
| `created_by_id` | Int? | 保存人（审计上下文，无 FK：用户删除不得改写 runtime 历史） |
| `created_at` | DateTime | |

约束：`@@unique([tunnel_id, revision])` + `@@index([tunnel_id, created_at])`。

### 2.2 `tunnel.desired_revision_id`

- 可空 Int，**不加 FK**。理由：`forward_revision.tunnel_id` 已是 `ON DELETE CASCADE` 指向 tunnel，tunnel 再加一条指向 revision 的 FK 构成循环级联路径；同时「最新 desired 指针」是高频更新列，不应被外键约束拖进删除锁竞争。
- 语义：**权威指向**最新 desired snapshot；读取方应验证 `revision == forward_revision.revision` 且 `tunnel_id` 相同，不匹配时按「退化到 config_revision 推算」处理并在日志标记（绝不 fail-open 到旧配置）。
- 不变式由服务层在同事务内维护（生成 snapshot 与写指针同一个 `db.$transaction`）。

### 2.3 API contract

#### `PATCH /api/forwards/:id`（扩展）

请求体（partial，`.strict()`）：

```ts
{
  name?: string;                    // 1..60，纯 metadata
  mode?: "direct" | "relay";
  ingress_node_id?: number;
  egress_node_id?: number | null;   // direct 必须 null/缺省；relay 必填
  listen_port?: number | null;      // null = 自动分配；缺省 = 不改
  target_host?: string;
  target_port?: number;
  expected_revision?: number;       // 乐观并发（可选）
}
```

- `expected_revision` 与当前 `tunnel.config_revision` 不等 → `409 revision_conflict`，`data.latest_revision = <当前 config_revision>`，**不写库、不落 revision**。
- 校验在**完整候选 config** 上做一次（禁止拆成多次 PATCH 形成临时非法状态）。
- 成功响应：`{ data: ForwardView }`，其中 `config_revision` 为新 revision，`desired_revision_id` 为新 snapshot 主键。
- 纯 name patch：`config_revision` / `desired_revision_id` 不变，无 runtime 收敛。

#### `POST /api/forwards/:id/preview`

同一 body 形状（不需要 `expected_revision`，但接受并不报错）。返回**不写库**：

```ts
{
  current: { revision, mode, ingress_node_id, egress_node_id, listen_port, target_host, target_port, apply_status, desired_status },
  candidate: { ...同形状..., source: "merged" },
  impact: {
    metadata_only: boolean,
    runtime_change: boolean,
    changes_external_address: boolean,     // 外部访问地址是否改变
    listen_port_change: boolean,           // 用户可见端口改变
    listener_replacement: boolean,        // 是否需要重建 listener（端口/入口节点/模式变化）
    ingress_node_change: boolean,
    mode_change: boolean,
    target_change: boolean,                // host/port 热换 upstream
    egress_target_change: boolean,
    nodes_prepare_drain: string[],         // 参与 PREPARE / DRAIN 的 node_id
    binding_required: boolean,             // RELAY 需要新 NodeBinding
    port_status: "ok" | "auto" | "taken" | "out_of_range",
    desired_address: string | null,        // 预测的 ingress_ip:port
  },
  validation: { ok: boolean; errors: string[]; warnings: string[]; reasons: string[] },
}
```

- `preview` 与 `update` 共用同一个 `validateForwardCandidate()`；preview 只多做「不落库」。
- 错误码集合稳定：`invalid_input` / `not_found` / `revision_conflict` / `binding_required` / `port_conflict` / `conflict`。

#### 兼容层（不改行为，只透传）

`/api/nodes/:ingressId/forwards` 的 deprecated 路由继续调同一 service；**PATCH 兼容路由不存在**（旧节点作用域 API 没有 PATCH 端点，见 `routes/nodes.ts`），因此无需改它。

### 2.4 并发与幂等

- `expected_revision` 是**闸门**不是锁：409 后由用户刷新重试。
- revision 号生成：`max(config_revision, 已有 snapshot 最大 revision) + 1`，在事务内完成；两次并发 PATCH 至少一个因 `@@unique([tunnel_id, revision])` 撞 P2002 → 统一转 `409 revision_conflict` 并提示最新 revision（不会产生重复 revision，也不会静默覆写）。
- 无 snapshot 可合并时（存量行）：以当前 tunnel 投影列合成 revision 1 的「基线 snapshot」再 +1（见 §3.3）。

---

## 3. 与并行 WP5 的共享 schema 合并策略

WP5（Node Lifecycle Foundation）同 Wave、同改 `backend/prisma/schema.prisma`，但两边的**表级改动不相交**：

| | WP1 | WP5 |
|---|---|---|
| 新表 | `forward_revision` | 无新表 / 或 lifecycle 相关新表 |
| `ALTER TABLE` | `tunnel`（+2 可空列） | `node`（+ 可空 lifecycle 列） |
| 新枚举 | 无（复用 `TunnelMode`） | `NodeLifecycle`（新枚举） |
| 受影响路由 | `routes/forwards.ts`、`services/forward-service.ts` | `routes/nodes.ts`/`node-admin.ts` |

合并规则（写进本报告，供集成代理执行）：

1. **各自独立 migration 目录**，命名遵循时间戳约定，WP1 使用 `20260927xxxxxx_v4_wp1_forward_revisions`（合并时若与 WP5 撞序，按目录名时间序重排即可，内容无耦合）。
2. **schema.prisma 冲突逐块解**：WP1 的块只出现在 `model Tunnel`（增量字段区 + 新 `forward_revision` model）；WP5 的块只出现在 `model Node` + 新枚举。两块不相邻 → 保留双方。
3. **不共用 `config-generator` / Node 生命周期文件**；WP5 的生命周期文件（`node-state.ts`、`node-admin.ts`、`routes/nodes.ts`）本次完全不碰。
4. **若 schema 合并后出现语义耦合**（例如 WP5 的 lifecycle 判定需要 revision 信息，或 WP1 的 runtime admission 需要 lifecycle），**不在任一分支内自行扩张**：WP1 完成后交由后续集成代理处理，禁止跨分支改对方文件。
5. 双方都遵守 expand-and-contract：新列可空、新表纯新增，因此**无论合并顺序如何，migrate deploy 都不会失败**（无 MODIFY/DROP）。

---

## 4. 实现切片（每片一个 commit）

| Commit | 内容 | 边界 |
|---|---|---|
| C1 | `reports/v4-wp1-plan.md`（本报告） | 仅文档 |
| C2 | Prisma additive migration + `schema.prisma`（`forward_revision` 表、`tunnel.desired_revision_id`） | 仅 `backend/prisma/**` |
| C3 | `services/forward-revision.ts`：revision snapshot 读写 + 单次校验/合并 + preview 计算（纯函数 + 可注入 db） + 离线单测 `__tests__/forward-revision.test.ts` | 新增文件 + 新增测试；不改既有文件 |
| C4 | `services/forward-service.ts`：`patchForward` 走共享校验路径，新增 `updateForward` / `previewForwardUpdate`；`forwardView` 暴露 `desired_revision_id` / `latest_revision` | 只改 forward-service.ts |
| C5 | `routes/forwards.ts`：`ForwardPatchSchema` 全字段 + `expected_revision` + `POST /:id/preview` 端点；错误码透传 | 只改 forwards.ts |
| C6 | 迁移测试 `tests/forward-revision-migration.test.mjs`（CI 的 MySQL backend job 执行） | 仅 `backend/tests/**` |

`test:unit` 是目录 glob（`bun test src/services/__tests__/ src/__tests__/`），C3 的测试文件**自动进入 CI**，无需改 `ci.yml`；`tests/*.test.mjs` 同理自动进入 `bun run test`。**本次不改 `.github/workflows/ci.yml`**，避免与并行 WP 的测试列表冲突（skill 记录的高频冲突点）。

---

## 5. 测试计划

| 层 | 用例 | 执行者 |
|---|---|---|
| 离线单测 | ① 合并后完整 config 才校验（partial patch 不会造出半配置）；② `expected_revision` 过期 → 409 + latest_revision；③ 同一 `(tunnel_id, revision)` 唯一（P2002 → 409，不覆写）；④ rename 不 bump revision / 不收敛 runtime；⑤ suspended 编辑只落 desired，`desired_status` 保持 inactive；⑥ RELAY 缺 binding 阻断；⑦ 端口占用/越界/黑名单；⑧ direct↔relay 切换的字段互斥（egress_node_id 必须 null / 必填）；⑨ preview 与 update 走同一函数（断言 preview 的 errors 与 update 拒绝原因逐条一致）；⑩ snapshot 字段完整性（§13.3.2 要求逐项在快照里） | CI (`bun run test:unit`) |
| 迁移测试 | ① 空库 apply 全量迁移成功，`forward_revision` 存在且 `@@unique([tunnel_id, revision])` 生效；② 存量 tunnel 行 `desired_revision_id = NULL` 且业务行为不变（与 WP2 fixture 同口径）；③ 重复 `migrate deploy` 幂等（prisma 已应用记录，no-op） | CI (`bun run test`，TUNEX_DB_TEST=1，MySQL service) |
| 既有回归 | `src/services/__tests__/*`、`web` mock 契约测试 | CI |

本地只跑**单文件** `bun test src/services/__tests__/forward-revision.test.ts`（skill：小内存机器不跑 tsc / build / 多文件 bun test）。typecheck 与 build 全交 CI。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `config_revision` 被 suspend 等运行动作 bump（`tunnel-api.ts`）导致「config revision」与「快照 revision」不同步 | desired 指针指向不存在的 revision | 指针与 revision 在同一事务写入；读取方发现不匹配按基线 snapshot 推算并在日志标记；suspend 不产生 snapshot（纯运行态动作） |
| `forward_revision` 无 FK 的节点/池列变成悬空引用 | WP3 恢复时拿到已删节点 | 快照语义即「历史不可变」；WP3 恢复前必须校验节点存在性（本报告为 WP3 预留该契约，WP1 不实现） |
| 合并 WP5 后 `migrate deploy` 顺序 | — | expand-and-contract 保证无 MODIFY/DROP，顺序无关 |
| 与 WP2/WP3 的 revision 语义误解（WP2 要幂等 revision，WP3 要五阶段） | 返工 | 本报告 §2 冻结「WP1 只落 desired + 由既有 reconciler 收敛」，WP3  Orchestrator 落地时替换该收敛出口，schema/契约不变 |
| 全字段 PATCH 让旧前端误发部分字段 | 临时非法态 | 校验总在完整合并 config 上做；preview 与 update 同源；`expected_revision` 防脏写 |
| secret-scan | CI 红 | 报告/测试不含真实口令；测试内 URL 一律变量拼装 |

---

## 7. 后续契约（给 WP2 / WP3 / WP4）

- **WP2**：读 `forward_revision` 还原 runtime 配置；`expected_revision`/revision 单调性是 Agent 幂等 apply 的闸门，不得放宽。
- **WP3**：用本表的 snapshot 做 CUTOVER 前后的对比与 compensation（回退到 `applied_revision` 对应的 snapshot）；`impact` 字段（`listener_replacement` / `nodes_prepare_drain` / `target_change`）即五阶段的计划输入。
- **WP4**：详情页用 `preview` 展示影响；保存时带 `expected_revision`；`revision_conflict` 的下一步 = 刷新后重新确认。
- **集成代理**：WP1 与 WP5 的 schema 合并见 §3；若需跨 WP 扩张，单独开分支，禁止在双方分支内互相改文件。

---

## 8. 验证与回滚

- 验证：CI 三 job（backend / web / agent）全绿；backend job 的 `prisma migrate deploy` + integration 步骤通过。
- 回滚：代码回滚即整体回滚（expand-and-contract，**不需要 DB downgrade**）；新表/新列保留无害（§6 既有策略）。

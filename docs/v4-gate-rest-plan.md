# V4-F1 Gate — 剩余场景实施计划（rest 切片）

分支：`feature/v4-gate-forward-rollout-rest`（worktree `/opt/TuneX-v4-gate-rest`，基于 `origin/feature/v4-gate-forward-rollout-e2e` @ `c441069`）

并发约束：与本分支同仓的 `feature/v4-gate-forward-rollout-e2e` 由另一代理独占，前两个场景
（target 热改、stale 409）在那里交付。**本切片只新增独立文件**，不改
`integration.yml` / `setup.sh` / `_bootstrap.py` / `v4-gate.sh` / 后端 / main / WP4 / WP5。

## 1. 目标（DEVELOPMENT.md §13.7 Gate V4-F1 十条）

| # | 场景 | 责任 | 状态 |
| --- | --- | --- | --- |
| S1 | target host/port 热修改 | e2e 分支（另一代理） | 已交付（切片 1） |
| S2 | stale `expected_revision` 409 | e2e 分支（另一代理） | 已交付（切片 1） |
| S3 | **listen port 修改** | **本切片** | 真实 API/DB/Agent/数据面断言 |
| S4 | **multi-field single revision** | **本切片** | 真实 API/DB 断言 |
| S5 | **update 失败时旧 applied revision 继续运行** | **本切片** | 真实 API/DB/数据面断言 |
| S6 | **suspended edit + resume 最新 revision** | **本切片** | 真实 API/DB/数据面断言 |
| S7 | RELAY 换 Egress | 待下一步 | 需第二台 egress Agent |
| S8 | DIRECT ↔ RELAY | 待下一步 | 需 mode 切换 + egress 拓扑 |
| S9 | Ingress migration | 待下一步 | 需第二台 ingress Agent + 数据网 |
| S10 | Backend/Agent 重启后 rollout/reconcile 恢复 | 待下一步 | 需重启编排能力 |

## 2. 可交付物

- `scripts/v3-e2e/v4-gate-rest.sh` — S3/S4/S5/S6 的真实断言脚本（HTTP + MySQL + 真实 TCP 探测）
- `docs/v4-gate-rest-report.md` — 实施报告（断言表、实跑结论、拓扑缺口）

## 3. 每个场景的服务端支撑点（已勘察确认）

### S3 listen port 修改（§13.3.4「Listen Port」行）
- 入口：`PATCH /api/forwards/:id` 带 `listen_port`（`ForwardPatchSchema` 允许）。
- 差异判定：`computeForwardImpact` 置 `listen_port_change=true` +
  `listener_replacement=true`（`forward-revision.ts:504`）。
- 计划：`planRollout` → `strategy=listener_replace`，步骤为
  `validate → acquire_port(prepare, new port) → cutover_ingress(listener_replaced) →
  drain_ingress(old port) → release_old_lease(old port)`（`forward-rollout.ts:484-598`）。
- Agent 侧：`apply_tunnel` → `ReplaceListener` → `PlanForwardSwap` 判
  `SwapListener`（`agent/internal/manager/swap.go:110`）→ `replaceListenerLocked`
  **先 bind 新端口、后 drain 旧实例**（`swap.go:324`）。
- 断言维度：新端口真实可达且 marker 正确；旧端口不可再建连；DB `tunnel.listen_port`
  切到新端口；`node_port_lease` 旧行 released + 新行 active；rollout `done|listener_replace`。

### S4 multi-field single revision（§13.3.4「多字段同时改」行）
- 一次 PATCH 同时改 `target_host` + `target_port` + `listen_port` + `name`。
- `resolveForwardCandidate` 合并成**一份**完整候选 config → 一次 `createForwardRevision`。
- 断言维度：`forward_revision` 恰好新增 **1 行**（不是 4 行）；该行 snapshot 的
  target_host/target_port/listen_port/name 全部为新值；`forward_rollout` 只有 1 行
  且 revision 唯一；无中间半配置状态（数据面从旧 target 直接到新 target+新端口，
  期间不出现「新端口 + 老 target」这种组合）。

### S5 update 失败时旧 applied revision 继续运行（§13.3.5 第一条/第三条失败规则）
真实失败注入点（无 mock、无人工改库）：
- **端口冲突（PREPARE 阶段 `acquire_port` 失败）**：用**真实存在的第三方占用者**把目标
  端口变成 `port_taken`。占用者不是 mock——同工作区另一条真实 Forward 已经 ACK 过的端口，
  由 `portPool.acquirePort` 的 `reserved.has(port) → port_taken` 拒绝（`portPool.ts:532`）。
- 也可命中 VALIDATE 前的 `port_conflict`（`forward-service.ts:529` / `forward-revision.ts:427`），
  那是更早的短路；两种都是「旧 runtime 继续」的有效证据。
- 断言维度：PATCH 返回 4xx/409 且带机器可读码；`tunnel.applied_revision` 不变、
  `config_revision` 不前进（或被拒绝前未写入）；数据面仍返回旧 target marker；
  `forward_rollout` 对失败 revision 无 `done` 行；随后正确 PATCH 能成功（证明不是死锁）。

### S6 suspended edit + resume 最新 revision（§13.3.6）
- `POST /api/forwards/:id/suspend` → `runTunnelAction('suspend')`：
  落 `desired_status=inactive` + `apply_status=suspended`，`config_revision = +1`，
  并向 Agent `remove_tunnel`（`tunnel-api.ts:824-876`）。
- suspended 期间 `PATCH`：`resolveForwardCandidate` 给 `desiredStatus='inactive'`，
  `patchForward` 以 `suspended=true` 调 `registerRollout` ⇒ **noop rollout**，
  只存 desired revision，不启 runtime（`forward-service.ts:672-686`）。
- 可连续多次编辑，每次生成新 revision（证明不是依次 replay 中间态）。
- `POST /api/forwards/:id/resume` → `runTunnelAction('resume')`：desired 推回
  `active`，走 `deps.applyDirect` 重下发。
- 断言维度：suspend 后数据面不可达；suspended 期间每次 PATCH 都 200 且
  `forward_revision` +1 行、`applied_revision` 不动；resume 后数据面返回
  **最后一次**编辑的目标 marker（不是中间某次），`applied_revision == config_revision`。

## 4. 断言脚本设计原则（与 v4-gate.sh 同源）

- 复用 `scripts/v3-e2e/state.json` + `fixtures/forward-edit.json`，不新建拓扑。
- 同一套 `ok/bad/assert_eq/assert_ne/assert_contains` 断言原语。
- 每条断言都带编号（S3.1 / S4.2 …），失败时打印实得 vs 期望。
- `mysqlc` / `probe` / `wait_probe` 复用 v4-gate.sh 的实现（真实 MySQL / 真实 TCP）。
- 退出码非 0 即失败，evidence 落 `scripts/v3-e2e/evidence/v4-gate-rest-result.txt`。

## 5. 拓扑需求（其余场景 S7–S10，详见实施报告）

| 场景 | 需要而当前 harness 没有的东西 |
| --- | --- |
| S7 RELAY 换 Egress | 第二台 EGRESS Agent（独立 node_id/credential）+ 可切换的 egress pool |
| S8 DIRECT ↔ RELAY | 同上，另需 `createForward` 的 mode 字段在 e2e 路径可用 |
| S9 Ingress migration | 第二台 INGRESS Agent + 独立 ingress data 网 + 第二个 client 视角 |
| S10 重启恢复 | 可对 panel/worker/agent 容器做受控重启并保留 DB volume |

本切片不改 `docker-compose.e2e.yaml`、`setup.sh`、`_bootstrap.py`，因此 S7–S10 只记录
需求，不在本分支强跑。

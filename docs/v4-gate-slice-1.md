# V4 Forward Rollout 真实 E2E Gate — 切片 1 实施报告

分支：`feature/v4-gate-forward-rollout-e2e`（worktree `/opt/TuneX-v4-gate`，基于 `main` @ `ae400ee`）

## 目标

DEVELOPMENT.md §13.7 / V4-F1 Gate 的前两个**真实**场景（HTTP / DB / Agent 数据面，不用 mock）：

| # | 场景 | 真实性要求 |
| --- | --- | --- |
| S1 | Forward PATCH target host/port 热改 | 真实 HTTP PATCH → rollout 五阶段 → 真实 MySQL 记账（`forward_rollout` / `forward_revision` / `node_port_lease`）→ 真实 Agent ACK → 真实 TCP 数据面切换 |
| S2 | stale `expected_revision` 409 | 真实 HTTP 连续 PATCH，第二次带过期 revision 必须被 409 拒绝，且 DB 记 revision 不被改写 |

## 复用的既有资产

- `scripts/v3-e2e/docker-compose.e2e.yaml`：隔离 MySQL / Redis / Panel / Worker / Ingress Agent / Egress Agent / target-a / target-b / client，三网分离（`wp14-ctrl` + 两个 internal data 网）。**不改动该文件。**
- `.github/workflows/integration.yml`：`pull_request` 触发，`v3-integration` job 执行 `setup.sh → verify.sh → teardown.sh`。**不改动触发条件**（Integration 对 PR 是 `pull_request` 事件），只扩 `verify.sh` 的断言集。

## 与 v3 Gate 的差异点

v3 的 T0–T8 覆盖 DIRECT/RELAY 创建、suspend/resume、Agent 重启恢复、凭据与租户隔离。V4 Gate 复用同一套拓扑，把入口换成 **V4 Forward API**：

- 隧道的创建走 `POST /api/nodes/:id/forwards`（`forward-service.createForward`）；
- 编辑走 `PATCH /api/forwards/:id`（`forward-service.patchForward`），这是 WP1/WP3 的 rollout 入口；
- 断言同时看 HTTP 状态码、HTTP 业务码、MySQL 记账行、以及 **真实 TCP 探测到的 target marker**。

## 新增内容（本切片）

- `scripts/v3-e2e/v4-gate.sh`：新增 V4 断言脚本，结构化输出 `V4-S1/S2 …`，退出码非 0 即失败。
- `fixtures/forward-edit.json`：V4 场景的目标地址（hot-swap 前后）。
- `.github/workflows/integration.yml`：`v3-integration` job 中 `verify.sh` 之后追加 `bash scripts/v3-e2e/v4-gate.sh`，失败即阻断 Integration；evidence 目录加入 V4 结果与原始 JSON。
- `scripts/v3-e2e/README.md`：记录 V4 Gate 的边界与断言表。

## 场景 S1 断言（至少）

1. `PATCH /api/forwards/{direct}` 带 `target_host/target_port` 热改 → HTTP 200；
2. 同一次编辑不产生 `listener_replace`：DB 中 `node_port_lease` 仍是原端口单条 active，`tunnel.listen_port` 不变；
3. `forward_rollout` 出现 `phase=done`、`strategy=target_hot_swap` 的一行，`revision` = 返回的 `config_revision`；
4. `forward_revision` 新增 snapshot 的 revision 单调 +1；
5. **真实数据面**：client → ingress:port 现在返回的是**新 target** 的 marker，旧 target marker 不再出现；
6. `applied_revision` 收敛到 `config_revision`（Agent 真实 ACK 生效）。

## 场景 S2 断言（至少）

1. 第一次 `PATCH` 带正确 `expected_revision` → 200；
2. 第二次 `PATCH` 带**过期** `expected_revision` → HTTP 409 + `code=revision_conflict` + `data.latest_revision` 为当前值；
3. 409 之后 config_revision / snapshot 行数不变、`applied_revision` 不动、真实数据面行为不变（仍走第一次的目标）；
4. 带上最新 `expected_revision` 的第三次 PATCH → 200（证明 409 是乐观锁而非死锁）。

## 明确不覆盖（如实记录）

- WP4/WP5 相关（Web 编辑页、Node 生命周期）不并入本分支，场景仅到 HTTP API 层。
- listen_port / ingress node / mode 切换、RELAY 换出口节点等较重 rollout 类别未在首个切片覆盖，后续切片按 §13.3.4 分类表逐行补齐。
- 补偿/断点续跑的失败注入真实 E2E 未覆盖（WP3 单测已覆盖）。

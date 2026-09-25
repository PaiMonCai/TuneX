# TuneX v3 Real Integration Gate（WP14）

这个目录是 TuneX 当前 **WP14 真实网络发布 Gate**。它不是只搭拓扑的历史 harness：
`.github/workflows/integration.yml` 会在 PR 和 main CI 之后实际执行
`setup.sh → verify.sh → teardown.sh`，失败会阻断 Integration。

WP14 已完成。当前 main 的 DIRECT / RELAY 都使用 v3 runtime，WP15 也已经删除
legacy DIRECT engine。

---

## 1. Gate 验证什么

Integration 会启动真实容器：

```text
Backend / Worker
        ▲
        │ Agent → Panel outbound HTTP poll / ACK / desired / state
        │
Ingress Agent ──────────────┐
        │                    │
        │ DIRECT             │ RELAY
        ▼                    ▼
    Target A          Egress Agent → Target B

Client → Ingress Agent
```

控制面与数据面刻意分网：

- Panel / Worker / Agent 控制请求使用 `wp14-ctrl`。
- Panel **不接** `wp14-ingress-data` / `wp14-egress-data`。
- 两个 Agent 都不映射 host 管理端口，`--agent-admin-port=0`。
- Agent 主动访问 `http://panel:3000` 轮询命令、ACK、上报状态和拉取 desired snapshot。
- Ingress/Egress 的数据监听端口只存在于数据网或测试入口，不依赖 Panel 反连 Agent。

因此这个拓扑验证的是生产约束：**Agent 只需要主动连接 Panel，Panel 不需要访问 Agent 公网管理端口。**

---

## 2. 当前自动断言（T0–T8）

`verify.sh` 直接观察容器、数据库、HTTP API 和 TCP 数据面；任意断言失败都会以非零退出码结束。

| Gate | 验证内容 |
| --- | --- |
| T0 | Backend、Worker、双 Agent、双 Target、Client 全部运行且 Panel healthy |
| T1 | Agent 无 host 管理端口；Panel 不接数据网；数据网保持 internal |
| T2 | DIRECT / RELAY concrete ingress/egress binding、revision ACK、NodePortLease 完整且无双 owner |
| T3 | 真实 TCP DIRECT 和 RELAY 转发成功，Target A/B 不串台 |
| T4 | DIRECT suspend / resume，原监听端口与 durable lease 保持 |
| T5 | Ingress/Egress Agent 重启后从 desired snapshot 恢复 DIRECT / RELAY |
| T6 | per-node credential 鉴权；Ingress credential 看不到 Egress runtime |
| T7 | Workspace / NodeGroup 跨租户访问被拒 |
| T8 | 生产 Worker 实际调度 `cron_reconcile_v3` |

Integration workflow 还会额外验证：

1. Agent Docker image 能构建并启动；
2. unified TuneX image 能构建；
3. Backend/Web runtime 文件完整；
4. `docker-compose.prod.yaml` 与开发 Compose wiring 可解析。

main 上 Integration 成功后，Release workflow 才发布镜像。

---

## 3. 使用

本地需要 Docker Compose v2 和 Python 3。

```bash
bash scripts/v3-e2e/setup.sh
bash scripts/v3-e2e/verify.sh
bash scripts/v3-e2e/teardown.sh
```

`setup.sh` 会：

1. 准备 MySQL / Redis / Backend / Worker；
2. 通过真实 HTTP API 创建 Workspace、NodeGroup、Node 和一次性 credential；
3. 启动 Ingress / Egress Agent，使其通过 outbound HTTP 控制链连接 Panel；
4. 再通过真实 API 创建 DIRECT / RELAY；
5. 等待真实 Agent ACK，而不是直接写业务表或伪造 active 状态。

运行期状态和证据位于：

```text
scripts/v3-e2e/.env.wp14
scripts/v3-e2e/.passwords.env
scripts/v3-e2e/state.json
scripts/v3-e2e/evidence/
```

这些文件均不应提交到 Git。

---

## 4. 关键端口与网络

默认 host 只暴露：

| 端点 | 默认 host 端口 | 说明 |
| --- | ---: | --- |
| Panel HTTP | 18180 | bootstrap / 用户 API / Agent outbound control 的测试入口 |
| DIRECT 测试入口 | 18201 | Client → Ingress → Target A |
| RELAY 测试入口 | 18202 | Client → Ingress → Egress → Target B |

Egress runtime 端口（默认测试范围 22000–22099）不映射到 host。

Compose 网络：

- `wp14-ctrl`：Panel、Worker、Ingress Agent、Egress Agent 的控制网；
- `wp14-ingress-data`：Client / Ingress / Targets 的入口数据网；
- `wp14-egress-data`：Ingress / Egress / Targets 的中继数据网。

Panel 只接控制网，从网络结构上无法直接访问 Agent 数据监听地址。

---

## 5. 文件

| 文件 | 作用 |
| --- | --- |
| `docker-compose.e2e.yaml` | 真实控制面 + 双 Agent + 双 Target 网络拓扑 |
| `setup.sh` | 构建/启动环境、provision Node、启动 Agent、创建 live Forward |
| `verify.sh` | 当前正式 T0–T8 Gate |
| `teardown.sh` | 销毁 wp14-e2e 自己的容器、网络、卷和可选镜像 |
| `_bootstrap.py` | 只通过真实 HTTP API provision 测试对象 |
| `fixtures/` | 静态测试输入 |
| `backend/tests/v3-e2e/` | 可复用 E2E harness 与 DIRECT/RELAY 断言代码 |

CI 的正式发布 Gate 以 `scripts/v3-e2e/verify.sh` 为准；`backend/tests/v3-e2e/*.mjs`
保留为可复用的更细粒度测试工具，不是另一套发布真相源。

---

## 6. WP14 与后续能力的边界

早期 WP14 文档曾把 weighted target、hot update、change Egress、backup/restore 等
全部列为同一个 Gate。项目实现后已经重新收敛边界：

- **WP14**：验证当前默认公开的 TCP DIRECT/RELAY、outbound-only 控制、恢复、权限、
  lease 和 Reconciler 能作为一个整体真实运行。
- **WP15**：删除 legacy DIRECT engine，让 DIRECT/RELAY 统一到 v3 runtime；已完成。
- **高级数据面能力**（advanced LB、UDP、WS/TLS、QUIC、HA、failover、multi-hop）：
  进入 WP16+，各自增加 contract + tests + real E2E。
- **backup/restore/rollback**：由 `scripts/ops/` 和生产部署演练负责，不和网络数据面
  Gate 混成一个无法定位责任的测试包。

不要通过放宽 `verify.sh`、把失败改成 skip、或直接写数据库状态来“修绿” Integration。
Gate 的意义就是证明真实控制链和真实 TCP 链路仍然成立。

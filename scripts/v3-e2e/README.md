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

---

## 7. V5-G5：两面板真拓扑联邦门禁（WP14 / WP15 / WP16）

`DEVELOPMENT.md` §10.3 的 Gate 必须跑在**两个真实 Panel + 各自真实 Agent** 上，因此它比
上面 T0–T8 多一个前置：**Panel B**。

### 7.1 环境要求（与本机跑 `verify.sh` 不同）

G5 必须在**容器里**执行，不能在宿主机上跑：

- 本容器**访问不到宿主机发布的端口**（`http://127.0.0.1:18180/healthz` 不可达）；
  面板之间靠**容器名 / 网络别名**互通（`http://panel:3000`、`http://panel-b:3000`）。
- 因此需要一个已挂在 `wp14_ctrl` 网络、且挂了 docker socket + docker CLI 的 runner
  容器（本项目里是 `tunex-e2e`，仓库在 `/repo`，镜像里有 `python3`）。
- 需要 `docker`、`python3`、`openssl`、`curl`；`wp14-backend:ci` / `wp14-agent:ci` 两个
  镜像由 `setup.sh` / `bootstrap-federation.py` 负责构建。

### 7.2 跑法

```bash
# 1) Panel A（既有拓扑）：如果还没起，先 bash scripts/v3-e2e/setup.sh
# 2) 把仓库同步进 runner 容器（必须用 tar：容器里挂的 /workspace/TuneX 是宿主机路径）
tar -C /workspace/TuneX --exclude=node_modules --exclude=.git --exclude='Forwardx*' \
    -cf - . | docker exec -i tunex-e2e tar -C /repo -xf -

# 3) 面板代码刷新：backend 改了就必须重建镜像，否则你验的是旧快照
docker exec tunex-e2e sh -c '
  cd /repo && docker build -t wp14-backend:ci /repo/backend
  export WP14_AGENT_IMAGE=wp14-agent:ci TUNEX_BACKEND_IMAGE=wp14-backend:ci
  export WP14_INGRESS_CREDENTIAL=UNPROVISIONED WP14_EGRESS_CREDENTIAL=UNPROVISIONED
  export WP14_INGRESS_AGENT_ID=UNPROVISIONED WP14_EGRESS_AGENT_ID=UNPROVISIONED
  export WP14_INGRESS_B_CREDENTIAL=UNPROVISIONED WP14_EGRESS_B_CREDENTIAL=UNPROVISIONED
  export WP14_INGRESS_B_AGENT_ID=UNPROVISIONED WP14_EGRESS_B_AGENT_ID=UNPROVISIONED
  docker compose -f scripts/v3-e2e/docker-compose.e2e.yaml \
    --env-file scripts/v3-e2e/.env.wp14 up -d --force-recreate panel worker'
# 3b) **Panel A 也要跑迁移**：新迁移不会因为 recreate panel 而自动 apply
docker exec tunex-e2e sh -c '
  cd /repo && docker compose -f scripts/v3-e2e/docker-compose.e2e.yaml \
    --env-file scripts/v3-e2e/.env.wp14 run --rm db-migrate'

# 4) 引导 Panel B + 建立双向信任（幂等；会自己重建 B 的镜像/容器，并跑 tunex_b 的迁移）
docker exec -e API=http://panel:3000 tunex-e2e bash -lc \
    'cd /repo && python3 scripts/v3-e2e/bootstrap-federation.py'

# 5) 跑 Gate
docker exec -e API=http://panel:3000 tunex-e2e bash -lc \
    'cd /repo && python3 scripts/v3-e2e/v5-g5.py'
```

> 第 3 步不能省：Gate 验的是**当前 checkout 的行为**。用几十分钟前的镜像跑出来的绿灯
> 会让人相信一条从未被验证过的链路（本项目已经踩过一次）。

证据落在 `scripts/v3-e2e/evidence/v5-g5-result.txt`，末行是
`V5-G5 TOTAL PASS=n FAIL=m`。FAIL > 0 意味着 V5.5 未收口。

### 7.3 `bootstrap-federation.py` 会建什么（以及不会碰什么）

建（容器名固定，全部可重复执行）：

| 对象 | 说明 |
| --- | --- |
| 数据库 `tunex_b` | Panel B 的**独立**库（迁移 + 按需 seed） |
| Redis `redis://redis:6379/2` | 独立 db index，避免和 A 抢锁 |
| `wp14-panel-b` | image `wp14-backend:ci`，`--network wp14_ctrl`，别名 `panel-b` |
| `wp14-worker-b` | B 的 worker；**没有它，"租约到期 host 主动停服"永远不会发生**（联邦 reconcile 挂在 `cron_reconcile_v3`，everyMs=30s） |
| `wp14-agent-b1` | image `wp14-agent:ci`，指向 `http://panel-b:3000`，接 `wp14_ctrl` + `wp14_egress_data`（默认 `172.31.20.41`） |
| B 的管理员 / workspace / NodeGroup / Node | 全部走**真实 HTTP API**（注册、`/api/node-groups`、`/api/node-groups/:id/nodes`、`/api/internal/node/enroll`） |
| 双向信任 | 一次性邀请 token + `POST /api/federation/v1/handshake` |

不碰：`wp14-panel` / `wp14-worker` / `wp14-mysql` / `wp14-redis` / 四个既有 Agent /
`wp14-target-*` / `wp14-client`，以及数据库 `tunex`（唯一的例外是把 A 的 e2e 用户提为
`super_admin`，与 `v5-g1a.py` / `v5-g4.py` 的 setup 同口径）。

幂等：面板/worker 容器按镜像 ID 复用（镜像变了才重建），Node 行已存在就**不再**调
provision（该 API 对已存在节点带 `targets` 会返回 `runtimeEdit` 冲突，这是产品有意的保护），
Agent 容器存在就直接复用（凭据从容器自己的 `Cmd` 读回），已互相信任就跳过握手。
默认每次都从当前 checkout 重建 backend 镜像；调试时可 `FED_SKIP_BUILD=1` 跳过。

### 7.4 署名请求从哪来

跨面板请求必须带 Ed25519 签名，门禁不自己实现密码学：用仓库里的
`scripts/v3-e2e/fed-sign.ts`（在**要发请求的那一侧面板容器**里跑，因为它要读那个面板的
DB 与 `AUTH_SECRET`），拿到「URL + 签名头 + body」之后由 Gate 负责发送。这样
duplicate / reorder / clock-skew 场景可以精确指定 `message_id` 与 body。

### 7.5 会被 G5 停掉/启回的容器

`Panel B offline`、`Panel A offline`、`network partition` 三条场景**必须**停/启真实容器
才能验 fail-closed：Gate 会停 `wp14-panel-b` 与（短暂地）`wp14-panel`，并在 `finally` 里
无条件启回来；`wp14-mysql` / `wp14-redis` / Agent / Target 不会被停。若中途被中断，请手动
`docker start wp14-panel wp14-panel-b`。

### 7.6 第二轮新增：Forward 级（home 侧账本）场景

第一轮 G5.5/G5.12 曾报过「`federation_placement` 恒为 0 行」。那不是 bug 位置报错了，而是
**报错的位置不对**：home 侧账本的写入者是**本机 rollout**，直连 M2M 调用（`POST /leases`）
按设计**不会**写它。所以第二轮把它拆成两层，各自断言各自的：

| 场景 | 验什么 |
| --- | --- |
| G5.1…G5.13（M2M 级） | 协议语义：幂等、epoch、容量、撤销、审计、用量。**不**声称 home 账本 |
| **G5.16** | A 上建一条 `mode=relay` + `federated_egress_peer=<B>` 的 Forward：placement 行出现、`desired_revision` 跟随 `config_revision`、B 侧 lease `active` + 节点上报里有 `tunex-fed-<lease_ref>-egress` 真实 runtime、**经 A 的入口端口在数据面上真的到达远端 target**；停 B → placement `degraded`（可解释错误码）且**不回落本地**（`egress_node_id=0`、本机没有出口 runtime）；恢复 B → 按 `(intent_id, revision)` 收敛、数据面恢复 |
| **G5.17** | 删除该 Forward → 远端租约释放、端口归还、远端 runtime 从节点上报里消失（无孤儿） |
| **G5.18** | 让该远端腿的 grant 只有 60s：到期后 host 停服 + **home 侧 placement 跟到终态**（不再是永远 active 的幽灵账本） |
| **G5.19** | 租约在**停机窗口内**过期（>TTL）之后的诚实性：远端腿已 expired、数据面不通时，Forward **不得**继续声称 `apply_status=active` |

> 分工说明：G5.16 的停机窗口必须**短于**远端租约 TTL（`DEFAULT_LEASE_TTL_SECONDS=300`），
> 它验的是"短分区 → 恢复 → 对账收敛 + 数据面回来"；"租约在对面不可达时到期"是另一件事，
> 由 G5.19 单独验。把两者混在一个场景里会把两种世界读成同一条断言。

**运维约束（会咬人，先记住）**：本机 rollout 委托远端出口时**不带 `grant_ref`**（home 不该
"记得"额度），host 侧按"该 peer 上**唯一一条**覆盖该 hop_role 的 active grant"解析。
因此 `federated_egress_peer` 生效的前提是：那个 peer 上**只有一条** active 的 egress grant。
多于一条时 host 会 fail-closed 拒绝（`grant_scope_violation`，要求显式指定），表现是
"Forward 建得出来但远端腿建不上"。G5 的场景会先把其它 active grant 撤掉再建 Forward。

数据面探测由 `wp14-client`（ingress 数据网内）发起 —— Gate 自己跑在 ctrl 网上，而
`wp14_ingress_data` 是 `internal` 网络，从外面够不到。

清理：Gate 每轮会删掉自己建的 Federated Forward（走产品自己的释放路径）、清掉它的
placement 行，并把两侧 revoked/pending 的 peer 行清掉后重跑 bootstrap 恢复信任，
所以可以反复执行。

> **同步时别把证据覆盖掉**：`evidence/` 是**容器内**的产物。用 tar 同步整个仓库时建议加
> `--exclude='scripts/v3-e2e/evidence'`，否则宿主机上那份旧结果会把容器里刚跑出来的
> 新结果冲掉（这个坑真的踩过一次）。

证据头部会记录这一轮读数对应**哪一版代码**：镜像 ID + 构建时间 + 两个 panel 容器实际使用的
镜像 digest 与启动时间。容器里没有 `git`，checkout 的 commit 由汇报里给出。

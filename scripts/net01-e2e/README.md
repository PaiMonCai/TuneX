# NET-01 收尾：双租户真实网络 E2E

**状态**：✅ 完成（36/36 项断言通过，可重复）
**日期**：2026-09-25
**分支**：`feature/email-auth`（工作区 `/opt/TuneX-email-auth`）
**范围**：自有 TCP 反向数据通道 + 节点身份验证的**双租户隔离**验收（PLAN.md NET-01 剩余项）

---

## 1. 一句话结论

两个互相隔离的租户（独立 workspace / 独立入口节点组 / 独立 agent 进程 / 独立监听端口 /
独立转发目标）在**真实网络**下：各自只拿到自己的隧道配置、各自只监听自己的端口、跨租户读
/ 建 / token 滥用全部被拒、配置推送严格按节点组 room 单播、数据面转发无串台。

---

## 2. 环境隔离设计（为何不复用 relayx 栈）

本机已有 `relayx` 生产栈（`/opt/relayx`）与 TuneX 栈在跑，双租户测试必须**完全独立**，
否则会污染他人数据、或端口/数据库冲突。因此新建一次性 `net01` 栈，**五个维度物理隔离**：

| 维度 | 隔离手段 | 与既有栈的区分 |
|---|---|---|
| Docker 网络 | 独立 bridge `net01_net` | 不挂 `relayx_default`、`tunex` |
| 容器名 | `net01-mysql` / `net01-redis` / `net01-backend` | 前缀 `net01-`，一眼可辨 |
| 数据卷 | 独立 `net01_mysql_data` / `net01_redis_data` | 名称唯一 |
| 主机端口 | mysql `13310`、redis `13311`、HTTP `8787`、Socket.IO `8788` | relayx 无映射、tunex 用 13307/16379 |
| 密钥 | 全新随机 `TUNEX_CONFIG_KEY` / `TUNEX_LICENSE_KEY` / `AUTH_SECRET` / `LICENSE_SECRET` | 自动生成，落 `.env.net01`（600），不入 git |

`teardown.sh` 可整套销毁，对其它栈零影响。

---

## 3. 测试对象与拓扑

```
                    控制面（Controller）
   ┌──────────────────────────────────────────────────────┐
   │  net01-backend  (Bun + Hono + Socket.IO)              │
   │    HTTP API  :3000 -> host 8787                        │
   │    Socket.IO :3001 -> host 8788   room = node_group/<id>│
   └───────────┬──────────────────────┬───────────────────┘
               │ io.use(token->group)  │
   ┌───────────▼─────────┐   ┌────────▼──────────────┐
   │ Agent A (Go, pid A) │   │ Agent B (Go, pid B)   │
   │  token A            │   │  token B              │
   │  room node_group/3  │   │  room node_group/4    │
   │  监听 :20001 tcp+udp │   │  监听 :21001 tcp+udp  │
   │  转发 -> 127.0.0.1:39001 │ 转发 -> 127.0.0.1:39002 │
   └───────────┬─────────┘   └────────┬──────────────┘
               │                      │
        echo 落地 A :39001        echo 落地 B :39002
        （回 "TARGET-39001"）     （回 "TARGET-39002"）
```

**租户定义**（全部经**真实 HTTP API** 创建，不写库，保证与控制面语义一致）：

| 租户 | workspace | user | 入口节点组 | 端口范围 | 隧道 | 监听端口 | 转发目标 |
|---|---|---|---|---|---|---|---|
| A | id=3 `NET01 Tenant A` | net01-a@tunex.local | id=3 `NET01-IN-A` | 20000-20099 | id=1 `A-tunnel` | **20001** | 127.0.0.1:39001 |
| B | id=5 `NET01 Tenant B` | net01-b@tunex.local | id=4 `NET01-IN-B` | 21000-21099 | id=2 `B-tunnel` | **21001** | 127.0.0.1:39002 |

两个 agent 都是 `agent/` 的真实 Go 二进制（`go build` 产物），走真实 Engine.IO v4 /
Socket.IO 连接、真实 Fernet 解密、真实 TCP listener + forwarder。**无 mock、无网络打桩。**

---

## 4. 使用方式

```bash
cd /opt/TuneX-email-auth

# ① 建独立栈 + 数据面 + 控制面 + 两个租户（幂等，可重复）
bash scripts/net01-e2e/setup.sh

# ② 起两个隔离的 agent 实例（会先停掉旧的 net01 agent）
bash scripts/net01-e2e/start-agents.sh

# ③ 跑双租户隔离验证（36 项断言，退出码 0 = 全过）
bash scripts/net01-e2e/verify.sh

# ④ 销毁（只动 net01 栈，不碰 relayx / TuneX）
bash scripts/net01-e2e/teardown.sh
```

若控制面已在跑可跳过 `setup.sh` 只跑 `bootstrap-tenants.sh` + `start-agents.sh`。
`setup.sh` 会被重复执行（复用自己的密钥文件），但数据卷已初始化时 seed 会按幂等 upsert。

---

## 5. 验证矩阵（36 项，全部通过）

### T1 租户 A 隔离（8 项）

| # | 断言 | 证据源 |
|---|---|---|
| T1a0 | agent A 存活（pid 记录） | `/tmp/net01/tenantA/agent.pid` |
| T1a2 | 进程 cmdline 是 `-n NET01-A-NODE` | `/proc/<pid>/cmdline` |
| T1a3 | 进程未持 B 的 token | `/proc/<pid>/cmdline` |
| T1a | agent A **独占**监听 `:20001` | `ss -ltnup` 按 pid 过滤 |
| T1b | agent A **未持有** `:21001` | 同上 |
| T1c | token A 在控制面解析到组 3 | `node_group.token` 查库 |
| T1d | 入口组 3 归属 workspace 3 | `node_group.workspace_id` |
| T1e | 组 3 节点数 = 1（只 A 自己） | `node` 表 |
| T1f | agent A 日志未出现 `:21001 ` | agent 运行日志 |

### T2 租户 B 隔离（7 项）
与 T1 对称（B 端口 21001 / 组 4 / workspace 5 / node `NET01-B-NODE`）。

### T3 跨租户访问被拒绝（4 项）

| # | 断言 | 实测 |
|---|---|---|
| T3a | 租户 A 会话读租户 B 的隧道 → 被拒 | **404** |
| T3b | 租户 A 会话读自己的隧道 → 通过（对照） | **200** |
| T3c | 租户 B 的组 token 以 Bearer 读 A 的隧道 → 被拒 | **401** |
| T3d | 租户 A 会话用 B 的入口组建隧道 → 被拒 | **403** |

> T3c/T3d 说明：节点组 token 只是 **Socket.IO 接入凭证**（换 room），不是用户级凭证，
> 不能横向取到 HTTP 业务资源；`x-workspace-id` 与 workspace 成员关系共同构成资源边界。

### T4 配置推送只发给对应租户（8 项）

| # | 断言 | 实测 |
|---|---|---|
| T4a | 仅 PATCH 租户 A 隧道，agent B 的 `config applied` 次数**不变** | 不变 ✅ |
| T4b | agent A 已应用配置 | ≥1 次 |
| T4c/T4d | Redis `node_group:config_hash` 按组隔离，含 field 3 与 4 | 命中 |
| T4e/T4f | 各 workspace 只有 1 条隧道 | 1 / 1 |
| T4g/T4h | 隧道 id 与 workspace 严格对应（无跨租户混放） | 1/1 |

机制：`pushNodeConfig(groupId)` → `io.to('node_group/<groupId>').emit('config', …)`，
A 组的推送**根本不会**进 B 的 room（`io.use` 已按 token 绑定 room）。

### T5 真实转发（2 项）

| # | 断言 | 实测 |
|---|---|---|
| T5a | `127.0.0.1:20001` → A 私有落地，回 `TARGET-39001` | ✅ |
| T5b | `127.0.0.1:21001` → B 私有落地，回 `TARGET-39002` | ✅ |

两个落地是不同端口、回各自端口标记的真实 socket 服务，**能区分串台**。

### T6 数据面隔离（4 项）

| # | 断言 | 实测 |
|---|---|---|
| T6a | A 端口回来的**不是** B 的落地标记 | ✅ |
| T6b | B 端口回来的**不是** A 的落地标记 | ✅ |
| T6c | agent A 实际服务清单无 `:21001` | ✅ |
| T6d | agent B 实际服务清单无 `:20001` | ✅ |

---

## 6. 证据落盘

`scripts/net01-e2e/evidence/`（不入 git，见 `.gitignore`）：

| 文件 | 内容 |
|---|---|
| `verify-result.txt` | 36 项断言逐条 PASS/FAIL + 汇总 |
| `tenantA-services.txt` / `tenantB-services.txt` | 两个 agent 实际加载的 `listening` / `config applied` 清单 |
| `t3-cross-create.json` | 跨租户建隧道被拒的服务端响应体 |
| `t4-patch-a.json` | patch 租户 A 隧道的响应体 |
| `echo-targets.log` | 两个私有 echo 落地的输出 |

---

## 7. 实现要点与坑（复用价值）

1. **「未监听 X 端口」必须按 PID 过滤 `ss`**。两个 agent 跑在同一宿主机，host 级端口表
   天然同时含 20001 与 21001（各自合法）。隔离的判定单位是「**哪个进程持有哪个端口**」，
   用 `ss -ltnup | grep "pid=$PID_A,"` 才对。最初按 host 判导致 4 项假 FAIL。
2. **shell 里管道条件不能直接 `$2` 执行**。`if $2` 只把 `$2` 当单个命令跑，管道 token
   变成 `ss` 的无关参数（退出 255）。要么 `eval "$2"`，要么把值取出来再判——**推荐后者**：
   否定断言尤其要在**值**上做，不要在「带副作用的命令」上做。
3. **隧道归属 team workspace 时，读接口必须带 `x-workspace-id`**，否则走 personal 上下文
   直接 404。验证脚本里 `cross_get` 已显式带 workspace 头。
4. **节点组 token 只在创建响应里返回一次**。`bootstrap-tenants.sh` 对「幂等重跑」的处理是
   先查后建；组已存在则从 `net01-mysql` 直读 token。
5. **口令文件必须幂等复用**。若每次重跑都重新生成口令，而已注册用户还在，login 会 401。
6. **`verify.sh` 里的后台 echo 服务必须重定向 stdout**，否则 heredoc 会占住管道让脚本挂住。

---

## 8. 复现命令（最短路径）

```bash
cd /opt/TuneX-email-auth
bash scripts/net01-e2e/setup.sh && bash scripts/net01-e2e/start-agents.sh \
  && bash scripts/net01-e2e/verify.sh
# 期望末行：总计: PASS=36 FAIL=0
```

已验证**连续 3 次**运行结果一致（36/36 通过）。

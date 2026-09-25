# WP14 v3 E2E Harness / QA 基础设施

**分支**：`test/v3-wp14-e2e-harness` · **Work Package**：WP14 · **Track**：D/Shared
**依据**：`DEVELOPMENT.md` §7.15（Real E2E / Grey Release）+ §7.2 Track D 清单

---

## 1. 这个目录是什么（以及不是什么）

**是**：`§7.15` 最低拓扑的可执行实现——五机真实网络拓扑、fixture 数据、流量转发
验证脚本、以及 backend 侧的 E2E 测试框架与工具函数。

**不是**：RELAY 的功能验收结论。功能工作包（WP5 数据面 / WP8 orchestrator /
WP9 reconciler 等）尚未合入，本 harness 的作用是**把验收环境提前搭好**，
并在功能落地后立刻可跑。它不会、也不允许把「功能没实现」报成「通过」。

### 1.1 为什么不会伪造通过

测试框架里每个断言有三个互斥状态，绝不含糊：

| 状态 | 含义 | 触发条件 |
|---|---|---|
| `pass` | 观测到的事实与期望一致 | 真实 socket/真实面板接口给出预期结果 |
| `fail` | 观测到的事实与期望**相反** | 有东西在听但路径错了、标记串台、越权竟然通过 |
| `unavailable` | **没有可观测对象** | 容器没起、agent 没连上、功能 WP 未合入 |

`unavailable` 与 `skip` 的区别是：它被单独计数并打印出来，且汇总断言
（`assertNoFailures`）**只对 `fail` 抛错**。所以两种失败都不可能：
功能没实现时报 `unavailable` 而不是 `pass`；功能错了报 `fail` 而不是静默跳过。
要宣称「RELAY 可用」的前提是跑一次 gate 且 `unavailable = 0`。

---

## 2. 拓扑

```
                       wp14-ctrl（控制面网段）
        ┌──────────────────────────────────────────────────┐
        │                                                  │
   ┌────▼─────┐         agent 主动出站（Socket.IO）        │
   │  panel   │◄──────────────────────┐                    │
   │ HTTP 3000│                       │                    │
   │ SIO  3001│              ┌────────┴────────┐           │
   └────┬─────┘              │                 │           │
        │ host 18180/18181   │                 │           │
        │              ┌─────▼──────┐   ┌──────▼───────┐   │
        │              │ingress-agent│  │egress-agent  │   │
        │              │ WP14-IN-A   │  │ WP14-OUT-A   │   │
        │              └──┬───────┬──┘  └──────┬───────┘   │
        │                 │       │            │           │
        │       host      │       │            │           │
        │       18201─────┤       │            │           │
        │       18202─────┤       │            │           │
        │                 │       │            │           │
        │   wp14-ingress-data（internal）      │           │
        │        ┌────────▼───┐  ┌│────────────▼───┐       │
        │        │  target-a  │  ││   target-b     │       │
        │        │ :3030      │  ││   :3030        │       │
        │        │ WP14-TARGET-A ││  WP14-TARGET-B │       │
        │        └────────────┘  └└────────────────┘       │
        │   wp14-egress-data（internal）                   │
        └──────────────────────────────────────────────────┘

   DIRECT 单跳：  host:18201 → ingress-agent:21001 → target-a:3030
   RELAY  双跳：  host:18202 → ingress-agent:21002 → egress-agent:22001 → target-b:3030
```

### 2.1 「至少一个 Agent 位于 NAT/私网、仅可主动出站」如何落地

`DEVELOPMENT.md` §7.15 要求至少一个 agent 仅可主动出站。compose 里这样实现：

* `egress-agent` (`scripts/v3-e2e/docker-compose.e2e.yaml`)
  **没有任何 host 端口映射**，且**刻意不接 `wp14-ctrl` 网段**。
  它的控制通道是 agent 主动向 `panel` 发起的 Socket.IO 连接；被 ingress
  拨号的数据端口（`egressPort`）只存在于 compose 内部网络。
* `panel` 只接 `wp14-ctrl`，两个数据网段都不接——控制面从网络层就无法
  访问 agent 数据端口（镜像约束的控制面侧）。
* 两个数据网段 `internal: true`：容器间可达，无外网出口。

这意味着"面板反连 agent"这一路径在网络层就是断的，与家用 NAT 后面的出口
节点语义一致。`verify.sh` T1 与 `relay.e2e.test.mjs` 的对应断言会**负向**
证明这条约束（出现端口映射/网段错接即 `fail`）。

### 2.2 端口规划（避开 net01 / tunex 两套栈）

| 端点 | host | container |
|---|---|---|
| panel HTTP | `18180`（`WP14_PANEL_HTTP_PORT`） | `3000` |
| panel Socket.IO | `18181`（`WP14_PANEL_SOCKET_PORT`） | `3001` |
| DIRECT 隧道 | `18201`（`WP14_INGRESS_PORT_DIRECT`） | `21001` |
| RELAY 隧道 | `18202`（`WP14_INGRESS_PORT_RELAY`） | `21002` |
| egress agent | 无 | `22001`（仅 compose 内可达） |
| target A/B | 无 | `3030` |
| mysql / redis | 无（compose 内） | `3306` / `6379` |

对照：net01 栈用 `8787/8788`（+mysql 13310、redis 13311），tunex 栈用
`8787`（+mysql 3307、redis 6380、caddy 9091）。本栈全部错开。

---

## 3. 使用

### 3.1 一键

```bash
bash scripts/v3-e2e/setup.sh      # 建环境（幂等，可重复）
bash scripts/v3-e2e/verify.sh     # 跑 DIRECT / RELAY / 隔离断言
bash scripts/v3-e2e/teardown.sh   # 整套销毁（不影响其它栈）
```

### 3.2 backend 侧 E2E 测试

```bash
cd backend
node --experimental-strip-types --test tests/v3-e2e/*.test.mjs
```

> CI 的 `backend` job 实际执行的是 `bun run test` → `node --experimental-transform-types
> --test tests/*.test.mjs`（注意 glob 是 `tests/*.test.mjs`，**不含** `v3-e2e/`
> 子目录）。子目录下的文件**当前不由 CI 自动拉起**——因为一次完整的 gate 运行需要
> docker 拓扑，超出 CI job 的资源预算。收敛到 `tests/` 顶层 glob 是后续 CI 变更，
> 本分支不动 CI 配置。本地/专有 runner 上按上面的命令手动跑。

### 3.3 变量覆盖

| 变量 | 默认 | 用途 |
|---|---|---|
| `TUNEX_BACKEND_IMAGE` | 本地有则 `ghcr.io/paimoncai/tunex-backend:latest`，否则现构建 `wp14-backend:ci` | 控制面镜像 |
| `WP14_AGENT_IMAGE` | `wp14-agent:ci` | agent 镜像（上下文 = `agent/`，由 `agent.Dockerfile.e2e` 构建） |
| `BUILD_AGENT_IMAGE` | 空 | `=1` 强制重建 agent 镜像 |
| `WP14_INGRESS_PORT_DIRECT` / `WP14_INGRESS_PORT_RELAY` | `18201` / `18202` | host 端口（撞端口时改） |
| `DELETE_IMAGES` | 空 | teardown 时 `=1` 连镜像一起删 |

---

## 4. 文件清单

| 文件 | 作用 |
|---|---|
| `scripts/v3-e2e/docker-compose.e2e.yaml` | 五机拓扑 + 三网段 + 端口规划 |
| `scripts/v3-e2e/setup.sh` | 建环境：镜像/数据服务/控制面/agents，并 bootstrap fixture 对象 |
| `scripts/v3-e2e/verify.sh` | T0–T6 断言（拓扑、仅出站、DIRECT、RELAY、隔离、配置隔离） |
| `scripts/v3-e2e/teardown.sh` | 销毁容器/网络/卷 + 清理运行期产物 |
| `scripts/v3-e2e/_bootstrap.py` | fixture 对象创建器（经**真实 HTTP API**，不直接写业务表） |
| `scripts/v3-e2e/fixtures/*.json` | 静态 fixture：拓扑/租户/隧道（含端口与 marker 真相源） |
| `scripts/v3-e2e/fixtures/agent-config-template.yaml` | agent 兼容位字段形状参考 |
| `backend/tests/v3-e2e/harness.ts` | 共享工具：容器探针、TCP 探针、控制面 client、状态模型、证据落盘 |
| `backend/tests/v3-e2e/relay.e2e.test.mjs` | RELAY 双跳 E2E 框架 |
| `backend/tests/v3-e2e/direct.e2e.test.mjs` | DIRECT 单跳 E2E 框架 |

`_bootstrap.py` 是**交付物且不入 git 清单之外**——它是 fixture → 控制面的桥，
由 setup.sh 调用，因此必须随源码走。真正不入 git 的运行期产物只有：
`state.json`、`.env.wp14`、`.passwords.env`、`agent.Dockerfile.e2e`
（setup.sh 每次按需生成）、`evidence/`、`backend/tests/v3-e2e/.artifacts/`
（见根目录 `.gitignore`）。

---

## 5. §7.15 正式 Gate 项状态矩阵

| # | Gate 项 | 当前状态 | 承载位置 |
|---|---|---|---|
| 1 | legacy DIRECT no regression | **框架就绪，环境驱动** | `direct.e2e.test.mjs` + `verify.sh` T2 |
| 2 | TCP RELAY | **框架就绪，环境驱动** | `relay.e2e.test.mjs` + `verify.sh` T3 |
| 3 | Egress-before-Ingress | 未实现（需 WP8 orchestrator） | — |
| 4 | weighted target | 未实现（需 WP5 + LB） | — |
| 5 | hot update | 未实现（需 WP9 reconciler） | — |
| 6 | Agent restart | 未实现 | — |
| 7 | control reconnect | 未实现 | — |
| 8 | Panel restart | 未实现 | — |
| 9 | stale revision | 未实现（需 WP6 contract） | — |
| 10 | credential revoke | 未实现（需 WP7） | — |
| 11 | port conflict/exhaustion | 未实现（需 WP3 lease） | — |
| 12 | workspace isolation | **框架就绪，环境驱动** | `verify.sh` T5/T6 + 两个测试文件的隔离断言 |
| 13 | BOTH Node | 未实现（需 WP1 role 扩展） | — |
| 14 | suspend/resume | 未实现（需 WP8） | — |
| 15 | change Egress | 未实现（需 WP8/WP10） | — |
| 16 | backup/restore | 未实现（运维侧，见 `scripts/ops/`） | — |
| 17 | old Agent compatibility | 未实现 | — |
| 18 | NAT / 仅出站 Agent 场景 | **拓扑就绪，负向断言已实现** | compose + `verify.sh` T1 + relay 测试 |

**「框架就绪，环境驱动」的准确含义**：断言逻辑、拓扑、fixture、证据采集都已
写好并已对**真实容器**验证过 PASS / FAIL / UNAVAILABLE 三条路径；当对应功能 WP
合入后，`setup.sh` 起栈即可得到真实判定，无需改代码。**它不等于功能已通过**。

---

## 6. 设计约束与踩过的坑

1. **`.mjs` 不能写 TS 语法**。CI 命令里的 `--experimental-transform-types` 只对
   **被导入的 `.ts` 文件**生效；`.mjs` 自身写 `const x: T = ...` 会在运行时报
   `SyntaxError: Missing initializer in const declaration`（Node 26 实测）。
   类型与工具一律放 `harness.ts`，`.mjs` 只消费。
2. **`fs/promises.writeFile` 不创建父目录**。`saveArtifacts` 必须先 `mkdir -p`
   （`rm` 之后再 `rm` 一次曾导致 ENOENT）。
3. **`execFile` 的 error.code 不总是数字**：二进制不存在时是字符串 `"ENOENT"`，
   超时是 `killed: true`。`harness.run()` 把三者归一成 `127 / 124 / 实际退出码`。
4. **"没起来"不能被读成"通过"**。`portBindings()` 对不存在的容器返回 `{}`，
   若直接断言"无端口映射 = 仅出站成立"，会把未运行的环境算成 PASS。
   所有拓扑断言都要先 `isContainerRunning()` 兜底，否则降级为 `unavailable`。
5. **`assertMarker` 连上但没回包**：这是 `fail`（有东西在听但不干活），
   不是 `unavailable`（压根没东西在听）。两者的处置完全不同。
6. **回显 target 用 busybox `nc -lk -p <port> -e echo <marker>`**：无需第三方
   镜像、无需 Python 运行时，且 `-lk` 持续 accept 能扛住多次连接。
7. **跨租户负面用例必须配反向对照**：只断言"读 B 的隧道被拒"是不够的——
   如果接口对所有请求都 403，断言会假通过。`T5c` / `own-workspace` 断言就是
   反向对照。
8. **fixture 的 `expected_marker` 曾漏字段**导致 `_bootstrap.py` KeyError——
   已用 mock API server 跑通 bootstrap 的完整 happy path + 幂等重跑后才补上。
   fixtures 是静态真相源，改它必须同步跑一遍 bootstrap。

---

## 7. 与其它 E2E 栈的隔离

`scripts/net01-e2e/`（双租户真实网络 E2E）与本栈互不影响：

| 维度 | net01 | wp14 |
|---|---|---|
| compose project | `net01` | `wp14-e2e` |
| 容器前缀 | `net01-` | `wp14-` |
| 网络 | `net01_net`（一个 bridge） | `wp14_ctrl` + `wp14_ingress_data` + `wp14_egress_data` |
| host 端口 | 8787/8788 | 18180/18181/18201/18202 |
| 数据卷 | `net01_mysql_data` | `wp14_mysql_data` |

`teardown.sh` 只删 `wp14-*` 自己的容器/网络/卷，并在开头打印其它栈的容器数量
作为"没误伤"的旁证。

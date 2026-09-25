# V4-WP2 — Agent Hot Reload Primitives 开发报告

- Work package: **V4-WP2 Agent Hot Reload Primitives**（Track B，Wave 1 → Wave 2 入口）
- Baseline: **WP1 契约分支 tip `74f97cd`**（`feature/v4-wp1-forward-revisions`，CI run `36184882122` success），分支由 `git worktree add /opt/TuneX-v4-wp2 -b feature/v4-wp2-agent-hot-reload 74f97cd` 从 **74f97cd 本体**创建——**不要在 74f97cd 之上叠加 main 快照**：那样 `git merge-base` 仍是 74f97cd，但 `git log` 看不出 WP1 血缘，集成代理会把 WP2 误判成「与 WP1 无关的新树」。本分支 `HEAD == 74f97cd`，`git merge-base --is-ancestor 74f97cd HEAD` 通过，血缘逐字记录在 §4。
- Worktree: `/opt/TuneX-v4-wp2`，分支 `feature/v4-wp2-agent-hot-reload`
- 规范依据: `DEVELOPMENT.md` §13.3.4（Hot Reload 分类）、§13.3.5（统一 Rollout 五阶段）、§13.3.2（revision 不可变 / 收敛到最新）、§13.6（WP2 DoD）、§13.7（Wave 1 → Track B）、§13.9（分支/PR 约定）
- **本报告先于实现提交**；实现按本报告 §5「实现切片」逐 commit。
- 与并行代理的边界：WP4 web 代理独占 `web/`；本包只动 `agent/` + `reports/`（本文件）。**不改** `backend/`、`web/`、`.github/workflows/ci.yml`、`docker-compose*`、`Caddyfile*`、迁移目录。

---

## 1. 范围（Scope）

### 1.1 In scope（WP2 交付）

| # | 交付物 | 说明 |
|---|---|---|
| S1 | **Upstream/target 热换原语** | 同一 listener 不重建，把已运行 forwarder 的上游整体替换；旧连接保持，新连接走新目标（§13.3.4「Target Host / Port」行） |
| S2 | **Listener replacement 原语** | 需要换端口/入口/模式时，新 listener 先 bind → cutover → drain 旧实例；bind 失败则旧实例原样继续（§13.3.4「Listen Port」行 + §13.3.5 PREPARE 失败规则） |
| S3 | **Drain 原语** | 停止接受新连接、等待在途连接退出，有界超时；端口占用表在 drain 过程中始终被新 Apply 视为已占用 |
| S4 | **幂等 revision 原语** | revision 相等 = 幂等 no-op（**不换 listener、不 drain**）；revision 更旧 = 拒绝；revision 更新 = 走 S1/S2。原语层显式给出「这一跳是 hot-swap 还是 replacement」的判定 |
| S5 | **判定函数（WP3 计划输入）** | `PlanForwardSwap(old, new)` 纯函数：输出 `Strategy(target_hot_swap / listener_replace / noop_metadata / unsupported)` + `DrainOld bool` + `FreeOldPort bool` + 人读 diff，WP3 五阶段契约直接消费 |
| S6 | **定向测试** | 真实网络单测（loopback echo/双目标），覆盖 §13.3.4 每一行 + 幂等/竞态/drain/释放 |

### 1.2 Out of scope（明确不做）

- **WP3 Forward Rollout Orchestrator**：不做五阶段状态机、compensation、Reconciler 改写。WP2 只交付*原语*与*判定*；编排在 WP3。
- **不改后端分发表**：`agent-command-bus.ts` / `orchestrator.ts` / `runtime-reconcile-sink.ts` / `control-protocol/**` 一律不碰（WP3 + WP1 的地盘）。WP2 不新增 wire 语义——它让**既有** `apply_tunnel` / `update_targets` 命令在 Agent 侧真正满足 §13.3.4 的语义，命令形状、错误码、ACK 形状零变化。
- **不改 `web/`**（WP4 独占）。
- 不做 UDP / WS / TLS / QUIC（§13.10）。
- 不做多入口 HA、automatic failover、节点迁移编排（§13.10，属 WP3/WP6）。

### 1.3 WP2 与 §13.3.4 的落地映射（本报告的核心约定）

§13.3.4 表的 Agent 侧落地——**一行一张表，每行有唯一 owner 原语**：

| §13.3.4 修改 | Agent 侧动作 | WP2 原语 |
|---|---|---|
| 名称 | Control Plane only，无数据面影响 | `PlanForwardSwap` 判 `noop_metadata`（Agent 根本收不到纯 rename 命令，见 §3.4） |
| Target Host / Port | 原 runtime 热换 upstream snapshot | `SingleHopForwarder.SetUpstream`（S1） |
| RELAY Egress | prepare 新 Egress → cutover Ingress → drain 旧 Egress | S1 的 `Pool` 路径 + `TunnelManager.Apply` 既有路径（WP3 编排顺序） |
| DIRECT → RELAY | 先准备 Egress，ACK 后切 Ingress upstream | S1（same listener，`upstream` 从 target 变 next_hop） |
| RELAY → DIRECT | Ingress 切直连 target，ACK 后撤旧 Egress | 同上 |
| Listen Port | 申请/监听新端口 → cutover → drain/释放旧 lease | `Manager.ReplaceListener`（S2+S3） |
| Ingress Node | 新 Ingress 完整 prepare → ACK → effective 切换 → 旧 Ingress drain | Agent 侧即一次全新 `Apply`（新节点上没有旧实例），drain 由 `Remove` 既有路径承担 |
| 多字段同时改 | 一个完整 revision / 一个 rollout plan | `PlanForwardSwap` 判定 + 按 revision 原子 Apply（§3.3） |

## 2. 契约（Agent 侧接口，WP3 消费）

### 2.1 `forwarder.TunnelConfig` 的修订

字段**零增删**（wire 兼容，WP1/backend 不做任何改动）。仅把上游地址解析收成一个显式概念：

- `UpstreamAddr()` 保持语义不变（RELAY = `next_hop`，其余 = `remote_host:remote_port`）。
- 新增内部 `upstreamAddr` 可变槽位，**只由** `SetUpstream` 写；`Start()` 不再在每次连接时重新从 cfg 取地址（见 §2.2）。

### 2.2 `forwarder.Forwarder` 接口扩展（additive，不破坏既有实现）

```go
type Forwarder interface {
    Start() error
    Stop() error
    Stats() int64
    // Running reports whether the listener is bound.
    Running() bool
    // SetUpstream hot-swaps the upstream of a RUNNING forwarder: live
    // connections keep their upstream, every following connection uses
    // addr. It never touches the listener, so it cannot fail a bind.
    // A non-one-hop forwarder returns ErrUpstreamNotSwappable.
    SetUpstream(addr string) error
    // Drain stops accepting and waits (bounded) for in-flight conns. The
    // listener stays bound... / Drain releases the listener...
    Drain(timeout time.Duration) error
}
```

三条不变式（测试逐条钉住）：

1. **`SetUpstream` 不与 listener 生命周期耦合**：调用前后 `Running()` 恒为 true；bind 不需要重新发生。因此「target 热换」不可能因为端口被自己占用而失败。
2. **`SetUpstream` 是 per-forwarder 的**：`TunnelManager` 持有该 forwarder 的引用即可完成 §13.3.4 Target 行，不需要 `Apply`（不需要走 revision 闸门）。
3. **`Drain` 有界**：`drainTimeout` 常量仍是硬上限；`Drain(d)` 用 `min(d, hard limit)`，避免调用方给一个巨大超时把 manager 卡死。

### 2.3 新增 `manager` 层 API（原语）

```go
// HotSwapUpstream hot-swaps the upstream of a RUNNING tunnel without
// touching its listener. Unknown tunnel / not running / upstream not
// swappable return an error; nothing is half-applied.
func (m *TunnelManager) HotSwapUpstream(id, addr string) error

// ReplaceListener applies cfg with the revision rules and, when the
// listener itself must change (port/mode), binds the NEW listener first
// and drains the old one only after the new one is live.
func (m *TunnelManager) ReplaceListener(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error)

// DrainTunnel stops accepting on id and drains in-flight connections with
// a bounded wait. The tunnel stays registered (Remove is the teardown).
func (m *TunnelManager) DrainTunnel(id string, timeout time.Duration) error
```

`ReplaceListener` 的行为规则（与 §13.3.5 PREPARE 失败规则对齐）：

```
1. revision 闸门（同 Apply：新=应用 / 等=幂等返回 / 旧=ErrStaleRevision）
2. same port 且同 mode：等价于 proxySemantics-level replace → 走 Apply 既有路径
   （已有 same-port replace 语义，见 tunnel.go startLocked 注释）
3. port/mode 变化：先 build + bind + mark used → 成功后才从 map 摘旧 entry 并
   异步入队 drain；bind 失败 → 旧实例原样不动，端口表无残留
```

与既有 `Apply` 的分工：**`Apply` 语义不变**（WP6 命令路径继续用它），`ReplaceListener` 是 `Apply` 的「listener-safe」变体，两者共享 build/revision/端口 guard 代码，不复制第二份。

### 2.4 `PlanForwardSwap` 判定（WP3 五阶段的计划输入）

```go
type SwapStrategy string
const (
    SwapNoop        SwapStrategy = "noop"         // identical config
    SwapMetadata    SwapStrategy = "metadata_only" // name/speed-limit 级改动
    SwapTargetSwap  SwapStrategy = "target_hot_swap" // upstream only
    SwapListener    SwapStrategy = "listener_replace"
    SwapRecreate    SwapStrategy = "recreate"        // unsupported hot path
)

type SwapPlan struct {
    Strategy   SwapStrategy
    DrainOld   bool // old instance must be drained after cutover
    FreeOldPort bool // old listen port must be released
    Reason     string // human-readable
}
```

判定表（§13.3.4 的属性 → plan）：

**表中 `mode 相同/不同` 指 cfg.Mode 的切换（DIRECT↔RELAY↔EGRESS）；`端口同/不同` 指 ListenPort()。** §13.3.4 对 DIRECT↔RELAY 的裁决是「Ingress listener 保持」：这一行是上游语义变化（upstream 从 RemoteHost:RemotePort 变成 NextHop），不是 listener 迁移，因此与 listen port 无关地归 `target_hot_swap`、`drain_old=false`、`free_old_port=false`——实现以冻结的 §13.3.4 为准（`PlanForwardSwap` 的 `modeMoved` 分支），下表已据实更正。

| old → new | strategy | drain_old | free_old_port |
|---|---|---|---|
| 完全相同 | `noop` | false | false |
| 仅 metadata（无数据面字段：speed_limit / protocol 等） | `metadata_only` | false | false |
| 同 mode、同 listen port、上游不同 | `target_hot_swap` | false | false（端口未被移动，仍在位） |
| **模式不同（DIRECT↔RELAY）且端口同** | `target_hot_swap`（§13.3.4「Ingress listener 保持」；上游从 target 变 next_hop，forwarder 仍只拨一个地址） | false | false |
| 同 mode、**端口不同** | `listener_replace` | true | true |
| 模式不同且端口不同 | `listener_replace`（端口迁移优先分类，同时携带上游变化） | true | true |
| 目标为 EGRESS（池由 EgressManager 管） | `recreate`（Agent 内不支持原地 hot swap，走 Apply 既有路径） | — | — |

`drain_old=false` 只表示「这一跳不 drain」：纯上游热换的旧实例就是存活下来的那个 forwarder，没有旧实例可 drain；端口迁移则先 bind 新 listener、再 drain 旧实例（§13.3.5 CUTOVER→DRAIN）。

## 3. 与既有实现的衔接（关键设计裁决）

### 3.1 为什么必须新增 `SetUpstream`，而不复用「同端口同 revision 重放」

现状 `startLocked` 的 same-port replace 是「**停旧 → 起新**」：旧 listener 先关，新 listener 后 bind。这满足「端口可复用」，但**违反** §13.3.4 Target 行的「旧 TCP 连接继续」——旧连接已被 `Stop()` drain 掉。所以 target 热换必须走「不碰 listener」的路径，`SetUpstream` 是这个路径的唯一正确实现。

### 3.2 EGRESS 目标的 hot swap 已经存在，WP2 不重复造

`manager.Pool.SwapTargets` + `LoadBalancer.UpdateTargets` 已经实现「RELAY Egress 换目标不重建 listener」（devmap §5.3），由 `PATCH /node/targets` 与 `control.prepareEgressPool` 复用。WP2 **不新建第二套**目标热换机制，只做两件事：

- 让 `PlanForwardSwap` 认识这条既有路径（EGRESS → `recreate`/走既有路径，避免误判成 `listener_replace`）；
- 单测把它与 §13.3.4 RELAY Egress 行显式锚定（已有 `TestRelayChainHotUpdate*` 系列，WP2 补一条「**换目标后旧连接不中断**」的定向断言，即既有能力 + 新契约断言，不重写）。

### 3.3 revision 幂等与「多字段单 revision」

`TunnelManager.Apply` 的 revision 三态已存在（newer/equal/older），WP2 的增量是**把它变成显式契约**并在 `ReplaceListener` 里复用：

- equal → 返回既有 forwarder，**不 drain、不 rebind**（§13.3.6「resume 时只应用最新 revision」靠这条不重复打断业务）；
- older → `ErrStaleRevision`（WP3 的 stale 判定在 Agent 侧被拒，不进数据面）；
- newer → 走 §2.3 的路径判定。

多字段同时改（§13.3.4 最后一行）：backend 一次 PATCH 就是一个 revision（WP1 保证），Agent 收到单个 `TunnelConfig` 整体生效——**Agent 侧天然不存在半配置中间态**，WP2 只需用 `PlanForwardSwap` 保证「一次 Apply 只产生一个 cutover」。

### 3.4 纯 rename 不进 Agent

WP1 已裁决纯 metadata 修改不 bump `config_revision`、不触发 runtime 收敛，因此 Agent 根本收不到 rename 命令。`PlanForwardSwap` 的 `metadata_only` 分支因此是**防御性**判定（配置里尚存 `speed_limit`/`protocol` 等未来可能放开的数据面字段），测试覆盖它，但文档必须写明它不是当前活跃路径。

## 4. 分支血缘与并行边界（写死，供集成代理）

```
main (9a489b5)
  └── feature/v4-wp1-forward-revisions (74f97cd)   ← WP1 契约冻结点，CI 36184882122 绿
        └── feature/v4-wp2-agent-hot-reload (HEAD = 74f97cd + WP2 commits)
```

- 基线由 `git worktree add /opt/TuneX-v4-wp2 -b feature/v4-wp2-agent-hot-reload 74f97cd` 创建；`git merge-base HEAD 74f97cd == 74f97cd`，`git rev-list --count 74f97cd..HEAD` 只含 WP2 自己的 commit。
- **WP2 不得 merge 到 main 早于 WP1**：WP1 尚未过集成门进 main，WP2 分支因此**暂驻契约分支 tip**。WP1 进 main 后，集成分支用 `git merge origin/main` 把 WP2 摘到新 main 上（保留 WP1 血缘；不改写历史、不强推）。
- 文件边界（硬约束）：只写 `agent/**` 与 `reports/v4-wp2-plan.md`。若实现过程中发现必须改 `backend/` 才能让热换生效——**停下来报告**，不越界改（那是 WP1/WP3 的契约问题）。
- 推送纪律：普通 push，**绝不 force**；若需 rebase/merge 用 merge commit 保持 fast-forward。

## 5. 实现切片（每片一个 commit）

| Commit | 内容 | 边界 |
|---|---|---|
| C1 | `reports/v4-wp2-plan.md`（本报告） | 仅文档 |
| C2 | `forwarder`：`Forwarder` 接口增加 `Running()/SetUpstream()/Drain()`；`singhop.go` 实现 `SetUpstream`/`Drain`（原子上游槽位 + 有界 drain）；`base.go` 暴露 `drainFor(d)`；`egress.go` 实现 `SetUpstream` 返回 `ErrUpstreamNotSwappable`、`Drain` 复用 pipeTracker | 只改 `agent/internal/forwarder/**` |
| C3 | `forwarder/interface_test` 扩展 + `singhop_hotswap_test.go`：真实 loopback 断言①`SetUpstream` 后 listener 未变（同一端口、旧连接不中断、字节继续计）；②上游不可达时新连接被丢弃但 listener 仍在；③`Drain` 有界且返回后 listener 已释放 | 只加测试文件 |
| C4 | `manager/swap.go`（新）：`SwapStrategy`/`SwapPlan`/`PlanForwardSwap` 纯函数；`TunnelManager.HotSwapUpstream` / `ReplaceListener` / `DrainTunnel` / `DrainAllTunnels`；`tunnel.go` 的 `Apply` 重构成共享 `applyLocked`（两条入口共用同一 revision + 端口 guard 实现） | 新文件 + 只重构 tunnel.go（行为不变） |
| C5 | `manager/swap_test.go`：判定表逐行 + `ReplaceListener` 的三类路径（幂等 / 同端口 / 换端口）+ bind 失败旧实例存活 + drain 后端口可立即复用 + `HotSwapUpstream` 未知/未运行/不可换的三种错误 | 只加测试文件 |
| C6 | `control/client.go` `apply_tunnel` + `api/server.go` `POST /tunnel` 按 plan 路由（listener 移动走 `ReplaceListener`）+ `control/hotreload_test.go`：命令路径换端口不断连、幂等 replay no-op、stale 拒绝 | 只改 agent 命令面 |
| C7 | （本 commit）报告同步实际切片与验收结果 | 仅文档 |

### 5.1 补片 C8（收尾审查发现，见 §9.3）

C6 的布线**只覆盖了 listener 移动**：命令面按 `Strategy == SwapListener` 选 `ReplaceListener`，其余一律回落到 `Apply`。于是 §13.3.4 的「Target Host / Port」行在生产路径上走的是 `Apply` 的 same-port 路径——而那条路径是「停旧 → 起新」，drain 掉全部活动连接并清零字节计数器。探针实测：同端口换 upstream 耗时 3.0036s（= `drainTimeout` 硬上限），`Stats` 由 14 归零，`LiveConns` 1→0。原语存在，但没有任何一个生产入口调它。

C8 把路由收敛进 manager 单点，并补三类定向测试：

- `applyRoutedLocked` 成为唯一路由点，两个 apply 面（`apply_tunnel`、`POST /tunnel`）都直接调 `ReplaceListener`，不再各自算 plan——两层各算一次必然漂移，且在外层的分类在拿锁前就过期了；
- `hotSwapUpstreamLocked`：同 listener 换 upstream 只改运行中 forwarder 的 dial 地址，listener、活动连接、字节计数全部保留；`SetUpstream` 被拒（不可换的 forwarder 种类）时 log 一行并回落到 `Apply` 重建，**不**让命令失败把节点留在面板已不信的配置上；
- 首次 apply 显式走 `Apply`：对零配置做 diff 永远长得像 listener 移动，若不排除会绕过 `usedPort` 端口 guard（这正是探针日志里 `tunnel listener replaced old_port=0` 暴露的问题）。

| 观察 | 修复前 | 修复后 |
|---|---|---|
| 同端口换 target 耗时 | 3.0036s（drainTimeout 上限） | 228µs |
| `Stats`（字节计数） | 14 → 0（重建清零） | 保留（单调不减） |
| `LiveConns` | 1 → 0（连接被 drain） | 1 → 1 |
| 首次 apply 日志 | `tunnel listener replaced old_port=0`（误判 + 绕过端口 guard） | `tunnel applied`，端口 guard 生效 |

顺带修掉两个既有测试缺陷：`TestReplaceListenerBindFailureKeepsTheOldInstanceRunning` 原本占用的是隧道**当前**端口（第二次 `127.0.0.1` bind 必失败）→ 每次都 SKIP、等于没测；改成占用要移动到的**新**端口，真正验证 §13.3.5 PREPARE 失败规则，并新增「旧实例仍可服务 / 端口表无残留」断言。

CI 覆盖：`agent` job 的 `go vet ./...` + `go test ./...` + `go build` 自动纳入。**不改 `.github/workflows/ci.yml`**（避免与并行 WP 的 CI 列表冲突——skill 记录的高频冲突点）。

## 6. 测试计划

| 层 | 用例 | 执行者 |
|---|---|---|
| 判定纯函数 | `PlanForwardSwap` 判定表逐行（§2.4）+ metadata/noop/recreate | CI `go test ./internal/manager/` |
| upstream 热换 | ① 换上游后**同一端口**仍 listen；② 换前建立的连接继续转发且字节计入；③ 换后新连接走新上游；④ 新上游不可达 → 新连接被丢弃、listener 不退出 | CI 真实 loopback |
| listener replacement | ① 换端口：新端口先活、旧端口随后不可连、旧实例被 drain；② 同端口同 mode：走既有路径且**不**重复 drain；③ bind 冲突（外国进程占端口）→ 旧实例原样运行、端口表无残留 | CI |
| drain | ① `Drain(0)`/`Drain(巨大值)` 都有界且**空闲时立即返回**；② drain 期间新 Apply 视该端口为占用；③ drain 后端口立即可复用（Remove）；④ drain 后**新连接不再被 accept**、在途连接被等待；⑤ drain 后 `SetUpstream`/`Start` 被拒（不可逆） | CI |
| revision 幂等 | ① equal revision 二次 Apply = 同一 forwarder 指针、不 rebind、不 drain；② older revision = `ErrStaleRevision` 且**运行时未被改动**（旧连接仍在） | CI |
| EGRESS 契约断言 | 换 target 后旧连接不中断（§13.3.4 RELAY Egress 行） | CI |
| 既有回归 | `go test ./...` 全量（含 dataplane_test / forwarder_test / lb_test / client_test） | CI |

本地只跑**单文件** `go test ./internal/forwarder/ -run <case>` 与 `go test ./internal/manager/ -run <case>`；`go vet ./...` 可在本地（廉价）。typecheck 之外的重量验证交 CI。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `SetUpstream` 与 `Start()` 的上游读取竞态 | 连接用旧/新上游随机分布（不可观测） | 上游地址进 `atomic.Pointer[string]`/atomic value，`Start()` 每次连接读一次；测试并发 `SetUpstream` + 连接循环，`-race` 下必须干净 |
| same-port replace 的「停旧再起新」窗口 | 端口在窗口内无人监听，新连接被拒 | `ReplaceListener` 明确区分「同端口同 mode → 既有路径（接受该窗口）」与「换端口 → 先 bind 新再 drain 旧」；文档写明同端口路径的窗口是既有设计，不是 WP2 引入 |
| `Drain` 阻塞 manager 锁 | 一次 drain 卡死整个 manager | drain 在 `m.mu` **外**执行（同 `stopEntry` 的理由）；端口 guard 的释放/保留全部在锁内完成 |
| EGRESS 被误判为 `listener_replace` | 换目标却重建 listener = 中断全部连接 | `PlanForwardSwap` 对 EGRESS 一律不给 `listener_replace`；单测钉住 |
| WP3 期望 `HotSwapUpstream` 走 revision 闸门 | 语义分歧返工 | 本报告 §2.2 不变式 2 写明：target 热换**不**过 revision 闸门（§13.3.4 Target 行没有 listener 动作，没有 cutover 需要幂等）——WP3 若要闸门版，在 WP3 侧包一层，不改 WP2 原语 |
| Go 版本 / 离线模块 | 构建失败 | agent 标准库 only；本地 `go vet ./...` 已过；CI `go-version-file: agent/go.mod` |

## 8. 给 WP3 / 集成代理的契约预留

- **WP3**：五阶段计划 = `PlanForwardSwap(old, new) → SwapPlan` + 节点维度展开。CUTOVER 用 `TunnelManager.ReplaceListener`（换 listener）或 `HotSwapUpstream`（纯上游）；DRAIN 用 `DrainTunnel`；CLEANUP 释放端口由 `ReplaceListener`/`Remove` 的端口表保证。**compensation** 需要的「回退到 applied revision」在 Agent 侧 = 对同一个 id 再 `Apply(applied snapshot)`，但**只有 listener 路径**可以保证回退后仍是同一 listener——这条约束由本报告 §3.1 固定，WP3 不得改写。
- **WP1 集成**：WP2 不读 `forward_revision` 表；Agent 只认 wire 上的 `revision`（= `tunnel.config_revision`）。WP1 的 `expected_revision` 409 与 Agent 的 `ErrStaleRevision` 是两层，语义一致，无需对齐改动。
- **集成顺序**：WP1 过集成门进 main → `git merge origin/main` 到本分支（fast-forward）→ 重推 → CI 绿 → 才可提 PR。PR 描述按 §13.9 模板补齐（Hot Reload / Drain Impact 一节直接引用本报告 §1.3 表）。

## 9. 验证与回滚

### 9.1 实际验证结果（实现后回填）

| 检查 | 结果 |
|---|---|
| `go vet ./...` | 通过 |
| `go test ./...`（全量，真实 loopback） | 通过（agentconfig / api / control / forwarder / manager 五包） |
| `go test -race`（api / control / manager / forwarder） | 通过，无 DATA RACE |
| CI `agent` job（vet + test + build + 交叉编译） | 每个功能 commit 一跑，逐次 success |
| 对 WP1 分支 / 其他文件的副作用 | 无：`git diff 74f97cd --stat` 只含 `agent/**` + 本报告 |

本地验证纪律：只跑单文件/单包 `go test`（Go 编译器 + 测试比 tsc/next build 轻得多，但 `-race` 全项目仍耗时，故按包执行）。**未**跑 `npm run build` / `tsc --noEmit`（本包不触碰 backend/web，且 CI 拥有重量验证）。

### 9.2 审查发现与修正（C8 引出的契约缺口）

1. **同端口 target 热换未走热换路径**（§1.3 表「Target Host / Port」行的 owner 原语未接线）。C6 只把 listener 移动接到 `ReplaceListener`，target-only 改动全部回落到 `Apply` 的 same-port 路径（停旧→起新），**协议上违反** §13.3.4「旧 TCP 连接继续；新连接走新目标」。已由 §5.1 的 `hotSwapUpstreamLocked` + 三类定向测试修复（api / control / manager 三层各一条）。
2. **plan 在两处各算一次**。命令面自己 `PlanForwardSwap` 挑路径，manager 锁内又算一次；外层那次在拿锁前就可能已过期（配置已被并发 Apply 改掉）。已收敛到 manager 锁内的 `applyRoutedLocked` 单点路由。
3. **首次 apply 被误判成 listener 替换**。对零配置做 diff 永远呈现「端口 0→N」，会走 `replaceListenerLocked` 从而**完全绕过 `usedPort` 端口 guard**——不是优雅降级，是把端口冲突检查跳过了。已显式分流到 `applyLocked`。
4. `TestReplaceListenerBindFailureKeepsTheOldInstanceRunning` 长期 SKIP（占错端口）。已改成占用要移动到的目标端口，恢复成真正跑的 PREPARE 失败规则用例。
5. 核对无越界：仅 `agent/**` + 本报告；`backend/`、`web/`、`.github/workflows/ci.yml`、迁移目录均未触碰。

### 9.2b 第二轮独立审查发现与修正（plan/测试偏差）

6. **`Drain` 未真正停止接受新连接**（§2.2 不变式 3 的 `Forwarder.Drain` 注释、§13.3.5 DRAIN 语义都没落地）。`pipeTracker.drainFor` 只轮询 `liveConns`，accept 循环从头到尾在跑：一次 Drain 之后 forwarder 还在收新连接，manager 侧的 DRAIN 阶段形同虚设。已改为 drain 前先置 `draining` 标志、accept 循环见标志即退出且**不关 listener**（端口留给 manager 释放），并把「conn 已 accept 但 drain 已开始」的竞态统一按 drain 赢处理。另补一条重要约束：**drain 不可逆**——无 un-drain；被 drain 的 forwarder 拒绝 `SetUpstream` 与再次 `start`，拆除走 `stop()`（drain 后任意时刻安全）。真实 loopback 测试覆盖：drain 后端口仍绑定但新连接不再被转发、在途连接被等待且返回仍有界、重复 drain / Stop 之后续生命周期、drain 与 Stop/拨号并发、egress forwarder 同契约。
7. **`d <= 0` 被当成「等死」而不是「不等」**。原实现 `if d <= 0 || d > drainCeiling { d = drainCeiling }` 把 0 也改写成 15s 上限，与 §2.2 不变式 3「`Drain(d)` 用 `min(d, ceiling)`」相反。已改为 `d <= 0` 立即返回（不等待但仍完成停止 accept 的那一半），`d > ceiling` 仍收敛。
8. **§2.4 判定表与代码不一致**（DIRECT↔RELAY 同行）。表中写「模式不同且端口同 → `listener_replace` + drain_old」，而冻结的 §13.3.4 要求「Ingress listener 保持」——这一行是上游语义变化，不是 listener 迁移，代码（`PlanForwardSwap` 的 `modeMoved` 分支）才是对的。已按冻结 §13.3.4 更正表格与说明，并补写 `mode`/`port` 的判定口径。
9. **`TestReplaceListenerTargetSwapFallbackKeepsNodeServing` 没有走 fallback**。它构造「端口 + target 同时改」，`PlanForwardSwap` 判 `SwapListener`，路由进 `replaceListenerLocked`，`hotSwapUpstreamLocked` 的 fallback 分支从未被执行——测试名承诺的契约没被测。已改名/拆分为真正触发 `SetUpstream` 被拒的用例（见 §9.2c）。
10. **旧端口 guard 提前释放**。`replaceListenerLocked` / `applyLocked` 在 `stopEntry`（异步关旧 listener）之前就 `releasePortLocked`，guard 报告的端口已经空闲、OS 层面的 bind 却还没发生。已改为旧实例真正停止后才释放，消除「guard 说空、OS 说占」的端口再利用窗口（见 §9.2c）。

  落地方式：`stopEntry` 增加 `stopEntryAsync(entry, onStopped)` 钩子，`releasePortAfterStop(cfg)` 在 `Stop()` 返回后**持 `m.mu`** 释放（guard 是 manager 状态，绝不交给 teardown goroutine 直接改）。该释放是 **owner-aware** 的：旧端口被新条目合法占用时（X→Y→X 的折返迁移）不删 key，避免晚到的释放把在跑隧道的端口送人。同端口同 id 场景显式传 nil 钩子——新 forwarder 已经持有该 key，旧实例拆的时候绝不能把它放掉。`TestReplaceListenerOldPortGuardFollowsTheOldListener` 同时钉住「仍在停止 → 保留」和「停止后 → 释放且端口立刻可再绑定」，mutation 验证：把 `stopEntryAsync(old, releasePortAfterStop(...))` 改回提前 `releasePortLocked` 立即 FAIL。

### 9.2c 本轮补片

| 观察 | 修复前 | 修复后 |
|---|---|---|
| `Drain` 后新连接 | 仍被 accept 并转发 | 不再 accept，端口仍绑定/保留 |
| `Drain(d<=0)` 空闲时 | 死等 15s 上限 | 立即返回 |
| drain 后 `SetUpstream` | 成功安装一个没人能拨的地址 | `ErrForwarderNotRunning` |
| 端口迁移时旧端口 guard | 在旧 listener 关闭前释放 | 旧实例停止后才释放 |
| `TestReplaceListenerTargetSwapFallbackKeepsNodeServing` | 名不副实（走的是 listener 路径） | 改名 + 真正触发 `SetUpstream` 拒绝的用例 |

### 9.3 回滚

- 纯代码回滚；无 schema、无 wire 契约变化，`backend`/`web` 零影响，回滚不需要数据修复。
- 不碰生产 DB/容器、不做部署。
- 回滚到 WP1 契约 tip = `git reset --hard 74f97cd`（本分支所有 WP2 commit 在其之上，revert 任一 commit 不影响 WP1 血缘）。

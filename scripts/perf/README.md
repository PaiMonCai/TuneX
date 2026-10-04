# V5 性能基线（WP3）：TCP / TLS / WS

> 冻结 V4/V5-G0 的 TCP 性能参照，避免"功能通过、性能退化"长期不可见
> （`DEVELOPMENT.md` §5.4）。V5.1a 给入口增加了两个前端协议，所以这里按同一条
> 流水线补上 `tls` 与 `ws` 两个场景（§5.4「每个协议各有自己的场景」）。

## 怎么跑

```bash
# 快速档（默认，几分钟内跑完）：日常改完代码自查。默认只跑 TCP 的 direct + relay
bash scripts/perf/v5-tcp-baseline.sh

# 接近真实链路量级：发布前人工对比
bash scripts/perf/v5-tcp-baseline.sh --profile full

# 只跑一个拓扑 / 只跑新增的前端协议
bash scripts/perf/v5-tcp-baseline.sh --scenarios direct
bash scripts/perf/v5-tcp-baseline.sh --scenarios tls
bash scripts/perf/v5-tcp-baseline.sh --scenarios ws
bash scripts/perf/v5-tcp-baseline.sh --scenarios direct relay tls ws

# 采集器自检（纯函数，不需要 go / 端口；TLS 场景才需要 openssl）
python3 scripts/perf/test_v5_tcp_baseline.py
```

`tls` 场景需要机器上有 `openssl`（现场生成一对临时自签证书，见下文）。缺
`openssl` 时该场景会**明确失败并说明两条出路**，不会静默跳过——静默跳过会让
基线看上去永远是绿的。默认场景（`direct relay`）与 `ws` 都不需要 `openssl`。

产物写到 `scripts/perf/results/`：同名时间戳的 `.json`（权威）与 `.csv`（便于画趋势）。

## 它测的是什么

| 指标 | 含义 |
|---|---|
| `<topo>_throughput` | 单连接吞吐（MiB/s）：建连（含 TLS/WS 握手）→ 传输 → 读完回包 |
| `<topo>_connect_ms` | 建连耗时（tls/ws 含各自握手完成） |
| `<topo>_concurrent_throughput` / `_concurrent_rtt_ms` | 并发连接下的整轮吞吐与单连接往返 |
| `<topo>_hot_reload_apply_ms` | apply 换 target（revision+1）返回的耗时 |
| `<topo>_hot_reload_effective_ms` | apply 到**新 target 真的可用**的耗时 |
| `<topo>_restart_panel_ms` | 重启期间面板可达 → 端口重新可用的耗时 |
| `<topo>_restart_lkg_ms` | 重启期间面板不可达 → 从本地 last-known-good 恢复的耗时 |
| `<topo>_graceful_drain_idle_ms` | 空载 SIGTERM → 进程退出 |
| `<topo>_graceful_drain_held_ms` | **有在途连接**时 SIGTERM → 进程退出（有界排空上限） |
| `<agent>_gauges` | goroutine 数 / RSS / 累计 CPU |
| `<agent>_cpu_seconds_used` | 本轮负载消耗的 CPU（两次读数之差） |
| `ws_echo_integrity` | WS 场景的前置校验：逐字节比对一次 64 KiB 往返，通过才写 `true` |

`<topo>` 就是场景名：`direct` / `relay` 是 TCP，`tls` 与 `ws` 是 V5.1a 的前端协议，
`relay` 会额外出现 `ingress_*` 与 `egress_*` 两组仪表。每个数值都带
`median / p95 / min / max / mean / count`。**看中位数和 p95**，`min`/`max` 在共享
机器上只能说明当时有没有别的东西在抢 CPU。

### tls / ws 场景具体测什么

| 场景 | 数据面动作 |
|---|---|
| `tls` | `openssl` 临时自签 EC 证书 → 面板下发 `protocol=tls` → 客户端建连 + TLS 握手 + 一次回环传输 |
| `ws` | 面板下发 `protocol=ws` → 客户端 RFC 6455 握手（校验 101 与 `Sec-WebSocket-Accept`）→ 一帧 masked 二进制消息 → 读回解帧后的字节 |

两者的**统计口径与 TCP 完全一致**（计时都从 `connect()` 之前开始），所以
`tls_throughput` 与 `direct_throughput` 可以直接比：差值是"入口换成 TLS"的真实成本。
`ws` 的吞吐按**解帧后的业务字节**计（不是线上字节），与 `direct` 同口径；帧头
开销不摊进分母。`ws` 场景在采集之前先做一次**内容**校验（`ws_echo_integrity`）：
吞吐只数字节数，一个解错了帧的隧道同样会"回满 N 字节"，所以先证明字节流是对的，
再谈它有多快；校验不通过就直接失败，不产出数字。

`tls` / `ws` 只测吞吐、建连、并发与仪表。热重载、重启收敛（panel/LKG）、有界
排空是**三种协议共用的 stream 运行时路径**，只在 `direct` 上测一次；`ws` 的
握手与分帧实现另由 Gate V5-G1A 的负例覆盖（非 WS 客户端、垃圾字节、明文 HTTP）。

## 拓扑是真的

- **DIRECT**：client → ingress Agent → echo target；
- **TLS**：同上，但**入口 listener 是 TLS server**（证书现场自签），握完手的
  明文流走与 DIRECT 完全相同的转发路径。出口与跨节点跳不做二次加密（§6.1）；
- **WS**：同上，但**入口 listener 说 RFC 6455**：客户端把 payload 装进 masked
  帧，Agent 解帧后把字节流转给 target，回程由 Agent 重新分帧（服务端帧不掩码）。
  客户端是采集器里手写的（不新增依赖），并会校验 `Sec-WebSocket-Accept`；
- **RELAY**：client → ingress Agent → egress Agent → echo target，**两台独立进程**，
  真的走完两跳与两个 listener；
- 有一个本地**假面板**（`FakePanel`）下发 desired 快照。没有它就没法测重启收敛：
  只用 admin API 只能造出"手工塞进去的隧道"，restore / LKG 这两条路径根本走不到。
  EGRESS 的 target pool 也必须由面板那份快照建立（`restore.Apply` 在构造 forwarder
  之前先建池），admin API 没有"创建第一个池"的入口；
- 假面板只回三件事：desired 快照、状态上报 200、其余 404。它**不实现任何授权语义**，
  所以它的存在不能被当成"测过面板权限"的证据。

## 没有生产凭据

回环拓扑，admin token 与面板凭据每次运行**随机生成**，只存在于该次运行的进程环境里，
不写进任何产物。假面板只认它自己刚生成的凭据（其余一律 401）。

TLS 场景的证书同样是一次性的：`openssl` 在临时工作区里现场生成一对自签 EC 证书
（`-days 2`、SAN 含 `127.0.0.1`），Apply 时只把**路径**交给 Agent（§6.1：Forward 不
携带密钥材料），运行结束连同临时目录整体删除。仓库里**不放**证书：一份会过期的
证书会让场景在某天悄悄变红，而"悄悄"正是这个文件一直在防的东西。


## 怎么解读

1. **不要拿绝对值跨机器比较。** `environment` 里记录了 CPU 型号、核数、内核、
   `cgroup_cpu_max`（容器里这才是真正的核数）与 `loadavg`。没有这些字段的对比没有意义。
2. **同一台机器、同一 profile，比中位数。** 循环回环 + Python 采集器的 GIL 会让
   单次数字波动很大（同一份代码在 quick 档就能看到 40–200 MiB/s 的中位数漂移）。
   趋势要看多跑几次的中位数，而不是一次运行的一个数。
3. **`--profile full` 才适合看 CPU。** `/proc/<pid>/stat` 的 CPU 分辨率是一个调度
   tick（通常 10 ms）；quick 档负载下增量可能不足一个 tick，产物会给出
   `cpu_resolution_note` 明确说明"读数为 0 表示低于分辨率，而不是没测到"。
4. **`graceful_drain_held_ms` 接近 10s 是预期结果**，不是退化：那是 V4 的有界排空
   上限。`graceful_drain_idle_ms`（几十毫秒）才是进程收尾开销。
5. **`restart_lkg_ms` 的 `*_sources` 字段必须显示 `["lkg"]`。** 它是"面板不可达时
   走的是本地快照"这条证据本身；如果显示 `panel`，说明面板没有被真正断开，那次
   测量没有测到耐久性路径。
6. **`tls_connect_ms` 才是"多一个协议"的建立成本。** 它是建连 **到 TLS 握手完成**；
   与 `direct_connect_ms`（纯 TCP 建连）的差就是 TLS 引入的那一层。`ws_connect_ms`
   同理（到 101 + `Sec-WebSocket-Accept` 校验通过）。两者的 `_throughput` 也包含
   这层握手（口径与 TCP 的 `transfer_once` 一致），所以 tls/ws 的吞吐低于 direct
   是**预期**的：那是"每条连接都要重新握手"的真实代价，不是退化。
7. **tls 的证书是每次运行现场生成、用完即删的自签 EC 证书**（`--days 2`，目录在
   临时工作区里）。产物里只有 `environment.openssl_version`，没有密钥材料；
   临时目录在运行结束时整体删除。复核证书本身请手工跑一条 tls 场景后趁进程存活
   用 `openssl s_client` 连它——不要期望产物里能找到证书。

## 它不是 CI 门槛

脚本只测量、**从不判定**"变慢了"。共享 CI Runner 上的毫秒级硬门槛只会制造随机红灯，
最终结果是没人再看它（§5.4「不要一开始用脆弱绝对阈值阻断 CI」）。后续回归方式：

```text
相对回归 > 历史趋势 > 大幅退化告警
```

`scripts/perf/baseline/` 下提交的是**锚点产物**：它记录"某个 commit 在某台机器上
一次真实运行"的结果，用来做相对比较，不是合格线。

## 已知边界

- 假面板不实现命令队列（`/api/internal/node/commands` 一律 404）。Agent 的控制循环
  会退避重试并打 debug 日志，不影响本基线测的路径（期望状态来自 `desired` 快照）；
- echo target 与采集器都在同一台机器上，因此数字里含采集器自身的成本。WS 的客户端
  分帧/掩码、TLS 的握手都在采集器这一侧，属于**同一类**成本（README 的"怎么解读"
  要求同机对比，也是为了不让它变成跨机器比较）；
- **已覆盖**：`tcp`（direct / relay 两个场景）、`tls`、`ws`。三种协议共用同一个
  stream 运行时，所以入口之外的路径（热重载 / 重启收敛 / 排空）只在 direct 上测；
- **未覆盖**：`udp`（V5.1b，datagram 生命周期，与 stream 不同，需要自己的场景与
  自己的指标口径——尤其不能沿用"建连/握手"这类 stream 概念）、`QUIC`（V5.1c），
  以及 `wss`（§6.1 明确它不是新的 protocol 值，而是待定的产品决策）；
- `tls` 场景依赖 `openssl` 生成证书。没有 `openssl` 时该场景**明确失败**（连带
  `direct relay` 之外的场景选择一起失败），不静默跳过。


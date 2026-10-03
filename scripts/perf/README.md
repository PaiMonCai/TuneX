# V5 TCP 性能基线（WP3）

> 冻结 V4/V5-G0 的 TCP 性能参照，避免"功能通过、性能退化"长期不可见
> （`DEVELOPMENT.md` §5.4）。

## 怎么跑

```bash
# 快速档（默认，几分钟内跑完）：日常改完代码自查
bash scripts/perf/v5-tcp-baseline.sh

# 接近真实链路量级：发布前人工对比
bash scripts/perf/v5-tcp-baseline.sh --profile full

# 只跑一个拓扑
bash scripts/perf/v5-tcp-baseline.sh --scenarios direct

# 采集器自检（纯函数，不需要 go / 端口）
python3 scripts/perf/test_v5_tcp_baseline.py
```

产物写到 `scripts/perf/results/`：同名时间戳的 `.json`（权威）与 `.csv`（便于画趋势）。

## 它测的是什么

| 指标 | 含义 |
|---|---|
| `<topo>_throughput` | 单连接吞吐（MiB/s）：建连 → 传输 → 读完回包 |
| `<topo>_connect_ms` | 建连耗时 |
| `<topo>_concurrent_throughput` / `_concurrent_rtt_ms` | 并发连接下的整轮吞吐与单连接往返 |
| `<topo>_hot_reload_apply_ms` | apply 换 target（revision+1）返回的耗时 |
| `<topo>_hot_reload_effective_ms` | apply 到**新 target 真的可用**的耗时 |
| `<topo>_restart_panel_ms` | 重启期间面板可达 → 端口重新可用的耗时 |
| `<topo>_restart_lkg_ms` | 重启期间面板不可达 → 从本地 last-known-good 恢复的耗时 |
| `<topo>_graceful_drain_idle_ms` | 空载 SIGTERM → 进程退出 |
| `<topo>_graceful_drain_held_ms` | **有在途连接**时 SIGTERM → 进程退出（有界排空上限） |
| `<agent>_gauges` | goroutine 数 / RSS / 累计 CPU |
| `<agent>_cpu_seconds_used` | 本轮负载消耗的 CPU（两次读数之差） |

每个数值都带 `median / p95 / min / max / mean / count`。**看中位数和 p95**，
`min`/`max` 在共享机器上只能说明当时有没有别的东西在抢 CPU。

## 拓扑是真的

- **DIRECT**：client → ingress Agent → echo target；
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
- echo target 与采集器都在同一台机器上，因此数字里含采集器自身的成本；
- 只覆盖 TCP/stream。WS/TLS（V5.1a）、UDP（V5.1b）、QUIC（V5.1c）各自需要自己的
  基线场景，并在对应 Gate 里加入。

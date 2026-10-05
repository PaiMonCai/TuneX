# V5-WP19 — 延迟历史 / 链路拓扑 / Looking Glass / 带宽跳测 契约（WP19-C0）

> **状态：草案（待 Lead 评审），2026-10-05。本文不含任何实现**：没有补丁、没有 Go/TS 代码，
> 不改代码 / schema / 其它文档，唯一产物是**语义与边界**。与 §6.1、§6.2、§7 同一条纪律：
> 每条结论要么指向仓库事实（`文件:符号名`），要么指向已冻结的 V5 不变量；
> 仓库无法唯一回答的一律进 §4「开放决策（不猜）」。
>
> 前置读数（`DEVELOPMENT.md` §17）：G0=137/0、G1A=73/0、**G1B=76/0（UDP DIRECT）**、G2=23/0、
> G3=50/0、G4=25/0、G5=206/0；UDP RELAY 与 QUIC 仍 fail-closed 关闭。
>
> 行号取自 2026-10-05 本工作树；并行编辑中，合并前请以**符号名**复核。
> 参考项目（Forwardx，AGPL-3.0）**只读、只参考语义、不复制代码**。

## 0. 六个必答问题的索引

| # | 问题 | 位置 | 状态 |
|---|---|---|---|
| 1 | 谁采、采什么、存在哪 | D1–D3、D5；现状 §1.1–§1.4 | 采集方/通道**冻结**；是否留历史**开放**（O1/O4） |
| 2 | `runtime_counts` 封闭键集 | D5 | **冻结** |
| 3 | datagram 的延迟怎么表达 | D6；现状 §1.5 | **冻结**（不提供 TCP 口径延迟） |
| 4 | Looking Glass 安全与多租户边界 | D7、D10；现状 §1.8 | 边界**冻结**；数值配额**开放**（O6/O7/O8） |
| 5 | iperf3 可选依赖的等价实现 | D9 | 原则**冻结**；做/不做**开放**（O5） |
| 6 | 与既有诊断 / Support Bundle 的复用点 | D8；现状 §1.6 | **冻结** |

## 1. 仓库现状事实

### 1.1 观测由 Agent 主动做；面板不反连、不下发探测任务
- `agent/internal/targetobs/observer.go:Observer.Run`（`:371`）：周期 `DefaultInterval=30s`（`:53`）、
  单次超时 `DefaultTimeout=3s`（`:61`）、并发 `DefaultConcurrency=8`（`:71`）、抖动 `±5s`（`:80`）；
  周期不重叠（`:363-366`）。
- 探测面来自**注入的 desired 读取器** `Config.Targets`（`:167`）；文件头（`:7-11`）
  「never scans, never takes a target from config/env」。
- 面板只有读路径：`backend/src/services/target-health-read.ts:readTargetHealth`（`:88`）→
  `target-health.ts:synthesiseTargetPool`（`:740`）。
- 依据 `DEVELOPMENT.md` §7 冻结结论 row 1：「**Agent**，不是 Panel」。

### 1.2 `target_observation` 是**投影**，不是历史
- `backend/prisma/schema.prisma:model TargetObservation`（`:1595-1628`），
  `@@unique([node_id, target_key])`（`:1625`）、`@@index([target_key])`（`:1626`）。
- 写入 = upsert + 删「不再观测」：`node-state.ts:syncTargetObservations`（`:750-779`，
  `deleteMany(... notIn: seen)` 在 `:778`）。
- `observation_age` **不落库**（§7 row 7；`target-health.ts:readObservation` `:453-454`）。
- **没有历史**：`DEVELOPMENT.md:1800` 的开放项原文就是「是否保留观测历史（当前只存
  每个 (节点,目标) 的最新一条投影）」。
- 粒度是 `(观测节点, target)` 二维（`node-state.ts:743-745`）；身份唯一实现
  `node-state.ts:targetKeyOf`（`:730-738`）与 Agent 侧 `observer.go:NormalizeHost/Identity`
  （`:116-144`），§7.3 已冻结「两侧必须同步，单改一侧 = 健康被静默丢弃」。

### 1.3 `runtime_counts` 是封闭键集，未知键拒**整份**上报
- `node-state.ts:isRuntimeCounts`（`:279-287`）未知键直接 false → 拒码 `bad_telemetry`
  （`:217`、`:491-492`），整份 400（隧道/端口/健康一起丢）。
- 键集唯一来源 `RUNTIME_COUNT_KEYS`（`:290`）；Agent 侧
  `agent/internal/reporter/telemetry.go:RuntimeCounts`（`:87-94`）。
- 注释（`:273-277`）说明理由：「放行一种未知种类…runtime 普查就是不完整的，而 health 仍说 healthy」。
- 第三、四份副本：`web/src/lib/node-health.ts:159-165`（键列表写死）、
  `web/src/lib/types.ts:1421`。

### 1.4 关键发现：新观测的通道**已经存在**，但面板只容忍不投影
- Agent 侧通用诊断块：`agent/internal/forwarder/diagnostics.go:ProtocolDiagnostics`（`:34-102`），
  随上报走 `agent/internal/reporter/heartbeat.go:ReportedTunnel.Diag`（`:184`，
  `json:"diag,omitempty"`；结构内嵌 `forwarder.TunnelConfig`，`:175-180` 注释：旧面板读到的
  JSON **逐字节不变**）。
- 该字段注释**已经**写出 §1.3 的约束并据此选落点（`diagnostics.go:76-83`）：
  「`runtime_counts` is a CLOSED key set on the panel side, and an unknown key there makes the
  panel reject the ENTIRE state report」。
- 面板校验**容忍**它：`backend/src/services/__tests__/node-telemetry-contract.test.ts`
  `describe("protocol diagnostics ride through the state report")`（`:269-323`），含
  「a malformed diag block does not invalidate the whole report」（`:313-322`）——
  与 capability/manifest 的 fail-closed **方向相反**。
- **但面板没有 `diag` 的一等读路径**：`node-state.ts:ReportedTunnel`（`:65-79`）无 `diag` 字段，
  `StateSnapshot` 也无；`tunnels` 只作 JSON 原样落库（`:861`）。`backend/src`、`web/src` 除测试外
  无 `ProtocolDiagnostics`/`diag` 消费点。
- ⇒ 今天 udp/tls/ws 的数据面事实是「上报 200、库里 JSON 有、**面板接口与 UI 永远读不到**」，
  即第三个「白名单陷阱」（`node-state.ts:571-573`、`:576-577` 已两次点名）。

#### 1.4.1 实测更正（2026-10-05，WP19-F 开工时核实）：`diag` 在哪里丢、在哪里**不**丢

> 上面 §1.4 的结论方向对，但"丢在哪"说错过一次（Lead 已更正）。写下来是为了下一个人
> **不用重新踩一遍**——这条缺陷有很强的误导性：它看起来很像是"落库路径丢字段"。

- **不丢**（落库路径是干净的）：
  - `node-state.ts:validateStateReport` 的 `tunnels` 白名单只逐项校验 `id`/端口/`revision`/
    `targets`，**未知字段整体透传**；投影里也有 `tunnels`。实测（在本工作树跑）：
    `validateStateReport({version, tunnels:[{id,mode,ingress_port,diag:{...}}]})` 的
    `report.tunnels[0].diag` **原样在**（含 `hop_local_addr`）；
  - `submitStateReport` 写的是 `tunnels: report.tunnels`（整块 JSON 列），所以
    `node_state_report.tunnels[].diag` **一直有值**；
  - 判据不止代码：`forward-contract.ts:datagramHopPeerFor`、`scheduler.ts`、`runtime-reconcile-sink.ts`
    今天就靠 `tunnels[].diag.hop_local_addr` 工作，① 的出口取证纠正在真拓扑上生效（G1B 77/0）。
- **丢**（面板的**类型化读路径**零消费点）：
  - `node-state.ts:ReportedTunnel` / `StateSnapshot` 没有 typed `diag`，全仓没有一处把
    per-tunnel `diag` 当成一等事实读出来（`backend/src`、`web/src` 都没有消费点）；
  - `node-health.ts:parseReportedRuntimes` 把上报的 `tunnels` 重建成 runtime 列表时只留
    `id/mode/ingress_port/egress_port/revision` ⇒ **`diag` 在这里被丢掉**，于是 health 遥测视图
    （`GET /api/admin/node/:id/health` 的 `telemetry.runtime`）与 UI 永远看不到；
  - `web/src/lib/types.ts:1296` 的隧道快照类型里没有 `diag`（**前端类型待补**，见 §5 WP19-F）。
- **为什么 G1B.12 却读得到**：gate 直接
  `SELECT IFNULL(tunnels,'[]') FROM node_state_report`（`scripts/v3-e2e/v5-g1b.py:tunnel_diag`），
  **绕过了面板接口**。这正好反过来证明"面板零消费点"，而不是"库里没有"。
- **后果的准确表述**：不是"少一个字段"，而是**一个把每个报文都丢掉的出口，和一个空闲的出口
  在面板上长得一模一样**（`drops` 读不到；且 Agent 侧零值 `omit`，"没有 diag 块"与"diag 里全 0"
  也是两个事实）。
- **修法（已交付，见 §5 WP19-F）**：落库投影显式带上 `diag`（坏形状整键丢弃、绝不 400）+
  类型化读取视图 `services/tunnel-diag.ts` + 面板读路径接线 + 源码级机械守卫。
  **不动** ACK 路径：诊断是观测路径，等一个上报周期是可接受的；把观测塞进可用性路径
  （控制协议封闭键集 + `parseAgentAck`/合成 ack/账本重放 + Go `control`）不成比例，
  而且会让正确性依赖遥测。

### 1.5 datagram 事实形状已冻结：**没有连接数**
- `docs/v5-1b-datagram-contract-draft.md` §4.4（`:330-349`）与 §6.1（`:443-461`）冻结
  `mappings_active/created/expired/rejected`、`packets_in|out`、分方向 `bytes_in|out`、
  按原因分类的 `drops`、`last_activity_at`，并**明确禁止**报告连接数。
- Agent 实现同源：`diagnostics.go:64-101`（UDP 键）注释「There is deliberately NO connection
  count here or anywhere else for a datagram tunnel」；`diagRecorder`（`:129-148`）；
  `datagram.go:DatagramForwarder.ProtocolDiagnostics`（`:444-448`）只补两个**非计数器**
  （live mapping 数、idle timeout，理由 `:440-443`）。
- 计数口径：只计真正送达（`diagnostics.go:216-230`）。

### 1.6 诊断通道的既有边界（四处，全部复用，不新建）
- `backend/src/services/forward-probe-plan.ts`：目标**只能**来自 desired（否则是 SSRF 工具）、
  **不许**拨业务监听端口（文件头 `:5-16`）；`PROBE_MAX_TARGETS_PER_SEGMENT=8`（`:29`），
  超限**拒绝而非截断**（`:140-147`）；`dialedTargets(plan)`（`:222-225`）是可断言口；
  三跳拆段 `ingress_to_middle`/`middle_to_egress`（`:153-189`）。
- `agent/internal/diag/probe.go`：硬上限是**常量不是配置**（`:35-48`：`MaxTargets=8`、
  `MaxTimeoutMS=5000`、`DefaultTimeoutMS=3000`、`TotalBudgetMS=15000`、`MaxDetailChars=160`）；
  封闭状态词表（`:50-69`）；`ErrTooManyTargets`（`:100-113`）；包级承诺「not a shell: nothing
  here reads files, runs commands」（`:10-11`）。
- `backend/src/services/node-diagnostics.ts`：**先判离线再决定是否发命令**
  （`NODE_OFFLINE_AFTER_SECONDS=75` `:21`、`NODE_DIAGNOSTICS_TIMEOUT_MS=12000` `:24`、
  `:104-123`）；下发前必须过 `decideCapability`（`:125-133`）。
- `backend/src/services/support-bundle.ts`：白名单采集 + 确定性脱敏（`:8-14`）、
  段/整体上限（`:27-31`）、超限显式 `truncated`（`:230-232`）、单一产物路径
  `finalizeBundle`（`:242-261`）、离线仍出产物（`:195-213`）、段落可见性 `BundleSections`
  显式无默认值（`:150-153`）。

### 1.7 能力协商：diagnostics 维度只用于展示，准入归 action
- `capability-manifest.ts:MANIFEST_DIAGNOSTIC_FEATURES=["tunnel_probe","node_snapshot"]`，
  注释明确「诊断的**下发准入**不在这里判定…否则同一件事会有两套真相」。
- 动作面 `agent-capability.ts:BASELINE_COMMAND_ACTIONS`（`:41`）；Agent 侧
  `agent/internal/control/protocol.go:ActionDiagnoseTunnel`（`:36`）、`ActionCollectDiagnostics`（`:39`）。
- manifest 纪律：缺失=baseline、坏形状=抛错（**不静默降级**）、未知条目名保留但**不构成许可**
  （`capability-manifest.ts:8-22`）；`CAPABILITY_MANIFEST_SCHEMA_VERSION=2`。

### 1.8 RBAC：今天**没有**「执行类」权限键
- `backend/src/services/workspace-permissions.ts:WORKSPACE_PERMISSIONS`（`:7-19`，11 个键，全为
  read/create/update/delete/manage 语义）；文件头：「Non-boolean/unknown keys or malformed maps
  invalidate the entire authorization map rather than widening it」。
- 诊断与 Support Bundle 只要求 `node:read`/`forward:read`（`node-diagnostics.ts:87`、
  `support-bundle.ts:160`、`:179`）。
- 协议授权在策略层：`capability-policy.ts:PolicyEntitlement.tunnel_types`（`:40`），
  `composeEffectivePolicy` 用 `platform_ceiling` 取**交集**收紧协议白名单（`:333-335`），
  拒绝码 `protocol_not_allowed`（`:81`）。
- 审计用既有 `db.auditEvent.create`（如 `routes/node-groups.ts:121`），无独立审计服务抽象。

### 1.9 Agent 是**静态非特权二进制**，全仓不 shell-out（对 iperf3 直接判死）
- `scripts/v3-e2e/setup.sh:66`、`.github/workflows/ci.yml:152-153`：`CGO_ENABLED=0 go build`。
- 非 `_test.go` 的 agent 代码**没有**任何 `os/exec`/`exec.Command`/`exec.LookPath`。

### 1.10 Gate 现状
- `scripts/v3-e2e/v5-g1b.py`：记分 `record(passed, message)`（`:72-77`）；纪律「missing topology,
  timeout, failed prerequisite or cleanup failure is a FAIL, never a skip」（`:22-23`、`:638`）。
- **`G1B.12 diagnostics`**（「the per-tunnel diag carries datagram facts, not a "connection"
  fiction」）与 **`G1B.10 port ownership`**（TCP/UDP 不同号）已存在（`v5-g1b.py:15`）。

## 2. Forwardx 先例与取舍

> 注：任务清单中的 `server/latencySeries.ts` / `latencyAggregation.ts` / `lookingGlassAccess.ts`
> 在参考树中**没有同名源文件**（只有 `*.test.ts`，测试内联了真实 SQL/DB 语义）。
> 下文凡引用它们都指**测试语义**，不是源码；未核实项见 §2.9。

- **2.1 采样两条路**：自采 + **节流上报**（`agent/tcping_report_gate_test.go`：稳态抑制 `:31-59`、
  失败/恢复立即整条拓扑上报 `:61-82`、5 分钟快照 `:99-122`、force 绕过 `:142-160`）；
  以及**面板下发任务**（`agent/selftest.go:selfTestPoller` `:33-57`，容量 256/并发 16 `:12-13`，
  `claimSelfTest` 去重 `:114-125`，队列满丢弃 `:68-75`；面板侧队列
  `server/lookingGlassAgentTasks.ts`，单 host 互斥 `:225-230`，终态保留 15min `:58`）。
- **2.2 存储**：按归属**拆表**的原始样本 + 读侧分桶。表与列见 `server/latencySeries.test.ts`
  `:52-73`、`:107-113`：`tcping_stats(ruleId,hostId,latencyMs,isTimeout,recordedAt)`、
  `tunnel_latency_stats(tunnelId,…,seriesKey,…)`、`forward_group_latency_stats(groupId,…)`、
  `host_probe_service_stats(serviceId,hostId,…)`。`seriesKey`（`primary`/`total`/`exit-N`）区分
  分支与合计（`server/tunnelLatencyDetails.ts:selectTunnelLatencyDetailPathKey` `:38-64`）；
  排序权威是**自增 id** 而非时间戳（`latencySeries.test.ts:107-109`「latest insertion id must win
  across a panel clock correction」）；24h 稠密窗口返回 600–1200 点（`:141-152`）、半小时桶（`:129-133`）；
  内存聚合显式 TTL 6 分钟（`server/tunnelMultiEntryLatencyState.ts:53`、`:78-90`）；
  刷新用版本号信号而非轮询（`server/tunnelLatencyRefresh.ts:3-57`）。
  **吸收**：`seriesKey` 思路、自增 id 排序、分桶读、TTL 显式化。
  **不吸收**：按归属拆表（TuneX 的归属真相只有一份 Forward/Node 模型）。
- **2.3 拓扑指纹**：`server/probeTopology.ts:tunnelProbeTopologyKey`（`:13-51`）把 hop 序列/端口/
  LB 策略摘要成 `tunnel:<id>:<digest>`；变更即失效（`tunnelLatencyDetails.ts:
  tunnelDetailsMatchTopology` `:120-186` 的 allowed/required edge 校验、
  `tunnelLatencySampleIsAfterBaseline` `:77-81`）；`server/ruleLatency.ts:
  canReuseRecentTunnelLatencySample`（`:64-90`）要求仍成功且样本不早于最近配置/测试更新（时钟偏斜 60s，`:8`）。
  **吸收**：样本必须能证明自己属于当前拓扑。**不吸收**：再发明一个哈希——TuneX 已有拓扑真相
  （`forward-probe-plan.ts:153-189` 的三跳段 + `config_revision`）。
- **2.4 UDP 的延迟先例**：`shared/latencyProbe.ts`（35 行）`isUdpOnlyProtocol` →
  `ruleLatencyProbeMethodForProtocol` 返回 `"ping"`（`:6-16`），并强制方法与协议兼容
  （`:26-31`）；`agent/selftest.go:handleSelfTest` 同判（`:138-141`）。
  **吸收方向**（没有连接就不能用 TCP 语义冒充）；**不抄方法**（ICMP 需 `CAP_NET_RAW`，与 §1.9 冲突）。
- **2.5 Looking Glass 的多租户边界（强先例，形态不能抄）**：
  `server/routers/lookingGlass.ts` 方法闭集 `z.enum([...7 种...])`（`:23`）、目标长度 ≤253（`:44-46`）、
  **解析后拒私网** `isPrivateAddress`（`:104-108`）、IPv6 需主机自身有 v6（`:201-203`）、
  每 host 单任务（`lookingGlassAgentTasks.ts:132-134`）。
  可见性（`server/lookingGlassAccess.test.ts:42-90`）：普通用户只见自有 host +
  `user_host_permissions` + 套餐内 host（`[1,3,5]`），admin 全量（`[1,2,3,4,5]`），
  全局开关 `lookingGlassUserEnabled=false` 时普通用户被拒（`:88-90`）。
  **吸收**：可见性过滤 + 拒私网 + 单 host 单任务 + 全局开关。
  **不吸收**：执行形态（面板下发方法名 → Agent shell-out，见 2.8）。
- **2.6 iperf3=可选依赖**：安装脚本原文（`server/agentInstallScripts.ts:938-963`）
  「iperf3 仅用于 Looking Glass 测试，单独安装，失败不得阻断 Agent 主流程」，各包管理器 `|| true`；
  运行时 `exec.LookPath("iperf3")` 不在就返回**结果**而非崩溃（`agent/main.go:4217-4231`）；
  服务端由面板任务 start/stop（`server/iperf3AgentTasks.ts`），单 host 互斥（`:79-86`）、
  队列 `slice(-10)`（`:96`）、30s 回报超时（`:74-76`）、空闲 3 分钟自停（`agent/main.go:54`）、
  `iperf3Mu` 单实例（`:275-276`、`:4244-4252`）。
  **吸收语义**「装不上 = 该功能不可用，不是故障」→ 在 TuneX 的等价物是 **capability 广告 +
  fail-closed 拒绝**（§1.7），**不是**装包脚本。
- **2.7 观测直接驱动动作（明确拒绝）**：`server/forwardGroupAutoLatencyState.ts`、
  `server/tunnelAutoLatencyState.ts`（grep 级确认）与
  `tcping_report_gate_test.go:84-97` 用例名「SendsAgentHealthDecisionWithUnchangedRawTimeout」——
  Agent 侧自下健康判定并随样本上报。这正是 §7「一次超时永不足以改变任何决策」、
  §7.3「禁止 observation 直接 delete target / 用 Agent 本地状态覆盖 Panel desired」的禁区。
- **2.8 不照搬的三件事**：① shell-out 多引擎（ping/mtr/traceroute/iperf3）当数据面；
  ② 容忍型自动动作默认打开（auto latency state）；③ 面板下发整份配置 / 工作项
  （`/api/agent/selftest-pull` 拉任务、`iperf3Tasks` 随心跳下发）。
- **2.9 未核实**：上述三个 `.ts` 源模块不存在（只有测试）；两个 auto-latency 文件仅 grep 级确认；
  Forwardx 延迟样本的**清理调度入口**未找到（只有一次性迁移与查询侧窗口截断），**不作先例引用**。

## 3. 冻结决策

格式：结论 / 依据 / 影响面 / 明确不做。

- **D1 观测面由 Agent 主动采集，面板不下发探测任务。**
  依据 §1.1、§1.4。影响面：周期/超时/并发/抖动的唯一来源是 Agent 侧常量（`observer.go:154-191`
  的 `Config` 模式）。**不做**：Forwardx 式轮询领任务（§2.1）；周期观测不是「任务」，无 id/领取/ACK。
- **D2 面板发起的一次性测试走既有命令总线 + action 协商，且必须过 `decideCapability`。**
  依据 §1.7、`node-diagnostics.ts:125-133`。影响面：`agent-capability.ts`（新 action）、
  `control/protocol.go`、Web 入口各一处。**不做**：第二条控制通道；面板内存队列 + 心跳捎带工作项。
- **D3 观测历史（若做）必须是独立档案：只 INSERT、不改既有事实表、可回答「属于哪个拓扑代次」、
  有确定保留期与配套索引、且不作为健康判定输入（判定仍只吃最新投影）。**
  依据 §7 row 4；§1.2（`syncTargetObservations` 的 upsert 语义决定它不能就地扩成历史）。
  影响面：schema 新 model + migration + 复用既有 worker 节拍清理 + 读路径/图表。
  **不做**：在 `target_observation` 上加历史行；引入外部时序库；把样本塞进
  `node_state_report.tunnels` JSON。
- **D4 观测不得成为第二份真相**：延迟/拓扑/带宽/LG 结果只能进 view / 档案 / 诊断产物，
  不得进 desired、admission、归属。要「用延迟做决策」必须走 §7 固定链第三段，
  且只能消费 `target-health.ts` 的五态结论，不得直接读原始样本。
  依据 §7 固定链与禁止项（`DEVELOPMENT.md:1696-1716`、`:1880-1885`）、
  `target-health.ts:1-7`/`:740-750`（纯函数、原样进原样出）。
  **不做**：Forwardx auto latency state（§2.7）；延迟超阈值自动切换。
- **D5 新观测走**已有通道**，本 WP 不动 `runtime_counts`。** ① 每隧道/每协议事实走
  `ReportedTunnel.diag`（additive）；② 若某天要加 `runtime_counts` 键，必须**同一 release 三处同步**
  （`telemetry.go:RuntimeCounts`、`node-state.ts:RUNTIME_COUNT_KEYS`、`web/lib/node-health.ts`
  键列表 + `web/lib/types.ts`），且旧面板仍可能收到新 Agent 上报时**不得**发布；
  ③ 新顶层字段必须写进 `validateStateReport` 的**投影白名单**，否则「校验通过、库里永远 NULL」；
  ④ 观测类坏形状**逐条丢弃**，不得升级为整份 400（与 manifest 方向相反）。
  依据 §1.3、§1.4、§1.7；`node-state.ts:571-577`、`:579-590`。
- **D6 datagram 不提供 TCP 口径的延迟，也不假装有连接。** ① udp 不复用 `tcp_connect` 口径，
  `observation_source` 必须如实（`observer.go:93` 是唯一现存值，新增须新增常量）；
  ② 在不引入 shell-out / raw socket 的前提下（§1.9），udp 的观测面就是 §1.5 已冻结的
  `mappings/packets/bytes/drops/idle_timeout`；③ 任何 udp 延迟展示必须标注口径与不可比性，
  或干脆不显示（`null` ≠ 0）；④ 「该协议不产生延迟事实」与「延迟读不到」在合成层必须可区分，
  否则会落到 `latency_unknown`（`target-health.ts:536-538`）被判 `degraded` —— 这条**需要产品决策**
  （O3），本 WP 不猜。依据 §1.5、§2.4。**不做**：给 datagram 造 `LiveConns`；用「无回包」冒充延迟；
  引入 ICMP/特权依赖。
- **D7 Looking Glass 的五条边界（同时成立）**：① 只能测本 workspace 内、调用者有权读的节点，
  跨租户一律拒绝；② 目标解析后**全部**为公网地址，私网/回环/链路本地/多播/保留段一律拒绝
  （别名域名也要解析后再判）；③ 同一节点同一时刻**至多一个**主动测试，配额数值未冻结前
  默认拒绝多余请求（fail-closed）；④ 部署级全局开关，**默认关闭**（与「先建立观测，再自动决策」一致），
  关闭时普通成员拒绝、管理员可用；⑤ 每次发起写审计（actor+node+方法+目标+结果码），
  结果只对发起者与有 `node:read` 的身份可见，不落 desired、不含数据面载荷。
  依据 §1.8、§2.5、§1.6、`DEVELOPMENT.md:2069`（§14「用户输入不能让 Agent 变成任意网络扫描器」，
  转引自已冻结的 datagram 契约 §2.4）。**不做**：任意命令执行；跨 workspace 借用节点；
  面板侧探测代理。
- **D8 复用既有诊断通道，不新建第二套**：目标来源与上限 → `forward-probe-plan.ts`；
  探测原语与预算 → `agent/internal/diag/probe.go`（调用而非复制边界检查）；
  命令下发与离线判定 → `node-diagnostics.ts`；产物打包 → `support-bundle.ts`
  （走 `redact`/`finalizeBundle`，计入 `BUNDLE_MAX_BYTES`）。依据 §1.6 全部四处。
  **不做**：第二个命令端点、第二个诊断端点、第二份脱敏、第二套离线阈值（75s 是唯一口径）。
- **D9 iperf3 不作为外部依赖；带宽测试要么 Go 内建（有硬上限），要么明确不做。**
  TuneX Agent 不 `exec` 任何二进制（§1.9），因此「装失败只提示」**不可等价移植**。
  若做，必须显式回答：谁对谁、时长上限、并发上限、取消语义、与业务转发的资源隔离；
  可用性走能力协商（未广告 ⇒ 面板在入队前拒绝）。依据 §1.9、§1.7、§2.6。**不做**：引入 `exec`、
  `CAP_NET_RAW`、特权容器、安装期副作用。
- **D10 结果可见性走既有 RBAC；如需新权限键，一次只加一个且 fail-closed。**
  依据 `workspace-permissions.ts:7-19` 与文件头纪律。**不做**：用 `node:manage` 代理执行权
  （把「能改节点」变成「能对任意公网目标发包」是权限放大）。
- **D11 新事实必须同时出现在「命令下发」与「重连快照」两条投递路径上，且 Agent 解码器要认识。**
  依据 `DEVELOPMENT.md:1963-1972`（V5-G2 的三个同源缺陷已被写成硬规则）；
  快照路径 `node-state.ts:buildReconnectSnapshot`（`:969-980`）。**不做**：只在命令路径生效的字段。
- **D12 fail-closed 与「未知 ≠ 0」**：缺字段=未知（不补 0）；stale=没有证据（不沿用最后结果）；
  越界不 clamp；不可比的量不并排成一条线。依据 `target-health.ts:9-20`、`:376-391`、
  `target-health-thresholds.ts:129-136`。

## 4. 开放决策（不猜）

> ### 4.0 Lead 裁决（2026-10-05）：O1 / O2 / O3 / O4 **已冻结**
>
> 下面四条已由开发 Lead 拍板；**各自的候选与代价原样保留在后续列表里**，供将来追溯
> "为什么当时没选另一条"。O5–O9 仍然开放。
>
> **O1 + O4 —— 做历史，但按独立档案表做。**
> 形态：**只 INSERT 的独立档案表**，与 `target_observation` 投影**并列而非写入它**：
> 投影回答"现在怎么样"，档案回答"过去怎么样"，两者互不写入。保留期取
> **原始 24h + 小时桶 30d** 作为**配置默认**（可调），索引与清理成对，沿用既有
> history-cleanup 模式。硬约束维持 D3/D4：档案**永不**作为健康判定输入，也永不反驱
> 归属。本次裁决**正式关闭 `DEVELOPMENT.md` 的既有开放项"是否保留观测历史"**——
> 该处措辞由 Lead 统一更新，本 WP 的 DoD 里记一条"待 Lead 更新 §7/§17 对应措辞"。
> 归属：写进**本文件 §3**，不新开契约文档（仓库纪律：一种能力一份契约）。
>
> **O2 —— 做 Looking Glass，按 D7 的五条边界，且必须先过安全评审。**
> 形态：新 control-protocol action（走既有命令总线 + `decideCapability` 前置）；目标
> 解析后必须全为公网；单节点同时至多一个；部署级开关**默认关闭**；每次写审计且不含
> 数据面载荷。它**自己一个 WP + 自己的 Gate**，排在 WP19-F 之后，文档里注明"上线前
> 需独立安全评审"（与 federation 同一条纪律）。
>
> **O3 —— v1 不产生 udp 延迟事实。**
> 明确不做 ICMP、也不做应用层回声探针：**没有可靠来源就不造指标**。**不改** §7 已冻结
> 的合成语义（不新增第四种表达）。"本协议不产生该事实"与"读不到"的区分记为**已记录的
> 延后项**（原候选 A/D 的张力保留在下方），等将来单独评审——它动的是已冻结契约，
> 不能在本文顺手改。
>
> **优先级：WP19-F 采纳。** 把已在线上跑的 `diag` 变成面板一等事实，属**既有缺陷
> 收口**、不需要任何开放决策、成本最低；但它属于 ④，**排在 ①（UDP RELAY）之后**执行。
> `G19.1` 设计成"初始必然 FAIL"来钉住该缺陷的做法保留——那是可复现的证据，不是断言。

- **O1 是否落历史 / 保留期 / 降采样**。A 不落库（维持今天；代价：回答不了「过去 24h 抖不抖」，
  本 WP 只剩拓扑与 LG）；B 原始 24h + 小时桶 30d（代价：体积 = 节点 × 目标 × 2880 行/天，
  必须先证明清理按索引可删）；C 只落分钟/小时聚合（体积可控，但丢样本级事实，
  「抖动不能被平均掉」在历史视图里做不到）。**注**：`DEVELOPMENT.md:1800` 已有同一条开放项。
- **O2 面板是否下发一次性测试任务**。A 只读诊断（最保守，LG 价值≈0）；B 新 action + 白名单
  （D2/D7 的推荐形态，但新增攻击面，需独立 Gate 与安全评审）；C 不做 LG。
- **O3 UDP 的延迟口径**。A 不提供（推荐；需 UI 明确表达「本协议不产生该事实」，否则会落
  `degraded`）；B 应用层回声（会把探测流量注入业务路径，多数 UDP 服务不回声）；
  C ICMP（需特权，与静态二进制冲突）；D 把 `latency_ms` 显式标「不适用」并让合成层区分——
  这是 A 的必要补充，但**动的是已冻结的合成语义**，必须走 §7 评审，不能在 WP19 顺手做。
- **O4 历史与既有 §7 开放项的关系**：O1 若选 B/C 等于替 Lead 关闭 `DEVELOPMENT.md:1800`
  的开放项，且与 §7 row 4 的精神有张力。**需明确：由本文提出，还是另立契约。**
- **O5 带宽测试**。A 不做（与 §17「optional 能力保持关闭」同一取向）；B Go 内建 agent↔agent
  吞吐（需新并发/资源上界、抢带宽隔离、新 Gate）；C 只读容量采样（测的是"刚跑了多少"，
  易被误读为"还能跑多少"）。
- **O6 目标白名单策略**：仅公网单播 / 用户显式声明的 CIDR 白名单 / workspace 白名单 + 平台黑名单。
  差异在「谁承担误配置风险」，属产品决策。
- **O7 配额与速率数值**：每 workspace 每日次数、每节点并发、单次时长上限、单次目标数上限。
  数值应集中在一处常量表（参照 `target-health-thresholds.ts` 纪律：每项注明保护什么），
  但**取值**是产品决策。
- **O8 是否新增 RBAC 键与审计动作名**：新键（如 `networktest:run`）/ 复用 `node:manage`
  （D10 反对）/ 仅管理员可用（不进 RBAC 体系，但审计仍需要）。
- **O9 跨租户聚合**：今天 `target_observation` 经 `Node → NodeGroup → workspace` 隔离，
  新表必须继承同一条链；任何跨租户看板都是新契约，不在本 WP。

## 5. WP 拆分

| WP | 名称 | 范围 | 依赖 |
|---|---|---|---|
| WP19-A | 契约（本文） | 语义/边界/Gate 映射 | — |
| **WP19-F** | **`diag` 的面板读路径（建议先做）** | 把线上已在跑的 `ReportedTunnel.diag` 变成面板一等事实（校验+投影+Web），收口 §1.4 | 无 |
| WP19-C | 链路拓扑与逐跳明细 | 复用 route plan / 三跳段（`forward-probe-plan.ts:153-189`）与 diag 逐跳结果；**不新建拓扑真相** | 无 |
| WP19-B | 延迟历史序列 | 新表+保留期+清理+读路径+Web 图 | O1/O4 |
| WP19-D | Looking Glass | 新 action + 白名单 + 配额 + 审计 + 视图；复用 D8 四处 | O2/O6/O7/O8 |
| WP19-E | 带宽 / 跳测 | Go 内建等价物 或 明确不做 | O5 |

### 5.1 WP19-F 交付记录（2026-10-05，④）

- **落地范围**（Lead 裁决：只做**上报侧一等化**，**不动 ACK 路径**——诊断是观测路径，
  不塞进可用性路径）：
  - `backend/src/services/tunnel-diag.ts`（新）：`diag` 的**类型化读取视图**。键集开放
    （未知键照样进视图）、坏值（嵌套/NaN/Inf）不进视图、视图有界且越界标 `truncated`、
    **永不回写原始块**（`hop_local_addr` 通路与 G1B.12 的原始 JSON 必须原样）；
  - `backend/src/services/node-state.ts`：`ReportedTunnel.diag` typed；新增 `projectReportedTunnels`
    显式投影（`diag` 原样带走，坏形状整键丢弃、绝不 400）；快照读取/重连快照（重放面）
    继续整块透传并加注；
  - `backend/src/services/node-health.ts`：`parseReportedRuntimes` 带上 `diag`
    （**这里就是过去丢它的那个重建点**，`undefined` ≠ `{ facts: {} }`）；
  - `backend/src/services/node-health-service.ts`：health 遥测视图新增
    `telemetry.runtime.diags`（按 runtime id 索引）——**面板接口第一次能读到 per-tunnel diag**；
  - 机械守卫 + 行为断言：`backend/src/services/__tests__/v5-wp19/`（源码级边界守卫，
    锚点唯一 + 窗口内**代码级**片段；另加"原始通路读点仍读原始 `tunnels[].diag`"的锚点，
    见 Lead 追加要求）。
- **明确未做 / 待补**：`web/src/lib/types.ts`（前端类型与展示）**待补**，本 WP 不触碰 `web/`
  （范围外）；ACK 路径按裁决不动；`diag` 不进 `runtime_counts`（封闭键集）。
- **Gate**：G19.1 的"面板接口可见"现在落在 `GET /api/admin/node/:id/health` 的
  `telemetry.runtime.diags`；G19.2（未知 diag 键不毁上报）由行为断言直接钉住。
- **证据**：`bun test src/services/__tests__/v5-wp19/` → **23 pass / 0 fail / 100 断言**；
  加相关既有文件（`node-telemetry-contract` / `node-health` / `v5-wp5-b2-ack-field-flow`）
  → **95 pass / 0 fail**；`bunx tsc --noEmit` 本 WP 文件 0 报错。G19.1 的**端到端**条目仍需
  真拓扑（跑 tls/ws/udp 三条并读面板接口），本次只覆盖到"面板接口能读到"的那一层。

### 5.2 WP19-B 交付记录（2026-10-05，④）

- **落地范围**（Lead 裁决 O1+O4：独立档案表、只 INSERT、原始 24h + 小时桶 30d）：
  - schema（**纯 additve**）：`TargetLatencySample`（`@@map("target_latency_sample")`，
    BigInt 主键 + `observed_at` / `(node_id, target_key, observed_at)` 两条索引）与
    `TargetLatencyHourly`（`@@map("target_latency_hourly")`，唯一键
    `(node_id, target_key, hour_start, observation_source)` + `hour_start` 索引）；
    迁移 `20261032000000_v5_wp19_latency_history`（两张表 + 两个外键，零既有列改动、
    零回填；索引/约束名与 Prisma canonical 名逐字一致，避免 `migrate diff` 漂移）；
  - `backend/src/services/latency-history.ts`：保留期解析（脏值回落默认，**绝不**"一条不删"
    或"全删"）、UTC 整点口径、聚合 merge（`success + failure == sample_count` 不变量，
    两次聚合间不自洽则整条跳过而不是 clamp）、rollup（只处理已结束且过了 1h grace 的小时，
    `create` + 唯一冲突跳过 ⇒ 桶表只追加）、prune（按索引边界删）、读路径
    （`sample` / `hour` 两种粒度，`sample` 窗口超出原始保留期时**显式拒绝**而不是返回空序列）；
  - `node-state.ts`：同一份观测在 `syncTargetObservations` 之后**追加**进档案
    （身份仍用同一个 `targetKeyOf`；写失败 fail-soft，不拖垮上报）；
  - `worker.ts`：新 cron `cron_latency_history`（每小时 :15，**先聚合后清理**——顺序反了会在
    "原始行已删、桶还没建"的窗口里永久丢一段历史）。
- **保留期配置**：`LATENCY_RAW_RETENTION_HOURS`（默认 24）/`LATENCY_BUCKET_RETENTION_DAYS`
  （默认 30），走既有 `system_config` 的**字符串键**读取（`services/config.ts:getConfig`
  本来就接受任意键名）。**刻意不新增 `SystemConfigName` 枚举成员**：那是 MySQL enum 列，
  加值要 `ALTER TABLE ... MODIFY COLUMN`，在共享 schema 上与并行 WP 冲突；将来要进管理端
  下拉再补（纯 additive）。
- **明确不做 / 待补**：Web 图表与前端类型（`web/` 范围外，**待补**）；跨租户聚合（§8 第 11 条）；
  分钟桶（裁决只给了原始 + 小时两档）；档案**永不**作为健康判定输入（D3/D4，没有任何判定
  路径 import 本模块的读函数）。
- **证据**：`bun test src/services/__tests__/v5-wp19/` → **45 pass / 0 fail / 179 断言**
  （其中 WP19-B 22 条：保留期回落、UTC 边界、聚合不变量、G19.8 的"超期消失/未超期完好/
  桶先建后删"、先聚合后清理的调用顺序、读路径"空 ≠ 被清理掉了"）。G19.8 的**端到端**条目
  仍需真拓扑（写入真实上报 + 触发 cron），本次只覆盖到纯函数与流水线替身层。
- **失败语义**：写路径 fail-soft（附着在节点上报上，不能因为档案失败把上报打成 500）；
  维护作业**不吞错**（表缺失/DB 故障由 worker 的 failed 事件显式暴露 + BullMQ 重试），
  因为静默失败会让"档案在跑"这个假设长期不成立，而原始样本 24h 后就不可恢复。



### 5.3 WP19-D 交付记录（2026-10-05，④）

- **落地范围**（O2 裁决的执行：新 action + 白名单 + 默认关 + 既有四处复用）：
  - `backend/src/services/looking-glass.ts`（新）：策略与编排的全部纯函数 + 生产装配。
    含**唯一**的地址准入函数 `classifyTargetAddress`（规范 IPv4/IPv6 解析 → 非公网段表 →
    映射形式先还原）、`NON_PUBLIC_V4_RANGES`/`NON_PUBLIC_V6_RANGES`（逐条注明命中说明）、
    写法变体判定 `looksLikeAddressLiteralVariant`、目标计划 `planLookingGlassTargets`
    （用户输入 → 解析 → 公网判定 → **钉死地址**）、单飞锁 `LookingGlassLocks`、
    结果归一 `normalizeLookingGlassResults`、编排 `runLookingGlass`、开关解析
    `lookingGlassEnabledFromEnv`；
  - `backend/src/routes/looking-glass.ts`（新）：`GET /status` + `POST /nodes/:id/tests`；
    **路由工厂**（可注入 service/workspace/nodeId 解析/管理员判定），因此四类拒绝能在
    不连 DB/Redis 的测试里逐个钉死；
  - `backend/src/services/control-protocol/{types,validator,index}.ts`（**增量**）：
    `COMMAND_ACTIONS` += `looking_glass`、`ACTION_SPECS.looking_glass`（只读 / node /
    revision 0）、`ACTION_PAYLOAD_KEYS.looking_glass = {method, targets, timeout_ms}`
    与形状校验、线形上限常量 `LOOKING_GLASS_MAX_TARGETS=4`/`LOOKING_GLASS_MAX_TIMEOUT_MS=5000`；
  - `backend/src/services/agent-command-bus.ts`（**增量**）：`QueuedAgentCommand.looking_glass`
    兄弟字段（与 `probe` 并列，理由见该字段注释）、`enqueueAgentCommand` 末尾可选参数、
    `issueAgentLookingGlass`、ACK 覆盖性校验从 `diagnose_tunnel` 推广到"探针形状动作"；
  - `agent/internal/diag/lookingglass.go`（新）+ `lookingglass_test.go`：Agent 侧独立复判
    （同一张非公网段表）、**只拨字面地址**、先校验全部目标再发第一个包；
  - `agent/internal/control/protocol.go` / `client.go`（**增量**）：新 action 常量 + 广告 +
    分派臂 + `QueuedCommand.LookingGlass` 兄弟字段；
  - `backend/src/env.ts`（**增量**）：`lookingGlassEnabled`，默认关闭；
  - 测试：`backend/src/services/__tests__/v5-wp19/v5-wp19-d-looking-glass.test.ts`、
    `backend/src/routes/__tests__/v5-wp19-d-looking-glass-route.test.ts`；
    `control-protocol.test.ts` 的"动作清单冻结断言"**有意**扩一项（理由写在该测试文件里：
    这是契约扩容，不是放宽）。
- **四个关键设计决定**（都为了"少一个会静默失效的边界"）：
  1. **面板解析、节点只拨字面地址**：命令里带的是**钉死的公网字面量**，Agent **不做任何
     名称解析**。这让 DNS 重绑定（TOCTOU）在结构上不成立，而不是"靠检查挡住"。代价：
     本功能**不能**回答"节点侧 DNS 能否解析该域名"——写进 `caveats`，不假装覆盖。
  2. **两侧各自实现同一张策略表**：面板判一次、Agent 再判一次，因此"面板被攻破/有 bug"
     不足以让私网包发出去。两侧用同一张测试向量表（`lookingglass_test.go:lookingGlassVectors`
     与 `d-looking-glass.test.ts:ADDRESS_VECTORS`）证明一致性——只断言 allow/deny 这一位，
     不断言拒绝文案（两侧解析器不同，文案绑死只会制造无意义的红）。
  3. **结果复用既有 ACK 字段 `results`**：`diagnose_tunnel` 已经把它走通了（五处逐字段重建
     全部带它）。**不新增 ACK 字段**＝少一个"漏了某处重建 ⇒ 面板永远读到 null"的机会。
     命令下行必须加兄弟字段，因此下行链的每一处都用源码级守卫钉住（见 §5.3 证据）。
  4. **开关关闭时的答复是明确拒绝**：`403 + code=looking_glass_disabled + error_layer=capability`
     + 文案里指回环境变量名。**不是**空结果、不是 200 + 空列表。
- **契约内部张力的裁决（留痕，免得下一个人重开）**：任务约束 3（"关闭时明确拒绝"）与 D7④
  （"关闭时普通成员拒绝、管理员可用"）字面有张力。**Lead 2026-10-05 裁决：按 D7④ 执行**，
  两个前提：① 关闭时的拒绝必须是**明确 code**（已做）；② 管理员越权使用必须在审计里
  一眼可辨（`admin_override: true`，已做）。理由：默认关要防的是**租户**把它当免费探针；
  "关掉之后运维自己也看不了"会把一个排障能力变成死开关。
- **O7（配额数值）仍未冻结 ⇒ 显式拒绝形态**：本 WP **不实现**"每 workspace 每日次数"这类
  数值配额（数值是产品决策），已冻结的只有 D7③ 的**每节点单飞**；超限**拒绝而非排队**
  （排队会让调用者以为"我发起了"，而它可能一分钟后才从客户机房发包）。
- **明确未做 / 待补**：
  - **多副本部署下的全局单飞**：锁是进程内的（`LookingGlassLocks`），多副本时可以各自放行
    一次。这是**已知且记录**的边界（TTL 30s 有界，不会永久锁死），要修就得引入 Redis 锁 ——
    在 O7 数值冻结时一起做；
  - **真拓扑端到端 Gate**（G19.9/G19.10/G19.13 的"真节点"半截）：见证据文件 §6/§7，
    本 WP 只覆盖到"拒绝发生在发包之前"的替身层；
  - **Web 入口**（`web/` 范围外）：前端类型与按钮待补；
  - **HTTP/TLS 探测**（重定向/降级/凭据那一整类威胁模型）：不做，另立契约；
  - **每日次数/速率配额**：不做（O7 开放）。
- **路由挂载（本提交**不含**，需 Lead 落）**：`backend/src/app.ts` 当前有别的 WP 的在途改动
  （13 行 announcements 挂载），为避免"扫走别人在途文件"，本 WP 不提交它。需要的一行：
  ```diff
  --- a/backend/src/app.ts
  +++ b/backend/src/app.ts
  @@
  import { nodeHealthRoutes } from "./routes/node-health.ts";
  +import { lookingGlassRoutes } from "./routes/looking-glass.ts";
  @@
     app.route("/api/route-profiles", routeProfilesRoutes);
  +  // V5-WP19-D：Looking Glass（默认关闭；打开见 LOOKING_GLASS_ENABLED）。
  +  app.route("/api/looking-glass", lookingGlassRoutes);
  ```
- **证据**：`docs/evidence/v5-wp19-d-looking-glass-20261005.txt`
  —— 服务层 **150 pass / 0 fail / 474 断言**；路由层 **11 pass / 0 fail / 45 断言**；
  含既有文件的回归 **344 pass / 0 fail / 1206 断言**（连跑 3 次一致）；
  `bunx tsc --noEmit` 本 WP 文件 0 报错；`go build ./...` OK；
  `go test ./internal/diag/ ./internal/control/` 两个包全绿。

### 5.4 WP19-D 安全审查（面向上线前独立评审）

> 这一节回答的不是"我们实现了什么"，而是"**我们检查过哪些绕过路径、哪些明确不防、为什么**"。
> 结论按"能防 / 不防但已记录 / 结构性不存在"三档给出，避免把"不存在这条代码路径"读成"忘了处理"。

| # | 绕过路径 | 结论 | 依据 / 为什么 |
|---|---|---|---|
| 1 | **重定向跟随**（3xx 跳到内网） | **结构性不存在** | 本功能只做 TCP connect（`tcp_connect` 是唯一方法），**不发任何 HTTP 请求**，因此没有 3xx 概念、没有 Location 头、没有 cookie/凭据可被重放。将来若加 HTTP 探测：必须逐跳重判公网、禁止降级、禁止携带凭据，且另立契约。 |
| 2 | **DNS 重绑定（TOCTOU）** | **能防（结构性）** | 面板解析一次并把地址**钉死**进命令；Agent **只拨字面地址**、自己不解析（源码级守卫：`lookingglass.go` 的执行代码里不得出现任何解析调用）。两次判定针对同一个字节序列，中间**没有第二次解析**，所以重绑定没有窗口。 |
| 3 | **HTTPS 降级** | **结构性不存在** | 没有 TLS 会话、没有 HTTP 层，谈不上降级；TCP connect 不发送任何字节，因此不可能泄漏 header/cookie/证书信任问题。 |
| 4 | **写法变体**（十进制 `2130706433`、八进制 `0177.0.0.1`、十六进制 `0x7f000001`、短形式 `127.1`、前导零、尾点、段数过多） | **能防（拒绝而非解释）** | 面板侧先判"规范字面量"，**不解释**任何非规范写法，并且**不把它们交给解析器**（测试断言解析器替身调用次数 = 0）；Agent 侧用 `netip.ParseAddr`（严格）同样拒绝。`::ffff:127.0.0.1` 这类映射形式**先还原成内嵌 IPv4 再判定**，所以映射不是绕过；大小写归一；方括号 `[::1]` 与 zone id `fe80::1%eth0` 在**两侧都拒绝**（两处规则不对称比一种写法被拒更难查）。 |
| 5 | **内嵌 IPv4 的 v6 隧道形式**（6to4 `2002::/16`、Teredo `2001::/32`、NAT64 `64:ff9b::/96`） | **能防（整段拒绝）** | 不做内嵌解析：把一个内网 v4 包装成 v6 是这类地址的正当用途，逐段判断只会给绕过留缝，因此整段拒绝。 |
| 6 | **别名域名打内网**（split-horizon、CNAME/AAAA 指向内网） | **能防（整请求拒绝）** | 解析结果里**每一个**地址都必须是公网单播；任何一个不合格 ⇒ 整请求拒绝（不是"跳过私网那条"）。地址数超上限 ⇒ 拒绝而非截断。解析失败 ⇒ 明确拒绝，**不**退回"让节点自己解析"。 |
| 7 | **扫描放大 / DDoS 跳板** | **能防（有界）+ 一处未冻结** | ≤4 个用户目标、解析后 ≤4 个地址、无端口范围语法、无排队、每节点单飞、每次发起写审计。**没有**"每日次数"配额：那是 O7 的开放数值决策，本 WP 不猜（不假装支持）。 |
| 8 | **审计绕过** | **能防（fail-closed）** | 三类事件：`test_refused` / `test_issued` / `test_completed`；审计写失败（返回 false 或抛错）⇒ **拒绝发起**（"没有记录的主动探测"不成立）。管理员在关闭状态下使用时，审计行带 `admin_override: true`。 |
| 9 | **能力绕过**（旧 Agent / 未广告动作） | **能防（入队前）** | 面板 `decideCapability(..., "looking_glass")` 前置拒绝（新动作**不在** baseline，未上报即拒绝），测试断言"整条请求 < 500ms 返回"以证明没有 ACK 等待窗口；Agent 侧的能力广告是编译期常量 + `TestAdvertisedCapabilitiesMatchExecute` 钉住。 |
| 10 | **面板被攻破 / 面板有 bug** | **能防（防御纵深）** | Agent 侧独立复判同一张策略表：**面板放行不足以让私网包发出去**。这是本设计里最重要的一条：把"信任面板"从安全边界里去掉。 |
| 11 | **跨租户借用节点** | **能防** | 节点查询按 `(nodeId, workspaceId)` 成对；不匹配 ⇒ 404（不泄漏节点是否存在），连 DNS 都不做，零下发，审计记录 actor。 |
| 12 | **结果里夹带凭据/载荷** | **能防** | 结果**逐字段重建**（未知字段丢弃）、状态闭集、detail 截断 160 并过 `redact`；`resolved_ip` 非空 ⇒ **整份结果拒绝**（那是"节点做了名称解析"的证据，比删字段更有价值）。 |
| 13 | **"关闭"被实现成静默空结果**（最容易被忽略的一条） | **能防** | 关闭 ⇒ 403 + `code=looking_glass_disabled` + `error_layer=capability` + 文案指回环境变量名；有测试钉住"有 code、有 error_layer、不是空列表"。 |

**明确不防（写清楚比假装安全重要）**：

- 不防**目标地址本身属于攻击者**：他会看到"某个公网节点连过我"。这是这个功能的本意
  （证明可达性）的固有代价，不是缺陷；因此它**默认关闭**并需要独立评审。
- 不防**路由/BGP 劫持**把包带到别处：我们能保证"只发给这个公网地址"，不能保证"这个地址的
  运营者是谁、路径经过谁"。
- 不防**"公网 IP 其实 NAT 到内网"**：我们只能判地址；这类目标会被真的连上（一次 TCP 连接
  就能证明某公网端口开着）。
- **不做节点侧 DNS 诊断**：解析由面板完成（这是防重绑定的代价）。split-horizon 部署下，
  报告反映的是**面板看到的地址**；这一点必须出现在 `caveats` 里（已做）。
- **单飞锁不是分布式的**：多副本面板可以各自放行一次（有 TTL，不会永久锁死）。已在 §5.3
  记为待办。
- 不做速率令牌桶、不做每日配额（O7 未冻结）。

**上线前要求**（沿用 §4.0 O2 的纪律）：独立安全评审 + G19.9/G19.10/G19.13 的真拓扑条目
（见证据文件 §6/§7 的未覆盖清单）。

推荐顺序：**F → C → D → B → E**（F 是既有缺陷收口、成本最低；C 不需开放决策；
B/D/E 各被一个开放决策卡住）。纪律：一次只做一个 WP，每个自带 Gate，不改 desired 语义。
（2026-10-05 实施状态：F、B、D 已交付；C 在途。）

## 6. DoD

1. §4 每条开放决策要么已由 Lead 拍板、要么在实现中**显式拒绝**（不是默认放行）；
2. 每个落地 WP 有：纯函数层单测 + 端到端 Gate 条目 + `docs/evidence/` 结果文件；
3. `diag` 新增键**不**出现在 `runtime_counts`（脚本断言三处键集互斥）；
4. 新事实在命令与快照两条路径都能到达 Agent（D11 断言化）；
5. 新字段出现在 `validateStateReport` 投影白名单里，并有单测钉住「校验通过 ⇒ 值真进得了库/视图」；
6. LG 四个负例端到端断言（私网目标 / 跨租户 hostId / 超配额 / 未广告 action 的 Agent），
   且**拒绝发生在发包之前**；
7. 观测类坏形状逐条丢弃、整份仍 200（方向与 capability fail-closed 相反，需单测钉住）；
8. Support Bundle 纳入新事实后仍满足白名单 + 脱敏 + 字节上限；
9. 不破坏 V4 冻结基线：G0/G1A/G1B/G2 在同一镜像上回归通过。

## 7. Gate 映射（`scripts/v3-e2e/`）

模型沿用 `v5-g1b.py`：逐条 `record()`（`:72-77`），证据落 `docs/evidence/`，
**缺拓扑/超时/前置失败/清理失败一律 FAIL，不是 skip**（`:22-23`、`:638`）。

| # | 检查 | 可执行动作 | 断言 |
|---|---|---|---|
| G19.1 | `diag` 到得了面板 | 跑 tls/ws/udp 各一条，读节点视图 | 三种 diag 键在**面板接口**可见（今天读不到 ⇒ 本条目初始为 FAIL，即 WP19-F 的理由） |
| G19.2 | 未知 diag 键不毁上报 | 造带未知 diag 键的上报 | 200，且隧道/端口/健康仍在 |
| G19.3 | `runtime_counts` 未污染 | 抓真实上报 | 键集恒为 `{direct,relay_ingress,relay_egress,total}` |
| G19.4 | udp 无连接数 | 读 udp diag | 无任何 connection 语义字段；`mappings` 随客户端数增长 |
| G19.5 | udp 不产生 TCP 口径延迟 | 读 udp 目标合成结果 | 不出现 `tcp_connect` 产生的延迟事实 |
| G19.6 | 节流不丢事实 | 连续两周期样本 | 稳态不重复上报，但变化时立即上报（若采用 §2.1 节流） |
| G19.7 | 拓扑段 == 失败跳 | 三跳 Forward 打断中间跳 | 失败段名与 `forward-probe-plan.ts:SegmentName` 一致 |
| G19.8 | 历史保留期 | 写超期样本 + 触发清理 | 按索引清理、超期行消失、未超期完好（O1 选择落库时） |
| G19.9 | LG 拒私网 | 对 `10.0.0.1`/`127.0.0.1`/`169.254.x` 发起 | 拒绝且 Agent 侧**零执行** |
| G19.10 | LG 跨租户拒绝 | A 身份用 B 的 nodeId | 拒绝，不产生任务 |
| G19.11 | LG 单节点单任务 | 并发两条 | 第二条被拒，第一条不受影响 |
| G19.12 | LG 未广告 action | 旧 Agent | 面板**入队前**拒绝，无超时等待 |
| G19.13 | LG 结果脱敏 | 发起一次测试 | 产物不含数据面载荷/凭据（同 `G1B.13` 模型） |
| G19.14 | 快照路径不丢新事实 | 重启 Agent 走快照恢复 | 新事实仍在（D11；模型：G2 三个同源缺陷） |
| G19.15 | TCP/UDP 回归 | 重跑 G0/G1A/G1B 关键项 | 全绿，不得因本 WP 翻转 |

**WP19-D 实施状态（2026-10-05）**：G19.9–G19.13 已在**单测层与路由层**落地——替身层
断言"拒绝发生在发包之前"（`issue` 替身调用次数 = 0），Agent 侧断言"整请求拒绝且
`dialed == 0`"。**真拓扑那半截**（真节点 + 抓 Agent 日志与产物 + A 身份用 B 的 nodeId）
尚未覆盖：本工作树没有可用 docker 拓扑，且任务纪律要求不动 docker/e2e 拓扑；它需要等
①（UDP RELAY）线落地后在 `v5-g1b` 那套里补。逐条覆盖与"为什么没覆盖"见
`docs/evidence/v5-wp19-d-looking-glass-20261005.txt` §6/§7。
G19.11 另有一条**已知边界**：单飞锁是**进程内**的，多副本部署时不是全局锁（§5.3 待办）。

**不改既有 Gate**：`G1B.12`/`G1B.10` 保持原样；若被本 WP 弄红，那是回归，不是「改断言」。

## 8. 明确不做

1. 不引入 shell-out 多引擎当主数据面（§1.9 是仓库事实）；
2. 不做容忍型自动动作默认打开（不做 auto latency state）；
3. 不做面板下发整份配置 / 工作项；
4. 不新建第二套状态机、第二份 desired、第二个诊断通道、第二个端口所有权模型；
5. 不让观测成为第二份真相：延迟/带宽/LG 结果不反驱归属、不进 admission；
6. 不给 datagram 造连接数；
7. 不在本 WP 扩 `runtime_counts` 键集；
8. 不让用户输入直接决定被拨地址（`forward-probe-plan.ts:5-16` 的 SSRF 边界）；
9. 不做跨 workspace 借用节点的万能扫描入口；
10. 不做「装了外部依赖才有功能」的安装期副作用；
11. 不做跨租户历史聚合；
12. 不因为「参考项目这么做」绕过以上任何一条。

## 9. 风险

| # | 风险 | 依据 | 缓解 |
|---|---|---|---|
| 1 | **`diag` 半实现**：上报 200、界面永远没有 | §1.4 | WP19-F 先做；DoD 5 |
| 2 | 历史被当成权威事实（第二份真相） | §7 row 4 | D4 + UI 标注口径/新鲜度 |
| 3 | LG 成为 SSRF/DDoS 跳板（节点在客户机房） | §1.6、§2.5 | D7 白名单+解析后判+配额+默认关闭+审计 |
| 4 | 内建带宽测试与业务抢带宽（自造拥塞） | §1.9、O5 | 硬上限+取消+资源隔离；否则不做 |
| 5 | 历史表体积压垮既有读路径 | O1-B | 索引与清理成对设计；先做体积估算再定保留期 |
| 6 | 与 §7 既有开放项冲突（历史保留） | `DEVELOPMENT.md:1800` | O4：等 Lead 明确归属 |
| 7 | 键集副本漂移（backend 校验/backend 读/web） | §1.3 | DoD 3 脚本化断言 |
| 8 | 新旧 Gate 断言互斥 | `v5-g1b.py:15`；datagram 契约 §7.4 | G19.15 回归；不得改旧断言 |
| 9 | 新增 action 扩大攻击面 | D2/D7 | 能力协商前置拒绝+封闭词表+独立安全评审 |
| 10 | `TargetKey` 两侧不同步 | §1.2、§7.3 | 一律复用既有身份函数，禁止第三份归一化 |

## 10. 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-10-05 | 初版：六问回答（D1–D12 + O1–O9）、WP19-F 收口建议、Gate G19.1–G19.15 | V5-WP19-C0（草案，待评审） |
| 2026-10-05 | Lead 裁决（§4.0）：O1+O4 冻结为"独立档案表、只 INSERT、24h 原始 + 30d 小时桶、永不作为判定输入"，并正式关闭既有开放项"是否保留观测历史"；O2 冻结为"新 action + 白名单 + 默认关闭 + 独立 Gate + 先过安全评审"，排在 WP19-F 之后；O3 冻结为"v1 不产生 udp 延迟事实，且不改 §7 合成语义"；WP19-F 采纳，排在 ① 之后执行。O5–O9 仍开放 | 开发 Lead（核实：Agent 上报 `diag` 但面板零消费点，缺陷成立） |
| 2026-10-05 | **§1.4.1 实测更正**：`diag` 在落库路径上**一直有值**（`validateStateReport` 透传未知字段、`node_state_report.tunnels` 整块落库；`datagramHopPeerFor` 依赖它，① 的出口取证纠正在真拓扑生效）。真正的丢点是**面板类型化读路径**（`parseReportedRuntimes` 重建 runtime 时丢 diag、无 typed 读路径、Web 类型缺）。Lead 裁决 WP19-F 取 **A（上报侧一等化）**、**不做 B（ACK 侧）**。§5.1 记录交付 | ④ WP19-F（实测与更正由 Lead 确认） |
| 2026-10-05 | **WP19-B 落地**（O1+O4 裁决的执行）：两张只追加档案表 + 迁移 `20261032000000_v5_wp19_latency_history` + `services/latency-history.ts`（保留期/UTC 分桶/rollup/prune/读路径）+ 上报侧追加 + `cron_latency_history`（先聚合后清理）。保留期走 `system_config` 字符串键，刻意不动 `SystemConfigName` 枚举。§5.2 记录交付与边界；Web 图表待补 | ④ WP19-B |
| 2026-10-05 | **WP19-D 落地**（O2 裁决的执行）：新 action `looking_glass`（面板 validator + Go control 两侧）、公网白名单两侧各自实现（同一张测试向量表）、面板解析并**钉死**地址、Agent **不做名称解析**（DNS 重绑定结构性关闭）、部署级开关**默认关**（关闭 = 明确拒绝；管理员例外带 `admin_override` 审计标记）、每节点单飞、三类审计（写失败即拒绝发起）、结果复用既有 ACK `results` 字段以避免新增重建边界。§5.3 记录交付/裁决留痕/待补；§5.4 新增**安全审查**（13 条绕过路径逐条给结论 + 明确不防清单）。证据 `docs/evidence/v5-wp19-d-looking-glass-20261005.txt`。**路由挂载那一行不在本提交**（`app.ts` 有别的 WP 在途改动），补丁见 §5.3 | ④ WP19-D（Looking Glass） |

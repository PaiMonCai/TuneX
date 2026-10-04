# V5.1b — UDP Datagram 语义契约（草案 / DRAFT）

> **状态：DRAFT（2026-10-04），未冻结。** 本文是 `DEVELOPMENT.md` §6.2 的前置契约
> 文档，对应拆分项 `WP5-B0 Datagram contract`（`DEVELOPMENT.md:1405`）。Lead 评审并
> 合并进 §6.2 之后，本文即被取代。
>
> 本文**不含任何实现**：没有补丁、没有 Go/TS 代码，也不修改任何代码文件。它唯一的
> 产物是**语义**。与被冻结的 §6.1（WS/TLS 语义契约，`DEVELOPMENT.md:1118-1332`）同一
> 条纪律：每条结论要么指向仓库事实（`文件:行`），要么指向已经冻结的 V5 不变量；仓库
> 事实无法唯一回答的，写进 §9「需要产品决策」并**不猜**，而不是从枚举名字猜行为。
>
> **行号说明**：下文行号取自 2026-10-04 本草案写作时刻的工作树。`backend/**`、
> `agent/**`、`web/src/**`、`DEVELOPMENT.md` 正被其他成员并行编辑，行号可能漂移；
> 合并前请以**符号名**为准复核（每个引用都同时给了符号名或原文片段）。

---

## 0. 八个问题的答案索引

| # | 问题 | 回答位置 | 结论是否已冻结 |
|---|---|---|---|
| 1 | UDP「会话」是什么，什么结束它 | §2 | 结构冻结，数值待产品决策（§9.2/9.3） |
| 2 | 用户可见 protocol vs 内部 transport | §1 | **冻结** |
| 3 | DIRECT / RELAY / 跨节点跳 | §3 | DIRECT 冻结；RELAY 的跳形态**未冻结**（§9.1） |
| 4 | StreamRuntime 各方法对 datagram 的意义 | §4 | **冻结**（Drain/SetUpstream 明确不适用） |
| 5 | 端口所有权 | §5 | 冻结（并暴露一处 schema 层面的取舍，§9.4） |
| 6 | 健康/观测必须上报的事实 | §6 | 事实清单冻结，落点待决策（§9.5） |
| 7 | Gate V5-G1B 映射到可执行检查 | §7 | **冻结** |
| 8 | 未猜测的开放产品决策 | §9 | — |

---

## 1. 用户可见 protocol 与内部 transport（问题 2）

### 1.1 冻结结论

~~~text
protocol    udp                       ← 用户在 Forward 上选的协议，产品维度
transport   datagram                  ← 由 protocol 派生，内部维度，不是第二个用户字段
~~~

依据与 §6.1 完全同源：用户可见协议是 `FORWARD_PROTOCOLS` 里的值，今天是
`["tcp", "tls", "ws"]`（`backend/src/services/forward-contract.ts:22`），创建入口用
`z.enum(FORWARD_PROTOCOLS)` 校验（§6.1 第 1 问）。`udp` 进入产品的方式只能是：加进
`FORWARD_PROTOCOLS` + 自带 Gate（V5-G1B）。

transport 是**派生**量，不是第二份真相：`FORWARD_TRANSPORTS` 今天只有 `["stream"]`
（`forward-contract.ts:30`），协议到 transport 的映射写在 `FORWARD_PROTOCOL_SPECS`
（`forward-contract.ts:64-75`），自检 `forwardRuntimePlanViolations` 会拒绝
「transport 与 protocol 不匹配」的计划（`forward-contract.ts:443-451`）。Agent 侧同一
张表：`protocolRuntimes`（`agent/internal/forwarder/interface.go:104-108`），它同时是
`ParseForwardProtocol`、`ImplementedProtocols()` 与能力清单的唯一来源
（`interface.go:92-98`、`137-147`）。

### 1.2 为什么 `datagram` 是 transport 而不是 protocol

三个定义性差异，全部可以在仓库里指到：

1. **连接 vs 包。** `StreamRuntime` 的契约写明「one accepted connection maps to one
   upstream connection」（`interface.go:356-358`）。datagram 里没有这个一一映射：
   是一个 mapping 对多个包（§2）。transport 这个词在 WP0 里的定义就是「how
   bytes/packets are transported」（`interface.go:59-64`）——packet 从一开始就在
   这个维度的定义里，而不是被遗漏。
2. **协议回答「客户端说什么」，transport 回答「节点之间怎么搬」。** §6.1 用这句话
   把 `wss` 拆开（`DEVELOPMENT.md:1173-1183`）。UDP 的同一拆法给出唯一答案：
   `udp` 是客户端说的东西（无连接的报文），`datagram` 是它在单节点数据面里的搬运
   契约。同一份报告里的 `ws` 是分帧协议、`tls` 是传输安全，两者正交；`udp` 与
   `datagram` 的关系是「协议 ↔ 生命周期」，不是并列枚举。
3. **生命周期值必须能表达「不能 drain 连接」。** transport 的规格里带
   `lifecycle`，今天只有 `connection`（`forward-contract.ts:33-41`）。把 datagram
   塞成 stream 的一个值，等于让 `ForwardTransportSpec` 说「UDP 也是 connection」，
   而 §3.3 的退出判断明确把「把 stream 生命周期错误套到 datagram」列为停止信号
   （`DEVELOPMENT.md:262`）。

### 1.3 落地足迹（只列必须改的契约点，不是补丁）

~~~text
agent/internal/forwarder/interface.go
    protocolRuntimes 增 {udp, datagram}；ForwardTransport 增 TransportDatagram；
    新增 datagram builder 注册表（不复用 streamBuilders）
agent/internal/forwarder/factory.go
    ResolveRuntimeTarget 已天然支持（协议 → transport 查表）；
    但 BuildStream 会**明确拒绝**非 stream transport（factory.go:110-126），
    所以需要一个平行的 BuildDatagram，而不是把 udp 放行给 stream builder
backend/src/services/forward-contract.ts
    FORWARD_PROTOCOLS 增 "udp"；FORWARD_TRANSPORTS 增 "datagram"；
    FORWARD_TRANSPORT_SPECS 的 lifecycle 需要第二个取值（今天是单值："connection"）
    FORWARD_PROTOCOL_SPECS.udp = { transport: "datagram", legacy_tunnel_type: "udp" }
backend/src/services/control-protocol/types.ts
    TUNNEL_TYPES 已含 "udp"（types.ts:78）→ 冻结的 wire 校验器
    （control-protocol/validator.ts:242-243）**不需要**改
backend/src/services/capability-manifest.ts
    BASELINE_TRANSPORTS 保持 ["stream"]（capability-manifest.ts:102）→
    datagram 只能靠**显式广告**进入，旧 Agent 不会因为 baseline 被放行
agent/internal/control/manifest.go
    DefaultManifest 从同一张表取，无需新逻辑（manifest.go:100-134、220-227）
~~~

**与 §6.1 的 `ws` 经历相比，这次少了两个坑（都是仓库事实）**：

- `udp` **在**遗留 DB 枚举里（`backend/prisma/schema.prisma:534-544`，`udp` 在 537
  行），所以 `legacy_tunnel_type` 可以是 `"udp"`，不会重演 `ws` 那种「枚举里只有
  `wss`、写 `wss` 就是撒谎」的问题（`forward-contract.ts:43-60`、§6.1 实施状态第 2 条）。
- `udp` **在** wire 词汇表里（`types.ts:78`），所以不会重演 §6.1 第 3 个坑
  「wire 白名单把 `ws` 拒了」（`DEVELOPMENT.md:1293-1295`）。

因此 V5.1b 的 wire/DB 投影是**零迁移**的：`wireTunnelTypeForForwardProtocol("udp")`
与 `legacyTunnelTypeColumn("udp")` 都直接得到 `"udp"`（`forward-contract.ts:252-268`）。
这与用户可见协议集合（`FORWARD_PROTOCOLS`）的扩张是两件事，不要混为一谈。

---

## 2. UDP 的「会话」= ingress mapping（问题 1）

### 2.1 定义

§6.2 给的目标生命周期是：

~~~text
listen packet → derive client/session key → lookup/create mapping → forward packet
→ receive response → return to client → idle expiry → mapping cleanup
（DEVELOPMENT.md:1384-1400）
~~~

据此冻结：**UDP 的「会话」是入口节点上的一个 mapping 表项**，不是连接，也不是
隧道。一条 Forward 在入口节点上有且只有一个 UDP socket；mapping 是它的**内部**状态。

mapping 必须回答四个问题，缺一不可（否则回包无法定向）：

~~~text
key       谁发的（入口 listener 标识 + 规范化后的客户端地址）
value     这条 mapping 现在把包发给哪个 target/上游（以及它自己的空闲时钟）
生命周期   创建于首个包，刷新于双向的每一次收发，结束于 §2.3 列出的三种原因
计数      packets/bytes 双向、丢弃原因——见 §6.1
~~~

### 2.2 mapping key 的性质（仓库能冻结的部分）

仓库里**没有** UDP 代码，所以 key 的具体编码是产品/实现决定。但下面四条性质不是
可选项，它们由已冻结的事实推出：

1. **key 必须含入口 listener 的身份。** 端口所有权是 node 级互斥的（§5），但同一节点
   可以有多个 UDP 入口（不同端口），key 不含 listener 就会把两条 Forward 的客户端
   混成一份 mapping。
2. **key 必须对地址做归一化。** IPv4/IPv6 是 §6.2 点名要定义的项
   （`DEVELOPMENT.md:1420`）。仓库现有的地址处理路径是 `net.JoinHostPort` /
   `net.SplitHostPort`（`interface.go:206-211`、`344-346`、`452-466`），面板侧的
   `host:port` 口径明确接受 `[IPv6]` 形态（`backend/src/services/scheduler.ts` 的
   `HOST_PORT` 正则）。同一个客户端若因 v4-mapped 形态产生两个 key，症状是
   「回包只回一半」或「mapping 数虚高」——这属于实现必须自证的部分，见 §7 的负例。
3. **key 不能含 target。** 否则「target 变更」会隐式重写 key，把 §6.2 要求的
   「target change 对 existing/new mapping 的语义」（`DEVELOPMENT.md:1418`）变成
   两套互相冲突的事实。
4. **key 只在 runtime 存活期内有效，不落库。** 依据是既有的耐久性契约：LKG/restore
   恢复的是**配置快照**（`agent/internal/restore/restore.go:35-40` 的 `Snapshot` 只有
   tunnels），revision/ACK 链恢复的是 applied 配置；把 mapping 落库会立刻产生
   「第二份运行时真相」，与 §1.4 的状态真相链冲突（`DEVELOPMENT.md:137-163`）。
   重启后 mapping 表为空，客户端下一个包自然新建一条——这正是 datagram 的正常语义。

### 2.3 什么结束一条 mapping（冻结三种，穷尽）

~~~text
① idle 到期          双向空闲超过 idle timeout → 回收（§9.2 定数值与是否可配）
② 显式关闭            UDP **没有**显式关闭语义：不存在 FIN/RST，客户端不发包就是全部信号
③ Agent 停止/退出     Stop / ShutdownAll / 进程退出 → socket 关闭，全部 mapping 一起消失
~~~

第 ② 条要写清「没有」，而不是留白：TCP 的删除清理守卫依赖「客户端挂断后计数归零」
（`agent/internal/manager/tunnel.go:474-476`），UDP 里根本没有等价事件，所以**不能**
把「连接关闭」当作 mapping 的回收路径，只能靠 idle 与上限。

第 ③ 条的量级必须与既有停机窗口对齐：`ShutdownTimeout = 10s`
（`agent/v3runtime.go:344`），且排空窗口是**绝对截止**——`remaining =
ShutdownTimeout - 已经花掉的时间`（`v3runtime.go:400-407`）。idle timeout 通常远大于
10s，因此 UDP 的关机不可能「等 mapping 自然过期」，只能停建新 mapping 后直接关
socket（§4.3）。

### 2.4 上限与清理

§6.2 要求定义 mapping ceiling 与 cleanup（`DEVELOPMENT.md:1416`）。仓库能提供的约束
只有一条，但它是硬的：**上限必须存在且必须有界**。依据：

- §14 明确「用户输入不能让 Agent 变成任意网络扫描器」（`DEVELOPMENT.md:2069`）。
  一个无上限的 UDP 入口 = 一个可以用伪造源地址把 Agent 内存吃光的放大器；同时
  UDP 的源地址是可伪造的，所以「每个源地址一条 mapping」这条朴素规则在对手手里
  就是资源耗尽攻击。
- 上限与超限行为（丢弃新包 / 拒绝新 mapping / 淘汰最久未用）是**产品决策**，见 §9.3。
  无论选哪个，Gate 都必须能断言「超限后的行为是确定的、可观测的」，见 §7 G1B.6。

---

## 3. DIRECT / RELAY 与跨节点跳（问题 3）

### 3.1 DIRECT（冻结）

~~~text
client ══ UDP ══> ingress listener(udp) ── datagram mapping ──> target:port (UDP)
client <══ UDP ══  ingress listener(udp) <─ 回包按 mapping 定向 ── target
~~~

与 §6.1 的 DIRECT 形状同构（`DEVELOPMENT.md:1187-1191`）：没有出口节点、没有跨节点
跳，listener 的协议只是入口那一层的形态。差异只在生命周期：**target 的"连接"不是
资源**——TCP 里一条到 target 的连接可以被持有、可以被半关、可以在 stop 时被强制关闭
（`agent/internal/forwarder/shutdown.go:104-116`）；UDP 里只有「往这个地址发包」，
没有可持有的目标侧对象。

### 3.2 RELAY 的**不变**部分（冻结）

RELAY 的编排顺序与协议无关，这一点 §6.1 已经为 ws/tls 定过（
`DEVELOPMENT.md:1193-1202`），UDP 沿用：

~~~text
client ══ UDP ══> ingress listener(udp) → [跨节点跳：见 §3.3] → egress → target
~~~

- 铁律四步不变：先准备出口 → 出口 ACK → 再启入口 → 失败补偿
  （`DEVELOPMENT.md:129-135`）；入口的 `next_hop` 只有在出口 ACK 之后才存在
  （`DEVELOPMENT.md:705-707`），面板侧体现为 `dispatchIngress` 的 `next_hop` 必填、
  两个方法必须按顺序调用（`backend/src/services/orchestrator.ts:1-35`、`476-478`）。
- RELAY 仍然是**两条独立 resource**：出口节点一条 EGRESS、入口节点一条 RELAY，
  各自等各自 ACK，共用同一个 `config_revision`（`orchestrator.ts:24-30`）。
- 出口池、LB 策略、健康视图不变（§6.1 同款论断）。

### 3.3 跨节点跳：本草案**唯一不冻结**的核心问题

§6.1 对 ws/tls 的答案是「这一跳仍然是裸 TCP」，理由是运维信任域 + 拒绝在协议 WP 里
引入第二套跨节点传输（`DEVELOPMENT.md:1141-1145`）。**这个理由不能机械照搬**，因为：

1. TCP 流搬不了报文边界。要在 TCP 上跑 UDP 载荷，必须新增一层长度前缀/分帧——那就是
   一个新内部传输协议（有自己的失败面：队头阻塞、MTU、粘包半包），正是 §6.1 拒绝的
   「第二份 transport 真相」。
2. 今天的下发路径**确实会把协议名带到出口腿**，所以「出口不需要知道前端协议」这句话
   在 UDP 上不会自动成立。三处证据：
   - 期望快照里三条腿都带 `protocol`：direct（`backend/src/services/agent-command-bus.ts`
     的 `desiredTunnelConfigFor`，三个分支分别写 `protocol`）、egress、relay ingress；
   - 编排器的三个下发方法同样各自取 `input.protocol ?? DEFAULT_FORWARD_PROTOCOL`
     （`orchestrator.ts:570`、`638`、`711`）；
   - `TunnelConfig.Validate()` 今天只对 **tls/ws** 拒绝 EGRESS（
     `interface.go:282-294`，理由是它们面向客户端）。`udp` 不在拒绝名单里，于是
     「RELAY + udp」会一路通过校验，直达一个**并不存在**的 datagram EGRESS 运行时。
3. 出口目标池没有协议维度。`EgressTarget` 只有 host/port/weight/order（
   `backend/prisma/schema.prisma:873-893`），Agent 的 `Target` 同样没有协议字段
   （`interface.go:196-203`），而 wire 上的 `TargetDescriptor` **已经**有
   `protocol?: "tcp" | "udp"`（`backend/src/services/control-protocol/types.ts:251`）。
   也就是说这个字段今天在下发链路上被丢弃，出口节点无论目标是 TCP 还是 UDP 都只会
   `net.DialTimeout("tcp", ...)`（`agent/internal/forwarder/egress.go:242`）。

**因此冻结到这里为止**：WP5-B1（UDP DIRECT）不依赖这个问题的答案，可以先做并且必须
先做（§6.2「UDP DIRECT 先于 UDP RELAY」，`DEVELOPMENT.md:1425-1439`）；WP5-B2
（UDP RELAY）在 §9.1 决策落地前**不得开工**。三种候选与代价写在 §9.1，本文不作选择。

### 3.4 target 生命周期 vs TCP connection（冻结）

| 事实 | TCP（今天） | UDP（本草案） |
|---|---|---|
| 目标侧对象 | 一条真实连接，可持有/半关/强关 | 无对象，只有「往哪发」 |
| target 热变更对在途流量 | live connection 保持旧 target（`interface.go:384-394`） | existing mapping 保持旧 target，直到 idle 到期 |
| target 热变更对新流量 | 新 connection 用新 target | new mapping 用新 target |
| 变更是否重建 listener | 否（§13.3.4 行，`interface.go:386-388`） | 否（同一理由：revision 变了但端口不变） |
| 目标不可达的可观测性 | dial 失败计数/最近错误（`agent/internal/forwarder/egress.go:18-34`） | 发送失败/ICMP 不可见——必须自己定义「多久没回包算不可用」 |

第一、二行的「旧目标继续、新目标接管」是**从冻结语义平移过来的**，不是新发明：它的
依据是 `SetUpstream` 的既有定义（live 连接保持旧 upstream，后续连接用新地址，
`interface.go:384-394`、`agent/internal/forwarder/singhop.go:100-120`）。§6.2 要求的
「target change 对 existing/new mapping 的语义」由此唯一化。

第四行的后半句是 datagram 特有的坏消息，必须写进契约：UDP 没有 dial，所以「target
unavailable」在入口侧**没有同步失败信号**（`sendto` 通常只反映本地错误）。健康判定
因此不能照搬 stream 的 dial 账本，见 §6。

---

## 4. StreamRuntime 契约对 datagram 的意义（问题 4）

### 4.1 逐方法的裁决（冻结）

`StreamRuntime` 的六个方法是
`Start / Stop / Stats / Running / SetUpstream / Drain`（`interface.go:372-411`）。
WP2 已经为「未来 datagram 不该被强迫实现同一接口」写了唯一理由
（`interface.go:356-371`），本草案把它落成逐条裁决：

| 方法 | 对 datagram | 理由与替代 |
|---|---|---|
| `Start` | **适用** | 绑定一个 UDP socket 并开始收包，与 TCP 的「绑定并开始 accept」同义（`interface.go:373-375`） |
| `Stop` | **适用**，语义要点改写 | 释放端口 + 关闭 socket；但「tears down live connections」要改写成「丢弃全部 mapping」——UDP 没有可优雅结束的对象（`interface.go:376-378`） |
| `Running` | **适用** | 「listener 是否绑定」对 UDP 同样成立（`interface.go:381-383`） |
| `Stats` | **适用但形状不足** | 现在返回单个 `int64`（`interface.go:379-380`），是「双向合计字节」。UDP 必须 additionally 报告 **packets、mappings、drop 原因**；沿用单值会让「包很多但字节很少」（扫描/放大）与「包少但字节大」不可区分。**不要求** datagram 实现这个签名，见 §4.2 |
| `SetUpstream` | **不适用** | 「the upstream address」是 per-connection 事实（`interface.go:362-367`）；datagram 里的对应物是「target 集合 + existing/new mapping 语义」（§3.4）。用一个字符串热替换 target，会把多目标池与 mapping 归属两件事一起压进一个参数里 |
| `Drain` | **不适用** | 见 §4.3；必须由 datagram 自己的「停止建新 mapping」替代 |

裁决的硬依据：WP2 的退出信号把「大量不适用于 TCP 的空方法」列为停止抽象的信号
（`DEVELOPMENT.md:825-835`）。让 UDP 实现 `Drain`/`SetUpstream` 的空壳正好落在这条
线上，所以本契约**明确禁止** datagram runtime 通过实现这两个方法来"满足"接口。

### 4.2 替代物：一个 datagram 自己的契约

不写代码，只冻结**语义槽位**（名字可在实现时定，但必须能回答）：

~~~text
Start()                 绑定 UDP socket
Stop()                  释放端口 + 丢弃全部 mapping
Running()               是否绑定
Stats()                 结构化计数（见 §6.1），不是单 int64
Retarget(targets)       替换新 mapping 的目标，不触碰 listener、不重写既有 mapping
DrainMappings(timeout)  停止建新 mapping；socket 保持打开；有界等待在途回包后返回
CloseListener()         对 datagram 的含义见 §4.4，**不得**被实现成"关 socket"
~~~

### 4.3 Drain 为什么不适用，替代物是什么

TCP 的 Drain 语义是「停止 accept，listener 仍绑定，等 in-flight connection 结束，
端口不释放」（`interface.go:395-410`、`base.go:300-347`）。搬到 UDP 会出现一个
**必须显式回答**的问题：能不能在「不再服务」的同时保持 socket 打开？

冻结：**能，而且必须保持 socket 打开**。原因是 UDP 的回程与去程共用同一个 socket：
关掉 socket 就等于同时杀死所有 mapping 的回包路径，这与「停止收新连接」完全不是
一回事。TCP 里 accept socket 与已建立连接是两个内核对象，所以「关 listener、留连接」
天然成立（`agent/internal/forwarder/shutdown.go:41-56`）；UDP 里只有一个对象。

因此 datagram 的排空 = **停建新 mapping + 继续服务既有 mapping 的回包 + 有界等待**，
且这个等待必须落在 §2.3 ③ 的绝对窗口内（`agent/v3runtime.go:344`、`400-407`）。

### 4.4 三个会静默骗人的接口断言（必须显式设计）

这三处不是"风格问题"——它们今天会对一个 UDP 隧道**返回 0 并当作事实**：

1. `TunnelManager.LiveConns` 用类型断言取计数，取不到就返回 0
   （`tunnel.go:474-489`）。datagram runtime 不实现 `LiveConns() int` 的话，面板/
   测试会读到「0 条在途」这个**错误的事实**，而不是「该 runtime 不适用该观测」。
2. `shutdownOne` 同理：断言 `interface{ LiveConns() int }` 失败时
   `RemainingConns` 保持 0（`agent/internal/manager/shutdown.go:186-196`），而
   `ShutdownResult` 的注释明确说「a non-zero value is a truth worth reporting」
   （`forwarder/shutdown.go:17-19`）。一个还有活 mapping 的 UDP 隧道会在最终上报里
   报告「0 剩余、0 强制」——这正好是本项目最忌讳的「把未知说成健康」。
3. `CloseListeners` 对不实现 `ListenerCloser` 的 runtime 直接回落 `Stop()`
   （`shutdown.go:81-94`），而它的注释承诺 phase 1 只停 listener、不动在途流量。
   datagram 若实现 `CloseListener` 为「关 socket」，就违反了 §1.6 的两阶段停机
   （「停止新连接 → bounded drain → 收敛 → 最终上报」，`DEVELOPMENT.md:177`）。

冻结结论：V5.1b 必须给 datagram runtime **自己的**「在途工作」与「停止接纳」原语
（名字可定，语义如上），并要求最终上报把 datagram 的在途量算进去；Gate 必须断言
这一点（§7 G1B.9/G1B.12）。

---

## 5. 端口所有权（问题 5）

### 5.1 铁律不变

§1.5：「端口继续由 NodePortLease / port guard 统一管理。任何新协议、HA、multi-hop
都不得自行 bind 一个"不在 lease 系统里"的端口」（`DEVELOPMENT.md:165-169`）。UDP 的
入口端口、RELAY 的出口端口都必须来自**同一个**所有权系统，不新建第二套。

控制面：`node_port_lease` 的 `UNIQUE(node_id, port)` 是所有权终审，Redis NX 只是并发
协调（`backend/src/services/portPool.ts:4-17`、`backend/prisma/schema.prisma:895-925`）；
`lease_type`（ingress/egress）只是元数据，**不构成隔离**，BOTH 节点共用一张物理端口表
（`portPool.ts:18-31`）。下发前端口由编排器之外的 `allocateTunnelPort` 申请
（`backend/src/services/scheduler.ts:694-720`），失败码 `port_taken` 等被翻译成调度
错误而不是"两个 listener 绑同一个端口"（`scheduler.ts:665-691`）。

数据面：Agent 的 `usedPort` 是**一个** map，TunnelManager 与 EgressManager 共用
（`agent/internal/manager/tunnel.go:10-15`、`58`），锁内检查 + 内核 `EADDRINUSE` 才是
最终裁判（`tunnel.go:268-296`）。

### 5.2 关键事实：内核是双命名空间，lease 是单命名空间

这是本草案最重要的发现，路线图没有提到它：

~~~text
内核（Linux）   TCP 19000 与 UDP 19000 是两个独立命名空间，可以同时绑定
NodePortLease   UNIQUE(node_id, port) —— 与协议无关（schema.prisma:921）
agent guard     map[string]bool，键是 "tcp:<port>"（tunnel.go:58、130-131）
~~~

结论：**沿用同一套 lease 的代价是「同一节点上 UDP 与 TCP 不能同号」**，这比内核更严格。
本草案冻结这个严格性，理由有两条，都指向同一个价值观：

1. §1.5 要求「一个 ownership 模型」；把唯一键改成 `(node_id, port, protocol)` 是一次
   schema 迁移 + 一次语义扩张（从「这台机器的这个端口」变成「这台机器的这个端口的这个
   协议」），而 §3.4 要求 migration 同时考虑旧 binary 兼容与历史事实（
   `DEVELOPMENT.md:270-284`）。它**不是** V5.1b 可以顺手做的事。
2. 宽松方向也不是无害的：一旦允许同号，扁平事实 `used_ports`（§6.2）与
   端口健康判定（§6.3）会立刻产生歧义，而这两处今天都只认 `number`。

这条约束必须在契约里写明，否则实现者会自然地认为「UDP 和 TCP 是不同命名空间，所以
可以同号」——那个直觉对内核成立，对 lease 不成立（见 §10 第 1 条）。

### 5.3 Agent 侧 guard 的命名空间陷阱

`portGuardKey` 生成 `"tcp:<port>"`（`tunnel.go:130-131`），而 `UsedPorts()` 把前缀
**剥掉**再返回 `map[int]bool`（`tunnel.go:514-525`），reporter 的 `PortLister` 接口
也是 `UsedPorts() map[int]bool`（`agent/internal/reporter/heartbeat.go:316-322`）。
三个后果：

1. UDP 端口若继续用 `"tcp:"` 前缀入 map，guard 本身仍能互斥（因为键里含端口），但
   **事实会被说错**：一个 UDP 绑定被记成 TCP 绑定。
2. `UsedPorts()` 的剥离操作 `k[len("tcp:"):]`（`tunnel.go:520`）在 `"udp:"` 前缀下
   「碰巧」仍能解析出正确端口号（两个前缀都是 4 字符），于是**不会报错**——它会静静地
   把两个命名空间合并成一个 `map[int]bool`。这是典型的"能跑但撒谎"。
3. 上报链一路扁平到面板：`used_ports: []int`
   （`heartbeat.go:92`、`node-state.ts` 的 `used_ports?: number[]`），校验只要求每项是
   number（`node-state.ts` 的 `bad_used_ports` 分支）。

冻结：Agent 侧 guard 必须按协议命名空间记键（`"udp:<port>"`），并且对外暴露事实时
必须保留命名空间（新增一个协议维度的视图，或在既有视图旁增加 UDP 专属字段）。
**不得**把两个命名空间压平后上报。面板是否需要同步改，取决于 §9.4 的产品决策：
若冻结「同号不允许」，扁平 `used_ports` 对「端口是否真的被绑」这个判定仍然正确（§6.3），
只需新增「这条绑定属于哪个协议」的可选事实；若改为允许同号，则两侧都必须协议化。

### 5.4 lease 与 legacy DIRECT 的关系（对 UDP 同样成立）

存量 DIRECT 的 `listen_port` 是 legacy 分配器给的、**没有** lease 行
（`portPool.ts:32-40`），所以 v3 分配前必须把同节点这些端口灌进 `reservedPorts`
（`scheduler.ts:618-628`）。UDP 不会改变这条纪律；反过来，**UDP 的 legacy 端口**（见
§5.5）也必须以同样方式被计入，否则会重演「没有任何 DB 约束兜底」的撞号。

### 5.5 仓库里已经存在的「UDP 端口槽」事实（v2 遗留）

v2 的配置生成器已经把「同一隧道的 tcp/udp 是两个独立槽」实现过：

- slot key `"${id}:tcp"` / `"${id}:udp"`，同一 slot 幂等取同号
  （`backend/src/socket/port-allocator.ts:121-131`）；
- 服务名 `tcp-<id>` / `udp-<id>` 分别解析、分别分配（同文件 `248-285`）；
- 文件头明确写「同一隧道的 tcp / udp 是两个独立槽 → 不会同号」
  （同文件 `33-37`），并有单测钉住「tcp/udp of the same tunnel never share a port」；
- listen 事件解析同样认 `udp-<id>`（`backend/src/socket/listen-events.ts:50-56`）。

这是**历史事实**，不是 V5 契约（该文件自己标注 LEGACY，新代码应使用
`services/portPool.ts`）。它在本草案里的作用只有一个：证明产品过去**没有**要求
「TCP/UDP 同号」，所以 §5.2 的保守冻结不是对既有产品的倒退。

---

## 6. 健康与观测（问题 6）

### 6.1 datagram runtime 必须上报的事实（冻结清单）

不写"连接数"（UDP 没有连接）。必须能回答：

~~~text
mappings_active        当前 mapping 数（= 在途工作的唯一口径，替代 LiveConns）
mappings_created       累计创建数（与降速/重试无关的原始计数）
mappings_expired       因 idle 回收的数量
mappings_rejected      因 ceiling 被拒/被淘汰的数量（超限行为必须可观测，§2.4）
packets_in / packets_out
bytes_in / bytes_out   **必须分方向**：今天的 Stats() 只有双向合计（interface.go:379-380）
drops                 按原因分类：unknown_source? ceiling / send_error / malformed
last_activity_at       最近一次成功收发（面板侧算「mapping 是否还活着」）
~~~

计数的口径必须继承既有纪律：**只计真正送达对端的量**。`copyOne` 的注释写明「计数放在
写侧，因为账单要的是 delivered 而不是 seen」（`agent/internal/forwarder/pipe.go:37-43`），
`decideTrafficReport` 也拒绝 0 增量（`backend/src/services/traffic-archive.ts:427-467`）。
UDP 的对应规则：转发失败或被丢弃的包不计入 bytes，只进 drops。

### 6.2 三条现有契约会让新事实「静默失败」

1. **`runtime_counts` 是封闭键集，不是开放集合。** Agent 的
   `RuntimeCounts{direct,relay_ingress,relay_egress,total}`（
   `agent/internal/reporter/telemetry.go:87-95`）与面板的 `RUNTIME_COUNT_KEYS`
   （`backend/src/services/node-state.ts:279`）一一对应；面板对未知键**拒绝整份上报**
   （`node-state.ts:268-276`，`bad_telemetry`），注释写明理由：「放行未知种类会让
   runtime 普查不完整，而 health 仍说 healthy——把监控说成正常是最坏的失败模式」。
   于是：**新 Agent 给 `runtime_counts` 加一个 UDP 键 + 旧面板 = 整份状态上报 400**，
   连带丢掉隧道、端口、健康事实。这与顶层未知键被宽容对待（
   `heartbeat.go:97-101` 的注释、`node-state.ts` 只校验白名单字段）完全不同。
   冻结：UDP 的 runtime 计数**不得**在面板白名单同步发布前进入 `runtime_counts`；
   走新的顶层字段（旧面板会忽略）或在同一 release 内两侧一起改。
   Web 侧还有第三处副本：`web/src/lib/types.ts` 的 `NodeRuntimeCounts` 与
   `web/src/lib/node-health.ts` 的 `runtimeCountEntries`（键列表写死）。
2. **`used_ports` 是扁平 `number[]`。** 校验只要求是 number（`node-state.ts` 的
   `used_ports` 分支），面板健康用 `parseUsedPorts` 收成一个 `Set<number>`
   （`backend/src/services/node-health.ts:311-318`），再判 `port_not_bound`
   （`node-health.ts:557-565`）。在 §5.2 的「同号不允许」冻结下，这个判定对 UDP
   仍然**正确**（一个端口号在这台机器上只有一条绑定）；一旦产品选择允许同号，它必须
   协议化，否则「UDP 19000 在跑、TCP 19000 没起」会被判成健康。
3. **`LiveConns` 断言静默返回 0**，见 §4.4。datagram 必须提供自己的在途口径，并且
   面板/关机报告要能读到它，而不是读到 0。

### 6.3 计费/流量链：v3 Agent 今天**没有**这条路径

这是「packet/byte accounting」这一项最容易踩空的地方：

- 面板侧确实有一条计量链：`POST /api/tunnel/traffic`（免认证、按 node 归属）
  → Redis hash 累加 → `tunnel_traffic` 归档 → workspace 聚合
  （`backend/src/routes/public.ts:61-143`、`backend/src/services/traffic-archive.ts:1-40`）。
- 但 v3 的 Go Agent 只访问 `/api/internal/node/commands`、`/ack`、`/desired`、
  `/api/internal/heartbeat`、`/api/internal/node/state`（
  `agent/internal/control/client.go:28-29`、`agent/internal/restore/http_source.go:87`、
  `agent/internal/reporter/heartbeat.go:47-53`），**没有**任何地方上报流量。
- 而 runtime 侧的 `Stats()` 在生产代码里也没有消费者：`TunnelManager.Stats(id)` 只有
  测试调用（`agent/internal/manager/tunnel.go:447-456`；全仓调用点均为 `_test.go`）。
- 上报条目本身也只有 `tunnel_id + bytes`（`traffic-archive.ts:427-467`），没有 packets；
  `tunnel_traffic` 的语义是「某日界已归档的字节」。

结论：**「packet accounting」是新建一条链，不是复用一条链**。契约只能冻结事实的形状
（§6.1）与口径纪律（delivered、分方向、drops 不入账），落点（状态上报 vs 计量端点）与
是否计费属于产品决策，见 §9.5。Gate 也必须按**被选中的那条链**写断言（§7 G1B.12）。

### 6.4 面板侧需要改的契约点（按文件）

~~~text
backend/src/services/node-state.ts        新顶层事实的校验白名单 + 投影白名单
                                          （投影是白名单：漏列 = 校验通过但库里永远 NULL，
                                          见 node-state.ts 的 "同一个白名单陷阱" 注释）
backend/src/services/node-health.ts       RuntimeCounts 形状 / ports 判定的协议化（条件性）
backend/src/services/node-health-service.ts  desired runtime 推导与遥测视图
                                          （runtimeId 约定不含协议，见 node-health-service.ts:123-135、
                                           185-213 —— UDP 不需要新的 id 映射，这一点是好消息）
web/src/lib/types.ts                      NodeRuntimeCounts / NodeTelemetry 形状
web/src/lib/node-health.ts                runtimeCountEntries 的键列表
agent/internal/reporter/telemetry.go      RuntimeCounts（若走这条链，两侧必须同步发布）
agent/internal/reporter/heartbeat.go      StatePayload 新增字段（additive）
agent/internal/forwarder/*                新 datagram runtime 的计数实现
~~~

一句话：**在 UDP 打通之前，先把「新事实怎么到达面板」的路径定下来**，否则会出现
「协议能跑、面板只显示 0」——这比彻底不支持更难排查。

---

## 7. Gate V5-G1B 映射到可执行检查（问题 7）

模型是 V5-G1A：检查项在脚本里逐条 `record()`，结果为 PASS/FAIL 行并落
`docs/evidence/`（`scripts/v3-e2e/v5-g1a.py:8-25`），结果格式沿用
`docs/evidence/v5-g0-result-20261003.txt`。纪律沿用 v5-g1a.py 的原文：**缺拓扑、超时、
前置失败、清理失败都是 FAIL，不是 skip**（`v5-g1a.py:24-25`）。

### 7.1 条目映射（§6.2 的 16 条 → 可执行检查）

| # | §6.2 条目（`DEVELOPMENT.md:1441-1460`） | 可执行动作 | 断言 |
|---|---|---|---|
| G1B.1 | one client | 一个 UDP 客户端发包 | target 收到且客户端收到回包 |
| G1B.2 | many clients | N 个源端口并发 | 每个客户端收到**自己**的回包（不串线） |
| G1B.3 | same/different source | 同一客户端连发 + 多个不同源（不同容器/IP、不同源端口）并发 | 同源复用同一条 mapping；不同源各自一条；回包不串线 |
| G1B.4 | bidirectional packet | 请求-响应 + 主动推送 | 两个方向都能穿过，计数分方向 |
| G1B.5 | idle expiry | 建立 mapping → 静置超过 idle | mapping 数回落；客户端下一个包能重新建（新 mapping 用当前 target） |
| G1B.6 | mapping ceiling | 把 mapping 数推到上限以上 | 超限行为确定、可观测（mappings_rejected 增长），listener 不崩、内存有界 |
| G1B.7 | target unavailable | target 端口关闭 | 入口不崩；失败可观测；不用「无回包」冒充成功 |
| G1B.8 | target hot update | 同 revision 内换 target（§13.3.4 行） | listener 端口不变；existing mapping 保持旧目标；new mapping 用新目标 |
| G1B.9 | Agent restart | 重启 ingress | 端口重新绑定；mapping 表为空也不报错；最终上报把 datagram 在途量算进去（§4.4） |
| G1B.10 | Panel outage | 停面板 | 入口继续转发既有配置；恢复后 desired 重新成为权威 |
| G1B.11 | LKG restore | 冷启动只带本地快照 | listener 从缓存恢复且协议事实保留（沿用 G0 的 LKG 用例形态）；mapping 不恢复是**期望**行为 |
| G1B.12 | packet accounting | 见 §6.3 | 被选中的链上能看到单调递增的 packets/bytes；drops 不计入 bytes |
| G1B.13 | lease conflict | 对已被占用的端口再申请 | 拒绝且 `port_taken`；无第二个 listener；无重复 bind |
| G1B.14 | DIRECT | 完整 DIRECT 用例 | 端到端可用，且协议事实/transport 事实正确 |
| G1B.15 | RELAY | 见 §9.1 | **决策落地前不得开跑**；落地后：先出口后入口可观测、失败补偿不留半条隧道 |
| G1B.16 | old Agent rejected before dispatch | 旧 Agent（无 udp 广告）创建 udp Forward | 面板在入队前拒绝（`upgrade_required` / `protocol_not_supported`），**没有**租约、**没有** listener |

### 7.2 必须补的负例与回归（对齐 G1A 的负例纪律）

~~~text
malformed datagram        0 字节 / 超长 / 截断 / 垃圾内容 → listener 不崩、不泄漏、留诊断事实
                                          （模型：G1A.5，v5-g1a.py:12）
transport 维度拒绝        广告了 udp 但没广告 datagram（或反之）→ 拒绝，理由是 transport
                                          （模型：G0.8，v5-g0-result §G0.8）
无 payload / 无 secret 泄漏  诊断、日志、Support Bundle 不含任何数据面报文内容
                                          （模型：G1A.11「no secret in logs/bundle」，
                                           §14 的 Support Bundle allowlist 纪律，DEVELOPMENT.md:2065）
entitlement 层              见 §7.3 —— udp 必须在 platform_ceiling 里，否则**没人**能创建
TCP 回归                    V5-G0 的 G0.1/G0.2 在 V5.1b 分支上重跑（§6.1 同款要求，DEVELOPMENT.md:1313）
**既有断言会翻转**           见 §7.4
~~~

### 7.3 Gate 必须覆盖的「非 runtime」前提

只测数据面会漏掉两类真实拦截：

1. **授权层。** 创建 Forward 的第 1 层是 workspace 策略的 `tunnel_types`
   （`backend/src/services/capability-policy.ts:396-398`，`protocol_not_allowed`），
   而上界 `platform_ceiling` 会与策略取交集。今天 `platform_ceiling` **不含 udp**
   （`backend/prisma/migrations/20261015000100_v5_wp5a1_tls_entitlement/migration.sql:26-30`），
   只有 `free_team` 里留有历史的 `udp`（同文件 `38-42`，注释说明那是保留的历史事实）。
   所以 V5.1b 必须带一条**纯数据** migration 把 udp 加进上界与默认模板——否则
   「协议开了、没人被授权」，Gate 会以一堆 `protocol_not_allowed` 失败。
2. **准入层。** 三层判定顺序是 action → protocol → transport
   （`backend/src/services/runtime-admission.ts:107-139`），失败在入队前发生，
   端口租约尚未产生（`admitRuntime` 全量检查后再返回，`runtime-admission.ts:148-172`）。
   G1B.16 必须断言「拒绝发生在**没有** lease / 没有 listener 的时刻」，而不是"最终
   没跑起来"。

### 7.4 需要同时改掉的既有检查（否则 Gate 自相矛盾）

以下既有断言在 udp 开放后会**必然**失效，属 V5.1b 的 Gate 范围内：

~~~text
docs/evidence/v5-g0-result-20261003.txt
    「G0.5 it does not advertise the unimplemented protocol udp」
    「G0.7 an explicit udp create is refused」
    这两条是 udp 未开放时的正确断言；开放后要改成分支内实现才广告 udp
    （模型：tls 在 V5.1a 时从"未开放"列表移出的做法）
backend/src/services/__tests__/capability-manifest-v5.test.ts
    基线是 tcp/stream、且 udp 属"未来协议"的断言（同文件 248-258）
backend/src/services/__tests__/forward-contract-v5.test.ts
    遗留枚举名不构成产品支持的 udp 列表（同文件 64-70）
backend/src/services/__tests__/forward-runtime-plan-v5.test.ts
    未开放协议列表与 `lifecycle: "packet"` 必须匹配失败的断言（同文件 91-111）
backend/src/services/__tests__/runtime-admission-v5.test.ts    udp 被拒的两条
backend/src/services/__tests__/dispatch-protocol-v5.test.ts    历史 udp 被当 TCP 的守卫
~~~

注意最后一项里那个字符串 `"packet"`：测试已经把一个非 `connection` 的 lifecycle 值
当作**非法**值使用。新的 lifecycle 名（`packet` 或 `datagram`）必须一次定死并在两侧
（`FORWARD_TRANSPORT_SPECS` 与测试）同时更新——这是命名决策，但**不能有两种拼法**，
否则「transport lifecycle mismatch」这条自检会在合法的 UDP 计划上误报。

---

## 8. 实施落点预览（只定边界，不写代码）

沿用 §5.3 的「不复制 manager」纪律（`DEVELOPMENT.md:812-823`）与
`single_manager_guard_test.go` 的源码级守卫（该测试明确写了"第一个 datagram 协议到达
时不要新增 UDPManager"）：

~~~text
WP5-B0 Datagram contract      本文档；不改代码
WP5-B1 UDP DIRECT             agent/internal/forwarder 新 datagram runtime + factory
                              分支；backend 的协议/transport 契约与 entitlement 数据
                              migration；面板观测字段（按 §9.5 决策）
WP5-B2 UDP RELAY              §9.1 决策之后；编排顺序不变，跳形态按决策
WP5-B3 UDP telemetry/account  §6.3 的链落地 + health/panel 契约
Gate V5-G1B                   scripts/v3-e2e/v5-g1b.py（模型 v5-g1a.py）+ evidence 文件
~~~

不被触碰的东西（禁止清单，依据同上）：`TunnelManager` 的 revision/lease/reconcile
所有权、第二份 desired state、第二个 port owner、第二个数据面 manager。

---

## 9. 需要产品决策（**不猜**）

以下每一条都是本草案**没有**回答的，因为仓库事实无法唯一回答。它们不是"实现细节"，
选择不同会让契约形状不同。

1. **跨节点跳的形态（§3.3）。** 三个候选：
   - (a) 跳保持裸 TCP + 新增长度前缀分帧 → 复用现有 EGRESS/端口/健康，但引入第二套
     跨节点传输真相与新的失败面（§6.1 反对的那种）；
   - (b) 跳改为 UDP（egress 监听 UDP）→ 端到端语义最自然，但需要 datagram EGRESS
     runtime、出口端口所有权、目标池协议维度（§3.3 第 3 点）、以及新的可靠性问题
     （丢包/无重传/MTU）；
   - (c) V5.1b **不做** UDP RELAY（只做 DIRECT）→ 最保守，但 §6.2 的 Gate 里 RELAY
     条目与「UDP DIRECT 先于 UDP RELAY」的拆分初衷要一并调整。
   影响面：`agent/internal/forwarder/factory.go` 的 builder 拆分、出口腿的协议投影
   （`orchestrator.ts`/`agent-command-bus.ts` 今天三条腿都带 protocol）、
   `TunnelConfig.Validate()` 对 EGRESS+udp 的裁决。
2. **idle timeout 的数值与可配置性。** 面板今天没有对应列（`forward_protocol` 与
   `tls_*` 是 V5 加过的两列，`schema.prisma:600-617`）。要么固定常量（简单，但一条
   被墙的 DNS 客户端也是这个量级），要么新增 per-Forward 列（要 migration + 校验 +
   计划字段）。数值本身是产品决策。
3. **mapping ceiling 的数值与超限行为。** 丢弃新包 / 拒绝新 mapping / 淘汰最久未用
   三者对客户端体验完全不同；§2.4 只冻结了「必须有界」。
4. **同一节点上 TCP 与 UDP 能否同号。** 见 §5.2：沿用现有 lease 唯一键就是「不能」
   （保守）；要「能」就必须把 `@@unique([node_id, port])` 扩成含协议维度，并同步
   `used_ports` 的协议化（§6.2 第 2 点）。这是 V5.1b 最容易被默默做错的取舍。
5. **UDP 是否计费、packets 是否入账。** 现有计量链只认 bytes（
   `traffic-archive.ts:427-467`），`tunnel_traffic` 没有 packets 列。是"只做观测"、
   还是"进计费"、packets 是否单独计费，都是产品决策；它决定了 §6.4 的落点。
6. **IPv4/IPv6 的绑定与归一化策略。** 入口 socket 是否双栈、v4-mapped 客户端是否归一到
   同一 mapping、`listen_host` 的既有语义（`interface.go:240-242`）如何映射到 UDP 绑定。
   仓库没有 UDP 绑定代码，无法唯一回答。
7. **UDP 是否需要"这条转发加不加 TLS/DTLS"之类的正交维度。** 本草案按 §6.1 的做法把
   维度拆开、不新增枚举名（`DEVELOPMENT.md:1175-1183`）。若产品要求 udp+DTLS，那是一个
   新 WP，必须自带密钥 ownership/rotation（§14，`DEVELOPMENT.md:2066`）。
8. **是否需要在面板暴露 per-protocol 的开关/配额。** 今天唯一的现有开关是能力策略的
   `tunnel_types`（`capability-policy.ts:396-398`）。用户能否"只允许 tcp 不允许 udp"
   不构成新机制；但"同一 Forward 是否允许 tcp 与 udp 同一个监听端口/同一个业务名"
   是产品模型问题（§1.1 的用户产品模型是 Node + Forward）。

---

## 10. 现有代码与路线图假设不一致的地方（给 Lead）

按严重度排列，全部是仓库事实：

1. **「复用 port lease」成立，但「UDP/TCP 同号」不成立。** `NodePortLease` 的唯一键是
   `UNIQUE(node_id, port)`（`schema.prisma:921`），而内核里 TCP/UDP 是两个命名空间。
   路线图的「复用 port lease」是对的，但它隐含的代价（同号被拒）没有写下来，实现者
   极可能反着理解（§5.2）。
2. **`runtime_counts` 是封闭键集，加键会让旧面板把整份上报判 400。** 这与"未知字段被
   忽略"的普遍印象相反（`node-state.ts:268-276` 的注释解释了为什么刻意的）。
   任何"顺手加一个 udp 计数"都会造成节点可观测性整体消失。
3. **「复用 Stream Runtime」在 Drain/SetUpstream 上不成立，而且 WP2 已经写明了。**
   `interface.go:356-371` 特意把这一点写在接口文档里；本契约必须**明确禁止**用空方法
   糊过去（§4.1）。
4. **`LiveConns` 与 `CloseListeners` 的接口断言会对 UDP 静默返回"没有在途工作"。**
   `tunnel.go:474-489`、`shutdown.go:186-196`、`shutdown.go:81-94`（§4.4）。
5. **RELAY 的下发路径今天会把 `udp` 一路送到出口节点**，而出口没有任何 datagram
   实现：三条腿都带 `protocol`（`agent-command-bus.ts` 的 `desiredTunnelConfigFor`、
   `orchestrator.ts:570/638/711`），`Validate()` 只拒 tls/ws 的 EGRESS
   （`interface.go:282-294`）。若不先解决 §9.1，B2 会在"校验通过、运行失败"的位置
   崩溃，而不是在契约处被拦住。
6. **出口目标池没有协议维度，wire 上却有一个被丢弃的 `protocol` 字段。**
   `EgressTarget`（`schema.prisma:873-893`）、Agent `Target`（`interface.go:196-203`）
   都没有；`TargetDescriptor.protocol?: "tcp" | "udp"`（`types.ts:251`）已经存在于
   wire 契约。这是既有的"半实现"，UDP RELAY 会把它变成真实缺口。
7. **「packet accounting / byte accounting」在 v3 上是新建链**：Go Agent 没有流量上报
   端点，`Stats()` 在生产路径没有消费者（§6.3）。
8. **`used_ports` 与 `UsedPorts()` 把命名空间压平**，且压平过程不会报错
   （`tunnel.go:514-525`、`heartbeat.go:316-322`、`node-state.ts` 的 `used_ports`）（§5.3）。
9. **Route 该假设的例外：「协议事实」这次不需要迁移。** `TUNNEL_TYPES` 已含 udp、DB
   枚举已含 udp（`types.ts:78`、`schema.prisma:537`），所以 V5.1b 的 projection 是零
   迁移的——与 §6.1 里 `ws` 的三次踩坑不同（§1.3）。
10. **既有 Gate 断言会翻转**（§7.4）：G0.5「不广告 udp」、G0.7「显式 udp 创建被拒」，
    以及 5 个 backend 测试文件里的"未开放协议"列表。这不是缺陷，但必须在同一个 WP 里
    改，否则新 Gate 会与旧 Gate 互斥。

---

## 11. 本文不做什么（边界）

- 不写任何 Go/TS 代码、不提出补丁、不改任何代码文件；
- 不创建第二套端口所有权、第二个 manager、第二份 desired state；
- 不定义 idle timeout / ceiling 的具体数值，不选择跨节点跳形态（§9）；
- 不把「枚举里有 `udp`」当作产品支持，也不因为"内核允许同号"就放宽端口所有权。

---

## 12. 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-10-04 | DRAFT 初版：八个问题的回答 + Gate V5-G1B 映射 + 10 条与现有代码的不一致 | V5-WP5-B0（草案，待评审） |

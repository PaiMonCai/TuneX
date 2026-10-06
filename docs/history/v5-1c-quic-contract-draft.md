# V5.1c — QUIC 语义契约（草案 / DRAFT）

> **状态：DRAFT（2026-10-04），未冻结。** 本文是 `DEVELOPMENT.md` §6.3
> （`DEVELOPMENT.md:1562-1593`）要求的前置契约文档，对应建议拆分项
> `WP5-C0 QUIC semantics contract`。Lead 评审并合并进 §6.3 之后，本文即被取代。
>
> 本文**不含任何实现**：没有补丁、没有 Go/TS 代码、不修改任何代码文件、**不新增依赖**。
> 它唯一的产物是**语义**，外加一份**诚实的实现前置条件**。
>
> 纪律与前两份契约完全同源：§6.1（WS/TLS，`DEVELOPMENT.md:1118-1332`）与 §6.2
> （UDP，`docs/v5-1b-datagram-contract-draft.md`）——每条结论要么指向仓库事实
> （`文件:行` / 符号名），要么指向已经冻结的 V5 不变量；仓库事实无法唯一回答的，
> 写进 §7「需要决策」并**不猜**，而不是从枚举名字或库的能力猜行为。
>
> **本文与前两份契约有一处结构性差异，请先读 §3。** V5.1a / V5.1b 的问题全部落在
> 「标准库能做什么」之内，所以契约写完就能开工。V5.1c 的七个问题写在一个新前提下：
> **Go 标准库没有 QUIC**，因此真实前端需要数据面的**第一份第三方依赖**——而「数据面
> 零第三方依赖」是这个仓库用 `go.mod`、README、代码注释与 CI 反复声明过的**架构属性**
> （§3.2）。本文把这个前提当作契约的一部分写下来，**不绕过它、不为它辩护、也不替产品
> 做选择**；选择权在 Lead 与人类决策者（§7.1）。
>
> **行号说明**：下文行号取自 2026-10-04 本草案写作时刻的工作树。`DEVELOPMENT.md`、
> `agent/**`、`backend/**`、`web/src/**` 正被其他成员并行编辑（本草案写作期间
> `agent/v3runtime.go` 的行号就已经移动过），行号可能漂移；复核时以**符号名**为准
> （每个引用同时给出符号名或原文片段）。
>
> **外部事实说明**：§2.3、§2.5、§2.6、§2.7、§3.1、§4 引用了仓库之外的资料（Go
> 发行版自身、RFC、quic-go / x/net 的模块元数据与公开文档）。这类引用**逐条标注
> URL 并写明「外部事实」**，与仓库事实严格分开：它们用来给选项定价，**不构成选择**，
> 也不构成契约（契约只冻结我们自己承诺什么）。

---

## 0. 七个问题的答案索引

| # | §6.3 的问题 | 回答位置 | 现在能否冻结 | 备注 |
|---|---|---|---|---|
| 1 | QUIC 是用户协议还是内部 hop transport | §2.1 | **可以** | 范围界定；另一读法是另一个 WP |
| 2 | termination point | §2.2 | **可以** | 入口 Agent；QUIC 走 UDP 命名空间 |
| 3 | TLS identity / certificate ownership | §2.3 | 主体可以 | ALPN 取值是开放决策（§7.3），**不依赖** §3 |
| 4 | connection vs stream accounting | §2.4 | 语义可以 | transport 槽位是开放决策（§7.2），**不依赖** §3 |
| 5 | datagram（RFC 9221）是否启用 | §2.5 | **可以** | 冻结为「不启用」 |
| 6 | migration 是否支持 | §2.6 | 主动迁移可以 | 被动迁移策略见 §7.4 |
| 7 | 0-RTT 是否支持 | §2.7 | **可以** | 冻结为「不支持」 |
| — | 实现前置条件（不属于七问，但决定七问能否落地） | §3、§4 | **阻塞，等决策** | §7.1 |
| — | Gate V5-G1C | §6 | **不可执行** | 没有实现就没有端点（§6.2） |

一句话总览：**七个语义问题里五个可以现在就冻结、两个只有子项待定；真正被阻塞的不是
答案，而是「谁来提供 QUIC 协议栈」这件事，以及因此根本无法定义的第七个 Gate。**

---

## 1. 开工条件：§6.3 的前置已经成立（但它只写了这一半）

§6.3 的第一句是「QUIC 只有 UDP Gate 全绿后开始」（`DEVELOPMENT.md:1564`）。这个条件
**今天成立**，证据是仓库自己的 Gate 结果文件（不是口头结论）：

~~~text
V5-G0 TOTAL PASS=137 FAIL=0    docs/evidence/v5-g0-rerun-after-v51a-20261004.txt:143
V5-G1A TOTAL PASS=73  FAIL=0    docs/evidence/v5-g1a-result-20261004.txt:79
V5-G1B TOTAL PASS=76  FAIL=0    docs/evidence/v5-g1b-result-20261004.txt:82
~~~

三门都绿，且 G1B 是在真实四 Agent 拓扑上跑出来的（`docs/evidence/v5-g1b-result-20261004.txt`
头部写明 topology 与 fixture）。所以 §6.3 的**顺序条件**满足。

但 §6.3 **没有写第二个前提**：QUIC 的实现需要一个仓库目前不具备的东西——一个 QUIC
协议栈。§6.1 与 §6.2 都不需要这个前提（TLS/WS 是标准库，UDP 是标准库），所以前两个
阶段的契约可以只谈语义；V5.1c 不行。§3 与 §4 就是这一半。

---

## 2. 七个问题的答案

### 2.1 问题 1：QUIC 是用户可见协议，还是内部 hop transport？

**冻结：在 V5.1c 的范围内，它是用户可见协议（`protocol=quic`），不是跨节点跳。**
停在这里而不是继续展开，是因为这句界定决定了另外六问是否成立。

依据（全部是仓库事实）：

1. `quic` 在产品面**只以「协议」的形态存在过**：遗留 DB 枚举
   （`backend/prisma/schema.prisma` 的 `enum TunnelType` 含 `quic`）、wire 词汇表
   （`backend/src/services/control-protocol/types.ts` 的 `TUNNEL_TYPES` 含 `quic`）、
   web 的「历史协议、未开放」展示（`web/src/lib/forward-protocol.ts`）、以及
   `FORWARD_PROTOCOLS` 这个创建白名单不含它（`backend/src/services/forward-contract.ts:24`，
   注释写明 "quic comes last"）。
2. **G0.7 的语义就是「用户创建 quic 转发被拒」**：`scripts/v3-e2e/v5-g0.py:1015-1036`
   用 `tunnel_type: "quic"` 走真实的 relay 创建端点，断言 `>=400` 且「没有 Forward 行、
   没有端口租约」；证据行 `docs/evidence/v5-g0-rerun-after-v51a-20261004.txt:50-52`。
   它把 `quic` 当作**用户协议**来测，而不是节点间实现细节。
3. §6.3 提的七问（0-RTT / migration / datagram / TLS identity / 证书 / 连接 vs 流）
   **只在「面向客户端的前端」这一读法下才有意义**。把 QUIC 当跨节点 hop transport 是
   另一件事：它不给用户暴露新协议、不需要用户字段与 ALPN 产品语义，但要处理跳的可靠性、
   出口节点能力与端口——那属于 §9 Multi-hop / V5.4 的领域，而今天的跳是裸 TCP
   （`agent/internal/forwarder/singhop.go` 的 `net.DialTimeout("tcp", ...)`；§6.1
   `DEVELOPMENT.md:1141-1145` 已为 tls/ws 冻结「不改这一跳」）。

**必须写清的边界**：若产品的意图是「用 QUIC 做节点间跳」，那需要**另写一份契约**——
它的答案与本文完全不同，本文的七问答案对它**无效**（例如「0-RTT 不支持」在 hop 场景下
会变成另一组取舍）。不要用本文去论证那个选项。

**冻结状态：可以现在冻结（不依赖 §3 的依赖决策）。**

### 2.2 问题 2：termination point 在哪里？

**冻结：入口 Agent 自己的 listener（面向客户端的一侧），位置与 `tls` 完全相同；出口
节点不终止、跨节点跳不做二次加密、面板不参与数据面。**

- 出口侧的证据：`TunnelConfig.Validate()` 已经对 tls/ws 拒绝 EGRESS，理由是
  「terminates at the client-facing listener」（`agent/internal/forwarder/interface.go`
  的 `protocol == ProtocolTLS && mode == ModeEgress` 分支，ws 同）——quic 是同一类前端，
  同一条规则。
- 跳不受影响的证据：`agent/internal/forwarder/singhop.go` 的 `net.DialTimeout("tcp", ...)`；
  §6.1 `DEVELOPMENT.md:1141-1145` 的「不为新前端协议引入第二套跨节点传输」。
- 编排顺序与协议无关：§1.3 铁律（先出口 → 出口 ACK → 再入口 → 失败补偿，
  `DEVELOPMENT.md:129-135`）；§6.1 `DEVELOPMENT.md:1193-1202` 已为 ws/tls 定过。

**QUIC 特有的一条（新增，必须写进契约）**：QUIC 监听的是 **UDP socket**，不是 TCP
listener。这意味着：

1. 它占用的是**内核的 UDP 命名空间**。§6.2 已冻结的保守规则「同一节点上 TCP 与 UDP
   不共享端口号」（`docs/v5-1b-datagram-contract-draft.md` §5.2，依据
   `NodePortLease` 的 `UNIQUE(node_id, port)` 与 `agent/internal/manager/tunnel.go`
   的 `portGuardKey` / `usedPort map[string]bool`，键形如 `"<socket namespace>:<port>"`）
   **自动覆盖** `quic` 与 `tcp` 的冲突。
2. UDP 命名空间里因此出现**第二个可能的占用者**：`udp`（datagram mapping runtime，
   `agent/internal/forwarder/datagram.go` 的 `net.ListenUDP`）与 `quic`（QUIC 端点）。
   两者会**正确地互相排斥**，因为 agent 侧 guard 的键都是 `"udp:<port>"`（`portGuardKey`
   把 UDP 记成 `udp:` 命名空间）。**端口所有权不需要新机制**，这一点是好消息。
3. 代价在**事实表达**上：`used_ports: number[]` 是扁平的，无法说出「这个 UDP 端口是
   `udp` 还是 `quic`」。§6.2 已把这件事列为开放决策（`docs/v5-1b-datagram-contract-draft.md`
   §5.3 / §9.4）；QUIC 只是让同一个缺口从「一个协议」变成「两个协议共享」。

**冻结状态：可以现在冻结。**

### 2.3 问题 3：TLS identity / certificate ownership

**冻结：直接继承 §6.1 第 4 问，不新建第二套。**

- 证书归**部署/运维**，以**节点本地文件**形式存在；Forward 只携带**路径**
  （`tls: { cert_path, key_path }`），**绝不携带密钥 material**
  （§6.1 `DEVELOPMENT.md:1155-1166`；实现见 `agent/internal/forwarder/interface.go` 的
  `TunnelConfig.TLSCertPath/TLSKeyPath` 及其注释，以及
  `backend/src/services/forward-contract.ts` 的 `tlsPathsForProtocol`）。
- 轮换 = 运维替换文件 + **下一次握手**读取；坏文件**保留上一份好证书**：实现是
  `agent/internal/forwarder/tls_cert.go` 的 `certReloader.GetCertificate`（按文件戳
  重读，失败时 report 并返回旧证书）。QUIC 复用同一个 reloader——`tls.Config.GetCertificate`
  对 QUIC 的握手同样有效，所以这里**没有新机制**。
- 密钥/证书继续走既有 redaction：`backend/src/services/redaction.ts:55` 的
  `pem_private_key` 规则按形状删除 PEM 私钥块；§14 的要求是「TLS/QUIC 若引入 key
  material，**先定义 ownership/rotation/redaction**」（`DEVELOPMENT.md:2213`）。
  本文的答案是：**不引入新的 key material 形态**——QUIC 用同一对 PEM 文件，仍以路径
  流经控制面，redaction 仍是兜底而不是唯一防线。
- 面板没有 per-resource secret store（§6.1 的既有依据）；QUIC 不改变这一点。

**QUIC 特有的两条（新增，必须写进契约）：**

1. **证书对 QUIC 是必需的，不是可选的。** QUIC 没有「明文 QUIC」：它的握手就是 TLS 1.3
   （RFC 9001；该 RFC §4.2 明文 "Clients MUST NOT offer TLS versions older than 1.3"——
   外部事实，https://www.rfc-editor.org/rfc/rfc9001.html#section-4.2 ）。另一个方向的
   外部核对：`golang.org/x/net/quic` 的 `Config.TLSConfig` 文档写着 "It must be non-nil
   and include at least one certificate or else set GetCertificate"
   （https://pkg.go.dev/golang.org/x/net/quic#Config ）。
   → 因此 `tlsPathsForProtocol` 的规则必须从「`protocol === "tls"` 必须有路径」扩成
   「所有**带 TLS 身份的前端**必须有路径」。把 `quic` 当成 tcp 那样「无必需配置」，会在
   建 listener 时才失败——而那正是 §6.1 用 `dispatchFactsFromRow`（「协议 + 它需要的
   配置一起解析」）消掉的那类漏网。
2. **ALPN 是 V5.1c 必须新增的一项契约，而仓库今天完全没有 ALPN 概念。** 今天的
   `buildTLSStream` 只设 `MinVersion: tls.VersionTLS12`
   （`agent/internal/forwarder/factory.go`，`tls.Config{...}` 处），没有任何 `NextProtos`。
   RFC 9001 专门有一节 `8.1 Protocol Negotiation`（该 RFC 目录已核对，外部事实：
   https://www.rfc-editor.org/rfc/rfc9001.html#section-8.1 ），QUIC 的应用协议协商以
   ALPN 为载体；实现落地时请按该节的规范措辞复核。契约因此冻结**两条规则**（**不冻结
   取值**，取值见 §7.3）：
   - quic 前端**必须显式声明一个 ALPN 标识**，不接受「客户端给什么就用什么」；
   - 该标识必须被 Gate 断言（否则症状是「配置对、客户端永远连不上」的静默失败）。

**冻结状态：主体可以现在冻结；ALPN 取值是开放决策（§7.3），它不受 §3 的依赖决策
阻塞，但必须在写代码前定死。**

### 2.4 问题 4：connection vs stream accounting

这是七问里唯一一个**现有冻结形状会明确说谎**的问题，必须逐条裁决。先列仓库事实：

- `StreamRuntime` 的定义句是「one accepted connection maps to one upstream connection」
  （`agent/internal/forwarder/interface.go` 的 `StreamRuntime` 文档）；
- `StreamRuntime.Stats() int64` 是「双向合计字节」的单值（同上）；
- 在途工作用类型断言 `interface{ LiveConns() int }` 读取，取不到就返回 0；datagram 已经
  有了显式替代 `LiveMappings`（`agent/internal/manager/tunnel.go` 的
  `TunnelManager.LiveConns` / `LiveMappings`，其注释明确写了「不得对 datagram 静默返回
  0」；背景见 `docs/v5-1b-datagram-contract-draft.md` §4.4）；
- 关机报告只有 `ForcedConns` / `ForcedMappings` / `RemainingConns` 三个在途维度，
  `RemainingConns` 的注释是 "A non-zero value is a truth worth reporting"
  （`agent/internal/forwarder/shutdown.go` 的 `ShutdownResult`）；
- 协议事实走每隧道 `diag`（`agent/internal/forwarder/diagnostics.go` 的
  `ProtocolDiagnostics`），其 `Protocol` 字段注释把取值写成 "tcp / tls / ws"（udp 落地时
  这行已经过时）；
- 面板侧 `runtime_counts` 是**封闭键集**：未知键**拒绝整份状态上报**
  （`backend/src/services/node-state.ts` 的 `RUNTIME_COUNT_KEYS` 与 `isRuntimeCounts`，
  注释解释了为什么刻意严格）。

QUIC 的结构性事实（协议本身，不是任何实现的细节）：**一条 QUIC 连接承载多条 stream。**
因此：

| 现有的冻结形状 | 对 QUIC 的裁决 | 理由与替代 |
|---|---|---|
| 「accepted connection ↔ upstream connection」 | **不适用** | 入口侧一条 QUIC 连接可以开出 N 条 stream，工作单位是 **stream**。把连接当单位会同时说错两件事：一条空闲连接被算成在途工作；一条承载 50 条 stream 的连接只被算成 1 |
| `Stats() int64` | **形状不足** | 单值无法表达方向，也无法区分「stream 数」与「连接数」；「很多小 stream」与「一条大 stream」可以有相同的字节总数 |
| `LiveConns() int` | **禁止用它回答** | 它会把连接数冒充在途工作。QUIC 需要自己的原语（名字可由实现定，但**必须**同时回答两个事实：活着的 stream 数、活着的连接数；在途工作以 **stream** 为准） |
| `Drain(timeout)` | **语义要重写，但不能没有** | TCP 的 drain = 停止 accept + 等在途连接结束。QUIC 有两层：连接层（停收新连接）与 stream 层（stream 有显式 FIN，所以「优雅结束一条 stream」是存在的——这比 UDP 好，UDP 连「显式关闭」都没有，见 `docs/v5-1b-datagram-contract-draft.md` §2.3②/§4.3）。**必须冻结的边界**：drain 期间 listener **保持绑定**（与 UDP 同一条理由：端口是租约事实，释放端口是 Remove 的事） |
| `SetUpstream` / 换 target | **按 stream 语义平移** | live stream 保持它拨号时的 target，新 stream 用新 target——这正是 UDP `Retarget` 的平移（`docs/v5-1b-datagram-contract-draft.md` §3.4），只是键从 mapping 换成 stream。热重载**不得重建 listener**（§13.3.4 行） |
| `ShutdownResult` | **必须加入 stream 维度** | 否则一条还挂着 100 条活 stream 的 QUIC 隧道会在最终上报里说「0 剩余、0 强制」——与 §6.2 抓到的「把未知说成健康」是同一类缺陷 |
| `ProtocolDiagnostics` | **加键，但不得进 `runtime_counts`** | 每隧道 `diag` 是**开放对象**：面板对 `tunnels[i]` 只校验 id / 端口 / targets（`backend/src/services/node-state.ts` 的 `tunnels` 校验段），diag 原样随隧道列表入 JSON。而 `runtime_counts` 是封闭键集，QUIC 的计数进入它会让「新 Agent + 旧面板 = 整份状态上报 400」，连带丢掉隧道、端口与健康事实（`docs/v5-1b-datagram-contract-draft.md` §6.2 第 1 条） |

**一个必须显式回答的契约问题（§7.2）**：QUIC 落在哪个 transport 槽位。今天有两个：
`stream`（lifecycle = `connection`）与 `datagram`（lifecycle = `mapping`）
（`backend/src/services/forward-contract.ts` 的 `FORWARD_TRANSPORT_SPECS`；
`agent/internal/forwarder/interface.go` 的 `TransportStream` / `TransportDatagram`）。
QUIC 两个都不诚实：不是 connection→connection（上表第一行），也不是无连接的 mapping。
三个候选写在 §7.2，**本文不选**。

**冻结状态：语义结论可以现在冻结**（stream 是在途工作的单位；`stream` 与 `datagram`
两个槽位都装不下它；事实走 `diag`、不进 `runtime_counts`）。
**transport 槽位的命名与由此产生的契约形状是开放决策（§7.2），它不依赖 §3 的依赖决策。**

### 2.5 问题 5：QUIC datagram（RFC 9221）是否启用？

**冻结：不启用。** 三条理由，第一条来自 §6.3 本身：

1. §6.3 的默认就是「不因为库支持就自动开启 0-RTT、connection migration 或**额外 QUIC
   扩展**」（`DEVELOPMENT.md:1576-1578`）。datagram extension 正是「额外扩展」。
2. **仓库里已经有一个叫 `datagram` 的东西，而它与 RFC 9221 不是一回事。** 仓库的
   `datagram` 是**传输/生命周期**（无连接、mapping、空闲过期：`TransportDatagram` /
   `DatagramRuntime` / `DatagramStats`，`agent/internal/forwarder/interface.go`；
   `FORWARD_TRANSPORT_SPECS.datagram.lifecycle = "mapping"`）；RFC 9221 的 datagram 是
   **一条 QUIC 连接内部的不可靠消息**。两者同名不同物——混用它们，正是 §6.1 花力气拆掉的
   那种混淆（那里是 `wss`）。若要启用，transport 规格必须能同时表达「面向连接」与
   「带不可靠消息」，那是**第三个维度**，不是一个开关。
3. 启用会让 §2.4 的账目问题再加一层：同一条连接里既有可靠 stream 又有不可靠 datagram，
   `Stats()` / 在途口径 / `ShutdownResult` 全部要再分一层。

**契约要求**：V5.1c 必须在配置层面**显式关闭** datagram（「默认关闭」是实现的属性，
契约要的是「我们不做这个承诺」），并让 Gate 断言「客户端声明支持 datagram 时，前端行为
确定、且不因此改变任何账目语义」。

外部事实（仅用于定价，不构成契约）：被考察的实现里有 `EnableDatagrams` 开关且默认
false，`ConnectionState.SupportsDatagrams` 报告双方是否启用
（https://raw.githubusercontent.com/quic-go/quic-go/v0.63.0/interface.go ）。

**冻结状态：可以现在冻结。**

### 2.6 问题 6：connection migration 是否支持？

分两层，**必须分开写**：

- **主动迁移（我们的代码发起）：不支持，且禁止。** Agent 是服务端；服务端没有「迁移到
  另一条路径」这个动作。契约冻结：QUIC 前端**不得**调用任何主动迁移 / 多路径 API。
- **被动迁移 / NAT rebinding（客户端换地址后继续用同一条连接）：策略未定（§7.4）。**
  这是协议允许且由客户端发起的。对**面向客户端的前端**，它至少不会破坏键的语义（stream
  前端不像 UDP 那样以「客户端地址」为 mapping 键）；但它会改变「客户端来源地址」这个
  诊断事实，而它是否被接受、能否被拒绝，取决于选哪个实现（§3 的决策）。

**契约冻结的原则**：迁移**不得成为可用性承诺**——「客户端换地址后连接一定活着」不在
契约里。实现落地时必须**显式选择**「接受被动迁移」或「拒绝被动迁移」，并让 Gate 断言
该行为；不允许「不知道、随库默认」。

外部事实（仅用于定价）：被考察的实现把主动迁移做成显式 API（`Conn.AddPath`、
`Path.Probe/Switch`），即默认不会主动迁移
（https://pkg.go.dev/github.com/quic-go/quic-go#Path ）。

**冻结状态：主动迁移「不支持」可以现在冻结；被动迁移策略依赖实现选择（§7.4），
不阻塞其余答案。**

### 2.7 问题 7：0-RTT 是否支持？

**冻结：不支持。** 三条理由：

1. §6.3 默认（同 §2.5 第 1 条，`DEVELOPMENT.md:1576-1578`）。
2. **0-RTT 对一个转发前端不是性能开关，而是重放面。** RFC 9001 §2.1 把这句话写死在规范里
   ——「This application data can be replayed by an attacker, so 0-RTT is not suitable for
   carrying instructions that might initiate any action that could cause unwanted effects
   if replayed」（外部事实，https://www.rfc-editor.org/rfc/rfc9001.html#section-2.1 ）。
   对一个「收到 stream 就去 dial 上游」的代理，重放 = 重复建连与重复的上游副作用。要安全
   支持它，需要应用层重放防护——那是**新的安全设计**，不是配置。
3. **它会引入新的 key material 生命周期。** 0-RTT 依赖 session ticket 及其加密密钥；跨
   Agent 重启必须稳定，否则 ticket 全部失效或可被伪造。§14 要求「先定义
   ownership/rotation/redaction」（`DEVELOPMENT.md:2213`），而今天路由给证书文件的
   ownership 模型没有位置放它。

**契约要求**：前端**不签发可用于 0-RTT 的 ticket，也不接受 Early Data**；Gate 必须有一条
负例断言「0-RTT 尝试被**确定性**拒绝」（不是偶发失败）。

外部事实（仅用于定价）：被考察实现的服务端 0-RTT 是显式 opt-in（`Allow0RTT`，注释写明
"Only valid for the server"），并有 `Err0RTTRejected`
（https://raw.githubusercontent.com/quic-go/quic-go/v0.63.0/interface.go ）；
`golang.org/x/net/quic` 的公开文档把 "0-RTT is not supported" 列为已知限制
（https://pkg.go.dev/golang.org/x/net/quic ）。

**冻结状态：可以现在冻结。**

---

## 3. 实现阻塞：Go 标准库没有 QUIC（证据）

> 这一节不是背景介绍，是契约的一部分：它决定 §6 的 Gate 能不能定义，也决定七个答案
> 里哪些**能被实现**。

### 3.1 标准库有什么、没有什么

**有**：`crypto/tls` 的 QUIC 握手钩子（`QUICConn` / `QUICConfig`），即 RFC 9001 那一层。
它是 Go **1.21** 加入的 API——证据是本机 Go 发行版的版本化 API 清单
`/usr/local/go/api/go1.21.txt`（条目如
`pkg crypto/tls, func QUICClient(*QUICConfig) *QUICConn #44886`）。它只把 TLS 1.3 握手
接到**调用者自己提供的 QUIC 传输**上，**不含** RFC 9000。

**没有**：任何公开的 QUIC 传输实现。本机 `go list std` 里没有任何 QUIC 包；`net/http`
也不导出 HTTP/3 服务端 API。

**一个容易被误读的巧合（本草案实测）**：Go 发行版内部**确实**打包了
`vendor/golang.org/x/net/quic` 与 `vendor/golang.org/x/net/http3`（标准库自己的测试用它
们，例如 `net/http/clientserver_test.go` 同时导入二者）。但用户代码**不能**导入：本草案
用一个只含 `import _ "vendor/golang.org/x/net/quic"` 的探针模块编译，失败并报
`use of vendored package not allowed`。它是标准库的私有实现，不是一个可用 API。

**结论**：「用标准库实现 QUIC」= 自己写 RFC 9000（封包/流/流控/连接 ID/迁移规则 + 丢包
恢复 + 拥塞控制）、RFC 9001 的密钥调度胶水、RFC 9002 的恢复算法。标准库只给了握手那一层。

### 3.2 「零第三方依赖」是被多处声明的架构属性，不是一个注释

- `agent/go.mod` 只有一行注释作为依赖声明：
  「The agent intentionally depends on the Go standard library only, so that
  `go build ./...` works fully offline (no third-party module downloads).」
  仓库里**没有** `go.sum`，也**没有** `agent/vendor/`。
- `agent/README.md`：「`go build -o tunex-agent .` # no third-party modules; works offline」。
- 代码层把它当设计约束：`agent/internal/forwarder/interface.go`（"standard-library only,
  so `go build ./...` keeps working fully offline"）、
  `agent/internal/forwarder/websocket.go` 的 `Why hand-rolled instead of a library`
  注释（"`go.mod` has no dependencies, which is what keeps `go build ./...` working
  offline"）、`agent/internal/api/server.go`、`agent/internal/reporter/resources_linux.go`、
  `agent/main.go`。
- **CI 按这条属性构建**：`.github/workflows/ci.yml` 的 `agent` job（约 133 行起）用
  `go-version-file: agent/go.mod` + `cache-dependency-path: agent/go.mod`，然后
  `go vet ./...`、`go test ./...`、`go build -buildvcs=false ./...`，最后交叉编译
  linux/amd64 与 linux/arm64（`CGO_ENABLED=0`，`-ldflags="-s -w"`）。
- **容器构建同样假设它**：`agent/Dockerfile` 先 `COPY agent/go.mod ./` 再 `COPY agent ./`，
  直接 `go build`——**没有** `go mod download`、**没有** `-mod=vendor`（因为不需要）；
  基础镜像是 `golang:1.22-bookworm`，`go.mod` 的指令是 `go 1.22`。
- **仓库已经为这条属性付过代价**：WebSocket 前端没有用 `gorilla/websocket`，而是手写了
  服务端需要的 RFC 6455 分帧（`agent/internal/forwarder/websocket.go`，理由写在文件头）；
  `agent/README.md` 的 Notes/limits 段写明「uTLS / REALITY / mieru / WireGuard /
  **QUIC carrier wrapping is not implemented（they require large third-party forks）**」。

### 3.3 路线图与这条属性是矛盾的（历史事实，从未被记下来）

原始设计文档把 QUIC 实现**指名**为 quic-go：

~~~text
docs/tunex-devmap-v3.md:748   **QUIC Forwarder**  forwarder/quic.go   quic-go（v1.1）
docs/tunex-devmap-v3.md:1024  **Agent**  QUICForwarder（quic-go）  forwarder/quic.go
~~~

而 v3 重写（`agent/` 这一支）选择了 standard-library-only，于是 README 把 QUIC 列为
「不做」。**§6.3 既没有提到这个矛盾，也没有提到「QUIC 需要第三方库」。** 它唯一相关的一
句是默认里的「不要因为**库支持**就自动开启 0-RTT / connection migration / 额外扩展」——
这句话其实**预设了「有库」**。本文补上的就是这一半。

### 3.4 两条容易漏的成本（与选哪个库无关）

- **交叉编译是好消息**：主流 Go QUIC 实现是纯 Go，`CGO_ENABLED=0` 交叉编译不受影响
  （这正是仓库的发布路径，见 §3.2 的 CI 步骤）。
- **供应链是坏消息**：一旦引入第三方代码，「审计一次二进制」的姿势就变了。
  `docs/release-record-v4.5.md:133` 已经写明仓库自身的 `LICENSE` / `NOTICE` /
  **third-party attribution** 尚未定稿——引入依赖会把这件事从「未来开源时的整理工作」
  变成「下一次发布的前置条件」。同时 `scripts/ci/secret-scan.mjs` 与 Support Bundle 的
  allowlist 纪律（§14，`DEVELOPMENT.md:2206-2216`）需要覆盖新的第三方源码面。

---

## 4. 选项与代价（**本文不选择**）

四个主选项，外加一个必须被诚实列出的第五项。每项只写「它对这个仓库的具体后果」。

### 选项 A：加入第三方依赖（以 `github.com/quic-go/quic-go` 为代表）

外部事实（2026-10-04 读取）：

- 最新版本 v0.63.0（2026-09-22 发布），MIT，纯 Go；实现 RFC 9000/9001/9002，另支持
  RFC 9221（datagram）、RFC 9369（v2）、qlog；被 caddy / traefik / frp / syncthing /
  cloudflared 等项目使用；上游发布策略是「始终支持最新两个 Go 版本」。
- 它的 `go.mod` 要求 **`go 1.26.0`**，并列出 **8 个直接依赖**（`golang.org/x/crypto`、
  `x/net`、`x/sync`、`x/sys`、`quic-go/qpack`、`stretchr/testify`、`go.uber.org/mock`、
  `quic-go/go-ossfuzz-seeds`）与 **5 个间接依赖**。
- 参考：https://pkg.go.dev/github.com/quic-go/quic-go 、
  https://raw.githubusercontent.com/quic-go/quic-go/v0.63.0/go.mod 、
  https://raw.githubusercontent.com/quic-go/quic-go/v0.63.0/interface.go

对本仓库的具体后果：

1. **不止一个依赖。** `go.sum` 会一次进 **13 个模块** —— 「agent 的第一个第三方依赖」
   在事实上是「agent 的十三个」。契约必须按这个数量级描述代价。
2. **必须同时升 Go 工具链。** 要动三处：`agent/go.mod` 的 `go 1.22`、
   `agent/Dockerfile` 的 `golang:1.22-bookworm`、CI 的 `go-version-file: agent/go.mod`。
   否则构建在工具链层面就失败。若不动 `go.mod` 而依赖 `GOTOOLCHAIN` 自动下载工具链，那
   等于把「离线构建」换成「构建时联网换工具链」——属性被换掉，只是换了个说法。
3. **离线构建消失。** `go build ./...` 不再自足：CI/容器需要 `go mod download`（需要网络
   与模块代理），或者走选项 B。
4. **供应链面**：与 §3.4 两条连在一起。
5. **降级到旧版本不是省事，而是更贵**：为绕开工具链升级而选一个 `go 1.22` 时代的 quic-go
   （例如 v0.48.2）会同时得到 **13 个直接依赖**（比 v0.63.0 更多）与一个已离开上游支持
   窗口的分支。参考：https://raw.githubusercontent.com/quic-go/quic-go/v0.48.2/go.mod

### 选项 B：加入依赖但 vendor 进仓库（`go mod vendor`）

- **保住了**：`go build ./...` 离线（存在 `vendor/` 时默认走 vendor 模式）、CI 不依赖模块
  代理、Dockerfile 可以继续「COPY 后直接 build」。
- **代价**：
  1. 仓库里出现第三方源码（量级是数 MB），代码审查与 secret scan 的输入面永久变大；
  2. `go.mod` / `go.sum` **仍然**有那 13 个模块——vendor 只改获取方式，不改依赖图；
  3. 升级 = 人工重跑 `go mod vendor` + 一个巨大的 diff；
  4. `go test ./...` 不会跑 vendor 里的上游测试（只编译被导入的部分），「上游测试是否
     通过」变成仓库外的事实；
  5. 选项 A 的第 2 条（工具链三处联动升级）**依然存在**。

### 选项 C：不引入任何依赖，把协议**在契约层关着**（V5.1c 只交付本文）

- 不做的事：`agent/internal/forwarder/interface.go` 的 `protocolRuntimes` 不加 `quic`；
  `backend/src/services/forward-contract.ts` 的 `FORWARD_PROTOCOLS` 不加 `quic`；
  不新增 transport。
- **保住了**：零依赖属性一件不改。而且这是三个选项里**唯一不需要改既有 Gate** 的：G0.5
  的「不广告未实现协议 quic」与 G0.7 的「显式 quic 创建被拒」继续成立
  （`scripts/v3-e2e/v5-g0.py`；证据行
  `docs/evidence/v5-g0-rerun-after-v51a-20261004.txt:32,50`）。
- **代价**：V5.1c 不交付任何用户能力；§6.3 的 Gate V5-G1C **无法执行**（没有实现可测）；
  「V5.1 协议扩张」止步于 `udp`；web 里 `quic` 继续以「历史协议、未开放」出现。

### 选项 D：推迟 V5.1c（等前提变化）

与 C 的区别是**意图与记录方式**：C 是「现在关闭」，D 是「挂起，前提一变就重开」。契约
部分照做（本文即是），代码部分不做。

- **代价**：路线图滑期。但滑期是**可见**的——本文把前提与重开条件写死了，而不是静默停摆。
- 一个必须诚实说清的外部事实：标准库方向上的下一步**不是已经就绪**。`golang.org/x/net/quic`
  是公开包，但它自己的文档写着「This package is a work in progress. It is not ready for
  production usage. Its API is subject to change without notice.」，已知限制里明确包含
  **0-RTT 不支持、地址迁移不支持**，并且「not yet covered by the Go security policy」；
  它的 `go.mod` 同样要求 `go 1.26.0`（另有 x/crypto、x/sys、x/term、x/text 四个依赖）。
  参考：https://pkg.go.dev/golang.org/x/net/quic 、
  https://raw.githubusercontent.com/golang/net/v0.59.0/go.mod
  → 也就是说：**选项 A 的「另一个候选」仍然是一份依赖，而且是一份明确声明"不适合生产"的
  依赖；「等它进标准库」目前只是希望，不是计划。**

### 选项 E：用标准库自己实现 QUIC（第五项，必须列出来）

- **可行性依据**：`crypto/tls.QUICConn`（Go 1.21+，见 §3.1）给了握手层，**因此这个选项
  零第三方依赖、也不用升工具链**（`go.mod` 的 1.22 够用）。
- **代价（诚实）**：
  1. 这是本仓库历史上最大的一次自研：RFC 9000 + RFC 9001 的胶水 + RFC 9002 的丢包恢复与
     拥塞控制。对照：手写 RFC 6455 服务端分帧（`websocket.go`）是几百行且规范边界清晰；
     QUIC 是一个完整传输。
  2. 失败模式是**安全与可用性**失败：错误的丢包恢复/流控不是「慢一点」，是黑洞、内存放大
     或被对手利用。
  3. 互操作成为主要风险：Gate 必须包含与**真实 QUIC 客户端**的互操作，而不只是自测自通。
  4. 长期维护成本落在本仓库。
  5. 一个反面参照（外部事实）：Go 团队自己把 QUIC 放在 `x/net`，且到 2026-09 仍标注不适合
     生产、不在 Go 安全策略覆盖内（同上 URL）。

### 本文的立场

**不在这五个选项里选择。** 这是产品 / 架构决策，属于 Lead 与其人类决策者；契约能做的
只有：把代价写清、把不依赖该决策的部分先冻结、把决策之后才能做的事标成阻塞。

---

## 5. 这个决策改变什么、不改变什么

| 决策结果 | 必须一起动的仓库面（示例，不是补丁） | 七个答案是否要改 |
|---|---|---|
| A 引入依赖 | `agent/go.mod` + 新增 `go.sum` + 工具链三处（`go.mod` / `agent/Dockerfile` / CI）+ `agent/internal/forwarder` 新前端与 builder + `protocolRuntimes` + `FORWARD_PROTOCOLS` / `FORWARD_TRANSPORT_SPECS` + 准入与授权 + entitlement 数据迁移（`platform_ceiling` 加 quic，形态参照 `backend/prisma/migrations/20261016000000_v5_wp5b1_udp_entitlement`） | **不改** |
| B vendor | 上面全部 + `agent/vendor/**` + Dockerfile/CI 的 `-mod=vendor` | 不改 |
| C 契约层关闭 | 无（本文即交付物） | 不改 |
| D 推迟 | 无（记录前提与重开条件） | 不改 |
| E 自研 | `agent/internal/forwarder` 新增 QUIC 传输实现 + 它自己的单元/互操作测试 | 不改 |

**这张表是本文最重要的一句话**：依赖决策改变的是**实现路径与 Gate 的可执行性**，
**不改变七个语义答案**。任何一个选项下的 QUIC 契约都长这样。

---

## 6. Gate V5-G1C 映射（以及它今天为什么不可执行）

### 6.1 §6.3 的清单 → 可执行检查（形态照抄 G1A / G1B）

模型是 V5-G1A/V5-G1B：检查项在脚本里逐条 `record()`，结果为 PASS/FAIL 行并落
`docs/evidence/`（`scripts/v3-e2e/v5-g1a.py`、`scripts/v3-e2e/v5-g1b.py`；结果文件
`docs/evidence/v5-g1a-result-20261004.txt`、`docs/evidence/v5-g1b-result-20261004.txt`）。
纪律沿用原文：**缺拓扑、超时、前置失败、清理失败都是 FAIL，不是 skip。**

| # | §6.3 条目（`DEVELOPMENT.md:1580-1593`） | 可执行动作 | 断言 |
|---|---|---|---|
| G1C.1 | basic handshake | 真实 QUIC 客户端连入口 listener | 握手成功；证书是运维放的那一份；流量穿透到 target |
| G1C.2 | invalid cert | 证书不匹配 / 文件缺失 / 过期 | 建 listener 前 fail closed；**保留上一 applied**（模型 G1A.3/G1A.6） |
| G1C.3 | reconnect | 断开后重连 | 新连接独立成功；无 fd/goroutine 泄漏 |
| G1C.4 | stream lifecycle | 一条连接并发多 stream、含半开与 reset | 每条 stream 独立转发；在途口径与连接数分离（§2.4） |
| G1C.5 | datagram behavior **if enabled** | §2.5 冻结为不启用 → 这条变成**负例** | 客户端声明 datagram 支持时行为确定，且账目语义不变 |
| G1C.6 | drain | suspend 后有在途 stream | 不再接受新客户端；listener 保持绑定；有界排空 |
| G1C.7 | restart | 重启 ingress Agent | 端口重新绑定；配置与协议事实随 desired state 回来 |
| G1C.8 | LKG | 冷启动只带本地快照 | listener 从缓存恢复且协议事实保留（模型 G0 的 LKG 用例） |
| G1C.9 | old Agent admission | 旧 Agent（未广告 quic）上创建 quic Forward | 面板在**入队前**拒绝；没有租约、没有 listener（`docs/v5-1b-datagram-contract-draft.md` §7.3 同款） |
| G1C.10 | telemetry | 观测链 | 事实走 `diag`；**不进 `runtime_counts`**；面板能读到（§2.4） |
| G1C.11 | secret redaction | 日志 / 诊断 / Support Bundle | 不含私钥、不含 payload（模型 G1A.11、G1B.13） |
| G1C.12 | TCP/UDP regression | 重跑 V5-G0 与 V5-G1B 的关键断言 | 新协议没有破坏 stream 与 datagram 两条路 |

### 6.2 为什么它今天不是一个可写的脚本

G1A/G1B 的每一条都要求一个**真实的协议端点**。QUIC 的端点来自实现；没有实现就没有端点。
这**不等于** §6.2 的 B2（那时是「跨节点跳的形态是开放产品决策，所以不做 RELAY」，Gate 仍然
可以断言「RELAY 必须被拒绝」）；这里是**前提缺失**：连「被拒绝」都无从写起，因为
`quic` 今天就不在任何白名单里，那部分已被 G0.5/G0.7 覆盖。

**因此：Gate V5-G1C 是阻塞项，不是待办项。** 它不能像 G1A/G1B 那样先写脚本再补实现。

### 6.3 实现落地后，Gate 还必须包含这些 QUIC 专属负例

~~~text
ALPN 不匹配 / 客户端不给 ALPN      → 确定性拒绝（不是挂起）；§7.3 的取值被断言
0-RTT 尝试                        → 确定性拒绝（§2.7）
客户端声明 datagram 支持           → 行为确定，账目语义不变（§2.5）
客户端换地址（被动迁移）           → 按 §7.4 的落地策略确定性接受或拒绝
多 stream 并发                    → 不串线；stream 数与连接数两个事实都可见（§2.4）
stream 半开 / reset               → 上游连接被有界释放，不泄漏 fd
无 payload / 无密钥泄漏            → 模型 G1A.11、G1B.13 的 support bundle 断言
既有断言翻转                       → §8 第 8 条列出的 G0 / backend / agent / web 测试
~~~

**建议拆分**（与 `DEVELOPMENT.md` §6.2 的建议拆分同形，本文只建议、不实现）：

~~~text
WP5-C0  QUIC 语义契约 + 依赖决策      ← 本文；决策落地前 C1/C2 不得开工
WP5-C1  QUIC 前端（按本文 §7.2 的 transport 决策 + §7.3 的 ALPN）
WP5-C2  QUIC 观测 / 账目（按本文 §7.5 的落点）
Gate V5-G1C                            本文 §6.1 + §6.3
~~~

---

## 7. 需要决策（**不猜**）

以下每一条都是本文**没有**回答的，因为仓库事实无法唯一回答。它们不是「实现细节」，
选择不同会让契约形状不同。

1. **数据面依赖决策（§3 / §4）。** 引入依赖（A）/ vendor（B）/ 契约层关闭（C）/ 推迟（D）
   / 自研（E）——**这是 Lead 与其人类决策者的选择**。本文只提供证据与代价，不提供推荐：
   推荐等于替产品决定「零依赖属性值不值一份 13 模块的依赖 + 一次工具链升级」。
   **在它与 §7.2 落地之前，WP5-C1 不得开工。**
2. **QUIC 的 transport 槽位（§2.4）。** 三个候选：
   - (a) 把它算作 `stream`：最省事，但要么说谎（把 QUIC 连接当 TCP 连接），要么把 `stream`
     的定义改成含糊的「面向连接的字节搬运」——后者会让已经冻结的 `Drain` / 在途口径 /
     `SetUpstream` 三个语义同时变得不精确。`DEVELOPMENT.md` §5.3 的退出信号
     「大量不适用于 TCP 的空方法」正在这条路上。
   - (b) **新增第三个 transport**（例如 `muxed`）：形状最诚实，与 V5.1b 为 UDP 新增
     `datagram` 是同一个动作。代价：`FORWARD_TRANSPORT_SPECS.lifecycle` 要有第三个取值、
     Admission / RuntimePlan / 测试的枚举同步扩张、perf 基线要为它定义新场景
     （`scripts/perf/README.md` 已预告 QUIC 无覆盖）。
   - (c) 限制为「一条连接一条 stream」：否定 QUIC 的存在理由，且与真实客户端不兼容。
   **本文不选。** 注意这条**不依赖** §7.1：无论 QUIC 协议栈从哪来，槽位都要先定。
3. **ALPN 标识的取值（§2.3）。** 必须是某个确定的字符串（例如产品自己的 `tunex-quic-*`），
   并且要定义「客户端给别的 ALPN 怎么办」。本文只冻结「必须显式声明且被 Gate 断言」。
4. **被动迁移策略（§2.6）。** 接受还是拒绝；以及它是否需要成为面板可见的事实。
5. **QUIC 是否计费 / 字节如何入账。** 与 §6.2 的同一条缺口一样：v3 Agent 今天没有流量
   上报路径，`Stats()` 在生产路径没有消费者（`docs/v5-1b-datagram-contract-draft.md` §6.3）。
   QUIC 的 stream/连接两个维度是否入账、计在哪个链上，是产品决策。
6. **面板是否需要 QUIC 专属的开关 / 配额。** 今天唯一的现有开关是能力策略的
   `tunnel_types`（`backend/src/services/capability-policy.ts` 的 `protocol_not_allowed`
   分支与 `platform_ceiling` 交集逻辑）。「只允许 tcp 不允许 quic」不构成新机制；但是否
   需要别的粒度是产品问题。
7. **证书供给方式是否跨过「运维放文件」。** 与 §6.1 的待定项 2 相同：若产品要求面板托管
   证书（上传/签发/自动续期），那是一个**新 WP**，必须自带密钥存储与轮换设计，QUIC 只是
   第二个消费者，不能顺手塞进 V5.1c。

---

## 8. 与 §6.3 假设不一致的地方（给 Lead）

按重要性排列，全部是仓库事实或已标注的外部事实。

1. **§6.3 完全没有写实现前置条件。** 它写了开工顺序（UDP Gate 全绿）与七个语义问题，
   但 QUIC 的实现需要一个仓库目前不具备的东西：一份 QUIC 协议栈（§3）。这是 V5.1c 与
   前两个协议阶段**最大的不同**，也是本文 §3/§4 的全部内容。
2. **§6.3 的默认句预设了「有库」。** 「不因为库支持就自动开启 0-RTT / connection
   migration / 额外扩展」只有在一个库被引入时才有宾语。本文把这句话变成两条可执行契约：
   库的默认值**不能当作契约**；我们必须显式关闭/拒绝，并让 Gate 断言。
3. **路线图与 agent 属性矛盾，且从未被记下来。** `docs/tunex-devmap-v3.md:748/1024` 指名
   `quic-go`；`agent/README.md` 说 QUIC 需要 "large third-party forks" 所以不做；
   `agent/go.mod` 用注释宣示 stdlib-only。§6.3、§6.1、§6.2 都没有提到这个矛盾。
4. **七个问题是必要的，但不够：§6.3 漏问了两个由仓库自身分类强制产生的问题。**
   - **QUIC 落在哪个 transport 槽位**（§7.2）：`stream` 的定义句与 `datagram` 的 mapping
     语义都装不下它；
   - **ALPN 取值**（§7.3）：QUIC 必须协商应用协议，而仓库今天完全没有 ALPN 概念
     （`buildTLSStream` 只设 `MinVersion`）。
5. **`ProtocolDiagnostics.Protocol` 的注释把取值写成 "tcp / tls / ws"**
   （`agent/internal/forwarder/diagnostics.go` 的 `The front this tunnel terminates` 一行）
   ——udp 落地时它已经过时，quic 会让它更过时。这不是缺陷，但它是一个「封闭集合思维」容易
   误导人的位置：`diag` 本身是**开放对象**（面板对 `tunnels[i]` 只校验 id/端口/targets），
   而 `runtime_counts` 是**封闭键集**。两者的严格程度必须分开记。
6. **QUIC 与 UDP 抢的是同一个内核命名空间。** §6.2 冻结的保守规则让 `quic` 与 `udp` 不会
   撞号，但 `used_ports: number[]` 无法表达「这个 UDP 端口是 udp 还是 quic」，而 agent 的
   `UsedPorts()` 会把 `"udp:"` 前缀剥掉再上报（`docs/v5-1b-datagram-contract-draft.md`
   §5.3 记录了这个压平过程「不会报错」）。QUIC 让这个缺口从「一个协议」变成「两个协议
   共享一个端口号」。
7. **perf 基线已预告 QUIC 无覆盖，而 §6.3 的 Gate 清单里没有性能项。**
   `scripts/perf/README.md` 写明 QUIC（V5.1c）未覆盖，且「需要自己的场景与自己的指标口径
   ——尤其不能沿用『建连/握手』这类 stream 概念」。若 V5.1c 要交付，perf 场景与 V5-WP3 的
   对比基线需要一起立项。这是 §6.3 未覆盖的第三个缺口（仅次于依赖与 transport 槽位）。
8. **既有 Gate / 测试会必然翻转，必须在同一个 WP 内一起改**（否则新旧断言互斥）：
   - `scripts/v3-e2e/v5-g0.py` 的 G0.5 `for absent in ("quic", ...)` 与 G0.7 的 quic 用例
     （证据行 `docs/evidence/v5-g0-rerun-after-v51a-20261004.txt:32,50`）；
   - backend：`__tests__/forward-runtime-plan-v5.test.ts`（未开放协议列表含 `quic`）、
     `__tests__/runtime-admission-v5.test.ts`（广告了 quic 仍被产品门拒绝）、
     `__tests__/capability-manifest-v5.test.ts`（baseline 只含 tcp/stream 的断言）、
     `__tests__/scheduler.test.ts`（A1b 用 `quic` 当「Gate 未跑的协议」例子，并留有
     「例子必须随契约移动」的注释）、`__tests__/desired-snapshot-protocol-v5.test.ts`、
     `__tests__/tls-front-a1.test.ts`；
   - agent：`agent/internal/forwarder/factory_test.go`（`quic` 在「无 runtime」列表里）、
     `agent/internal/forwarder/forwarder_test.go`（`c.Protocol = "quic"` 当未实现协议）、
     `agent/internal/control/manifest_test.go`；
   - web：`web/src/lib/forward-protocol.ts` 的「未开放」分支与
     `web/src/components/forwards/__tests__/forward-protocol.test.tsx` 的渲染/复制断言。
   这不是缺陷（是 `docs/v5-1b-datagram-contract-draft.md` §7.4 处理过的同一类工作），但
   **QUIC 的翻转面更大**：它同时是 G0 的例子、admission 的例子、scheduler 的例子与 web
   的例子。
9. **一处正面发现（与 udp 相同）。** `quic` 早就在遗留 DB 枚举
   （`backend/prisma/schema.prisma` 的 `enum TunnelType`）、wire 词汇表
   （`backend/src/services/control-protocol/types.ts` 的 `TUNNEL_TYPES`）与 web 类型里，
   所以**协议投影零迁移**（`wireTunnelTypeForForwardProtocol("quic")` /
   `legacyTunnelTypeForForwardProtocol("quic")` 直接得到 `"quic"`，
   `backend/src/services/forward-contract.ts`）。需要迁移的只有**授权**：
   `platform_ceiling` 目前是 `tcp/tls/ws/udp`
   （`backend/prisma/migrations/20261016000000_v5_wp5b1_udp_entitlement/migration.sql`），
   不含 quic。若协议开放而上界不含它，**没有任何 workspace 能创建**
   （`capability-policy.ts` 的 ceiling 交集），Gate 会以一堆 `protocol_not_allowed` 失败
   ——与 V5.1b 的教训完全一样。

---

## 9. 本文不做什么（边界）

- 不写任何 Go/TS 代码、不提出补丁、不改任何代码文件、**不新增依赖**；
- **不替产品选择** §7 的任何一项，尤其是数据面依赖（§7.1）；
- 不把「库有开关」当作契约（`Allow0RTT` / `EnableDatagrams` / 迁移 API 的默认值只是实现
  的属性，不是我们的承诺）；
- 不把「枚举 / 词汇表里有 `quic`」当作产品支持（WP0 铁律，§6.1 第 1 问）；
- 不设计跨节点跳用的 QUIC（那是另一个 WP，见 §2.1）；
- 不把 QUIC 的 datagram extension 与仓库已有的 `datagram` transport 混为一谈（§2.5）；
- 不定义 Gate V5-G1C 的可执行脚本（前提缺失，§6.2）；只定义它**必须**包含什么。

---

## 10. 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-10-04 | DRAFT 初版：七个问题的回答（5 个可冻结 + 2 个部分冻结）、依赖阻塞的证据与五个选项的代价、Gate V5-G1C 映射、9 条与现有代码/路线图不一致的地方 | V5-WP5-C0（草案，待评审） |

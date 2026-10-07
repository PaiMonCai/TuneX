# ABCD 核心开发记录与验收

日期：2026-10-07。分支：`feat/forward-core-abcd`；开发基线：`fa815ebe4cf42c4376ef9321922fd233a8e8ba2a`。

这是功能比较后的实施记录。优先处理隧道转发，支付、套餐、插件和移动端继续后置。本文区分代码已实现、本地已验证与发布验收，不能用类型检查或 HTTP fixtures 替代真实多节点转发。

首版已提交并推送为 `8b0abbc`，草稿 [PR #75](https://github.com/PaiMonCai/TuneX/pull/75)。随后提交 `777a94b` 完成 [FXP 每规则流量切片](./LINK_TRAFFIC_IMPLEMENTATION.md)，接入现有额度与历史流量表。首轮失败及后续修复保留在统计记录中；下面的本机验证表属于首版证据，不能代替后续候选提交的 CI 结果。

## 1. 本轮范围

| 方向 | 实现入口 | 当前边界 |
| --- | --- | --- |
| A：加密共享连接 | 独立 `LinkResource`、不可变 `LinkVersion/LinkDeployment`、专用 `/api/links` 与 `/links` 页面、托管 FXP 子进程 | 首轮固定两个自有节点；独立连接可无业务规则，入口为空时待命。规则引用同一连接；端点修改限未部署且零引用，轮换密钥限零引用。新增、改目标/限制、移业务端口、删除只重建受影响规则；协议/监听范围修改需新规则。 |
| B：协议与端口 | FXP 规则 TCP/UDP/both；数据库协议/地址租约与 Agent 统一端口守卫 | TCP 与 UDP 可同号；未知历史协议保守占两类。原生普通 Forward 的 `both` 继续关闭，不能把实验 Link 的能力推广到所有运行路径。 |
| C：实际运行限制 | 表单、业务修订、下发、恢复、原生 Agent 与 FXP limiter/gate | 每规则、每入口 runtime 的双向 bytes/sec、总并发、每源 IP 并发。UDP 并发指活跃映射。0 请求值表示不设规则上限，仍受工作空间天花板限制；工作空间 0 额度禁止转发。不是工作空间多节点总带宽池。 |
| D：目标策略 | 原生出口池 fallback、RR/random/weighted、健康与恢复、IP_HASH selector | fallback 按目标优先级和现有健康事实选择。IP_HASH 必须得到可信客户端 IP；现有 RELAY/EGRESS 不透传来源，明确拒绝。选择器及可信来源注入已有实现，不等于全部面板路径已开放 IP_HASH。FXP Link 首轮每条绑定一个目标。 |

`RouteProfile` 继续作为模板，`NodeGroup` 继续作为节点调度/访问资源。两者都不冒充独立运行的 Link。业务目标、限制和状态的唯一写入源仍是 Tunnel/ForwardRevision；LinkDeployment 仅保存合并编译的不可变部署快照。

## 2. 核心处理方式

### 复用 ForwardX

独立导入 `third_party/forwardx/forwardx-fxp`，来源提交 `cb0ef0bb156dc114e4344c887328018491fbd638`，项目版本 2.3.281；FXP 程序内部版本 2.2.117。保留 AES-GCM 载体、TCP/UDP 帧和 limiter/gate，增加托管边界，不依赖用户的只读 `Forwardx/` 目录构建。

保留 AGPL-3.0-only 许可证、依赖声明、原文件哈希及修改说明；Agent 镜像携带独立程序和对应修改源码。这里没有给其他 TuneX 源码指定许可证。分发/运营前须完成适用许可和源码访问安排的核对。

### 授权、身份和恢复

- 出口只允许编译好的 rule/protocol/target binding；持有连接密钥不意味着可以选择任意目的地址。
- `apply_link/remove_link` 使用现有队列与 ACK，核对节点、工作空间、代次及配置摘要；迟到 ACK 不确认更高的 Forward 修订。
- 传输密钥用独立 `TUNEX_LINK_SEAL_KEY` 封存，按工作空间、Link 和代次绑定；不复用 AUTH_SECRET。
- Agent 私有缓存加密，删除墓碑持久化；租约 180 秒，周期续租。授权失败、身份不符、损坏快照不允许借旧缓存继续运行。
- 当前配置与修订、协议授权、流量额度和最新限速天花板都参与续租复核。额度收紧生成新代部署，授权/流量拒绝标记 `policy_blocked` 并移除；恢复后生成更高代次。
- 普通 Forward 的写入、恢复与 reconcile 路径排除 Link 规则，避免同时启动一个明文原生 runtime。

### 端口与变更

一张 `NodePortLease` 表管理 node/protocol/bind_scope/port。节点同号端口的区间锁负责通配/具体地址竞争，唯一键负责精确绑定；Redis 仅优化竞争。

新增、修改、恢复规则先合并校验所有绑定，并在业务事务内预留端口；失败时不提交新的规则或代次。部署按出口授权→入口监听顺序应用；仅两侧确认完整快照后释放旧槽位。删除最后一条规则保留独立出口连接；退役先停入口，再停出口，确认后释放整个 Link 的租约。

部署 ACK 是历史确认。页面只有在新鲜 Agent 报告的身份、代次、摘要及租约全部匹配时显示运行；缺报告为未知、过期为 stale、入口零规则为 passive。

Link 应用或删除成功后，Agent 在发送命令 ACK 前主动上报当前运行和端口事实。即时报告与周期报告串行采集、发送，防止删除前的在途报告覆盖删除后的空闲事实。报告失败不改写已经成功的运行结果；面板保留旧占用，直到后续报告确认，不能凭 ACK 猜测未知端口已经空闲。

## 3. 验证记录

已经验证的项目：

- 编译器、严格版本解析、密钥封存、命令授权、运行事实投影。
- 生命周期隔离场景：共享 A/B 合并、迟到 ACK、端口冲突不落库、部分应用失败、退役重试、策略收紧/撤销/恢复、暂停与恢复写入修订。
- 独立 FXP 可执行程序与真实本地 TCP/UDP echo：同号端口、加密载体贯通、both 并发共享、规则间预算隔离。
- 托管共享热更新实测：新增、改目标/限制、移动 A 的业务端口、删除 A，以及新绑定失败补偿；原 B TCP 会话和固定 UDP 目标 socket 持续服务。此前 251 组往返、最终程序复测 236 组往返，TCP 断连与 UDP 映射变化均为 0；此为本机 loopback 证据，不替代 Linux 多节点 gate。
- Agent 原生协议、目标策略、限流、恢复和端口守卫测试；backend/web 类型检查。
- `/links` 的组件/契约测试及独立浏览器点击。浏览器验证使用内存 HTTP fixtures，未连接数据库或 Agent，详见前端 [EVIDENCE](../../../web/src/components/links/__tests__/EVIDENCE.md)。

收尾复测结果（仅列本轮实际执行的范围）：

| 验证 | 结果 |
| --- | --- |
| backend 编译、密钥/命令、生命周期、运行观测、端口与真实 FXP loopback，10 文件 | 112 pass / 0 fail，2255 assertions；端口测试使用注入存储，未验证真实数据库并发 |
| web Link API/页面与策略表单，3 文件 | 33 pass / 0 fail，200 assertions |
| Agent control/reporter/linkrunner/manager/portlease/forwarder | 六包通过；包含即时事实刷新与报告顺序验证 |
| Agent restore 的两项策略恢复测试 | 通过；不等于整个 restore 测试包通过 |
| 独立 FXP 测试、Agent `go vet ./...` | 通过 |
| Agent 和 FXP Linux amd64 交叉编译 | 通过；未在 Linux 运行 |
| backend/web TypeScript、Prisma schema validate | 通过；schema validate 不连接数据库、不执行迁移 |

本机 Windows 全量 `restore` 测试仍有既有 `TestConcurrentCacheWritesStayValid` 文件并发读写锁失败，不能报告 Agent 全量测试通过。最终六包回归和策略恢复测试通过；该平台问题与完整 Linux 回归一并由 CI 继续验证。后端端口测试加载模块时还触发了本地 Redis 单例连接失败，分配逻辑使用的是注入存储；这些结果不能用作真实 Redis 集成证据。

尚不能在本机记为通过的项目：

- Linux 容器实际镜像构建、MySQL 迁移与数据库并发租约门禁。
- Panel/Worker、多 Agent 的真实网络部署、共享更新保留原 TCP 会话和原 UDP 目标 socket、重启恢复与事实上报。

本机无 Docker/可用 Linux 环境。CI 的 `core-integration` 执行 `scripts/integration/abcd-core-gate.sh`，进入统一 required 检查。候选 `777a94b` 与 `4b2c9d2` 均已在四 Agent、Panel/Worker、MySQL/Redis 的真实 Linux 拓扑通过 35 项验收；包含双协议转发、共享规则更新、同日增量、重复去重、历史保留及重启恢复。`4b2c9d2` 后端的 3169 项 unit/contract 与 111 项数据库/HTTP 集成也通过，Agent 存在一次启动 fixture 失败，正在修复。最终候选和统一门禁结果见统计记录。公共支持矩阵继续 planned；长期统计容量、可信来源与更多目标组合仍需独立发布验收。

## 4. 测试环境启动

1. 备份测试数据库与服务配置，核对五项新增迁移；先部署兼容的新 Agent，再部署 Panel/Worker。
2. Panel 和 Worker 使用相同安装级 `TUNEX_LINK_SEAL_KEY`（独立生成 32 字节、64 位 hex），设置 `TUNEX_FXP_LINKS_ENABLED=true`。
3. Agent 设置同名功能开关，使用包含 `/usr/local/bin/tunex-fxp` 的新镜像；显式注入有效 Agent 版本。私有状态目录只供 Agent 服务账户访问。
4. Linux 验收机执行 `bash scripts/integration/abcd-core-gate.sh`。该脚本使用现有隔离测试拓扑，不连接生产库。
5. 确认数据库 gate、现有 current-protocol/A00 回归和新共享 gate 全通过，检查证据后再决定发布版本及最小 Agent 版本。

关闭开关只表示停止续租，新缓存会在租约到期后停止。正常回滚应先删除/暂停 Link 业务绑定并确认停止，再退役连接；保留独立 seal key 和私有状态，不能直接回退删除新增列。若控制面无法确认停止，等待本地租约到期并核实端口后再复用。

## 5. 保留的后续工作

本轮不是 ForwardX 全量对齐。FXP 每规则流量已通过独立累计快照、精确存储 ACK 与事务水位接入现有计量；仍需完成长期活动 producer 的已确认历史裁剪。其他独立切片包括：原生 both 的全路径支持、可信来源透传后的面板 IP_HASH、多目标 FXP 绑定、链/多入口/多出口、多节点总预算分配、在线有引用密钥轮换、已部署端点迁移。不能用 native reporter 的空流量替代 FXP 业务流量，也不能把当前采样、上报和额度检查称为无超额窗口的实时配额池。

GOST/WireGuard 和系统转发驱动、DDNS、批量导入导出和复杂运维仍沿用后续方案，各自完成真实载体/接口验收后再开放。支付继续后置。

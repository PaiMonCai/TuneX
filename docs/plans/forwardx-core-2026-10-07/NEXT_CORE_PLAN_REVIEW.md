# TuneX 核心转发后续开发方案与现有路线修订

> 日期：2026-10-07。目标：先把隧道转发做通、做稳定、做易用，再扩展运营功能。
> 审查基线：`origin/main@fa815ebe4cf42c4376ef9321922fd233a8e8ba2a`。
> ForwardX 参考：`2.3.281@cb0ef0bb156dc114e4344c887328018491fbd638`。
> 本文件属于方案审查；业务代码未修改。当前工作区仍在旧功能分支，以下判断以主线源码为准。

## 1. 结论与本轮目标

现有六阶段路线的方向成立：固定上游、验证 FXP、建立独立 LinkResource、接入托管生命周期，再扩展协议和拓扑。需要调整的是发布门槛、阶段拆法和核心能力优先级。

下一轮的产品目标是：用户可以创建一条真实加密的点对点连接，让多条 TCP 或 UDP 转发规则复用它；编辑、删除其中一条规则时，其余规则继续工作；Agent 重启、面板暂时不可达、旧配置重放和升级失败时，资源与状态仍然正确。

优先复用 ForwardX 已成熟的 FXP 协议实现、配置语义、TCP/UDP 转发、连接限制、限速、目标选择及运行状态处理。TuneX 保留现有 Workspace/RBAC、部署版本、reconcile、租约、审计与前后端技术栈，通过适配层接入。避免同时重写协议、控制面和 UI。

本轮不以“全面对齐 ForwardX”作为一次发布目标。先交付下面的 R1 核心版本，再做 `both`、更复杂拓扑与更多驱动；支付、营销、AI、插件市场及移动端继续后置。

## 2. 主线现状：已合入不等于完整验收结束

| 项目 | 已确认的源码状态 | 后续边界 |
| --- | --- | --- |
| 登录基础安全 | #70 修复 hydration 前表单行为 | 仍需生产模式浏览器验收，与转发 UI 一并完成 |
| TCP/UDP 基线 | #71 将现有真实多 Agent 环境纳入 A00 入口，并加入删除、清理、同端口复用脚本 | 合并脚本不能替代指定候选提交的执行证据 |
| 加权出口 | #72 覆盖下发、retry/resume 和启动恢复；已有真实验收脚本 | 沿用现有选择器，补充故障窗口、恢复与配置更新验收 |
| 批量删除 | #73 提供逐项权限、失败隔离和 remove revision tombstone | 还要验证重启后的旧状态重放与浏览器交互；默认开关按验收证据决定 |
| 节点状态 | #74 增加 stale/unknown 等状态真值测试 | 新 Link/FXP 必须沿用 desired 与 observed 分离 |
| A01 契约 | 协议、front、carrier、driver、digest、逻辑 runtime id、未来租约键已定义 | 尚无 LinkResource 数据库闭环、FXP runner 或新功能 UI |
| 上游对拍 | fixture 明确记录 `upstream_executed=false` | 不能宣称已完成 ForwardX planner parity |
| 能力矩阵 | FXP/GOST/WG/`both` 保持 `planned`，新契约禁止降级到明文 | 只有完成正式发布验收，具体组合才可变为 `available` |
| Agent 版本 | 准入检查非空、特定 `unknown` 字符串和能力列表 | 尚未解析版本或比较 `minimum_agent_version` |
| 核心策略 | 部分下发仍为 `speed_limit: 0` | 服务端字段与额度检查不代表数据面带宽、连接/IP 限制已生效 |

本轮重新获取远端后，`origin/main` 仍是以上提交。已读取主线契约、A00/A01 文档、下发路径、删除围栏、离线缓存以及参考 FXP 出口代码。本轮对主线 A01 纯测试的验证结果为 **10 pass / 0 fail，32 assertions**；没有重新执行完整 Linux 多节点验收、生产浏览器验收或核验全部 GitHub Actions 记录。

用户提供的交接说明报告了上一轮真实 weighted/batch 验收结果；应整理这些结果并关联候选 SHA，不能因为当前文档尚未归档就认定从未执行，也不能把其他提交的结果当成新候选已通过。

## 3. 对原方案的必要修改

| 优先级 | 原路线的问题或未明确的边界 | 修订要求 |
| --- | --- | --- |
| P0 | FXP 单规则 PoC 通过后即将矩阵改为 `available` | PoC 只通过内部实验入口；正式开放必须同时完成共享规则隔离、托管生命周期、版本准入和真实网络验收 |
| P0 | 已声明最低版本，准入函数却没有比较 | 解析合法版本、明确 prerelease 策略、验证两个端点和实际 runner 版本；不合法、低于门槛或能力缺失时给出明确拒绝原因 |
| P0 | “共享 carrier”没有同时定义共享后的权限边界 | 控制面验证 Workspace、节点和资源使用权；出口数据面根据授权 binding 映射决定目标，不能仅因为密钥正确就接受任意 RuleID/target |
| P0 | tombstone 被当成覆盖所有重启场景的保证 | 当前是进程内 map；补充删除后断线、重启、旧 snapshot/命令重放的组合验收，再决定持久化水位或权威 epoch 方案 |
| P0 | A00 的总完成标记过于宽泛 | 统一现有协议、删除、weighted、batch、状态与浏览器证据；每个结果记录候选 SHA、镜像、时间及未执行项 |
| P1 | A02 先做大量模型/API，A03 再让它真正运行 | A02 与最小 A03 组成同一纵向切片：创建资源、绑定两条规则、真实传输、修改与删除；避免只有 CRUD 的阶段成果 |
| P1 | 限速、连接限制、基本主备被放到复杂 chain 之后 | 前置到点对点核心版本；先做目标健康、主备切换与已有加权出口的可靠性，再做链路自动选择和多活 |
| P1 | 版本化 runtime id 与同端口升级的关系不明确 | 区分逻辑配置 ID、稳定进程/监听槽位、deployment generation；升级同端口不得出现新旧双 writer/双占用 |
| P1 | 零 binding 时“两端正常”与 runner 数量定义模糊 | 共享的是资源、配置编译和生命周期，不要求一个进程或一条物理连接；允许符合上游语义的被动入口标记，并分别展示资源状态与业务可用性 |
| P1 | `both` 租约升级只在最后开始考虑 | 端口冲突矩阵和迁移设计提前并行，正式启用放在点对点稳定后；不能靠增加 enum 或唯一字符串解决 wildcard/dual-stack 冲突 |
| P1 | 首轮对拍范围包含所有 GOST/WG/m* 语义 | 先对拍将发布的 FXP TCP/UDP、目标与认证语义；未接入驱动的对拍随驱动推进，不阻塞第一条完整转发链路 |

### 3.1 两项源码证据需要特别保留

`admitExecutionSelection()` 目前只拒绝空版本及精确的 `unknown`，然后检查能力。使用原有 native TCP 组合和正确能力，本轮探针中 `not-semver`、`UNKNOWN` 都获得 `ok: true`。`minimum_agent_version` 字段存在，但函数没有比较它。这是新契约的准入缺口；目前非 native 驱动仍未开放，不能将它描述为已发布 FXP 的漏洞。

ForwardX 的 `handleExitSessionWithStartup()` 解密 hello 后，用 hello 中的 target；为空时才补配置目标，随后 `handleExitTCP()` 直接 dial。该路径未见按 TuneX Workspace/binding 校验目标的逻辑。上游已有加密和密钥握手，不能因此推导“无认证”；需要补的是**持有合法共享凭据却请求未授权 binding/target**的拒绝能力。复用 upstream 时应增加明确的出口授权适配，并记录该行为与上游的差异。

## 4. 复用方式与资源事实

### 4.1 优先复用范围

| 层 | 复用或保留内容 | TuneX 必须提供的适配 |
| --- | --- | --- |
| FXP 协议 | 上游加密、握手、帧、TCP/UDP 运行逻辑 | 固定版本/构建来源、授权 binding、密钥生命周期与失败报告 |
| FXP 策略 | 上游方向限速、连接/IP gate、目标与 PROXY 语义 | TuneX 策略单位/作用域映射、真实执行证据、可信来源约束 |
| 配置编译 | 上游 entry/exit/规则关联、角色及被动 marker 语义 | 单 compiler 合并全部 binding，生成不可变版本与配置摘要 |
| 控制面 | 保留 TuneX RBAC、租约、rollout/reconcile、fencing、审计 | 新 Link desired 与 Forward desired 各自归属，避免竞争写同一个 runtime |
| Web | 复用业务操作和术语，继续使用现有组件体系 | 创建资源、选择资源、影响预览、逐项错误、真实状态 |

导入前记录 ForwardX 的 `AGPL-3.0-only`、依赖来源和目标分发方式，并完成项目许可/分发兼容性决定。优先导入当前切片需要的源码或固定构建产物，保留来源、许可证与改动记录；不要求把整个上游面板一并迁移。不根据本文件作未经核实的许可结论。

CI 的来源可以是经审查的 `third_party/forwardx/` 快照，或固定 commit/hash 的获取与构建流程；都必须可复现。用户下载的未跟踪 `Forwardx/` 保持只读，不能成为 CI 的隐含依赖。

对拍分两类：上游已有行为做语义 parity；TuneX 新增的 Workspace/RBAC/binding 拒绝做本项目负例。不能为了“对拍一致”删除 TuneX 必须保留的边界。

### 4.2 模型建议：A01 冻结名称与归属，还未冻结完整表结构

| 事实 | 第一版必要字段/行为 |
| --- | --- |
| LinkResource | Workspace、名称、kind、期望状态、当前版本引用；第一版 UI 只开放 point-to-point |
| LinkVersion | 不可变拓扑/策略输入、schema version、digest；不写明文密钥 |
| LinkDeployment | 目标版本、generation、observed generation、部署状态、controller ownership、失败原因 |
| LinkPlacement | 固定节点、角色、实际 runner、稳定监听槽位、租约和 fencing token |
| ForwardLinkBinding | Forward 与 LinkVersion/Deployment 的关联、业务协议/监听/授权目标、binding revision；不复制一套可变拓扑 |
| TransportCredential | 密文或受控 secret 引用、Link/binding 作用域、key epoch、轮换/撤销/到期事实 |

具体唯一键、外键、事务和 API schema 在第 3 个 PR 中明确，不能把现有 `CanonicalLinkVersionInput` 的抽象字段直接当成完成数据库设计。

保留旧 `legacy_private` writer 和既有自动路径准备。RouteProfile 是创建预设；NodeGroup 是节点组织/调度能力；两者都不自动转换为有独立 runtime 的 Link。新旧资源显式选择、迁移逐条进行，禁止批量自动重新标记“已加密”。

### 4.3 必须写入实现的运行约束

1. 一个 deployment 只有一个 compiler/writer；所有 binding 汇总到同一配置，再以 CAS/generation 发布。并发新增、删除与编辑不能覆盖兄弟规则。
2. A01 版本化 runtime id 保留为逻辑身份；监听/进程槽位的升级交接另有稳定身份。支持 reload 的 runner 原位更新；需要 restart 的 runner 明确 drain、短暂停顿和失败回滚，不能承诺无损更新。
3. Link 更新先预览受影响的规则，再灰度/应用；成功后的 observed generation 才能代表新版本运行。单条业务目标故障不应被误报为整个 carrier 不可用。
4. 删除 A 只删除 A 的 binding/业务运行时；B 与共享载体继续存在。引用中的 Link 删除返回 409。零 binding 的 Link 可保留必要出口与被动状态，显式删除才清理其资源。
5. 端点和 binding 认证分开。优先保留 upstream framing，在出口使用受控映射核对绑定并确定目标；如必须改 wire format，单独标明协议版本和互通范围。
6. 删除围栏要覆盖重启、离线恢复和旧配置重放；方案可以是持久水位或权威 epoch，但必须有崩溃一致性、资源上限与安全 GC。
7. 既有 LKG 不存凭据；新 runner 不能把 transport key 塞入明文 desired JSON。定义受限本地 secret 保存、绑定 Agent 身份、有效期与过期关闭策略，测试面板不可达时的恢复边界。
8. UI 分别展示已启用、部署中、运行、退化、不可达与业务目标故障。无绑定资源和被动 marker 不假装已验证业务转发。

## 5. 修订后的开发顺序

### S0：补准入与可复用验收基线

范围：为当前切片固定上游来源；补合法版本与最低版本比较；整理现有 A00 脚本/证据，不搭第二套环境。

交付：FXP TCP/UDP 上游 fixture 与适配 fixture、来源清单、版本/能力负例、A00 汇总入口和证据 manifest。未知/过旧端点返回明确错误，不通过 secure-to-native fallback 绕过。

验收：上游对拍确实执行才更新对应 fixture 标记；单测覆盖非法版本、边界版本、prerelease、缺能力与不支持的组合。A00 汇总能区分已执行、失败、未执行、跳过原因，并关联同一候选版本。

### S1：FXP 实验驱动与共享隔离证明

范围：两台真实 Agent，复用 FXP TCP/UDP 核心；加入最小受控启停、配置加载和日志采集。实验入口不改变公共 `planned` 状态。

交付：受控二进制/源码构建、配置转换、端点身份与密钥、出口 binding 目标映射、实验验收脚本。具体 Agent 最低版本来自真实构建；同时记录 runner 版本/hash。

验收：单规则 TCP/UDP真实载荷；错误密钥、重放、合法密钥但错误 binding/target 均拒绝；两个 binding 共享资源；删除/修改 A 后 B 继续工作；两端重启、面板重启、删除清理与同端口复用。

控制面 wrong workspace/node 的拒绝和数据面 forged binding 的拒绝分别验证。跨 Workspace 共享资源先不开放。

### S2：A02 + 最小 A03，交付第一条完整点对点链路

范围：模型、API、compiler、Agent 托管与最小 UI 一起落地，固定一入口、一出口；TCP 和 UDP 分别创建规则，尚不开 `both`。

交付：创建/版本/部署/影响预览/绑定/删除 API、单 writer、幂等命令、状态投影、最小资源列表和规则表单。部署失败保留可追踪事实并释放未生效的预约，不返回假成功。

API 建议按资源归属拆分：Link 创建与版本；deployment 的预览/发布/回滚；Forward 的绑定与解绑。写操作携带期望版本或 generation、幂等键及审计上下文；列表和详情只返回脱敏凭据摘要。

验收链：创建 Link → 部署 → A/B 两规则真实传输 → 并发编辑/删除 A → B 正常 → 删除引用中 Link 得 409 → 删除 B → 零 binding Link 保留 → 显式删 Link → 两端监听、进程、凭据引用、租约全部收敛清理。

### S3：点对点发布加固、真实限制与基础主备

范围：完善 prepare/apply/restart/reconcile/degraded/rollback/delete；接入最必要的策略和诊断。目标故障切换优先，自动选路与多活后置。

策略交付：双向带宽单位和口径、总并发连接数、每个来源 IP 的并发连接数、UDP mapping 数/idle timeout。明确作用域是 binding、Link 还是 Workspace；共享资源不能让每条 binding 都获得全部预算。第一版先用固定配额分配，不做分布式多活预算算法。

本轮进一步核对确认：ForwardX FXP 的 `maxIPs` 实际赋给 `maxPerIP`，按 `ips[ip]` 限制单来源并发，并不限制不同来源 IP 的总数量。“同时来源 IP 数上限”和“CIDR allow/deny”作为独立可选策略，在方向选择后确定是否进入 R1；不能声称复用该字段就已完成。详见 [逐项功能对比](FUNCTION_COMPARISON.md) 的 L09–L11。

策略只对已经证明执行的 driver 开放；未实现的旧 driver 明确拒绝或标记不支持，不能静默传 `0`。复用 FXP 现有限制器并做协议映射，禁止只补数据库字段或 UI 开关。

基础主备交付：复用现有 target-health/出口选择框架，补目标探测、失败/恢复窗口、重试与回切、明确新连接与已有连接的行为。对同一出口上的多个业务目标先做主备；跨节点切换涉及 placement/租约时，在本阶段先冻结规则，在后续拓扑阶段开放。

诊断交付：每规则/Link 的 observed generation、最后错误、目标健康、活动连接、UDP mapping、方向流量和受限日志；必要时真实主动测试，不以 desired active 代替 online。

验收：限速曲线和 burst 误差有证据；总连接/每来源并发拒绝正确且退出后释放；如果选择新增 IP 数/CIDR 策略则分别验收；UDP 大报文和闲置回收；主目标故障后新连接切备，恢复按窗口回切；Panel/Agent 崩溃、乱序和撤销凭据后仍满足资源与授权边界。

**R1 发布门槛在 S3 末尾。S1 PoC 或 S2 CRUD 成功均不足以将 FXP 标为 available。** 按具体 TCP/UDP 与 front 组合开放，不将未验收的 TLS/WS/m* 一起开放。

### S4：A04，TCP+UDP 同端口与协议感知租约

范围：`both` 编译为独立 TCP/UDP children；节点、规范化 bind scope、协议和端口共同参与冲突判定。设计可与 S1/S2 并行，启用依赖稳定生命周期。

交付：Prisma 迁移、Agent 冲突检测、所有入口/出口租约读写、恢复与对账升级；两个 child 的原子预约、部分失败补偿和真实状态聚合。

验收：同端口 TCP+UDP 同时有真实载荷；同协议重占拒绝；IPv4/IPv6/wildcard/dual-stack/v6only 组合符合 Linux 实际监听行为；一 child 失败不泄漏另一份预约；删除/重启/旧数据迁移后同端口可用。

迁移先检查旧租约并通过兼容版本部署，再开启 `both`；有 `both` 数据后的回滚需要关闭新建并转换/停用相关资源，不能直接回退旧唯一约束。

### S5：拓扑扩展与更多转发驱动

顺序：已有简单中继兼容 → 新 Link chain 的逐跳版本/认证/租约 → 固定跨节点主备和多出口 → 受控健康选择 → 多入口/多活 → 自动最佳路径。

先沿用已有加权策略与健康设施，避免把 weighted 出口重新从零实现。每跳可选 carrier 要在对应 driver 真正通过验收后开放；链路失败需能定位具体 placement/hop。

新增驱动顺序以用户场景决定：GOST TCP/TLS/WSS → 必要的 PROXY/outbound 选项 → WireGuard/FXP v2 → m* 与系统驱动。内核驱动的权限、进程隔离和发行资产单独设计，不默认扩大所有 Agent 的权限。

多活上线前，明确每个入口独立 placement ownership、全局限额的分配、失联 fencing 和故障转移。自动选路、成本/容量优化和可视化编辑器随稳定拓扑再做。

## 6. 前六个 PR 的具体拆分

| PR | 开发内容 | 依赖 | 完成标准与回退 |
| --- | --- | --- | --- |
| 1：来源与准入 | 上游最小来源清单/可复现构建；FXP fixture；版本解析、floor、能力检查 | 当前 main | 未发布组合仍关闭；版本负例和上游执行证据通过；回退不触及旧规则 |
| 2：实验 FXP runner | Agent 受控运行、编译适配、出口授权、双 binding 实验脚本 | PR1 | TCP/UDP、错误凭据/绑定、A/B 隔离、重启/清理通过；只撤实验 driver，不改变公共支持矩阵 |
| 3：点对点模型与 API | 六类资源事实、唯一键/事务、RBAC、generation、影响预览；定义稳定监听身份 | PR1；结合 PR2 实际语义 | 迁移可前后兼容；引用删除 409；并发/权限/补偿真实 DB 测试；不开普通用户入口 |
| 4：完整点对点切片 | 单 compiler、调度/托管/reconcile、状态、最小 UI；真实 A/B 绑定生命周期 | PR2+PR3 | 两规则共享、编辑/删一条不影响另一条、零绑定/显式删除、同端口更新验收；按新资源开关回退 |
| 5：发布加固与策略 | 删除重启围栏、secret/密钥生命周期、限速/连接/IP、目标主备、必要诊断 | PR4 | R1 所有适用项通过后才开放具体组合；失败回到前一配置，保留失败 generation 供诊断 |
| 6：both 与租约迁移 | TCP/UDP children、bind 冲突、迁移/恢复、兼容 Agent 门槛 | PR3 身份约定；上线依赖 PR5 | `both` 真正可用、无重复占用/租约泄漏；关闭新建并迁移资源后才能回退旧约束 |

每个 PR 保持可独立审查。PR5 的策略和生命周期可分两个 PR，并行开发；正式发布仍由同一个 R1 门槛约束，不扩大单次改动范围。

关键路径：**固定来源/准入 → 实验 runner 与授权 → 模型 + 第一条受控点对点链路 → 生命周期/策略验收 → R1**。

可并行：A00 证据归档；端口冲突与迁移设计；目标健康/选择器核对；UI 对现有模型的术语整理。不要并行改两个 deployment writer，也不要在模型未定时同时重写全部规则页面。

工作量以人日而非承诺日历计算：S0 约 3–5 人日，S1 约 5–8，S2 约 8–14，S3 约 8–14，S4 约 6–10。此为源码审查后的粗估，S1 完成后重新估算；不包含全驱动、复杂多活、部署等待或许可方案调整。

## 7. R1 必须具备的真实验收

复用 `scripts/integration/` 的 Linux、MySQL、Redis、Panel、Worker、多 Agent、控制/数据隔离网络和 TCP/UDP target。PR 快速测试继续保留；完整网络验收在候选发布上运行，结果保存为可追溯 artifact。

| 类别 | 必须验证的行为 |
| --- | --- |
| 协议 | TCP 长连接/短连接、UDP 多客户端/大报文/idle、IPv4/IPv6；记录实际支持范围和 UDP payload/MTU 边界 |
| 共享 | A/B 真实传输、增删改并发、A 更新/删除后 B 正常、配置 generation 不丢 binding |
| 授权 | 错误 Workspace/节点、错误密钥、合法密钥伪造 binding/target、撤销/过期；区分控制面与数据面 |
| 删除 | 删除、断线、重启、旧 snapshot 和延迟命令重放；监听/进程/租约无残留，同端口可重新创建 |
| 恢复 | 两端重启、Panel 不可达、有效/损坏/过期 LKG、复制到不同 Agent；不泄漏密钥、不恢复已删除资源 |
| 更新 | 同端口版本升级、旧 generation 拒绝、runner reload/restart 失败、进程崩溃、回滚与两端不同版本 |
| 限制 | 实测方向速率、总连接/每来源并发 gate、UDP mapping；兄弟 binding 不绕过共享预算；新增 IP 数/CIDR 按选定范围验收 |
| 目标 | 主目标超时/拒绝/恢复，故障与恢复窗口；现有 weighted 配置和重启后的策略保留 |
| 状态 | desired/observed/target health 区分；stale/offline 与被动 marker；每规则和 Link 计数口径准确 |
| 兼容 | 原 native TCP/TLS/WS/UDP、自动路径准备、模板及 legacy 规则继续工作；不把旧明文标为加密 |
| UI | 非 mock 生产构建上的登录、创建/部署/绑定/编辑/删除、取消、双击、跨页、部分失败和权限提示 |
| 发布 | 候选 SHA、镜像 digest、Agent/runner 版本、fixture hash、执行时间、结果及 skip 原因完整 |

安全回退：先停止新 Link 创建，再回退目标 generation；旧规则 writer 不受开关影响。新 Link 功能回退不等于取消已部署资源，需要明确 drain/保留运行/清理策略。测试环境使用既有 teardown，不能手工删 DB 租约“修绿”。

## 8. 第一版 UI 与暂缓范围

导航按业务事实解释：节点 = 在哪里运行；连接资源 = 节点之间如何连接；转发规则 = 从哪个监听端口到哪个目标；模板 = 创建预设。

第一版只需要连接列表/详情、创建点对点、部署与影响预览、规则选择连接、真实状态及错误处理。继续保留旧转发创建入口。高级参数随已通过验收的功能开放，不用未运行的 enum 填充下拉框。

暂缓：支付/套餐/优惠券、营销、多活自动预算、全自动最优路径、大型拓扑画布、全部系统驱动同时接入、WG/m* 全量支持、AI/插件市场/移动端。故障日志、基础流量、目标主备和数据面限制属于核心运行需求，继续在 R1 内完成。

## 9. 证据索引与未决事项

TuneX 链接固定在审查提交，避免被后续 main 变化覆盖；ForwardX 文件位于用户只读参考树。

| 判断 | 源码依据 |
| --- | --- |
| A01 边界与上游未执行 | [A01_CONTRACT.md](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/docs/plans/forwardx-core-2026-10-07/A01_CONTRACT.md)、[forwardx-reference.json](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/integrations/forwardx/fixtures/forwardx-reference.json) |
| 版本字段/准入/逻辑身份 | [core-contract.ts:91](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/integrations/forwardx/core-contract.ts#L91)、同文件 `admitExecutionSelection:278`、`CanonicalLinkVersionInput:387`、`linkRuntimeId:458`、`protocolPortLeaseKey:479` |
| A00 总入口与待验收边界 | [A00_REAL_GATE.md](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/docs/plans/forwardx-core-2026-10-07/A00_REAL_GATE.md)、[a00-core-gate.sh:26](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/scripts/integration/a00-core-gate.sh#L26) |
| weighted/batch 现有验收 | [a00-weighted-round.py](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/scripts/integration/a00-weighted-round.py)、[a00-batch-delete.py](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/scripts/integration/a00-batch-delete.py) |
| 快速 CI 与网络 gate 区别 | [.github/workflows/ci.yml:183](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/.github/workflows/ci.yml#L183)、同文件 224：mock web build 和 gate 语法检查 |
| tombstone 在进程内 | [manager/tunnel.go:70](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/manager/tunnel.go#L70)、同文件 214、705；`manager/swap.go:270` |
| LKG 无凭据与空状态保存 | [restore/lkg.go:13](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/restore/lkg.go#L13)；本轮未证明现有部署重启会复活，只识别需补的组合验收 |
| 限速下发仍有 0 | [agent-command-bus.ts:1169](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/agent-command-bus.ts#L1169)，同文件 1200/1254/1288 |
| 模板与现有路径能力 | [route-profile.ts:4](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/route-profile.ts#L4)、[forward-path-setup.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-path-setup.ts) |
| FXP 出口按 hello 目标拨号 | `Forwardx/forwardx-fxp/main.go:1743`、`:1763`、`:1784`；配置与策略：`Forwardx/forwardx-fxp/config_types.go` |
| 合法被动 marker | `Forwardx/server/tunnelRuntimePlan.ts:8`；不能把上游被动入口强行要求为独立 ready listener |
| 上游版本/许可 | `Forwardx/package.json:3`、`:5`、`Forwardx/LICENSE`；参考树提交已核对 |

尚需实证的事项：FXP 原实现如何最小侵入地提供 binding 授权；共享配置 reload 的中断范围；UDP 实测容量与 MTU；runner 的可复现发行方式；离线密钥恢复与撤销时限。以上在 S1/S2 解决并更新估算，不能在方案中预设全部已经满足。

下一阶段开工从 PR1 开始；最小来源/准入完成后，实验 runner 与点对点模型可按依赖并行推进。每轮以新增的真实核心行为作为完成标准。

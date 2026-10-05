# V5-WP17 — 入口组 / 出口组 / DDNS 联动契约（DRAFT，待冻结）

> **状态：契约草案（2026-10-05，未冻结）。** 本文只回答语义，不含实现：不新增代码、不改
> schema、不改 `DEVELOPMENT.md`、不改任何既有契约文档。冻结由 Lead 拍板后回写状态行。
>
> 上游权威：`DEVELOPMENT.md` §8（WP10 六条件 + 回切）、§9.4（Route Profile / Console 边界）、
> §5.1（端口租约）。冻结基线：`docs/v5-wp13-5b-route-profile-contract.md`（FROZEN）、
> `docs/v5-wp14-16-federation-contract.md`（FROZEN）。与它们冲突时不改它们，只在 §4 登记。
>
> **行号说明**：一律引用**符号名 + 文件路径**（`backend/**` 正被并行编辑，行号会漂移）。
>
> **硬约束**：不引入第二套状态机 / 第二份 desired / 第二个端口所有权；一切能力挂回既有
> `Forward desired → config_revision → Agent ACK(applied_revision) → reconcile` 链；
> fail-closed 优先，未冻结形态一律**拒绝并点名原因**。

## 0. 六个必答问题的索引

| # | 问题 | 回答 | 状态 |
|---|---|---|---|
| 1 | Forwardx 五种组模式各解决什么、TuneX 对应什么 | §2.1 + §3 F1 | **冻结** |
| 2 | 入口/出口组怎么表达、是否与 Route Profile 重复 | §3 F1 / F2 | **冻结**（复用，不重复） |
| 3 | DDNS 在哪一环、谁触发、失败怎么办、怎么确认 | §3 F3–F5 + F7 | **冻结**（含三级确认） |
| 4 | 凭据归谁、共享节点差异、谁能改 DNS | §3 F6 | 主体冻结；平台凭据存管留 D3 |
| 5 | 备用入口端口：预分配还是迁移时申请 | §3 F8 | **冻结**（迁移时申请） |
| 6 | 与 federation 的边界 | §3 F9 + §8 | **冻结**（本 WP 不碰） |

## 1. 仓库现状事实（逐条给证据）

### 1.1 「组」今天在哪里

- **Forward 已有入口/出口组列 + 具体节点列**：`schema.prisma` `model Tunnel` 的
  `in_node_group_id`（必填）/ `out_node_group_id`，以及 `ingress_node_id` / `egress_node_id` /
  `middle_node_id`；该 model 注释即上游不变量：**「NodeGroup 只是候选集合，运行时恢复/删除/
  对账不得再根据组重新猜节点」**。
- **方向语义的最终真相是 `Node.role`**（`enum NodeRole = ingress|egress|both`），不是
  `NodeGroup.node_type`（`enum NodeType = in|out`）——schema 注释明写 v3 逻辑不得以前者为准。
- **共享/授权**：`model NodeGroupGrant`（`direction` + `active`，`@@unique([user_id,
  node_group_id, direction])`）+ `services/node-group-policy.ts` `isNodeGroupGranted` +
  `services/node-group-access.ts` `canUseNodeGroup`（缺 owner 绝不等于公开）。
- **`is_shared` 不是列**：`services/tenant-scope.ts` 的 `GroupScopeRow.is_shared` 只出现在
  类型投影与测试里；`CREATE TABLE node_group`（迁移 `20260923170000_init`）没有它，后续只
  加过 `workspace_id`。生产路径无人设置它 ⇒ 今天的「平台共享」由 grant 表达，
  `GLOBAL_SCOPE` 只描述 Redis 键域。（→ 风险 5）
- **Route Profile 已经是模板化的组**：`route-profile-compiler.ts` 的 `INGRESS_STRATEGIES`
  （`failover|fallback|round_robin|random|least_conn|ip_hash`）、`EGRESS_STRATEGIES`
  （`fallback|round_robin|random|least_conn|ip_hash`）、selector `{kind:"fixed_node"}` /
  `{kind:"node_group", node_group_id, strategy}`、`pickByStrategy`（确定性：failover/fallback
  取有序第一个；random **编译期抽一次**即冻结；ip_hash 用 FNV-1a）。契约 §4.1/§4.6 与 §9.4.4
  已冻结该边界，dynamic middle pool 关闭。
- **apply 落在既有变更路径**：`route-profile.ts` `applyRouteProfile` 最终调
  `forward-service.patchForward`，只写 `mode / ingress_node_id / egress_node_id /
  middle_node_id`。

### 1.2 故障转移链路（已有且已接线）

- **纯策略**：`services/failover-policy.ts` `FAILOVER_POLICY_CONDITIONS`（六条，顺序即 §8）、
  `PLACEMENT_PRECONDITIONS`、`decideFailover`、`placementMigration`、
  `PlacementMigration{expected_epoch, next_epoch}`。
- **阈值唯一来源**：`services/failover-thresholds.ts` `FAILOVER_THRESHOLDS`（stale 线复用
  WP6 `TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS`）+ `PLACEMENT_EPOCH_INCREMENT`。
- **执行顺序不可交换**：`failover-executor.ts` `executeFailoverForTunnel`：
  `readDecisionFacts → decideFailover → CAS(leaseBefore.epoch vs expected_epoch，不等即
  epoch_mismatch) → claimLease → applyPlacementMove`；生产实现只有一条
  `forward-service.patchForward({ ingress_node_id })`。
- **归属**：`services/placement-lease.ts` `claimLease` / `releaseLease` / `LEASE_TTL_SECONDS`；
  `model PlacementLease`（`tunnel_id` 唯一，`epoch` 单调 +1）。
- **rollout 已有迁移计划**：`forward-rollout.ts`（`strategy === "node_migration"` 由
  `impact.ingress_node_change / egress_node_change / middle_node_change` 派生）与
  `forward-rollout-exec.ts` 的步骤词表 `acquire_port` / `cutover_ingress` / `drain_ingress` /
  `release_old_lease`。
- **接线与默认关**：`worker.ts` 把 `runFailoverSweep`（`failover-loop.ts`）挂到
  `ReconcileDeps.failoverSweep`（`reconciler.ts` 注释：缺省 = 不评估）；策略键
  `FAILOVER_POLICY_CONFIG_KEY = "FAILOVER_POLICY"` + `readFailoverPolicy`（缺配置/坏 JSON 都
  false）。策略存 `model SystemConfig`，**`enum SystemConfigName` 列是 DB enum ⇒ 新增键 = ALTER**。
- **两个已存在的薄弱点（不是本文发明的）**：① `pickFailoverDestination` 的候选集来自
  `in_node_group_id` + `Node.role ∈ {ingress,both}` + `state_report.reported_at > now-5min`，
  **不复查** Route Profile 的 `nodeAdmission` / constraints / capabilities；②
  `preferred_node_id` 恒为 `null` ⇒ **自动回切今天不可能发生**（`failbackHealthyChecks` 缺省 0）。

### 1.3 端口所有权

- **唯一真相 = `model NodePortLease` 的 `@@unique([node_id, port])`**（`tunnel_id` 可空、
  `status` 字符串列、`expires_at` 可空）。`services/tenant-scope.ts` `portLeaseLockKey`
  （Redis NX）只是抢占协调。
- `services/portPool.ts`：`acquirePort` / `availablePorts`（黑名单 + active 租约 +
  `reservedPorts` 三重过滤）/ `reconcileLeases` / `ORPHAN_RULES` / `PREALLOC_TTL_S`
  （15 分钟，专为「预分配孤儿可回收」而存在）/ `DEFAULT_LOCK_TTL_S`。
- 条件 4 的读数来源：`failover-executor.readDestination` 调 `portPool.availablePorts` 做
  **只读**预检查（读不到按 0，fail-closed）。

### 1.4 DNS 现状：schema 有，运行时**没有**

- `model DNSProvider{name, type: DNSProviderType, config Json, user_id}`，`enum
  DNSProviderType = cloudflare|huawei`；`model InNodeGroupDNS{in_node_group_id,
  dns_provider_id, ttl, ipv6, status}` —— **没有 domain 列**（`CREATE TABLE
  in_node_group_dns` 逐字核对）。
- `model Node.dns_status` 只是管理面透传字段（`node-admin.ts` 投影、`admin-extended.ts` 写入、`web/src` 一个开关）。
- **全仓 `ddns` 关键字命中 0**（`backend/src`、`web/src`、`agent`）；`InNodeGroupDNS` /
  `DNSProvider` 的唯一生产引用是 `routes/admin-extended.ts` 的两处 `deleteMany`。
  ⇒ DNS 是**遗留 schema**：没有服务层、没有触发器，**连「更新哪个域名」都表达不出来**。

### 1.5 多租户、RBAC、可复用件

- `services/tenant-scope.ts`：`GLOBAL_SCOPE = 0`、`groupScope`、`nodeScope`、
  `classifyGroupForWorkspace ∈ {own, shared, cross_tenant}`、`tunnelBelongsToWorkspace`；
  `nodeScope` 的存在理由：`Node` / `EgressPool` / `EgressTarget` / `NodePortLease` **都没有
  `workspace_id`**，归属沿 `Node → node_group → workspace_id` 单向上查。
- RBAC：`services/workspace.ts` `WorkspaceResourceFamily = "forward"|"tunnel"|"node"|
  "member"|"settings"|"audit"`（`resolveWorkspaceAccess`）。
- **唯一可解封的凭据落地先例**：`services/federation/seal.ts` `deriveSealKey` / `sealSecret` /
  `unsealSecret`（HKDF-SHA256(AUTH_SECRET) + AES-256-GCM，失败一律抛错）；`crypto/keys.ts`
  明确旧 Fernet key 已删除。

### 1.6 Gate 与拓扑（已具备什么）

- `scripts/v3-e2e/docker-compose.e2e.yaml` 已有**两个入口 Agent**：
  `wp14-ingress-agent`（`WP14-IN-A-NODE`，`172.31.10.20`，`--ingress-range 21000-21099`）与
  `wp14-ingress-agent-b`（`WP14-IN-C-NODE`，`172.31.10.21`，**同端口区间**），外加
  `wp14-client`（`wp14-ingress-data` 内，`internal` 网）⇒「同端口在不同节点各自合法」
  由拓扑天然满足。
- 现有 Gate：`V5-G3`（归属/epoch/split brain）、`G4`（多跳）、`G5`（联邦），见
  `scripts/v3-e2e/README.md`；**没有任何 DNS 断言**。

## 2. Forwardx 先例与取舍（只取语义，不取代码）

只读参考 `/workspace/TuneX/Forwardx(参考项目，不进入git提交）/`（AGPL-3.0，**不复制代码**）。

### 2.1 五种组模式

| 模式 | Forwardx 语义（符号） | 解决什么 | TuneX 对应 |
|---|---|---|---|
| `port` | `normalizeForwardGroupMembers`：成员恰好 1 台 | 单机转发（**无组语义**） | 既有 `tunnel_mode=direct` + 一个 `ingress_node_id` |
| `chain` | 成员 2..`MAX_FORWARD_GROUP_MEMBERS`，顺序即链路，可带 `entryGroupId` | 有序多跳 | 既有 `middle_node_id` + `RouteProfile.transit[]`（V5.4 三跳） |
| `failover` | 按 `priority` 排序，单活跃，`failoverSeconds/recoverSeconds/autoFailback/domain` | 单活跃入口 + 域名跟着切 | **归属迁移**（`PlacementLease` + `decideFailover`，已实现）+ 本 WP 的 DDNS |
| `entry` | 一批入口主机，`domain` 必填，`ddnsAutoResolveEnabled` | **多入口同时可用**，记录集 = 健康入口集合 | `ingress{kind:node_group}` + 本 WP 的**多值记录集** |
| `exit` | 一批出口主机，`exitStrategy` 控制选择 | 一个 Forward 可切换多个出口 | `egress{kind:node_group, strategy}`（编译期解析） |

### 2.2 出口策略

`shared/exitStrategy.ts`：`none|fallback|round_robin|random|ip_hash`，且
**`normalizeExitGroupStrategy` 对未知值回落到 `round_robin`**（容忍型默认值 —— 我们要反着做）。
`server/tunnelExitStrategy.ts` `gostExitSelector` 把策略翻译成**数据面引擎参数**（`maxFails` /
`failTimeout`），即引擎在运行期逐个尝试出口。TuneX **不能**接受：§9.4.3 冻结「运行时必须使用
确定的具体节点事实」，§9 冻结第 7 条只允许 hop 0 有 owner。

### 2.3 DDNS 链路（`server/ddns.ts` / `hostDdns.ts` / `forwardGroupRepository.ts`）

- 凭据是**面板全局单份**：`getDdnsSettings()` 读 `db.getAllSettings()`，全表一组 provider/密钥
  （cloudflare / webhook / huaweicloud / aliyun / tencentcloud），**无租户维度** ⇒ 多租户照搬 =
  A 的凭据替 B 的域名写记录。
- 写入是**值集合**：`updateDdnsRecordValues({domain, recordType, values[]})`，用
  `withKeyedTaskLock(ddnsRecordLockKey(...))` 串行化，内部 `planDdnsValueChanges` 产出
  `updates/creates/removals`；多值 CNAME 被显式拒绝。
- 触发点在**故障转移内部**：`syncEntryGroupDdns`（entry，多值）与 `syncSingleForwardGroupDdns`
  （failover，单值），中途用 `agentSelectionStillCurrent()` + `beforeCommit()` 复核；失败写
  `lastStatus=error` + `lastDdnsError`，由 `HostDdnsUpdateCoordinator` 退避重试，节拍来自既有
  `forwardGroupHealthRechecks`。
- **没有传播确认**：写成功即成功，`lastDdnsValue` 记的是「我想写的值」，不是「Resolver 现在答
  什么」——**这就是假成功**：面板显示已切换，客户端在 TTL 内仍连旧 IP。

### 2.4 三件明确不照搬（对应硬约束）

1. **不把 shell-out 多引擎当主数据面**：TuneX 的出口是编译期解析的具体节点，数据面只有 Go Agent 既有 manager。
2. **不容忍型默认值**：`normalizeExitGroupStrategy` 的「未知 → round_robin」一律改为**未知值 fail-closed + 默认关**。
3. **不面板下发整份配置**：只走 desired→revision→ACK→applied→reconcile；DDNS 是面板对第三方 DNS 的外呼副作用。

## 3. 冻结决策

### F1 — 组不是新资源：入口/出口组 = Route Profile 的 `node_group` selector

- **结论**：不新建 `forward_group` / `entry_group` / `exit_group` 表。入口组 =
  `ingress_selector = {kind:"node_group", node_group_id, strategy}`；出口组 = `egress_selector`
  同形态（transit 的组形态继续关闭）。旧列 `in_node_group_id / out_node_group_id` 只作
  **兼容候选来源**，不得成为第二份路由真相。
- **依据**：§9.4.4 已把两者列入支持边界；`INGRESS_STRATEGIES`/`EGRESS_STRATEGIES`/
  `pickByStrategy` 是既有的确定性实现；Route Profile 契约 §1.2「不新建第二套路由模型」。
- **影响面**：Web 不需要新概念，只在 Route Profile 编辑页暴露 node_group selector；`apply`
  路径零改动。
- **明确不做**：不新增组表 / 不引入 `group_mode` 字段 / 不复用遗留 `model TunnelChain`。

### F2 — 组的「多」是编译期的：运行期没有出口池、没有随机挑选

- **结论**：`node_group` selector 在 `apply` 那一刻解析成**一个具体节点**并冻结进
  `ForwardRevision`。运行期换出口 = 一次新 revision（走 `patchForward`）；**不存在**「Agent
  从出口池里挑一个」。入口侧唯一的运行期变化是**归属迁移**（hop 0），它同样是新 revision。
- **依据**：§9.4.3 与 §9 冻结第 7 条；`Tunnel` 注释「不得再根据组重新猜节点」；出口是资源
  不是 owner。
- **影响面**：出口故障今天**没有**自动收敛路径（D1）；产品文案必须写清，不能暗示「出口组会
  自动切」。
- **明确不做**：不做运行期多出口轮询 / live ip_hash 分流（第二套 desired）。

### F3 — DDNS 绑定挂在 **Forward**，不挂在 Route Profile

- **结论**：`tunnel` 新增可空列组（`dns_domain` / `dns_record_type` / `dns_provider_id` /
  `dns_auto_resolve` / `dns_mode`），语义 = 「这条 Forward 的前门域名」。Route Profile
  **不拥有** DNS。
- **依据**：① 模板与域名是 N:1（一个 Profile 可被多条 Forward apply，域名属模板就互相打架；
  而 Forwardx 的 domain 恰好属于**组**）；② Route Profile 契约已 FROZEN，扩字段表 = 改冻结
  文档；③ 绑定必须随 `config_revision` 被 ACK，落 `tunnel` 行才是同一份 desired。
- **影响面**：`ForwardPatchInput` 新增字段（复用既有校验与 revision 逻辑）；Web 在 Forward
  编辑页加「前门域名」区块；Route Profile 页零改动。
- **明确不做**：不改 `route_profile*` / 编译器；不把域名塞进 `ingress_policy`（该 JSON 的键集
  未冻结，塞进去等于悄悄扩一条冻结契约的语义）。
- **值来源（同为冻结部分）**：写进 DNS 的地址**只能**来自 `node.connect_ip`（面板观察到的
  连接 IP，跳间拨号同源，见 `agent-command-bus.ts`）。`connect_ip IS NULL` ⇒ **拒绝写**
  （`dns_unbound_address`），**绝不**回落 `listen_ip` 或节点组 legacy `connect_ip`。

### F4 — 记录是**一组值**，不是单个值；多入口形态优先

- **结论**：值集 = `values: string[]`（多值 A/AAAA），两种形态：**多入口（首选）**记录集 =
  当前可用入口集合（通常 ≥2），单个入口挂掉**不需要写 DNS**，客户端靠记录集里的其它地址
  自愈；**单活跃**记录集 = 当前 owner 的 `connect_ip`，每次归属迁移都要写。
- **依据**：Forwardx 的 entry / failover 正是这两种语义；多值形态把「DNS 写延迟」从可用性
  关键路径上摘掉，直接缓解 §8「短暂中断」的取舍。
- **明确不做**：多值 CNAME 拒绝；不做 SRV / 权重；不做 TTL=0。

### F5 — 触发点：迁移的**后继**，面板在 reconcile 节拍执行；就绪性作为执行层前置闸门

- **结论**（四段缺一不可）：
  1. **谁触发**：面板控制面的 DNS 同步器，挂在**既有** reconcile 节拍（`worker.ts` 已把
     `runFailoverSweep` 挂到 `ReconcileDeps.failoverSweep`）。**不新开定时器**、不下发给
     Agent，Agent 不知道 DNS 存在。
  2. **在哪一环**：必须在 rollout 到达「新入口已 applied」（`applied_revision ==
     config_revision` 且 `cutover_ingress` 完成）**之后**，与旧入口 drain 相邻。先写再搬 =
     把客户端指向还没监听的机器；搬完不写 = 客户端一直连已停机的旧地址。
  3. **要不要写**：`dns_auto_resolve === true` 且值集 ≠ 上次已确认值集。**缺省 false**（显式
     opt-in，与 §8「自动动作必须显式 policy」同一纪律）。关闭时只返回**建议值集**，零外呼。
  4. **就绪性前置闸门**：对开启自动解析的 Forward，`failover-loop` 在调用执行器**之前**检查
     DNS 路径（provider 配置完整且 enabled，且最近一次成功写在 `DDNS_PROOF_MAX_AGE_MS` 内，
     或只读探测成功）。不可用 ⇒ **不调用执行器**，记 `dns_path_unready`，**epoch 不动**。
- **依据**：§8 六条件是冻结契约，DNS 就绪性不是「谁承载」的事实，塞进 `decideFailover` 会改
  冻结语义与全部用例；放执行层是「挂回既有链路」最干净的位置。fail-closed 取向的理由：DNS
  写不通时迁移会让前门静默失联。
- **影响面**：`runFailoverSweep` 多一次前置查询 + 一个 finding 码；`decideFailover` 及其用例
  **零改动**；`FAILOVER_POLICY` 格式不变。**明确不做**：不改 `FAILOVER_POLICY_CONDITIONS` /
  `PLACEMENT_PRECONDITIONS`；不把 DNS 事实喂回策略（DNS 故障**永不**触发第二次迁移，见 F7）。

### F6 — 多租户：凭据归 workspace；平台共享入口组的 DNS 只由平台管理员写

- **结论**：① `model DNSProvider` 现有 `user_id` 是**错的粒度**（凭据属于资源域，不属于
  个人）⇒ 新增可空 `workspace_id`；`NULL` 为遗留全局行，**非平台管理员读取即 fail-closed**。
  ② `config`（token/secret）必须以 `services/federation/seal.ts` 的 `sealSecret` 落地，
  **禁止明文 JSON**（列照用，只约定内容形态）。③ **谁能改 DNS**：
  `resolveWorkspaceAccess(..., "manage", "settings")`，跨 workspace 一律 404/403。④ **平台
  共享入口组**（`GLOBAL_SCOPE` / 已授权给多租户的组）**不得**由租户凭据写记录；只能由平台
  管理员用平台级凭据配置，违反 ⇒ 拒绝并点名 `shared_group_dns_denied`。
- **依据**：`tenant-scope.ts` 的 `cross_tenant` 语义与「平台 bucket 按定义不含租户资产」；
  RBAC 已有的 `settings` family。
- **影响面**：provider 的 CRUD 权限与作用域判定；历史 `user_id` 行需要一次显式迁移策略。
- **明确不做**：不把凭据放进 `SystemConfig`（列是 DB enum，新增键 = ALTER，且会变成第二套
  全局凭据 = 重演 Forwardx）；不改 `DNSProviderType`（Gate 用 endpoint 覆盖 + 本地 stub）。

### F7 — 失败与回切：DNS 不改变归属；禁止假成功

- **结论**：一次 DNS 写失败**不**回滚 epoch（§8 一：永不回退）、**不**回滚 revision、**不**
  触发新迁移；只记 `dns_state=error` + 原因 + 审计，下一节拍按退避重试。`failback` 与
  `failover` 共用**同一条** DNS 后继（回切是正常迁移）。**禁止假成功**：产品可见状态必须
  区分 `dns_state ∈ {unbound, synced, pending, error}`，只有 `synced` 允许显示「已切换」，
  `pending/error` 必须显示未确认 + 期望值集 + 最后错误。
- **依据**：§8「epoch 永不回退」；`failover-executor` 的残留风险注释（认领后迁移失败也不
  回退）；§8.3 的 F1/F2/F3 教训。
- **明确不做**：不用 DNS 结果反推健康；不做通知渠道（Forwardx 的 Telegram 通知不在本 WP）；
  不自动降级为单值。

### F8 — 备用入口的端口：迁移时申请，不预分配

- **结论**：端口在 rollout 的 `acquire_port` 于**目的节点**申请（`preferred = 当前
  listen_port`）；条件 4 只用 `portPool.availablePorts` 做只读预检查。**不为备用入口预分配
  租约。**
- **依据**：① `NodePortLease @@unique([node_id, port])` 是唯一真相；`tunnel_id IS NULL` 的
  现有语义是**待回收的孤儿**（`PREALLOC_TTL_S` + `ORPHAN_RULES` 15 分钟内回收），拿它当
  「备用预留」会与回收规则直接冲突；② `Tunnel` 注释：运行时不得根据组猜节点，预分配等于
  提前替世界挑好一台入口。
- **影响面**：迁移成败依赖目的节点当时有可用端口（条件 4 已覆盖）；要「备用永远有位」的
  正确做法是**给备用节点更大的端口区间**，不是预留端口。
- **明确不做**：不新增「预留租约」状态；不改 `reconcileLeases` 的孤儿规则。

### F9 — 与 federation 的边界：本 WP 不碰跨面板入口/出口

- **结论**：`tunnel.federated_egress_peer`（远端出口腿）存在时，DDNS 的值来源仍是**本机
  hop 0** 的 `connect_ip`；「远端 ingress」形态尚不存在，任何 `federated_ingress_*` 语义
  一律 fail-closed 拒绝绑定。
- **依据**：`DEVELOPMENT.md` §10.2「跨面板 3+ 跳 / 远端 ingress / 跨面板自动 failover 一律
  fail-closed 保持关闭」；联邦契约 §3.4 只声明出口腿。
- **明确不做**：不做跨面板 failover、不做跨面板 DDNS 记账、不做远端 hop 的域名解析。

## 4. 开放决策（不猜；候选 + 代价 + 影响面）

> ### 4.0 Lead 裁决（2026-10-05）：D1–D4 **已冻结**
>
> **D2 DNS「生效」的确认强度 —— 禁止假成功。** `dns_state=synced` 必须**至少**满足 L1
> （provider 侧读回）。provider 无 read-back 能力时，状态必须是**显式的
> `synced_unverified`**（新增取值），且 UI **禁止**显示"已切换"。L1 成功但 L2 超时 ⇒ 保持
> `pending`，超时后置 `error`：不假成功，也不回滚 epoch/revision（与 F7 一致）。
> 理由：多租户下"面板说切了、客户端还连旧 IP"是最坏的一类故障，宁可显示未确认。
>
> **D1 出口组故障是否自动重解析 —— v1 不自动。** 出口故障只允许**人工 re-apply**。
> 理由：自动化需要一个"非归属迁移"的新决策入口，会触碰 §9 冻结第 7 条的表述；本期收益
> （少点一次按钮）远小于引入第二个决策入口的代价。
>
> **D3 平台级 DDNS 凭据存管 —— `DNSProvider.workspace_id` 可空，NULL = 平台级。**
> 非 NULL = 租户级；两者都必须 sealed 落地（复用 `federation/seal.ts` 原语）；平台级只能
> 由平台管理员写。**不塞 SystemConfig**——那里是明文，且已有先例证明会留下"沉睡、又被
> 免认证下发"的键（见 WP18 对 `NOTICE*` 的核实）。
>
> **D4 `preferred_node_id` 恒为 null ⇒ 自动回切永远不会发生 —— 判为既有缺陷，收口。**
> 属"写了功能但没有任何写入路径"的一类（与 WP19 的 `diag` 白名单陷阱同源）。WP17 的 DoD
> 必须包含：把"首选入口"接到真实写入路径，并加一条断言——**设置首选入口后，健康恢复能
> 真的回切**（epoch + 1 的正常归属迁移，不是特例路径）。
>
> **重申一条硬约束（已核实）**：`is_shared` **不是 DB 列**（`node_group` 建表迁移里没有），
> 生产路径无人设置 ⇒ **任何授权判定都不得依赖它**。

### D1 — 出口组故障是否自动重解析

- **A 不自动（本 WP 倾向）**：人工 re-apply。代价：出口离线后需人工介入；影响：零新状态机。
- **B 自动重解析**：复用六条件里可适用的部分（观测新鲜 + 冷却 + 显式 policy），出口不是
  owner 故**不涉及 epoch**，必须走 `patchForward` 生成新 revision。代价：需要一个新的「非归属
  迁移」决策入口，与「只有一个 owner」的表述易混淆；影响：`failover-loop` 变成两类 sweep。
- **C 有条件自动**：仅当 egress selector 是 `node_group` 且策略显式开启。代价：多一个策略键
  （`SystemConfig` 列是 DB enum ⇒ ALTER）。
- **请 Lead 拍板**（B/C 都会触碰 §9 冻结条款的表述）。

### D2 — DNS 传播确认的强度与失败后的降级

- **已冻结**：三级确认 —— **L1 权威写 + read-back（强制，未确认即 `pending`）**、
  **L2 解析器回查（可配 resolver，超时 = 未确认）**、**L3 客户端实测（只用于 Gate 断言，
  不进产品路径）**。
- **未冻结 1**：L1 成功但 L2 在 `DDNS_SYNC_DEADLINE_MS` 内不通过怎么办。候选 A：
  `dns_state=error` 保持重试 + 文案显示未确认（今天的默认）；B：把 Forward 标为 `degraded`
  （需定义它与 `apply_status` 的关系，会触碰既有状态词表）；C：仅告警。
- **未冻结 2**：provider 无 read-back 能力（如纯 webhook）时 L1 的含义。候选：要求 provider
  必须支持查询；或接受「写成功即 synced 但标注 `unverified`」。
- **影响面**：直接决定「假成功」是否被彻底消灭。**请 Lead 拍板**。

### D3 — 平台级 DDNS 凭据的存管形态

- **A** 新增「平台 workspace」（`enum WorkspaceKind` 只有 `personal|team`，新增值 = 改 enum）。
- **B**（本 WP 倾向）`DNSProvider.workspace_id = NULL` 表示平台级，仅超级管理员可读写，配一次
  显式迁移标注历史行。
- **C** 沿用 `SystemConfig`（列是 DB enum ⇒ ALTER，且凭据从资源域挪回全局单份 = 重演 Forwardx）。
- **请 Lead 拍板**。

### D4 — 首选入口（`preferred_node_id`）的存储与自动回切

- 事实：`failover-policy` 已支持 `failback` 路径，但 `pickFailoverDestination` 恒返回
  `preferred_node_id = null` ⇒ **自动回切今天永不发生**。候选：**A** 绑在 Forward
  （`tunnel.preferred_ingress_node_id`，可空列）；**B** 绑在 Route Profile 的 ingress selector
  （= 改 FROZEN 契约字段表）；**C** 不提供自动回切。**代价/影响**：决定回切是产品能力还是运维
  动作，也决定 `FAILBACK_HEALTHY_CHECKS` 由谁累计（今天缺省 0）。**请 Lead 拍板**。

### D4 收口记录（实现时发现的四件事，2026-10-05）

1. **存储选 A 的理由补全**：候选 B（Route Profile 的 ingress selector）要改 FROZEN 的字段表，
   候选 C（不提供自动回切）与本条裁决"把首选入口接到真实写入路径"直接矛盾 ⇒ `tunnel.preferred_ingress_node_id`。
2. **回切需要第二列才算真的通**：策略要求"**连续** N 次健康"，而"连续"是跨节拍的事实 ——
   从单次观测推导不出来。原来 `failbackHealthyChecks` 恒为 0，所以偏好存下来也照样不会回切。
   `failback_healthy_checks` 由扫描维护（健康 `+1`、否则 `=0`，用原子 `increment`）。
   **判定读上一拍的值、这一拍写下一拍的值**：同一拍里既判又算会让阈值退化成 1。
3. **"在线"要把凭据被吊销分出来**：`deriveConnection` 把"吊销"和"很久没上报"一起归成 `offline`，
   于是运维只能看到"节点不在线"——而这两件事的下一步动作完全不同（重新登记 vs 等它回来）。
   共享判定里吊销**先于**在线报出（`node_credential_revoked`）。
4. **编译器的注释与现实不符（行为是对的，注释误导）**：`constraints.allowed_lifecycles` 注释写
   "显式白名单才放宽"，但 `nodeAdmission` 已经要求 `lifecycle === "active"`
   （`lifecycleAcceptsBusiness`），所以那条白名单**只能收窄、放不宽**。共享判定按实际语义工作，
   并把这个事实写在了代码注释里。

### D5 观察：`Node.status` 的连接态取值是 `active`

`deriveConnection` 要求 `status === "active"`，不是 `"online"`。写本 WP 的断言时夹具用了
`"online"`，于是"一台一切正常的节点"被判成离线 —— 断言先坏在夹具上，而生产数据本来就是对的。
记在这里是因为它很容易被下一次踩到（同一族的还有仓库已付过两次学费的"夹具绝对时间"）。

### WP17.3 交付记录：实现时定下的六条（2026-10-05）

1. **退避需要两个事实**（`dns_attempt_count` / `dns_next_attempt_at`，additive 迁移）：契约 F7 说
   "下一节拍按退避重试"，而"退避"是**跨节拍**的状态 —— 缺了它，执行器每拍都会立刻重试同一次
   失败，对端限流时那正是最坏的输入。阶梯 `5s → 15s → 60s → 300s → 900s` 封顶，且与
   `DDNS_SYNC_DEADLINE_MS`（一次同步的期限）**不是一回事**。
2. **`unavailable` 绝不写空值集**：期望值集为空（owner 没有 `connect_ip`、组内没有可用入口）
   时的正确动作是"什么都不做"，而不是"把记录集写成空" —— 后者会把整个域名抹掉，而面板会
   显示"同步成功"。这条现在有断言。
3. **零外呼有四层判据**，层层都在"真正要说的话"之前：未绑定 → 未开启自动解析 → 退避窗口内
   → 值集没变。最后一条顺带意味着**连凭据都不读**（一个坏配置不该在没有工作要做时变成告警）。
4. **不可重试的错误不排退避**：4xx（凭据错、域名不存在）重试一万次也不会变对，而挂着
   `next_attempt_at` 会让运维以为"系统在重试"。区分落在 `DdnsProviderError.retryable` 上。
5. **provider 适配器是一个窄契约**（`GET /records` / `POST /records`，endpoint 可覆盖）：
   它不去模仿各家厂商的真实 API（那是按需增加适配器的事），而是先把"面板 ↔ 执行器"的边界
   固定下来，让值集规划、读回、退避这些**与厂商无关**的部分能被真实地测。契约 F6 要求的
   "不新增 provider 类型"因此成立。
6. **审计借用既有 sink**，用一条**合成的真实路径**（`/api/forwards/<id>/dns`）让 `analyzePath`
   把事件归属到同一条 Forward —— 于是 DNS 事件与"谁改了这条转发"落在同一批审计里，
   而不是另起一页（WP17.2 已拒绝过"第二套审计机制"）。

**边界**：本 WP 不接 failover、不碰 rollout —— 触发点、就绪性闸门与 DNS 后继属于 WP17.4。

## 5. WP 拆分（一个 WP 一个可交付物；次序 17.1/17.2 并行 → 17.3 → 17.4 → 17.5）

| WP | 可交付物（单件） | 明确不含 |
|---|---|---|
| WP17.0 | 本文档冻结（状态行改 FROZEN + 冻结清单） | 任何代码 |
| WP17.1 | 候选集同源化：`failover-loop` 的候选来源与 Route Profile 编译来源一致（同一份 `nodeAdmission` + constraints，`deriveConnection` 判在线），离线用例钉死「不放行 ⇒ 不迁 + 原因码」 —— **已交付 2026-10-05**：`services/ingress-candidate.ts`（唯一实现，编译器与循环共用）+ D4 收口（`preferred_ingress_node_id` / `failback_healthy_checks` 两列 + `PUT /:id/preferred-ingress` 写入路径 + 扫描维护连续健康计数）；20 条断言 | 不改 `decideFailover` 词表 |
| WP17.2 | DNS 绑定落库 + RBAC + sealed 凭据（additive 迁移 + 服务 + 路由），**零外呼**；含 `dns_state` 投影 —— **已交付 2026-10-05**：`services/ddns-binding.ts` + `routes/ddns.ts` + `forwards.ts` 的 `/:id/dns`；38 条断言（服务层 33 + 路由层 5，后者钉住 `settings:manage` 这条接线） | 不写 DNS、不建 provider 适配 |
| WP17.3 | DDNS 执行器：provider 适配（endpoint 可覆盖）+ 值集规划（`updates/creates/removals`）+ L1 read-back + 退避 + 审计 —— **已交付 2026-10-05**：`services/ddns-executor.ts`（唯一的外呼入口）+ 退避两列（additive 迁移）；25 条断言 | 不接 failover、不碰 rollout |
| WP17.4 | 迁移/回切的 DNS 后继 + 就绪性前置闸门（`dns_path_unready`），挂既有 reconcile 节拍 | 不新增定时器、不改 rollout 步骤词表 |
| WP17.5 | Gate V5-G6 + `docs/evidence/` 证据 | 不改 G3/G4/G5 断言 |

## 6. DoD（可断言的检查）
**时间与数值**（实现选值，可调，理由随附）：`DDNS_SYNC_DEADLINE_MS = 120_000`（迁移秒级、
单次 provider 调用 ≤10s，留两次重试）；`DDNS_TTL_SECONDS ∈ [60, 3600]`（下限抗抖动，上限把
「客户端最坏切换窗口」压在 1 小时内）；`DDNS_PROOF_MAX_AGE_MS = 600_000`（就绪性判据）。

1. **多入口主路径**：记录集含两个入口地址；停掉其中一个 ⇒ **零 DNS 写**（值集未变），客户端
   用记录集里的另一个地址**真的连通**（数据面断言）。
2. **单活跃主路径**：入口 A 挂掉 ⇒ 归属迁到 B ⇒ **≤ `DDNS_SYNC_DEADLINE_MS` 内** provider
   read-back 得到 `{B.connect_ip}`，`dns_state = synced`，客户端按该地址连得上。
3. **反例·未确认不算成功**：provider 不可达 ⇒ `dns_state = error`，API **不得**返回「已切换」，
   且 `placement_lease.epoch` **不前进**。
4. **反例·显式 opt-in**：`dns_auto_resolve = false` ⇒ 零外呼，只返回建议值集。
5. **反例·跨租户**：租户凭据 + 平台共享入口组 ⇒ 拒绝（`shared_group_dns_denied`），零 provider 调用。
6. **反例·地址缺失**：入口 `connect_ip IS NULL` ⇒ 拒绝写（`dns_unbound_address`），不猜地址。
7. **反例·未知值**：`dns_record_type` 非法 / `dns_mode` 未知 ⇒ 拒绝，不回落默认值。
8. **反例·CNAME**：值集 > 1 且 `record_type = CNAME` ⇒ 拒绝。
9. **回切**：首选入口恢复 ⇒ 回切产生一次 DNS 后继（值集回到首选），`dns_state = synced`。
10. **不回归**：`bun test src`（`failover-policy` / `failover-executor` / `failover-loop` / `portPool` / `route-profile`）全绿，且 G3 断言逐条不变。

## 7. Gate 映射（真实 Docker 多 Agent 拓扑）

**新增 Gate `V5-G6`（`scripts/v3-e2e/v5-g6.py`），不改 G3/G4/G5。** 拓扑复用 §1.6 已有的两个
入口 Agent 与 `wp14-client`（无需新 Agent），**需新增**一个 Gate 自带的 **DDNS stub**（ctrl 网
内，实现 Cloudflare 形状的 `GET/PUT/POST/DELETE /dns_records` 并暴露「权威查询」入口），
provider 配置用 **endpoint 覆盖**指向它 —— **不新增 `DNSProviderType` 枚举值**，不访问公共 DNS。

必须新增的断言：① 迁移后 **stub 内记录集 == {B.connect_ip}**（L1 的真拓扑版本）；②
`wp14-client` 按 stub 的权威答案建立**真实连接**并完成一次转发（L3）；③ 停 stub / 返回 5xx ⇒
`dns_state=error`、`epoch` 不前进、日志出现结构化原因（不许只有 500）；④ 多入口形态停一个入口
时 stub 的**写调用计数为 0**；⑤ 跨租户与共享组负例在 panel 侧 403 且 stub 调用计数为 0。

**为什么必须有 Gate**：§8.3 的 F1/F2/F3 已证明「实现了但没接线」在本仓库反复发生，而 DDNS 的
风险形态恰恰是「记录写成功但没人真的去写」与「写了但客户端连不上」——只在真拓扑上可观察。

## 8. 明确不做（边界）

~~~text
第二套路由模型 / 第二套状态机 / 第二份 desired / 第二个端口所有权
运行期出口池（Agent 从池里挑出口 / 多出口轮询 / live ip_hash 分流）
跨面板 ingress / 跨面板 failover / 跨面板 DDNS（联邦是另一件事）
远端 hop 的域名解析；远端地址写入第三方 DNS
用 DNS 观测结果反推节点或目标健康（DNS 是副作用，不是观测源）
通知渠道（Telegram / webhook 告警）—— Forwardx 有，本 WP 不含
套餐/计费侧的 DNS 能力 entitlement
改任何 FROZEN 文档；新增 DB enum 值（DNSProviderType / WorkspaceKind / SystemConfigName 一律不动）
~~~

## 9. 风险

1. **TTL 决定切换窗口，客户端缓存不可控**：缓解 = 多入口形态优先（值集不变则不写）+ 暴露
   `dns_ttl_seconds` 与「客户端最坏切换时间」文案。
2. **第三方 provider 形状与时延**：read-back 多一次外呼，限流会拉长 `pending`。缓解 = 单记录
   键锁（沿用 Forwardx 的 keyed-lock 语义）+ 退避 + 按 Forward 串行。
3. **平台共享入口组的 DNS 责任**是跨租户副作用最可能出事故处。已冻结为平台管理员专属；**D3
   未定前不要落地共享组绑定**（宁可不做，不可放过）。
4. **凭据必须 sealed**：`config Json` 列照用，一旦有人存明文，就是 Forwardx 的全局凭据问题在
   **多租户**下的重演。WP17.2 必须钉住「解封失败 = 数据不可用，不是没有数据」。
5. **`is_shared` 未持久化**（§1.1）：授权判定**不得**依赖它（今天恒为 undefined），只能用
   `node_group_grant` + workspace 归属，否则会出现静默放行或静默拒绝。
6. **`preferred_node_id` 缺存储**（D4）：定案前自动回切**不可能发生**，文案不得暗示它存在。
7. **候选集同源化（WP17.1）会改变今天的行为**：从只看 `role + state_report(5 分钟)` 改成
   `nodeAdmission` + constraints 后，某些今天能迁的场景会变成 `hold`（更严格）。这是**有意**的
   fail-closed，但必须在 Gate 里钉住「为什么没迁」的原因码，避免变成新的静默。

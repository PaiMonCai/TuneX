# V5-WP20 订阅计费运行时契约（周期结算 / 流量周期 / 配额预留）

> **状态：PROPOSED → 部分落地（2026-10-05）**：Lead 已冻结归属 / `traffic_used` / 倍率 / O5 / O6
> （§4.0），**WP20-1（计费时钟纯函数）已交付**（§5.1）。除 §5.1 记录的那一个 WP 外，本契约
> 其余部分仍**不含实现**。
> 依据：`DEVELOPMENT.md` §1（V4 frozen baseline）、§3（工作纪律）、§4（V5 总路线）、
> §6.2（UDP 边界「packets 计费」）、§9.4.6（套餐授权指向 capability entitlement）。
> 先例（**只读语义，不复制代码**；AGPL-3.0）：`Forwardx(参考项目，不进入git提交）/` 的
> `shared/billingTime.ts`、`shared/trafficMultiplier.ts`、`server/repositories/billingRepository.ts`、
> `server/trafficBillingAuthorization.ts`、`server/ruleQuotaReservations.ts`、`server/portReservations.ts`
> 及 `server/billingTime.test.ts` 等四份计费测试。
> 与 `DEVELOPMENT.md` 冲突时以其硬不变量为准；本文件只**细化**，不放松任何一条。
> 编号说明：`DEVELOPMENT.md` §4 路线表**没有** WP17–WP21 的登记（`grep -n "WP1[7-9]\|WP2[0-9]"`
> 无命中）；同批并行提案已有 `v5-wp17-entry-exit-group-ddns-contract.md`、
> `v5-wp19-latency-observability-contract.md`、`v5-wp21-installer-and-docs-site-contract.md`。
> 故 **WP20 属于同一批待登记提案，落地前须由 Lead 在 §4 一次登记**。
> 行号取自 2026-10-05 本工作树；合并前请以**符号名**复核。

---

## 0. 一句话定义

订阅计费运行时 = **把「谁在什么时间拥有哪一份能力策略」做成一条可重放的时间函数**，并把「每个计费
周期只结算一次」做成一条**先占位后执行**的账本事实。它**不**新增权限判定、**不**新增状态机、
**不**新增 desired：策略判定仍只有 `capability-policy.ts` 一份真相，到期仍只是策略发放上的时间比较。

~~~text
新增（纯函数） billing-time.ts @ Asia/Shanghai → 新增（账本，先占位后执行）
   SubscriptionPeriodSettlement UNIQUE(plan_subscription_id, period_key)
   ↓ 既有（判定，不动）composeEffectivePolicy ← WorkspacePolicyAssignment
~~~

---

## 1. 仓库现状事实

### 1.1 权限 / 额度 / 计费与订单现状（已只有一份真相，且与计费解耦）

| # | 事实 | 证据（文件:符号） |
|---|---|---|
| F1 | 功能准入 + 资源额度的**唯一**合成入口：授予取并集，再与平台硬上限求交 | `capability-policy.ts:292 composeEffectivePolicy`、`:195 unionLimits`、`:216 intersectCeiling` |
| F2 | 到期是**纯时间函数**（比较 `effective_at/expires_at/revoked_at`），**无任何** status 翻转任务 | `capability-policy.ts:163 isAssignmentActive`、`:171 isWithinGrace` |
| F3 | 到期未撤权时有**降级宽限期**（默认 3 天）：宽限内仍放行，但 `deny_reason="policy_expired"` | `policy-service.ts:34 POLICY_GRACE_MS`、`capability-policy.ts:297`（仅 `active.length===0` 才吃 grace）、`:125 grace_expires_at` |
| F4 | 并发原子额度守卫 = workspace 行 `SELECT ... FOR UPDATE`；调用点只有 **5** 处（路由 4 + forward 服务 1） | `policy-service.ts:342 lockWorkspaceRow`、`:360 withWorkspaceQuotaLock`；`routes/tunnels.ts:253`、`routes/node-groups.ts:112`/`:173`、`routes/workspaces.ts:168`、`services/forward-service.ts:787` |
| F5 | **支付/订单/余额不参与判定**：`workspacePolicyAssignment` 全仓只有 **1** 个写入点；`PolicySource.purchase` 存在但**无任何代码写入** | 写入点 `policy-service.ts:320`（`assignDefaultPolicy`）；`billing-access.ts:1`（「Payment writes are opt-in and must never be used to decide RBAC」）；`schema.prisma:115`；`grep -rn '"purchase"' backend/src` 仅命中类型与 `policy-service.ts:84 asSource` |
| F6 | `runtime-admission.ts` 是**正交维度**（action/protocol/transport），不判额度/套餐 | `runtime-admission.ts:1`（「能力协商的唯一判定入口」）、`:24` |
| F7 | 充值回调幂等**形状已正确**：单事务内 `evaluateTransition` → `idempotent` 即返回 `{credited:false}`；入账 `updateMany` 且 `count !== 1` 抛错回滚；迁移矩阵是纯函数，`success → success` 标注「幂等，**不得重复入账**」 | `payment/order.ts:267 handleCallback`、`:276 $transaction`、`:286`、`:325`、`:333`；`payment/order-state.ts:80 evaluateTransition`、`:62 FORBIDDEN` |
| F8 | 余额扣款用**条件更新**防并发超扣 | `routes/plans.ts:155`（`updateMany({ where: { id, balance: { gte: total } } })`） |
| F9 | 套餐周期是**固定天数近似**而非日历月（`month=30/quarter=90/half_year=180/year=365`），到期 = `Date.now() + days*86400000` | `routes/plans.ts:37 CYCLE_DAYS`、`:191`、`:201`、`:215` |
| F10 | 同套餐续期从 `max(now, 原到期)` 起算，但 `traffic`/`max_tunnels` 覆盖写、`traffic_used` **不重置**；只有换套餐才置 0 | `routes/plans.ts:187`、`:192`、`:203`、`:213` |
| F11 | 支付开关只**屏蔽路由**、不影响权限（GET/HEAD 永远放行）；`ENABLE_SUBSCRIPTION` 只是设置白名单项，**无运行时行为**；`license.ts` 是实例级商用许可，不是用户订阅 | `billing-access.ts:2 isBillingBlocked`、`app.ts:124`、`env.ts:70 paymentsEnabled`、`schema.prisma:1252`、`routes/public.ts:173`、`services/license.ts:24`/`:44` |

### 1.2 流量口径现状（三处口径，其中一处只对 UTC+0..+11 正确）

| # | 事实 | 证据 |
|---|---|---|
| F12 | 计费口径的**唯一真相是已归档事实**：对 `tunnel_traffic` 做 `_sum: { traffic: true }`；该表只有**一个写入点**且幂等追加（`createMany({ skipDuplicates: true })`，唯一键 `(tunnel_id, date)`） | `policy-service.ts:262 sumWorkspaceTraffic`、`:271`；`traffic-archive.ts:360`；`schema.prisma:1212` |
| F13 | 窗口起点用**进程本地时钟**（`setHours(0,0,0,0)` + `setDate(1)`），纯函数版同样 | `policy-service.ts:275 trafficStart`、`capability-policy.ts:455 trafficWindowStart` |
| F14 | 归档日界 = **本地日标签 + UTC 午夜戳**（注释明确禁止 `toISOString().slice(0,10)`，UTC+8 会回退一天）；保留期 cutoff 也是 UTC 日界，两者自洽 | `traffic.ts:97 dayKeyOf`、`:104 localDayKey`；`traffic-archive.ts:194 trafficDate`；`traffic-retention.ts#retentionCutoff`（注释解释为何不用本地零点） |
| F15 | `traffic_cost` 列已存在但**恒等于 `traffic`**，且**没有任何口径读它** | `traffic-archive.ts:101`（`traffic_cost: bytes`）；`grep -rn "traffic_cost" backend/src` 仅投影展示（`services/traffic.ts`、`forward-service.ts:303`） |
| F16 | 归档 cron **每 10 分钟**一轮 ⇒「已计量」比数据面滞后 ≤10 分钟 | `worker.ts:42` |

> **口径缝隙（必须写进契约）**：`date` 存「本地日标签的 UTC 午夜戳」，窗口起点却是「本地午夜」的
> 绝对时刻；只有进程时区偏移 **≥ 0**（如 `Asia/Shanghai`）时二者自洽，负偏移时月首整天会被**漏算**。
> `TZ=Asia/Shanghai` 由部署文件保证（`.env.example:5`、`.env.production.example:16`、
> `docker-compose.prod.yaml:93 env_file: [.env]`、`scripts/v3-e2e/docker-compose.e2e.yaml:20`），
> 但那只是部署约定，**不是**契约级保证。

### 1.3 联邦缺口 / 并发占位 / 定时任务 / 归属

| # | 事实 | 证据 |
|---|---|---|
| F17 | 联邦远端腿用量只落 `federation_usage_record`（`usage_id` 唯一索引 = 去重真相），**不写 `tunnel_traffic`** ⇒ `sumWorkspaceTraffic()` 看不到它，额度**被低估** | `federation/usage.ts:575`（「唯一索引是去重真相（不是『先查后写』）」）、`:582 persistUsageReport`、`:594 create`；F12 |
| F18 | 建 Forward 的原子占位是 **`tunnel` 行本身**：workspace 行锁内 `create()`（`apply_status:"pending"`），网络编排在**事务提交后** | `forward-service.ts:787`、`:823`、`:929`；`routes/tunnels.ts:253`、`:282`、`:327` |
| F19 | 端口占位是 **Redis 互斥锁 + `nodePortLease.create` 命中 `UNIQUE(node_id,port)`**，冲突即换下一候选；`reconcileLeases` 是回收判定的唯一实现，reconciler 通过 seam 复用 | `portPool.ts:463 acquirePort`、`:537 tryLock`、`:568 create`、`:425 isUniqueConflict`、`:636 releaseLease`、`:762 reconcileLeases`；`schema.prisma:995`；`reconciler.ts:19 release_orphan_lease`、`:849` |
| F20 | scheduler 内的额度判定是**明确标注的非原子预检**，**不重复实现**行锁（防超发由路由同事务负责）；存量资源不占新计数槽 | `scheduler.ts:911 checkTunnelCreation` + `:912` 注释（「真正防超发的行锁由调用方（WP11 路由）在同事务里包住『判定 + 落库』。这里不重复实现 SOFT-01 的锁」）；`capability-policy.ts:419 checkTunnelUse` |
| F21 | 失败补偿**有向**：按走到哪一步反向回滚（先撤 Egress 再 Ingress）+ `releaseLease`；**永不物理删 Forward**（失败保留行并置 `apply_status="error"`） | `scheduler.ts:27`（补偿顺序）、`:866 createRelayTunnel`（`fail()` 内 `persistFailure`）、`:1480 reapplyRelayTunnel`、`:2274 reapplyDirectTunnel` |
| F22 | 建 Forward 同时消耗三类资源：端口租约 + 转发条数 + 流量额度，且发生在**不同位置**（F18/F19/F12） | F4、F12、F18、F19 |
| F23 | worker 只注册 **4** 个 cron，**无任何**订阅/计费/流量重置任务；`cron_renew_user_plan`（自动续费）与 `cron_notify_plan_expire` 被显式删除，注明「商业化模块，默认关闭」，并明确「**无『隧道过期』概念**（到期的是策略/额度，由 policy-service 判定）」 | `worker.ts:41 CRON_JOBS`、`:28`、`:34`、`:36` |
| F24 | `UserPlan` 只被**展示层**读取、不参与判定（判定层有专门注释「为什么不吃 UserPlan」）；其形状是**用户级单例**（`user_id @unique`），而权限/额度/资源全部按 **workspace** | `routes/dashboard.ts:112`、`:156-160`；`routes/admin.ts:56`；`routes/admin-extended.ts:1068`；`policy-service.ts:15`；`schema.prisma:1073-1088` 对照 `:316`、`policy-service.ts:249`/`:262` |
| F25 | 每个用户有一个 `personal` workspace；`BillingCycle` 已有 5 个周期值；`User.auto_renew` 默认 `false`；本契约改动面涉及的既有模型：`Plan`:1098、`PlanOrder`:1143、`PlanCoupon`:1294、`UserPlan`:1073、`TopupOrder`:1165、`TopupActivity`:1189、`Payment`:1271、`BalanceLog`:1319、`Ticket`:1378、`SystemConfig`:1255 | `schema.prisma`；`services/workspace.ts:11` |

---

## 2. Forwardx 先例与取舍

| 先例 | 可吸收的语义 | TuneX 取舍 |
|---|---|---|
| `shared/billingTime.ts:1` `BILLING_TIME_ZONE="Asia/Shanghai"` + `Intl` 派生日历分量；`:126 billingMonthlyBoundary(ref, resetDay, offset, maxResetDay=28)`、`:103 billingAddMonthsClamped` | 计费边界由**固定时区**决定而非进程 `TZ`；`28` 天上限避免 2 月跳变；日期夹取 | **吸收**（重写为 TuneX 纯函数，语义相同、代码不复用）。TuneX 现状是反例（F13） |
| `server/billingTime.test.ts:53` 同一断言在 `TZ=UTC/Asia/Shanghai/America_Los_Angeles` 下逐字相等 | 「进程时区无关」必须被**测试证明**，不能靠部署约定 | **吸收**：WP20-1 的 DoD 强制三进程时区同一断言 |
| `server/billingTime.test.ts:98` `resetUserTrafficForCycle(u, boundary, now)` 首轮 `true`、同周期第二轮 `false`（标记单调推进） | 周期重置幂等 = **单调周期标记**，不是「再查一次」 | **吸收**：即 §3.1 的 `period_key` 唯一键 |
| `server/userTrafficBillingReset.test.ts` 手工重置只改**展示基线**（`trafficBillingResetBytes`），三张账本表逐行不变 | 「重置展示」与「篡改账本」必须分离 | **吸收**：`UserPlan.traffic_used` 若保留，只能是展示基线 |
| `server/subscriptionBillingState.test.ts:174 repairSubscriptionBillingStateOnce()` 启动期幂等全量修复；`:83` 授权同步失败必须**回滚**（不得扣钱）；`:99` 手工额度与套餐额度**不叠加**；`:189` 计费用户锁串行化 | 计费状态需要**幂等修复通道**；账本与授权必须同事务；额度是「取其一/取大」而非相加 | **吸收**：WP20-3 的 `settleDuePeriods()` 可重复执行并返回计数；发放与订单同事务 |
| `server/subscriptionExpiryRuntime.test.ts` 过期用 runtime gate（`resourceAccessDenied`）而非删规则 | 到期 = 对**新动作** fail-closed，存量运行时不粗暴删除 | **吸收语义，不吸收实现**：TuneX 到期即策略失效 → 拒新建，存量 Forward 不动 |
| `shared/trafficMultiplier.ts:1` 整数万分比（`SCALE=100`、`1..5000`） | 倍率是整数比，不是浮点乘数 | **不吸收（v1）**：见 §3.6 / §4-O3 |
| `server/ruleQuotaReservations.ts:12` 与 `server/portReservations.ts:22` 都是进程内 `Map` 占位 | 进程内「先占位后执行」 | **明确拒绝**：多实例/多 worker 不共享 ⇒ 会超卖。TuneX 必须用 **DB 唯一键**（F19 已是正确先例） |
| `server/trafficBillingAuthorization.ts:9` 全量枚举用户重算并批量 `disabledRuleIds` | 计费变化后全量对账 | **不吸收**：TuneX 授权是**按需求值**（`composeEffectivePolicy(now)`），无存量状态需批量翻转；全量重算 = 第二套 desired |

---

## 3. 冻结决策

### 3.1 计费时钟与「每周期只结算一次」的幂等

**结论**
1. 计费日历**单区域 `Asia/Shanghai`，且必须进程时区无关**。新增纯函数模块
   `backend/src/services/billing-time.ts`：`billingCalendarParts` / `billingMonthStart` /
   `billingMonthlyBoundary(now, resetDay, offset, maxResetDay=28)` / `billingAddMonthsClamped`，
   内部只用 `Intl.DateTimeFormat({ timeZone: "Asia/Shanghai", hourCycle: "h23" })` 派生日历分量。
2. **多租户不引入多时区**：Workspace 表无时区列，`CapabilityPolicy.traffic_period` 只有
   `total/month/day`（`schema.prisma:123`）；per-workspace 时区会同时污染账本、审计与 Gate。
3. **三处口径收敛为一处**：F13 的 `trafficStart`/`trafficWindowStart` 改为委托 `billing-time.ts`，
   使窗口起点、归档日标签（F14）、保留期 cutoff 同源。
4. **幂等 = 先占位后执行，不是「再查一遍」**。新增账本表：`plan_subscription_id` + `period_key`
   唯一（`period_key` = Asia/Shanghai 下的 `YYYY-MM` 或 `YYYY-MM-DD`），另有
   `state pending|settled|failed`、`attempts`、`order_id`、`error`、`started_at`、`settled_at`。
   固定顺序：**① `create` 占位（唯一键即幂等闸门，命中 `P2002` 即本轮跳过）→ ② 扣款/发放 →
   ③ 置 `settled`**。崩溃在 ① 之后 ② 之前留下的 `pending` 由下一轮**接管续跑**（复用
   `forward-rollout-recovery.ts` 已证明的「捞起未完成相位续跑」模式，不新建机制）。

**依据** F2/F3、F7、F13/F14、F23、`federation/usage.ts:575`。**影响面** `policy-service.ts` 两处
窗口函数、`traffic-retention.ts` 调用方、`routes/dashboard.ts`/`routes/tunnels.ts` 图表窗口；一张新表；
worker 新增一个 tick。

**明确不做**：不引入 per-workspace 时区列；不引入用户可配的「结算日」（`resetDay` 固定为 `1`，
即自然月月初，该参数只为实现完备性保留）。

### 3.2 到期转终态

**结论**
1. **不引入状态机、不引入翻转任务**：到期仍是 `expires_at` 上的时间比较（F2）；worker **不**把发放
   标成 `expired`；判定侧每次重算（`getEffectivePolicy(..., { noCache: true })`）。
2. 到期的可观察效果由**既有合成规则自动给出**，按序：① `purchase` 发放失效 → 若仍剩
   `system_default`/`admin_grant` 则**自动降级**（额度/协议收窄）；② 宽限期内 `grace_policies` 非空、
   `deny_scope=false`、`deny_reason="policy_expired"`（F3）；③ 宽限期后一条有效发放都没有才
   `deny_scope=true`。**「降级到 system_default」不需要新代码，是并集语义的自然结果。**
3. **存量 Forward 不停服**：到期只影响**新建/改设置/重试/恢复**这类新动作（`checkTunnelCreation`），
   已有 runtime 继续跑 —— 这不是新决策，而是 V4 基线（F23）。
4. **执行者**：唯一新增执行者是 worker 的 `cron_settle_billing`（§3.1 账本结算 + 到期**通知**），
   它只写 `SubscriptionPeriodSettlement`/`PlanOrder`/`BalanceLog`/`WorkspacePolicyAssignment`
   四类台账，**不做任何权限判定**。
5. 与 `capability-policy` 的联动是**单向**的：计费只改变「哪一条发放存在」，权限与额度一律由
   `composeEffectivePolicy` 从发放算出（F1）；**禁止**在计费模块读 `CapabilityPolicy` 的
   `max_tunnels`/`tunnel_types`（F5/F6 同源纪律）。

**依据** F1、F2/F3、F5、F23、F24。**影响面** `policy-service.ts` 新增
`grantPolicyFromPurchase()`（**唯一**写 `purchase` 发放的函数，内部 `upsert` + `invalidatePolicyCache`）；
`CRON_JOBS` 4 → 5 条；前端复用既有 `describeDeny` 的 `policy_expired` 文案。

**明确不做**：① 不新增 `AssignmentStatus` 枚举或 `expired` 列；② 不在到期时停机/删 Forward/断流；
③ 不放大 `POLICY_GRACE_MS`（改默认值 = 改 V4 已冻结的用户可见行为）；④ 不做「到期自动扣款续费」。

### 3.3 流量周期重置

**结论**
1. **不引入计数器重置机制**：流量额度的真相是「已归档事实的窗口求和」（F12），所以「重置」=
   **窗口自然滚动**，天然幂等、无竞态、无需任务。
2. `UserPlan.traffic_used` **冻结为 legacy 展示列**：不参与判定（F24），且**不得**被任何计费/结算
   路径回写成「本周期已用量」。前端要展示已用流量必须改读 `GET /api/me/capabilities` 的
   `traffic_used`（由 `policy-service.ts:290 getWorkspaceUsageReport` 用窗口求和算出）。
   是否物理删除 → **开放决策 O2**。
3. **口径统一**：F13 的两个函数合并为对 `billing-time.ts` 的一次调用；日切标签继续沿用
   `traffic.ts:104 localDayKey`（已正确且有注释保护）。
4. **竞态处理 = 不做锁**：归档是「追加 + `(tunnel_id,date)` 唯一」的幂等写（F12），窗口求和读的是
   **已归档事实**、不读 Redis 缓冲；并发唯一后果是 **≤10 分钟口径滞后**（F16）——这是**明确接受的
   用户可见边界**，写进产品文案。
5. **联邦口径缺口按现状保留并显式标注**：本期**不合并**两个账本（F17），合并会制造第二份用量真相
   并触犯 §10「Usage authority = host panel」；改为在用量报告输出
   `traffic_used_unattributed_federated`，让缺口**可观测**而非静默。

**依据** F12–F17、F24。**影响面** 只改读取路径（`policy-service.ts`、`capability-policy.ts`、
`routes/dashboard.ts`、`routes/tunnels.ts`、`services/traffic.ts`）；**零 schema 改动**（除非 O2 删列）。

**明确不做**：① 不新增 `traffic_period_started_at`/`last_reset_at` 列；② 不新增「重置流量」定时任务；
③ 不用 Redis 计数器做额度判定（会与归档账本形成第二真相）。

### 3.4 配额预留与并发授权

**结论**
1. **按资源分类处置，不做统一「预留表」**：

   | 资源 | 是否预留 | 机制（唯一真相） |
   |---|---|---|
   | 转发条数 `max_tunnels` | **是**（已存在） | workspace 行锁内 `tunnel.create()` 占位（F18）。**不新增计数表** |
   | 节点端口 `NodePortLease` | **是**（已存在） | Redis 互斥锁 + `nodePortLease.create` 命中 `UNIQUE(node_id,port)`（F19）。**不新增第二套端口占位** |
   | 成员数 `max_members` | **是**（已存在） | `withWorkspaceQuotaLock` + `workspaceMember.create`（F4） |
   | 流量额度 `traffic_limit` | **否（冻结为不预留）** | 流量是**事后计量**（F12），不是一次性可耗尽分配；「预扣」必然与 `tunnel_traffic` 形成第二份用量真相 |

2. **建 Forward 的占位顺序冻结为**（顺序本身即契约）：

   ~~~text
   workspace 行锁内： ① 额度判定 checkTunnelCreation  →  ② tunnel 行 create（占位 1：条数）
   事务提交后：        ③ acquirePort()（占位 2：NodePortLease）  →  ④ 下发 / ACK / rollout
   ~~~

   ③ 失败时的补偿**已有**（F21）：`scheduler.createRelayTunnel` 反向回滚 + `releaseLease`；
   孤儿租约由 `reconciler` 复用 `portPool.reconcileLeases` 回收（F19）。**不新增补偿路径**。
3. **失败占位行不回收**：`tunnel` 行失败后保留并置 `apply_status="error"` —— 这正是「条数占位」的
   实现；重试走 `reapplyRelayTunnel`/`reapplyDirectTunnel`，不重复消耗条数（F20/F21）。
4. **计费的「占位」只针对周期结算**（§3.1 唯一键），**不**为流量额度引入预留。计费占位与端口占位是
   **两个独立事务**，不得嵌套成一个大事务（会持锁等 ACK，违反 F18 注释「网络编排在事务提交后执行」）。

**依据** F4、F12、F18–F22。**影响面** 无 schema 改动；在 `forward-service.ts`/`tunnels.ts` 占位块补
注释锚点，并把「判定 → 占位 → 编排」顺序写进 Gate 断言（§7 G6.7/G6.8）。

**明确不做**：① 不新增 `quota_reservation` 表；② 不把端口占用检查改成先查后插；③ 不让计费结算
进入建 Forward 的判定路径（F5）。

### 3.5 归属：套餐属于 Workspace，但**分两步**落地

**结论**
1. **目标真相：订阅属于 Workspace，不属于 user**。判定链全部按 workspace（F24），而
   `UserPlan.user_id @unique`（F24）在 team workspace 下**无法表达**「一个租户一份套餐、
   多成员共享额度」。
2. **分两步、第一步不加破坏性约束**：新增 `PlanSubscription`（`workspace_id Int @unique` +
   `plan_id` + `started_at` + `expires_at` + `auto_renew Boolean @default(false)` + `source` +
   快照字段）**作为唯一真相**；`UserPlan` **冻结为 legacy 兼容视图**，仅由 `personal` workspace
   的购买路径双写（保持 `routes/dashboard.ts:113` 与 `routes/admin-extended.ts:1068` 不破），
   判定层继续不读它；**不删** `UserPlan.user_id @unique`、**不改** `PlanOrder.user_id`
   （历史账本不得重写）。
3. **自动续费 fail-closed 默认关闭**：复用既有 `User.auto_renew @default(false)` 语义（F25）。
   结算任务**只记账、只降级**，绝不默认扣款续期 —— 这是对「不照搬 Forwardx 容忍型自动动作
   默认打开」的直接落实。
4. **`PlanOrder` 仍挂 user**（谁点的购买谁付款），新增可空 `workspace_id` 表达「这笔钱买给哪个租户」；
   历史行 `NULL` 是**合法历史**，不猜。

**依据** F8、F23、F24、F25。**影响面** 新增 2 张表 + 1 个可空列；`routes/plans.ts` 的 4 个分支
（`:186/:196/:207` 与 `traffic_used` 重置）改为「写 `PlanSubscription` + 双写 `UserPlan`」；
`routes/dashboard.ts` 改为优先读 `PlanSubscription`。

**明确不做**：① 不改 `UserPlan` 的主键/唯一约束；② 不把 `Plan`（商品模板）与 `CapabilityPolicy`
（能力策略）合并成一张表；③ 不做「套餐 → 策略」的**隐式**推导 —— 发放必须是一条显式的
`WorkspacePolicyAssignment`（F5），套餐上需显式绑定 `policy_id`。

### 3.6 流量倍率（`trafficMultiplier`）

**结论：v1 不引入。** ① `CapabilityPolicy` 与 `Plan` 都没有倍率列（F25）；唯一预留位是
`TunnelTraffic.traffic_cost`，而它**恒等于 `traffic`**（F15）且**没有任何口径读它**（F12）。
② 若引入，口径必须唯一：**倍率只作用于账本写入侧**（归档时把 `traffic * m / 100` 写入 `traffic_cost`），
且 `sumWorkspaceTraffic` 必须同步切到 `traffic_cost` ——「展示乘一遍、额度乘一遍、账本不乘」是三个
口径，直接把 V4 账本一致性打穿。③ 本期最小代价是**不引入**：TuneX 无「线路差异化计费」的产品需求
（`Plan` 按 GB 定额），而引入会同时影响额度判定、保留期口径、客户对账与联邦归因（F17），收益 < 代价。
④ 若 Lead 决定引入，必须**独立 WP**（WP20-7），且先冻结「`traffic` 与 `traffic_cost` 各自的消费者
清单」，再动 schema。

**依据** F12、F15、F17、F25；`Forwardx/shared/trafficMultiplier.ts` 的整数万分比口径可作为将来实现
形状的**参考形状**（不复制代码）。

**明确不做**：① 不新增倍率列；② 不改 `sumWorkspaceTraffic` 的求和列；③ 不在前端做倍率展示。

---

## 4. 开放决策（不猜；候选与代价）

> ### 4.0 Lead 裁决（2026-10-05）：归属、`traffic_used`、倍率 **已冻结**
>
> **归属（本契约最大的取舍）—— 套餐属 Workspace，不属 user。**
> 新增 `PlanSubscription`（`workspace_id @unique`）作为唯一真相；`UserPlan` 冻结为
> **legacy 读路径**（不删列、不删表）。依据：TuneX 的**全部额度判定都已经按 workspace**
> （`policy-service` 的 assignment、`capability-policy` 的行锁守卫、`sumWorkspaceTraffic`），
> 而 `UserPlan.user_id @unique` 是一个与判定链不一致的旧形状。代价明确接受：WP20-2 多两张
> 表与一处可空列，dashboard 的读取路径要跟着切。
>
> **`UserPlan.traffic_used` —— 保留为 legacy 展示列，禁止回写。**
> 与第 3.4 条（流量真相是窗口求和）一致；不删列以免丢掉历史快照并引发前端大改。
>
> **流量倍率 —— v1 不引入。** `traffic_cost` 当前恒等于 `traffic` 且没有任何口径读它；
> 一旦引入，所有存量用户的已用流量数字会当场变化，需要口径切换公告 + Gate 回归，而
> `traffic_cost` 的历史值不可比。要做是独立 WP。
>
> **O5 联邦远端腿用量 —— 不计入额度**（与"Usage authority = host panel"一致），只保留
> `traffic_used_unattributed_federated` 作为可观测缺口，**不合并两本账**。
>
> **O6 到期通知 —— 不在本 WP**，与 WP18 的 O1 裁决一致：本 WP 落地**之后**该事实源才
> 存在，届时由 WP18 单独登记为通知源。
>
> **O1/O4**：O1 不抽象统一 Reservation（收益为零且会碰 V4 冻结的端口所有权路径，取文档
> 的推荐项）；O4 接管超时**登记进 SystemConfig**（默认 10 分钟，可调，不得硬编码）。

> 以下**均未冻结**，落地前需 Lead 明确拍板，不允许实现者自行选择。

**O1 · 端口租约是否纳入统一的「配额预留」抽象？（非阻塞）**
- A：保持现状（端口用唯一键、条数用 tunnel 行，互不抽象）。代价=两套占位形状；收益=零改动零回归。**推荐**。
- B：抽出 `Reservation` 接口统一两者。代价=触碰 V4 冻结的端口所有权路径（`DEVELOPMENT.md` §1.5、
  `verify.sh` T2「无双 owner」断言），且抽象不带来新能力。

**O2 · `UserPlan.traffic_used` 保留还是删除？（需 Lead 拍板）**
- A：保留为 legacy 展示列、永不回写（§3.3）。代价=留一个语义误导的列；收益=dashboard/admin 零改动。
- B：WP20-6 一次性删除该列及被策略取代的 `traffic`/`max_tunnels`/`whitelist_ips`。代价=必须同步改
  dashboard、admin 用户详情、管理页类型与前端 mock，且历史快照丢失。
- C：保留但改名 `legacy_traffic_used`。代价=一次无收益 migration + 前端字段重命名。

**O3 · 是否引入流量倍率？（需 Lead 拍板）**
- A：不引入（§3.6）。代价=无法做线路差异化计费。
- B：引入，只在归档写入侧作用于 `traffic_cost` 并把 `sumWorkspaceTraffic` 切到 `traffic_cost`。
  代价=**所有既有用户已用流量数字当场变化**，需口径切换公告 + Gate 回归；且 `traffic_cost` 历史值
  （= `traffic`，F15）与切换后不可比，必须记录切换时刻。
- C：引入但只做展示。代价=制造「展示 ≠ 判定」的第二口径，与仓库纪律直接冲突。

**O4 · 结算 `pending` 的接管超时取多少？（可实现层默认，需登记）**
- 候选 **10 分钟**（与充值订单超时口径一致，`routes/topups.ts:22`）。代价=若结算慢于 10 分钟会
  **重复执行**，因此结算必须幂等可重放（条件扣款 F8 + `upsert` 发放）。
- 该值应登记为 `SystemConfig` 项，而非硬编码常量（沿用「契约值集中在一处」的纪律）。

**O5 · 联邦远端腿用量是否计入 Workspace 流量额度？（非阻塞，影响产品口径）**
- A：不计入，只暴露 `traffic_used_unattributed_federated`（§3.3）。**推荐**。
- B：计入 —— 需把 `federation_usage_record` 与 `tunnel_traffic` 归并成读模型。代价=两面板用量窗可能
  重叠/空洞，合并引入「谁权威」的模糊，与 §10「Usage authority = host panel」冲突。

**O6 · 到期通知（`Ticket`/邮件）是否属于本 WP？**
- A：本期不做通知，到期只体现在 API 的 `deny_reason`。代价=用户「下次操作时才被告知」（可解释但被动）。
- B：只做站内 `Ticket`/`AuditLog` 记录，不发外部邮件（避免新第三方依赖）。

---

## 5. WP 拆分

| WP | 内容 | 交付物 | 依赖 |
|---|---|---|---|
| **WP20-0** | 本契约冻结（含 §7 Gate 与时间夹具规格）+ Lead 对 O2/O3 拍板 | 本文件 + `DEVELOPMENT.md` §4 登记 | — |
| **WP20-1** | 计费时钟纯函数 | ✅ **已交付**（2026-10-05，见 §5.1）：`backend/src/services/billing-time.ts` + `backend/src/services/__tests__/v5-wp20/billing-time.test.ts`（三进程时区逐字相等） | WP20-0 |
| **WP20-2** | 账本与归属 schema | migration：`PlanSubscription`、`SubscriptionPeriodSettlement`、`PlanOrder.workspace_id`(nullable)；`UserPlan` 冻结注释 | WP20-1 |
| **WP20-3** | 周期结算 tick（幂等占位 + 接管续跑） | `backend/src/services/subscription-billing.ts`（纯判定 + 注入依赖）+ `worker.ts` 新增 `cron_settle_billing`（每小时） | WP20-2 |
| **WP20-4** | 支付 → 策略发放接线（`purchase` 唯一写入点） | `policy-service.ts#grantPolicyFromPurchase` + `routes/plans.ts` 事务内调用 + `invalidatePolicyCache` | WP20-2 |
| **WP20-5** | 到期降级与可观测 | 复用 `describeDeny` 文案 + 用量报告补充到期/宽限字段（**不新增状态机**） | WP20-4 |
| **WP20-6** | 流量口径统一 | F13 两函数收敛到 `billing-time.ts`；`traffic_used_unattributed_federated`；`traffic_used` 读取路径切换 | WP20-1（可与 20-3 并行） |
| **WP20-7** | （条件）流量倍率 | 仅当 O3 选 B 时立项，需独立契约补充 + Gate 断言 | O3 拍板 |

顺序约束：**一次只做一个 WP**（`DEVELOPMENT.md` §3.1）。WP20-6 与 WP20-3 无共享文件，可并行；其余串行。

### 5.1 WP20-1 落地记录（2026-10-05，分支 `feature/v5-1b-udp-relay`）

> 本表按顺序执行得到：**WP20-0 已由 Lead 冻结（§4.0 + 本文件）**，故第一个可交付 WP 是
> **WP20-1（计费时钟）**，不是「套餐归属落库」——归属落库是 WP20-2，它**依赖** WP20-1。

**交付物（实际路径 + 与上表的一处偏差）**

| 文件 | 说明 |
|---|---|
| `backend/src/services/billing-time.ts` | 纯函数模块，唯一导出面 = `BILLING_TIME_ZONE`、`BillingCalendarParts`、`billingCalendarParts`、`billingMonthStart`、`billingMonthlyBoundary`、`billingAddMonthsClamped`（即 §3.1 点名的四个函数 + 时区常量/类型） |
| `backend/src/services/__tests__/v5-wp20/billing-time.test.ts` | 24 条断言，含「三子进程时区逐字相等」 |
| `backend/src/services/__tests__/v5-wp20/billing-clock-canonical.ts` | 测试专用金样本生成器（被本进程与三个子进程共同调用） |

**偏差（记录理由，不静默）**：上表把测试写成 `backend/src/__tests__/billing-time.test.ts`，实际落在
`backend/src/services/__tests__/v5-wp20/`。理由：① 这是本次任务的 writeScope 划定范围；
② `backend/src/__tests__/` 与 `backend/src/services/__tests__/` 两个目录并存是既有事实，
而 `services/` 下的被测模块配套测试一直在 `src/services/__tests__/`（如 `traffic-retention.test.ts`）；
③ `v5-wp20` 子目录让后续 WP20-2/20-3 的测试同址聚集。**符号名与断言不受影响。**

**语义冻结（实现里做实的判定，均带反例测试）**

1. **固定 `Asia/Shanghai`，进程时区无关**：日历分量只能来自
   `Intl.DateTimeFormat("en-US-u-nu-latn", { timeZone: "Asia/Shanghai", hourCycle: "h23" })`。
   *反例（为什么不沿用 F13 的 `setHours(0,0,0,0)`）*：同一瞬时点 `2026-01-31T16:00:00Z`，
   `TZ=UTC` 下 `setDate(1)` 得 `2026-01-01T00:00:00Z`，`TZ=Asia/Shanghai` 下得
   `2025-12-31T16:00:00Z` —— 一个时刻两个答案，正是 R1 的成因。
2. **`billingCalendarParts` 只接受显式时间点**（`Date | number`），非法值抛 `RangeError`（fail-closed）。
   `hourCycle: "h23"` 保证上海午夜是 `00` 而不是 `24`（有断言）。
3. **`billingMonthStart`** = 上海当月 1 日 00:00:00.000（= 上月末 16:00Z）。这就是
   `traffic_period="month"` 的窗口起点语义。*反例*：`2026-02-28T15:59:59.999Z` → `2026-01-31T16:00:00Z`，
   而 `2026-02-28T16:00:00.000Z` → `2026-02-28T16:00:00Z`（差 1ms 差整月）。
4. **`billingMonthlyBoundary(reference, resetDay, monthOffset=0, maximumResetDay=28)`**：目标月 = 上海月 +
   `monthOffset`；日期**两层夹取、顺序固定**：先 `min(requested, maximumResetDay)`（默认 28，避免 2 月跳变），
   再 `min(…, 该月实际天数)`（闰年 2 月 = 29）。
   `resetDay` 非法（`0`/负数/空串/`NaN`/小数取整后 <1）一律回落 **1**；`maximumResetDay` 非法回落 **1**
   （比下限更严，方向是收紧而非放宽，故不构成放松）。
   *反例（为什么必须有 28 上限）*：`resetDay=31`、无上限时「1 月 31 日 + 1 月」在 JS 里会溢出成 3 月 3 日；
   夹取后是 2 月 28 日。产品侧固定 `resetDay=1`（§3.1「不做用户可配结算日」），该参数只为实现完备性保留。
5. **`billingAddMonthsClamped(reference, months)`**：按月推进、日夹取到目标月长度、**保留上海墙钟的
   时/分/秒/毫秒**。*反例（为什么不按 UTC 偏移加月）*：带 DST 的时区里按偏移加月会在月末凭空多/少 1 小时，
   「1 月 31 日 10:30 买的月付，2 月 28 日 10:30 到期」这句用户可见语义会被破坏；
   实际断言：`2026-01-31T15:59:59.999Z` +1 月 = `2026-02-28T15:59:59.999Z`（毫秒都在），
   `2028-01-31T02:30Z` +1 月 = `2028-02-29T02:30Z`（闰年）。

**明确延期（不在 WP20-1，避免越界与第二真相）**

- **`period_key`（`YYYY-MM` / `YYYY-MM-DD`）格式化不在此 WP**：它的形状由
  `SubscriptionPeriodSettlement UNIQUE(plan_subscription_id, period_key)`（WP20-2 的 schema）定义，
  放在 WP20-1 会先冻一个没有消费者的形状。→ 归 WP20-2/WP20-3。
- **`policy-service.ts#trafficStart` 与 `capability-policy.ts#trafficWindowStart` 未改**：§3.1.3 的
  收敛属 **WP20-6**。因此 **DoD 第 8 条在 WP20-1 交付后仍不满足**（别误判为回归）。
- **无 schema 改动**：`grep -rn "enum .*Status" backend/prisma/schema.prisma` 数量不变 ⇒ DoD 第 7 条成立。
- **未注册 cron、未新增依赖、未碰 docker/e2e 拓扑与 `worker.ts`**。

**证据**

```
# 三时区逐字相等（DoD 3）：24 pass / 0 fail / 88 expect() calls，三次输出（剥离耗时）byte-identical
for tz in UTC Asia/Shanghai America/Los_Angeles; do \
  TZ=$tz bun test src/services/__tests__/v5-wp20/billing-time.test.ts; done
# 类型：TMPDIR=/tmp bunx tsc --noEmit（在 backend/）→ exit 0
```

**DoD 覆盖矩阵（仅针对 WP20-1）**：第 3 条 ✅（真跑子进程，跑不起来即 FAIL，不 skip）；
第 7 条 ✅（零 schema 改动）；第 8 条 ⏳ 属 WP20-6；第 1/2/4/5/6/9/10/11 条不适用（WP20-2 起）。

---


## 6. DoD

1. **不变量（CRITICAL）**：`grep -rn "checkTunnelCreation\|max_tunnels" backend/src/services/payment backend/src/services/subscription-billing.ts` **必须为空** —— 计费侧不得出现任何额度判定（F5/F6）。
2. `workspacePolicyAssignment` 写入点从 **1** 变 **2** 且仅此两个（`assignDefaultPolicy` + `grantPolicyFromPurchase`）：`grep -rn "workspacePolicyAssignment.create\|workspacePolicyAssignment.upsert"` 精确命中 2 处。
3. `billing-time.ts` 同一组断言在 `TZ=UTC`/`TZ=Asia/Shanghai`/`TZ=America/Los_Angeles` 下逐字相等（先例 `Forwardx/server/billingTime.test.ts:53`，**重写不复用**）。
4. 结算幂等可证：同一 `(plan_subscription_id, period_key)` 连跑两轮，第二轮 `settled`/`skipped` 为 0，且 `PlanOrder`/`BalanceLog`/余额三者均无变化。
5. 结算崩溃可恢复：手工插入 `state="pending"` 且 `started_at` 早于接管超时的行，下一轮必须**恰好一次**推到 `settled`。
6. 到期语义可证：`purchase` 发放过期后 `getEffectivePolicy` 返回 `grace_policies` 非空 + `deny_reason="policy_expired"`；再越过 `POLICY_GRACE_MS` 后若仍有 `system_default` 则额度**降级**而非 `deny_scope`（证据=合成前后 `limits` 差异）。
7. **无新状态机**：`grep -rn "enum .*Status" backend/prisma/schema.prisma` 的枚举数量**不增加**。
8. 流量口径只有一个实现：`grep -rn "setHours(0, 0, 0, 0)" backend/src/services` 在 `policy-service.ts`/`capability-policy.ts` 中 **0** 命中（已收敛到 `billing-time.ts`）。
9. 自动动作默认关闭：新建订阅路径 `auto_renew` 默认 `false`；`grep -rn "auto_renew" backend/src` 无「默认开启」赋值。
10. V4 冻结基线未破：`scripts/v3-e2e/verify.sh`（T0–T8）与 `v5-g0`/`g1b`/`g4`/`g5` 在**不改断言**的前提下全部通过。
11. `DEVELOPMENT.md` §4 路线表登记 WP20 各子项状态，并在 §6.2「packets 计费」条目下补一行「订阅计费运行时见 WP20 契约」。

---

## 7. Gate 映射（`scripts/v3-e2e/`）与时间夹具

### 7.1 新增 Gate `v5-g6.py`（Billing Runtime Gate）

| 断言 | 内容 | 依赖的真实证据 |
|---|---|---|
| G6.1 | 计费时钟进程时区无关：容器内以 `TZ=UTC` 与 `TZ=Asia/Shanghai` 各跑一次同一断言 | §3.1、F13 |
| G6.2 | 购买成功 → 存在 `purchase` 来源的发放（`GET /api/me/capabilities` 能看到对应 policy key） | §3.2、F5 |
| G6.3 | **连跑两遍结算 tick**：第二遍 `settled=0`，`plan_order`/`balance_log`/余额逐行不变 | §3.1、F7、`federation/usage.ts:575` |
| G6.4 | 预置 `pending` 超时行 → 下一轮**恰好一次**推入 `settled`（崩溃恢复） | §3.1、F21（rollout 续跑同源） |
| G6.5 | 到期降级：`expires_at` 过后新建被拒且 `code="policy_expired"`；**存量 Forward 仍 `apply_status="active"`** | §3.2、F2/F3、F18 |
| G6.6 | 宽限期后 fail-closed：移除 `system_default` 发放 → `deny_scope=true`，新建被拒 | §3.2、F4 |
| G6.7 | 占位顺序：额度拒绝时**不产生** `NodePortLease` 行（判定先于端口占位） | §3.4、F18/F19 |
| G6.8 | 端口占位失败（预占同端口）时 tunnel 行保留为 `pending`/`error` 而非被删除 | §3.4、F21 |
| G6.9 | 流量口径一致：窗口求和与 `/api/me/capabilities` 的 `traffic_used` 在跨月边界前后一致 | §3.3、F12–F14 |
| G6.10 | 联邦缺口可观测：存在 `federation_usage_record` 时 `traffic_used_unattributed_federated > 0`（若 O5 选 A） | F17 |

失败语义沿用既有纪律（`scripts/v3-e2e/README.md`：**缺少拓扑/超时/前提失败一律 FAIL，不得 skip**）。

### 7.2 是否需要「时间旅行」夹具

**需要，但不需要真的穿越时钟。** 冻结三条：

1. **纯函数层**：周期边界函数必须接受显式 `now` 参数，测试直接用 `new Date("...")` 断言 —— 零夹具。
2. **编排层**：沿用既有**依赖注入**先例（`scheduler.ts:873 deps.now()`、`traffic-archive.ts#defaultTrafficArchiveDeps`、`reconciler.ts#ReconcileDeps`），结算服务必须暴露 `settleDuePeriods(deps, now)`。**禁止** patch 全局 `Date.now`。
3. **Gate 侧不注入时钟，而是直接预置状态**：① 往 `subscription_period_settlement` 插一条上一周期的 `pending` 行；② 通过可显式触发的 tick 入口（cron 名 + BullMQ 立即入队）跑一轮。新增夹具 `scripts/v3-e2e/fixtures/billing-clock.json`（预置行 + 期望计数）与 `docs/evidence/v5-g6-result-<date>.txt` 证据文件。
4. 若确需端到端跨月验证，**唯一**允许方式是 `tick(name, { now })` 显式入参（worker 读 env `TUNEX_BILLING_NOW`，仅 e2e compose 设置）；但这引入一个生产可被误设的时间覆盖开关，故**默认不实现**，列为 O4 的延伸决策。

---

## 8. 明确不做

1. **不引入第二套状态机**：不新增 `SubscriptionStatus`/`AssignmentStatus` 枚举；订阅「有效」= `started_at <= now < expires_at`，与 `isAssignmentActive` 同构。
2. **不引入第二份 desired**：订阅不生成任何「期望配置」，不进入 Forward desired → revision → ACK → applied 链。
3. **不引入第二套权限判定**：计费模块不得 import `capability-policy.ts` 的判定函数，不得读 `max_tunnels`/`traffic_limit`/`tunnel_types`（F5/F6/F24）。
4. **不照搬 Forwardx 三件事**：① 不做 shell-out 多引擎当主数据面（计费不触发任何 Agent/引擎命令）；② 不做容忍型自动动作默认打开（自动续费默认 `false`，到期不做「先续上再说」的兜底）；③ 不向面板下发整份配置（发放变化只 `invalidatePolicyCache()`）。
5. **不改 V4 冻结基线**：不改 `NodePortLease` 唯一性语义、不改 `WorkspacePolicyAssignment` 形状、不改 `tunnel_traffic` 唯一键、不删 `verify.sh` 任何断言。
6. **不跑 Docker 门禁、不装依赖**（WP20-0 的唯一交付物是本文件；本会话未跑任何容器）。
7. **不做跨面板计费**：`federation_usage_record` 只做归因展示，不参与本面板额度（O5 候选 A）。
8. **不引入进程内预留/锁**（`ruleQuotaReservations.ts` 的反面教材）。
9. **不做支付渠道侧改动**：`payment/{epay,bepusdt,heleket}.ts` 与 `handleCallback` 的幂等形状（F7）**不动**；WP20-4 只在「入账成功之后」接一条发放动作，且必须复用既有 `afterCredit` 钩子槽位（`payment/order.ts:347`）。

---

## 9. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **进程时区漂移**：`TZ` 只由 `.env` 提供（`docker-compose.prod.yaml:93`），缺失则 F13 的窗口起点跟随宿主时区，跨月边界整日偏移 | 额度算错一天、保留期错位 | WP20-1 把窗口起点收敛到固定时区的 `billing-time.ts`（不再依赖进程 `TZ`）；G6.1 用两个 `TZ` 值证明 |
| R2 | **宽限期是「容忍型默认」**：默认 3 天且到期仍放行（F3） | 到期后仍可用 3 天，可能被视为自动放宽 | 保持现状（改默认值 = 破 V4 用户可见行为）；产品文案显式展示 `grace_expires_at`（已有字段） |
| R3 | **≤10 分钟计量滞后**（F16）：额度耗尽后仍可能多跑 10 分钟 | 轻度超用 | 明确接受并写入文案；硬保证需数据面侧计数上报，属 B3（`DEVELOPMENT.md:1474`），不在本 WP |
| R4 | **联邦用量不进额度账本**（F17） | 联邦场景额度低估 | 冻结为**可观测缺口**（§3.3.5）；合并账本属独立 WP 且需先解决「谁权威」 |
| R5 | **`PlanOrder` 历史行无 `workspace_id`** | 前端归属统计可能显示「未归属」 | 迁移保持可空 + 不猜历史；新行必填由 WP20-4 应用层保证 |
| R6 | **双写 `UserPlan` 与 `PlanSubscription` 漂移** | 展示与真相不一致 | `PlanSubscription` 是唯一真相；DoD 要求双写同事务 + WP20-6 把 dashboard 切到新表 |
| R7 | **结算接管超时过小**（O4） | 同一周期被重复执行 | 结算必须幂等可重放（条件扣款 + `upsert`）；G6.3/G6.4 覆盖 |
| R8 | **本文件与 `DEVELOPMENT.md` 的编号不一致**（无 WP17–WP21 登记） | 接手 Agent 找不到 WP20 的登记 | WP20-0 的 DoD 第 11 条要求登记路线表；在此明确：本文件是**契约提案**，不是已登记路线 |

---

## 10. 证据索引

所有事实均在正文以 `文件:符号` 就地引用（§1 的 F1–F25、§2、§3、§8 各条）。
本节只列**最常被复核的符号名**，避免二次维护出第二份真相：
`composeEffectivePolicy` / `isAssignmentActive` / `checkTunnelCreation` / `withWorkspaceQuotaLock` /
`lockWorkspaceRow` / `sumWorkspaceTraffic` / `assignDefaultPolicy` / `invalidatePolicyCache` /
`acquirePort` / `releaseLease` / `reconcileLeases` / `trafficDate` / `localDayKey` / `retentionCutoff` /
`evaluateTransition` / `handleCallback` / `persistUsageReport` / `runFederationReconcile`。
Forwardx 侧先例符号：`BILLING_TIME_ZONE` / `billingMonthlyBoundary` / `billingAddMonthsClamped` /
`resetUserTrafficForCycle` / `repairSubscriptionBillingStateOnce` / `applyTrafficMultiplier`。

# V5-WP20 订阅计费运行时契约（周期结算 / 流量周期 / 配额预留）

> **状态：PROPOSED → 部分落地（2026-10-05）**：Lead 已冻结归属 / `traffic_used` / 倍率 / O5 / O6
> （§4.0），**WP20-1（计费时钟）、WP20-2（账本与归属 schema）、WP20-3（周期结算 tick）、
> WP20-4（支付 → 发放接线 + 续期执行器）、WP20-4b（套餐 ↔ 策略绑定入口）、
> WP20-5（到期降级与可观测）、WP20-6（流量口径统一）、WP20-6b（`/api/me/capabilities` 端点）已交付**，
> 并由 **V5-G7 门禁**（§7.1）在真 MySQL 上验证；**额度周期语义修正**见 §5.9（月额度可复位）。
> 除 §5.1–§5.9 这九处记录外，本契约其余部分仍**不含实现**。
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
| **WP20-2** | 账本与归属 schema | ✅ **已交付**（2026-10-05，见 §5.2）：migration `20261031000000_v5_wp20_subscription_ledger`（`PlanSubscription`、`SubscriptionPeriodSettlement`、`PlanOrder.workspace_id`(nullable)）+ `UserPlan` 冻结注释 | WP20-1 |
| **WP20-3** | 周期结算 tick（幂等占位 + 接管续跑） | ✅ **已交付**（2026-10-05，见 §5.3）：`backend/src/services/subscription-billing.ts`（纯判定 + 注入依赖）+ `worker.ts` 新增 `cron_settle_billing`（每小时 `45 * * * *`） | WP20-2 |
| **WP20-4** | 支付 → 策略发放接线（`purchase` 唯一写入点） | ✅ **已交付**（2026-10-05，见 §5.4）：`policy-service.ts#grantPolicyFromPurchase` + `subscription-purchase.ts`（购买/续期共用实现）+ `routes/plans.ts` 事务内调用 + `invalidatePolicyCache`；并把续期执行器 `renewSubscriptionPeriod` 接上 | WP20-2 |
| **WP20-4b** | 套餐 ↔ 策略绑定入口（WP20-4 的写入路径补完） | ✅ **已交付**（2026-10-05，见 §5.5）：`services/plan-subscription.ts` + 套餐 CRUD 的 `policy_id` + 只读选项端点 + 前端字段 | WP20-4 |
| **WP20-5** | 到期降级与可观测 | ✅ **已交付**（2026-10-05，见 §5.8）：`buildUsageExpiryView` 投影落在 `/api/me/capabilities` 与 `/api/dashboard/stats`；前端 `PlanExpiryNotice` 渲染后端文案；**DoD 6 证明**（不新增状态机） | WP20-4 |
| **WP20-6** | 流量口径统一 | ✅ **已交付**（2026-10-05，见 §5.6）：三处日/月界收敛到 `billing-time.ts`、`traffic_used` 读取路径切换、`traffic_used_unattributed_federated` 落在已挂载的用量端点上 | WP20-1 |
| **WP20-6b** | 补 `GET /api/me/capabilities`（契约 §3.3.2 的读路径落点） | ✅ **已交付**（2026-10-05，见 §5.7）：`routes/me.ts` + `app.ts` 挂载 + 子进程 HTTP 契约 | WP20-6 |
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

### 5.2 WP20-2 落地记录（2026-10-05，分支 `feature/v5-1b-udp-relay`）

**交付物**

| 文件 | 说明 |
|---|---|
| `backend/prisma/schema.prisma` | **增量**：`PlanSubscription`、`SubscriptionPeriodSettlement`、`PlanOrder.workspace_id`（可空）、`Workspace`/`Plan`/`PlanOrder` 反向关系、`UserPlan` 冻结注释。未删/未改任何既有列与约束 |
| `backend/prisma/migrations/20261031000000_v5_wp20_subscription_ledger/migration.sql` | 纯 additive：2 张新表 + 1 个可空列 + 1 个索引 + 5 个外键；DDL 由 `prisma migrate diff` 生成（不是手写） |
| `backend/src/services/__tests__/v5-wp20/schema-wp20.test.ts` | 20 条静态不变量断言（读 schema + 迁移文本，不连 DB） |

**冻结的语义与理由（都带反例或实证）**

1. **`state` / `source` 用 VARCHAR + 应用层校验，不新增任何枚举**（DoD 7、§8.1）：订阅「有效」=
   `started_at <= now < expires_at` 的时间比较，不是状态列。证据：`enum` 总数 30 → 30，
   `*Status` 集合逐字不变（`Status`/`TopupOrderStatus`/`WithdrawStatus`/`TicketStatus`）。
   反例：一旦引入 `SubscriptionStatus`，就会出现「订阅状态」与「发放是否有效」两个真相。
2. **`expires_at` 可空**：`BillingCycle` 含 `lifetime`（F25），终身订阅没有到期点。反例：NOT NULL
   会逼出一个魔法日期（`9999-12-31`），成为第二个真相 + 边界 bug。
3. **快照只含商务口径（`plan_name` / `billing_cycle` / `price`），刻意不抄额度数字**。
   反例：若在此列 `traffic_limit`/`max_tunnels`，读方（含未来的我们）会拿它当额度判定输入 ——
   那就同时违反 §3.5.3「不做套餐 → 策略的隐式推导」与 §8.3/F5「额度唯一真相是显式发放」。
   断言里把 `max_tunnels`/`traffic_limit`/`policy_id` 列为**禁止出现**在 `PlanSubscription` 里。
4. **`PlanOrder.workspace_id` 可空、零回填**：历史行 `NULL` 是合法历史，不猜（R5）；新行归属由
   WP20-4 应用层保证。反例：若 `NOT NULL` + 默认值，会把「历史未归属」伪装成「归属到某个 workspace」。
5. **外键取向是被既有删用户流程倒推的，不是偏好**（`routes/admin-extended.ts:400-440`：同一事务里
   先 `workspace.deleteMany` 删个人 workspace，**之后**才删 `planOrder`）：
   - `plan_subscription.workspace_id` → **Cascade**。反例：`Restrict` 会让「删用户」在存在订阅时
     直接抛错，即打破既有管理路径。
   - `plan_order.workspace_id` → **SetNull**（Prisma 对可空关系的默认，也正好等于 R5 的语义）。
   - `settlement.order_id` → **SetNull**；`settlement.plan_subscription_id` → **Cascade**。
   **代价明确接受**：删用户会连带删掉其订阅与结算占位 —— 但这与该流程**本就**删除
   `planOrder`/`balanceLog`/`userPlan` 是同一口径，不新增语义损失；「账本不可变」靠
   「没有应用层删除路径」保证（§2 先例语义）。
6. **`period_key` 形状在此冻结**：`VARCHAR(16)`，值域 `YYYY-MM`（月结）/ `YYYY-MM-DD`（日结），
   上海时区下的标签；这正是 WP20-1 刻意延期的那个决定。

**事故与修复（必须留痕）**

本 WP 在建过程中发生一次**并发编辑事故**，两个独立原因叠加：

1. 另一位成员提交时用了「把所有工作树改动一起 add」的方式，把**本 WP 尚未提交的在建文件**
   （`schema.prisma` 的增量、本迁移、本测试）扫进了 `feat(v5-wp17.4)` / `fix(v5-wp21)` 两个提交。
2. 更危险的一半：`prisma migrate diff` 的输入是「HEAD schema → 当前工作树 schema」的**差集**，
   在生成期间对方的 `NotificationDelivery` 已进入共享 schema，于是**对方的建表语句被夹进本迁移**，
   与对方自己的 `20261030000000_v5_wp18_notification_delivery` **重复建表** —— 空库
   `prisma migrate deploy` 会在本迁移直接失败（`ER_TABLE_EXISTS_ERROR`）。本迁移已删除该段并复核。

**纪律结论（写给后续 WP）**：① 共享 `schema.prisma` 上生成迁移后，必须**复核生成物只含自己的模型**
（本次的守卫断言即为此）；② 多人在同一工作树并行时**禁止**「一次性 add 全部改动」的提交方式，
提交只 add 自己名下的路径；③ 迁移的「表」维度需要一条全仓守卫，本次已加：
`没有任何表被两次建出`（修复前状态会被它抓到，已验证）。

**未决 / 不在本 WP**

- `Plan.policy_id`（套餐 → 策略的**显式**绑定，§3.5.3）不在本 WP ⇒ WP20-4。
- `prisma generate` 已本地跑通（client 认出新模型）；**迁移未在真实 MySQL 上 apply 过** ——
  本会话没有 DB 且 §8.6 禁止跑容器门禁，故迁移只做了 `prisma validate` + DDL 复核 + 静态守卫。
- 观察（交 owner 判断，**不在本 WP 修**）：`20261030000000_v5_wp18_notification_delivery` 里的索引名
  （如 `notification_delivery_dedupe_channel_key`）与 Prisma 由 `@@unique([dedupe_key, channel_kind])`
  推导出的默认名（`notification_delivery_dedupe_key_channel_kind_key`，`migrate diff --from-empty` 实测）
  不一致，后续 `migrate dev`/`diff` 可能把它报成漂移。

**证据**

```
DATABASE_URL=... bunx prisma validate                      → valid 🚀
DATABASE_URL=... bunx prisma generate                      → exit 0
bun test src/services/__tests__/v5-wp20/schema-wp20.test.ts → 20 pass / 0 fail / 62 expect()
bunx tsc --noEmit（仅本 WP 四个文件，--ignoreConfig）        → exit 0
```

**DoD 覆盖矩阵（针对 WP20-2）**：第 7 条 ✅（含断言）；第 5/6 条不适用（WP20-3/20-5）；
第 10 条 ⏳（e2e 未跑，本会话禁跑容器）；第 4 条 ⏳ 属 WP20-3。

### 5.3 WP20-3 落地记录（2026-10-05，分支 `feature/v5-1b-udp-relay`）

**交付物**

| 文件 | 说明 |
|---|---|
| `backend/src/services/subscription-billing.ts` | 结算编排（占位 → 执行 → 终态 + 崩溃接管）+ 纯判别函数 + 生产依赖（懒加载 db） |
| `backend/src/worker.ts` | **增量**：`CRON_JOBS` **末尾**追加 `cron_settle_billing`（`45 * * * *`）、switch 追加一个 case、注释块加一行。既有 5 条 cron 的名称/顺序/节拍逐字未动（有断言） |
| `backend/prisma/schema.prisma` | `SystemConfigName` **尾部追加** `BILLING_SETTLEMENT_TAKEOVER_MINUTES` |
| `backend/prisma/migrations/20261032000000_v5_wp20_settlement_config/` | 一条 `MODIFY COLUMN config.name ENUM(...)`（追加值，零数据影响） |
| `backend/prisma/seed.ts` | 一行默认值 `"10"`。**越界说明**：`DEFAULT_CONFIG` 是 `Record<SystemConfigName, string>`，新增枚举值会**编译不过** ⇒ 这一行是编译强制，不是可选装饰 |
| `backend/src/services/billing-time.ts` | 追加 `billingPeriodKey` / `billingDayStart`（WP20-1 刻意延期的那个「账本唯一键口径」，见 §5.1） |
| `backend/src/services/__tests__/v5-wp20/subscription-billing.test.ts` | 24 条断言（含内存账本 fake：唯一键 + CAS 都是真约束，执行器每次执行真的动钱） |
| `billing-time.test.ts` / `schema-wp20.test.ts` | 扩展：周期键进三时区金样本；新增「ENUM 只在尾部追加」与「seed/schema 都登记」守卫 |

**冻结的语义与理由（都带反例）**

1. **幂等 = 先占位后执行，闸门是 DB 唯一键**（§3.1.4）。DoD 4 里「第二轮 `settled`/`skipped` 为 0」
   的正确读法：第二轮**连 `due` 都是 0**（到期查询会排除已有占位行的周期），`skipped` 只在**并发**
   下出现（两个 worker 同一拍，输的一方撞 `P2002` ⇒ 跳过且**不执行**）。所以测试里两条都断言：
   串行双跑（第二轮零动作、订单/余额零变化）与并发撞键（`skipped=1`、执行器零调用）。
2. **结算节奏 = 上海自然月**（`period_key = YYYY-MM`），**与 `Plan.billing_cycle` 无关**：
   `billing_cycle` 决定的是购买期限（落到 `started_at`/`expires_at`），结算账本记的是
   「每个周期只记账一次」的占位单位。反例：若按 `billing_cycle` 分档（年付 → `YYYY`），
   `period_key` 会超出 WP20-2 冻结的 `VARCHAR(16)` 值域（`YYYY` 也不是已冻结的两种形状之一），
   且续期的幂等闸门要等一整年才能复用；季度/半年同理。**日结**（`YYYY-MM-DD`）只为实现完备性
   保留，tick 默认月结。
3. **`taken_over` 与 `settled` 语义分离**：`settled` 数**结果**，`taken_over` 数**相位**。
   反例（本次修掉的真 bug）：把「接管后落 settled 的」才计入 `taken_over`，会让一条**每次都
   `deferred`** 的续期永远显示 `taken_over=0` —— 运维据此以为「没有行被卡住」，而它恰恰是唯一被卡住的那类行。
4. **执行器是注入的接缝，WP20-3 的生产执行器只记账**（不扣款、不写 `PlanOrder`/`BalanceLog`、
   不写 `WorkspacePolicyAssignment`，有静态守卫）：契约 §3.5.3「只记账、只降级，绝不默认扣款续期」
   + DoD 2「发放写入点恰好两个」（`assignDefaultPolicy` + WP20-4 的 `grantPolicyFromPurchase`）。
   `auto_renew = true` 的续期**留在 `pending`** 并记 `error="renewal_executor_not_wired"`、
   `attempts+1`，由接管重试直到 WP20-4 接线。两条反例：
   - 假装落 `settled` = 谎报「钱已经动过」；
   - 落 `failed` = **`failed` 不参与接管**（只有 `pending` 会被捞），等于把一条钱路径永久静默丢掉。
   今天没有任何路径会把 `auto_renew` 写成 true（默认 `false`，DoD 9 有全仓守卫），这条分支是接缝不是行为。
5. **接管超时**：`SystemConfig.BILLING_SETTLEMENT_TAKEOVER_MINUTES`，代码默认 10（与充值订单超时同口径）、
   夹取 `[1, 1440]` 分钟、缺省/非法回落且**可观测**（`takeover_config_missing`/`invalid` 进结果与日志）。
   O4 的已知代价照实接受：超时小于真实执行耗时会**重复执行**同一周期 ⇒ **执行器必须幂等可重放**
   （F8 条件扣款 + 发放 `upsert`）是 **WP20-4 的义务**，不是本模块能代偿的。本模块只保证
   「最多重复一次执行，绝不重复落终态」（占位唯一键 + `markSettled` 的 `where state="pending"` CAS）。
6. **过期订阅的收口谓词**：`listDuePeriods` 只取「本周期开始时仍有效」的订阅
   （`expires_at IS NULL OR expires_at > period_start`）。反例：不加这个谓词，一个 1 月就过期的订阅
   会在每个后续月份都产生一行「本周期已收口」的账本事实 —— 那是在记录一个**不存在的周期**。

**交棒给 WP20-4（本 WP 刻意不做，避免第二份真相/第三个写入点）**

- `executePeriod` 的生产接线：条件扣款（F8）→ 发 `PlanOrder`/`BalanceLog` → `grantPolicyFromPurchase`
  （`purchase` 发放的**唯一**写入点）+ `invalidatePolicyCache`。
- `Plan.policy_id`（套餐 → 策略的显式绑定，§3.5.3）。
- 到期通知仍不做（O6 裁决：本 WP 之后由 WP18 单独登记通知源）。

**证据**

```
bun test src/services/__tests__/v5-wp20/                        → 74 pass / 0 fail / 290 expect()
  · 三时区（UTC / Asia/Shanghai / America/Los_Angeles）三次输出剥离耗时后 byte-identical（含周期键金样本）
  · DoD 4：连跑两轮 → 第二轮 due/settled/skipped 全 0、订单与余额零变化；并发撞键 → skipped=1 且执行器零调用
  · DoD 5：11 分钟前的 pending → 接管并在下一轮恰好一次落 settled（orders/executions 不再增长）
bunx tsc --noEmit（backend/）                                    → exit 0（**全树干净**）
prisma validate / prisma generate                               → valid / exit 0
DATABASE_URL=... bunx prisma migrate diff --from-schema-datamodel <改动前> --to-schema-datamodel prisma/schema.prisma
                                                                → 唯一 DDL 就是那条 MODIFY（新值在尾部）
```

**DoD 覆盖矩阵（针对 WP20-3）**：第 1 条 ✅（静态守卫：无 `checkTunnelCreation`/`max_tunnels`/判定层 import）；
第 4 条 ✅；第 5 条 ✅；第 7 条 ✅（不新增枚举类型，只追加值）；第 9 条 ✅（全仓无 `auto_renew` 默认开启赋值 + schema 默认 `false`）；
第 8 条 ⏳ 属 WP20-6；第 2/6 条 ⏳ 属 WP20-4；第 10 条 ⏳（e2e 未跑，本会话禁跑容器）。

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

### 5.4 WP20-4 落地记录（2026-10-05，分支 `feature/v5-1b-udp-relay`）

**交付物**

| 文件 | 说明 |
|---|---|
| `backend/src/services/policy-service.ts` | **增量**：新增 `grantPolicyFromPurchase(tx, input)`（`purchase` 发放的**唯一**写入点，DoD 2 的第 2 处） |
| `backend/src/services/subscription-purchase.ts` | 新增：`nextSubscriptionTerm`（纯函数）+ `applyPlanPurchase`（**购买与续期共用的唯一落库实现**） |
| `backend/src/routes/plans.ts` | `POST /purchase`：事务内改调 `applyPlanPurchase`；订单带 `workspace_id`；提交后 `invalidatePolicyCache` |
| `backend/src/services/subscription-billing.ts` | 续期执行器 `renewSubscriptionPeriod`（`auto_renew=true` 的生产实现）；`auto_renew=false` 仍是「只记账」 |
| `backend/prisma/schema.prisma` | 增量：`Plan.policy_id`（可空）+ `CapabilityPolicy.plans` 反向关系 |
| `backend/prisma/migrations/20261036000000_v5_wp20_plan_policy_binding/` | 一条 `ADD COLUMN` + 一个外键（DDL 与 `prisma migrate diff` 逐字一致） |
| `backend/src/services/__tests__/v5-wp20/subscription-purchase.test.ts` / `subscription-renewal.test.ts` | 30 条断言（含 db 替身的钱路径） |

**冻结的语义与理由（都带反例）**

1. **`Plan.policy_id` 显式绑定，NULL = 不发放、也不拒绝购买**。反例：① NULL 就拒绝购买 → 存量商品
   当场不可售；② NULL 就挑一条模板发放 → 正是 §3.5.3 禁止的隐式推导（用户拿到没买过的策略）。
   NULL 时购买照常（扣款/订单/订阅），准入继续由既有 `system_default` 发放决定 = 今天的行为不变。
   治理副作用见「未决」：目前**没有管理入口**能写这一列。
2. **`grantPolicyFromPurchase` 的 `effective_at` 只前移不后移**：续期取 `min(原 effective_at, now)`。
   反例：若设成 `max(now, 旧到期)`，**提前续费**的用户会在付款瞬间从「已生效」变成「尚未生效」——
   付了钱却当场失去准入。
3. **换套餐 = 撤销旧套餐的 `purchase` 发放**（只撤 `purchase` 来源）。
   反例：不撤 → 两份套餐的发放按并集同时生效（F1 的并集语义），用户白拿两份权益。
   同套餐续期 = 延长 `expires_at`，`started_at` 保留（F10 的既有语义）。
4. **`UserPlan` 仍是 legacy 投影，但 `traffic_used` 从此一个字节都不写**：历史实现里「换套餐置 0」
   被**删除**（§3.3.2 / §4.0 冻结：它是派生/只读的，回写会产生第二份用量真相）。
   代价明确接受：dashboard 的已用流量在 WP20-6 切换读路径前会显示旧基线（不是新错误，是旧数字）。
   额度快照两列（`traffic`/`max_tunnels`）在**购买**时写、在**续期**时省略（同套餐额度不变）。
   这条省略也是 DoD 1 成立的前提：`subscription-billing.ts` 里因此**一个额度字段名都不出现**。
5. **续期执行器的幂等锚点 = 账本行上的 `order_id`**（`SELECT ... FOR UPDATE` → 已有 `order_id` 即短路）。
   反例（为什么光有唯一键占位不够）：接管机制**允许**同一周期被执行两次，只有占位键而无订单锚点时，
   接管那一次会**重复扣款**。WP20-3 里写的「执行器必须幂等可重放」在这一 WP 落地为可断言的形状：
   `order_id` 已存在 ⇒ 不扣款、不建单、只复用（有断言）。
6. **该做不了的事一律 `deferred`（留 `pending`）**：余额不足、团队 workspace 无钱包主体
   （`personal_user_id` 为 NULL，余额在 `User` 上、没有可扣主体）、商品下架/不可续费。
   反例：记 `failed` → `failed` 不参与接管，自动续费永远不再发生；假装 `settled` → 谎报钱已动。
   终身订阅（`expires_at = null`）与「用户在结算这一刻关掉 `auto_renew`」则按**只记账**收口，不扣款。
7. **`PlanOrder.workspace_id` 新行必填（应用层）**，历史行 NULL 不猜（R5）。续期产生的订单同样带上它。

**守卫的演化（不是放松，是更精确）**

- DoD 1：现在 `grep -rn "checkTunnelCreation\|max_tunnels" backend/src/services/payment backend/src/services/subscription-billing.ts`
  **字面为空** —— 连注释里都不许出现那些字段名（注释里出现它，就是下一个人伸手去用的地方）。
- DoD 2：`workspacePolicyAssignment.create|upsert` 全仓**恰好 2 处**，且断言它们分别落在
  `assignDefaultPolicy` 与 `grantPolicyFromPurchase` 两个函数里（按函数名断言，不按行号 —— 行号会腐烂）。
- WP20-3 那条「计费侧不写 `PlanOrder`/`BalanceLog`」的守卫升级为：**引擎本体（占位/接管/终态）一行都不碰钱**，
  订单与流水只允许出现在 `renewSubscriptionPeriod` 里，且必须与扣款/订阅/发放/锚点同在一个 `$transaction`。

**未决 / 交棒**

- **没有管理入口写 `Plan.policy_id`**（`routes/admin.ts` 的套餐 CRUD 不在本 WP 范围）⇒ 现存套餐全是 NULL，
  购买路径的发放分支目前**不会触发**（行为等同今天）。要真正启用，需要一次「套餐 ↔ 策略」绑定入口（独立小 WP）。
- **全树 `tsc` 有一处不属于本 WP 的红**：`prisma/seed.ts` 的 `DEFAULT_CONFIG` 缺
  `LATENCY_RAW_RETENTION_HOURS` / `LATENCY_BUCKET_RETENTION_DAYS`（WP19 的枚举值已在 `7895b40` 落地但没补 seed 键；
  它们的默认值在自己的 `services/latency-history.ts` 里是 24 / 30）。**不是我的文件，我没有代改**（猜产品默认值不对）。
- WP20-5（到期降级可观测）与 WP20-6（流量口径统一）分别见 §5.8 / §5.6；`DEVELOPMENT.md` §4 登记（DoD 11）不在本 WP 范围。

**证据**

```
bun test src/services/__tests__/v5-wp20/          → 104 pass / 0 fail / 387 expect()
  · 其中 subscription-renewal.test.ts（11 条，db 模块级替身）：幂等锚点短路 / 单事务钱路径 /
    余额不足·无钱包·不可续费 ⇒ deferred 且一分钱不动 / 终身与关闭续费 ⇒ 只记账
grep -rn "checkTunnelCreation\|max_tunnels" src/services/payment src/services/subscription-billing.ts → 0 命中（DoD 1）
grep -rn "workspacePolicyAssignment.create\|workspacePolicyAssignment.upsert" src/ → 恰好 2 处（DoD 2）
bunx tsc --noEmit（backend/）                        → 唯一错误是上面那条 seed.ts（非本 WP 文件）
prisma validate / migrate diff                       → valid / 迁移语句与生成的 DDL 逐字一致
```

**DoD 覆盖矩阵（针对 WP20-4）**：第 1 条 ✅；第 2 条 ✅（含函数级断言）；第 4/5 条 ✅（WP20-3 + 续期幂等锚点）；
第 9 条 ✅；第 6 条 ⏳ 属 WP20-5；第 8 条 ⏳ 属 WP20-6；第 10/11 条 ⏳（e2e 与 `DEVELOPMENT.md` 登记不在本 WP）。

---

### 5.5 WP20-4b 落地记录 —— 套餐 ↔ 策略绑定入口（2026-10-05）

> **为什么补一个 4b**：WP20-4 落了 `Plan.policy_id` 与购买时的发放分支，但**没有任何写入路径**能设它
> ⇒「套餐 → `purchase` 发放」在真实系统里**永远不会被触发**。本仓反复出现这一类缺陷
> （能力写好了、没有任何写入方：`preferred_node_id`、`diag` 都栽在这里），所以本 WP 的验收标准
> 由 Lead 明确为「**能真的绑上，并且绑上之后发放分支被触发**」，而不是「CRUD 返回 200」。

**交付物**

| 文件 | 说明 |
|---|---|
| `backend/src/services/plan-subscription.ts` | 新增：`parsePlanPolicyBinding`（纯）/ `resolvePlanPolicyBinding`（校验）/ `listBindablePolicies`（选项） |
| `backend/src/routes/admin-extended.ts` | 套餐 CRUD 的 POST/PATCH 解析 `body.policy_id`；新增只读 `GET /plan-policy-options`；套餐读投影 `include` 出 `policy` 摘要 |
| `backend/src/services/__tests__/v5-wp20/plan-policy-binding.test.ts` | 14 条断言，含**端到端那条**（D 组） |
| `web/src/lib/types.ts` / `web/src/lib/api.ts` / `web/src/components/admin/plans-manager.tsx` | 前端字段与选项加载（写路径的最后一环） |

**范围偏差（记录，不静默）**：Lead 授权写 `backend/src/routes/admin.ts`，但**套餐 CRUD 实际在
`routes/admin-extended.ts`**（`admin.ts` 只有 `/plan/stats`）。改的是真实位置。

**校验口径（与发放语义同一真相）**

1. **策略未启用 ⇒ 拒绝**。`capability-policy.ts#isAssignmentActive` 要求 `policy.status === "active"`：
   绑一条未启用的策略 = 用户付了钱、拿到一条**永远不生效**的发放（静默 no-op）。要卖它，先启用。
2. **`is_ceiling` 模板 ⇒ 拒绝**。它是「所有 workspace 的绝对上界，不直接发放」；允许绑定等于把一个商品
   卖成一份『上限』而不是一份『权益』。
3. **部分更新语义**：`undefined`（不带字段）= 不改动；`null`/`""` = **显式解绑**（绑错要能退回来）；
   正整数/数字字符串 = 绑定；其它（0/负数/小数/非数字）⇒ 400 fail-closed。
4. **UI 与校验同口径**：`GET /plan-policy-options` 只列「可绑」集合，与 `resolvePlanPolicyBinding`
   的接受集合**逐项等价**（有断言：列出的必被接受、没列出的一定被拒）。否则就会出现
   「UI 能选、保存 400」这种最招人烦的形态。

**前端两处实现细节（都有反例）**

- 「不绑定」的 Select 值是哨兵 `"none"` 而**不是空串**：Radix 的 `<Select.Item value="">` 会直接抛错。
  到 payload 才映射成 `null`（且**显式发送** null —— 省略等于「不改动」，语义完全不同）。
- 编辑一个「绑了已停用策略」的套餐时，该策略不在可绑集合里；表单把它**补进选项**并标注不可绑，
  否则 Select 显示为空、管理员一保存就把绑定悄悄清掉。

**验收证据（本 WP 的核心）**

```
bun test src/services/__tests__/v5-wp20/plan-policy-binding.test.ts → 14 pass / 0 fail / 44 expect()
  D 组「能真的绑上，且绑上之后发放分支被触发」：
    ① 管理端提交 policy_id → resolvePlanPolicyBinding 给出 bind（policy_id 一路贯通）
    ② 未绑定套餐 → 同一段 applyPlanPurchase 返回 granted=false / plan_policy_unbound
    ③ 绑定套餐 → 真实 applyPlanPurchase 走完，purchase 发放的 policy_id=8、
       且 expires_at 与订阅到期点**同源**
  E 组静态守卫：POST 与 PATCH 各一次解析 `body.policy_id`；选项端点存在；前端确实发出 `policy_id`
```

**DoD 影响**：不新增 DoD 条目；它补的是「G7.2 / DoD 6 的到期语义在真实系统里可发生」的前提 ——
在此之前，即使 WP20-4 全绿，生产里也不会有任何一条 `purchase` 发放被创建。

**未决**：批量导入 / CLI 绑定入口（复用同一 `resolvePlanPolicyBinding` 即可，无需新语义）；
策略被停用后**已绑定**的套餐会静默失去发放（这是「停用策略」的既有语义，不是本 WP 引入的），
运营侧需要一条「哪些套餐绑了停用策略」的巡检 —— 可作为 `attention` 的后续条目。

---

### 5.6 WP20-6 落地记录 —— 流量口径统一（2026-10-05）

**交付物**

| 文件 | 说明 |
|---|---|
| `backend/src/services/billing-time.ts` | 追加 `billingDayKeyStamp`（当日标签的 UTC 午夜戳 = `tunnel_traffic.date` 的存储口径） |
| `backend/src/services/capability-policy.ts` | `trafficWindowStart` 委托 `billing-time`（**DoD 8**：该文件里不再有 `setHours(0, 0, 0, 0)`） |
| `backend/src/services/policy-service.ts` | `trafficStart` 同样委托；新增 `sumFederatedUnattributedTraffic`；用量报告补 `traffic_used_unattributed_federated` |
| `backend/src/services/traffic.ts` | `dayKeyOf`/`fillDays` 与趋势窗口下界收敛到 `billing-time`；用量汇总带出联邦缺口 |
| `backend/src/routes/dashboard.ts` | 日首/月首收敛；`dayKeys` 改为复用 `fillDays`；**已用流量改读窗口求和**（并让上限同源） |
| `backend/src/routes/tunnels.ts` | 单隧道图表窗口与补键改为 `billingDayKeyStamp` + `fillDays`（同一实现） |
| `backend/src/services/__tests__/v5-wp20/traffic-window-convergence.test.ts` | 新增 13 条断言（跨模块逐字相等 + DoD 8 守卫 + 缺口语义） |

**冻结的语义与理由（都带反例）**

1. **三处口径收敛为一处**（§3.1.3）：① 窗口起点（`capability-policy#trafficWindowStart` 与
   `policy-service#trafficStart`）→ `billingDayStart`/`billingMonthStart`；② 图表日键
   （`dayKeyOf`/`fillDays`，dashboard 与 tunnels 共用**同一实现**）；③ 归档戳
   `billingDayKeyStamp` 与写入端 `traffic-archive#trafficDate` **逐字相等**（有断言）。
   反例（②的旧实现）：`setHours(0,0,0,0)` 后再 `toISOString().slice(0,10)`，UTC+8 下本地午夜
   落在**前一天 16:00Z** ⇒ 键整体回退一天，图表永远匹配不上库里的行。
2. **存储戳仍然是 UTC 午夜，不改成上海午夜**。反例：改口径要求全表回填 + 保留期同步改，
   否则同一列里会同时存在两种日界 —— 那是账本一致性问题，不是显示问题。保留期因此**不动**
   （它本来就按 UTC 取整，与存储戳同口径）。
3. **`traffic_used` 读路径切换**（§3.3.2）：dashboard `/stats` 改读
   `sumWorkspaceTraffic(workspace, 生效策略的 traffic_period)`，不再读 `UserPlan.traffic_used`
   —— 后者是冻结的 legacy 列，且购买路径已不再写它（WP20-4），读它只会拿到过期基线。
   **上限也一并换成策略**（`policyView.limits.traffic_limit`）：不然会出现「用量按策略窗口、
   上限按旧列」的错配，两个数字不可比 —— 那是修好一个显示、造出另一个。策略读不到时回落 legacy 列。
4. **联邦缺口是独立字段，不并进任何用量**（§3.3.5 / O5）：
   `traffic_used_unattributed_federated` = 按 `tunnel_id` 关联到本 workspace 隧道的
   `federation_usage_record` 字节和。反例：并进 `traffic_used` 就是把两本账合一，引入
   「谁权威」的模糊（§10）。`tunnel_id IS NULL` 的行**无法归因到某个租户**（联邦侧收不到归属），
   属于平台级桶，不会出现在任何 workspace 的报告里 —— 这条决定了门禁夹具要造 > 0 的观测值，
   必须把 usage 行归因到该 workspace 的 tunnel。
   实现用原生 SQL（`JOIN tunnel`）而不是 Prisma relation filter：那张表**没有外键**（联邦统一取向）；
   `bytes_*` 是 `BigInt`，转 `number` 的精度边界（≈9 PB）已注明。
5. **缺口落在已挂载的端点上**：`GET /api/workspaces/:id/traffic`（`getWorkspaceTrafficSummary`）
   带上该字段，读失败时给 `null` 而不是 0（「读不到」与「真的是 0」必须区分，否则缺口重新变不可见）。

**两处既有测试的改动（都写明了为什么）**

- `src/__tests__/traffic-pipeline.test.ts` 的 `fillDays / dayKeyOf` 三条：它们用
  `new Date(2026, 8, 24, 15, 0)`（本地分量构造）+ 本地分量期望 —— 那是把「跟随进程 TZ」当成了契约。
  在 `TZ=UTC` 下 `new Date(2026,8,24,23,59)` 其实是上海 09-25 07:59，旧期望 09-24 才是错的。
  已改为**显式 UTC 瞬时点 + 上海标签**断言（三个时区下都过），并保留一条「不跟随进程 TZ」的守卫。
- `src/routes/__tests__/workspace-rbac-v4.test.ts` 的替身补了两个出口（`fillDays`、
  `sumFederatedUnattributedTraffic`、`getEffectivePolicy`）：该文件整体在 `String.raw` 模板串里，
  注释**不能出现反引号**（会终止模板串），已在文件里注明。这两处都属于「替身必须语义完整」那条
  既有结论（见 `src/__tests__/lifecycle-db-stub.ts` 顶部）。

**未决（交棒）**

1. **`GET /api/me/capabilities` 不存在**，而 §3.3.2 让前端改读它。现实里唯一挂载的用量面是
   `GET /api/workspaces/:id/traffic`（已带上缺口字段）。`getWorkspaceUsageReport` 目前
   **零调用者**（死代码）—— 要么补那个端点，要么删掉它，属于产品/API 决策，不在本 WP 擅自决定。
2. **≤10 分钟计量滞后的产品文案**（§3.3.4 末句）未做：WP20-6 的交付物清单里没有「文案」一项，
   且措辞是产品决策。建议独立小 WP（或并入前端线的文案改动）。
3. `UserPlan` 的 `traffic_limit`/`max_tunnels`/`plan_name` 仍由 dashboard 从 legacy 读出（本 WP 只换了
   用量与上限的流量口径）——「展示基线全量切换」属 WP20-5/后续。

**证据**

```
bun test src/services/__tests__/v5-wp20/                                    → 131 pass / 0 fail / 521 expect()
bun test src/__tests__/traffic-pipeline.test.ts                             → 38 pass（TZ=UTC 与默认 TZ 各跑一次，均 0 fail）
for tz in Asia/Shanghai UTC America/Los_Angeles; do TZ=$tz bun test …; done  → 三时区均 0 fail
grep -rn "setHours(0, 0, 0, 0)" src/services/policy-service.ts src/services/capability-policy.ts → 0 命中（DoD 8）
bunx tsc --noEmit（backend/）                                                → 本 WP 文件 0 报错
```

**DoD 覆盖矩阵（针对 WP20-6）**：**第 8 条 ✅（含断言）**；第 3 条 ✅（WP20-1 的三时区金样本仍全绿）；
第 1/2/4/5/7/9 条不回归（全绿）；第 6 条 ⏳ 属 WP20-5；第 10 条 ⏳（e2e 未跑）；第 11 条 ⏳（登记不在本 WP）。

---

### 5.7 WP20-6b 落地记录 —— 补 `GET /api/me/capabilities`（给死代码一个调用者）

> **为什么补**：§3.3.2 指定「前端展示已用流量改读 `GET /api/me/capabilities`」，
> 而那个端点在代码里**从来不存在**；它背后的 `policy-service#getWorkspaceUsageReport` 是
> **零调用者的死代码**。死代码只有两种解法：删掉，或给它一个调用者。契约已经写死了读路径的名字，
> 所以按 **Lead 裁决**选后者（删掉会让 §3.3.2 失去落点）。

**交付物**：`backend/src/routes/me.ts`（新）+ `backend/src/app.ts`（挂载 `/api/me`，一行）
+ `backend/src/routes/__tests__/me-capabilities-route.test.ts`（子进程隔离的 HTTP 契约）。

**冻结的语义**

1. **口径与 dashboard 同源**：同一个 `resolveWorkspaceMembership`（`x-workspace-id` 头优先、缺省个人空间），
   同一次请求里只取一个 `now` 并透传（否则跨月那一秒的月首会被算两遍，读路径与判定层可能差一个月）。
   返回的就是 `getWorkspaceUsageReport`：`traffic_used` = **窗口求和**（生效策略的 `traffic_period`），
   `traffic_used_unattributed_federated` = 联邦缺口，`limits`/`policy` = 生效策略。
2. **权限面 = 该工作空间的成员**（解析函数自己拒非成员）。**不叠加** `forward:read` 之类的资源权限：
   本端点返回的是「租户自己的额度与用量」，成员本就可见；dashboard 的可见性开关管的是**资源明细**，
   不是额度。反例：若这里要求 `forward:read`，一个只有节点权限的管理员就看不到自家额度，
   而额度判定恰恰会拒绝他的建隧道请求 —— 那才是真正需要解释的 403。
3. **端点必须真的可达**：本仓已有机械守卫 `route-mount-coverage.test.ts`（凡 `*Routes` 导出都必须在
   `app.ts` 被引用），本 WP 另外把**具体前缀**钉住（`app.route("/api/me", meRoutes)`）并断言
   报告函数**有生产调用点** —— 这正是「模块存在、路由没挂」那族缺陷的正面守卫。
4. **前端不必切换**：dashboard 的 `/stats` 在 WP20-6 里已经改成窗口求和（同一口径），
   所以前端即使仍读 `/api/dashboard/stats` 也不会拿到错数；`/api/me/capabilities` 供需要
   **完整能力视图**（policy/limits/联邦缺口）的调用方。两者由同一函数供数，不会各算一套。

**未决**：无（死代码缺口已消掉）。`≤10 分钟计量滞后`的产品文案仍在待办（§3.3.4，措辞属产品决策）。

**证据**

```
bun test src/routes/__tests__/me-capabilities-route.test.ts → 2 pass（401 不触碰服务层 / 200 且口径来自生效策略
   period=month、traffic_used=窗口求和值、缺字段在 / 传下去的 workspace id = 解析结果 / now 是 Date）
bun test src/routes/__tests__/route-mount-coverage.test.ts  → 3 pass（机械守卫：router 都已挂载）
bun test src/services/__tests__/v5-wp20/ + 上述两个文件     → 136 pass / 0 fail / 530 expect()
```

**DoD 覆盖矩阵（针对 WP20-6b）**：不新增 DoD 条目；它消掉的是 §3.3.2 的「读路径指向不存在的端点」缺口。

---

### 5.8 WP20-5 落地记录 —— 到期降级与可观测（2026-10-05）

**交付物**

| 文件 | 说明 |
|---|---|
| `backend/src/services/policy-service.ts` | 新增纯函数 `buildUsageExpiryView(policy)` + `UsageExpiryView`；用量报告带上 `expiry` |
| `backend/src/routes/dashboard.ts` | `/stats` 带上同一个 `expiry`（两条读路径同一个实现） |
| `backend/src/services/__tests__/v5-wp20/policy-expiry-degrade.test.ts` | 新增 17 条断言（**DoD 第 6 条**的完整证明） |
| `web/src/components/dashboard/plan-expiry-notice.tsx` + `dashboard-body.tsx` + `lib/types.ts` | 用户可见的到期/宽限提示（渲染后端文案） |
| `web/src/components/dashboard/__tests__/plan-expiry-notice.test.tsx` | 5 条渲染断言 |

**冻结的语义**

1. **没有新状态机、没有翻转任务**（§3.2.1）：三种用户可见状态全部由 `expires_at` 上的时间比较得出，
   代码侧一行都没加 —— 本 WP 只**证明**它并按需**投影**它。守卫：`*Status` 枚举集合仍逐字等于
   `Status`/`TopupOrderStatus`/`WithdrawStatus`/`TicketStatus`；`policy-service.ts` 里不出现
   `status: "expired"` 或 `AssignmentStatus`。
2. **DoD 6 的完整证明**（顺序即用户经历）：
   - **宽限内**：只有 `purchase` 且刚过期 ⇒ `grace_policies=["pro_monthly"]`、`deny_reason="policy_expired"`、
     `deny_scope=false`，且**额度不缩水**（10 条 / tcp+udp 全在）；
   - **自动降级**：`purchase` 过期而 `system_default` 有效 ⇒ 权限收窄到剩下的那份
     （max_tunnels 10→1、traffic_limit 100000→1000、协议 2→1），`deny_reason=null`；
     并断言**单调收窄**（额度只可能变小或持平）；
   - **fail-closed**：越过宽限且无有效发放 ⇒ `deny_scope=true` + `no_active_policy`；
     边界两侧各 1ms 都有断言；显式撤销（`revoked_at`）**不吃宽限**（F3）。
3. **`buildUsageExpiryView` 是投影，不是第二真相**：所有值现算自 `EffectivePolicy`，不落库、不参与判定。
   四条语义各有反例测试：
   - `policy_expires_at` 取**最早**到期点（取最晚会把「最早消失的那条」藏起来，用户看到还有余额却突然被拒）；
   - 全部终身 ⇒ `null`（不是「很远的一天」）；
   - `in_grace` = 一条有效发放都没有、但仍有宽限内的已到期发放（此时**仍放行**）；
   - `deny_message` = `describeDeny(deny_reason)` 的原文 —— **拒绝文案的唯一实现**，前端渲染它，
     不在前端抄中文（测试断言组件源码里不含那句中文，防止「后端改词、前端永远显示旧那句」）。
4. **一处用测试发现、而不是用测试固化的语义**：宽限期内 `active_policies` **不是空的** ——
   它的语义是「**当前有效**的发放集合」，宽限中的已到期行也在其中（这正是宽限内仍放行的实现方式），
   `grace_policies` 只是给它们打标记。我起初断言为空，跑出真值后改成断言真值并写进这里
   （「用测试固化自己的猜测」比「没测」更坏）。

**守卫新纪律（采纳 Lead 的判据）**：前端那条「文案唯一实现」的守卫**先剥注释再匹配**。
门禁若把注释也算进去，就会惩罚写解释性注释的人 —— 而注释恰恰是最有价值的文档。
（反例语境：我这次第一版守卫就被自己文档注释里的「已到期」三个字命中。）

**未决**
- `≤10 分钟计量滞后`的产品文案仍是待办（措辞属产品决策，与 §5.6 的同一项）。
- `dashboard.stats.expired_at` 保留为 legacy 兼容值（新前端优先读 `expiry`）；两者对个人购买路径是同步的
  （WP20-4 双写），但真相是订阅/发放，不是这一列。
- `dashboard.stats.max_tunnels`/`plan_name` 仍读 legacy（额度展示的其余部分属后续）。

**证据**

```
bun test src/services/__tests__/v5-wp20/            → 148 pass / 0 fail / 582 expect()（其中 expiry 组 17 条）
bun test web/src/components/dashboard/__tests__/plan-expiry-notice.test.tsx → 5 pass
bunx tsc --noEmit（backend/ 与 web/）                → 本 WP 文件 0 报错
```

**DoD 覆盖矩阵（针对 WP20-5）**：**第 6 条 ✅**（宽限 / 降级 / fail-closed / 边界 / 撤销）；
第 7 条 ✅ 不回归（枚举集合逐字不变）；第 1/2/4/5/8/9 条不回归；第 10 条 ⏳（e2e 未跑）；
第 11 条 ⏳（`DEVELOPMENT.md` 登记不在本 WP）。

---

### 5.9 额度语义修正：生效周期 = 声明的最长周期（Lead 2026-10-05 裁决 (a)）

> **一句话语义（本节是额度周期的唯一一句话）**：
> **生效周期 = 适用策略中声明的「最长」周期；只有当某条策略真的声明 `total` 时才是 `total`。**

**缺陷（由 V5-G7 门禁抓到，既有、非 WP20 引入）**
`composeEffectivePolicy` 的累计初值是 `UNLIMITED_LIMITS`（`traffic_period: "total"`），而
`unionLimits` 对周期取「更宽松（更长窗口）」。数值上限的初值 `null`（不限）确实是 `maxNullable`
的中性元 ✓，但**周期用 `total` 是恒胜元** ✗ ⇒ 无论策略声明什么周期，结果都停在 `total`。
纯函数一行复现：单条 `traffic_period:"month"` 策略 ⇒ `limits.traffic_period === "total"`。
后果：① `sumWorkspaceTraffic` 按**全量累计**求和 ⇒ **月额度永不复位**（用户累计超过一个月额度后被持续拒绝）；
② 面板的 `traffic_used` 显示「全量已用」而不是「本月已用」（WP20-6 的读路径同源是对的，
**同源的那个周期本身是错的**）。

**为什么算缺陷而不是语义**：`unionLimits` 自己的注释写的是「取更宽松（更长窗口）的一方」，
`intersectCeiling` 里也早就把 `total` 当「无约束」（`ceiling.traffic_period === "total" ? grant.traffic_period : …`）。
修法**恢复的是这两处已经声明的意图**，不是重新设计语义，也不改 V4 冻结基线。

**条件一（先查是否已有测试在守护这个 bug）—— 结论：没有**
证据：`grep -rn "traffic_period" src/ --include=*.test.ts | grep -E "toBe\(|toEqual\("`
全仓只命中 `src/routes/__tests__/me-capabilities-route.test.ts`，而那是**替身 fixture 的返回值**
（不经过 `composeEffectivePolicy`）。因此本次**没有删除或改写任何既有断言**，
也就不存在「原断言守护的是缺陷行为」需要记录的情形（与 `traffic-pipeline.test.ts` 那次不同）。

**修法**：累计从**第一条策略**起折（`null` 累加器），不再依赖「初值必须刚好是中性元」。
同一次提交里补了两层断言：
- 纯函数（`traffic-window-convergence.test.ts` 的 C2 组 6 条）：单条 month ⇒ month；单条 day ⇒ day；
  month + day ⇒ month；**month + total ⇒ total**；ceiling 的 total 表示「无约束」不得拉宽；
  数值上限不受影响；以及「下月窗口起点 > 上月归档戳」的复位证明。
- 门禁（`v5-g7.py`）：**G7.9e** 单条 month ⇒ `month`；**G7.9f** month+total 并存 ⇒ `total`；
  **G7.9g** 跨月复位（10 月读数 222 / 11 月读数 777，互不串月）。

**修好后 ⑤ 的收口口径**：至此「**月额度会复位**」才可以算进本期承诺（Lead 明示）。

**顺带发现的第二条缺陷（cache 与时间无关），已单独报 Lead，尚未裁决**
`getEffectivePolicy` 的缓存条目**与调用方传入的 `now` 无关**：有效性判定是
`调用方 now − 计算时 now < TTL`，而且 **`noCache: true` 只跳过读、仍然写缓存**
（`if (!opts.client) cache.set(...)`）。本门禁自己踩到它：G7.6b 用**未来时间**（`NOW+10d`）
验证 fail-closed 之后，缓存里被放进「未来那一刻」的策略（`deny_scope` ⇒ `limits = UNLIMITED_LIMITS`
⇒ `period = total`），于是后面**展示路径**读到的是它。
生产里 `now ≈ Date.now()`，症状轻得多；但形状是真的：任何用合成时间的调用方（回填、门禁、将来的
`TUNNEL_BILLING_NOW` 类开关）都会污染展示路径。门禁侧已用 `invalidatePolicyCache` 显式规避并注明原因；
**修不修、怎么修（`noCache` 是否应同时不写、TTL 是否应按墙钟计）请 Lead 裁决**，本节只留痕。

**V5-G7 门禁**（§7.1）：33 断言全绿（含 G7.7/G7.8 的「不覆盖 + 理由」），证据
`docs/evidence/v5-g7-result-20261005.txt`。门禁抓到的两条夹具陷阱（合成 `now` vs 真实墙钟的
`effective_at`；窗口上界开放 ⇒ 未来行会被算进当前月）都写进了脚本注释 —— 它们属于
「**断言因为错误的理由走向另一个分支**」那一族。

---

## 7. Gate 映射（`scripts/v3-e2e/`）与时间夹具

### 7.1 新增 Gate `v5-g7.py`（Billing Runtime Gate）

> **编号裁决（Lead 2026-10-05 拍板）：本门禁的文件名是 `v5-g7.py`、断言编号是 `G7.x`。**
> 本节标题与下文表格里遗留的 `v5-g6.py` / `G6.x` 字样一律按此替换。
> 冲突事实：`scripts/v3-e2e/v5-g6.py` 已被 **WP17.5 的 DDNS 前门门禁**占用
> （其 docstring 第一行即「V5-G6 gate — DDNS 前门」），且那个门禁已在真拓扑上跑过并产出证据、
> **不可改名**（改名会让既有证据指不到文件）。因此 `G6.1..G6.10` 这些编号**不能照抄落地**。
> 本 WP（WP20）**没有改任何门禁**（不改他人文件名、不改已冻结的断言编号）。

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

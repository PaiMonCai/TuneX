# V5-WP18 — 公告系统 / 通用通知渠道契约（PROPOSED → 评审后 FROZEN）

> **状态：DRAFT-PROPOSED（2026-10-05）**，分支 `feature/v5-1b-udp-relay`。
> 本文是「公告 + 通知渠道」的唯一语义来源。**尚未冻结**：§4 的 F1–F10 是建议冻结项，
> §5 的 O1–O7 明确**不猜**（列候选与代价，交 Lead 拍板）。Lead 逐条确认后把本段改为
> `FROZEN`，并把本 WP 登记进 `DEVELOPMENT.md` 路线图表（**登记是 Lead 的动作，本文不改该文件**）。
>
> 本文**不含任何实现**：不写代码、不改 schema、不改任何既有文件，唯一产物是语义。每条结论要么指向仓库事实
> （`文件` + 符号名），要么指向已冻结的 V5 不变量；仓库事实无法唯一回答的一律进 §5，**不在正文里发明事实**。
> 引用一律用符号名不用行号（`backend/**`、`web/src/**` 正在被并行编辑，行号会漂移）。

## 0. 一句话定位

~~~text
公告（Announcement） = 平台/租户写给「人」的内容，有生命周期与已读状态
通知（Notification） = 既有事实链上的一次派生 + 一次投递，本身**没有**事实权威
~~~

两者共用「渠道」这一层，但**共用的是投递能力，不是真相**：公告的内容真相在公告表，
通知的真相在它派生的那张既有表（`node.status` / `tunnel.apply_status` / `audit_event` / …）。
这条界线是本文全部冻结项的地基。

---

## 1. 仓库现状事实（逐条给证据）

### 1.1 出站通道：只有一个，且只服务事务邮件

| 事实 | 证据（文件 + 符号） |
|---|---|
| 唯一出站通道是 SMTP，手写最小客户端（零运行时依赖：hono/prisma/ioredis/zod/bcryptjs/jose）；投递失败**永不抛出**，收敛成 `{sent:false, reason}`；未配置 SMTP 时降级打日志 | `backend/src/services/mail.ts`：`SmtpClient`、`sendMail()`、`isMailConfigured()`、`MailResult`（`reason: "smtp_not_configured" \| "smtp_error"`） |
| 邮件是**纯文本**（无 HTML 多部分）、无模板引擎 | `mail.ts` `SmtpClient.send()`：`Content-Type: text/plain`、headers 手工拼接 |
| 已有防注入先例 + 测试注入口（生产路径不调用） | `mail.ts`：正文 `replace(/\r?\n/g,"\r\n").replace(/^\./gm,"..")`；`To:`/`Subject:` 各自 `replace(/[\r\n]/g,"")`；`setMailTransportForTest()` |
| 有界退避先例 | `backend/src/services/mail-tokens.ts`：`DEADLOCK_MAX_ATTEMPTS = 3`、`DEADLOCK_BACKOFF_BASE_MS = 50`、`BASE * 3^N + 抖动` |

**没有**的东西（grep 验证）：全仓不存在 webhook 通道、不存在 Telegram bot、不存在通知队列。
`backend/src` 与 `web/src` 内 `webhook` 零命中。

### 1.2 配置与「公告」的现有落点：一个明文 KV 表

| 事实 | 证据 |
|---|---|
| 面板级 KV 表是 `config`，值**明文** `String`，名字是 **DB enum**（34 项固定） | `backend/prisma/schema.prisma`：`model SystemConfig`（`name SystemConfigName` + `value String @db.Text` + `@@map("config")`）、`enum SystemConfigName` |
| 里面**已经有**三个「公告」键与六个 SMTP 凭据键 | 同上：`NOTICE`、`NOTICE_POPUP`、`NOTICE_POPUP_INTERVAL_HOURS`；`SMTP_HOST/PORT/SECURE/USER/PASS/FROM` |
| 读写服务（5s 短缓存，写入清缓存）；写入路径不校验值、按名字 upsert | `backend/src/services/config.ts`：`SystemConfigService.getConfig/setConfig/listAll`、`systemConfig` 单例；`routes/admin.ts`：`PUT /system/config/:name`、`GET /system/config` |
| 公网免认证下发面 | `backend/src/routes/public.ts`：`GET /settings` 白名单含上述三个 NOTICE 键 |

**关键事实（沉睡的半成品）**：`NOTICE*` 三键在 `web/src` **没有任何消费者**——
`grep -rn "api/public\|NOTICE\|SITE_NAME" web/src` 只命中 `components/admin/settings-manager.tsx`
（管理端编辑器，按 `name.startsWith("NOTICE")` 归到「公告」分组）、`web/src/mocks/*` 与 i18n 文案。
即：**今天面板能写公告、API 能读公告，但没有任何地方渲染它。**

### 1.3 已存在、可作为通知触发源的持久事实链

| # | 事实 | 证据（符号） | 落库 |
|---|---|---|---|
| A | 节点连接态的唯一判定 | `services/node-lifecycle.ts`：`deriveConnection()`（`waiting/online/offline`）、`nodeAdmission()`；注释「连接是事实、生命周期是期望」 | 由 `node.status` + `last_seen_at` + 凭据列投影 |
| B | 节点离线的状态翻转 | `socket/offline-detector.ts`：`DISCONNECT_DEBOUNCE_MS = 60_000`、`DISCONNECT_MARKER_TTL_S`、`runOfflineCheck()`；驱动者 `backend/src/worker.ts` 的 `cron_check_node_offline`（`everyMs: 10_000`）；翻转 `updateMany(where status="active")` 幂等 | ✅ `node.status = inactive` |
| C | 「需要处理」的聚合口径 + 节点健康码表（都复用既有词表、都只派生读） | `services/attention.ts`：`collectAttention()`、`AttentionReasonCode`、`ATTENTION_MAX_ITEMS = 25`、`AttentionPayload.degraded`；`services/node-health.ts`：`HealthReasonCode`（16 码 / 四态 `NODE_HEALTHS`）；HTTP 面 `routes/dashboard.ts` `GET /attention` | 派生读 |
| E | **Forward 下发被拒**（最硬的一条）+ 拒绝码词表 | `services/runtime-reconcile-sink.ts`：`createTunnelLedger().markBlocked()` 写 `apply_status="error"` + `apply_error_code=denied.reason` + `apply_error="[layer] msg"`；`markApplied()` 清错误并写 `applied_revision`/`last_applied_at`（幂等闸门 `OR[null, lt]`）；码表 `services/runtime-admission.ts` 的 `RuntimeAdmissionDenied`（`reason`/`error_layer`/`layer`/`body.code`）、`RuntimeAdmissionReason = ManifestRejectionReason` | ✅ `tunnel.apply_*` |
| G | **只打日志**的两类事实：对账 findings、联邦每拍汇总 | `services/reconciler.ts` findings（`code`/`severity`/`tunnel_id`/`node_id`/`detail`），`worker.ts` 只对 `severity==="error"` 或 `code==="resend_skipped"` 逐条打印；`services/federation/lease.ts` `runFederationReconcile()`（`expired/tore_down/teardown_failed/ports_released/grants_expired/revoked_cleaned/...`）只在「有事」时打印 | ❌ 仅日志 |
| H | 租约到期/交接 | `services/placement-lease.ts`：`LEASE_TTL_SECONDS = 90`、`isLeaseExpired()`、`claimLease()`（`not_expired` 是**正确拒绝**）；`schema.prisma`：`PlacementLease.lease_expires_at`、`NodePortLease.expires_at` | ✅ DB |
| J | 联邦动作的审计事实 | `services/federation/audit.ts`：同时写 `audit_log`（`action: "FEDERATION <action>"`）与 `audit_event`（`action: "federation.<action>"`，带 `workspace_id`）；动作名 `grant.create/expire/revoke`、`trust.handshake/revoke/revoked_by_peer`、`usage.unattributed` | ✅ DB |
| K | 租户业务事件流（**唯一**能可靠按租户过滤的表） | `schema.prisma`：`model AuditEvent`（`workspace_id` 必填 + `action` + `resource_type/id` + `detail`）；写入点 `routes/workspaces.ts`（`workspace.created`/`member.invited/joined/removed`）、`routes/node-groups.ts`、`services/workspace-role-management.ts` 的 `audit()`；过滤依据见 `services/workspace-audit.ts` 注释（「`audit_log` 没有 `workspace_id` 列，跨租户投影会漏数据或错数据」） | ✅ DB |
| L | 平台审计（无租户维度） | `schema.prisma`：`model AuditLog`；`services/audit.ts`：`buildAuditEntry()`/`writeAudit()`（**永不抛出**）/`SENSITIVE_RE`（敏感路径丢 metadata）；读取面 `routes/admin-extended.ts` `GET /audit-logs`（注释明示：未登记前缀 → 非超管 403） | ✅ DB |

### 1.4 运维侧：**面板之外**已经有一套通知通道

`scripts/ops/alert.sh` 有 webhook 通道（钉钉/企微/Slack 兼容 JSON，`ALERT_WEBHOOK` + `send_alert()` 的 `curl`）、
有去重（`ALERT_DEDUPE_SECONDS` 默认 3600 + `var/alerts/state.json`）、有本地审计轨迹（`alerts.log` 始终写、
退出码 `0/1/2`），检查项覆盖 `DISK`/`MEM`/`SWAP`/`MYSQL_*`/`REDIS_*`/`CONTAINER`/`CERT`/`BACKUP`。
`scripts/ops/backup.sh` 失败也走 webhook（`notify_failure()`）；`scripts/ops/capacity.sh` 头注释明确「只做测算与建议，
不发告警」。→ **容量 / 备份 / 证书 / 容器类告警今天完全在面板外**；面板内没有这些事实源，写进通知契约就得先造真相（禁止）。

### 1.5 密钥、SSRF、权限、净化的现状

| 主题 | 现状 | 证据 |
|---|---|---|
| 可逆密钥存储 | **只有一个先例**：联邦 Ed25519 私钥 AES-256-GCM 密文落地，密钥 HKDF(AUTH_SECRET) 派生；per-install Fernet key 已在 WP15 删除；**其它凭据一律只存哈希** | `services/federation/seal.ts`：`deriveSealKey()`/`sealSecret()`/`unsealSecret()`/`FEDERATION_SEAL_INFO`；`schema.prisma`：`FederationSetting.private_key_enc`、`node_credential`/`user.api_key_hash`/`email_verification.token_hash` 注释；`crypto/keys.ts` 头注释；`services/user-keys.ts`：`hashKey()` |
| 明文令牌纪律 | 「明文只出现一次」 | `routes/settings.ts`：`regenerateApiKey()`/`regenerateSubscriptionKey()`（`rotateKey` 后只在本响应体返回一次）+ 同文件 `publicUser()` 剥离所有哈希列 |
| SSRF | **没有可复用的 URL/IP 守卫**；仅有两处「产品边界说明」注释 | `services/forward-probe-plan.ts`、`services/agent-diagnose.ts` 头注释（都是「别把客户机房当内网扫描器」）；`routes/forwards.ts` 的关键词命中亦为注释 |
| 权限（平台 / 租户） | 平台：`super_admin` 直通，否则按 `admin_roles` + 前缀表判定，**未登记前缀 = 403**；租户：固定四角色 + 自定义角色白名单（11 键），fail-closed | `permissions.ts`：`ADMIN_RESOURCES`（含 `key: "audit"`）、`STAFF_SHARED_KEY`、`SUPER_ADMIN_KEY`、`buildAdminRouteTable()`、`resolveAdminRoute()`；`middlewares/auth.ts`：`adminRequired`/`adminPermissionGuard`/`superAdminRequired`；`services/workspace-permissions.ts`：`WORKSPACE_PERMISSIONS`、`sanitizeCustomPermissions()`、`customRoleGrants()` |
| HTML 净化 | **仓库里完全没有**：无 sanitizer、无 `dangerouslySetInnerHTML` | `grep -rni "sanitizeHtml\|dompurify\|dangerouslySetInnerHTML" backend/src web/src` → 空 |
| Telegram | 只有一个**沉睡字段** `User.tg_id`：可读写、**无任何消费方** | `schema.prisma`：`User.tg_id String?`；`routes/settings.ts` `PATCH /profile`；`routes/admin-extended.ts`；`web/src/components/settings/settings-body.tsx` |
| 队列/定时 | BullMQ + 4 个**真实** cron；商业化 cron 已删除 | `worker.ts`：`CRON_JOBS`（`cron_save_traffic`/`cron_delete_tunnel_traffic`/`cron_check_node_offline`/`cron_reconcile_v3`）+ 头注释明确 `cron_notify_plan_expire`、`cron_renew_user_plan` 已移除且**无实现** |
| 限流 / Redis 键纪律 / 真相一致性先例 | 限流是纯函数判定 + Redis 计数；所有 Redis 键必须走工厂；门禁已断言「attention 与 lifecycle 真相一致」 | `middlewares/rate-limit.ts`：`GLOBAL_RATE_LIMIT_RULES`、`evaluate()`；`tenant-scope.ts`：`scopedKey()`/`GLOBAL_SCOPE`；`redis.ts`：`RedisKeys` 全量键表；`scripts/v3-e2e/v4-gate-f3.py` 的 F3.17（改 `lifecycle=maintenance` 后查 `/api/dashboard/attention`） |

---

## 2. Forwardx 先例与取舍（只参考语义，不复制代码）

### 2.1 公告：`server/routers/announcements.ts` + `drizzle/schema.ts`

- **模型**：`announcements{title, content, type(normal|popup|upgrade_popup), targetVersion, isActive, startsAt, expiresAt, createdByUserId, ...}` + `announcement_reads{announcementId, userId, dismissedAt}`。
  已读 = **每用户一条 dismiss 记录**（不是全量已读清单）；`startsAt`/`expiresAt` 在代码里**恒被写成 `null`**（`createAnnouncement`/`updateAnnouncement` 硬编码）——定时发布是空壳。
- **权限**：`list`/`popup`/`dismiss` = `protectedProcedure`；`create`/`update`/`delete` = `adminProcedure`。
- **版本绑定**：只有 `upgrade_popup` 需要 `targetVersion`，**强制 semver**（`resolveUpgradeAnnouncementVersion()` 的 `/^\d+\.\d+\.\d+$/`），查询侧与 `APP_VERSION` 比较，且只对 `role === "admin"` 可见。→ **TuneX 无法照搬**：TuneX 用 git sha 打 tag，`env.ts` 的 `agentLatestVersion` 注释明确「仓库里没有任何权威的『当前 Agent 版本』常量」，没有可比矩阵。
- **唯一活跃弹窗**：`announcementRepository.ts` 的 `deactivateOtherPopups()`/`deactivateOtherUpgradePopups()` 靠「先关旧的再插新的」，**没有 DB 唯一约束**，并发下会留下两个活跃弹窗。
- **净化与推送**：内容在**写入时**服务端 `sanitizeHtml()`；`telegramPush` 可选布尔，`pushAnnouncementToTelegram()` 逐用户串行发送，失败只 `console.warn`，返回 `{requested, sent, failed, total}`——**无重试、无幂等键、无投递账本**。

### 2.2 `shared/htmlSanitizer.ts`：手写正则 allowlist

30 个白名单标签、5 个属性（`class/href/rel/target/title`）、`on*` 一律丢弃、`href` 只允许 `http/https/mailto/tel///#`、
`<a>` 自动补 `target="_blank"` + `rel="noopener noreferrer"`；先整体正则删 `script/style/iframe/svg/math/...` 再逐标签重建。
**取舍：不照搬。** 正则解析 HTML 有已知失效面（mXSS / 畸形标签），而 TuneX 现状是**零净化器 + 零 HTML 渲染**：
引入自研净化器等于把风险从 0 抬到「未知但非 0」，引入 DOMPurify 又违反 `mail.ts` 头注释写明的零依赖取向。→ 见 F6。

### 2.3 `server/hostOfflineNotificationDebouncer.ts`：它到底解决什么

解决的是**通知洪泛与闪断误报**，不是状态判定：(1) 主机短暂失联又立刻恢复，不该先发「离线」再发「上线」；
(2) 定时器必须挂在**最新状态**上——每次 `schedule()` 递增 `generation`、`cancel()` 上一个定时器，
到点再 `isCurrent()` 二次确认，保证「迟到的定时器不为已被推翻的状态发消息」；
(3) `cancel(hostId)` 在恢复事件里被调用，注释明确**快速存活状态仍然立即翻转**，只有通知被压。

**与 TuneX 的差异（关键）**：TuneX 已有 60s **状态翻转**防抖（`offline-detector.ts` 的 `DISCONNECT_DEBOUNCE_MS`），
「再来一个 30s 定时器去复制状态」就是**第二套判定**（禁止）。TuneX 需要的是事件确定**之后**的**事件级静默期
（cooldown）**：同一 `(租户, 来源, 资源, 原因码)` 一段时间内只投递一次。→ F4。

### 2.4 / 2.5 两个对照：去重形态要借鉴，内存账本要避免

`server/forwardRuleErrorNotifier.ts` 的 `shouldNotifyForwardRuleError(ruleId, message)` 用
key = `${ruleId}:${sha256(message)}` 做冷却（`RULE_ERROR_NOTIFY_COOLDOWN_MS = 5min`、上限 `10_000`、定期 `prune`）：
「资源 + 原因指纹」的**形态可借鉴**，但**进程内 `Map` 不可照搬**——TuneX 的 api 与 worker 是**两个进程**，
进程内 Map 会让同一事件投递两次且重启即失忆（→ F4 要求落 Redis 且走 `scopedKey()`）。
反面教材是 `server/hostStatusNotifier.ts`：它用 `lastKnownStatus: Map<hostId, "online"|"offline">` 维护「谁在线」的
**内存账本**（`notifyHostStatusChange` 用 `previous === status` 去重），启动时 `primeHostStatusNotifier()`「静默播种」——
这正是本 WP 禁止的模式。TuneX 必须相反：「变化」由**既有表上的状态列/时间戳**回答，不缓存「上次是什么」。

### 2.6 其余先例的可吸收点

- **可吸收**：`server/smtpTransport.ts` 的安全模式解析（`auto/implicit-tls/starttls/none` + 465/587 纠正）、
  **逐项超时**（DNS 8s / 连接 10s / greeting 10s / socket 20s / operation 25s）、`smtpErrorMessage()` 把底层错误
  归类成用户可读文案；`server/telegramApiTimeout.ts` 的 `withTelegramApiTimeout()`（AbortController + 分方法 15s/40s）；
  `server/logFileStore.ts` 的有界缓冲（`MAX_PENDING_APPEND_ENTRIES`/`MAX_PENDING_APPEND_BYTES`）+ 丢弃计数；
  `shared/customSidebarPages.ts` 的 URL 归一化与 `visibility: all|admin` 两种可见性形态。
- **不吸收**：`server/telegramBot.ts` 的 token 落 **settings KV 明文**（`getTelegramSettings()`；`getTokenKey()`
  只取长度+前后 8 位做日志脱敏）与投递**无重试/无退避/无 429 处理/无幂等键/无持久队列**（`sendTelegramMessage`
  → `telegramApi` → 单次 `fetch`，失败只 `console.warn` + 计数器）；`shared/personalization.ts` 不是通知偏好
  （它是主题/壁纸），且 Forwardx **没有统一偏好模型**（开关散落在各 feature 的 settings 键 + 业务表列，
  如规则上的 `telegramErrorNotifyEnabled`）——这个散乱是反面教材；文件日志存储、自定义侧边栏本次不需要。

---

## 3. 三条硬约束（契约层写死）

- **C1**：通知必须由既有状态机 / 对账事件**派生**；不得新增「谁在线 / 谁健康 / 谁已下发」的真相。
- **C2**：只有一份真相——公告真相在公告表，通知真相在来源表；投递记录只描述「尝试投递」。
- **C3**：fail-closed——未知来源、未知渠道类型、解不开的密文、无法验证的目标地址**一律拒绝**，不得降级成「当作没有」或「当作成功」。

同源依据：`attention.ts` 头注释（不在前端复抄判定）、`node-health.ts` 的码表复用、
`federation/seal.ts` 头注释（「解封失败一律抛错，不得用『解不开就当空』的方式降级」）、
`schema.prisma` 里 `CapabilityPolicy` 的「空白名单 = 无访问」。

---

## 4. 冻结决策（建议冻结：结论 / 依据 / 影响面 / 明确不做）

### F1 通知是派生物，且必须带来源

- **结论**：通知层只消费固定的 `NotificationFact`：
  `{ scope(workspace_id | global), source_kind(封闭枚举), source_id, reason_code(既有词表), severity(info|warning|error), resource_type, resource_id, occurred_at, dedupe_key }`。
  派生是**纯读**：只查既有表 + 调用既有判定函数。
- **依据**：`attention.ts` 已证明路线可行（「判定全部复用既有实现」，连 reason_code 都取既有词表）。
- **影响面**：新增一个只读派生服务 + 一个类型；**不修改** `deriveConnection`/`nodeHealth`/`attention` 的任何判定。
- **明确不做**：不在通知层写「多久算离线/不健康」；不做 `isNodeOnline()` 之类第二判定；
  不为「发通知」而写回 `node.status`/`tunnel.apply_status`。

### F2 触发源是**封闭白名单**（本期 6 类，逐条有既存持久事实）

| ID | 触发源 | 派生依据 | 备注 |
|---|---|---|---|
| N1 | 节点离线 / 恢复 | `node.status` 翻转 + `deriveConnection()` | 恢复通知**只在存在前一次离线事实时**发；维护中掉线**不是**故障（`attention.ts` 的 `NODE_MANAGED_REJECTIONS` 同一取向） |
| N2 | Forward 下发被拒 | `tunnel.apply_status="error"` + `apply_error_code`（`markBlocked`） | 恢复信号 = `markApplied` 清错误、`applied_revision` 前进 |
| N3 | 对账需要人处理 | `reconciler.ts` findings（`severity === "error"`） | 今天只打日志；若要通知**必须**先把 finding 落成持久行（否则是「日志当真相」）→ O2 |
| N4 | 租户业务事件 | `audit_event` 既有 action 词表（`workspace.created`/`member.*`/角色与节点组变更） | 只挑**人需要知道**的子集，不把审计流整体镜像成通知流 |
| N5 | 联邦到期/撤销/停服 | `runFederationReconcile()` 汇总 + `federation.*` 审计行 | 汇总今天只在「有事」时打印；单事件有审计行可派生 |
| N6 | 公告发布 | 公告表自身 | 公告是内容不是告警，投递走同一渠道层 |

- **明确不列入**：容量/备份/证书/容器（面板内**无事实源**，见 §1.4）；套餐/许可到期（**无事实源**：
  `worker.ts` 注释已删 `cron_notify_plan_expire`；`license.ts` 的 `expired_at` 是 env 快照、实例级、非租户级）→ O1。

### F3 渠道抽象：一个接口、三个实现，**投递记录是唯一的投递真相**

~~~text
NotificationChannel = { id: "email"|"webhook"|"telegram"; isConfigured(scope); validateConfig(input);
                       send(rendered, target) -> ChannelResult }   // 未配置 = 不可用，不得假装成功
ChannelResult ≈ { sent: boolean; reason?: "not_configured" | "transport_error" | "rejected_target" | ... }
~~~

- **结论**：`ChannelResult` 沿用 `mail.ts` 的 `{sent, reason}` 语义（不引入新的三态）；邮件渠道就是 `sendMail()` 本身（不重写）；各渠道**不做**自己的账本，只有一张投递表。
- **依据**：`MailResult` 是仓库里唯一被接受的出站结果形态；`audit.ts`/`mail.ts` 共同确立「旁路永不抛出」。
- **明确不做**：不做渠道插件注册表；不做「扇出 N 渠道后聚合出一个成功」的模糊判定（每渠道各自一条投递记录）。

### F4 投递语义：至少一次 + 幂等键 + 有界退避 + 静默期（**不是**第二次防抖）

1. **语义 = 至少一次**，不承诺 exactly-once；
2. **幂等键** `dedupe_key = hash(scope, source_kind, source_id, reason_code, window_start)`，投递表**唯一索引兜底**；
3. **有界重试**：最多 3 次，退避 `BASE * 3^N + 抖动`（沿用 `mail-tokens.ts` 形态）；**不做无限重试**；
4. **静默期**：同一 `(scope, source_kind, source_id, reason_code)` 在 `NOTIFICATION_COOLDOWN_SECONDS` 内只投递一次；
   **不同 reason_code 各有一条配额**（「离线」与「恢复」互不吞掉——Forwardx 恢复时 cancel 掉离线待发通知是它的取舍，**不照搬**：用户需要知道「它离线过，现在回来了」）；
5. **静默期落 Redis** 且经 `tenant-scope.ts` 的 `scopedKey()`（新增 `RedisKeys.notificationCooldown`）；**禁止进程内 Map**（api 与 worker 是两个进程）；
6. **失败可见性**：每次投递留一行记录（目标/渠道/结果/错误摘要），失败**不阻断**主业务；投递记录**不是事实**，删掉它不影响任何判定。

- **依据**：`forwardRuleErrorNotifier.ts` 的幂等键形态；`mail-tokens.ts` 的退避参数；`redis.ts` 的 `RedisKeys` 命名纪律；`audit.ts` 的「写失败只打日志」。
- **明确不做**：不做 exactly-once；不做跨渠道事务；不做投递重放接口；**不把静默期做成第二个 `hostOfflineNotificationDebouncer`**。

### F5 渠道配置与密钥：新表 + 密文列，**不进** `SystemConfig`、**不进** env

- **结论**：新增 `notification_channel`（additive、无 DB enum）：
  `{ id, scope_kind("platform"|"workspace"), workspace_id(platform 为 NULL), kind("email"|"webhook"|"telegram"), target, secret_enc, enabled, created_by_id, created_at, updated_at }`；
  `secret_enc` = AES-256-GCM 密文（`v1.<iv>.<ct>.<tag>` 单行）。
- **密钥派生**：复用 `federation/seal.ts` 的**原语**，但**新增独立 HKDF info**（`NOTIFICATION_SEAL_INFO = "tunex-notification-v1"`），**绝不**与联邦共用派生密钥。
- **解封失败**：fail-closed 抛错，**不得**「解不开就当空/当未配置」。
- **依据**：`seal.ts` 头注释（Fernet 已删，这是唯一现成的可逆封装；「换个用途就换 info」是它自己写的纪律）；`FederationSetting.private_key_enc` 先例；`SystemConfig.value` **明文**，放 token 等于把凭据写进一个「可能被非超管读到、且无轮换语义」的表。
- **明确不做**：token 不进 `audit_log.metadata`（`SENSITIVE_RE` 已确立「敏感路径丢 metadata」）；不在响应体回显 token；不塞 env（env 是**不可变部署面**：改 token 要改 compose + 重启，且无法按租户隔离）。

### F6 公告：一行 + 一份已读记录；**替换**而不是并存遗留 `NOTICE`

1. 新增 `announcement`：`{ id, scope_kind("platform"|"workspace"), workspace_id?, type("normal"|"popup"), title, body, published_at, created_by_id, created_at, updated_at, revoked_at? }`
   + `announcement_dismissal{ announcement_id, user_id, dismissed_at }`（`@@unique([announcement_id, user_id])`）。
2. **多租户归属**：`scope_kind="platform"` ⟹ `workspace_id` **必须为 NULL**（用结构约束表达，不用「约定」）；
   租户侧读取 = platform ∪ 本 workspace，**其它 workspace 的行永不返回**。与既有分野一致：`AuditEvent` 有 `workspace_id`（能可靠按租户过滤），`AuditLog` 没有（平台侧查询）。
3. **类型只保留 `normal` / `popup`**（`upgrade_popup` 不移植，理由见下）；同 `scope` 下 `type="popup"` 只允许**一条活跃**——**用 DB 唯一约束表达**（Forwardx 无约束，并发会留下两条）。
5. **已读**：`announcement_dismissal`；**免打扰是「每用户 × 每渠道 × 每类别」三元映射**，只影响**推送**，不影响站内公告的存在与已读。
6. **内容净化 = 不做 HTML**：正文是纯文本 / 受限 Markdown 子集；前端**不得** `dangerouslySetInnerHTML`
   （今天全仓零命中，这是可 grep 的 DoD）。渠道渲染按各渠道规则转义：Telegram（`parse_mode=HTML`）必须 `escapeHtml`；邮件沿用 `mail.ts` 的 CRLF 剥离与 `^\.` 转义。
7. **遗留 `NOTICE` 的处置**：`NOTICE`/`NOTICE_POPUP`/`NOTICE_POPUP_INTERVAL_HOURS` 标 deprecated，
   **只读迁移**（把非空 `NOTICE` 值转成一条 `type="normal"` 公告），`/api/public/settings` 不再把这三键当公告来源；
   **不删 enum 值**（§3.4 取向：DB enum 增删值都会让旧二进制读到未知值时失败）。

- **依据**：`enum SystemConfigName` 已有三个 NOTICE 键 + `routes/public.ts` 已下发 + `web/src` **零消费者**（沉睡半成品，不处置就是「两份公告真相」）；`CapabilityPolicy` 注释（同样「用结构表达边界」）；`mail.ts` 的注入防护先例。
- **明确不做**：不做富文本编辑器；不做 HTML 白名单净化器（引入第三库违反零依赖，自研正则净化器是可预见 XSS 面）；不做公告审批流；不做按租户公告模板。
- **升级弹窗不移植的理由**：Forwardx 的 `resolveUpgradeAnnouncementVersion()` 强制 semver 并与 `APP_VERSION` 比较；
  TuneX 用 git sha 打 tag，`env.ts` 的 `agentLatestVersion` 注释明确「仓库里没有任何权威的『当前 Agent 版本』常量」——
  硬造版本矩阵**就是发明事实**。→ O3。

### F7 权限：映射到既有 RBAC，不新造角色

| 动作 | 谁能做 | 接线方式 |
|---|---|---|
| 发布/撤回**平台**公告 | `super_admin`，或 `ADMIN_ROUTE_TABLE` 中登记的新前缀 | 在 `permissions.ts` 的 `ADMIN_RESOURCES` 新增条目（如 `announcements`）挂 `/admin/announcements`；**不登记 = 只有超管**（既有 fail-closed 行为） |
| 配置/停用**渠道** | 同上（建议独立 key，不复用 `settings`） | 理由：面向全体租户的对外内容与出站凭据，与站点设置风险面不同 |
| 查看**投递日志** | 平台侧 `super_admin`（与 `GET /admin/audit-logs` 同口径） | 不登记前缀 → 非超管 403；**租户侧不可见** |
| 发布/撤回**租户**公告 | 复用 `settings:manage`（读用 `settings:read`） | `WORKSPACE_PERMISSIONS` 既有键，**不新增** |

- **依据**：`adminRequired`/`adminPermissionGuard` 与 `permissions.ts` 前缀表已确立「未登记 = 拒绝」；`admin-extended.ts` 的 `GET /audit-logs` 注释把口径写明。
- **明确不做**：不新增租户权限键（改白名单要同步 UI + 测试，且本期「租户公告」用途未证明）；不做按租户分配渠道；
  不做投递日志的租户侧页面（会泄露其它租户的渠道拓扑与失败模式）。

### F8 「通知不是第二份真相」怎么写死（三条 + 可断言）

~~~text
A. 通知模块对既有表**只读**；禁止新增任何「在线/健康/已下发」列。
B. 每条通知必须携带 source_kind（封闭枚举）+ source_id（既有表主键）；
   DoD 断言：不存在 source_id 指向不存在行的通知行。
C. 状态判定必须调用既有函数（deriveConnection / nodeAdmission / isLeaseExpired / isRetryable）；
   DoD 断言：通知模块内不得出现新的大于 1 秒的「时长常量」（在线窗口/离线阈值）。
~~~

- **加强断言**：沿用 `v4-gate-f3.py` F3.17 的做法——把节点置 `lifecycle=maintenance` 后，
  「attention 的 reason_code」与「通知派生的 reason_code」必须**完全一致**。
- **明确不做**：通知状态不得作为任何其它模块的输入（通知不能反向驱动 reconcile / failover）。

### F9 出站请求的 SSRF 边界（webhook，本期最小可用边界，全部 fail-closed）

1. 目标必须 `https://`；`http://` 仅在 `NODE_ENV !== "production"` **且**显式开启时允许；
2. 投递前解析域名，**校验解析结果的 IP 不属于** loopback / private / link-local / multicast / 唯一本地地址
   （`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`、`fe80::/10`）；
3. **禁止重定向**：3xx 一律拒绝（跟随重定向会绕过首次校验）；
4. **DNS rebinding**：解析一次并连接到该解析结果（Host 头保留域名），或校验后二次解析比对；校验失败 → 留一条投递记录（`reason: "rejected_target"`），**不重试**。

- **依据**：仓库**没有**可复用的 URL/IP 守卫（`forward-probe-plan.ts`/`agent-diagnose.ts` 只有产品边界注释），
  必须显式冻结，否则 webhook 会把面板变成出站跳板。
- **影响面**：新增一个纯函数校验器 + 反例测试；不改动既有 probe/diagnose 语义。
- **明确不做**：不做用户自定义 URL 模板；不做 webhook 签名（本期是主动出站）；不把「完整 SSRF 硬化」塞进本 WP（→ O4）。

### F10 邮件模板注入

- **结论**：继续**不用**模板引擎（`mail.ts` 是纯文本拼接）；插值只允许白名单字段（节点/转发名、
  reason_code 文案、时间），插值前剥 CRLF、按长度截断（沿用 `audit.ts` 的 `MAX_*` 截断取向）；
  `To:`/`Subject:` 继续走 `replace(/[\r\n]/g,"")`；`Content-Type` 保持 `text/plain`（**不做 HTML 邮件**）。
- **依据**：`mail.ts` 已有 CRLF 剥离与点转义；`audit.ts` 已有统一截断纪律。
- **明确不做**：不引入模板引擎；不做 HTML 邮件（HTML 邮件 = 又一处需要净化的地方）。

---

## 5. 开放决策（**不猜**：候选 + 代价）

> ### 5.0 Lead 裁决（2026-10-05）：O1–O4 **已冻结**
>
> **O2 静默期取值与 Redis 不可用时的 fail 方向。** 取值集中在一处常量表（照
> `target-health-thresholds.ts` 的纪律：每一项注明它保护什么）：节点离线/恢复 **5 分钟**、
> 下发被拒 **15 分钟**、其余 **30 分钟**。**Redis 不可用时仍然发送**，去重降级为进程内并
> 在投递记录里标 `degraded`。理由：静默期是**抑制**机制——抑制机制失效时应当**多报**，
> 漏报（真实故障没人知道）比重复报危险得多。
>
> **O3 升级弹窗 —— 本期不做。** TuneX 用 git sha、没有 semver 矩阵，`agentLatestVersion`
> 并非权威版本常量；Forwardx 的 semver 比较无法移植。强行做出来只能是一个会误导用户的
> 弹窗。等有了权威版本源再单独立项。
>
> **O4 SSRF 硬化深度 —— 本期按 F9 的最小边界，不另开 WP。** 附加一条新约束：
> **webhook 渠道的部署级开关默认关闭**（与 Looking Glass 同取向：新增的出站通道默认关，
> 要开必须显式打开）。
>
> **O1 套餐/许可到期作为通知源 —— 今天不造。** 现状确实**没有事实源**，造它就等于新造
> 状态，与 C1"通知是派生物"直接冲突。**但这条会在 WP20-4 落地后自然打开**：届时"付费
> 发放 / 到期降级"成为真实事实，它才可以被登记进触发源白名单——**届时单独登记，不在本期**。
> 这也是 WP18 与 WP20 两份契约必须保持一致的地方。

**O1 — 套餐/许可到期要不要成为通知源？** 现状**没有事实源**：`worker.ts` 注释已删 `cron_notify_plan_expire`/`cron_renew_user_plan`；
`license.ts` 的 `expired_at` 来自 `env.licenseExpiredAt`（实例级快照）。候选：(a) 本期不做；(b) 新建到期扫描
（**等于新造事实源**，必须先冻结「到期」的权威判定在哪张表、归属哪个租户）；(c) 只留在面板外 `alert.sh`。
代价：(b) 会把本 WP 从「派生」变成「造状态」，与 C1 冲突，需要单独的语义契约。

**O2 — 静默期数值，以及「Redis 不可用时往哪边 fail」。** 候选 30min / 6h / 24h per `(source, reason)`。
代价：太短会被 flap 刷屏；太长会错过**第二次真实故障**。另一个必须拍板的点：**Redis 不可用时「不发」还是「全发」**——
fail-closed 的字面含义是「不发」，但那会让 Redis 抖动变成通知静默丢失（建议：不发 + 记一条失败投递行）。

**O3 — 升级公告的版本绑定（TuneX 无语义化版本矩阵）。** 候选：(a) 本期**不做**升级弹窗（推荐）；
(b) 引入 `TUNEX_BUILD_SHA` 之类部署期常量，公告绑定 sha 白名单——代价：新增 env、同一 sha 的多次构建无法区分、用户看不懂 sha；
(c) 复用已有 `env.agentLatestVersion` 做**站点级单条**「建议升级」提示（没有矩阵，只有一条）。

**O4 — SSRF 硬化的深度。** 候选：(a) 本期按 F9 最小边界；(b) 独立 WP 做「出站 HTTP 客户端 + 允许列表 + 连接级 IP 校验」，
并回头复用给 `forward-probe-plan.ts`/`agent-diagnose.ts` 的既有担心。

**O5 / O7 — 两个次要开放项。** O5 投递记录的保留期与清理：候选 30 / 90 天 + 独立清理 cron（形态可对齐
`services/traffic-retention.ts` 的「按保留期删除、幂等、配置缺失回落默认」），数值不猜。O7 公告定时发布
（`startsAt`/`expiresAt`，Forwardx 有列但**恒为 null**）：候选 (a) 本期不实现；(b) 实现发布窗口 = 新增 worker
定时任务 + 时区语义 + 「窗口外不可见」的读侧判定。

**O6 — 是否允许租户自带渠道（BYO webhook / Telegram bot）。** 候选：(a) 本期**只允许平台级渠道**（冻结方向）；
(b) 允许，但必须先回答「租户 token 的存储、轮换、吊销、滥用检测」（面板可能被当跳板）。


---

## 6. WP 拆分（建议）

| WP | 内容 | 依赖 |
|---|---|---|
| WP18.0 | 本文（契约）+ Lead 拍板 §5 | — |
| WP18.1 | 通知派生的**纯函数**核心（`NotificationFact`）+ 单测（只读消费既有词表） | 18.0 |
| WP18.2 | 投递账本（表 + 唯一索引）+ 静默期（Redis `scopedKey`）+ `NotificationChannel` 接口 + **email 复用 `sendMail`** | 18.1 |
| WP18.3 | Webhook 渠道 + F9 校验 + 反例测试（private IP / 重定向 / 非 https） | 18.2 |
| WP18.4 | Telegram 渠道 + token 密文存储（新 HKDF info）+ `tg_id` 绑定语义（未绑定 = 不投递，**不猜用户**） | 18.2 |
| WP18.5 | 公告：表 + API + 已读 + 免打扰 + `NOTICE` 只读迁移 + 前端最小展示（纯文本渲染） | 18.0 |
| WP18.6 | 权限接线：`ADMIN_RESOURCES` 登记新前缀 + 租户侧复用 `settings:*` | 18.2 / 18.5 |
| WP18.7 | Gate / 契约测试收口（§8）：DoD 2/3/4/5/6/9 落 `backend/tests/*.mjs` | 全部 |

**排序纪律**：18.1 先于 18.2（先证明「派生可行」再谈投递）；18.5 与 18.3/18.4 无依赖，可并行；18.4 必须先冻结
`tg_id` 绑定语义（未绑定 chat 的用户本期冻结为**不发**，禁止把用户 id 猜成 chat id）；18.7 只收口不新增能力。

---

## 7. DoD（可断言检查）

1. **派生纯函数（`bun test src`）**：给定固定 attention items / `apply_status="error"` 行，输出 `NotificationFact` 集合**逐字段确定**（同一输入两次派生一致，含 `dedupe_key` 稳定性）。
2. **幂等**：同一事实并发派生 N 次 → 投递表**只有 1 行**（唯一索引兜底；`backend/tests/*.mjs`，`TUNEX_DB_TEST=1`）。
3. **静默期**：静默期内二次派生不新增投递行；过后新增一条（注入时钟，不依赖 wall clock）。
4. **fail-closed 反例**：未知 `source_kind`、缺 `source_id`、未知 `channel.kind`、密文解封失败 → 一律**拒绝**并留失败记录。
5. **SSRF 反例**：`http://`（生产）、`localhost`、`127.0.0.1`、`10.0.0.1`、`169.254.169.254`、`[::1]`、3xx 重定向 → 全部 `rejected_target` 且**零出站请求**（注入 fetch 断言未被调用）。
6. **公告跨租户**：A 的用户读不到 B 的公告；platform 公告对两者可见；`scope_kind="platform"` 且 `workspace_id != NULL` 的行**写不进去**。
7. **公告无 HTML 渲染**：`grep -rn "dangerouslySetInnerHTML" web/src` 零命中（保持今天的状态）。
8. **NOTICE 迁移**：empty DB 与 existing V4 DB 都能 apply；非空 `NOTICE` → 一条 `type="normal"` 公告；枚举值**一个都没删**。
9. **权限**：非超管访问未登记的 `/api/admin/announcements*` → 403；超管正常；租户侧缺 `settings:manage` 发布 → 403。
10. **不新增第二判定 / 回归**：通知模块文件内不出现新的大于 1 秒的时长常量（在线窗口、离线阈值必须复用
    `node-lifecycle.ts`）；V4-G0 / V4-G4 / V5-G0 仍全绿；`tunnel.apply_status` / `node.status` 写入路径 diff 为 0。

---

## 8. Gate 映射（`scripts/v3-e2e/`）

| 既有 Gate | 与本 WP 的关系 | 需要什么 |
|---|---|---|
| `v5-g0.py`（Contract Compatibility Gate，20 项） | **不改**：本 WP 不碰 desired / revision / Agent 协议 | 只作**回归**跑一次；G0 的语义是「没破坏 V4 承诺」，本 WP 的失败面不在 control plane |
| `v4-gate-f3.py`（产品闭环，含 F3.17 attention 真相一致） | **直接复用其构造方式** | 新增一条断言：节点置 `maintenance` 后「`/api/dashboard/attention` 的 reason_code」与「通知派生的 reason_code」一致（F8 的可执行形式） |
| `v5-g4.py` 等 HTTP 契约门禁 | 新 admin 前缀未登记会 403 | **不改脚本**：`adminPermissionGuard` 的 fail-closed 已隐式覆盖；但 WP18.6 的测试要显式断言「登记生效」 |
| 新增 `v5-g6.py`（建议） | 若要把 DoD 2/3/5/6 上抬到真实拓扑 | 四条断言：(1) 幂等键并发只落一行；(2) SSRF 反例全拒且零出站；(3) 公告跨租户不可见；(4) attention ↔ 通知 reason_code 一致 |

**「是否需要 Gate」的判断**：本 WP 不引入新的**控制面**失败面（无 desired 改动、无 Agent 协议、无 revision/ACK
语义变化），按 `DEVELOPMENT.md` §3.6「涉及真实 runtime 的 WP 还必须进 Integration Gate」的口径，推荐把
DoD 2/3/4/5/6/9 落在 `backend/tests/*.mjs`（HTTP/DB 契约测试），只把回归项交给既有 Gate。**若 Lead 认为「出站投递」
本身需要真实网络验证**，则把 DoD 5（SSRF 反例）与 DoD 2（并发幂等）上抬进新的 `v5-g6.py`。

---

## 9. 明确不做（本期）

1. **不照搬 Forwardx 三件事**：① 不用 shell-out 多引擎当主数据面（TuneX 真相在 DB + control protocol）；
   ② 不做「容忍型自动动作默认打开」（沿用 `FAILOVER_POLICY` fail-closed：策略没配过就不许自动搬流量）；③ 不做「面板下发整份配置」。
2. 不新增「谁在线/谁健康/谁已下发」的第二份真相（C1）。
3. 不做富文本公告、不做 HTML 净化器、不引入第三方净化库、不做 HTML 邮件、不引入任何新运行时依赖（无 nodemailer / telegraf / DOMPurify / 模板引擎）。
4. 不做 Telegram **入站** bot（长轮询 / 接收 webhook / 命令菜单）——本期只有**出站**投递。
5. 不做通知中心前端（多渠道偏好矩阵 UI / 投递日志租户页）；不做租户自带渠道、公告审批流、定时发布（O6/O7 未拍板前一律不做）。
6. 不做「通知即动作」：通知**不得**触发 failover / 迁移 / 重启（`DEVELOPMENT.md`：failover 必须是显式 policy）。
7. 不改 V4 冻结基线：不动 `deriveConnection`/`nodeAdmission`/`node-health.ts` 判定、不动 `markBlocked`/`markApplied` 写入语义、不动 SMTP env 语义。
8. 不删 `SystemConfigName` 任何枚举值（含 `NOTICE*`）。

---

## 10. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 静默期数值选错 → 刷屏或漏报 | 数值集中**一处**导出常量 + 可注入时钟 + DoD 3；数值本身进 O2 |
| R2 | 幂等键把「两次真实故障」折叠成一次；通知失败被误当「事实缺失」 | `dedupe_key` **必须**含 `reason_code` + 时间窗（不得只含 `source_id`）；投递记录与事实分离（C2） |
| R3 | `NOTICE` 迁移后双份展示 | 迁移与前端切换**同一次发布**；`routes/public.ts` 同步停止把 `NOTICE*` 当公告来源；DoD 8 |
| R4 | webhook 成为出站跳板 | F9 + DoD 5（零出站断言）；残余风险：DNS rebinding 实现细节需代码评审 |
| R5 | 复用 `seal.ts` 时密钥域混淆（通知密钥 == 联邦密钥）；渠道配置表成为新的「明文凭据表」 | 独立 HKDF info + 单测断言「同一 AUTH_SECRET 派生的两把密钥不同」；`secret_enc` 强制密文列 + DoD 4 覆盖解封失败 + 禁止回显 |
| R6 | Redis 不可用 → 静默期失效 | 见 O2：建议「不发 + 记失败投递行」；**必须 Lead 拍板**，否则会出现「Redis 抖动导致通知风暴」 |
| R7 | 公告跨租户泄露；api 与 worker 两进程同时派生 → 竞态重复投递 | `scope_kind` + `workspace_id NULL` 结构约束 + 查询强制条件 + DoD 6；唯一索引兜底 + Redis SETNX 先例（`traffic-archive` 的「SETNX 占位锁 + 唯一索引 + 读走即删」三层防线，见 `worker.ts` 注释） |

---

## 11. 需要 Lead 拍板的取舍（≤3 条）与交付物

1. **O2**：静默期默认值与「Redis 不可用时发 / 不发」（影响 R6）。
2. **O3**：升级弹窗是否**本期彻底不做**（TuneX 无 semver 矩阵，本文倾向不做）。
3. **O4**：SSRF 硬化是**本期最小边界**还是**独立 WP**。

> 交付物：契约即本文。`DEVELOPMENT.md` 的 WP18 路线图登记是 **Lead 的动作**（本文不改该文件）；后续实现落点见 §6。本文不含任何代码、schema 或既有文件改动。

---

## 12. 交付记录

> 本节的纪律：**实现的每一处"契约没写清楚"的判断都写在这里**（含理由与反例），
> 而不是让读者去 diff 里猜。编号一经写入不修改，后续 WP 如需推翻，另起一条并说明原因。

### 12.1 WP18.3 —— Webhook 渠道 + 出站 SSRF 边界（2026-10-05，`feature/v5-1b-udp-relay`）

**交付**：`backend/src/services/notification-webhook.ts`（新增）、
`backend/src/services/__tests__/v5-wp18-webhook.test.ts`（新增，35 test / 180 expect）、
`backend/src/services/notification-delivery.ts`（追加：`IMPLEMENTED_CHANNEL_KINDS` += `webhook`、
`defaultNotificationChannels()` += webhook、`NotificationChannel.redactTarget?` 可选钩子）、
`backend/src/services/__tests__/v5-wp18-delivery.test.ts`（**改一条已交付断言**，见 D2）。

**D1（判断）出站传输用手写最小客户端（net/tls），**不是** `fetch`，并把这条写成静态守卫。**
理由：F9.4 要求「解析一次并连接到该解析结果」。`fetch` 在仓库运行时 Bun 上**无法**指定连接 IP
（不暴露 dispatcher/Agent），只能退化成「二次解析比对」，仍有绑定窗口；而 `mail.ts` 的 `SmtpClient`
已经确立了「手写最小协议客户端」的先例。实现因此做到了三件结构性的事：连接目标 IP 是**参数**
（`createPinnedSocketTransport` 的 `address`）、Host/SNI 仍用域名、只读响应头即断开。
反例证据：`v5-wp18-webhook.test.ts` 的 H 组用**本机回环真 socket** 断言「域名不可解析仍能连上 →
连的是传入的 IP」与「302 之后只有 1 次请求」；J 组静态断言模块内不出现 `fetch(`。
**与 DoD5 措辞的差异（需要 Lead 知悉）**：DoD5 写的是「注入 fetch 断言未被调用」，
本实现把注入点命名为 `transport`（`WebhookTransport`），断言等价（零出站 = 替身调用次数为 0），
但**没有**在渠道层保留 `fetch` 这个依赖名。理由同上：留一个永远不会被调用的 `fetch` 依赖
只会让人误以为出站走的是 `fetch`。

**D2（判断）给 `NotificationChannel` 追加可选 `redactTarget?`，并在 18.2 的投递编排里使用它。**
理由：F5 与 18.2 的 `NotificationDelivery.target` 列注释都要求「webhook 的密钥不得出现在账本里，
URL 必须由渠道自己脱敏后回传」，但 18.2 写账本用的是 `valid.join(",")`，渠道没有插手的余地。
加了**可选**钩子（缺省行为不变，email 完全不受影响），webhook 用它写
`<origin>/***<sha256 前 12 位>`：保留 origin 让运维能定位接收方，丢掉 path/query 因为
Slack/Discord/飞书的凭据就在这两段里，摘要让同一 host 上的多个 hook 可区分而不泄露 URL。
反例证据：G 组三例（脱敏形态稳定性 / 端到端账本不含 `XXXX` 而出站仍是完整 URL /
传输层抛出的错误里的 URL 也被替换）。

**D3（判断）webhook 载荷冻结为中性 JSON 信封 v1：`{version, source, subject, text}`。**
理由：契约没写载荷形状。F9 明确「不做用户自定义 URL 模板」，而把 `alert.sh` 那套
钉钉/企微/Slack JSON 搬进控制面，等于给每家格式留一份实现与一份测试。
中性信封 + `text`（F10 渲染出的纯文本）把「怎么显示」留给接收方。
**明确不做**：不引入结构化业务字段 —— 那需要扩 F3 的 `send(rendered, target)` 签名，
本期不动接口（如需，另起判断条目）。

**D4（判断）DNS 解析失败 = `rejected_target`（不是 `transport_error`）。**
理由：F9.4 写明「校验失败 → 留 `rejected_target` 且不重试」；`transport_error` 会触发
F4.3 的 3 次重试，而解析不了的目标重试同样次数是同样的结果。反例证据：F 组「ENOTFOUND / 空结果
→ rejected_target 且零出站」。

**D5（判断）地址分类比 F9.2 列出的更严**：额外拒绝 CGNAT `100.64/10`、保留段
（`192.0.0/24`、`192.0.2/24`、`198.51.100/24`、`203.0.113/24`、`198.18/15`、`192.88.99/24`、
`240/4`）、IPv4-mapped/兼容形态、6to4 与 NAT64 前缀。方向由 F9 背书（白名单只有 `public` 一格）。
**副作用（已实测）**：用文档段地址（如 `203.0.113.9`）做"公网"夹具会失败 —— 测试夹具必须用
真实公网段（单测里用 `93.184.216.34`）。

**D6（判断）`https:///hook` 这类空 authority 形态显式拒（`malformed_url`）。**
理由：WHATWG 解析器（Bun 与 Node 行为一致，已实测）会把多余斜杠静默吞掉、把 `hook` 当主机名 ——
操作员写的路径变成主机名这种归一化必须显式拒，不能靠解析器的宽容。

**D7（修正，提交 `94d0da6`）IPv6 字面量目标不发 SNI。**
WP18.4 收尾自查时发现：`URL.hostname` 对 IPv6 字面量带方括号（`[2606:4700::1111]`），
而 `isIP()` 不认方括号 —— 原实现会把 IP 目标当域名、给它发一个 `[..]` 形态的 SNI。
Bun 容忍这种取值（不会当场报错），属于**会静默生效的错**，所以单独修掉并把判断收成纯函数
`webhookTlsServername()`（可断言：5 例单测）。**教训写在这里**：F9.4 的"连接固定到已校验 IP"
让 `url.hostname` 承担了两个角色（SNI 的主机名 / IP 判定的输入），这两种形态对 IPv6 不一致。

**契约未覆盖、本期未做**：不做 webhook 签名（F9 明确）、不做每租户 webhook（O6 未拍板）、
不做投递日志租户页（F7）。**F5 的 `notification_channel` 表**当时未落（schema.prisma 被并行改动占用），
已由 §12.2-D4 补上（该条展开）。

### 12.2 WP18.4 —— Telegram 渠道 + token 密文存储 + `tg_id` 绑定语义（2026-10-05）

**交付**：`backend/src/services/notification-seal.ts`（新增）、
`backend/src/services/notification-telegram.ts`（新增）、
`backend/src/services/__tests__/v5-wp18-telegram.test.ts`（新增，29 test / 138 expect）、
`backend/src/services/notification-delivery.ts`（追加：`IMPLEMENTED_CHANNEL_KINDS` += `telegram`、
`defaultNotificationChannels()` += telegram、失败原因闭集 += **`secret_unreadable`**）、
`backend/src/services/__tests__/v5-wp18-delivery.test.ts`（改一条已交付断言的**语义**，见 D5）、
`backend/src/services/__tests__/v5-wp18-webhook.test.ts`（同一条清单断言同步到三个渠道）。

**D1（判断；Lead 2026-10-05 已批准）telegram 也加部署级开关，默认关（`TUNEX_NOTIFICATION_TELEGRAM_ENABLED`）。**
契约只在 O4 里点名了 webhook，但 Lead 给的**理由**是通用的：「新增的出站通道默认关，要开必须显式
打开」。Lead 追加的理由：默认关 + 显式打开的通道，出问题时**第一嫌疑人是配置而不是代码**，
排查成本差一个数量级。telegram 比 webhook 更需要它 —— `User.tg_id` 今天没有任何验证（见 D3）。

**D2（判断）失败原因闭集新增 `secret_unreadable`。**
F3 的 `ChannelResult` 写的是 `{not_configured | transport_error | rejected_target | ...}`，
这个 `...` 就是给它留的位置。**必须**与 `not_configured` 分开：密文存在但解不开（换错主密钥、
被截断、解出来的东西不是 bot token）是**可排查的数据损坏**，把它显示成"没配置"就是用"看起来没配"
掩盖一次密钥事故 —— C3 明令禁止这种降级。证据：测试 E 组三例（错主密钥 / 解出非 token / 空主密钥
→ 全部 `secret_unreadable` + 零出站 + 账本留行）。

**D3（判断）`tg_id` 绑定语义冻结，并**明写残余风险**。**
1. 收件人**只能**来自 `User.tg_id`：`trim` 后为空 = `unbound`，形状非法（非十进制整数/超 19 位）= `invalid_tg_id`，
   两者都**不投递**，落一条 `rejected_target`（可见，不是静默丢弃）。
2. 「绝不猜用户」用**类型**表达：`resolveTelegramChatTarget(recipient)` 的入参只有 `tg_id`，
   不接受 user id / email / 昵称 —— 「未绑定时拿 `User.id` 顶上」这种写法**写不出来**。
3. **残余风险（不含糊）**：`tg_id` 是用户可自由编辑且**无验证**的字段
   （`routes/settings.ts` 的 `PATCH /profile`），所以「已绑定」只等于「填了一个形状合法的 chat id」，
   **不等于**「这个 chat 属于这个用户」。真正的绑定验证需要**入站 bot 握手**（`/start` 回传一次性码），
   而契约 §9.4 明确本期不做入站 —— 缺口记在这里，**不假装验证过**。
   本期因此：(a) 渠道默认关（D1）；(b) 收件人由调用方按 scope 解析（18.2 契约），
   本模块不提供「给所有用户发」这种默认；(c) 绑定表/握手留给打开 O6 时单独立项。

**D4（判断；原为阻塞项，Lead 2026-10-05 解锁后**已落地**）F5 的 `notification_channel` 表。**
最初的阻塞：`prisma/schema.prisma` 当时被并行成员占用（WP20 的枚举值 staged、WP18.5 的枚举注释
unstaged），`git add` 会把别人的在建改动扫进我的提交（纪律 2 明令禁止）。Lead 先串行落地了三条线
（`7895b40`）并解锁；随后 WP20-4 又开始在同一个文件里改，因此**本次提交只暂存自己那几行**
（`git update-index --cacheinfo` 一个自建 blob），工作树里别人的改动**原封不动留在 unstaged 区**。
落地物：`prisma/schema.prisma` 的 `model NotificationChannel` + 迁移
`prisma/migrations/20261036000000_v5_wp18_notification_channel/migration.sql`
（时间戳避开了已被占用的 `20261035`）。**未加唯一索引**：`(scope_kind, workspace_id, kind)` 看似该唯一，
但 platform 行的 `workspace_id` 是 NULL，MySQL 唯一索引里 NULL 互不相等 ⇒ 它只会给出**假的排他性**。
这一条**实测过**（见下面的验证记录），真要做「一 scope 一 kind」得用生成列或在应用层加锁，那是接线 WP 的取舍。
**验证记录（可复现）**：
1. `prisma validate` 通过；
2. 空库上把 `prisma/migrations/*` 全部按序 apply（**47 条**，含本条）→ `OK`，`SHOW CREATE TABLE
   notification_channel` 与 `prisma migrate diff --from-empty --to-schema-datamodel` 生成的 DDL **逐列一致**；
3. 假的排他性实验：在 `notification_channel` 上**手工**加 `UNIQUE(scope_kind, workspace_id, kind)` 后，
   再插第三条 `('platform', NULL, 'telegram', …)` **仍然成功**（3 行并存）—— 即该唯一索引并不阻止
   "平台侧两条 telegram"，这正是本表不加它的理由。
   （实验在一台 e2e MySQL 的**一次性 scratch 库**里做，做完即 `DROP DATABASE`，未触碰 `tunex` 库。）
4. 附带把 `NotificationDelivery.failure_reason` 的列注释补齐到含 `secret_unreadable`（注释增量，无 DDL 变化）。

**D5（判断）telegram 的 `transport_error` 会触发 F4.3 的重试，因此把「确定性目标问题」映射成
`rejected_target`**：Telegram 返回 `error_code=400`（chat not found / 参数不可接受）与
`403`（bot 被拉黑 / 不在群里）都是**重试无用**的，归 `rejected_target`；429 / 5xx / 3xx / `ok=false`
归 `transport_error`（有界重试 ≤3 次，测试 G 组断言 attempts=3）。
同时，18.2 里那条「枚举里尚未实现契约的渠道类型」的断言语义失效（枚举里不再有未实现的 kind），
改成显式断言「`IMPLEMENTED_CHANNEL_KINDS` == `NOTIFICATION_CHANNEL_KINDS`」，
`unsupported_channel` 分支继续由「枚举外的 kind」那条覆盖 —— 不留空循环式的假通过。

**D6（判断）telegram 出站用 `fetch`（与 webhook 刻意不同），token 的脱敏在渠道层做。**
理由：Telegram 的目标是 chat id，端点 `TELEGRAM_API_BASE` 是**硬编码常量**，没有「用户指定 URL」这回事，
F9.4 的连接级 IP 固定在这里没有对应问题。但 token 在 URL 路径里（协议如此），
所以：`detail` 与账本 `error` 必须经 `redactTelegramToken()` 脱敏（含 URL 编码形态），
账本 `target` 只落 chat id（`redactTarget` 对非 chat id 形状**一律返回 `***`**，防调用方把 URL 当目标传进来）。
证据：测试 F 组的「传输层错误带完整 URL」与「description 回显 token」两例，断言账本 `error` 里
不含 token、且含 `***`。**chat_id 以 JSON 字符串下发**：它是 64 位整数，走 JSON number 会在大 id 上丢精度。

**D7（判断）渲染：`parse_mode=HTML` 必须转义，且截断**不得切断实体**。**
`&`→`&amp;`、`<`→`&lt;`、`>`→`&gt;`（先换 `&`），超 4096 字符时回退到最后一个未闭合实体之前 ——
把 `&amp;` 切成 `&am` 会被 Telegram 返回 400，那会变成一条"我们渲染坏了"的假故障（测试 H 组）。

### 12.3 WP18.5 —— 公告：表 + API + 已读 + 免打扰 + `NOTICE` 只读迁移 + 前端最小展示（2026-10-05）

**交付**：
- schema / 迁移（三个模型 + `NOTICE*` 的 `@deprecated` 注释 + 只读回填）—— 已随 Lead 的串行化提交
  `7895b40` 落地（`prisma/schema.prisma`、
  `prisma/migrations/20261033000000_v5_wp18_announcements/migration.sql`）。
- `backend/src/services/announcement.ts`、`backend/src/services/announcement-mute.ts`（新增）。
- `backend/src/routes/announcements.ts`、`backend/src/routes/announcements-admin.ts`（新增）；
  `backend/src/app.ts` 挂载两处；`backend/src/routes/public.ts` 的免认证白名单去掉三个 `NOTICE` 键。
- 测试：`src/services/__tests__/v5-wp18-announcements.test.ts`（32 test / 134 expect）、
  `src/services/__tests__/v5-wp18-announcement-mute.test.ts`（19 test / 58 expect）。
- Web：`src/lib/announcements.ts`、`src/components/announcements/announcement-banner.tsx`、
  `src/components/announcements/__tests__/announcement-banner.test.tsx`（7 test / 24 expect）、
  `src/lib/api.ts`（+`announcements` 组）、`src/lib/i18n.ts`（+`announcements` 词条）、
  `src/components/dashboard/dashboard-body.tsx`（挂载）、
  `src/components/admin/settings-manager.tsx`（`NOTICE*` 组标注「已废弃」）。

**D1（判断；契约在这里缺一条 —— 我没有默默决定，请 Lead 确认）公告**不经过** `NotificationFact`。**
F1 把 `reason_code` 冻结成「既有词表」= **同一份** `AttentionReasonCode`，而 F2-N6 又说公告的派生依据
是「公告表自身」—— 这两条联立后，公告**没有**可用的原因码：`AttentionReasonCode` 里没有、也不该有
「公告」这种码（它是「需要处理」的码表，公告不是待办）。候选：
(a) 把 `NotificationReasonCode` 扩成 `AttentionReasonCode | AnnouncementReasonCode`（改的是 18.1 已冻结
的形状，需要 18.1/18.2 的所有者同意，且不在本 WP 的文件范围内）；
(b) 公告不走 `NotificationFact`：投递用渠道层的 `RenderedNotification` + 同一套免打扰判据；
(c) 借用某个既有码（**禁止**：那就是发明事实）。
**取舍 = (b)（本期）**。理由：把公告塞进「通知 = 既有事实链的派生」会让 F1 的地基出现一个例外，
而公告的真相本来就在公告表里（C2 已写明「公告真相在公告表」），不需要 `AttentionItem` 当载体。
落地物：`renderAnnouncementText()`（纯文本、无模板引擎、无 HTML）产出与渠道层同形的 `RenderedNotification`。
**交付缺口（明确记下）**：本 WP 只交付「渲染 + 免打扰判据」，**没有**任何 worker / 路由在公告发布时去投递它；
若 Lead 选 (a)，这条接线自然变成「派生一条 announcement 事实」，否则需要一个非 `NotificationFact` 的投递入口
（建议与 WP18.6 一起做，因为那时才有 `notification_channel` 的读侧）。

**D2（判断）免打扰的两个词表**复用**既有闭集，不做副本。**
类别 = `NOTIFICATION_SOURCE_KINDS`（`notification-facts.ts`）、渠道 = `NOTIFICATION_CHANNEL_KINDS`
（`notification-delivery.ts`），并且是**引用相等**（测试 `toBe` 钉住）而不仅是"内容一样"。
理由：F6.5 的「类别」要回答的就是「这类通知」，而通知的类别本来就是它的**触发源**；另造一套分类词表
等于两处映射，迟早不一致。未知渠道 / 未知类别在 JSON 边界**整份拒绝**（`unknown_channel_kind` /
`unknown_category`），不做「丢掉不认识的项」的降级（C3）。

**D3（判断）免打扰是"偏好"、静默期是"速率"，两者互补且**只有一个接触点**。**
静默期（O2）的键是 `(scope, source_kind, source_id, reason_code)`，回答「**同一条事实**刚投过没有」；
免打扰的键是 `(user_id, channel_kind, category)`，回答「这个**用户**要不要在这个渠道收这一类」。
因此本层**不实现任何冷却/时间窗常量**（测试 G 组静态断言：两个新模块不含时长常量、不 import redis、
不引用 `NOTIFICATION_COOLDOWN_SECONDS` / `notificationCooldownKey` / `cooldownSecondsForReason`）。
唯一接触点是 `createMuteAwareTargetResolver()` —— 它只替换 `DeliverNotificationDeps.resolveTargets`，
投递层的静默期 / 账本抢占 / 有界重试**一行未改**。
两条容易做错的边界，都用断言写明：① 被静音的目标**根本不进账本**（`target` 里没有它，不是"发了再假装没发"）；
② 全员静音 ⇒ 空目标 ⇒ 走既有语义记一条 `rejected_target` 失败行（**失败可见**，既不改写成 `sent`，
也不静默跳过）。证据：mute 测试 E 组五条（目标不进账本 / 同一事实第二次仍是 `suppressed` 且不新增账本行 /
类别与渠道各自独立 / 全员静音留失败行 / 无静音时与不装免打扰完全一致）。

**D4（判断；F7 的一处口径补充，请 Lead 确认）「读公告」= 活跃成员，不是 `settings:read`。**
F7 的表里写「发布/撤回租户公告 | 复用 `settings:manage`（读用 `settings:read`）」。我把那句「读」解释为
**管理面的读**（`GET /manage`：含已撤回的完整列表），而**用户侧**的可见列表与已读只需**活跃成员**
（`resolveWorkspaceMembership`）。理由是一条反例：公告是**发给所有人**的内容；若可见列表挂在
`settings:read` 上，任何自定义角色里没有该键的成员就看不到平台公告 —— 那不是把权限收紧，是把功能做坏。
落地：`GET /` 与 `POST /:id/dismiss` 只做成员解析；`GET /manage` / `POST /` / `POST /:id/revoke`
走 `resolveWorkspaceAccess(c, "read"|"manage", "settings")`（**不新增**租户权限键，F7 明确不做）。
另外，免打扰的两个端点是**用户级**（F6.5 的三元映射里没有 workspace），放在 `/announcements/preferences`
只认会话用户、不经过工作空间权限判定。

**D5（判断）弹窗冲突 = 409 拒绝，不「先关旧的再插新的」。**
F6.3 只要求「同 scope 一条活跃 + 用 DB 唯一约束表达」，没写冲突时怎么办。Forwardx 的做法是自动关旧的
—— 它的问题正是"没有约束、并发下留下两条"。本实现：`active_popup_key` 是**非空标量**
（`popup:global` / `popup:<id>`）+ 唯一索引，第二条活跃弹窗被 **DB 拒绝**，服务层收敛成
`active_popup_exists` → **409**；撤回时把该列清回 NULL（槽位释放），否则一条已撤回的弹窗会永久占位。
不做自动撤回：悄悄关掉另一个管理员正在用的公告，比一个 409 危险得多。
为什么不用 `@@unique([scope_kind, workspace_id, type])`：MySQL 的唯一索引把 NULL 视为互不相等，
平台行（`workspace_id IS NULL`）之间永远不冲突 —— 与 §12.2-D4 对 `notification_channel` 的实测结论同一条。
证据：announcements 测试 D 组五条（唯一键形态 / 第二条被拒且 normal 不受影响 / 撤回释放槽位 /
撤回幂等且不改首次时刻 / 撤回要求作用域**恰好相等**）。

**D6（判断）`platform ⟹ workspace_id = NULL` 的结构表达 = 类型 + 唯一转换点；DB 层**故意不加** CHECK。**
F6.2 要求「用结构约束表达，不用约定」。落地方式与 WP18.1 同源：`AnnouncementScope` **就是**
`NotificationScope`（判别联合 —— `kind:"platform"` 时 `workspace_id` 只能是 `null`），
`isAnnouncementScope` 是 `isNotificationScope` 的**别名**（测试用 `toBe` 钉住"不是两份实现"）；
落库值只经 `announcementScopeColumns()` 这**一个**出口；读侧另有 `visibleAnnouncementWhere()`（查询条件）
与 `isAnnouncementVisible()`（行级判定）两道。坏行（`scope_kind="platform"` 且 `workspace_id != NULL`）
对**任何**租户都不可见（fail-closed，测试 B 组覆盖）。
**不加 DB `CHECK` 的理由**：`schema.prisma` 表达不了 CHECK，而这条线的门禁是
`prisma migrate diff` 零漂移；本沙箱没有 MySQL，我**无法证明** CHECK 不会造成漂移 ⇒ 宁可不加，
让坏行的代价被限制在"读不到"而不是"证明不了"。若 Lead 要求 DB 级硬约束，建议照 `active_popup_key`
的思路用**生成列 + 唯一索引**表达，并先在一台 e2e MySQL 上复验 `migrate diff` 仍为
`No difference detected.`。

**D7（判断）`NOTICE` 只读迁移：迁什么、不迁什么，以及幂等判据为什么挂在临时表上。**
- **只读**：迁移文件里没有任何一条语句写 `config`（测试 G 用正则断言不含 `UPDATE`/`INSERT INTO`/
  `DELETE FROM`/`ALTER TABLE`/`DROP TABLE \`config\``，也不含 `TRUNCATE`），确实只 `SELECT` 它。
- **迁什么**：非空 `NOTICE` → **一条** `scope_kind="platform"` + `type="normal"` 的公告，标题固定
  「站点公告」，正文 = `TRIM(value)`，`published_at = COALESCE(updated_at, created_at, now)` ——
  **来源表上的既有时间戳**，不是"迁移跑起来的时刻"；`created_by_id` 留 **NULL**（旧键没有作者，不猜）。
- **不迁什么**：`NOTICE_POPUP` / `NOTICE_POPUP_INTERVAL_HOURS` 不做内容迁移 —— 它们是布尔开关与展示间隔，
  不是内容（内容在 `NOTICE` 里，已经迁走）。三个枚举值**一个都没删**，且都标了 `@deprecated`
  （测试 G 逐条正则断言「紧邻上方有 `@deprecated`」，不是口头承诺）。
- **幂等判据为什么挂在临时表上**：MySQL 手册 13.2.5.1 明写 *"you cannot insert into a table and select
  from the same table in a subquery"* ⇒ `INSERT INTO announcement … WHERE NOT EXISTS (SELECT 1 FROM
  announcement …)` 这种写法**根本写不出来**。判据因此挂在 `INSERT INTO <临时表>` 上（该语句的目标表不是
  `announcement`），回填语句只读临时表。于是手工重复执行本文件成为 no-op（正常路径下 Prisma 的
  `_prisma_migrations` 台账已经保证至多执行一次，这是第二道闸）。
- **同一次发布里停掉旧下发面**：`routes/public.ts` 的免认证白名单去掉三个 `NOTICE` 键（`web/src` 对它们
  **零消费者**，契约 §1.2 已核实）。否则老客户端读旧键、新客户端读公告表，就是两份公告真相（R3）。
- 未纳入的：`NOTICE_POPUP=true` **不**转成 `type="popup"` 公告 —— 契约只写了「非空 `NOTICE` 值」，
  把布尔开关猜成"要一条什么样的弹窗"没有依据。

**D8（判断）前端只做**最小展示**：不做偏好矩阵 UI（§9.5 已明确）、不做管理端发布 UI、弹窗不做模态。**
- 取数在服务端（`DashboardBody`；作用域从 `tunex_workspace` cookie 解析，与同一处的 `forwards.list`
  同源），客户端组件只负责显示与「知道了」。已读后 `router.refresh()` 让服务端重取 ——
  前端**不**维护第二份"我读过什么"（C2）。
- **三态**：有内容 → 列出未已读的（弹窗优先，其余按发布时间倒序）；没有 → **什么都不渲染**（不占版面、
  不说「暂无公告」）；取不到 → 一句「公告暂时取不到（这不代表没有公告）」。`null` 与 `[]` 必须分开：
  把抖动读成"平台没有话说"正是本仓库反复禁止的那种谎。
- **纯文本**：正文一律作为 React **文本节点**渲染（`{item.body}`，自动转义）。DoD7 的 grep 断言由
  `v5-wp18-announcements.test.ts` 实现（递归扫描 `web/src` 的 `.ts/.tsx`），另有一条**真渲染**断言
  `<script>alert(1)</script>` 被转义成 `&lt;script&gt;`（"没有那个属性"只是必要条件，不等于渲染安全）。
- **一条值得写下来的教训（Lead 2026-10-05 给的"可执行反馈"，已改）**：DoD7 的第一版断言是
  `src.includes("…")`，跑出来命中的**全是**"我们没有用它、为什么不用"的注释 —— 一个把好行为
  （把理由写在代码旁边）逼走的断言，**错的是断言**。修法是**修断言，不是删注释**：
  扫描改成**先去注释再匹配**（对象：行注释、块注释、JSX 注释；用状态机而不是逐行正则 ——
  逐行 `/\/\/.*$/` 会把 `title="https://x"` 之后的**真命中**一起删掉，而 URL 字符串在 web 里很常见），
  并按本仓库既有源码守卫的样式（`system-config-enum.test.ts`、`v5-wp5-b2-ack-field-flow.test.ts`）
  补一条**口径自检**，钉住四件事：注释里的字不算命中 / 真代码里的算命中 / 含 `https://` 字符串的同一行
  后面仍算命中 / 扫到的文件数 > 50（防路径写错造成的"零命中"假通过）。
  于是那三处解释性注释**照原样保留**（并把名字写回去）。

**D9（未决 / 移交）**
1. **WP18.6**：`/admin/announcements` 前缀的 RBAC 登记。本 WP **故意不预先登记** ——
   现在未登记 ⇒ 非超管 403、超管可用（契约 F7「不登记 = 只有超管」），这正是 18.6「登记生效」断言
   （改动前 403 → 改动后 200）的起点。`app.ts` 与 `routes/announcements-admin.ts` 都写明了这一点。
2. **WP18.7 / Gate**：DoD8 的**真实 apply**（空库 + 存量 V4 库，含"非空 `NOTICE`"夹具；以及
   `scope_kind="platform"` 坏行的写入尝试）需要 MySQL。本沙箱既无 MySQL 也无法起容器（禁止动 docker），
   我能做到的只有静态断言；**漂移那一半已被 Lead 在 `7895b40` 证明**（`migrate diff` →
   `No difference detected.`），**回填语义那一半仍需真实库**。
3. **D1 的接线**（公告发布后谁去投递）与管理端**发布公告的 UI**：见 D1 与 D8，均未做。
   注意 §9.5 已排除"通知中心前端"，但**公告编辑**不在该排除项里 —— 若需要，另立小项（F6 明确不做富文本）。

**验证记录（可复现，2026-10-05）**
1. `bun test src/services/__tests__/v5-wp18-announcements.test.ts src/services/__tests__/v5-wp18-announcement-mute.test.ts
   src/services/__tests__/v5-wp18-facts.test.ts src/services/__tests__/v5-wp18-delivery.test.ts`
   → **104 pass / 0 fail**（5426 expect）。其中本 WP 新增 **51 test / 192 expect**；
   18.1/18.2 的既有 54 test 作为回归一起跑。
2. `bun test src/components/announcements/__tests__/announcement-banner.test.tsx`（web）→ **7 pass / 0 fail**（24 expect）。
3. `bunx tsc --noEmit`（backend）与 `tsc --noEmit`（web）→ 本 WP 的文件**零错误**。
   注：backend 全量 tsc 当时有 3 条**别人在途**的错误（`prisma/seed.ts` 缺 WP19 新增的两个枚举键、
   `services/looking-glass.ts` + `control-protocol/types.ts` 的 `looking_glass`），与 WP18.5 无关，
   已在交付报告里点名。
4. DoD 对照：**DoD1/2/3/4/5**（18.1/18.2 已交付）、**DoD6**（公告跨租户：B 组 6 test）、
   **DoD7**（去注释后的扫描 + 口径自检 + 真渲染转义）、**DoD8 的离线半边**（G 组 7 test）、
   **DoD10**（两个新模块无时长常量）
   均已断言；**DoD8 的联机半边**与 **DoD9**（权限）分别归 WP18.7 与 WP18.6，见 D9。




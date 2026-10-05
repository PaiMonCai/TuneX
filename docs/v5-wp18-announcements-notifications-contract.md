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

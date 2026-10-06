# R6 终局独立评审：退出条件 #10「不再明显落后」（task-32）

> **评审人**：`misc-truth`（持久队友，非本专项实施者）
> **被评审对象**：`docs/agent/productization-status.md` §3.34 的对账表、`docs/agent/forwardx-alignment-review.md`（R5-A 基线，task-23）、以及 R5-A 判「#10 未达成」时列出的**三条落后理由**。
> **纪律**：本文件只写**我自己复核过**的东西；「从文档看到但未复核」单列在最后一节。**不把 §3.34 对账表当证据**（它是被评审对象）；不把「在途 / 只有单测 / 只有契约测试」算作达成。
> **只读**：本次评审未改任何源码、未做 git 提交、未启停任何容器、未动 `tunex-it-*` 拓扑；唯一写入是本文件。

## 0. 时间与 SHA 钉点（读本节时请先确认它还是最新的）

| 项目 | 值 |
|---|---|
| HEAD（评审基线） | `2037d057342d3887e327ece4d0ff4b884759f520` |
| HEAD 提交时间 | 2026-10-07 03:27:05 +0800（`feat(harvest): F1 收口（探针改 agent 自实现 HTTP）+ SMTP 配置真话化（task-14 进行中）`） |
| 本报告开始时间 | 2026-10-07 03:34 +0800 |
| 干净检出 | `git archive HEAD` → `/tmp/r6-misc-truth-2037d05`（无 `.git`；SHA 由工作区 `git rev-parse HEAD` 钉住） |
| 工作区在途（审计时） | `backend/src/routes/__tests__/forward-list-route.test.ts`、`backend/src/services/__tests__/mock-isolation-guard.test.ts`、`docs/production-deploy.md`、`web/src/components/admin/settings-manager.tsx`（M）、`backend/src/services/__tests__/notifications/smtp-deployment-config.test.ts`（??）——**均非本评审的三条对象**，且我读的所有文件都在干净检出里 |
| scratch Panel | `http://127.0.0.1:18180`（主机 node 进程把 TCP 转发到 `docker exec -i tunex-it-panel` 的 `:3000`；`/healthz` → 200），Panel/Worker 镜像 `tunex-harvest-backend:n4-0314`，两者 Up ~20min |
| 真库 | `tunex-it-mysql`（`MYSQL_DATABASE=tunex`）。**只读 SELECT**（无写、无重启），见 §1.4 |

**证据类别**（本评审实际用到的）：① 干净检出读码（给 `文件:行`）；② 干净检出上跑只读命令（`tsc --noEmit`、`bun test` 指定文件）；③ 只读 HTTP 打 `127.0.0.1:18180`；**外加**④ 只读 SQL / `docker logs`（真机事实）。**本评审没有使用浏览器**（无截图、无 DOM 取证），凡是"页面渲染成什么样"的结论都只到「组件行为 + 已挂载」这一层。

## 1. 落后理由 ①：通知「配好也没有任何东西会被投递」

**复核结论：部分消除（接线已真，端到端投递未证实）。**

### 1.1 生产调用者：**已消除**（读码 + 真机日志）

- `backend/src/worker.ts:46`：`CRON_JOBS` 里有 `{ name: "cron_notification_facts", everyMs: 30_000, ... }`。
- `backend/src/worker.ts:242-266`：`case "cron_notification_facts"` 动态 `import` 真实服务并调用 `runForwardDenialNotifications(defaultForwardDenialDeps())`；异常被 `console.error("[worker] cron_notification_facts failed:", ...)` 留痕而不是静默吞掉。
- `backend/src/services/notification-facts-trigger.ts:640-668`：生产依赖是**真**依赖——`collectAttention(...)` 取事实、`loadPlatformChannelConfig(db)` 读渠道、`enabledNotificationChannels(...)` 过部署级闸门、`createPrismaLedgerStore()` 写账本；配置读取失败时**不**谎称"这台安装没配渠道"，而是回落 + `warn(...)`（`:650-657`）。
- **真机日志**（`docker logs tunex-it-worker`，`--since 12h`）：`[worker] cron_notification_facts ok (29xxx ms since enqueue)` 以 ~30s 一拍持续出现（同一窗口 ≥15 拍，与 `cron_reconcile_v3` / `cron_ddns_sync` 同频）。对照：另一个 worker 容器（镜像 `ghcr.io/paimoncai/tunex:latest`，非本 HEAD 构建）**没有**这条节拍——说明这条节拍来自 HEAD 代码，不是"旧镜像里本来就有的东西"。

### 1.2 渠道配置：**UI 与端点都已到位**（只读 HTTP + 读码）

- 端点：`GET /api/admin/notification-channels` → **200**，实测 body：
  `{"scope_kind":"platform","channels":[],"delivery_kinds":{"registered":["email","telegram"],"enabled":[],"announcement":[]},"warnings":[]}`。
- UI：`web/src/app/(admin)/admin/notification-channels/page.tsx`（独立目录，**不走** `[segment]` 的 `normalize()`）+ `web/src/components/admin/notification-channels-manager.tsx`；导航项在 `web/src/lib/nav.ts:259-266`（**非 planned**，可直接点击）。
- 「保存 ≠ 投递」这句真话在 UI 里：`notification-channels-manager.tsx:132`「保存成功只代表服务端记下了配置：它不会让未接线的渠道开始投递，也不会打开部署级的渠道开关」；`:190` 说明 email 凭据来自**部署级 SMTP**，不在本页。
- 渠道集合的**闭集由服务端下发**（`:465-472` 渲染 `delivery_kinds`），前端不硬编码副本。
- 事实类渠道口径（读码）：`notification-facts-trigger.ts:367-374` `FACT_NOTIFICATION_CHANNEL_KINDS = ANNOUNCEMENT_CHANNEL_KINDS`（email / telegram），且 `:353-366` 明确**有意排除 webhook** 并给三条理由（与实测 `registered: ["email","telegram"]` 一致）。

### 1.3 用户偏好与失败可见：**已到位**（读码 + 只读 HTTP + 组件测试）

- 用户偏好：`GET /api/announcements/preferences` → **200**，服务端下发闭集 `{mutes, channels:[email,webhook,telegram], categories:[node,forward,reconcile_finding,workspace_event,federation_event,announcement]}`；UI 挂在 `web/src/components/settings/settings-body.tsx:333`（`NotificationPreferences`）。
- 失败可见（账本读投影）：`GET /api/notifications/deliveries` → **200**，实测
  `{"scope_kind":"workspace","workspace_id":3,"summary":{"total":0,...,"degraded":0,"by_failure_reason":{}},"rows":[]}`；
  `?status=bogus` → **400** `{"code":"invalid_filter" ...}`（闭集 400，不是静默忽略）；`?status=failed` → 200 空。
- UI：`web/src/components/settings/notification-deliveries.tsx` 挂在 `settings-body.tsx:338`；五态 `loading/forbidden/unavailable/empty/ready`，其中 `empty` **只在真的读到 0 行**时成立（`:211-216`）；`emptyHint` 明写「没有记录」**不是**「没有失败」、更不是「通知都在正常工作」（`:93-95`），`forbidden`/`unavailable` 两态也各自拒绝这个读法（`:89`、`:91`）。
- 该组件与渠道管理器、偏好组件在干净检出上的定向测试：**146 pass / 0 fail**（5 文件：`looking-glass-panel`、`forward-ha-card`、`notification-deliveries`、`notification-preferences`、`notification-channels`）。

### 1.4 但**端到端投递仍无证据**（真机事实，这是本条的扣分点）

只读 SQL（`SELECT` only）打在 `tunex-it-mysql`：

| 查询 | 结果 |
|---|---|
| `SELECT * FROM notification_delivery` | **0 行**（所有 scope，不只是工作区） |
| `SELECT kind,enabled,target FROM notification_channel` | **0 行**（本安装没有任何渠道配置行） |
| `SELECT name,value FROM config WHERE name LIKE '%SMTP%'` | `SMTP_PORT/SMTP_SECURE` 有值，**`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` 全为空** ⇒ 邮件不可用 |
| `SELECT value FROM config WHERE name='FAILOVER_POLICY'` | `{"auto_failover":false,"auto_failback":false}`（与 §2 的 HA 呈现相关） |

- Panel 日志同时给出邮件通道的真实状态：`[mail] SMTP 未配置，邮件降级为日志（开发环境）。`
- 事实源：`GET /api/dashboard/attention` → **200**，`items: []`、`total: 0` ⇒ **这个拓扑当前没有任何「转发下发被拒」事实**，所以触发器即使每 30s 跑，也**没有东西可投**。
- 因此：`cron_notification_facts` 每拍 `ok` **只证明"节拍在跑、没有崩"**，不证明"配好一个渠道后真的会投递出去"。把这两件事混为一谈，正是 R5-A 那条落后的**同型错误**（只是方向相反）。

### 1.5 一个我**无法解释干净**的历史痕迹（如实记录，不作为证据）

Panel access log 里 `2026-10-06T19:16:25Z`（= 03:16 +08）有 `GET /api/notifications/deliveries/5` → **200**，意味着**当时**某个 scope 下存在 id=5 的账本行；而 03:45 我复跑同一路径（工作区 2 / 3 都试过）→ **404** `没有这条投递记录（本工作空间）`，且整表 0 行。
我不能确定它来自"真实投递"还是"验收期的夹具/清理"（`/tmp/tunex-harvest-integration-20261006/` 下的验收脚本 `acceptance-f5.mjs:93-94` 确有 `docker exec tunex-it-mysql ... mysql -e` 的用法，但我**没有**逐行确认它是否插过账本行，且该脚本属于实施方产物，不能当作证据）。**结论：这条历史痕迹不能支撑"端到端投递已达成"。**

### 1.6 明确仍无端到端证据的环节

1. **公网 MTA**：SMTP 未配置（用户/密码/发件人为空）⇒ 从未真的发过一封邮件；
2. **Telegram 真投递**：无 bot token、`notification_channel` 零行 ⇒ 从未真的调用过 Bot API；
3. **"配好一个渠道 → 产生一条真实事实 → 账本出现 sent 行"** 的完整链：需要①有拒绝事实 ②有可用渠道 ③三者在真机上串起来——本次拓扑三者一个都不具备。

---

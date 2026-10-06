# 通知中心预研（R4-A 收束）

> 只读预研结论（含文件:行证据）。用于退出条件 #6「Notification 可以从 UI 配置」。**不授权编码，不代表任何功能已完成。**

## 1. 头条结论

1. **TuneX 通知后端相当完整**：派生（纯函数、只消费 attention 既有原因码）、静默期（Redis 每渠道 SET NX）、投递账本（唯一索引幂等 + 每渠道配额）、有界重试（≤3，仅 `transport_error`）、三渠道、免打扰 `(user×channel×category)`、渠道密文（HKDF 独立域 `tunex-notification-v1`），且有真实 DB/Redis 集成测试。
2. **缺口是"未接线 + 无配置面 + 账本只写不读"**：事实类触发器**没有生产调用者**；`notification_channel` **没有任何读写 API**、`sealNotificationSecret` **无生产写入方**；`notification_delivery` **无人读**（投递失败用户与管理员都看不到）。
3. **Web 侧零实现**：用户域与 admin 域都**完全没有**通知配置界面/客户端/词条（全 `web/src` 对 `notif` 仅 5 处命中，全是联邦 `notified`）。

## 2. 关键证据

| 事实 | 位置 |
|---|---|
| 事实类触发器无生产调用者：`runForwardDenialNotifications` / `defaultOpenDenialsDeps` 只被自己的测试引用 | `services/notification-facts-trigger.ts:133/306` |
| worker 的 `CRON_JOBS` 只有 traffic / latency / offline / reconcile / settle，**没有通知 job** | `worker.ts:26-36` |
| 唯一真正接线的投递路径是**公告**（发布后 fire-and-forget） | `routes/announcements.ts:83-87`、`announcements-admin.ts:81-87` |
| 事实类 **`resolveTargets` 完全未写**（触发器只注入 `deliver`） | `services/notification-delivery.ts:511` |
| 触发器只选 forward 类（`item.kind !== "forward"` 直接 continue）⇒ **node 事实从不被选中** | `notification-facts-trigger.ts:53-54` |
| `notification_channel` 无任何路由；`sealNotificationSecret` 无生产写入方 | 全仓 `grep notification_channel` 在 `routes/` 零命中 |
| 账本只写不读（无路由/页面/支持包/审计） | `grep notification_delivery` 在 `routes/` 零命中 |
| 免打扰后端完整（`GET/PUT /api/announcements/preferences`，**连同服务端闭集一起下发**、PUT fail-closed 400） | `routes/announcements.ts:151-180` |
| Web `lib/announcements.ts:36-39` 明文记载"本期不做通知中心前端（偏好矩阵 UI）" | 同左 |

**既有事实错误（顺带查出）**：
- **N-F1**：admin 系统设置能写 `SMTP_*`，但 `mail.ts` **只读 `process.env`** ⇒ 在 UI 配 SMTP 对邮件渠道**不生效**（`admin.ts:201-223` vs `mail.ts:59` / `env.ts:72-82`）。
- **N-F2**：部署文档称 webhook/telegram 的凭据"见管理端配置"，**该配置不存在**（`docs/production-deploy.md:117`）。
- **N-F3**：前端类型 `SystemConfigItem` 不含 `secret_configured` ⇒ UI 无法显示"已配置"（`lib/types/base.ts:145-151`）。

## 3. 缺口（G1–G10）与切片（N1–N5）

| 缺口 | 阻塞 #6？ | 对应切片 |
|---|---|---|
| G1 事实类触发器无调用者；worker 无 job；事实类 `resolveTargets` 未写 | **是** | **N3** |
| G2 `notification_channel` 无读写 API；`sealNotificationSecret` 无写入方 | **是** | **N2** |
| G3 投递账本无读取面 | 否（但违反"失败可见"纪律） | N4 |
| G4 渠道状态（已配置/未启用/密钥不可读）无投影 | 是（否则前端只能说假话） | N2 的一部分 |
| G5 免打扰后端完整、Web 零消费 | 否（最高 ROI 的"可从 UI 配置"） | **N1** |
| G6 `tg_id` 裸填、无绑定握手（后端明示未验证） | 否 | DEFER |
| G7 Web 无任何通知界面/词条/mock | 否 | N1/N2 的 UI 面 |
| G8 Failover / DDNS / finding / 联邦 / 工作空间事件**无通知派生**（枚举占位） | 否 | DEFER |
| G9 **6 个免打扰类别里今天只有 `announcement` 真的会投递** | 是（决定首切片措辞） | N1 必须如实标注 |
| G10 SMTP 的 UI 配置不生效 + 文档谎 | 否 | N5 |

**优先级**：**N2 + N3（后端最小接线，闭环前提）→ N1（纯 Web EXPOSE）→ N4（失败可见）→ N5（SMTP 事实错误）**。

## 4. 各切片的边界（要点）

- **N2**：新增 `backend/src/routes/notification-channels.ts`；GET 只给 `kind`/`enabled`/脱敏 `target`/`secret_configured`（**绝不回显 `secret_enc` 或明文**）；PUT/DELETE 走 `sealNotificationSecret`（唯一落库入口）；形状校验复用既有 `isValidTelegramBotToken` / `parseWebhookTarget`；`permissions.ts` **必须登记新资源键**（未登记前缀=只有超管，fail-closed）；`app.ts` 挂载一行。**不加表/列/迁移，不改投递逻辑。**
- **N3**：`worker.ts` 的 `CRON_JOBS` 注册一条 job → `runForwardDenialNotifications`，补齐 `load()`/`resolveTargets`/`channels`；**幂等交给投递层**（账本 + 静默期），**job 里不得另做去抖**（那就是第二套抑制判据）；webhook 是否纳入需显式决定（`buildPlatformNotificationChannels` 目前有意排除它）。
- **N1（纯 Web）**：EXPOSE `GET/PUT /api/announcements/preferences`；渲染**服务端下发的闭集**；**必须如实标注哪些类别今天会真的投递**（G9），不得把 6 类渲染成等价可用；三态（`loading`/`ready`/`degraded`）且 `400 unknown_*` 与 `503 storage_error` 分开；免打扰是 **user 级、跨 workspace**，不得包 workspace scope，切空间丢弃晚到响应。
- **N4**：账本只读投影（admin 先行）；平台行（`workspace_id` 为空）**不得**下发给租户。
- **N5**：修 N-F1 / N-F2。

## 5. ForwardX 参考（只读行为，未复制代码/文案）

渠道**只有 Telegram**（其 webhook 是 DDNS provider，与通知无关）；email 提醒有服务端无 UI。配置为 admin 单页按渠道分卡（启用开关、只写不读的 token（masked/locked/来源标注）、三类事件开关、"测试发送"、删除机器人）；用户侧用一次性绑定码（`TG-<12>`，TTL 5 分钟，深链 + 倒计时 + 解绑确认）；公告按用户 opt-in；**per-host** 的提醒开关写在 host 行上。
**反面教材（TuneX 已有注释点名）**：进程内 Map 记"上次状态/冷却"、把"今天已发过"写进 settings KV、失败只 `console.warn` 计数（把"投递失败"变成日志而非可见事实）。

## 6. 风险（照搬会破坏什么）

双份去抖（TuneX 的抑制真相是 Redis 静默期 + 账本唯一索引）；把 `not_configured`/`rejected_target`/`secret_unreadable` 折叠成"已配置/正常"（违反"失败可见"与"不撒谎"纪律）；为做 UI 另建"通知记录"表（第二套真相）；没有握手就宣称 `tg_id`"已绑定/已验证"；为通知在 Node 表加列（绕过 Workspace 归属与审计边界，**REJECT**）；两套静音心智并列；敏感值进 URL/日志/SSR/账本（bot token、webhook URL 本身就是凭据）。

## 7. 未验证（不得写成通过）

全部为静态调查，**未运行任何服务/测试/构建/容器**，未连接真实 DB/Redis，未发送任何真实邮件/Telegram/webhook；"无生产调用者"基于仓库内全量 grep，未在运行实例核对；真实库里 `notification_delivery`/`notification_channel` 是否有存量行未核实；ForwardX 侧为只读代码推断，未运行其前端；N-F1 未在真实部署验证。

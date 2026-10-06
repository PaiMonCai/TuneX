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

### 0.1 审计期间 HEAD 被推进（按纪律重新取 SHA 并标注）

| 时刻 | HEAD | 说明 |
|---|---|---|
| 03:34（评审开始） | `2037d057342d3887e327ece4d0ff4b884759f520` | 本报告 §1–§3 的代码引用以它为准（干净检出 `/tmp/r6-misc-truth-2037d05`） |
| 03:52（复核时发现已推进） | `57d252080ce395cfd7e5897e7d7aafa241c8564e` | 03:51:53 `feat(harvest): F1 收口（探针内建，零依赖增长）+ SMTP 配置真话化 + 部署演练结论` |

`57d2520` 相对 `2037d05` 改了 17 个文件；**与本评审三条对象有关的文件一个都没变**（`worker.ts`、`notification-facts-trigger.ts`、`routes/forwards.ts`、`routes/looking-glass.ts`、`forward-ha-card.tsx`、通知三件 UI 均不在 diff 内）⇒ §1–§3 的结论**沿用**。受影响的**旁项**按新 HEAD 重核：`node-health-service.ts`（+44，Agent 版本基线语义分类）、`settings-manager.tsx`（+8）与 `admin.ts:326`（SMTP 真话化，见 §1.7）。第二次干净检出：`/tmp/r6-misc-truth-57d2520`。

### 0.2 真机证据的版本边界（必须和结论一起读）

- scratch Panel/Worker 跑的是镜像 `tunex-harvest-backend:n4-0314`，**不是** HEAD 构建。§1/§2/§3 里"只读 HTTP / 真库"的结论，严格说是**该镜像**的行为；我判断"它与 HEAD 一致"的依据是端点返回形状与 HEAD 代码逐字段吻合（`/ha` 的 `preference_rejection`/`accepts_new_business`、`/looking-glass/status` 的 `platform_admin_override` 等）。
- 反例（证明镜像确实可能落后于 HEAD）：`GET /api/admin/system/config` 在该镜像上**仍列出** `SMTP_PORT/SECURE/USER/PASS/FROM`，而 HEAD 的 `settings-manager.tsx:42-62` 与 `admin.ts:326` 已经**不再列、且拒写**它们。⇒ **不要把真机 HTTP 当成"HEAD 的验收"**，它只是"某次构建的真机行为"。

## 1. 落后理由 ①：通知「配好也没有任何东西会被投递」

**复核结论：部分消除（接线已真，端到端投递未证实）。**

### 1.1 生产调用者：**已消除**（读码 + 真机日志）

- `backend/src/worker.ts:46`：`CRON_JOBS` 里有 `{ name: "cron_notification_facts", everyMs: 30_000, ... }`。
- `backend/src/worker.ts:242-266`：`case "cron_notification_facts"` 动态 `import` 真实服务并调用 `runForwardDenialNotifications(defaultForwardDenialDeps())`；异常被 `console.error("[worker] cron_notification_facts failed:", ...)` 留痕而不是静默吞掉。
- `backend/src/services/notification-facts-trigger.ts:622-668`（`defaultForwardDenialDeps()`；`loadChannels` 在 `:645-658`，`deliverFacts` 在 `:659-667`）：生产依赖是**真**依赖——`collectAttention(...)` 取事实、`loadPlatformChannelConfig(db)` 读渠道、`enabledNotificationChannels(...)` 过部署级闸门、`createPrismaLedgerStore()` 写账本；配置读取失败时**不**谎称"这台安装没配渠道"，而是回落 + `warn(...)`（`notification-facts-trigger.ts:655-658`；抛错分支另有 `:592`）。
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

### 1.5 一个我**无法解释干净**的历史痕迹 —— 已由 Lead 说明来源（仍不作为证据）

Panel access log 里 `2026-10-06T19:16:25Z`（= 03:16 +08）有 `GET /api/notifications/deliveries/5` → **200**，意味着**当时**某个 scope 下存在 id=5 的账本行；而 03:45 我复跑同一路径（工作区 2 / 3 都试过）→ **404** `没有这条投递记录（本工作空间）`，且整表 0 行。

**事后说明（2026-10-07 04:0x，Lead 转述 `notify-center` 的 task-13 报告）**：那是 N4 真机验证时**临时插入 3 行、验完即删**，报告写明"零残留、`notification_delivery` 回到 0 行"；`docs/agent/productization-status.md:766` 亦记有该轮"零残留"。这与我的观测（整表 0 行）**自洽**。

**但这条说明不改变本报告的结论，也不升格为证据**：它是**实施方自述**且**不可回溯证实**（哪 3 行、什么状态都已不在库里）。原始判断——"这条历史痕迹不能支撑『端到端投递已达成』"——保持不变。它顺带说明了一件事：**"表里有行"可以是别人临时插入、验完就删的夹具**，所以投递证据必须自带**收件端**的收信记录（见 §8 复核清单）。

### 1.6 明确仍无端到端证据的环节

1. **公网 MTA**：SMTP 未配置（用户/密码/发件人为空）⇒ 从未真的发过一封邮件；
2. **Telegram 真投递**：无 bot token、`notification_channel` 零行 ⇒ 从未真的调用过 Bot API；
3. **"配好一个渠道 → 产生一条真实事实 → 账本出现 sent 行"** 的完整链：需要①有拒绝事实 ②有可用渠道 ③三者在真机上串起来——本次拓扑三者一个都不具备。

### 1.7 HEAD 推进后的新增事实：email 渠道**不再能从 UI 配置**（task-14 选了方案 (b)）

在 `57d2520` 上核到（读码 + **我自己跑**的定点测试）：

- `web/src/components/admin/settings-manager.tsx:42-62`：SMTP 归入**部署级**配置，页面给通知（"邮件发送读取的是部署环境的变量，因此管理端不提供 SMTP 写入项（写进这里也不会生效）"），历史 `SMTP_*` 行**被忽略、不删**。
- `backend/src/routes/admin.ts:326`：`PUT /api/admin/system/config/SMTP_*` → **400 `deployment_level_config`**（明确拒绝，不是静默无效）。
- `backend/src/services/mail.ts` 仍是"只读 env"（本次未变）⇒ 语义一致：**邮件只能由部署环境配置**。
- 我自己在干净检出（`/tmp/r6-misc-truth-57d2520`；`DATABASE_URL`/`AUTH_SECRET` 用一次性假值、存储走受控替身、Redis 指向死端口）跑：
  `bun test backend/src/services/__tests__/notifications/smtp-deployment-config.test.ts` → **5 pass / 0 fail**（PUT 全拒 + GET 不再列出 + 历史行仍在 + 其它键回归）。
- **对判定意味着什么**：这是**又一处"界面不再骗人"**的改进（对应 R5-A 的 N-F1：写进 UI 却没读者）。但它**没有**让邮件渠道变得"可用"——只是把"配了没用"改成"如实说不能在这里配"。所以通知这条的结论不变：**接线已真、端到端未证**；email 的端到端要成立，还额外需要部署环境真的给上 SMTP 凭据。

## 2. 落后理由 ②：高可用 / 多入口「无产品面」

**复核结论：已消除（读投影 + 挂载 + 三态可分，均有真机 HTTP 佐证）；但「多入口分组」这一层仍然是刻意不做的取舍。**

### 2.1 端点真的存在，且真的返回真事（只读 HTTP）

`GET /api/forwards/{1,2,3}/ha` → **200**（对 Integration Primary 工作区里 3 条转发逐一实测），逐字形状：

```json
{"forward_id":1,"preferred_ingress_node_id":null,"active_ingress_node_id":1,
 "policy":{"auto_failover":false,"auto_failback":false,"parse_error":null},
 "failover_candidate":{"status":"none","node_id":null,"reason":null},
 "preference_options":{"status":"ok","nodes":[{"node_id":1,"name":"Integration-IN-A-NODE","role":"ingress",
   "node_group_id":1,"is_active_ingress":true,"is_preferred":false,"can_be_preferred":true,
   "preference_rejection":null,"connection":"online","lifecycle":"active",
   "accepts_new_business":true,"admission_rejection":null}]}}
```

- 路由声明：`backend/src/routes/forwards.ts:641`（`forwardsRoutes.get("/:id/ha")`），鉴权走 `authorizeForward(c, id, "read")`（`:644`）⇒ 工作空间作用域，不是新的越权面。
- **期望 / 事实 / 候选三层在同一个载荷里就是分开的字段**：`preferred_ingress_node_id`（期望）vs `active_ingress_node_id`（事实）vs `failover_candidate`（平台此刻的候选判定）。
- 每个备选节点同时带**期望侧**（`is_preferred` / `can_be_preferred` / `preference_rejection`）与**事实侧**（`connection` / `lifecycle` / `accepts_new_business` / `admission_rejection`），事实侧复用 `projectUserNode`（`:722-731`），不是前端另算。

### 2.2 三态可分（读码，且与真机返回值对齐）

`backend/src/routes/forwards.ts:664-684`：
- `failover_candidate.status` = `none`（真的没有候选）/ `available` / `unavailable`（**查候选时抛异常**，`reason:"candidate_query_failed"`，且**不回显 SQL 细节**）。代码注释即写「「读不到」≠「没有候选」」。
- `preference_options.status` = `ok` / `unavailable`（`:736`），`unavailable` 时 `nodes: []` 但**不**能被读成"这个组里没有节点"。
- 真机实测拿到 `none` + `ok`；`available` / `unavailable` 两态我**没有**在真机上制造出来（需要改库或断依赖，超出只读纪律）⇒ 只算代码 + 组件测试级证据。

### 2.3 策略缺省即关被如实呈现（读码 + 真库 + 只读 HTTP 三处一致）

- 真库：`config.FAILOVER_POLICY = {"auto_failover":false,"auto_failback":false}`（只读 SELECT）。
- 只读 HTTP：`policy.auto_failover=false / auto_failback=false`（上面 JSON）。
- 读码：卡片对 `false` 只有一种呈现——`forward-ha-card.tsx:129-131`「平台未启用自动迁移：这条转发不会因为入口故障而自动改归属」+「这是本部署当前的策略真值（`FAILOVER_POLICY` 缺省即关），不是这条转发的问题，也不是「暂时」的状态」；判定函数 `policyEnabled()`（`:368-369`）只认 `=== true`，**没有任何乐观解释**；坏 JSON → `policy.parse_error` 单独一态，文案明说这是「配置坏了」而不是「运维没开」（`:138-139`）；卡片**刻意不提供策略开关**（`:140`「策略是只读的……避免界面与运维配置成为两份真相」）。
- 真机面板上这条转发的策略由**同一个读者**读出：`readFailoverPolicy()`（`forwards.ts:657`；候选判定 `pickFailoverDestination` 在 `:662-674`），与 failover 循环同一实现 —— 不存在"UI 一套、worker 一套"。

### 2.4 挂载与写路径

- 挂载：`web/src/components/forwards/forward-detail.tsx:306-308` `<ForwardHaCard forwardId={forward.id} />`（无条件渲染，不藏在 relay/direct 分支后）。
- 「首选入口」的写端点存在：`forwards.ts:548`（`PUT /:id/preferred-ingress`）。**我没有执行它**（写操作，超出只读纪律）⇒ 写路径只有代码级证据，卡片里"期望"的措辞纪律（`:227`「偏好只是期望……设置它不会立即改变归属」）我按读码接受。
- 干净检出定向测试（含该卡片）：`bun test .../forward-ha-card.test.tsx` 在内 146 pass / 0 fail（与 §1.3 同一次运行）。

### 2.5 仍然落后的那一层（不等于本条未消除，但要写清楚）

ForwardX 的 `ForwardGroup` 是**多入口分组**产品面（5 种模式、4 种 failover 策略、成员 priority、分组删除影响预览、链路自测）。TuneX 本轮给的是**单条转发视角的只读 HA 事实 + 一个期望（首选入口）**。也就是说：R5-A 说的"无产品面"（用户看不到任何 HA 事实）**已经消除**；"多入口分组管理"**没有**做，而且按专项记录它是**刻意不做**的取舍（后端无 ForwardGroup 概念，不为了对齐而新造）。

## 3. 落后理由 ③：诊断「Web 侧不存在」

**复核结论：已消除（有 Web 消费者、有挂载、状态可分、`enabled:false` 与「取不到」在服务端与客户端两侧都分得开）。**

### 3.1 有消费者、有挂载（读码）

- 服务端：`backend/src/routes/looking-glass.ts:80`（`GET /status`）、`:112`（`POST /nodes/:id/tests`）；挂载 `backend/src/app.ts:207`（`/api/looking-glass`），并在 `:83` 的挂载表里登记。
- Web 消费者（R5-A 当时 grep 为 0）：`web/src/lib/api/looking-glass.ts`、`web/src/components/nodes/looking-glass-panel.tsx`。
- 挂载点：`web/src/components/nodes/node-workspace.tsx:961` —— `{selectedIngress ? <LookingGlassPanel nodeId={selectedIngress.id} /> : null}`（用户域 `/nodes`，选中入口节点后出现；**不是**管理端专属）。

### 3.2 `enabled:false` 与「取不到」可分（两侧都分）

- 服务端（读码 + 真机）：`routes/looking-glass.ts:72-79` 注释与实现明确——**`enabled:false` 不返回 403**：「UI 需要能回答"为什么没有这个入口"，而一个会 403 的状态端点会让前端把"未启用"显示成"出错了"」。真机实测：`GET /api/looking-glass/status` → **200**
  `{"data":{"enabled":false,"switch_env":"LOOKING_GLASS_ENABLED","platform_admin_override":true,"method":"tcp_connect","caps":{...,"methods":["tcp_connect"]},"targets":"public-only（私网/回环/链路本地/多播/保留段一律拒绝）","caveats":[...4 条...]}}`
- 客户端（读码）：`looking-glass-panel.tsx:342-364` 的相位机 `loading / unavailable / permission_denied / disabled / admin_override / ready`，其中 `if (!readable) return "unavailable"`（取不到）与 `if (status.enabled) return "ready"` / `platform_admin_override ? "admin_override" : "disabled"`（读到了、但没开）是**两个分支**；`:752-757` 的注释把这条纪律写明：「取不到（不可读）与没开启（可读的 `enabled:false`）互不冒充；权限不足是第三种」。
- 文案也分：`:118-121` `disabled` =「平台未开启这项诊断」+ 说出开关名 + 找谁开；`:185` `unavailable` =「取不到……这不等于"平台没开"，也不等于"节点坏了"」。
- 真机在这个拓扑上会走 `admin_override` 分支（`platform_admin_override:true`），即"没开但平台管理员仍可用"，这与服务端字段语义一致（`:88-89`）。

### 3.3 状态与失败语义（读码 + 组件测试）

- 结果行是闭集外的"未知"分支（`resultStatusText`，注释「闭集之外的状态走"未知"分支，绝不显示成某一种成功」）；拒绝都带 `code` + `error_layer` 且发生在**发包之前**（`routes/looking-glass.ts:104-148`）。
- caveats 是**服务端下发**的诚实边界（不是前端编的）：真机返回值含「连上只证明 L3/L4 可达，不证明对端业务可用」「域名由面板解析、节点只拨固定地址：因此它不能回答「节点侧 DNS 能否解析该域名」」「不含 UDP/ICMP」「不含任何数据面载荷与凭据；每次发起与拒绝都会写审计」。

### 3.4 明确没有复核到的部分

- **没有跑过一次真实的 Looking Glass 测试**（`POST /nodes/:id/tests` 是 POST，虽然不改业务状态，但它会写审计并驱动 agent 发包；本次只读纪律下我不执行）⇒ "点一下真的能出结果"这一点，只有代码 + 该面板的组件测试支撑，以及 `state` 里 `platform_admin_override:true` 的可达性前提。
- 与 ForwardX 相比，方法集仍是 **1 种**（`tcp_connect`，`services/looking-glass.ts` 的 `LOOKING_GLASS_METHODS`，与真机 `caps.methods` 一致）vs 对方 **7 种**（我**自己**在参考副本 `server/lookingGlassAgentTasks.ts:3` 与 `server/routers/lookingGlass.ts:23` 读到 `ping/ping6/traceroute/traceroute6/mtr/mtr6/tcp`；R5-A 写的是 8 种含 iperf3，这一点我**没有**核到）。**R5-A 的落后理由里"Web 侧不存在"已消除，但"方法集落后一个量级"没有变。**

---

## 4. 对齐矩阵：受影响的行的"当时 → 现在"

> ForwardX 侧描述沿用 R5-A 的只读观察（**我另标**了我自己复核到的部分）；TuneX 侧一律是本评审自己的证据。未列出的行 = 本次**未重新审计**，沿用 R5-A 判定（不作为本报告结论）。

| 能力 | 当时（R5-A） | 现在（本评审，HEAD `57d2520`） | 判定变化 |
|---|---|---|---|
| **通知** | **落后**：渠道端点已提交但 admin UI 缺失；事实类**零调用者**；worker **零通知节拍** ⇒"配好也没有任何东西会被投递" | 三条都已经在了：`cron_notification_facts` 注册且在真机每 30s 一拍（日志 ≥15 拍）；渠道配置独立页 + 导航项 + 三态 UI；用户偏好与**投递账本读投影**都挂了（`settings-body.tsx:333/338`）。**但**：真库 `notification_delivery` **0 行**、`notification_channel` **0 行**、SMTP 无凭据、工作区无拒绝事实 ⇒ **端到端投递从未发生**；email 渠道 HEAD 起**只能部署级配置**（§1.7） | **落后 ⇒ 部分消除**（接线消除、端到端未证） |
| **高可用 / 多入口** | **落后**：无 ForwardGroup 概念；HA 只是 `SystemConfig` 里一个 JSON；用户看不到"为什么没切" | 用户侧有了**只读投影** `GET /api/forwards/:id/ha`（真机 3 条转发 200）+ 挂在 Forward 详情的卡片（`forward-detail.tsx:306-308`）；策略/期望/事实/候选/备选**四层字段分开**；三态 `none/available/unavailable` 与 `preference_options ok/unavailable` 可分（`forwards.ts:668-674` / `:736`）；"缺省即关"三处一致（真库 / HTTP / 文案）；**多入口分组**（ForwardX 的 5 模式 / 4 策略）仍**不做**（后端无该概念，属刻意取舍） | **落后 ⇒ 已消除（"无产品面"）**，余留"分组管理"是取舍而非缺失 |
| **诊断** | **落后**：Web 侧对 `/api/looking-glass/*` **零消费**，后端只 1 方法 | 有消费者（`lib/api/looking-glass.ts`）且**已挂载**（`node-workspace.tsx:961`，用户域选中入口节点即出现）；`enabled:false`（200，非 403）与"取不到"在服务端与客户端两侧都分开（相位机 6 值，`panel:342-364/752-757`）；五态 testid 与文案独立。**方法集仍是 1 vs 7**（我自核的上界） | **落后 ⇒ 部分消除**（入口消除、方法集仍落后一个量级） |
| **Forward 创建（多跳）** | **落后**：`middle_node_id` 在 web 全仓 0 命中 | 已接线：`forward-create-dialog.tsx:12` 引入 `ForwardMultihopSection`，`:157-171` 仅 relay 渲染、缺前置即禁提交；模型 `forward-multihop-model.ts` 与后端两段绑定判据同源。**我没有**在真机上创建过多跳转发（需写操作） | **落后 ⇒ 已接线（代码级）**；"5 跳 + chain/failover 中继模式"仍落后 |
| **升级** | **落后**：`TUNEX_AGENT_LATEST_VERSION` 缺省空 ⇒ 永不判落后；用户域无实报版本投影 | `GET /api/nodes/:id/upgrade-state` 已提交（`nodes.ts:305`）+ Web 客户端（`lib/api/node-upgrade.ts:76`）；`node-health-service.ts` 把基线**分类**成 `unset/comparable/uncomparable`（unset 仍=不判版本，但不再静默）。**缺省空 ⇒ 默认部署仍不提示"落后"** 这一点没变 | **部分消除**（可判定性/真话性改善，默认部署仍不提示） |
| **首启引导（面板自身）** | **落后**（矩阵混合行的后半） | 未变：`web/src/app/` 下没有 Setup 向导（只有 `(admin)/(auth)/(user)/page.tsx`） | 仍落后（本次只做"存在性"核对） |

**未受影响/未重审**：Agent 接入、DDNS、可观测（带宽行）、权限多租户、治理 —— 前两项我做了"存在性"核对（DDNS 仍 `cloudflare/huawei` 两种；用户域仍无带宽/主机资源序列），判定沿用 R5-A。

---

## 5. 退出条件 #10 的终局判定

### 判定：**未达成**（但性质已改变：从"通路不存在"降级为"未证实 + 覆盖面"）

**一句话可复核理由**：R5-A 的三条落后理由里 ②③（HA 无产品面、诊断 Web 侧不存在）**已被我用真机证据消除**，①（通知）**只消除了"没有生产调用者/没有渠道 UI"**——真库 `notification_delivery` **0 行**、`notification_channel` **0 行**、SMTP 无凭据、工作区无拒绝事实，**通知从未端到端投递过任何一条**；同时"核心日常体验"一侧仍有 4 项**未动的日常可见差距**（用户域无带宽/吞吐序列、DDNS 仅 2 家、诊断方法集 1 vs 7、默认部署永不提示版本落后）与 1 项一次性部署差距（面板首启无 Web 向导）⇒ 不能判"不再明显落后"。

**为什么不是"基本达成"**：判"基本达成"意味着"剩余差距不改变结论"。我不同意这一点，理由是通知那条**只有设计证据、没有任何一次真实投递**——而它恰恰是 R5-A 列的**第 1 号差距**；把"从未发生过"算作"不再明显落后"，与本次专项"不把未证实写成通过"的纪律冲突。

### 最短路径（1–3 件事，做完即可翻转）

1. **通知的一次真实端到端投递（第一优先，也是唯一"达标即翻转"的一件）**：在生产形态上跑通 `真实拒绝事实 → 打开的渠道 → 账本出现 sent 行 → 收件端确实收到`。走 email 需要先定部署级 SMTP 的交付形态（HEAD 已明确不在 UI 配置，那就必须在**部署文档 + 安装器**里给出可用的配置与一次测试发信）；走 Telegram 则需要一个可用 bot token。**并顺便演示至少一种失败态**（`rejected_target` / `secret_unreadable`）以证明"失败可见"不是空跑。
2. **补一条用户日常可见的宽度差距**（择一即可）：**用户域带宽/吞吐时间序列**（`host_metrics` 解析已在，缺用户投影）——这是 ForwardX 日常项里最直的一处；或**让默认部署能给出"版本落后/无法判定"**（现在 `unset` = 永不提示）。
3. （若要求与 ForwardX 诊断同量级）Looking Glass 补 1–2 种方法（ping / traceroute 或 mtr），把 1 vs 7 缩到同一量级。

### 关于退出条件 #1 现在"未达成"（task-31 部署演练结论）—— 我的裁定

**#1 不影响 #10 的判定方向，但我不把它计入 #10 的证据。** 理由：`#10` 问的是**运行期日常体验**是否明显落后于 ForwardX，`#1` 问的是**能不能按文档把面板部署起来**——两者是不同阶段的门槛，把它们互相折算会让两个条件都失去分辨率（这正是"一个条件救另一个"的典型失效模式）。我据此：①**没有**把 task-31 的结论写进 §1–§3 的任何证据；②仍然独立判 #10 未达成（理由见上）；③但要说明一句**判断口径上的连带影响**：#1 未达成意味着"整体产品化距可宣称不落后还有距离"，所以**我不会因为三条理由里两条被消除，就把 #10 抬成"基本达成"来给出一个更好看的结论**——门槛应当是"至少一次真实端到端投递 + 至少一条日常宽度差距被补齐"。若 Lead 认为 #1 的修复（task-34/35）完成后应重新评估 #10，我同意**重评**，但那时的翻转依据仍应是 §5 的最短路径，而不是 #1 的状态本身。

---

## 6. 未复核 / 未验证清单（必须与结论一起读）

### 6.1 我没有做的验证

1. **没有浏览器**：全程没有打开页面、没有截图、没有 DOM 取证。所有"页面会显示成 X"的结论都只是「组件行为（渲染测试/读码）+ 已挂载（读码）」。
2. **没有执行任何写操作**：`PUT /api/forwards/:id/preferred-ingress`、`POST /api/looking-glass/nodes/:id/tests`、渠道 PUT/DELETE、免打扰 PUT、`notification-channel` 配置——全部只读核对（代码 + 只读 GET）；因此"设置首选入口真的能写成"、"LG 点一下真的能出结果"只有代码级证据。
3. **`failover_candidate=available` / `preference_options=unavailable` 两态没在真机造出来**（需要改库或断依赖）。
4. **多跳创建路径没有真机跑通**（需写操作），只有"已接线 + 提交参数"的代码证据。
5. **没有跑全量 `bun test` / `next build`**（本评审是只读审计，不是回归门禁）。跑过的是：干净检出 `tsc --noEmit`（web，exit 0、零诊断）、web 5 个定向组件测试（146 pass/0 fail）、backend SMTP 真话化测试（5 pass/0 fail）。
6. **`n4-0314` 镜像与 HEAD 的等价性没有证明**（§0.2 给了反例）；真机结论按镜像口径读。
7. **§1.5 那条 `deliveries/5 → 200`（03:16）→ 现在 404/整表 0 行**：来源已由 Lead 说明（`notify-center` task-13 真机验证临时插 3 行、验完即删），与观测自洽，但属**实施方自述、不可回溯证实**；它没有被用作任何结论。

### 6.2 从文档看到、但我**没有**复核的

| 内容 | 来源 | 状态 |
|---|---|---|
| ForwardX 的 `Setup.tsx`（面板首启向导 748 行）、`HostMonitor.tsx` 带宽/CPU 图表、`ForwardGroup` 5 模式 / 4 策略 / priority / 删除影响预览 / 链路自测、SMTP 页的"测试请求" | R5-A §2/§5 | **未复核**（我没有打开这些文件） |
| ForwardX 支持 8 种 Looking Glass 方法（含 iperf3） | R5-A §1 #8 | **部分复核**：我自核到 **7 种**（见 §3.4），iperf3 未核到 |
| ForwardX DDNS ≥6 provider | R5-A §2 | **部分复核**：我自核到 `disabled/cloudflare/webhook/huaweicloud/aliyun/tencentcloud`（5 家 + disabled），与"≥6"一致 |
| `status §3.34` 的对账表 | 被评审对象 | **按纪律未作为证据**（只用来定位需要复核的对象） |
| task-31 的部署演练结论（缺 `LICENSE_SECRET` 阻断启动、钉版本静默回退陈旧镜像） | Lead 转述 | **未复核**（属 #1 的证据面，我按 §5 的裁定把它排除在 #10 的证据之外） |
| Lead 的验收截图 `accept-*.png` 与 `acceptance-final.json` | `/tmp/tunex-harvest-integration-20261006/` | **未作为证据**（实施方产物）；只在 §1.5 里作为"这条历史痕迹可能来自验收动作"的**排除性**线索提及 |

---

## 7. 本次评审的自我边界

- 本评审**没有能力**回答"用户实际用起来爽不爽"——那需要真实用户/浏览器时长；我回答的是"宣称与已核实事实之间的差"。
- 我**没有**、也不应该替实施方决定"要不要做多入口分组/带宽序列"这类产品取舍；§5 的最短路径只列"能翻转判定"的最小项。
- 报告里所有"已消除"都**限定在它自己的那句落后理由的语义内**（例如诊断的"Web 侧不存在"已消除 ≠ 诊断能力已追平 ForwardX）。

---

## 8. 承接：`task-36`（通知端到端投递）证据的独立复核清单（待办，本评审人执行）

Lead 已把 §5 最短路径的第 ① 条建为 `task-36`（交 `notify-center`：假 SMTP 跑一次真实端到端投递，成功 + 失败 + "保存≠投递"三条）。**其证据将由本评审人独立复核**（仍是只读：我只检查它的证据与库/日志是否自洽，不自己发信）。预先写清**我只接受什么**，避免"证据看起来齐、其实不可复核"：

| # | 复核点 | 我会怎么查（只读） | 不成立的样子 |
|---|---|---|---|
| 1 | **收件端真有记录**（最硬的一条） | 看假 SMTP 侧记录到的 `Subject`/`To`/正文片段 + **时间戳**，并与账本行 `created_at` 对表 | 只有账本 `sent` 行、没有收件端记录；或收件记录是手工构造的文本 |
| 2 | **因果链是"经 worker 节拍"**，不是手工调用 | 该 worker 日志时间窗内能找到对应拍（`cron_notification_facts` 且有事实/投递摘要行） | 只有"直接调用投递函数"的脚本输出；或时间顺序不自洽（账本行早于事实被写入） |
| 3 | **事实是真实事实** | 库里那条被制造的拒绝事实（`apply_status` 等）与账本 `source_kind/source_id`、`reason_code` 对得上 | 事实与账本行对不上（硬凑的） |
| 4 | **收件人来自用户自己** | 账本 `target` 的脱敏形态（`***@example.com` + `targets_count`）与用户真实邮箱一致；收件端 `To` 与之一致 | 出现"猜出来的 chat id / 别人的邮箱" |
| 5 | **失败路径同样端到端** | 失败账本行（`failed` + `failure_reason` + `attempts`）+ N4 读投影把它呈现出来（端点响应或组件文本） | 只演示成功；或失败被折叠成"没有记录" |
| 6 | **"保存 ≠ 会被投递"** | 渠道已保存但部署开关未开时留 `not_configured`（有行、有原因） | 什么都不留（无法区分"没配"与"没发生"） |
| 7 | **清理对照可复现** | 我自己**再取一次**库计数（`notification_delivery`/`notification_channel`/`tunnel.apply_status`）与它的"清理后"对照 | 只给"清理后"、没有"清理前"；或库里残留 |
| 8 | **任何绕过都写成发现** | 若为走通流程手工改了库（如直接 UPDATE 账本状态），报告必须显式写出；**我按"绕过的部分不计入达成"处理** | 用绕过达到的效果当作"真实投递" |

复核时我会**重新钉 SHA 与时间戳**（届时 HEAD 很可能又推进），结论按"支撑 / 部分支撑 / 不支撑 + 缺什么"写回本文件的新小节，**不改写 §1–§6 已成立的结论**（那些建立在 `2037d05`/`57d2520` 上）。

---

## 9. `task-36` 证据的独立复核结论（2026-10-07 04:30–04:50 +08）

### 9.0 钉点（本次复核）

| 项目 | 值 |
|---|---|
| 复核开始 | 2026-10-07 04:30 +08 |
| HEAD（复核基线） | `8a4ba98183bb71891ecb488244c237137bdce816`（04:30:39 `docs(agent): task-36 端到端投递证据落库（含与预期不同的零账本行发现）+ 在途门禁红标注`） |
| 被复核证据 | `docs/agent/productization-status.md` §3.40 + `/tmp/t36-{setup-tick,present,unreadable}.mjs`、`/tmp/t36-smtp.py`（脚本本体）+ 我自己的只读库/镜像/日志检查 |
| **复核期间的拓扑变化** | scratch 的 panel/worker 在 **20:40:30–20:40:47Z（= 04:40 +08）被重建**，镜像由 `n4-0314` 换成 `final48-0439`。⇒ **t36 实验期（20:13–20:21Z）那个 worker 化身（`n4-0314`，19:15Z 启动）的日志已经不可得**；我 04:33 读到的"≥15 拍"是在重建**之前**取的，属"当时观测"（已记在 §1.1） |
| 只读手段 | `git archive` 读码；对 `tunex-it-mysql` 的只读 SELECT；`docker logs -t`；两个**唯一名 `--rm` 临时容器**只读读取镜像内 `/app/src/worker.ts`（用完自动删除，未动任何拓扑） |

### 9.1 逐条判据

| # | 判据 | 结论 | 依据 / 缺什么 |
|---|---|---|---|
| 1 | **收件端真有记录** | **部分支撑** | 支撑：`/tmp/t36-smtp.py` 确实是**会先发 220 问候语**的 RFC 5321 形态服务器，且在 `DATA` 结束后打印 `MESSAGE-BEGIN` + 完整报文 + `commands=…`（2526 端口先发 `554`）；账本/渠道计数与它引用的 id 区间自洽（见 #7）。**缺**：`t36-smtp` 容器已删，**原始终端记录没有任何落盘副本**（我在 /tmp 做过有界搜索：只有脚本，无 transcript 文件）⇒ 我能核到"它会打印什么"，但**无法独立核对它实际打印了什么** |
| 2 | **因果链是"经 worker 节拍"** | **不支撑** | ① 它自己的实验脚本 `/tmp/t36-setup-tick.mjs` **直接 `import { runForwardDenialNotifications, defaultForwardDenialDeps }` 并在进程内调用**（它 §⑤ 也如实写了"未经 BullMQ 调度器"）⇒ 调度→job→handler 这一段**没有被这次实验覆盖**；② 我另行核到调度器那一半**是**接线的：临时容器读 `n4-0314`（实验期镜像）与 `final48-0439`（现在）的 `/app/src/worker.ts`，都有 `case "cron_notification_facts"`（:242）→ `runForwardDenialNotifications(defaultForwardDenialDeps())`（:250）→ 非空摘要 `console.log`（:254）。**缺**：一次**由调度器产生**的投递（例如让临时事实至少跨一拍，并贴出 `[worker] cron_notification_facts: {…,"built":1…}` 那一行）；或至少给出 t36-a/b/c 的 `DATABASE_URL`/`REDIS_URL`，证明"投递那个库 = 我观测的那个库" |
| 3 | **事实是真实事实** | **部分支撑** | 支撑：事实载体是**真实 schema 的真实行**（`tunnel.apply_status='error'`、`category='port_forward'`），且与代码候选集口径一致：`createForwardDenialDeps` 的候选查询就是 `category='port_forward' AND (apply_status='error' OR id IN 未闭合拒绝)`（`notification-facts-trigger.ts:559-566`）。**缺**：它是**操作者 SQL 直接 INSERT** 的行，不是真实下发失败产生的；账本行的 `source_kind/source_id/reason_code` 与来源行的对应关系**已随清理消失**，我无法复核 |
| 4 | **收件人来自用户自己** | **支撑** | 代码：`resolveTargets` 取 `recipient.email` / `recipient.tg_id`，受众来自 `workspaceAnnouncementAudience(db, workspace_id)`（`notification-facts-trigger.ts:464-474`、`:479-495`）⇒ 目标来自**成员自己的资料行**，不是猜的。独立锚点：我读 `tunex-it-mysql` → `user.id=2` 的 email = **`tunex-it-e2e@tunex.local`**，与它记录的 `To/target` 逐字相同，也与 `state.json` 的登录用户一致 |
| 5 | **失败路径同样端到端** | **部分支撑** | 支撑（机制）：三条码的路径我都能在代码里核到——`transport_error`（mail 的 `smtp_error` → delivery.ts:265）、`rejected_target`（`validateConfig` 过滤后无合法目标 → `recordRejection`）、`not_configured`（delivery.ts:616）；"554 问候语 ⇒ 一条命令都不发"与 `mail.ts` 的问候语判定一致。**缺**：账本行与那份 `summary{total:6,sent:3,failed:3,…}` 响应**都已随清理消失**，我没有可复核的运行时载体（无快照/录屏）；而读投影的**契约与呈现纪律**我在 §1.3 已独立验证过（脱敏、闭集 400、五态、`empty ≠ 没有失败`） |
| 6 | **"保存 ≠ 会被投递"** | **不支撑（与简报第 3 条不符）——但已如实报告** | 它报的实际行为是**零账本行**，我独立复核该根因**成立**：事实路径只把 `enabledNotificationChannels(...)`（已被 `isConfigured` 过滤）交给投递层（`notification-facts-trigger.ts:645-658`），而 `not_configured` 的落账分支在 `notification-delivery.ts:607-618` ⇒ 对事实路径**不可达**（只在该拍内配置变坏时可达）。**后果**：账本层分不出"渠道保存了但没启用"与"什么都没发生"；用户可见层靠 UI 文案补（`notification-deliveries.tsx:93-95` 等，§1.3 已核）。**缺**：要么按它的建议改投递契约（保存但未生效也留一行），要么在渠道页明说"未启用的渠道不会留账" |
| 7 | **清理对照可复现** | **支撑** | 我自己现取（只读 SELECT，04:33）：`workspace 4 / workspace_member 4 / tunnel 3 / notification_channel 0 / notification_delivery 0 / user.tg_id 非空 0 / slug LIKE 'n36-%' 0` —— 与它报的 after 数字**逐项一致**。独立佐证（AUTO_INCREMENT，现有 0 行的表仍留有"曾经存在"的痕迹）：`notification_delivery=22`（它引用的成功行 id=8 落在其中）、`notification_channel=15`（它引用的渠道 id **12/13/14 正好是 15 之前的三行**）、`workspace=9`（它引用临时 ws 7/8）、`workspace_member=9`、`tunnel=11`（它报 tunnel 8→3） |
| 8 | **任何绕过都写成发现** | **支撑** | §③（零账本行的裁定）与"未经 BullMQ 调度器"都写成了发现，没有把绕过包装成达成 —— 这也正是我判 #2 不支撑的依据 |

### 9.2 对 #10 翻转要件 ① 的总判：**部分支撑**

- **被支撑的一半**：`渠道启用 → 投递层 → 真实 SMTP 会话（含 fail-closed 的 554 形态）→ 账本行 → 用户可见投影` 这条**投递机制**，有脚本 + 计数 + 代码 + 我自己的库/镜像检查共同支撑（#1/#3/#4/#5 的"机制"部分）。
- **不被支撑的一半**：**调度器那一拍**（#2）与**收件端原始记录**（#1）—— 前者被实验设计刻意绕过，后者随容器删除灭失。
- **#10 判定不变**：仍是**未达成**。但本条的性质进一步收窄：从"从未投递过"变成"**有投递机制的实验证据（部分）、缺调度器与收件端原始记录**"。

### 9.3 对 §1 的**口径更新**（不改结论、不改 §1 正文）

§1.4/§1.6 写的是"**通知从未端到端投递过任何一条**"——那是**基于我自己观测范围内**（真库 0 行 / 0 渠道 / SMTP 空 / 0 事实）的判断。`task-36` 之后，正确的读法是：**"在本评审自己的观测范围内没有；task-36 提供的是一次部分支撑的实验记录（§9），其中收件端原始记录与调度器环节仍缺"**。§1 的结论（通知只算部分消除、不足以翻转 #10）不变，因为翻转门槛要求的正是这两条缺口。

### 9.4 两条**流程教训**（给专项，不是给某个人）

1. **依赖"运行中容器"的证据必须在容器存活期内落盘**：scratch 的 panel/worker 在 04:40 被重建，旧化身（`n4-0314`）的日志随之消失 —— 我 04:33 读到的"≥15 拍"因此成了**唯一**还存在的调度器证据。建议关键日志在重建前 `docker logs > /tmp/<task>/…`。
2. **收件端记录应落成文件**：`t36-smtp` 的 `MESSAGE-BEGIN … commands=…` 输出本该是一份可带走的 transcript（一行重定向即可），但容器 `rm` 之后它只存在于实施方会话里 ⇒ 复核只能到"脚本会打印什么"，到不了"它打印了什么"。

---

## 10. `task-41` 补齐证据的独立复核结论（2026-10-07 05:03–05:15 +08）

### 10.0 钉点

| 项目 | 值 |
|---|---|
| 复核时间 | 2026-10-07 05:03–05:15 +08 |
| HEAD（复核基线） | `65dd865f6eefd46ef74e0dcc24cab53168497a2a`（05:02:17 `feat(backend): HA 成员投影 + throughput 只读端点（不含仍在途的 LG 方法表）`） |
| 被复核证据 | `/tmp/t41-smtp.log`（1645 B，**已保留**，副本在 `/tmp/tunex-harvest-integration-20261006/t41-smtp.log`）、`/tmp/t41-facts.mjs`、`/tmp/t41-created{,2}.json`、`/tmp/t41-ws.txt`、Lead 转述的 worker 日志与账本行 |
| 拓扑变化 | scratch 的 panel/worker 在 **~05:02:40 又重启一次**（复核开始时 `Up 46s/52s`）；`t41-*`、`t36-*` 容器均已不存在；`tunex-it-mysql` / `tunex-it-redis` 未重启（Up 4h） |
| 我的只读手段 | 读文件（transcript/脚本/json）；`tunex-it-mysql` 只读 SELECT（含 `information_schema`/`SHOW DATABASES`）；`tunex-it-redis` 只读 `DBSIZE`/`KEYS`；HEAD 读码核对报文格式；`docker ps -a` |

### 10.1 逐条判据（相对 §9 的变化）

| # | 判据 | 本次结论 | 相对上轮 | 依据 / 缺什么 |
|---|---|---|---|---|
| 1 | **收件端真有记录** | **支撑** | ↑（上轮：部分支撑） | `/tmp/t41-smtp.log` 是**落盘的机器记录**：`LISTENING 20:55:12` → `CONNECT from 172.33.0.46:44290`（21:00:23）→ `GREETING 220` → `EHLO/AUTH/MAIL FROM/RCPT TO/DATA` → `MESSAGE-BEGIN…MESSAGE-END`（`To: tunex-it-e2e@tunex.local`、`Subject: [TuneX][error] forward_apply_error`、正文含原因码/严重度/资源 `tunnel 11（t41-forward-…）`/来源/发生时间 `2026-10-06T21:00:18.133Z`/诊断码 `port_in_use` + 结尾一句）→ `COMMANDS EHLO AUTH MAIL RCPT DATA` → `QUIT` → `CLOSE`。**且报文体与 HEAD 渲染器逐字一致**（`notification-delivery.ts:183` 主题格式、`:190-191` 原因码/严重度、`:198` 诊断码、`:201` 结尾句），凭据没有出现在任何一行（`AUTH` 只回 `334`/`235`）。**残余**：我无法重放；该文件由实施方保留（其真实性靠"格式/时间戳/邮箱/事实工件互锁"支撑，不是靠自述） |
| 2 | **因果链经 worker 节拍** | **部分支撑** | ↑（上轮：不支撑） | **支撑的一半（我自己核的）**：① `/tmp/t41-facts.mjs` **只做插入**（`create`/`observe`/`counts` 三个分支，**没有任何投递函数调用**）⇒ 这次不是 in-process 投递；② **等拍时间签名**：事实建于 `21:00:18.250`，SMTP 首连在 `21:00:23`（差 ~5 s）；失败案例事实建于 `21:01:10.369`，三连击在 `21:01:23`（差 ~13 s）——两次都符合"等下一拍"，而**不符合**"脚本内立刻投递"（那会是亚秒级）。③ 镜像内 `worker.ts:242/250/254` 的接线我在 §9 已用临时容器核过。**缺**：worker 自己的那一行日志（`registered 8 cron schedulers` 与 `[worker] cron_notification_facts: {…"built":1…}`）**没有落盘**——我在 /tmp 有界搜索过，没有任何 worker 日志文件；因此"那一拍由 BullMQ 调度器触发"仍缺**可直接复核**的载体 |
| 3 | **事实是真实事实** | **部分支撑** | =（不变） | 真实 schema 的真实行；候选集口径一致（`notification-facts-trigger.ts:559-566`）。**仍是操作者 SQL 直插**（它自列），且其库不可复核（见 §10.3）。`/tmp/t41-created{,2}.json` 至少把"插入时间 + 脚本不投递"这条说明**落成了文件**，比上轮好 |
| 4 | **收件人来自用户自己** | **支撑** | =（不变） | transcript 的 `RCPT TO:<tunex-it-e2e@tunex.local>` + 正文 `To:` 头；配合我此前核过的 `user 2` 邮箱与 `state.json` 一致（`notification-facts-trigger.ts:464-495` 取成员自己的资料行） |
| 5 | **失败路径端到端** | **支撑（收件端）/ 部分支撑（账本侧）** | ↑ | **收件端侧是硬证据**：失败案例三次 `CONNECT … GREETING 554` 后**直接 CLOSE、零命令**（transcript 原文）——这与 `mail.ts:170` 的"问候语不是 220 就一条命令都不发"逐字对应；三次连接与 `NOTIFICATION_MAX_ATTEMPTS=3`（`notification-delivery.ts:451/676`）一致。**账本侧**（`id=23 status=failed failure_reason=transport_error attempts=3`）仍不可复核（§10.3） |
| 6 | **"保存 ≠ 会被投递"** | **不支撑（与简报第 3 条不符）** | =（不变） | 与 task-36 相同：实际是**零账本行**，根因成立且我独立复核过（事实路径只拿到 `isConfigured` 过滤后的渠道 ⇒ `notification-delivery.ts:616` 的 `not_configured` 落账分支不可达）。**缺**：改投递契约，或在渠道页明说"未启用的渠道不会留账" |
| 7 | **清理对照可复现** | **部分支撑** | ↓（上轮：支撑） | live 侧我核到：`t41-*` slug 残留 **0**、`notification_channel`/`notification_delivery` 均 0 行、Redis `db9 DBSIZE=0`、无 `t41-*` 容器。**但它报的 before/after 与账本行都不在可复核的库里**（§10.3）⇒ 这条从"支撑"降为"部分支撑" |
| 8 | **任何绕过都写成发现** | **支撑** | =（不变） | ① SQL 直插事实 ② Redis 用 db9（含代价） ③ 同窗口另 7 条 job ④ 未查 `node.status` —— 四条都写成发现 |

### 10.2 我这一轮**新核到的**（可复核）

1. transcript 与 HEAD 渲染器**逐字一致**（主题、原因码、严重度、诊断码、结尾句），且 `DATA` 段没有任何凭据。
2. **554 分支的 fail-closed 有收件端证据**（三次 554 ⇒ 零命令），与 `mail.ts` 的判定同源。
3. `/tmp/t41-facts.mjs` **确实不投递**（对比 task-36 的脚本，那次是 in-process 调用）——这是"经调度器"这一条**实质性的**方法改进。
4. Redis `db9 DBSIZE=0`、`db9` 无 `*notification*` 键、`db0 DBSIZE=2717`（scratch 自身负载）——与它"刻意用 db9 以免抢队列"的说法一致，且清理到位。

### 10.3 一个**新的具体疑点**：这次投递发生在**哪个 MySQL**？（必须澄清）

事实（我自己读的）：

- 活的 scratch MySQL 是 `tunex-it-mysql`（`tunex_it_ctrl` 上唯一别名 `mysql`；`audit_log` 最新写入距我查询仅 7 s，**证明它是活的、没有被停**）。
- 它的 AUTO_INCREMENT **在 t41 前后完全没有动**：`workspace=9`、`tunnel=11`、`notification_delivery=22`、`notification_channel=15`（我 04:33 测过同一组值，05:05 再测仍相同）；`SHOW DATABASES` 只有 `tunex`，**没有克隆 schema**；`slug LIKE 't41-%'` = 0。
- 而 t41 引用的 id 是 `workspace 9/10`、`tunnel 11/12`、`notification_delivery 22/23` ⇒ 这要求那个库的"下一个 id"正好是 **9 / 11 / 22**。

⇒ 结论只有两种解释：**(a) 它跑的是一个"活库的克隆"**（mysqldump 会把 AUTO_INCREMENT 一起写进 CREATE TABLE，所以克隆的 next-id 恰好等于活库当时的值 —— 这完美解释 9/11/22，也解释它报的 4/4/3 基线）；**(b) 它跑了活库，之后有人把活库从 t41 之前的 dump 还原过**（这会让其它表的 AI 也回到同组值，同样自洽）。**我无法从外部区分 (a)/(b)**，但两种情形下**它引用的账本行都不再可复核**。

**两轮 id 的对照（说明差别，不夸大）**：活库 `workspace` AI=9 ⇒ id 5–8 在活库里被消费过，而 task-36 的 `present.mjs` 用的正是 ws **7/8**（与它报的 6/6/5→4/4/3 相容）⇒ **t36 的 id 与活库相容**（因此我倾向它写的是活库，但这只是相容性推断，不是证明）。而 task-41 的 `created.json` 说自己建了 ws **9/10**、tunnel **11/12**、ledger **22/23**：若也写活库，`workspace` AI 应变成 **11**、`tunnel` 变 **13**、`notification_delivery` 变 **24**；实测三者仍是 **9 / 11 / 22** ⇒ **task-41 的账本行与这两个 workspace 不在活库里**（这一点是确定的，与 (a)/(b) 之争无关）。这也说明"写同一个 MySQL"这句（转述）**不成立**，应修正为"克隆库（或等价的一次性库）"。

> 这不是"造假"的暗示：**在不碰共享活库的前提下做实验是更好的卫生**。问题只有一个——那样一来，**账本行与清理对照就没有第二方能复核的载体**。要闭合它，任选其一：
> ① 说清库的出处（容器名 + 怎么产生：dump 还原？），并**把 dump 时间一并给出**；
> ② 或者下一轮直接**在活库上做**（写完立刻贴出宿主侧 `SELECT`、清理后我再抽查 AI），像 task-36 那样；
> ③ 或者把账本行的**宿主侧读取输出落盘**（`docker exec … > /tmp/t41-ledger.txt`），与 transcript 同等对待。

### 10.4 对 §9.1 第 7 条判据的**更正**（不改 §9 正文）

§9.1 我判"清理对照 = 支撑"，其中一条依据是"`notification_delivery` AUTO_INCREMENT=22 佐证它引用的行确实存在过"。**按 §10.3 的新事实，这条推断要收窄**：活库的 AI 只能证明"这个库里历史上被消费过这些 id"，**不能**证明**是它引用的那些行**。因此 §9.1 #7 的正确判定应是**部分支撑**（live 侧无残留可核，但对照是在我无法访问的库上做的）。其余 §9 结论不受影响。

### 10.5 总判：翻转要件 ① 仍为 **部分支撑**（明显前进，但不足以抬到"支撑"）

- **前进的部分（实质性）**：① 收件端 transcript **落盘且与 HEAD 渲染器逐字一致**；② 554 分支拿到**收件端**的 fail-closed 证据；③ 事实建立脚本**确实不投递**，两次"事实→连接"延迟都是**等拍签名**（~5 s / ~13 s）；④ 绕过项全部写成发现。
- **仍缺的三件小事（缺一即不能算"支撑"）**：
  1. **worker 自身日志落盘**（`docker logs t41-worker | grep -E "cron_notification_facts|registered" > /tmp/t41-worker.log`）——这是把"经调度器"从**推断**变成**直接证据**的唯一一步；
  2. **库的出处**（§10.3 的 ①②③ 任选）；
  3. **#6 的契约**（改投递契约，或渠道页明说"未启用的渠道不留账"）——这条不是"证据"问题，是产品契约问题。
- **因此 #10 的判定不变：未达成**。要件 ① 从"部分支撑"到"支撑"只差上面第 1、2 件（第 3 件属独立小切片）；第 ② 条（日常宽度差距：带宽序列 / 版本落后可判定）与第 ③ 条（LG 方法集）仍按 §5 的最短路径另算。


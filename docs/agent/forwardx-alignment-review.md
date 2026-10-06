# TuneX × ForwardX 产品对齐审查（task-23）

- **审查人**：`align-review`（持久队友，只读审查，唯一写入范围 = 本文件）
- **状态**：✅ 已完成（10 条退出条件已判定；11 行对齐矩阵、7 条已复核的「能力有、路径不通」、6 项刻意不同复核、Top3 差距均已落盘）
- **分支**：`productization/tunex-harvest`
- **基线**：`origin/main..HEAD`
- **纪律**：ForwardX 为 **AGPL-3.0-only**；本审查**只研究行为**，不复制代码、不复制文案字符串；所有 ForwardX 证据只给行为描述与（如引用）行号定位，不给可复制代码。
- **判定口径**：本文件不做"已完成/已验证"声明，只做判定；每条判定附可复核证据（文件:行 或 命令）。

---

## 摘要（三句）

1. **退出条件：10 条里 2 条达成（#2 首台 Node、#9 无概念泄漏）、6 条基本达成（#1/#3/#4/#5/#7/#8，其中 #3/#7 的主因是"在途，未评"）、2 条未达成（#6、#10）** —— 未达成的是 #6 通知（**投递链完全没接线**，渠道配好也没有任何东西会被发出）与 #10 整体体验（矩阵 11 行里落后 5 行，且落后项是"通路不存在"而非"少个开关"）；#1 的扣分点是**面板首启无 Web 向导**（ForwardX 有 748 行分步向导，TuneX 靠手改 `.env`）。
2. **"能力有、路径不通"本轮新增两条硬证据**：**Looking Glass 后端只支持 1 种方法（`tcp_connect`）且 Web 侧零消费**（`grep -rni looking glass web/src` = 0）；**SMTP 管理配置写进 `SystemConfig` 但投递层只读 `process.env`**（全仓 `SMTP_HOST` 非测试命中只有 `env.ts:74`）——即"保存成功但永不生效"。同时**复核确认 DDNS 写入路径的解耦是真修**（独立 30s 节拍、不 import failover、取数条件与策略无关），且**多跳后端闸门在生产路径上已经是开的**（`forward-rollout-exec.ts:2348` 传 `multiHopImplemented: true`），缺的只有 Web 接线。
3. **距 #10 的 Top3 缺口**：①通知投递（worker 加节拍 + admin 独立目录页 + 免打扰扩到事实域）；②HA/多入口（后端**无 ForwardGroup 概念**，至少要一条"为什么没切"的读投影）；③诊断（Looking Glass 的 8 方法差距 + Web 零消费；升级缺 `upgrade-state` 与版本基线）。**刻意不同项里有一条建议改判**：ForwardX 的"分组切换通知"不是更细的开关而是**事实类通知**，TuneX 已写好 `runForwardDenialNotifications` 却没有调用者 ⇒ 应记为"做了没接"，不应继续归入"刻意不做"。

---

## 0. 判定面（本次审查覆盖的 diff 边界）

> 状态：✅ 已复核（命令输出见附录 A.1）

**已提交部分**（`origin/main..HEAD`，共 18 个提交，`da4c4cf` → `1199324`）：
`git diff origin/main --stat` = **130 files changed, 24103 insertions(+), 845 deletions(-)**，按目录：

| 区域 | 文件数 | 增 | 删 |
|---|---|---|---|
| `web/src` | 90 | 16809 | 691 |
| `backend/src` | 20 | 4960 | 26 |
| `docs/agent` | 8 | 2102 | 0 |
| `agent/*`（Go + Dockerfile + README） | 9 | 215 | 128 |
| `docs/production-deploy.md` | 1 | 32 | 0 |
| `.env.production.example` | 1 | 14 | 0 |
| `scripts/perf` | 1 | 5 | 1 |

**在途部分**（工作树有改动但**未提交**）：取样时 `git status --short` = 24 个已跟踪文件被改 + **30 个未跟踪新文件**。逐项标注于本报告各处，**凡在途项一律标「在途，未评」**，不计入任何"达成"判定。
> 审查过程中在途集合发生变化（Lead 把部分未跟踪文件加入索引，我的文件也一度因此触发一次 FS 版本冲突）⇒ §3.A 的结论均以**取样时刻的 HEAD + 工作树内容**为准，在途项的行号/大小可能已变。

**本审查的判定口径声明**：
- "达成" = 我在**已提交代码**里找到用户可达路径，且**不止有后端**；用户域/管理域的差异分别标注；
- 证据强度分两档：**读码 + git**（本报告全部采用）与 **只读 HTTP/浏览器 E2E**（本报告**未采用**，见 §6）；两者不混用；
- 文档（`productization-status.md`）里的自述**不作为本报告的判定证据**，只作为被检验对象。

## 1. 退出条件 10 条逐条判定

> 状态：✅ 已复核（10 条全部判定；标「在途，未评」的部分不计入任何达成）

| # | 退出条件 | 判定 | 证据（可复核） |
|---|---|---|---|
| **1** | 新用户可以快速部署 TuneX | **基本达成** | `README.md:25-46` 给出四步路径（clone → `cp .env.example .env` → `docker compose up -d --build` → `curl /healthz`），`.env.example` 已跟踪（1194 B），`docs/production-deploy.md` 存在且有 §3.1 升级校验章节。**扣分项**：`README.md:56-60` 把 Agent 部署推给"先在管理界面创建 Node"——即**部署第二台机器需要先有一个能登录的面板**，这正是 #2 的下游；此外 `/healthz` 在 README 里写死 `localhost:8787`（`README.md:44`），未说明生产反代下的对应关系。 |
| **2** | 可以从 Web 指引完成第一台 Node | **达成** | 已提交闭环三件套：`web/src/components/nodes/node-onboarding.tsx`（写入引导）、`web/src/lib/node-install-polling.ts`（`INSTALL_POLL_INTERVAL_MS=10_000`，`INSTALL_POLL_MAX_MS=30min`，`NodeInstallPoller` 带 single-flight/deadline/dispose）、`web/src/components/admin/node-install-waiting.tsx`；首启入口 `web/src/components/dashboard/first-run-panel.tsx` 由 `dashboard-body.tsx` 消费；成功 CTA 落到 `/forwards?ingress_node_id=`（`status §3.12 B)` 记录真实浏览器 + 真 Agent 容器 5s 内 `online`）。 |
| **3** | 可以直观创建 Direct / Relay / Multi-hop | **基本达成（Multi-hop 在途，未评）** | **Direct / Relay 已提交**：`forward-create-dialog.tsx` 用 `draft.mode === "relay"` 分叉标题/描述/出口节点/提交按钮（HEAD 版第 33/34/59/80 行），`forward-create-model.ts` 管模式切换与 fail-closed。**Multi-hop 未提交**：`git grep middle_node_id HEAD -- web/` = **0 命中**（附录 A.3），`forward-multihop-select.tsx` / `forward-multihop-model.ts` / `forward-path-preview.tsx` 均为**未跟踪**文件 ⇒ 按纪律记「在途，未评」。 |
| **4** | Forward 状态和链路清晰可见 | **基本达成** | 已提交并挂载于 `forward-detail`：链路卡片 + DNS 前门卡片（`25df22d`/`75f0f16`）、延迟历史卡片（`2715313` 挂载 task-7 交付物）。`status §3.12 A)` 记录真实浏览器下 DIRECT/RELAY 两态措辞正确、累计流量按账本口径显示「无数据」而非 `0 B`、禁用词（正常/健康/可达）零命中。**缺口**：延迟卡片只覆盖延迟，**没有带宽/吞吐时间序列**（见 §2 可观测行）。 |
| **5** | DDNS 可以从 UI 使用 | **基本达成（修复已复核覆盖）** | Web 已提交：用户域页面 `web/src/app/(user)/settings/dns/page.tsx` + `components/ddns/dns-providers-manager.tsx` + `forward-dns-card.tsx` + `lib/api/ddns.ts`。**写路径已复核为真解耦**（非仅文档自述）：`backend/src/worker.ts:35` 注册独立节拍 `cron_ddns_sync`（`everyMs: 30_000`），`:284-291` 对**全部** `CRON_JOBS` 建调度并打印注册清单，`:206-232` 的 handler 直接 `runDdnsSyncSweep`；扫描自身的取数条件是 `dns_auto_resolve: true, dns_provider_id: { not: null }`（`ddns-successor.ts:239-241`），**不读 `FAILOVER_POLICY`、不 import failover-loop**（`failover-loop.ts` 的关闸首行在 `:220-224`，与本路径无调用关系）⇒ 生产缺省（两开关都关）下仍会写。见 §3 第 1 条。**扣分项**：只支持 2 种 provider（`cloudflare` / `huawei`，`web/src/lib/types/ddns.ts:33`）。 |
| **6** | Notification 可以从 UI 配置 | **未达成** | 三条腿有两条不在：①**平台渠道配置后端已提交**（`backend/src/routes/notification-channels.ts`，31594 B；`app.ts` 挂载；权限键已登记），但 **admin UI 不存在**——`web/src/app/(admin)/admin/` 下只有 `[segment] announcements federation nodes route-profiles`，没有渠道页；②**事实类投递无生产调用者**（见 §3 第 3 条，我自己 grep 出来的）；③`backend/src/worker.ts` 里 `grep -c notification` = **0**——`CRON_JOBS`（`worker.ts:26-37`）**没有任何通知节拍**，`notification-facts-trigger.ts` 的 `runForwardDenialNotifications` 全仓唯一引用是它自己的测试文件。⇒ 即使配好渠道，**没有任何东西会被投递**。④唯一已接线的通知路径是**公告类**（`routes/announcements.ts` → `announcement-delivery.ts`），其**用户免打扰 UI 是未跟踪文件**（`web/src/components/settings/notification-preferences.tsx` + `settings-body.tsx` 在途）⇒ 记「在途，未评」。 |
| **7** | Agent upgrade 有完整用户流程 | **基本达成（完整流程在途，未评）** | 已提交：`POST /api/nodes/:id/upgrade-command`（`nodes.ts:227`）+ `checkUpgradePrecondition`/`renderNodeUpgradeScript`（`services/node-upgrade.ts`）+ 用户域 UI 入口「生成升级命令」（`components/nodes/node-diagnostics.tsx:264-273`，挂在 `(user)/nodes` 的 `NodeWorkspace`，权限门 `can("node:manage")`）。**三个真实缺口**：①`TUNEX_AGENT_LATEST_VERSION` 缺省 `""`（`env.ts:44`）⇒ `node-health-service.ts:82` 把它折成 `null` ⇒ **不判版本落后**（`node-health-service.ts:70-72` 注释明说两个版本类健康项都不出现）⇒ 默认部署下「该升级了」永不出现；②**用户域没有"实际上报版本"投影**——`GET /api/nodes` 用的是 `node.version` 配置列（`HEAD:nodes.ts:96` 的 `nodeSelect.version: true`、`:122`），实报版本只在 `node_state_report.version`（`schema.prisma:1988-2079`）并通过 `node-health-service.ts:265 version: snapshot.version` 暴露，而该路由挂在 **`/api/admin`**（`app.ts:200`）⇒ 普通用户在用户域看不到实报版本；③`GET /api/nodes/:id/upgrade-state`（补①②的端点）在**工作树在途**（`backend/src/routes/nodes.ts:283-305`）⇒ 记「在途，未评」。 |
| **8** | 常见故障有诊断入口 | **基本达成** | 用户域可见：`components/nodes/node-diagnostics.tsx`（节点诊断，含升级命令）挂在 `node-workspace.tsx:947`；转发失败面 `forward-detail.tsx:193-194,437-450` 把 `apply_error` + `apply_error_code` 映射成**下一步动作**而非裸报错；后端有 `GET /api/nodes/:id/support-bundle`（白名单采集 + 确定性脱敏，`routes/nodes.ts:384-390`、`services/support-bundle.ts`）；Dashboard 有 `attention-panel.tsx`（由 `services/attention.ts` 聚合）。**明显缺口**：Looking Glass —— 后端有 `GET /api/looking-glass/status` 与 `POST /api/looking-glass/nodes/:id/tests`（`routes/looking-glass.ts:80,112`）但只支持一种方法 `LOOKING_GLASS_METHODS = ["tcp_connect"]`（`services/looking-glass.ts:63`），**且 Web 侧零消费**（`grep -rn looking-glass web/src --include=*.tsx` 只命中 mocks 的 probe 名）⇒ 见 §3 第 4 条。 |
| **9** | 用户不需要理解 Lease / Revision / Fencing 才能完成普通操作 | **达成（有一处需注意）** | 用户域组件全量 grep `Lease\|Fencing\|Revision\|Desired State\|desired_status`：**`Lease`/`Fencing` 零命中**（唯一命中在**管理端** `components/admin/federation/leases-manager.tsx`）；`(user)` 路由树下零命中。`Revision` 类词只出现在 `forward-detail.tsx:402-424` 的一个**默认折叠**技术详情块里（源码注释即写「V4-WP8 §13.7：raw revision / desired internals **默认折叠**」，理由是「对普通用户不构成决策依据」）⇒ 达成；**需注意**：折叠 ≠ 不存在，普通操作路径上没有出现，但展开后仍会看到 `config_revision` / `applied_revision` 标签。`dd4a409` 也删掉了 routes 页那句"下一步：创建转发时选择线路"的**假承诺**。 |
| **10** | TuneX 的核心日常体验不再明显落后于 ForwardX | **未达成** | 自评不能只靠 `status` 自述。按 §2 矩阵 11 行：**落后 5 行**、混合 2 行、条件领先 2 行、领先 2 行。更关键的是落后项的**性质**——它们不是"少一个开关"，而是**整条通路不存在**：通知（worker 零节拍 + 事实类零调用者 + admin UI 缺失 ⇒ 无任何投递）、HA/多入口（后端无 ForwardGroup 概念）、诊断（Looking Glass Web 零消费且后端只 1 方法）。三条 Top 差距见 §5。**判"未达成"而不是"接近"的理由**：退出条件 #10 说的是"**不再明显落后**"，而"通知完全不会发出""没有分组/多入口产品面""诊断页在 Web 侧不存在"三者都属于**明显**；同时我**不能**把在途项（多跳、升级完整流程）算作已补齐。 |

## 2. 对齐矩阵

> 状态：✅ 已复核（ForwardX 侧证据全部来自只读参考副本，只描述**行为**，不摘录代码/文案字符串）

| 能力 | TuneX 现状（证据） | ForwardX 行为（只读观察） | 判定 |
|---|---|---|---|
| **Agent 接入** | 一次性**哈希**enrollment token + TTL + 撤销/消费 + 重放 401；Web 生成安装命令 → 轮询等待（10s 一拍，30min 上限）→ 成功 CTA 到 `/forwards?ingress_node_id=`（`lib/node-install-polling.ts:37-39`、`components/nodes/node-onboarding.tsx`、`node-install-waiting.tsx`） | 生成**长期** Agent token（`AgentTokenManager.tsx`，1092 行）：卡片/表格双视图 + 视图偏好本地持久化 + 搜索 + 状态区分「可用/已绑定且在线/已绑定但离线」；token 与 host 绑定后可**复用** | **刻意不同**：TuneX 安全模型更严（一次性 + 可撤销），ForwardX 更省事。TuneX 便利侧已用"等待/恢复"补齐，判定**对齐（不同取舍）** |
| **首启引导** | ①**首台节点**引导：`components/dashboard/first-run-panel.tsx` + `first-run.ts`（读时派生、无状态机、`null`＝未读到≠0）已提交；②**面板自身首启**：靠 `.env` 手改 + `docker compose up`（`README.md:25-46`），**没有 Web 向导** | `client/src/pages/Setup.tsx`（748 行）是**面板首启 Web 向导**：分步 UI + 数据库初始化 + 旧面板迁移 + 管理员账户，带 `needsRestart` 与步骤回退 | **落后**（面板首启）；**对齐/略领先**（节点侧：TuneX 有服务端 onliness 判定与一次性 token，ForwardX 只有 token 状态） |
| **Forward 创建** | Direct / Relay 已提交（`forward-create-dialog.tsx` HEAD:33/34/59/80 按 `draft.mode` 分叉）；**多跳在途**（`git grep middle_node_id HEAD -- web/` = 0 命中） | `MultiHopEditor.tsx`（491 行）：**最多 5 跳**（`maxHops = 5`）、可拖拽排序、两种中继模式 `chain` / `failover`（`relayMode`）、区分"外部入口/外部出口"（`externalEntry`/`externalExit`） | **落后**（多跳在途，未评；已提交侧对齐） |
| **可观测（链路/流量/延迟）** | 链路卡片（`forward-topology.tsx`，区分 `running:false` 与 revision 不一致**两件事**）+ 延迟历史（97 点中 77 个 `latency_ms:null` **不补零不插值**，切多段；409 `raw_window_expired` 与 200 `no_samples` 可分）+ 账本口径累计流量（**「无数据」而非 `0 B`**，标注日界/归档节奏上限） | `HostMonitor.tsx`（1106 行）**主机维度**监控：CPU / 内存 / 上行下行速率、延迟图表（含峰值裁剪 `applyLatencyPeakCut`、Y 轴刻度归一） | **链路与口径领先**（诚实空态、不插值、账本口径）；**带宽/主机资源曲线落后**（TuneX 有 `host_metrics` 解析在管理端，但**没有**用户可用带宽时间序列） |
| **DDNS** | **按转发**配置 provider + 期望值集 + 写后**读回确认**（`dns_confirmed_values`）+ 有界退避 + 自愈；独立 30s 节拍（`worker.ts:35`）；provider **2 种**（`cloudflare`/`huawei`） | **平台级** DDNS 设置（`server/ddns.ts`）：provider 至少 6 种（cloudflare / webhook / huaweicloud / aliyun / tencentcloud + disabled），带主域名约束（域名必须在主域名下）；被 forward group 与**按主机** DDNS 共用 | **语义领先**（确认读回 + 退避 + 按转发期望值集）；**厂商覆盖落后**（2 vs 6，且无 webhook/国内云） |
| **通知** | 渠道配置端点已提交（密文封存 `v1.`、响应逐字不含明文、`delivery_kinds` 现场计算）；公告类已接线；**事实类零调用者** + **worker 零通知节拍** + **admin UI 不存在** | SMTP 配置页含**安全模式**（auto/implicit-tls/starttls/none）+ **测试请求**（含超时提示）；Telegram 路由；`mobileNotifications.ts`（移动端推送）；分组切换可开 Telegram 通知 | **落后**（差距在本专项里最大：能力齐但**没有任何投递路径**） |
| **升级** | 升级命令生成 + 前置校验 + 14 个节点的身份校验，且已修「3xx 把长期凭据带出容器」（curl 优先、`--max-redirs 0`）；**版本基线缺省空 ⇒ 永不判落后**；用户域无实报版本；`upgrade-state` 在途 | `HostCard` 的升级动作带 `canUpgrade`/离线禁用 + **升级超时**判定（`isAgentUpgradeTimedOut`）；`panelUpgrade.ts` 面板自身升级；`agentAssets` 有版本资产候选列表 | **落后**（在途；已提交侧：TuneX 的凭据外发修复是 ForwardX 没有的安全深度） |
| **高可用 / 多入口** | **无 Forward Group 概念**（`grep forwardGroup backend/src` = 0）；HA 表现为 `FAILOVER_POLICY`（`SystemConfig` 里一个 JSON，`auto_failover`/`auto_failback`，**缺省即关**）+ 放置候选（`ingress-candidate.ts`，`requireOnline`）| `ForwardGroup` 产品面：5 种模式 `port / failover / chain / entry / exit`；failover 策略 4 种 `fallback / round_robin / random / ip_hash`；成员按 `priority` 排序；健康检查开关；**切换时 Telegram 通知**；删除影响预览（`getForwardGroupDeleteImpact`）；链路自测（`runForwardGroupChainSelfTest`） | **落后**（产品面缺失；TuneX 的放置/租约内核更可靠，但没有用户可理解的分组入口） |
| **诊断** | 节点诊断卡（含缓存态/可达性/升级命令）+ `support-bundle`（白名单 + 脱敏）+ `attention-panel`；**Looking Glass：后端 1 种方法 `tcp_connect`，Web 零消费** | `LookingGlass.tsx`（780 行）**8 种方法**：ping/ping6、traceroute/traceroute6、mtr/mtr6、tcp（TCPing）、**iperf3**，带 `queued/starting/running/stopping/stopped/error` 状态机与轮询节奏；`rules.selfTest.ts` 规则自测 | **落后**（方法集 + UI 全缺；TuneX 的 support-bundle 脱敏是对方没有的） |
| **权限与多租户** | Workspace RBAC（`workspace-roles.ts`、`permissions.ts` 资源键）+ `canWorkspaceResourceAction` + Federation（身份/信任/授权/远端租约/用量） | **两级**：`admin` vs `role: "user"`（`users.ts`），且**禁止**改 admin 的角色 | **领先**（TuneX 是多租户 + 联邦，ForwardX 是单面板两级） |
| **治理（Desired State / Lease / Fencing / 审计）** | Desired State + Revision + Rollout + Lease + Fencing + Reconcile（`cron_reconcile_v3` 30s）+ Traffic Ledger + 审计 | 关键词实测：`fencing` **0 命中**；`lease` 的 88 处命中是**会话/SSE 配置刷新的互斥闸**（`agentHeartbeatGate`）与 auth 会话清理，**非放置租约**；无 desired state 编译/对账管线 | **领先（TuneX 独特优势，不应为对齐而放弃）** |

**矩阵小结**：11 行口径如下 —— **TuneX 领先 2 行**（权限多租户、治理）、**条件领先 2 行**（可观测口径、DDNS 语义）、**混合 2 行**（Agent 接入＝安全更强但便利性靠等待补齐；首启引导＝节点侧对齐而面板首启落后）、**落后 5 行**（Forward 创建多跳、通知、升级、HA/多入口、诊断）。**落后项集中在"产品面/接线"，领先项集中在"控制平面/可靠性"** —— 这与专项目标（缩短「已有工程能力 → 用户可感知产品能力」的距离）方向一致，说明专项选点是对的，但**还远没走完**；而且落后项里有三条属于**通路完全不存在**（通知无投递、无分组产品面、诊断页不存在），不是"少一个开关"。

## 3. "能力有、路径不通"清单

> 状态：✅ 已复核（每条判定都由**我自己跑的命令/读的码**支撑；"仅文档看到"的单列在 §3.B）

### 3.A 我自己复核过的（可被别人用同样命令复现）

#### 1. DDNS 写入曾挂在 failover 循环里 —— **已真修，但修复的边界要写清楚**

- **修复确认为真**（不是文案）：`backend/src/worker.ts:35` 在 `CRON_JOBS` 里新增 `cron_ddns_sync`（`everyMs: 30_000`）；`:284-291` 遍历**整个** `CRON_JOBS` 建调度并打印注册清单（所以不存在"注册了但没调度"）；`:206-232` 的 handler 直接 `await import("./services/ddns-successor.ts")` 后调 `runDdnsSyncSweep`。
- **解耦确认为真**：扫描自己的取数条件只有 `where: { dns_auto_resolve: true, dns_provider_id: { not: null } }`（`ddns-successor.ts:239-241`），**没有** `FAILOVER_POLICY` 读取，**没有** `dnsPathReadiness` 闸门；`ddns-successor.ts` 不 import `failover-loop.ts`。对比：`failover-loop.ts:220-224` 的关闸在**两个开关都关**时 `return { evaluated: 0, ... }` —— 这条闸只影响 failover 扫描自身。
- **覆盖边界（重要，不能读成"DDNS 全都修好了"）**：sweep 只处理"**已开自动同步且已绑 provider**"的转发。`web/src/components/forwards/forward-dns-card.tsx:74` 的新建绑定表单缺省 `autoResolve: false` ⇒ **只绑定域名、不勾自动同步 ⇒ 仍然不会写**。这是**设计**（`ddns-executor.ts:373 auto_resolve !== true ⇒ 零外呼`），且卡片会显示开关态（`forward-dns-card.tsx:243-246`），但"绑定即生效"这个直觉不成立，UI 上必须让这一步可发现。
- **仍未验证（不得写成通过）**：`synced` / `synced_unverified` / `error` / 退避**四态在真实环境的运行时观察**，以及 30s 节拍长时抖动——`status §3.13` 也仍把这条列为未关闭项。

#### 2. 多跳 `middle_node_id`：后端不但齐备，**生产闸门已开**；缺的确实只有 Web

- **能力齐备**：`forward-route.ts`（`:74` 拆 ingress/egress/middle、`:164-165` 反对称校验、`:254` 多跳**必须**预置绑定 `requiresBindings`）、`reconciler.ts:1154-1230`（三跳计划与事实合并）、`forward-probe-plan.ts:140-165`（**两段**探测计划）、`forward-topology.ts:221`、`agent-diagnose.ts:490`、`route-profile-compiler.ts:645-667`。
- **闸门是真的开着的**（这点比文档说得更强）：`forward-rollout-exec.ts:2348` 传 `{ multiHopImplemented: true }`，`route-profile-compiler.ts:724` 缺省 `input.multi_hop_implemented ?? true` ⇒ `forward-route.ts:265` 的"未实现多跳就拒绝"分支在生产路径上**不触发**。也就是说：**后端已经准备好接受多跳，只差有人发过来。**
- **Web 缺接线**：`git grep middle_node_id HEAD -- web/` = **0 命中**。工作树里 `forward-multihop-select.tsx` / `forward-multihop-model.ts` / `forward-multihop.test.tsx` 都是**未跟踪**文件 ⇒ 「在途，未评」。
- **一条容易被忽略的隐藏契约**：多跳**要求两段绑定先存在**（`forward-route.ts:250-254`，注释说明单跳 rollout 能在 PREPARE 阶段补绑定、多跳不行）⇒ 即便前端发出 `middle_node_id`，若两段邻接绑定没预置，会落到 `route_invalid` 而不是"排队中"。接线时必须先把这条前置条件讲清。

#### 3. 通知：**不是"缺 UI"，是整条投递链缺接线**（本专项里最完整的一例）

- **事实类触发器零生产调用者**：`runForwardDenialNotifications`（`notification-facts-trigger.ts:133`）非测试引用 = **0**；`selectForwardRecoveryFacts` / `listOpenForwardDenials` 同样只出现在自身模块与测试里（逐个 `grep -rn <name> backend/src --include=*.ts | grep -v __tests__` 查过）。
- **worker 零通知节拍**：`grep -c notification backend/src/worker.ts` = **0**；`CRON_JOBS`（`worker.ts:26-37`）共 7 条，**没有一条**与通知相关。
- **平台渠道配置**：后端已提交（`routes/notification-channels.ts`，`app.ts` 已挂载），但 **admin 页面不存在**（`web/src/app/(admin)/admin/` 只有 `[segment] announcements federation nodes route-profiles`）。`status §3.23` 还记录了另一个坑：admin 访问不存在的 segment 会被 `normalize()` **静默回落成节点管理页** ⇒ 渠道页没实现时，用户看到的是**另一个页面**且没有任何提示。
- **唯一已接线的是公告类**（`routes/announcements.ts` → `announcement-delivery.ts`），其用户免打扰 UI 在途（`web/src/components/settings/notification-preferences.tsx` 未跟踪，`settings-body.tsx:332` 在途挂载）。
- ⇒ 当前真实状态是：**渠道配好了，但没有任何东西会被投递**。退出条件 #6 的缺口不在 UI 层。

#### 4. 【新发现】Looking Glass：后端只支持 1 种方法，且 Web **零消费**

- 后端 HTTP 面存在：`GET /api/looking-glass/status`（`routes/looking-glass.ts:80`）、`POST /api/looking-glass/nodes/:id/tests`（`:112`），挂在 `/api/looking-glass`（`app.ts:202`）。
- 方法集只有一种：`export const LOOKING_GLASS_METHODS = ["tcp_connect"] as const`（`services/looking-glass.ts:63`）。
- **Web 侧完全不存在**：`grep -rni "lookingglass|looking_glass|looking-glass" web/src` = **0 命中**（连 mocks 都没有；mocks 里的 `tcp_connect` 是链路延迟的 observer probe 名，与这个端点无关）。
- **方法说明（避免误判）**：我最初按 `app.ts` 的挂载前缀做过一次"web-refs = 0"的粗筛，`route-profiles / pay / payments / internal / federation/v1` 也是 0；逐个复核后**只有 looking-glass 成立**——`route-profiles` 由 `api.routeProfiles`（`lib/api/routeProfiles.ts:118` 起）消费，`payments` 由 `lib/api/topups.ts:121` 与 `lib/api/admin.ts:409` 消费。**粗筛结果不可直接当结论**，故只把复核过的这一条写进清单。
- 对照 ForwardX：`LookingGlass.tsx`（780 行）有 **8 种方法**（ping/ping6、traceroute/traceroute6、mtr/mtr6、tcp TCPing、**iperf3**）+ `queued/starting/running/stopping/stopped/error` 状态机 + 自适应轮询节奏。

#### 5. `TUNEX_AGENT_LATEST_VERSION` 缺省空 ⇒ 版本落后永不提示；用户域无"实际上报版本"投影

- 缺省确认：`backend/src/env.ts:44` = `process.env.TUNEX_AGENT_LATEST_VERSION?.trim() || ""`；`node-health-service.ts:82-85` 把空串折成 `null`，`:70-72` 注释明说"未配置 = null = 不判版本落后（`agent_version_behind` / `agent_version_unknown` 都不出现）"。`.env.production.example:124` 该键是**注释掉的**（`# TUNEX_AGENT_LATEST_VERSION=replace-with-git-sha`）⇒ 默认部署下这条健康项**永不出现**。
- 用户域投影确认：`GET /api/nodes` 的 `version` 来自 `node` 表配置列（`HEAD:routes/nodes.ts:96` 的 `nodeSelect.version: true`，类型在 `:122`）；**实际上报版本**在另一张表 `node_state_report.version`（`prisma/schema.prisma:1988-2079`），只被 `node-health-service.ts:265 version: snapshot.version` 投影出去，而该路由挂在 **`/api/admin`**（`app.ts:200`）⇒ 普通用户在用户域拿不到实报版本。
- **补充（比文档更完整的一点）**：管理域**是**能拿到实报版本的（`/api/admin/node/:id/health` 的 `telemetry.version`）⇒ 缺的不是"能力"，是**用户域的投影**；补的时候不要另造一套实报版本读法，应复用 `node-health-service` 的快照投影。

#### 6. 【新发现，独立印证 task-14】SMTP：管理员在 UI 里改，投递层根本不读

- 写入侧：管理端 UI `web/src/components/admin/settings-manager.tsx:69` → `api.admin.setSystemConfig`（`lib/api/admin.ts:423`）→ `PUT /api/admin/system/config`（`routes/admin.ts:203,218`）→ `SystemConfig` 表（`services/config.ts:42-52`）；种子键含 `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`（`prisma/seed.ts:79-85`）。
- 读取侧：邮件投递只读 **process.env** —— `services/mail.ts:259 sendMail` + `env.ts:72-80`；全仓 `grep SMTP_HOST` 的非测试命中**只有** `env.ts:74`（以及 mail.ts 的一句注释）⇒ 写进 `SystemConfig` 的 SMTP 值**没有任何读取者**。
- 且 **TuneX 没有 SMTP 测试端点**（`routes/settings.ts` 里 `grep smtp` = 0），而 ForwardX 的邮件设置页带"测试请求"（含超时提示）与安全模式选择。
- ⇒ 典型"UI 在、通路不在"，且**用户会以为已配置成功**（保存返回成功）。

#### 7. 非功能性：`0600` 源文件回归（与 `status §3.4` 的强制规则冲突）

- 实测：`find web/src backend/src agent -type f -name "*.ts*" -perm 600` 命中 **21 个**，其中 **7 个已被跟踪**（例：`web/src/mocks/capabilities.ts`、`web/src/lib/__tests__/first-run.test.ts`、`web/src/components/ui/__tests__/a11y-labels.test.tsx`），**14 个未跟踪**（含 `web/src/components/settings/notification-preferences.tsx`、`web/src/components/nodes/node-upgrade-card.tsx`、`web/src/components/forwards/forward-multihop-select.tsx`）。
- 为什么要记：`docker compose up -d --build` **从工作树构建**，`COPY` 保留 mode ⇒ 非 root 的 `bun` 用户读不到，这正是 §3.4 记录过的同型事故（当时表现为 `prisma migrate` P3015）。**运行时**相关的 `backend/src/**` 里只有 1 个测试文件，故本次爆炸半径比上次小；但"新建文件 644"是写进纪律的，**这条已经在回归**。
- 判定：**环境卫生项，不是功能缺陷**；建议最终提交前统一 `chmod 644`。

### 3.B 从文档看到、但我**没有**复核的（不得当作本审查的结论）

| 项 | 文档出处 | 为什么没复核 |
|---|---|---|
| task-15 的跨 host A/B 凭据外发证据（两个 IP 各自记录 `auth_present`） | `status §3.22` | 需要起容器/伪造两个监听服务；本次为只读审查，**不启动容器** |
| task-10 的真机 + 真库证据（`secret_enc` 前缀 `v1.`、明文 0 行、14 例非法形状 400） | `status §3.21` | 同上（需真 MySQL/Redis） |
| §3.23 的"真实 synced 态在浏览器可见" | `status §3.23` | 需驱动真实浏览器；本次只发**只读 HTTP**，未重跑该脚本 |
| 真实浏览器整条用户路径（onboarding 5s online、CTA、重放 401） | `status §3.12 B)` | 同上 |
| mock 与真实的剩余分叉（已存在节点 + 显式不同 role → 真 409 等） | `status §3.13` | 需真后端实例构造用例 |
| 2026-10-07 门禁数字（backend 2868 pass / web 958 pass / build 38 页） | `status §3.12`、`§3.22` | **本次未重跑任何测试**（只读审查且工作树有 30 个未跟踪文件，跑出来的数字也对应不到提交态） |

## 4. 刻意不同项：理由**今天**是否仍然成立

> 状态：✅ 已复核（ForwardX 侧为只读行为观察；判定给出**今天**的理由，不复述文档）

| 刻意不同项 | ForwardX 侧行为（只读观察） | 今天是否仍成立 | 理由（今天重述） |
|---|---|---|---|
| **多 runtime** | 未见"多 runtime"抽象；其分组/规则围绕单一转发链组织 | **成立** | TuneX 的 runtime 不是"多种转发引擎"，而是 `runtime-admission.ts` 的**准入层**（协议白名单 + 至少一个节点 + 补偿路径撤不该存在的 runtime）。为"对齐"去扩 runtime 种类会把**准入语义**摊薄，而准入恰是 TuneX 优于 ForwardX 的地方（§2 治理行）。**但**：`runtime-admission` 的失败态在用户域是否可读，我**没有复核** ⇒ 不据此下结论。 |
| **插件** | **真实存在且在售**：`plugins/china-region-whitelist`、`plugins/live2d-widget`、`plugins/official-store.json`、`Plugins.tsx`、`server/routers/plugins.ts` | **基本成立，但要限定** | 值得注意：ForwardX 的第一个插件是 **china-region-whitelist（区域白名单）**——那是**合规**需求，不是玩物。若 TuneX 已用内置策略满足同类需求，理由成立；若 TuneX **没有**等价能力，则"不做插件"会把一个真实需求一起挡在门外。**我未复核 TuneX 是否有等价策略** ⇒ 只标注为"需在下一轮判定"。 |
| **移动端** | **真实存在**：`android/`（含 `AndroidManifest.xml`、`java/`）、`capacitor.config.ts`、`client/src/lib/mobileNotifications.ts`（`defaultMobileNotificationSettings` / `get` / `save`） | **成立（优先级仍低），但理由变弱** | ForwardX 的移动端是 Capacitor **壳** + 本机通知设置，不是原生重写 ⇒ "不做原生 Android"的理由成立；但"移动端完全不做"的理由**变弱**了——它承载的是**通知触达**，而通知正是 TuneX 现在最大的落后项（§2 通知行）。 |
| **per-host / per-group 通知开关** | `forwardGroupService.ts:178` 的 `telegramSwitchNotifyEnabled`：**仅在** `failover`/`entry` 模式生效，即"发生了线路切换就通知" | **不成立（建议改判为"未接线"）** | 这条不是"更细的开关"，而是**事实类通知**（切换发生 → 通知）。TuneX 的 `runForwardDenialNotifications` 已把这个能力写好却**没有调用者**（§3.A.3）⇒ TuneX 不是"选择不做"，而是"做了没接"。继续归入"刻意不同"会掩盖一个真实缺陷。 |
| **长期 token** | 长期 Agent token，可与 host 绑定后复用；管理面有在线/离线状态与搜索 | **成立** | TuneX 的一次性哈希 token + TTL + 撤销是**更强的安全模型**，且已用"等待/恢复/成功 CTA"补齐便利性缺口（§2 Agent 接入行）。没有理由为了"少点一次"放弃可撤销性。 |
| **route→Forward 创建** | ForwardX 的 group/rule 是**并列**编排入口：先有规则，再有分组与链路模式 | **成立** | TuneX 的 `RouteProfile` 用"发布版本 → 预览影响 → dry-run → 按 revision 应用"作用于**已存在**的转发（`components/admin/route-profiles/route-profiles-manager.tsx:430,453` 有 `impact` 与 `apply(..., dry_run)`）⇒ 这是**比 ForwardX 更强**的批量编排模型；让"创建转发时选线路"反而会把版本化编排降级成一次性选择（`dd4a409` 正是删掉这句假承诺）。 |

## 5. 距退出条件 #10 的差距 Top3

> 状态：✅ 已复核。排序口径：**核心日常体验被用户感知的频率 × 与 ForwardX 的差距宽度 ÷ 补齐的接线成本**。第 4、5 名附后（更接近"一次性"而非"日常"）。

| # | 差距 | 具体到文件 / 端点 / 缺的接线 |
|---|---|---|
| **1** | **通知投递链整体不通**（日常：告警 / 线路切换 / 转发失败都应有出口） | 缺三处接线：①`backend/src/worker.ts` 的 `CRON_JOBS`（`:26-37`）**加一条通知节拍**，并在 `switch`（`:206` 之后）里调用 `runForwardDenialNotifications`（`notification-facts-trigger.ts:133`，现在**零调用者**）；②在 `web/src/app/(admin)/admin/` 下**新建独立目录**（如 `notification-channels/`）承载 `routes/notification-channels.ts` 已交付的端点——**不能**复用 `[segment]` 的 `normalize()`，否则未实现时会静默渲染成节点页（`status §3.23`）；③把用户免打扰从**公告域**扩到**事实域**（现在 `notification-preferences.tsx` 只走 `/api/announcements/preferences`）。**判定影响**：EC#6 = 未达成。 |
| **2** | **高可用 / 多入口没有产品面**（日常：线路断了需要能看懂"为什么没切"） | TuneX 后端**没有 ForwardGroup 概念**（`grep forwardGroup backend/src` = 0）；HA 只表现为 `SystemConfig` 里一个 JSON `FAILOVER_POLICY`（`failover-policy.ts:32`）+ 放置候选（`ingress-candidate.ts` 的 `requireOnline`）。要补的不只是 UI：至少要有一条**读投影**（当前策略 + 每个候选的被拒原因——`failover-policy.ts:107,147` 已有 `policy_auto_failover_disabled` 这类原因码、`:599` 有"哪条不满足"的函数）挂到 Forward/线路详情，否则用户只能看到"没切"而看不到"为什么没切"。**注意**：`FAILOVER_POLICY` 缺省即关是**刻意的安全默认**，不要为了"看起来有 HA"改缺省。 |
| **3** | **诊断入口在 Web 侧是空的**（日常：出问题时无自助手段） | ①`web/src` **没有任何**组件消费 `/api/looking-glass/*`（`routes/looking-glass.ts:80,112`）——`grep -rni looking glass web/src` = 0；且后端只支持 `tcp_connect`（`services/looking-glass.ts:63`），与 ForwardX 的 8 方法（含 mtr、iperf3）差一个量级。②升级流程的"当前版本 vs 目标版本 vs 等待/恢复"缺 `GET /api/nodes/:id/upgrade-state`（在途，`backend/src/routes/nodes.ts:283-305`）与版本基线（`TUNEX_AGENT_LATEST_VERSION` 缺省空，`env.ts:44`）。 |

**第 4 名（非日常，但阻塞 EC#1 的"快速"）**：**面板自身首启没有 Web 向导** —— ForwardX 的 `Setup.tsx`（748 行）把数据库初始化、旧面板迁移、管理员账户做成分步 UI；TuneX 仍是 `cp .env.example .env` 手改 + `docker compose up`（`README.md:25-46`）。这是 EC#1 判"基本达成"而不是"达成"的原因。

**第 5 名**：**DDNS 厂商覆盖**（TuneX 2 种 `web/src/lib/types/ddns.ts:33` vs ForwardX ≥6 种含国内云与 webhook）。TuneX 的适配器已经做到"只描述能力、不描述厂商"（`ddns-executor.ts:125-126`，`endpoint` 可覆盖），新增厂商是**纯适配**工作，成本低、用户感知直接。

---

## 附录 A：复核命令原始输出

> 状态：✅ 关键输出已回填（ForwardX 侧只记录**行为层**观察，不摘录其代码/文案字符串）

### A.1 判定面

```
$ git diff origin/main --stat | tail -1
 130 files changed, 24103 insertions(+), 845 deletions(-)

$ git status --short | grep -c '^??'
30
```

### A.2 DDNS 写入路径解耦（EC#5 / §3.A.1）

```
$ grep -n "cron_ddns_sync" backend/src/worker.ts
35:  { name: "cron_ddns_sync", everyMs: 30_000, desc: "..." },
206:      case "cron_ddns_sync": {
229:          console.log("[worker] cron_ddns_sync:", JSON.stringify(summary));

$ sed -n '239,241p' backend/src/services/ddns-successor.ts
      where: { dns_auto_resolve: true, dns_provider_id: { not: null } },
      select: { id: true },
      orderBy: { id: "asc" },

$ sed -n '220,224p' backend/src/services/failover-loop.ts
  if (!policy.auto_failover && !policy.auto_failback) {
    return { evaluated: 0, moved: 0, held: 0, results: [], dns_gated: [] };
  }
```

### A.3 多跳：后端闸门开着、Web 零接线（EC#3 / §3.A.2）

```
$ git grep -n "middle_node_id\|middleNodeId" HEAD -- web/
(无输出)

$ grep -n "multiHopImplemented" backend/src/services/forward-rollout-exec.ts backend/src/services/route-profile-compiler.ts
forward-rollout-exec.ts:2348:    { multiHopImplemented: true },
route-profile-compiler.ts:724:    multiHopImplemented: input.multi_hop_implemented ?? true,
```

### A.4 通知：投递链缺接线（EC#6 / §3.A.3）

```
$ grep -c notification backend/src/worker.ts
0

$ sed -n '26,37p' backend/src/worker.ts     # CRON_JOBS 共 7 条，无通知
（cron_save_traffic / cron_delete_tunnel_traffic / cron_latency_history /
  cron_check_node_offline / cron_reconcile_v3 / cron_ddns_sync / cron_settle_billing）

$ grep -rn "runForwardDenialNotifications" backend/src --include=*.ts | grep -v __tests__
backend/src/services/notification-facts-trigger.ts:133:export async function runForwardDenialNotifications(

$ ls "web/src/app/(admin)/admin/"
[segment]  announcements  federation  nodes  page.tsx  route-profiles
```

### A.5 Looking Glass：后端 1 方法、Web 零消费（§3.A.4）

```
$ grep -n "LOOKING_GLASS_METHODS" backend/src/services/looking-glass.ts
63:export const LOOKING_GLASS_METHODS = ["tcp_connect"] as const;

$ grep -rni "lookingglass\|looking_glass\|looking-glass" web/src
(无输出)

$ grep -n "routes.get(\|routes.post(" backend/src/routes/looking-glass.ts
80:  routes.get("/status", ...)
112:  routes.post("/nodes/:id/tests", ...)
```

### A.6 SMTP：写进 SystemConfig、读自 process.env（§3.A.6）

```
$ grep -rn "SMTP_HOST" backend/src --include=*.ts | grep -v __tests__
backend/src/env.ts:74:    host: process.env.SMTP_HOST ?? "",

$ grep -rn "setSystemConfig\|system-config" web/src/lib/api/admin.ts backend/src/routes/admin.ts
web/src/lib/api/admin.ts:423:    setSystemConfig: (name: string, value: string, cookie?: string) =>
backend/src/routes/admin.ts:218:  await systemConfig.setConfig(name, body.value);

$ grep -rn "smtp" backend/src/routes/settings.ts
(无输出 → 无测试端点)
```

### A.7 权限回归：0600 源文件（§3.A.7）

```
$ find web/src backend/src agent -type f -name "*.ts*" -perm 600 | wc -l
21          # 逐文件经 git ls-files 判定：7 tracked / 14 untracked
```

### A.8 ForwardX 行为（只读观察，行为层）

```
$ wc -l client/src/components/MultiHopEditor.tsx client/src/pages/Setup.tsx \
        client/src/pages/LookingGlass.tsx client/src/pages/HostMonitor.tsx \
        client/src/components/AgentTokenManager.tsx
  491 MultiHopEditor.tsx
  748 Setup.tsx
  780 LookingGlass.tsx
 1106 HostMonitor.tsx
 1092 AgentTokenManager.tsx

$ grep -n "ForwardGroupMode" server/services/forwardGroupService.ts
12:export type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";

$ for k in fencing lease reconcile; do echo -n "$k: "; \
    grep -rli "$k" client/src server drizzle shared --include=*.ts --include=*.tsx | wc -l; done
fencing: 0
lease: 88      # 均为会话 / SSE 配置刷新互斥闸与 auth 会话清理，非放置租约
reconcile: 30
```

---

## 6. 本审查的自我边界（必须与结论一起读）

1. **只读**：本次未修改任何源码，未做 git 提交，未启动/重启任何容器，未跑任何测试套件与浏览器脚本。唯一写入是**本文件**。
2. **scratch Panel 未被使用**：任务允许对 `http://127.0.0.1:18180` 发只读请求，但本审查每条结论都已在**本地代码 + git** 上取得直接证据，无需依赖运行时；因此**没有**把运行时状态当作证据，也没有借它推断"已验证"。
3. **ForwardX 侧全部是行为观察**：只记录行数、常量取值、标识符名、页面/方法清单这类**行为层**事实；未复制其任何实现代码，也未逐字搬运其界面文案（个别标识符/枚举值是为**可复核定位**而引用，属行为描述而非实现复制），符合 AGPL-3.0-only 的 clean-room 纪律。
4. **"在途，未评"的含义**：指该文件在工作树中被修改或未跟踪，其内容可能随时变化，因此**既不算达成也不算未达成**。受影响的判定：EC#3（多跳）、EC#6（免打扰 UI）、EC#7（升级完整流程）、§3.A.2。
5. **我没有做的判断**：真实浏览器 E2E、真机/真库证据、凭据外发 A/B、门禁数字重跑——一律留在 §3.B，**不得**被引用为本审查的结论。


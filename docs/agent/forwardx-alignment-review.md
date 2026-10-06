# TuneX × ForwardX 产品对齐审查（task-23）

- **审查人**：`align-review`（持久队友，只读审查，唯一写入范围 = 本文件）
- **状态**：🚧 进行中（本文件按块增量落盘；每节头部标注"已确认 / 待复核"）
- **分支**：`productization/tunex-harvest`
- **基线**：`origin/main..HEAD`
- **纪律**：ForwardX 为 **AGPL-3.0-only**；本审查**只研究行为**，不复制代码、不复制文案字符串；所有 ForwardX 证据只给行为描述与（如引用）行号定位，不给可复制代码。
- **判定口径**：本文件不做"已完成/已验证"声明，只做判定；每条判定附可复核证据（文件:行 或 命令）。

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

**在途部分**（工作树有改动但**未提交**）：`git status --short` = 24 个已跟踪文件被改 + **30 个未跟踪新文件**。逐项标注于本报告各处，**凡在途项一律标「在途，未评」**，不计入任何"达成"判定。

**本审查的判定口径声明**：
- "达成" = 我在**已提交代码**里找到用户可达路径，且**不止有后端**;
- 只读 HTTP 复核（scratch Panel `http://127.0.0.1:18180`）与读码是两类不同强度的证据，分别标注；
- 文档（`productization-status.md`）里的自述**不作为本条判定的证据**，只作为被检验对象。

## 1. 退出条件 10 条逐条判定

> 状态：🚧 进行中（#1–#5 已落盘；#6–#10 待补）

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

## 2. 对齐矩阵

> 状态：✅ 已复核（ForwardX 侧证据全部来自只读参考副本，只描述**行为**，不摘录代码/文案字符串）

| 能力 | TuneX 现状（证据） | ForwardX 行为（只读观察） | 判定 |
|---|---|---|---|
| **Agent 接入** | 一次性**哈希**enrollment token + TTL + 撤销/消费 + 重放 401；Web 生成安装命令 → 轮询等待（10s 一拍，30min 上限）→ 成功 CTA 到 `/forwards?ingress_node_id=`（`lib/node-install-polling.ts:37-39`、`components/nodes/node-onboarding.tsx`、`node-install-waiting.tsx`） | 生成**长期** Agent token（`AgentTokenManager.tsx`，1092 行）：卡片/表格双视图 + 本地持久化视图偏好 + 搜索 + 「已使用/未绑定/在线/离线」状态；token 与 host 绑定后可**复用** | **刻意不同**：TuneX 安全模型更严（一次性 + 可撤销），ForwardX 更省事。TuneX 便利侧已用"等待/恢复"补齐，判定**对齐（不同取舍）** |
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

**矩阵小结**：11 行里 **TuneX 领先 3 行**（权限多租户、治理、Agent 接入的安全模型）、**平/条件领先 2 行**（可观测口径、DDNS 语义）、**落后 6 行**（面板首启、Forward 创建多跳、通知、升级、HA/多入口、诊断）。**落后项集中在"产品面/接线"，而领先项集中在"控制平面/可靠性"**——这与专项目标（缩短「已有工程能力 → 用户可感知产品能力」的距离）方向一致，说明专项的选点是对的，但**还远没走完**。

## 2. 对齐矩阵

> 状态：🚧 待填

## 3. "能力有、路径不通"清单

> 状态：🚧 待填

## 4. 刻意不同项：理由今天是否仍然成立

> 状态：🚧 待填

## 5. 距退出条件 #10 的差距 Top3

> 状态：🚧 待填

---

## 附录 A：复核命令原始输出

> 状态：🚧 待填


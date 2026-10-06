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
| **5** | DDNS 可以从 UI 使用 | **基本达成（修复已复核覆盖）** | Web 已提交：用户域页面 `web/src/app/(user)/settings/dns/page.tsx` + `components/ddns/dns-providers-manager.tsx` + `forward-dns-card.tsx` + `lib/api/ddns.ts`。**写路径已复核为真解耦**（非仅文档自述）：`backend/src/worker.ts:35` 注册独立节拍 `cron_ddns_sync`（`everyMs: 30_000`），`:284-291` 对**全部** `CRON_JOBS` 建调度并打印注册清单，`:206-232` 的 handler 直接 `runDdnsSyncSweep`；扫描自身的取数条件是 `dns_auto_resolve: true, dns_provider_id: { not: null }`（`ddns-successor.ts:239-241`），**不读 `FAILOVER_POLICY`、不 import failover-loop**（`failover-loop.ts` 的关闸首行在 `:220-224`，与本路径无调用关系）⇒ 生产缺省（两开关都关）下仍会写。见 §3 第 1 条。 |

## 2. 对齐矩阵

> 状态：🚧 待填

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


# TuneX Productization Harvest — 协作状态

> 专项规则：[productization-harvest.md](./productization-harvest.md)。本文件是任务、调查结论、验证证据和交接入口，不替代代码事实。
> 启动日期：2026-10-06（Asia/Shanghai）。当前阶段：**Round 1 / Independent Review + Integration；I1-A/B 实现到齐，R2 First-run 预研完成**。

## 1. 目标与执行约定

- 目标：复用 TuneX 已有能力，吸收 ForwardX 产品行为，以完整 vertical slice 缩短用户操作路径。
- 首轮：**Agent Onboarding / Enrollment / Install / Upgrade**。
- 派发模型：**DeepSeek V4.1 Flash**，路由 `txapi/deepseek-v4.1-flash`，reasoning effort `high`。路由已通过模型目录确认。
- 固定顺序：审计 → 比较 → Capability Map → 方案与边界 → 实现 → 独立审查 → 验证 → 更新状态。
- Leader 独占编辑本状态文件；并行调查代理只读。实现阶段每项任务必须记录不重叠的写入范围、依赖和验收标准。
- 不复制 ForwardX 源码；采用行为研究与 clean-room 实现。禁止将参考目录加入提交。
- 不绕过 Desired State / Revision / Lease / Fencing / Workspace ownership；后端已有能力优先 REUSE / EXPOSE / INTEGRATE。
- 不自动提交、合并、重置、切换分支或改动用户已有文件；如需分支/集成操作，先记录依据。

## 2. 启动环境与保护边界

| 项目 | 已确认状态 |
|---|---|
| 工作目录 | `/workspace/TuneX` |
| 当前分支 | `productization/agent-onboarding`，不是 `main` |
| 用户已有未跟踪内容 | `docs/agent/` 与 `Forwardx(参考项目，不进入git提交）/` |
| ForwardX 参考 | 仓库根目录本地参考副本，目录名结尾为中文全角右括号 |
| 专项分支约定 | 本地已存在 `productization/forwardx-harvest`；未切换，当前按用户所在 `productization/agent-onboarding` 调查 |
| 工程约定 | [DEVELOPMENT.md](../../DEVELOPMENT.md) 要求 main 基线；已验证本地 `main...HEAD` 为 `0 / 0`，当前 HEAD `cafaaba`，未 fetch，不能声称与远端最新 main 一致 |
| Web 约定 | [web/AGENTS.md](../../web/AGENTS.md)：编码前阅读已安装 Next.js 对应指南 |

## 3. Round 1 任务与代理

以下为有独立上下文的子代理，不是持久化 Agent Teams 成员；所有代理统一使用指定模型。ID 供 Leader 继续沟通与收集结果。

| ID | 角色 / 任务 | 状态 | 读取范围 | 写入范围 | 依赖 / 输出 |
|---|---|---|---|---|---|
| R1-A | TuneX Capability Auditor | 已完成 | backend / agent / web / migrations / scripts / tests / docs | 无，只读 | 事实与测试覆盖见调查文档 |
| R1-B | ForwardX Product Researcher | 已完成 | 本地 ForwardX 参考副本、必要 TuneX 对照 | 无，只读 | 产品行为分类、许可证边界已汇总 |
| R1-C | TuneX UX Auditor | 已完成 | Web 页面/组件/API 客户端/文档 | 无，只读 | 用户等待闭环、无组死路、安全确认缺口 |
| R1-D | Leader 综合 | 已完成 | 三份调查与对应代码 | 本文件、onboarding-recon.md | Capability Map、复核修正与切片边界已批准 |
| I1-A | 共享等待组件/轮询行为 | 实现完成，待验收 | 批准方案及既有 admin 调用 | admin/node-install-waiting.tsx；lib/node-lifecycle-i18n.ts；新增 lib/node-install-polling.ts 及专属测试、admin/node-install-waiting.test.tsx | 已交接；定向115 pass；最终竞态/浏览器由审查与Leader验证 |
| I1-B | 用户接入闭环 | 实现完成，待验收 | 用户组件/API、批准共享契约 | nodes/node-workspace.tsx；lib/i18n/dictionaries.ts；新增 node-onboarding helper/展示与 add-node-onboarding.test.tsx | 已交接；专属35 pass，代理全量635 pass；不是最终验收 |
| I1-C | 独立异步审查 | 已完成，发现需修复项 | 最终组件/轮询库/admin-user调用/受控测试 | 无，产品与文档只读 | Chromium真实组件+受控timer证实unknown不启动、在途重启死锁、deadline/TTL、确认绕过、同提交令牌串台 |
| I1-D | 独立用户域安全/UX审查 | 已完成，发现需修复项 | 用户接入、Workspace权限epoch、文案、真实后端契约 | 无，产品与文档只读 | production响应无投影、最新凭据确认、同名provision重签、persona与degraded；不接受仅635绿测作为验收 |
| I1-A2 | 共享等待/轮询修复 | 进行中 | I1-C证据与真实组件repro | A1共享组件/轮询/i18n/专属tests；必要更新admin lifecycle自动启动语义断言 | unknown+issued观察、独立deadline/TTL、generation、确认入口、render-time敏感过滤、横幅恢复与openLabel |
| I1-B2 | 用户接入安全/事实修复 | 进行中 | I1-D findings与真实Backend契约 | B1用户组件/helper/dictionaries/专属tests | 最新列表视图、最新/未知凭据保守确认、同名检测、late error/finally、只读/无组/degraded真话 |

代理 ID：
- R1-A：`44b7f40a-f196-4c84-9a6b-a39602525fdc`
- R1-B：`90c47006-fde7-422c-a7f6-b6a73eec85c6`
- R1-C：`ea293382-5680-47ad-b83d-4b17c739c878`
- I1-A：`5724eca9-b552-4a4b-9362-28ba0cb91587`
- I1-B：`8bad0d53-20cc-4049-9653-297f10f15a9a`
- I1-C：`b20fc5ee-cfc9-44c3-8b32-d8a9a69ac616`
- I1-D：`e231688f-1237-4130-ac54-7e32f4cf803f`
- I1-A2：`3413a945-7152-402d-b0c2-0a60156fbbb7`
- I1-B2：`71e01124-607e-4deb-84c7-0d1b62740a44`

### Round 1 — 修复后门禁与缺陷派发

| ID | 任务 | 状态 | 写入范围 | 输出 |
|---|---|---|---|---|
| V1 | 修复后全量门禁 | 通过 | 无（只读执行） | `typecheck` 0 错；Web `674 pass / 0 fail`（35 文件，基线 635）；`build` 38 页 |
| E2E-1 | 真实浏览器 + 真实 Agent 端到端 | 进行中 | 仅 `/tmp/tunex-harvest-integration-20261006` | 真实 provision → 关对话框持续等待 → 一次性 enrollment 消费与重放 → 真 Agent 容器上线 → 成功 CTA |
| D3 | 建组后加节点的 `port_range` 错误契约 | 已完成，Leader 已独立验证 | `backend/src/routes/node-groups.ts`、新增 `node-groups-provision-contract.test.ts` | 修复前真实复现 500；现为 409 + `PORT_RANGE_REQUIRED`（与 mock 收敛），零副作用；复查 `bun test` 2 文件 34 pass / 0 fail |
| D1 | 节点创建命名一致性 + 对话框无障碍文案 | 已完成，待浏览器复核 | `web/src/components/ui/dialog.tsx`、`components/nodes/**`、`lib/i18n/dictionaries.ts`、新增 `ui/__tests__/dialog.test.tsx` | 三者统一 `node.create`；`DialogContent` 关闭标签改走 `common.close`（无 Provider 回落默认语言）；定向 73 pass / 0 fail、`tsc` 0 错 |
| D2 | 升级身份校验不可执行/不可发现 | 已完成，Leader 已独立验证 | `node-upgrade.ts`、其测试、`.env.production.example`、`docs/production-deploy.md` | 查出**第二条更深缺陷**：`docker exec` 拿不到 entrypoint source 的凭据 → 空 Bearer → 健康升级被误判 401 回退；curl 缺失时还打印「未校验」+「升级完成」。现改为容器内 source 取凭据 + `wget` 回落 + 只有 200 才算通过；复查 33 pass / 0 fail、backend `tsc` 0 错 |
| E1 | 节点「在线真相」阻断级缺陷 | 进行中 | `backend/src/services/node-lifecycle.ts`、`node-state.ts` 及其测试 | 已确认根因链（见 §3.2）；修复需让新鲜已认证上报自动恢复 `online` |
| R3-A | DDNS 产品化只读预研 | 已完成 | 无，只读 | **TuneX 后端几乎完整，Web 侧 0 文件引用**（页面/客户端/i18n/mock 全无）→ 主路径 REUSE/EXPOSE；退避可见性需后端 +3 读投影字段（`auto_resolve`/`attempt_count`/`next_attempt_at`）；`multi_entry` 只写单地址、`CNAME` 会写 IP 值 → 首发 UI 不得提供；`/api/forwards/:id/dns` 缺路由级测试 |
| R3-B | Forward 可观测性只读预研 | 已完成 | 无，只读 | **`GET /api/forwards/:id/topology` 已存在且零 Web consumer**（逐跳链 + 每端 revision + 逐端协议诊断 + 新鲜度）→ 纯 Web EXPOSE；另发现两处**生产级事实错误**：详情页"累计流量"读已无写入者的死列（列表页用正确账本）、Web `api.admin.nodeState` 打复数路径 `/admin/nodes/:id/state` 而后端只有单数 `/admin/node/:id/state`（生产 404，mock 盖住，loader 又把"取不到"渲染成"无上报"）；延迟历史读函数与用户域目标健康是**真后端缺口**，须独立切片 |
| W1 | First-run 切片（自助建组 + 下一步 + a11y 文案） | 进行中 | `web/src/lib/api/**`、`lib/first-run.ts`(新)、`lib/i18n/dictionaries.ts`、`components/dashboard/**`、`components/nodes/**`、`ui/**`、`sidebar.tsx`、`traffic-chart.tsx`、`admin-charts.tsx`、`route-profiles-manager.tsx`、`mocks/**` | 要求一次做完整：真实可执行路径 + 精确错误码分支 + 三态 + token 不落地 + 中英文案 + 行为测试 + 三项自检 |

- D1：`c2d861bd-6533-44f7-a60a-4d91a324deff`（已完成）
- D2：`11f1d012-81ae-4482-af15-198447b605f1`（已完成）
- D3：`4be4ca94-27ca-4ee6-a57a-894e86767430`（已完成）
- E1：`5e54ac67-5a10-4842-86f4-2a013bb4c312`
- W1：`4037d58f-403d-460d-9426-092ba1d258a0`
- R3-A：`58cb11e2-90e0-4bd7-9563-587279b5be9d`
- R3-B：`433adc0f-2f22-4479-99ae-93ae0d8b88f8`

## 3.1 Round 2 — First-run 只读预研（不提前实现）

I1-A/B 实现期间并行调查下一优先项；首个切片未审查/验证前不派发下一轮编码。重点区分平台管理员与普通 Workspace 用户，不能为了向导绕过策略。

| ID | 角色 | 状态 | 写入范围 | 输出 |
|---|---|---|---|---|
| R2-A | First-run 能力/权限/节点组前置审计 | 已完成 | 无，只读 | 自助建组现有能力、Workspace归属、策略/端口前置、派生事实 |
| R2-B | ForwardX 首启行为参考 | 已完成 | 无，只读 | setup仅DB/迁移/admin，登录后完整向导并不存在；借机制不照搬流程 |
| R2-C | First-run 用户路径审计 | 已完成 | 无，只读 | 首屏无下一步、自助建组缺UI、persona死路、entitlement-gated最小切片 |

模型均为 `txapi/deepseek-v4.1-flash` / `high`。
- R2-A：`6987670e-b8e6-4047-9e81-8d9f1348c81f`
- R2-B：`972cf4a3-1d57-4e3d-b833-d71cabfa29c9`
- R2-C：`031bf24e-b2a4-4f71-9122-125ec5d58b19`

## 3.2 Round 3 — 真实端到端发现的**阻断级**缺陷

真实拓扑（4 台真实 Agent 长期运行、已 ACK 转发）上的实测证据：

| 观测 | 证据 |
|---|---|
| 上报是新鲜的 | `node_state_report` 每 30s 更新；`node.last_seen_at` 与之一致，age 14–30s |
| `node.status` 全为 `inactive` | 6/6 行（含 4 台集成 Agent、含真实 provision 新建节点） |
| `GET /api/nodes` 全为 `offline` | `deriveConnection` 要求 `status === "active"`（`node-lifecycle.ts:245-261`） |
| 后果 | 真实 Agent 已上线、已 ACK 转发，面板仍显示「已安装，当前离线」；「等待安装 → 在线 → 成功 CTA」闭环不可达 |

相关事实：`Node.status` schema 默认 `active`，注释称由 offline-detector 翻转，与 v4 `lifecycle` 正交；代码里只找到「翻成 inactive」的路径（过期清扫 `markStaleInactive`：`last_seen_at` 早于 cutoff **或为 NULL**；会话结束 `markInactive`），疑似缺少「新鲜上报恢复 active」的路径。

已派 E1 做根因定位与修复（含时区/时钟偏差与单向闩锁两条候选），并附加真实证据要求。**在 E1 完成并验证前，不宣称 Agent 上线体验完成。**

### 受控实验：整条链只差这一处（2026-10-06 23:56，真实 UI + 真实后端 + 真实 Agent 容器）

方法：UI 创建节点 → 消费真实一次性 enrollment → 以真实凭据启动真实 Agent 容器并持续上报 → 然后**只改一个变量**：把该行 `node.status` 由 `inactive` 置回 `active`。

| 阶段 | 实测结果 |
|---|---|
| 创建后 | phase「等待安装」，命令保留 |
| 真 Agent 上报中（`last_seen_at` 新鲜） | `connection: offline`，UI「已安装，当前离线」 |
| 仅把 `status` 置回 `active` | `connection: online`，UI 徽章「已连接」 |
| 闭环下一步 | `node-install-success-action` 出现，文案「创建第一条转发」，`href=/forwards?ingress_node_id=7` |
| 真 Agent 日志 | `restore done ... source=panel`、control/heartbeat/observation 均已排程 |

结论：真实 Agent 上报、90s 窗口、`deriveConnection`、用户投影、等待组件、成功 CTA **全链路都正常**；唯一断点是 `status` 缺少自动恢复路径。E1 的修复必须让这一步无需人工干预即可发生。

### Leader 独立确认的完整机制链（与 E1 结论互证）

| 步 | 事实 | 位置 |
|---|---|---|
| 1 | 新建节点 `status='active'`、`last_seen_at=NULL` | `prisma/schema.prisma` Node 默认值；provision 不写 `status` |
| 2 | 过期清扫把 **`last_seen_at IS NULL` 也算过期** → 新建节点在下一轮就被翻成 `inactive` | `src/socket/offline-detector.ts:250-266`（worker 定时调用：`src/worker.ts:82` → `runOfflineCheck` → `markStaleInactive`） |
| 3 | 真实上报**只刷新 `last_seen_at`，从不把 `status` 置回 `active`** | `src/services/node-state.ts:991-996` |
| 4 | `deriveConnection` 要求 `status === 'active'` → **永久 offline** | `src/services/node-lifecycle.ts:245-261` |

即：任何节点在第一次上报之前就会被清扫翻成 inactive，之后无论上报多新鲜都回不来。这解释了为什么 6/6 节点（含 4 台长期上报的集成 Agent）都是 `inactive`。

E1 修复的验收基准：`<第 2 步发生>` 之后，**一次已认证的新鲜上报必须让该节点恢复 `online`**；同时不得放宽凭据撤销→offline、无凭据→waiting、lifecycle 正交、lease/fencing。

### 修复后的决定性验收：**通过**（2026-10-07 00:00，真实 UI + 真实后端 + 真实 Agent 容器，零手工写库）

E1 的实现与 Leader 独立推导一致：`services/node-state.ts` 在**通过凭据认证与载荷校验之后**，把 `last_seen_at` 与 `status: "active"` 放进**同一条 `updateMany`**；并在 `deriveConnection` 旁写清「`status` 必须可恢复、两个方向共用同一窗口常量」的写入契约。定向 `bun test`（node-credential / node-lifecycle / node-view / node-health）**209 pass / 0 fail**。

按 `rebuild-panel.sh` 用当前源码重建 scratch Panel/Worker 后，验收脚本刻意先制造闩锁再要求自动恢复：

| 观测 | 实测 |
|---|---|
| 创建后 | `等待安装`；命令与签发一致；关掉对话框继续轮询（26s 内 2 次取数） |
| 库里状态 | `inactive\|NULL` → **闩锁条件已成立**（`latchedBeforeAgent=true`） |
| 闩锁期间 | `connection: waiting`（无凭据，语义正确） |
| 消费真实 enrollment + 启动真 Agent | 5s「已安装，当前离线」→ **15s「已连接」** |
| 服务端投影 | `online` / `has_credential` / `registered` / `accepts_new_business` / `role=ingress` |
| 成功下一步 | `node-install-success-action` 出现，文案「创建第一条转发」，`href=/forwards?ingress_node_id=8` |
| 浏览器网络 | 无 ≥400 的 API 响应 |

结论：**Agent Onboarding 的「创建 → 等待 → 真实 Agent 上线 → 成功下一步」闭环在真实拓扑上成立且可复现**。仍待补：web 侧最终门禁与浏览器复核（等 W1 释放 web 写入）、独立审查代理复核本切片。

### 升级身份校验的真实复核（D2，2026-10-07 00:0x，真实 Panel + 真实凭据 + production 形状 `agent.env`）

用真实渲染出来的升级脚本第 5 步（`POST /api/nodes/:id/upgrade-command` 的 `data.script`），配 production 形状（凭据只存在于容器内 `/run/tunex-agent/agent.env`，不经 CLI 参数）与真实 Agent 容器：

| 用例 | 真实输出 | 退出码 |
|---|---|---|
| 未配 `TUNEX_PUBLIC_PANEL_URL`，但 `agent.env` 有 `TUNEX_PANEL_HTTP_URL` | `身份校验通过（HTTP 200）：同一个 node_id/agent_id 已重新连上 Panel` → `升级完成…（身份校验：通过）` | 0 |
| 未配地址且 `agent.env` 也无记录 | `身份校验：未校验 —— 没有可用的 Panel 地址…` + `提醒：本次升级没有通过身份校验，不要当成已校验通过…` | 0（`negativeCaseSaysVerified=false`） |

即：修复后**真实可执行**，且**不可能在没有 HTTP 200 的情况下说"通过"**。同一节点在此期间 `connection` 自动为 `online`，E1 的修复在 production 形状下再次成立。

### E1 的补充证据（独立镜像 + 一次性 scratch 栈，已清理）

E1 自行用**独立标签派生镜像**（`tunex-e1-fixed:local` / `tunex-e1-old:local`，只 `COPY src /app/src`——镜像内应用在 `/app/src`，外层 bind mount 无效）搭了一次性 MySQL/Redis/Panel/Worker + 真实 Agent 容器，给出 **A/B 决定性对照**：换回 pre-fix Panel 时 Agent 启动后 `last_seen_age=2.3s`（上报完全新鲜）却仍 `offline`；换回 fixed 镜像、其余不变 → 下一拍上报即 `online`。并排除时区/时钟偏差（MySQL `NOW()` 与服务端一致）、确认 Redis 里**零** socket 标记键、worker 日志 `flipped_stale:4` 一次性闩死 4 台真实 Agent。定向 12 个连接相关文件 **509 pass / 0 fail**，含 A/B 自证（临时移除写点 → 4 fail）。

E1 的剩余风险（如实记录，未修）：心跳写入仍 fail-soft（DB 抖动最多 offline 30s，下一拍自愈）；socket 时代残留的 `markInactive` 理论上能翻掉仍在 HTTP 上报的节点（生产 Redis 零标记键，属理论路径，下一拍自愈）；`/node/desired` 刻意不恢复 status（保持单一"活着"定义，代价是最迟 30s）。

### 下一批切片队列（按 ROI 与写入冲突排序）

| 序 | 切片 | 前置 | 说明 |
|---|---|---|---|
| 1 | W1 First-run（自助建组 + 下一步 + a11y） | 进行中 | 完成后跑 web 全量门禁 + 真实浏览器复核 |
| 2 | D5 修 `api.admin.nodeState` 复数路径 404 + loader 把"取不到"渲染成"无上报" | **已派发**（限定不跑 `next build`，避免与 W1 自检撞 `.next`） | 生产级事实错误；mock 实现了复数路径把它盖住（`mocks/handlers/admin.ts:343`），`loadNodeState` catch 一切回落 null 并注释称"无上报是常态" |
| 3 | DDNS 切片：D4 后端读投影（**已完成并独立验证**：69 pass / 0 fail）+ Web 部分 | W1 释放 web | 退避可见性必须读服务端；`multi_entry`/`CNAME` 首发不做 |
| 4 | R3-B1 Forward 详情链路与流量口径（纯 Web） | 等 W1 | 换掉死列、`topology` 首次消费、`缺数据≠正常` 硬断言 |
| 5 | 延迟历史读端点 + 用户域目标健康（真后端缺口） | 独立评估权限/scope | R3-B 确认 `readLatencySeries` 无路由 |

### Leader 已实证确认的三处"展示事实错误"（不依赖子代理结论）

| 编号 | 事实 | 证据 |
|---|---|---|
| F11 | 详情页「累计流量」读的是**已无写入者**的 `tunnel.traffic`：全仓 grep 不到任何 `tunnel.update/create/upsert` 携带 `traffic`；`forward-service.ts:578-583` 自己的注释也说明流量是归档账本事实、live 列是历史遗留。同一张卡片里 **图表用账本、数字用死列**，永远显示 `0 B`，与列表页口径不一致 | `forward-service.ts:307` vs `:578-595`；`forward-detail.tsx:255-266`（`forward.totalTraffic: formatBytes(forward.traffic)`） |
| F18 | Web `api.admin.nodeState` 打 `/admin/nodes/${id}/state`（复数），后端只有 `nodeAdminRoutes.get("/node/:id/state")`（单数）→ 生产 404；mock 实现了复数路径把它盖住，loader 又把"取不到"渲染成"无上报" | `web/src/lib/api/admin.ts:189` vs `backend/src/routes/node-admin.ts:327` |
| — | `GET /api/forwards/:id/topology` 确实存在（`forwards.ts:282`，只读、`forward:read`）且 Web 侧零 consumer | grep 确认 |

运行时未复现 F11 的数值分叉：scratch 拓扑里没有流量流过（`tunnel_traffic` 0 行），因此只能确证到代码级；修完须用真实流量再做一次数值比对。

## 3.3 用户指令：Backlog 重排（2026-10-06）

用户明确要求：**先查 TuneX 是否已有该能力**，再只读研究 ForwardX 的产品行为，映射到既有服务，只补缺失部分；不要因为 ForwardX 有就重写 TuneX 已具备的后端。

| 顺序 | 项目 | 类型 | 现状判断 |
|---|---|---|---|
| 1 | Agent 一键接入（install/enroll/wait/upgrade） | ForwardX UX → TuneX lifecycle | 本专项当前切片；E1 修复连接真相是前置 |
| 2 | First-run 下一步 + 自助建组 | 前端编排 + EXPOSE | 预研完成（`first-run-recon.md`）；等 D1 释放 web 写入后派发 |
| 3 | 线路可视化创建（心智模型） | ForwardX mental model + TuneX Route | 未开始 |
| 4 | DDNS UI | 接已有 backend | TuneX 已有 executor/binding/backoff → 只补前端 |
| 5 | Forward 详情监控/诊断 | 接已有 telemetry | 后端更丰富，缺页面组织 |
| 6 | 通知设置中心 | 接已有 notification | 未开始 |
| 7 | Agent Upgrade UX | 接已有 node-upgrade | D2 正在修身份校验 |
| 8 | Forward Group / HA UX | 借鉴 ForwardX | 未开始 |
| 9–10 | PWA / Plugin API | 后期 | 暂不做 |

明确降级：Federation 新功能、workflow 新功能、更多底层抽象、主动增强 CI。许可证纪律不变：ForwardX 为 AGPL-3.0-only，只吸收思想与产品行为，代码走 clean-room。

## 3.4 环境卫生：源文件权限必须 644

发现全仓有一批**已跟踪**源文件是 `0600`（例如 `web/src/app/(admin)/layout.tsx`、`web/src/components/admin/federation/*`、`web/src/components/console/session.ts`，以及各代理新建的文件）。这不是内容问题，但会在两个真实场景炸掉：

- backend 镜像以非 root 的 `bun` 用户运行，`/app/src/**` 与 `/app/prisma/**` 中 0600 的 root 文件**运行期不可读**（本次真实集成第一次失败正是 `prisma migrate` 报 P3015「找不到 migration.sql」，实为权限不可读）；
- 任何以非 root 用户执行的构建/测试同样读不到。

已执行 `chmod 644` 归一（仅权限、无内容改动，git 不记录非执行位）。**后续所有子代理的写入范围说明都必须包含：新建文件权限用 644，不要用 0600。**

## 3.5 连接真相缺陷的真实爆炸半径（Leader 独立核查）

原缺陷不只是"UI 显示离线"。`status` 被闩死后，所有消费 `deriveConnection()` / `isNodeUnreachable()` 的子系统都会把**每一台节点**当成离线/不可达：

| 消费方 | 位置 | 后果 |
|---|---|---|
| 用户/管理端投影 | `services/node-view.ts:89` | 「在线」永远不可能出现 |
| 待办聚合 | `services/attention.ts:251` | 待办与告警口径错误 |
| 健康合成 | `services/node-health.ts:457` | connection 维错误 |
| **自动放置 / 故障切换候选** | `services/ingress-candidate.ts:109`（`requireOnline` ⇒ `node_not_online`） | **任何节点都不再是候选**：自动放置与 failover 选不出可用入口 |
| **协调器可达性** | `services/reconciler.ts:381,936`（`isNodeUnreachable`） | 可达性恒为 false ⇒ 期望状态无法被判定为可自动下发 |

也就是说：在 HTTP 上报型部署里（无 socket 会话），**自动放置、故障切换候选与协调器可达性同时失效**，只是它们不像 UI 那样立刻可见。E1 的修复恢复的是这些子系统共同的输入，因此修复后应重跑受影响的定向测试（`reconciler` / `ingress-candidate` / `attention` / `node-health` / `node-view`），而不是只看页面。

**安全性核查（重要）**：全仓**没有**任何"操作者主动把 `node.status` 置为 inactive"的写点——admin 侧只读 `status='active'` 做统计（`admin-extended.ts:427,731,885`），`node-admin.ts` 不写 status；操作者维度是 `lifecycle`（maintenance/disabled/retiring，独立判定）。因此"一次已认证上报 ⇒ status=active"**不会**撤销任何人的停用决定，也不会绕过凭据撤销（认证在写点之前）。

## 4. Capability Map

完整调查、Leader 校正、详细 Capability Map 与验收契约见 [onboarding-recon.md](./onboarding-recon.md)。

| Capability | TuneX Backend | TuneX Web | ForwardX | Gap | Action |
|---|---|---|---|---|---|
| Enrollment / install command | 一次性哈希token、TTL、撤销/消费、脚本已完整 | user/admin均能取命令 | 长期Token生成命令 | 不缺后端，保留安全模型 | REUSE |
| Waiting / online | /nodes服务端安全投影已有 | admin有；user缺 | 轮询列表徽章 | 用户复制后无下文 | INTEGRATE |
| TTL / timeout / retry / reissue | expires_at与重签语义已有 | TTL/后果不可见；用户无恢复 | 后果/下一步明确 | 共享等待与命令恢复体验 | IMPROVE |
| 成功下一步 | Forward API已有 | query可用，但无成功CTA | 回主机列表 | 需权限/role/admission感知 | EXPOSE |
| 无节点组 / 加载失败 | 用户域创建已有且entitlement门控；默认免费策略允许自建 | 缺create客户端/UI，空选择/禁用死路 | 空态按角色引导 | I1恢复说明；R2必须EXPOSE真自助入口，不绕过策略 | EXPOSE / IMPROVE |
| Health / 实际Agent版本 | 已有health/state report | admin已有，用户安装未接 | 可见状态与版本 | online不代表health passed | DEFER |
| Agent upgrade | 脚本/前置/回退已有 | 诊断面板能生成，完整体验缺 | 当前/目标/等待/恢复 | 另做vertical slice；配置缺口已记 | DEFER |
| 明文长期Token / 远程自升级 | 与TuneX架构不符 | 不需要 | 已实现 | 不吸收这些实现模式 | REJECT |

允许 Action：REUSE / EXPOSE / INTEGRATE / IMPROVE / REIMPLEMENT / DEFER / REJECT。

## 5. Productization Backlog

### NOW
- I1-A/B 并行实现纯 Web 用户接入闭环，按独占范围编辑，禁止扩展后端。
- 两项完成后派发独立审查，Leader 复核竞态/令牌/权限/角色/准入，运行全量 Web tests/typecheck/build。
- 验证可用节点组创建 → 保留原命令 → 页面等待 → 服务端 online → 权限/准入感知下一步；真实 enrollment/E2E 与健康/版本证据单独记录。

### NEXT
- 独立处理升级身份校验配置不可发现（TUNEX_PUBLIC_PANEL_URL）与升级 UX/等待口径。
- R2已确认：默认free_personal/free_team允许自建组；先EXPOSE用户域自助建组（必填port_range）+派生首启下一步，读取有效capabilities并保留node:manage、quota、真实403；不是绕过策略。无组说明本身不等于首台节点闭环完成。
- 管理员建组仅落管理员个人空间，不能当目标Workspace建组的权宜路径。RouteProfile不在首条Direct Forward关键路径。
- 用户安装CTA的ingress_node_id query已被列表筛选消费，openCreate也用该筛选预选入口；无需重复实现预填（Leader复核修正R2-A此项推断）。
- 对真实浏览器与实际 Agent 安装执行验证，避免把 mock/SSR 当真实安装。
- enrollment 事务缺少便宜单测，已有重放401 topology保护；按风险/测试预算独立评估。

### LATER
- DDNS 产品化、Forward 可观测性。
- Notification Center、Agent Upgrade UX、高可用体验、节点管理与诊断。
- PWA/移动体验与插件：按 ROI 和专项退出条件决定。

### REJECTED / 默认不做
- 复制 ForwardX AGPL 实现代码。
- 创建重复 Desired State、Ledger、onboarding 状态机或绕过现有权限模型。
- 无关 Federation/runtime/数据库扩张与 CI 重构。

## 6. 验证记录

| 检查 | 状态 | 证据 / 说明 |
|---|---|---|
| 工作树与分支检查 | 已完成 | 启动时只有参考目录及 docs/agent 未跟踪；当前分支见上 |
| 指定模型可用性 | 已完成 | 模型目录返回 txapi/deepseek-v4.1-flash，支持 low/medium/high/xhigh |
| 工程/Web 约定与脚本 | 已阅读 | Web 提供 `typecheck`、`build`，未提供 component test 脚本；Backend 提供 typecheck、bun unit、node integration |
| Web 基线 typecheck | 通过 | `cd web && npm run typecheck`，退出码 0 |
| Web 基线测试 | 通过 | `cd web && bun test src`：574 pass / 0 fail，32 files，5386 assertions；包含 mock、SSR 与源码守卫，不等同浏览器 E2E |
| Backend 基线 typecheck | 通过（重生成 Prisma Client 后） | 首次 `bun run typecheck` 退出码 1，缺少模型/字段；当前 schema 存在对应定义。执行 `bun run generate && bun run typecheck` 退出码 0，确认是陈旧生成依赖，不修改 schema/source/migrations |
| Backend enrollment 基线 | 通过（有环境告警） | `cd backend && bun test src/services/__tests__/node-enrollment.test.ts`：3 pass / 0 fail，12 assertions；Redis 127.0.0.1:6379 ECONNREFUSED，未验证 Redis/DB/真实 enrollment |
| Backend 复用契约基线 | 通过（同样有Redis告警） | 6个相关test：node-bootstrap / node-upgrade / node-credential / node-view / node-lifecycle / node-reprovision；184 pass / 0 fail，584 assertions，退出码0，约1.1s。含mock与脚本断言，不等同真实DB/Agent安装 |
| Web 基线 build | 通过 | `cd web && npm run build` 退出码0，Next 16.3.6，38页生成；既有路由含 /nodes、/forwards 与管理员节点详情 |
| 变更后 Web 门禁（修复前构建） | 通过 | `typecheck` 0 错；`bun test src` 674 pass / 0 fail（35 文件，基线 635）；`build` 38 页。修复 D1/W1 落地后需重跑 |
| 变更后 Backend 门禁 | 通过 | `bun run typecheck` 0 错；`bun test src` **2806 pass / 0 fail**（124 文件，15288 assertions），含 D2/D3/E1 的改动 |
| 真实端到端（首切片闭环） | 通过 | 真实 UI + 真实 Panel + 真实 Agent 容器，零手工写库：创建 → 等待 → 真实 Agent 上线（15s 内 `online`）→ 成功 CTA `/forwards?ingress_node_id=8`；一次性 enrollment 重放 401；浏览器无 ≥400 API |
| 修复后独立复核 | 进行中 | E2 只读复核 E1/D1/D2/D3/I1-A2/I1-B2 的声明（含真实 `docker exec` 与受控异步复现） |
| W1 切片与真实后端的形状核对 | 通过 | ①真实 `GET /api/me/capabilities` 满足 `lib/api/capabilities.ts` 投影要求的每一项（`allow_custom_in/out_group` 为 boolean、`limits.max_nodes/max_tunnels`、顶层 `nodes/tunnels`、`expiry.deny_scope/deny_message` 均存在）→ 生产不会永远"取不到"；②`GET /api/node-groups` **恒定**返回 `{data:{data,total,page,page_size}}`，面板用 `total` 而非 `data.length` 正确；③`lib/first-run.ts` 复核：读时派生、无状态机/localStorage、`null`＝未读到≠0、事实缺失一律 `unknown` |
| 真实验证环境 | 已检查，尚未部署 TuneX | Docker CLI可用；当前运行容器无TuneX，其他业务容器不改动；Redis本机6379不可达，不借用其他产品实例 |
| 真实安装、浏览器与 Agent 接入 | 未执行 | 源码调查不能替代真实端到端验证 |

## 7. 变更与交接日志

### 2026-10-06 — 专项启动
- 用户指定 DeepSeek V4.1 Flash 并指定本文件作为团队状态记录。
- 已派发三路独立只读调查；等待事实与产品差距，尚未派发编码任务。
- 保护用户已有未跟踪文档和参考副本，不将参考项目带入提交。
- 下一步：Leader 在代理执行期间确认工程测试入口与分支基线；三份结果到齐后更新此文件并确定开发切片。

### 2026-10-06 — 三路 Recon 收束 / 批准 I1
- 三份报告均已收到，结论及 Leader 修正已持久化到 [onboarding-recon.md](./onboarding-recon.md)。
- 首个切片为纯 Web 用户接入等待/恢复，不重建 Backend。明确用户适配不能使用 admin-only API，online 不等于 healthy，不隐藏角色或绕过组策略。
- I1-A/B 已按独立写入范围并行派发，模型统一 txapi/deepseek-v4.1-flash/high。共享接口约定与验收标准见调查文档。
- 当前阶段不宣称首台节点 1–2 分钟真实接入或 Epic 1 DONE。无组的真正自助路径、真实health/版本与升级闭环仍属后续差距。
- 验证环境仅检查现有服务，未创建新服务、未借用其他产品数据库/Redis。
- 下一步：收集 I1-A/B，派发只读独立审查，Leader集成并执行变更后门禁。

## 8. 完成与收尾判据

本专项尚未完成。Epic 必须同时具备可用 UI、真实 API 集成、可恢复失败路径、关键行为测试、相关检查通过与必要文档清理。最终按指南 Exit Conditions 逐项核验，不以 API 完成或代理回复 Done 视为完成。

每轮交接至少更新：当前阶段、任务/依赖/写入边界、结论及依据、变更、实际测试结果、未完成事项和下一步。

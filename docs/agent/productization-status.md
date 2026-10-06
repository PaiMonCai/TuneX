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

## 3.6 待解决回归：路由模块作用域引入 redis（会让全量变红）

**现象**：`bun test src --timeout 10000` 中 `workspace-rbac.test.ts`（WP10 子进程用例）稳定在 ~10s 超时失败；00:11 时它还是 178ms 通过。

**根因（D4 受控实验定位，非猜测）**：延迟历史切片在 `backend/src/routes/forwards.ts:52` **模块作用域**引入 `import { targetKeyOf } from "../services/node-state.ts"`；`node-state.ts` 传递依赖 `redis.ts`（`lazyConnect:false`，连不上无限重试）⇒ 任何 import `forwards.ts` 的子进程都**不会自然退出**。`workspace-rbac.test.ts` 的子进程只 mock 了 forward-service / tunnel-api，没有 mock node-state，靠"进程自然退出"收尾，于是被外层 `--timeout 10000` 判失败（它自己的 spawn 预算是 30s，两者本身也错配）。
- 实验：只 mock `forward-service` 再 import `routes/forwards.ts` → 10s 不退出；**再多 mock 一条 `node-state`** → 549ms 正常退出。差别只有 node-state。
- 归因：排除新增测试文件后重跑全量（125 文件）同样红，与 D4 的 DDNS 改动无关。

**Leader 独立验证 + 依赖链追查（结论可直接执行）**：
- 单独跑 `bun test src/routes/__tests__/workspace-rbac.test.ts --timeout 10000` → **10.01s 超时失败**，日志里出现 `[redis] error: connect ECONNREFUSED 127.0.0.1:6379`，与"子进程因打开的 Redis 句柄无法退出"一致。
- 完整依赖链：`routes/forwards.ts:52` → `services/node-state.ts:15` → **`services/node-credential.ts`（node-state 依赖图中唯一 import `redis.ts` 的模块，5 处命中）** → `services/redis.ts`（`lazyConnect:false`）。
- 因此"只删 `targetKeyOf` 这条模块作用域 import（或改惰性 `await import`）"是**有效**修法；mock 其它模块（forward-service/tunnel-api）无效，因为 redis 是被 node-state 这一条链拉进来的。

**修法（优先级从高到低）**：
1. 让 `routes/forwards.ts` 不在模块作用域把 redis 拉进来（改用不依赖 node-state 的本地实现/已有 helper，或惰性 `await import`）；若 `targetKeyOf` 可不用最好；
2. 或修 `workspace-rbac.test.ts` 的收尾（`process.exit(0)`）——但这只是掩盖，必须同时说明为什么模块作用域 import 是合理的；
3. 不允许用测试改绿来掩盖真实问题。

**状态**：已要求 D6 在其任务内修（其简报本就要求全量 0 fail），因 `send_message` 对普通子代理不可用，无法中途指挥。**若 D6 交付时仍红，由 Leader 直接修**（此时代码已停止写入）。在修好之前不跑"官方门禁"结论。

## 3.7 团队形态调整（用户决定，2026-10-07）

**背景**：普通一次性子代理在本专项暴露出三个结构性限制——① `send_message` 对其返回 `active teammate ... not found`，**无法中途指挥**（D4 诊断出 D6 引入的回归时我无法把反馈送进去）；② `list_agents` 看不到它们，**无法观测谁在跑**，只能靠文件 mtime 猜；③ 没有共享任务板，写入范围只是简报里的口头声明，**冲突无法被系统校验**（D5 与 W1 撞同一棵树导致我的门禁作废）。

**决定**：收干净当前 3 个在途子代理（D5/D6/E2）后，**切换到 Agent Teams**：为剩余切片创建持久队友，用共享任务板声明写入范围与 `blocked_by` 依赖，Lead 只做集成与验收。

**已建立的共享任务（先于队友创建，便于直接认领）**：
| 任务 | 内容 | 写入范围要点 | 依赖 |
|---|---|---|---|
| `task-1` | DDNS Web：设置页服务商 CRUD + `forward-dns-card.tsx`（自包含） | `lib/api/ddns.ts`、`lib/ddns-i18n.ts`、`components/ddns/`、`mocks/handlers/ddns.ts`、`lib/api.ts`、`lib/nav.ts` | 无 |
| `task-2` | Forward 详情：`forward-topology.tsx`（topology 首次消费）+ 修 F11 死列 | `components/forwards/forward-topology.tsx`、`lib/api/forwards.ts`、`mocks/handlers/forwards.ts` | 无 |
| `task-3` | 集成：把两块卡片挂进 `forward-detail.tsx`（**Lead 独占写点**） | 仅 `components/forwards/forward-detail.tsx` | task-1、task-2 |

把 `forward-detail.tsx` 单独抽成集成任务的用意：DDNS 切片与链路切片都想改它，这正是先前并行双写产生冲突的同型问题；现在两个组件任务都被要求**不碰**该文件，冲突点在任务板层面被消解。

## 3.8 E2 独立复核结论（本轮最重要的质量输入）

被复核的 9 个文件 sha256 全程未变；E2 重跑门禁：backend `bun test src` **2820 pass / 0 fail**、`tsc` 0；web `bun test src` **783 pass / 0 fail**、`tsc` 0。

### 被推翻 / 需要纠正的声明（记录下来，避免继续传播）

| 编号 | 结论 | 影响 |
|---|---|---|
| **F1 (P1)** | D2 的「身份校验通过」**可被一个未鉴权的 200 骗过**：`node-upgrade.ts:314-321` 的 wget 分支取**最后一个**状态码，而 wget 默认跟随重定向 ⇒ 假面板 `302 → /login(200)` 就得到 `VERIFIED=yes`（curl 分支无 `-L` 则给 302→"未校验"，两分支语义相反） | 我此前"不可能在没有 HTTP 200 时说通过"的结论**只在我测过的场景成立**（真 Panel 200 + 无地址），重定向场景没测 → 已派 `task-5` 修（禁跟随重定向 **且** 要求响应体像 Panel JSON） |
| **F2** | 「90s 窗口只有一处定义」**全局不成立**：`reconciler.ts:53`、`target-health-thresholds.ts:113`、`scheduler-support.ts:293` 各自写字面量，web 侧另 3 处；只有一处测试断言了其中一对 | E1 自身"两个写入方向共用同一常量"**成立**，但§3.2 那句话不应被读成"全局单一真相" |
| **F3 (P2)** | D3 的 `rangeConflict`（`node-groups.ts:287-292`）在 `checkNodeCreation` 之前返回 ⇒ 无策略空间里给无区间组加节点得 409「请新建带区间的组」，而同空间建组是 403 —— **把用户指向死路** | 已派 `task-5`：能力拒绝应优先于可修复状态 |

### 已确认成立（可计入验收证据）

E1：①未认证写回 `active` **不成立**（全仓写点枚举 + 真实 HTTP：无/错凭据 401、admin 路由未认证 401、普通用户 403，status 全程不变）②撤销/封禁 401 且不写 status ③只写 `last_seen_at`+`status` 两列，lifecycle/port_range/role/lease 计数不变 ④并发抖动未复现（40 轮上报×清扫 inconsistent=0/flap=0，89.998s 边界不翻）；真实 MySQL/Redis 11 项全绿。
D2：②当前版本**不发空 Bearer**（无/空凭据时根本不发请求），并实测证实旧写法在 `docker exec` 下确实是空变量（`auth_len=7`）；③四类场景（无 curl/wget、agent.env 缺失、不可达/超时、非 200）全部落"未校验"；④只有 401/403 回滚；⑤busybox ash 实测 `. /nope` 直接退出 rc=2，`[ -r ]` 守卫有效。
D3：零副作用成立；既有 `groupConflict/roleConflict/runtimeEdit/400` 仍按序生效。
I1：轮询 single-flight / 独立 deadline（`loadView` 永久挂起也超时）/ dispose 不复活 / stop→start 不死锁 成立；unknown 不渲染成已连接（真实组件 SSR × 9 档）；D1「一个称呼」同源成立。**观察项 F4**：`onView` 在 try 内，消费者抛错被当成取数失败并**跳过闭环判定** → 已派 `task-5`。
敏感信息：localStorage/sessionStorage/URL/console/SSR payload/mock 日志 —— **静态成立，运行时未验证**。

### 未验证（不得写成通过）

真实浏览器里驱动整条用户路径（E2 的 harness 只完成静态挂载）；组件层 `catch/finally` 的运行时丢弃；真实 30s 节奏下的长时抖动；web `build`（E2 未跑）。

### 新增缺陷任务

`task-5`（F1 身份校验可被未鉴权 200 骗过 + F3 能力拒绝被遮蔽 + F4 轮询吞异常 + F6 mock 同名语义，已派 `backend-truth`）、`task-6`（F5 Agent 心跳 `/api/internal/heartbeat` 后端无路由、每 30s 404，待派）。

## 3.9 环境事件与验证夹具（必须记录）

1. **容器名冲突导致环境中断**：另一个代理自建一次性 scratch 栈时用了与我同一套 `tunex-it-*` 容器名，其清理动作删除了我的 `tunex-it-mysql` 与 `tunex-it-redis`（panel/worker/4 台 Agent 存活，API 表面 200 但登录阻塞）。数据卷 `tunex_it_mysql_data` 存活 → 用同一 compose `up -d mysql redis` 恢复，**数据完好**（3 用户 / 8 节点 / 7 组 / 3 转发）。**规则**：任何一次性 scratch 栈必须使用唯一容器名与网络名（或直接复用 Lead 的 scratch 栈），禁止覆盖既有 `tunex-it-*` 名。
2. **管理端真机验证夹具**：为在真实后端上验证管理端（否则只能读码断言），在 scratch 库给测试用户 `tunex-it-e2e@tunex.local` 置 `super_admin=1`（**仅限该一次性测试库**，与仓库 `setup.sh` 抬高团队额度同类）。借此取得真机证据：`/api/admin/node/1/detail` → **200**、`/api/admin/nodes/1`（web 现用复数）→ **404**、`/api/admin/node/1/pools` → 200、`/api/admin/nodes/1/pools`（web 复数）→ **404** → 见 `task-4`。

## 3.10 团队形态（生效中）

3 名持久队友（均可 `send_message` 中途纠偏、可观测状态）：`web-ddns`（task-1 DDNS Web）、`web-forward`（task-2 Forward 链路 + F11 换源）、`backend-truth`（task-5 E2 缺陷修复）。
Lead 负责：`task-3`（把两块自包含组件挂进 `forward-detail.tsx` 的**独占写点** + 最终门禁/浏览器验收）、`task-4`（管理端 API 契约对齐，已有真机证据）、`task-6`（F5 心跳死端点）与最终提交。

## 3.11 task-4 进展（Lead 自己在做）：管理员节点路径族的**真实**边界

**不要**把"复数一律是错的"当作规则——真机实测（scratch Panel + 管理会话）：

| 路径 | 真机 | 判定 |
|---|---|---|
| `GET /api/admin/node/:id/detail` | **200** | 正确（`node-admin.ts:101`） |
| `GET /api/admin/nodes/:id` | **404** | ✗ web `nodeDetail` 曾走这里 → **已改单数** |
| `PATCH`/`DELETE /api/admin/nodes/:id` | 由 `admin-extended.ts:672/675` 提供（200 家族） | ✓ web 的 `updateNode`/`removeNode` **本来就对**，**不得**改成单数 |
| `GET /api/admin/nodes`（列表） | 200 | ✓ |
| `GET /api/admin/nodes/:id/pools` | **404** | ✗ 已改 `/node/:id/pools` |
| `PATCH /api/admin/node/pools/:poolId`、`DELETE /node/pools/:poolId`、`POST /node/pools/:poolId/targets`、`PATCH|DELETE /node/targets/:targetId` | 单数由 `node-admin.ts:192/211/258/291/308` 提供 | ✗ 已改 |
| `GET /api/admin/node/:id/lifecycle`、`/node/:id/impact`、`/node/:id/state`、`/node/:id/health`、`/node/pools/:poolId/health` | 200 | ✓ 本来就对 |

已完成的代码改动：`nodeDetail` 改单数 + **线上嵌套形状 → 界面扁平模型的显式投影**（新增 `projectNodeDetail`，并从中**移除** `state` 字段——该端点已不提供运行态，留着会被读成"没有上报"）；pools 列表解**两层信封** `{data:{data,total}}`；pool/target 方法签名与新路径一致（`node-egress-pools-panel.tsx` 4 处调用点同步更新）；补齐**缺失**的 `common.loadFailed`（zh/en）——它有两个消费方，其中一个在**用户域**（`topup-body.tsx`），此前一直渲染裸 key。

待做：mock 对齐（删复数扁平 `GET /admin/nodes/:id`，改单数嵌套 + 单数 pools/targets）、路径↔后端声明的对照测试、真机复核。

### task-4 进展（Lead，2026-10-07）

已提交：`465959b`（详情走真实单数路径 + 显式投影 + 出口池单数路径 + 补 `common.loadFailed`）、`e1f0828`（mock 与真实同形 + 修 5 处固化旧契约的测试）。

mock 与真实后端对齐时发现两处**结构性差异**（都属于"mock 撒谎"）：
1. **池列表信封**：mock 返回扁平数组，真实后端是 `{data:{data,total}}` ⇒ 客户端按信封读取会永远显示空池；已让 mock 返回同形信封。
2. **targetId 是全局的还是按池的**：真实后端按 targetId **全局寻址**（`/node/targets/:targetId`），而 mock 的 `nextTargetId` 是**按池**分配 ⇒ 每个池都有 id=1，按真实路径操作会命中**别的池的同号目标**（实测：DELETE 返回 ok，但被删的是种子池里的同号目标，PATCH 那个"已删"目标仍 200）。已改为全局唯一。

顺带修掉我自己引入的一处遮蔽：新增的 `/node/pools/:poolId` 分支把 `/node/pools/:id/health` 也吞了（→ 404「接口不存在」），已限定尾段。

定向测试现状（`src/mocks/__tests__ src/components/admin/__tests__ src/components/forwards src/components/nodes`）：**696 pass / 3 fail → 修完 1 条后剩 2 条**，两条都与 provision 相关：`POST /node-groups/:id/nodes` 在**合跑**时返回 201 但 body 无 `node`（**单跑通过**），已带精确证据交回拥有 `mocks/handlers/catalog.ts` 的 `backend-truth`（合跑/单跑差异属跨文件共享 mock state，需他们按真实形状定位并补可复现的行为测试）。

## 3.12 最终集成门禁与真实浏览器验收（2026-10-07 01:0x，冻结工作树）

**门禁（由 Lead 亲自运行，并在运行期间校验工作树指纹未变 → 结论对应当前代码）**：

| 检查 | 结果 |
|---|---|
| backend `tsc --noEmit` | 0 错 |
| backend `bun test src` | **2825 pass / 0 fail**（126 文件，15384 assertions） |
| web `npx tsc --noEmit` | 0 错 |
| web `bun test src` | **958 pass / 0 fail**（53 文件，7420 assertions） |
| web `npm run build` | 成功（Next 16.3.6，38 页） |
| 工作树指纹 | 运行前后一致 → 门禁有效 |

**真实浏览器 + 真实后端验收（同一冻结构建）**：

A) Forward 详情两块卡片（RELAY `/forwards/2` 与 DIRECT `/forwards/1`）：
- 链路卡片与 DNS 前门卡片**都渲染**；
- DIRECT 正确呈现「直连」与「无节点间跳是设计结论」措辞；
- 累计流量按账本口径显示 **「无数据」而非 `0 B`**，并标注窗口（2026-09-24~10-07，Asia/Shanghai 日界）、归档节奏（每 10 分钟，今天是不完整日，最多滞后 10 分钟，面板无实时速率）与口径来源；
- DNS 卡片显示 `unbound` + 服务端推导的期望地址；**禁用词（正常/健康/可达）零命中**；无 ≥400 API 错误。

B) Onboarding 端到端（重跑，验证最终构建）：
- 先复现闩锁（`inactive|NULL` → connection `waiting`）；
- 消费真实 enrollment + 启动真 Agent 容器 → **5 秒内 `online`**（`registered/has_credential/accepts_new_business` 齐备）；
- 成功 CTA「创建第一条转发」→ `/forwards?ingress_node_id=9`；一次性 enrollment **重放 401**；无 API 错误。

## 3.13 仍未关闭的项（不得当作已完成）

| 项 | 说明 | 归属 |
|---|---|---|
| F1 残留 | busybox wget 无法禁止跟随重定向 → **跨主机跳转时凭据是否外发未验证**；且「响应体像 Panel JSON」是结构性 grep 判定（镜像内无解析器），刻意构造 `{"data": <非 JSON>}` 仍会被判通过 | 新小切片 |
| F2 | 「90s 窗口只有一处定义」全局不成立（reconciler / target-health / scheduler 各自写字面量，web 侧另 3 处） | 未派 |
| F5 | Agent 心跳 `/api/internal/heartbeat` 后端无路由，每 30s 404（`task-6`，未派） | 未派 |
| F8/F9 | `dispose()` 在从未 `start()` 时不回调 `onStop`；`stopTimeoutS/checkTimeoutS` 未过 `safeToken`（当前不可注入） | 未派 |
| DDNS 运行时四态 | `synced` / `synced_unverified` / `error` / 退避在真实环境**未观察到**（无可写目标 + 30s 节拍） | 未验证 |
| 升级完整流程 | 仅验证了探针在真实镜像下对真/假端点的行为，**未在真实节点跑完整 pull→stop→run→校验** | 未验证 |
| 延迟端点 Web 消费 | D6 已交付只读端点（含四态与截断语义），Web 侧尚未消费 | 新切片 |
| mock 与真实剩余分叉 | 已存在节点 + 显式不同 `role` → 真实 409（mock 不判）；带 `targets` 的重装 → 真实 409（mock 忽略） | 记录在案 |

## 3.14 Round 19 派发（补齐退出条件 #3 / #6 / #7 的缺口）

用户已批准"由我自行判断何时用一次性子代理、何时用持久队友"。本轮的判断与派发：

| 任务 | 形态 | 执行者 | 依据 |
|---|---|---|---|
| `task-7` Forward 详情第三块：消费延迟端点（四态/截断/409 与无数据可分） | 实现（持久队友，唤醒既有成员） | `web-forward`（task-2 的延续，最熟悉链路与 observability 纪律） | D6 已交付只读端点；退出条件 #4/#8 |
| `task-6` F5：Agent 心跳 `/api/internal/heartbeat` 后端无路由（每 30s 404） | 实现（持久队友，唤醒） | `backend-truth`（task-5 的延续，已掌握 agent↔panel 契约） | E2 复核 F5；退出条件 #8 |
| R4-A「通知中心」只读预研 | **一次性子代理**（只读、隔离、不需中途纠偏） | 新 subagent | 退出条件 #6，尚未预研 |
| R4-B「线路创建的用户心智模型」只读预研 | **一次性子代理**（同上） | 新 subagent | 退出条件 #3，尚未预研 |

判断原则（本专项实践总结）：**只读预研/独立复核 → 一次性子代理**（便宜、上下文隔离、无写入冲突）；**多步实现、需要中途纠偏、与既有切片相邻文件 → 持久队友**（可 `send_message` 指挥、可观测状态、共享任务板带写入范围与依赖）。

## 3.15 Round 20 收口与派发

### 已完成（本轮）
| 任务 | 结论与证据 |
|---|---|
| **task-6 / F5**（`backend-truth`） | **定性为 Agent 侧遗留死代码**，不是后端能力被移除：`git log --all -S "/api/internal/heartbeat" -- backend/` = 0 提交；真机 Panel 近 10 分钟 **80 条 404**（同窗口混着真 404，实证"掩盖"）。已在 Agent 侧删除（`Run` 只发 state report，闸门改为"无凭据就什么都不发"——比旧行为更严）；受控 recording panel 对照：旧镜像 heartbeat ×1 → 新镜像 **×0** 且 state 照常；`go build/vet/test` 全绿（13 包）+ 反向变异验证。**裁决**：**不**给该幽灵端点补路由（会把从未存在的端点写进路由表并需要自己的鉴权故事）；`scripts/perf/stream-baseline.py:275` 的历史路径列入清理项 |
| **task-7 / 延迟卡片**（`web-forward`） | 35 pass；真机对比：真实序列 97 点里 **77 个 `latency_ms:null`** → 折线切成多段、**不补零不插值**；**409 `raw_window_expired` 与 200 `no_samples` 实测是两种东西**；**实测确认服务端忽略客户端传的 `node_id`/`target_key`**（安全边界成立）；`no_samples` 是时间性的（同一窗口先空后有桶） |
| **task-3 第三块挂载**（Lead） | 延迟卡片已挂进 Forward 详情（`2715313`）；`tsc` 0 错 + forwards 套件 **294 pass / 0 fail** |

### 本轮新发现（均属"后端有能力、产品路径不通"）
1. **DDNS 在默认部署下永远不会写**（阻塞退出条件 #5）：`failover-loop.ts:220` 两开关都关即 `evaluated:0` 直接返回；`FAILOVER_POLICY` **缺省即关**（真机取证 `{"auto_failover":false,"auto_failback":false}`）；实测绑定 + `auto_resolve=true` 后等 150s，假 DNS 服务**零写入**、worker 无 ddns 日志 → `task-8`（`backend-truth` 正在做）。
2. **多跳后端已完整实现且准入已开、Web 零接线**（退出条件 #3 的机会）：`middle_node_id` 已在 create/patch schema、有邻接两段绑定校验、`multiHopImplemented: true`、调度器分配中继端口；Web 全仓 grep `middle_node_id` **命中 0**。隐藏契约：中间跳必须 `role ∈ {ingress, both}`（待裁决）→ `task-9`（纯 Web 线路预览）先做，多跳接线另开。
3. **通知中心缺的是后端接线**（退出条件 #6）：见 `docs/agent/notification-recon.md`（已持久化）→ `task-10`（渠道配置端点）/`task-12`（用户偏好 EXPOSE）/`task-11`（worker 接线，**blocked_by task-10 与 task-8**，因为都要改 `worker.ts`）。

### 团队（4 名队友）
`web-ddns`（task-1 完成）、`web-forward`（task-2/7 完成，正在 task-9）、`backend-truth`（task-5/6 完成，正在 task-8）、**`notify-center`（新，负责通知 epic：task-10 → task-12 → task-11）**。
Lead 负责：task-3 挂载集成（已完成三块卡片）、task-4 收尾、最终门禁与真实浏览器验收、统一提交。

## 3.16 Round 21：三条裁决 + 通知 epic 队列补齐

### Lead 裁决（记录理由，避免反复）
| 事项 | 裁决 | 理由 |
|---|---|---|
| F5 幽灵心跳端点 | **不给后端补路由**（该端点从未存在过） | 补一个不写状态的弃用路由会把"从未存在的端点"写进路由表，并需要它自己的鉴权/限流故事；正确做法是 Agent 侧删除（已做）+ 旧镜像走既有升级路径 |
| 多跳（`middle_node_id`）隐藏契约 | **显式要求中间跳节点 `role ∈ {ingress, both}` 并在 UI 讲清**，本轮**不放宽**绑定 API | 绑定 API 要求**来源**节点是 ingress/both 是模型语义（第二段绑定的来源就是中间跳）；为多跳放宽会让"中间跳"变成第二套编排入口。因此多跳接线前要先有 truthful 的前置说明（`task-9` 的线路预览正好提供这个位置） |
| `scripts/perf/stream-baseline.py` 里的历史路径 | **已清理**（假面板只认真实存在的端点） | 继续把死路径算作"可接受路径"会让性能基线的 404 计数与真实部署不一致——正是"假面板替真后端撒谎"那一类 |

### 通知 epic 队列补齐（板上）
`task-10`（N2 渠道配置端点，进行中）→ `task-12`（N1 用户偏好 EXPOSE）→ `task-11`（N3 worker 接线，**blocked_by task-10 + task-8**，因为都要改 `worker.ts`）→ `task-13`（N4 投递失败可见性，**blocked_by task-10**，同一权限族）→ `task-14`（N5：SMTP 的 UI 配置不生效 + 文档谎 + `secret_configured` 类型缺口）。
已把完整队列与"禁止自行放宽契约"的要求一并发给 `notify-center`。

### 在途
`web-forward`（task-9 线路预览）、`backend-truth`（task-8 DDNS 写入路径解耦）、`notify-center`（task-10 渠道配置端点）。Lead 负责集成、门禁与提交。

## 3.17 Round 24：并行铺开（用户要求加速）

### 团队（7 名持久队友 + Lead）
| 队友 | 在飞 | 队列 |
|---|---|---|
| `web-ddns` | — | `task-19` 多跳接线（**blocked_by task-9**，等待期做只读准备） |
| `web-forward` | `task-9` 线路预览 | — |
| `backend-truth` | `task-8` DDNS 写入路径解耦 | `task-15` F1 残留（凭据可被 3xx 带出容器） |
| `notify-center` | `task-10` 渠道配置端点 | `task-12` 用户偏好 → `task-11`（blocked_by task-8）→ `task-13`（blocked_by task-10）→ `task-14` |
| **`ha-ui`**（新） | **`task-16`** 高可用/多入口读投影 + 自包含卡片 | — |
| **`upgrade-ux`**（新） | **`task-17`** Agent 升级的用户侧完整流程 | — |
| **`misc-truth`**（新） | **`task-18`** persona 路由 + 受控错误页 + admin 403≠空 + 概念残留 + 两处小缺陷 | — |
| Lead | 集成挂载（task-3 三块卡片已完成）、门禁、真实浏览器验收、统一提交 | `task-4` 已 complete |

### 本轮的两个上游动作
1. **`task-15` 建单并实证**：镜像内 busybox wget v1.37 **不支持 `--max-redirect`**（`wget --help` 只有 `-cqS/--spider/-O/-o/--header/-U`）⇒ 面板返回 3xx 指向别的主机时，探针会**把节点长期凭据重发过去**。E2 修掉的是"假通过"，这一条是**凭据外发**，性质不同 → 指派 `backend-truth`。
2. **routes 页文案的自相矛盾**（R4-B 的 G3）：原文案先说"下一步：在创建转发时选择合适的线路"、又说"目前还不支持从线路直接创建转发"——**第一句承诺了契约上不存在的操作**。已改为一句真话（"线路由管理员编排并作用于**已经存在**的转发；创建转发时不需要也无法选择线路"），并把钉住旧文案的源码断言改为断言真话。`tsc` 0 错、该套件 28 pass / 0 fail。

### 并行时的写点纪律（已写进各任务描述）
- `lib/api/forwards.ts` / `mocks/handlers/forwards.ts` 由 `task-9` 独占 ⇒ `task-16` 用**独立模块** `lib/api/forward-ha.ts`；`task-17` 用 `lib/api/node-upgrade.ts`；`task-19` **blocked_by task-9**。
- `worker.ts` 由 `task-8` 与 `task-11` 共享 ⇒ `task-11` blocked_by task-8。
- `forward-detail.tsx` 是 **Lead 独占挂载点**；所有卡片任务都要求"自包含、不碰它"。
- `lib/i18n/dictionaries.ts` 暂无人改，仍建议各切片用独立 `*-i18n.ts` 模块。

## 3.18 DDNS 写入路径修复：**已在验收环境验证通过**（里程碑）

`task-8`（`backend-truth`）交付：worker 新增独立节拍 **`cron_ddns_sync`（30s）**，遍历 `dns_auto_resolve=true 且 dns_provider_id 非空` 的转发，调用**同一个** `runDdnsSuccessor`/`syncForwardDns`；**不改** `auto_failover` 缺省、**不用** `dnsPathReadiness` 当闸门（那个闸门对新绑定是鸡生蛋）、**没动** `failover-loop.ts` 一行。

**委托方自证（隔离栈）**：策略两开关都关（= 生产缺省）时仍写出；值集未变零外呼；失败退避（`attempt_count=1`、`next_attempt_at=+5s`）且**不覆盖已确认值**；自愈；11 条测试反向变异 9 条变红；后端 `bun test src` **2859 pass / 0 fail**。

**Lead 在验收拓扑上的独立复核（关键）**：重建后端镜像 → 重启 Panel/Worker → 确认 `[worker] registered 7 cron schedulers: …,cron_ddns_sync,…` 且该 job 每 30s 运行 → 用假 DNS 服务（`endpoint` 覆盖，契约允许）走真实链路：

```
bind forward2 → pending（expected_values=["172.33.10.20"]，来自入口节点 connect_ip）
t+5s → state=synced  verified=true  confirmed=["172.33.10.20"]  attempt=0  next=null
假 DNS 日志：POST {"domain":"e2e-ddns.example.com","type":"A","values":["172.33.10.20"],"ttl":300}
            + GET（读回确认）
```

⇒ **在 `FAILOVER_POLICY={"auto_failover":false,"auto_failback":false}`（生产缺省）下，"绑定域名 + 开自动同步"现在真的会写并读回确认**——退出条件 #5 的阻塞点已消除并实测。验证后已还原现场（解绑 + 删除 provider + 删除临时容器）。

## 3.19 Round 25：两路只读审查已派发 + 两处授权

| 任务 | 形态 | 内容 |
|---|---|---|
| **R5-A** | 一次性子代理（只读） | **ForwardX 产品对齐审查**：退出条件 10 条逐条判定、"能力有路径不通"清单（要求给**自己复核过**的证据，并区分"已复核"与"仅文档"）、刻意不同项的理由是否仍成立、距 #10 的差距排序 Top3 |
| **R5-B** | 一次性子代理（只读） | **已完成切片的缺陷检修**（敌意复核）：客户端路径/形状 vs 后端声明、mock 是否在撒谎、`catch → null/[]` 是否让界面给出错误结论、异步竞态与晚到响应、敏感信息泄漏面、测试是否在钉错误契约、缺省配置下功能是否真会触发、i18n 与措辞；每条要求**自己的证据**，允许反驳文档与既有结论 |

**授权**：`ha-ui`（task-16）最小 3 行接入 `web/src/mocks/handler.ts`（`handleForwardsMock` 把 `/forwards/*` 整个命名空间认领了，新 mock 模块必须排在它**之前**才可达；该文件当前无其他写者）——已补进 task-16 的 writeScopes。
**催办**：`ha-ui` 已回复（在读码/规划后继续，Phase A 设计已认可）；`upgrade-ux` 无产出且 inactive，已要求回报卡点，并提醒它在升级流程里同样要检查"默认配置下是否永不触发"这类缺陷形态。

## 3.20 又两例"能力有、路径不通"（队友只读取证，已记）

| 发现 | 证据 | 处理 |
|---|---|---|
| **`agentLatestVersion` 缺省为空 ⇒ 面板永不判 Agent 版本落后** | `upgrade-ux` 在真机只读确认：`env.agentLatestVersion`（`TUNEX_AGENT_LATEST_VERSION`）缺省空，`node-health-service.ts:72-82` 据此**不判定落后** ⇒ 默认部署下"升级建议"永不出现 | **不伪造**"是否落后"（如实显示"部署方未声明版本基线，面板无法判定"）；同时把它变成**可发现**的配置 → 已把 `.env.production.example` 加进 task-17 范围（照 D2 给 `TUNEX_PUBLIC_PANEL_URL` 的写法）。`docs/production-deploy.md` 由 task-14 占用，避免双写 |
| **用户域没有任何"实际上报版本"投影** | 同一队友真机取证：`node.version`（管理配置字段）**9 台全 `unknown`**，而 `node_state_report.version` 是 `0.13.22`（节点 1–5/7–9；节点 6 无 state_report 行）⇒ `GET /api/nodes` 的 `version` 就是配置字段，不能当实报版本 | task-17 加最小只读端点 `GET /api/nodes/:id/upgrade-state`（`node:read`），前置结论**直接调用** `checkUpgradePrecondition`，并下发 `NODE_OFFLINE_AFTER_SECONDS`（不让前端编窗口）；**要求补顺序回归测试**（防被 catch-all 吃掉——本专项已踩两次） |

这两条再次印证本专项的方法论：**先问"默认配置下它会不会触发"，再谈 UI**。

## 3.21 task-10（通知渠道配置端点）完成：真机 + 真库证据

交付：`backend/src/routes/notification-channels.ts`（+ 23 条行为测试）、`permissions.ts` 登记 `notification_channels` 资源键、`app.ts` 挂载一行；**未动** worker/投递逻辑/schema/迁移/web。

证据（`notify-center` 用**临时**容器 + 真实 MySQL/Redis，唯一容器名，用完已删；未碰 `tunex-it-*`）：
- 未认证 GET → 401；超管 200；`/api/admin/meta/resources` 真实返回含该资源键；
- `PUT telegram {enabled,secret}` → 200，`value:""`、`secret_configured:true`、`secret_state:"sealed"`；**响应与 GET 都逐字不含明文、不含 `secret_enc`**；
- 真实库落库形态：`scope_kind=platform, workspace_id=NULL, secret_enc` 前缀 `v1.`；`LIKE '%<明文>%'` = **0 行**（明文不在库）；
- 非法形状 14 例全部 400 且**零写调用/零行变化**；`enabled=false` 与"未配置"可分；
- **`delivery_kinds` 是现场调用既有构造函数算出来的** ⇒ "保存成功 ≠ 会被投递"是**投影**而不是文案；webhook 保存后会带 warning「不在注册表里」；
- 最终真实库 `notification_channel` 回到 **0 行**（环境恢复原状）。
- 后端 `bun run typecheck` 0 错、`bun test src` **2863 pass / 0 fail（128 文件）**。

**它如实标注的边界**（不得越界宣称）：admin **UI 尚不存在**（故"可从 UI 配置"仍不成立）；真实拓扑上没跑过真实投递（`enabled` 集合在 scratch 上恒空，需 task-11 接线）；非超管真机路径未跑（只跑了受控真实中间件 + 真实超管）；`secret_state:"unreadable"` 只在受控测试构造；多行 telegram 真机路径未构造。

**后续**：新建 `task-20`（admin 渠道配置 UI，已派给 `notify-center`）；`task-11`（worker 注册通知 job）**已解锁**（task-8 早已 completed），并已提醒对方这一点。

## 3.22 task-15（F1 凭据外发）完成：跨 host A/B 证据

`backend-truth` 交付：`agent/Dockerfile` runtime 阶段装 **curl**（+5.19MB / +34.6%，真实数字），探针**优先 curl 且不写 `-L`**（curl 分支另加 `--max-redirs 0` 防呆），wget 仅兜底且仍要求"首个状态行 + 响应体像 Panel JSON"。

**证据（两个不同 IP 的独立 server 记录，谁收到就是谁收到）**：
```
[修复前] 旧镜像（只有 busybox wget）
  panel(原 host)     收到 auth_present=true auth_len=38
  target(跳转目标)   收到 auth_present=true auth_len=38   ← 凭据出了容器；探针结论 http:302（结论对，凭据已外发）
[修复后] 新镜像（runtime 有 curl 8.14.1）
  panel(原 host)     收到 auth_present=true auth_len=38
  target(跳转目标)   收到 []                              ← 零请求；结论仍是 http:302（未校验，不谎报）
```
正例未回归（真 Panel + 真凭据 200、错凭据 401、无凭据 `unverified:no_credential`）；`node-upgrade.test.ts` **42 pass**；backend `bun test src` **2868 pass / 0 fail**；反向变异（把 curl 分支改成 `-L`）**3 条变红**。

**它如实列出的残留**：① 没有 curl 的镜像（老/自定义镜像）仍走 wget 兜底 ⇒ 3xx 仍会外发凭据（彻底消除只能靠镜像带 curl，或把探针换成自己发 HTTP 的实现）；② 响应体判定仍是结构性 grep（`{"data": <非 JSON>}` 会被判通过）→ 已建 **`task-21`**（装 jq 做真解析）。
另建 **`task-22`**（F2 审计：多个 90s 字面量是否应当同源——**先判定，允许结论是"本来就该不同"**）。

## 3.23 干跑最终验收脚本（Lead）：真实 synced 态首次在浏览器可见

在**含 task-8 的镜像**上跑了一遍完整浏览器遍历（脚本 `acceptance-final.mjs`：建 provider → 绑定 → 等 synced → 遍历 6 个页面 → 自动清理）：

- `bind → pending`，随后 **`dnsAfterWait = synced`**；
- `/forwards/2` 浏览器渲染出 **「已切换」+「服务端已读回确认：解析记录就是这里的期望地址」+ 已确认地址 172.33.10.20 + 确认时间 + 失败次数 0 + 不会自动重试 + 自动同步已开启**；
- 禁用词（正常/健康/可达）在该页**零命中**；`apiErrors` 全页**为空**；
- 清理后 `providersLeft=0`、`forward2DnsState=unbound`（环境恢复原状）。

**一处观察（非缺陷，但值得记）**：`/admin/notification-channels` 在页面尚未实现时被 `app/(admin)/admin/[segment]/page.tsx` 的 `normalize()` **静默回落成节点管理页**（渲染出 37 个 testid 且该页文本含「健康」）。这正好印证我给 `task-20` 写下的警示：admin 新页**必须建独立目录**，否则用户访问一个不存在的地址会看到另一个页面（而且没有任何提示）。

## 3.24 R5-A 独立审查结论（ForwardX 对齐，HEAD 1199324 + 工作树快照）

审查人自述口径：**只读**、以 HEAD `1199324`（01:45）+ 工作树为准、带时间戳（审计期间分支被并发推进 20→25 提交）；所有"未跑"项如实列出。

### A. 它抓到的 P0：**提交的 HEAD 不可构建**（已修）
干净检出 `git archive HEAD | tsc` → **恰好 2 错**，两处都是"slice 只提交了一半"：
1. `forward-detail.tsx(14)` 找不到 `@/components/forwards/forward-latency`（`2715313` 只提交挂载，组件未提交）；
2. `forward-workspace.tsx(730)` 传的 `bindingsUnavailable` 在提交版 dialog 上不存在（`147a0cf` 只提交生产端）。

→ **Lead 已修**（`bb44309` 整体落地自洽工作树 + 0600→644；`904e2db` 注册表与模块成对提交），并**用 R5-A 的原命令自证干净检出 tsc = 0 错**。
**门禁纪律更新（已生效）**：① 提交前必须在**干净检出**上跑 `tsc`/`build`；② 禁止只提交一个 slice 的半数文件（挂载与被挂载、prop 与消费者必须同 commit）；③ 提交粒度以**自洽**为准，不以目录为准（我第一次修的时候按目录挑着提交，又造出两处同类半提交）。

### B. 退出条件逐条判定（R5-A）
| # | 判定 | 一句证据 |
|---|---|---|
| 1 快速部署 | 基本达成（工具面）／未验证（真实主机） | `README:25` + `production-deploy.md` + `scripts/ops/install.sh`（`--dry-run/--check`）；未在真实主机跑过 |
| 2 Web 完成第一台 Node | 基本达成 | `node-onboarding.tsx` + `lib/node-install-polling.ts` 已挂载；真机 `GET /api/nodes` 4/4 `online`/`active`/`has_credential:true` |
| 3 Direct/Relay/Multi-hop | Direct/Relay 基本达成；**多跳未达成** | HEAD dialog 有 direct/relay + 路径预览；多跳整套当时未提交（现已由 task-19 交付） |
| 4 Forward 状态与链路 | **达成** | `forward-detail.tsx` 挂 topology/DNS/latency 三卡 + 账本口径；真机 topology 200 |
| 5 DDNS 可从 UI 用 | 基本达成 | 设置页 + provider 管理 + 前门卡片都在 HEAD；写入闸门已修（A8） |
| 6 Notification 可从 UI 配置 | **未达成** | Web 0 消费者、无页面（A5/A6）、HEAD worker 无通知 job |
| 7 Agent 升级完整流程 | **未达成** | 卡片 0 生产挂载、后端 `upgrade-state` 未提交（A4） |
| 8 常见故障诊断入口 | 基本达成（弱）；**最强诊断不可达** | `NodeDiagnostics` + 支持包可用，但 **Looking Glass 后端/Agent/协议全齐、Web 0 消费者、缺省关**（A3） |
| 9 不需理解 Lease/Revision/Fencing | **达成** | `console/user-shell.tsx:9` + 词表守卫测试；真机 `/api/nodes` 投影不含这些字段 |
| 10 不落后 ForwardX | **未达成** | 见其 Top3；且当时 HEAD 不可构建 |

### C. 它**新发现**的断点（本专项此前未记录）
| 断点 | 证据 | 处理 |
|---|---|---|
| **Looking Glass 全链路完备、Web 0 消费者、`LOOKING_GLASS_ENABLED` 缺省关** | `routes/looking-glass.ts` + `app.ts:202` + `agent/internal/diag/lookingglass.go` + 控制协议 `:168`；真机 `GET /api/looking-glass/status` → 200 `{"enabled":false,...,"method":"tcp_connect","caps":{"max_targets":4}}`；`grep looking web/src/lib/api` = 0 | **新建 task-25**（已派 `web-ddns`） |
| `/admin/notification-channels` 权限 URL 无页面 ⇒ HEAD 下**静默渲染成节点管理页** | `permissions.ts:75` 登记 URL，`admin-resource-list.tsx:25-37` 的 `ADMIN_SEGMENTS` 不含它，`admin/[segment]/page.tsx` 的 `normalize()` 未知段回落 `nodes` | task-20（admin 渠道 UI，必须独立目录）；我干跑时也独立观察到同一现象（§3.23） |
| **0600 规则被系统性违反（27 文件）** | `find ... -perm 600 | wc -l` = 27（含 `node-upgrade-card.tsx`、`forward-multihop-*.tsx`） | 已统一 644 |
| F5 幽灵心跳**仍在运行实例 404**（旧 Agent 镜像） | `docker logs tunex-it-panel` 有 `POST /api/internal/heartbeat → 404`；4 台 Agent 镜像均为修复前构建 | "删除代码 ≠ 运行链路已干净" ⇒ 需升级验收环境里的 Agent 镜像（Lead 的验收动作） |
| 多跳真实可用性受**角色模型**限制 | `POST /nodes/1/bindings{3}` → 409「出口节点角色必须是 egress 或 both」；`GET /nodes/2/bindings`（源 egress）→ 409「该节点不具备入口能力」⇒ 仅 `role=both` 能一次建成两段；scratch 4 台**无一是 both** | task-19 已如实呈现；真实三跳验证需 Lead 临时改一台节点角色 |

### D. 它给的差距 Top3（最短路径，Lead 采纳为当前执行序）
1. **让 HEAD 可交付**（纯收口，无新功能）→ **已完成**（`bb44309`/`904e2db` + 干净检出自证）。
2. **打通"后端完备、产品面为零"的通知与诊断** → 通知：task-11（worker job + `resolveTargets`）+ task-20（admin UI，独立目录）+ task-12（用户偏好）；诊断：**task-25（Looking Glass）**。
3. **多跳先"可走完"再谈直观** → task-19 已交付（含"第二段要去哪里建"的指路与不可选原因），真实三跳需验收环境支持。

### E. R5-A 明确列出的"未验证"（不得写成通过）
web 干净检出 `build` 未跑；web/后端**测试刻意未跑**（工作树同期在被写，快照不构成判定）；DDNS 浏览器端到端未由它执行；升级完整流程未跑；Looking Glass 未开启开关、未发 `POST`；ForwardX 侧结论是**源码级行为**而非实测；多跳真机未构造；0600 的运行期影响未复现。

### F. 它对"刻意不同"的复核结论（要点）
全部仍成立，但**两条需要补充**：① "不做 per-forward 通知开关"成立，**但**在"6 类里只有 `announcement` 真会投递"时，"等价可用"的呈现风险仍在（这是 #6 未达成的根因之一，不能只靠"刻意不同"解释）；② "不做远程自升级波次"成立，**但**不能因此接受"升级 UX 不可用"——当前是**卡片没挂、端点没提交**（缺口），不是取舍。

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

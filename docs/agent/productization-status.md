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
| mock 与真实剩余分叉（P2-5，task-27 已修一半） | **节点额度门控**：真机 `POST /api/node-groups/:id/nodes` 在 `max_nodes` 用尽时 403 `node_limit`（顺序：能力/额度 → 端口区间），旧 mock **完全没有这道门**、无限 201；现已按同序补上（403 `{error,code}` + 拒绝后不建行，`node-provision-mock-parity.test.ts` 10 pass 钉住）。**残留**：mock 的计数口径是"**本空间自建组**里的行"（`nodeGroupWorkspace`），种子组是跨作用域演示数据、不在该表里 ⇒ 演示态那 7 行不计入任何空间；真机上每个组都有归属，同样状态下会 403。要复现"额度耗尽"请在测试/演示里显式设置 `capabilityPolicies`（parity 测试即如此） | 残留记录在案 |

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

## 3.25 R5-B 缺陷检修结论（钉在 SHA 上）+ Lead 处置

审查方法：结论**全部钉在 SHA**（审计期间 HEAD 被并发推进 5 次），复核一律在 `git archive HEAD` 的**干净检出**上跑；报告把"已复核通过/在途未评/未验证"分列（含唯一一条未执行的静态路径追踪，已标注）。

### 已处置
| 编号 | 缺陷 | 处置 |
|---|---|---|
| **P0-1** | **HEAD 后端不可构建**：`node-upgrade.test.ts:499` 多一个 `}` 提前闭合 describe（干净检出 backend tsc 4 错、bun test 1 error）。**由我自己的 `bb44309` 引入** | 已修（`6b1625e`），并用审查者原命令在干净检出自证双端 tsc = 0 |
| **P0-2** | 同源半提交家族（`forward-latency.tsx` 从未被提交、`bindingsUnavailable` 消费者半边未提交）⇒ `147a0cf` 与 §3.12 的"tsc 0 错/build 成功"都是**脏工作树产物**，不可外推 | 已由 R5-A 的 `5ac794d` + 我的整体落地修复；**门禁纪律升级**：提交前必须在干净检出上跑、禁止半提交、粒度以自洽为准 |
| **P2-6** | 「绑定事实取不到 ≠ 没有可用出口」在**整张节点表取不到**这条路径上仍失守（`setBindingsUnavailable` 不执行而 `setReferenceLoaded(true)` 照执行） | 已修（`6b1625e`）：catch 里一并置位 |
| **P3-7/P3-8** | 4 个 i18n 裸键；`GET /api/admin/node` 下发 `node_credential_hash` | **均非本专项引入**（`origin/main` 同款）⇒ 记入收尾清单，不占用当前关键路径 |

### 已派发（`task-27`，交 `web-forward` —— 它自己查出来的，修起来最准）
- **P1-3**：mock `GET /admin/node/:id/state` 的"有上报"分支返回**落库行**而非 `NodeStateView`（缺 10 键/多 10 键，真机恰好 19 键）；已交付的契约测试只断言两形状的**公共子集**，测不出 ⇒ 改成两个分支都断言完整键集。
- **P2-4**：`node-runtime-panel.tsx` 把面板侧 `role` 渲染在「Agent 自报角色」标签下（真机 `role="ingress"` vs `reported_role="INGRESS"`）⇒ **生产错、mock 掩盖**；并把后端特意给出却无人消费的 `role_mismatch`/`stale`/`age_seconds` 显式展示（`stale` 不得渲染成"离线/异常"）。
- **P2-5**：mock provision **无额度门控**（真机 403 `node_limit`，mock 在 `max_nodes=1/used=7` 下连发 5 次 201）⇒ 按真机同序补 `checkNodeCreation` + parity 测试 + 补进本文档的分叉表。

### 它"已复核通过"的项（可计入验收）
干净检出 web tsc 0 错 / web tests 1151 pass 0 fail；`/admin/node/:id/detail` 与 `projectNodeDetail` 一致；`pools` 两层信封一致；**capabilities 投影吃真实载荷正确且不泄 `policy`/`ceiling`/`whitelist_ips`**；DDNS 状态集合与客户端逐字一致；新 `notification-channels` 端点 GET 无凭据材料、webhook 显式拒 `secret`、读不到返 503；**zh/en 叶子键集完全相等**；web 侧无 localStorage、凭据不进 URL；`NodeInstallPoller` 语义与注释一致。

## 3.26 Round 30–31：四切片落地、三卡片挂载、门禁快照

**`7d669f5` 集成了四个切片**（每片都有队友真实证据）：高可用（task-16）/ 升级用户流程（task-17）/ Looking Glass 诊断（task-25）/ jq 真解析 + F2 审计（task-21、22）。

**Lead 集成动作**：
1. **三块卡片挂载**：`ForwardHaCard` 进 Forward 详情（四块卡片同屏）；`NodeUpgradeCard` 与 `LookingGlassPanel` 进节点页诊断区。
2. **退役旧内联升级块**（`node-diagnostics.tsx`）：它不是"重复"，而是**缺三件事实**——把管理配置字段 `node.version` 当版本依据（真机 9 台全 `unknown`）、没有服务端前置（用户先撞 409 才明白要切维护）、生成脚本后**没有执行后可见性**。退役同时清掉它的死代码（`buildUpgrade`/`requestUpgrade`/5 个状态）并把一条 a11y 断言改指新卡片（保持"英文界面不得出现写死中文"这条回归）。
3. **共享注册表接线**：HA 的 `handleForwardHaMock` 接入（`handleForwardsMock` 之前）；looking-glass 因 `web-ddns` 已自接而**去重**。可达性实测：`handleMock` 对 `forwards/1/ha`、`looking-glass/status`、`announcements/preferences` **均 200**（不再落进 `handleForwardsMock` 的 404）。

**门禁快照（第 31 轮，非门禁——指纹在运行期间变化）**：后端 **2897 pass / 0 fail**；web 有 2 条失败 + tsc 报错，**全部来自 `task-27` 的中途态**（`node-runtime-panel.tsx`），等其落地后重跑。

**已交付但尚未挂载/验证的点（如实）**：`enabled:true` 的 Looking Glass 真机路径未验证（scratch 开关关闭，需改验收环境）；真实三跳创建未跑通（scratch 无 `role=both` 节点）；升级完整流程未在真实节点执行（刻意不升级那 4 台）。

## 3.27 Round 31–32：通知接线完成 + 一条 P1 既存缺陷 + Looking Glass 开关路径已验证

### task-11（N3 通知节拍）完成 —— 真实 MySQL + 真实 Redis 三拍证据
`cron_notification_facts`（30s，与 reconcile/ddns 同拍）→ `runForwardDenialNotifications(defaultForwardDenialDeps())`。真机三拍：
| 拍 | 结果 |
|---|---|
| 1（隧道 `apply_status='error'`） | `{considered:1,built:1,recovered:0,rejected:0,skipped:0,delivered:true}`；**真实 email 送达**（假 SMTP 收到 `[TuneX][error] forward_apply_error`）；账本真实落行 `status='sent'`、`attempts=1` |
| 2（同一事实立刻再来） | 账本仍 **1 行**、没有第二封 ⇒ 拦住它的是**投递层**（Redis `…cooldown:forward:5:forward_apply_error:email`），**不是 job 里去抖**（job 内零去抖，有源码守卫测试） |
| 3（改回 active） | `recovered:1` → 恢复事实配对 + 新账本行（severity `info`） |
清理后库计数回到探测前基线；19 条新接线用例（真实 `runForwardDenialNotifications` + 真实 `deliverNotificationFacts`，仅换账本/静默期/渠道替身）；后端全量 **2898 pass / 0 fail**。
**webhook 明确不纳入事实类首发**（免打扰语义属"给人"的渠道；webhook 没有"哪条事实送哪个端点"的订阅概念）→ 另立切片。
**node 事实仍不被选中**：判定为"有意的范围限制 + 敞着的门"，要接需**四件事一起定**（哪些节点理由码值得打扰人、来源行映射、账本 open-denial 查询扩展、reason 白名单）；**不得只删那行 `continue`**（既有测试正是在防"通知范围悄悄变大"）。

### 🔴 新发现 P1（既存，已并入 task-14 并升级为第一优先）：`sendMail` 不读 SMTP 220 问候语
`services/mail.ts` 的 `SmtpClient.connect()` 从不读连接后的问候语，直接发 `EHLO` ⇒ **任何符合 RFC 5321 的真实 MTA 都会失败**（假 SMTP 发问候语→`transport_error`；去掉问候语→立刻成功，同一份代码）。影响：凡配了 `SMTP_*` 的部署，**邮箱验证 / 密码重置 / 公告邮件 / 通知 email 渠道全部发不出去**；而仓里**没有任何测试跑过真实 `SmtpClient` 会话**，所以长期未被发现。要求含"起一个会发问候语的假 SMTP 断言成功"的行为测试 + 修复前后真实会话对照。

### Looking Glass 开关路径：已验证（`enabled:true`）
`web-ddns` 用**派生唯一容器**（同镜像 + 仅覆盖 `LOOKING_GLASS_ENABLED=1`，不发布宿主端口）在真实环境验证：`status` → `enabled:true`；**非平台管理员也进得来**且 `platform_admin_override:false`（该字段是**按观察者**算的——这条此前从未观察过）；真实发起走的是**开关路径而非管理员例外**（`entry:{enabled:true, admin_override:false}`）；`refused` 之外的**结果状态拿到真机样本**（`reachable`/`timeout`（`i/o timeout`）/`error`（IPv6 `network is unreachable`））；域名目标实测 `pinned_by_host` 4 条字面地址（= `max_pinned_addresses`）⇒ 印证"面板解析、节点只拨字面地址"的设计结论；并发 → 409 `looking_glass_busy`；审计真实计数 `issued=6/completed=6/refused=9`。
**仍无样本**：`refused`（本拓扑出网路径不返回 RST）、`dns_error`（结构上不可达）、`invalid_target`/`unsupported`/`upgrade_required`（需更老/更怪的 Agent）。

### Lead 处置：P3-8（凭据哈希下发）已修
`GET /api/admin/node` 原为 `findMany()` 全字段 ⇒ 把 `node_credential_hash`（长期凭据的 sha256）下发到客户端。已改为 **select 白名单**（凭据状态由 `credential_*` 列表达，列表所需字段一个不少）。

**这条修复的分量比"小卫生"更重**：仓里**已经有一条测试把"绝不下发 `node_credential_hash`"写成服务端契约红线**（`web/src/components/admin/__tests__/node-management.test.ts:95` 断言 `toBeUndefined()`，文件头注释也点名它是红线）——也就是说**真实后端一直在违反自己文档化的契约**，而 mock 侧反而是被钉住的。前端与 mock 对该字段零引用（grep 只有那两条断言）⇒ 移除无消费方风险。干净检出 backend tsc = 0 错。
**顺带发现并复现一个既存的顺序敏感缺陷**（与本改动无关）：`routes/__tests__/ddns-provider-route.test.ts` 在进程内注册了只含 `resolveWorkspaceAccess` 的 `workspace.ts` 替身（缺 `createPersonalWorkspace`）⇒ 同进程后跑的 `route-mount-coverage.test.ts` 报 `Export named 'createPersonalWorkspace' not found`。**只跑这两个文件即可复现**（5 pass / 1 fail / 1 error）；全量跑因顺序不同反而绿 ⇒ 属"替身必须语义完整"的同型问题，待小切片修。

## 3.28 Round 32：task-11 真机 worker 验证 + P1 邮件修复 + 一类"替身泄漏"缺陷

### task-11 的最后一里已关（Lead 验收环境实测）
用当前后端源码重建 Panel/Worker 后，**真实 worker 进程**打印：
```
[worker] registered 8 cron schedulers: cron_save_traffic,cron_delete_tunnel_traffic,cron_latency_history,
         cron_check_node_offline,cron_reconcile_v3,cron_ddns_sync,cron_settle_billing,cron_notification_facts
[worker] cron_notification_facts ok (105ms since enqueue) → 30s 后再次 ok
```
⇒ "整条 worker 循环里它每 30s 真的被 BullMQ 调度"这条**不再只是源码锚点**（`notify-center` 自列的未验证项已关闭）。

### P1 已修：`sendMail` 不读 SMTP 220 问候语（`fc90ec5`）
真机前后对照（同一个会发 `220 … ready` 的假 SMTP、同一封邮件）：
```
after_fix : {"sent":true}                       假 SMTP 完整收到 Subject/To/正文
before_fix: {"sent":false,"reason":"smtp_error"} [mail] 发送失败：SMTP EHLO 返回 220：220 n3-fake-smtp ready
```
修复：`connect()` 末尾 `readGreeting()`（**非 220 就抛错，一条命令都不发**）+ 顺带修 `readReply()` 的监听器泄漏（成功路径不摘 `once("error")` → 真机 `MaxListenersExceededWarning`）+ `SmtpClient` 导出与可注入 `replyTimeoutMs`（仅供测试）。4 条真实会话测试（有问候语/多行问候语/554 ⇒ 零命令/服务器不说话 ⇒ 超时）。
**未验证**：真实公网 MTA 的 465 隐式 TLS / 587 STARTTLS 两条分支没有实测，只验了明文 `SMTP_SECURE=false`。

### 一类缺陷：**进程级模块替身泄漏**（两个现场，同一不变量）
不变量：`mock.module` 是**进程级注册表、先加载者生效**（仓里 `node-health-service.ts:76-77` 已文档化），因此**替身必须语义完整**，否则泄漏到同进程的其它测试文件。
| 现场 | 症状 | 复现 |
|---|---|---|
| `workspace.ts` 替身缺 `createPersonalWorkspace` | `route-mount-coverage.test.ts` 报 `Export named … not found` | 只跑那两个文件：5 pass / 1 fail / 1 error（全量因顺序不同反而绿） |
| `env.ts` 替身缺 `mail`（`redis-scope` / `traffic-pipeline` / `policy-concurrency` / `csrf`） | 全量跑时 `env.mail === undefined` ⇒ `isMailConfigured()` 抛 `TypeError` ⇒ `mail-smtp-session.test.ts` **4 条全红**（**单独跑 4/4 绿**） | `cd backend && bun test src` |

**处置**：`task-28` 扩到覆盖两个现场（替身语义完整 + **防复发守卫**：断言"env 替身键集 ⊇ 真实 env 键集"，或断言"缺段 env 下 `isMailConfigured()` 返回 `false` 而非抛错"），交 `backend-truth`；`mail.ts` 的健壮化（缺段应返回"未配置"而不是崩）归 `notify-center`（他持有该文件）。

### 另一处由我造成并已修的 HEAD 级失败
我退役 `node-diagnostics` 内联升级块时**只改了 a11y 测试、漏了 `diagnostics-ui.test.tsx:206`** 对同一句文案的断言 ⇒ HEAD 上 1 条红（`web-forward` 独立发现并报回）。已改为断言新卡片的文案对象。
**教训（值得记）**：我补 import 时只 `grep` 到注释里出现的文件名就以为"已 import"，实际没有——**验证 import 是否存在必须查 import 语句本身**，不能靠文件名出现次数。

### 当前门禁状态
- web：`tsc` 0 错 + 全量 **1267 pass / 0 fail**（已提交 `ef4f073`）
- backend：`tsc` 0 错；全量 **2901 pass / 4 fail**，4 条红**全部**是上述替身泄漏（单独跑绿）⇒ 等 `task-28` 与 `notify-center` 两半落地后应回 0

## 3.29 Round 33：**真机浏览器验收（新构建）全通过** —— 四块新卡片 + DNS synced 态 + 通知偏好

方法：`npm run build`（当前树）→ **重启 Web 指向新构建**（此前 41000 的进程握的是旧构建，正是它造成过 chunk 500）→ 起假 DNS provider → 脚本建 provider + 绑定 → 等 synced → 遍历 6 个页面 → 自动还原现场。

**结果**：
| 面 | 真实渲染证据（testid 摘录） |
|---|---|
| `/forwards/2` RELAY | 链路（`forward-topology-*`、`diag-none`、`observed-at`）+ **DNS 前门 `forward-dns-card`（真实 `synced`）** + **延迟 `forward-latency-ok`**（真实现可达态）+ **高可用 `forward-ha-policy-off` / `forward-ha-candidate-none` / `forward-ha-options`** ⇒ **四块同屏** |
| `/forwards/1` DIRECT | `forward-topology-direct` + 延迟 `forward-latency-no-observer` + `forward-latency-reason`（按构造没有观测维度，不是"没有数据"）+ HA 卡 |
| `/nodes`（选中入口） | **升级卡片**：`upgrade-running-version` / `upgrade-freshness` / `upgrade-configured-version`（与上报版本分开）/ `upgrade-target-image` / `upgrade-expected-version` / `upgrade-drift` / `upgrade-precondition` / `upgrade-aftermath`；**Looking Glass**：`looking-glass-panel` / `admin-override` / `caps` / `method` / `scope` / `write-warning`（发起是写操作）/ `max-targets` / `timeout` / `run` / `idle` / `caveats` |
| `/settings` | 通知偏好矩阵 `notification-channel-{email,webhook,telegram}` |
| 全局 | **`apiErrors` 为空**、**禁用词（正常/健康/可达）每页零命中** |
| DNS 闭环 | `bind → pending` → `after wait: **synced**` → 清理后 `providersLeft=0`、`forward2DnsState=unbound` |

`/admin/notification-channels` 尚无 testid 命中——与 `task-20`（admin 渠道 UI）在途一致，**不记为缺陷**。

**未覆盖（留给最终验收）**：Looking Glass 的**真实发起**（本轮只看渲染，未点 run——真实发包有副作用）；通知偏好的**点击往返**（已由 `notify-center` 在隔离副本上验过）；升级的**真实执行**（刻意不做）。

## 3.30 Round 34–35：冻结门禁 + 最终浏览器验收（含真实 GA 卡与 admin 渠道页）

### 冻结树全量门禁（指纹在运行前后一致 ⇒ 有效）
| 检查 | 结果 |
|---|---|
| backend `tsc` | 0 错 |
| backend `bun test src` | **2908 pass / 0 fail**（134 文件） |
| web `tsc` | 0 错 |
| web `bun test src` | **1292 pass / 0 fail**（66 文件） |
| web `npm run build` | 成功 |

### 最终浏览器验收（重启到新构建 + 真实后端 + 假 DNS provider）
- **DNS 前门**：`bind → pending → synced`，**浏览器里真实显示已切换态**；清理后 `providersLeft=0`、`forward2DnsState=unbound`。
- **Forward 详情**：RELAY/DIRECT 两页共 **43 / 41 个相关 testid**（链路、DNS、延迟、高可用四块同屏）；DIRECT 的延迟是 `no-observer + reason`（按构造无维度 ≠ 无数据）。
- **节点页**：升级卡片（8 个 testid）+ Looking Glass 面板（17 个 testid：`admin-override`/`caps`/`method`/`scope`/`write-warning`/`max-targets`/`timeout`/`idle`/`caveats`）。
- **/settings**：通知偏好矩阵（3 渠道）。
- **/admin/notification-channels**：task-20 交付后已有命中（独立目录，URL 正确）。
- **全局**：`apiErrors` **为空**；禁用词（正常/健康/可达）在这些"未知/降级"语境里**零命中**。

### Looking Glass 的真实发起：拒绝路径已在浏览器验证；带目标的发起在 API 层验证
- 浏览器点击 `looking-glass-run` 且表单未填目标 ⇒ 面板如实显示 **「本次发起被拒绝 / 这次没有发出任何测试（拒绝发生在发包之前）/ 没有可用的目标：本面板没有发出任何请求」**（不谎称"没有发出"以外的任何事、也不编结果）。
- **带目标**的发起已由 `web-ddns` 在 API 层验证（200 真报告 + 409 `looking_glass_busy` 单飞 + 审计计数 issued/completed/refused）。
- 浏览器层"填目标后点 run"未点通（脚本选择器未命中表单输入）⇒ **如实记为未覆盖**，不作为通过。

## 3.31 新增切片（Round 35 派发）
| 任务 | 内容 |
|---|---|
| `task-30` | 替身泄漏的**剩余现场**：`forward-route-topology` / `forward-batch-route` / `me-capabilities`（后者"碰巧安全"）的 `workspace.ts` 替身改 spread + 守卫覆盖 |
| `task-29` | **F1 收口**：探针改为 **agent 自实现 HTTP**（Go stdlib，`CheckRedirect: http.ErrUseLastResponse` **永不跟随重定向**）——从根上消除"凭据随 3xx 外发"这一类，并顺带消掉 curl/jq 两次镜像增长（+5.19MB / +0.92MB）与"两条分支结论可能不一致"；要求保留旧镜像兜底并**如实标注是兜底**、A/B 两台独立 server、响应体矩阵、体积前后真实数字、反向变异、独立镜像标签 |
| `task-13` | N4 投递失败可见性（用户域只读投影）：Lead 追加两条硬要求——**target 对非本人行必须脱敏到不可还原**（否则把同事联系方式泄漏给全空间）；`error` 需二次脱敏且断言密文/明文/完整 target 逐字不出现 |

### 机制发现（值得记住）
`mock.module` 只对**之后首次 import 该模块的文件**生效 ⇒ **本文件永远看不到自己的替身**（同 specifier 与绝对路径两种形态实测都返回真实现）⇒ 受害方永远是**另一个文件**，这正是"替身泄漏"只在特定跑法下红的原因（`backend-truth` 实测并写进注释）。

## 3.32 Round 36：N4 端点挂载 + 替身收尾 + 守卫被当被测对象打磨

### Lead 挂载（共享文件单写）
`app.route("/api/notifications", notificationDeliveryRoutes)` **特意排在 `app.route("/api", publicRoutes)` 之前**（宽路由；本专项已在 DNS 前门 / 延迟端点 / HA 三处踩过同类顺序问题，注释写明理由）。Panel 重建为 `n4-0314` 后真机探针：
```
GET /api/notifications/deliveries → 200
{"data":{"scope_kind":"workspace","workspace_id":3,"truncated":false,"limit":50,
         "summary":{"total":0,"sent":0,"failed":0,…}}}
（/api/notifications 与 /api/notifications/summary → 404，正确：只挂了交付的 router，未臆造路径）
```
**后端门禁**：`tsc` 0 错 + **2927 pass / 0 fail**（135 文件）。

### task-30：替身泄漏收尾（含一次自我更正）
| 文件 | 处置 |
|---|---|
| `forward-route-topology.test.ts` | 改 spread ⇒ 与 `route-mount-coverage` 合跑 6 pass / 0 fail |
| `forward-batch-route.test.ts` | 改 spread ⇒ 合跑 13 pass / 0 fail |
| `me-capabilities-route.test.ts` | **回退**：它不是"碰巧安全"，而是**按设计**安全（scenario 放在模板字符串里交给**子进程**执行，替身注册不到本进程） |

**守卫本身被当成被测对象打磨**（这是本轮最有价值的产出）：扩展到**两个受监控模块**（`env.ts` + `services/workspace.ts`），并修掉四处边界——① 注释里的 `mock.module()/env.ts` 造成**假阳性**（先剥注释）；② 窗口里任意 `...` 造成**假阴性**（收紧为"紧跟返回对象 `{` 之后的 spread"）；③ **别名解析丢失路径前缀**导致漏检（改为按文件名匹配）；④ 支持**具名工厂**（对象字面量在函数体里 ⇒ 到定义处取窗口）。`env.ts` 侧**零豁免**。

### 机制（已固化的精确表述，解释这类缺陷为何长期潜伏）
> `mock.module` 只对**该进程里之后首次 import 这个模块的文件**生效。注册替身的文件若**先** import 过真实现，之后无论用**原 specifier** 还是**绝对路径 specifier** 再 import，拿到的都是真实现 ⇒ **本文件永远观察不到自己的替身**。受害方**永远是另一个文件**：它才是本进程里第一个真正 import 该模块的人，却拿到残缺命名空间，于是失败发生在**加载期**（`SyntaxError: Export named 'X' not found`）、往往**不带 `(fail)` 前缀**，且只在"两个文件恰好共享一个进程"的跑法下出现（bun 会把测试文件分派到不同 worker ⇒ 全量绿、双文件红）。⇒ 守卫只能针对"交给注册表的那个对象"，不能靠"import 回来看一眼"。

### 守卫新挖出的 2 处（已分派）
- `routes/__tests__/forward-list-route.test.ts`（无人在写）⇒ 一句话给 `backend-truth`：做 task-29 时顺手 5 分钟可收，否则单独立单，**不污染主切片**。
- `services/__tests__/notifications/deliveries.test.ts` ⇒ 交回 `notify-center`（其领地；同样 1 hunk 或改用"模板字符串 + 子进程"隔离形态）。

## 3.33 Round 37：退出条件 #1 的部署演练切片 + 一条同类的真话缺口

### 派出 `task-31`：**照文档做一次全新部署演练**（退出条件 #1 的实质）
现状：`README:25` 的快速部署段（`cp .env.example .env` → `docker compose up -d --build` → `/healthz` + Web `:9091`）+ `docs/production-deploy.md` + `scripts/ops/install.sh --dry-run/--check` **从未被真正跑过一次**。而文档本身就是产品的一部分——"照着做能成功"才是这条退出条件的实质。
要求：**完全隔离**（独立 project/端口/卷，基线 `docker ps` 前后对照、绝不碰 `tunex-it-*` 与用户容器）+ **只按文档做**（遇任何要"猜"的地方都计为发现，不许凭经验绕过）+ 走通证据链（**迁移与管理员账号怎么产生**、worker cron 是否真起、**真实 Agent enroll 并 online**）+ **真实墙钟耗时**与"30 分钟"对比 + **文档缺陷清单**（`文件:行` + 现象 + 建议）+ 如实列出无法验证的部分。

### Lead 修掉一条 R5-A 点出的真话缺口（`dec70f4`）
DDNS 卡在 **`auto_resolve=false`（缺省）** 时只写了"开启后会怎样"，**没说"关着就不会跟随、要你自己维护"** ⇒ 用户很容易以为"绑定了域名就会跟着入口走"，而记录其实只在绑定那一刻写一次。
修复：新增 `autoResolveOffHint`（zh/en，含可执行下一步：解绑后在绑定表单勾上自动同步），**仅在关闭时渲染**（开启时不出现，避免变成"开着也警告"）；断言两条方向都有。
（**自我记录一次同类失误**：我在写这段 zh 文案时又用了 Markdown `**粗体**`，会原样显示星号——与之前 routes 页那次同一个错误，已立刻改掉。教训：**用户可见字符串里不得出现 Markdown 标记**。）

### 门禁状态（轮内快照）
- web：`tsc` 0 错 + **1312 pass / 0 fail**（67 文件，含 N4 新测试）
- backend：`tsc` 0 错；全量 2927 条里 **2 条失败 = `backend-truth` 正在做的 task-29 中途态**（`agent/internal/identityprobe/` 等），不是回归
- N4 真机验证（`notify-center`）：脱敏（完整地址逐字不出现、`***@example.com` + `target_masked` + `targets_count`）、**跨空间隔离**、**平台行不下发**、`error` 二次脱敏（`RCPT TO:<***> returned 550`）、三种 404 逐字同形、`?status=exploded` → 400 fail-closed、`degraded` 与 `failed` **正交**、零残留

## 3.34 退出条件逐条对账（**Round 38 更新版**，基准 = R5-A 的 §1 判定表 + 其后的全部交付）

口径：以 R5-A 在 `docs/agent/forwardx-alignment-review.md` §1 的判定为**基线**，逐条写"当时的判定 → 现在的事实 → 现在的判定 → 仍缺什么"。**不把在途或未端到端验证的东西算作达成。**

| # | 条件 | R5-A 当时 | 现在的事实（证据） | 现在的判定 | 仍缺什么（诚实列出） |
|---|---|---|---|---|---|
| **1** | 新用户可快速部署 | **达成** | **三轮证据叠加**：①（`task-31`）照文档**走不通**（缺 `LICENSE_SECRET` ⇒ `db-migrate` exit 1；钉版本 `manifest unknown` 后静默回退陈旧 `:latest`）；②（`task-34`，修文档 + **本地构建镜像**）**文档路径已通**（迁移/种子/管理员凭据/8 cron/建组 201 + provision 201；`up -d` 235s）；③ **（Round 52，Lead 一手）`Agent enroll → online` 通过**：建组 201 → provision 201 → `enrollment` 一次性 token（TTL 600s）→ **`POST /api/internal/node/enroll` 兑换出 43 字符 credential（200）** → 起 agent ⇒ 面板判 **`status: active` + `connection: online`**（首个 5s 轮询即在线）；**同 token 重放 = 401**；清理后节点数回 4、额度回 4、8 个 `tunex-it-*` 完好 | **达成** | ① **字面一键命令**（`curl … install.sh | sudo sh -s -- --panel … --enroll-token …`）**仍需真实节点主机**（sudo/docker），沙箱不可执行 ⇒ 我复现的是**同一条链路的每一步**（含关键兑换），不是那行命令本身；② 生成的命令里面板地址是 `127.0.0.1:18180`（**节点不可达**）⇒ 实测印证 `task-34` 已补的 `SITE_URL` 前置条件；③ 公网 TLS/反代、备份/恢复/回滚、云主机资源限额未验 |
| **2** | 可从 Web 指引完成第一台 Node | 达成 | 浏览器端到端：闩锁 → 真 Agent → **5s 内 online** → CTA `/forwards?ingress_node_id=`；round 33 门禁重跑仍绿 | **达成** | — |
| **3** | 直观创建 Direct / Relay / Multi-hop | **达成** | Direct/Relay 早已交付；多跳接线（模型/选择器/请求字段/两段绑定前置/预览四步三段）；**Round 53 Lead 一手在真机跑通三跳**：建 `role=both` 节点 → 两段绑定（`POST /api/nodes/1/bindings`、`POST /api/nodes/12/bindings` 各 201）→ `POST /api/forwards {mode:"relay", ingress:1, middle:12, egress:2, listen_port:21502}` **201 且 `apply=active`**；`GET /forwards/17/topology` 正确给出**两段**（`ingress_to_middle` 1→12、`middle_to_egress` 12→2，含 `runtime_id`/`running`/`expected_revision`） | **达成** | 沿途查出并已记录一条**真缺口**：`connect_ip` **只在 provision 时可写、无任何更新端点**、面板也不从上报学地址 ⇒ 未填地址的节点**永远**不能当 RELAY 跳（`invariant_violated`）——见 §3.52；另：数据面是否真能过包未验（无真实客户端/服务端） |
| **4** | Forward 状态与链路清晰可见 | 基本达成 | **四块卡片同屏**（链路/DNS/延迟/HA）+ 账本口径 + 浏览器验收 43/41 个相关 testid、禁用词零命中 | **达成** | 带宽/吞吐时间序列（后端无该数据源） |
| **5** | DDNS 可从 UI 使用 | 基本达成 | 写入闸门真解耦（`cron_ddns_sync`）；**真机 `pending → synced` + 读回确认 + 浏览器「已切换」**；缺口补齐：`auto_resolve=false` 缺省态现在**明说"不会跟随、要你自己维护"**（`dec70f4`） | **达成** | 只支持 2 种 provider（cloudflare/huawei）；多入口 `multi_entry` 首发未开放 |
| **6** | Notification 可从 UI 配置 | **未达成** | **四块都到位**：渠道配置端点（task-10）+ **admin 渠道 UI**（task-20，独立目录）+ 用户偏好矩阵（task-12）+ **事实类投递节拍**（task-11，真机三拍：真 email 送达 / 被投递层静默期拦住 / 恢复配对）+ **投递失败可见性**（task-13，真机脱敏与跨空间隔离）+ SMTP 问候语 P1 已修 | **基本达成** | **真实外部投递**未验证（SMTP 只验明文会话、未对真实公网 MTA；telegram 从未真发到 api.telegram.org）；`degraded=true` 真机触发；`secret_state=unreadable` 真机 |
| **7** | Agent upgrade 有完整用户流程 | **达成** | 只读 `upgrade-state`（**实际上报版本** + 前置逐字同源）+ 卡片挂载（旧内联入口退役）+ 版本基线语义修复（task-26）+ 镜像 stamp（task-37）+ `version_drift:behind` 真机首现（Round 54）+ **Round 56 Lead 一手跑通真实节点完整升级**：旧镜像 agent（上报 `0.13.22`、`behind`）→ 跑面板生成的**真实升级脚本**（registry 拉取 → 停旧 → 用新镜像重建 → **身份校验通过**："HTTP 200 + Panel JSON 真解析；agent 内置探针，不跟随重定向；同一个 node_id/agent_id 已重新连上 Panel"）→ 新 agent 上报 **`0.15.0`** ⇒ **`version_drift: not_behind`**；节点全程 `active/online`、**身份与 Forward 关系未变（无重新 enroll）** | **达成** | ① 我沙箱内的偏差已披露：`--network host`→控制网、宿主文件挂载→**命名卷 + docker cp**（因 daemon 文件系统视图 ≠ 沙箱视图，见 §3.58）；② **真实公网 registry/TLS** 未测（用本地 registry 代理）；③ 回退路径（新镜像起不来 → 自动回退旧镜像）**未真机触发**（脚本里有该分支，本次未走到） |
| **8** | 常见故障有诊断入口 | 基本达成 | 诊断面板 + 支持包 + 转发错误→下一步；**Looking Glass 已消费并挂载**（五态 + `admin_override` 按观察者 + 写操作警告 + caveats），开关真机验证（含普通成员可进）、真实发起在 API 层验证（200 报告 / 409 单飞 / 审计计数） | **达成** | 后端只 1 种方法 `tcp_connect`（相对 ForwardX 的 8 种）；`refused`/`invalid_target` 等结果态无真机样本 |
| **9** | 不需理解 Lease/Revision/Fencing | 达成 | 用户域零命中（唯一命中在管理端联邦页）；`Revision` 只在默认折叠的技术详情块内；routes 页假承诺已删 | **达成** | — |
| **10** | 核心日常体验不再明显落后 ForwardX | **未达成**（但**距"基本达成"只差要件 ② 一条**） | 三条落后理由复核：② HA **已消除**、③ 诊断**部分消除**（方法集 1→3 已部署；`task-42` 正在推到 5）、① 通知 **部分消除**→**R6 §12 已改判要件① = 支撑**（评审自我复核库身份 `@@server_uuid` 逐字相同 + `SHOW CREATE TABLE` 绕开统计缓存读出真计数器 `workspace 12/tunnel 14/delivery 25`，与其引用 id 一对一吻合；八条判据 6 支撑 / 1 部分支撑（SQL 直插事实）/ 1 不支撑（契约）） | **未达成** | **评审给的三级门槛**：未达成 = ①未支撑 或 ①支撑但②未闭合（**当前**）；**基本达成 = ①支撑 + ②闭合**（一条日常宽度差距真机可验证闭合，如 `task-26`/`task-37`）；达成 = 上述 + 覆盖面再收一条（LG ≥5、DDNS ≥4）。⇒ 下一目标明确：**闭合要件②**（我计划用 enroll 流程 + stamp 镜像做 `version_drift:behind` 真机首现）。另有评审 §12.4 的**判决实验**（`task-45`）在办 |

**本对账的诚实边界**：
- 第 10 条我**故意不自行判"达成"**——它是整体判断，应由一次独立评审（同 R5-A 的方法：钉 SHA、只写自己复核过的、把"在途"排除）给出，而不是由实施方自述。
- "达成"一律指：**有可复核证据的端到端或真机证据**；凡"只有单测/契约测试"的都不写成达成（例如 #3 的多跳接线、#7 的升级卡片）。
- 表中所有"仍缺什么"都不是免责声明，而是**下一条切片的输入**。

## 3.35 Round 41–42：**部署演练结论（#1 未达成）** + F1 收口交付 + 配置键审计派发

### `task-31` 演练结论：**照文档部署走不通**（本专项最有价值的一次交付）
在 `/tmp` 克隆副本按 `production-deploy.md` 生产路径演练（`-p tunex-rehearsal-webddns`、唯一端口 23101-23103、全新 `*-prod` 卷、不发布公网端口；**清理后基线逐行 0 差异**）。**两个未记载的阻断点**（在"第一台 Agent online"之前）：
1. **`db-migrate` exit 1 ⇒ `up -d` 失败**：发布镜像要求 `LICENSE_SECRET`，而 `.env.production.example` 与 §2.2 必改项表**都没有它**；
2. **镜像钉版本不可行**：按 `$(git rev-parse HEAD)` 钉 ⇒ `manifest unknown`；当前"静默回退 `:latest`"**未记载且与源码不匹配**（`:latest` 早于 D3 修复 ⇒ provision 报 500 而非 409 `PORT_RANGE_REQUIRED`；且不认 `SEED_DEMO_DATA=false` ⇒ 演示数据占满 1 台上限 ⇒ **加不了第一台真实节点**，403 `node_limit`）。
**耗时**：到失败点约 20 分钟（含 258s `pull`），**未能评判"30 分钟"口径**（路更早就断了）。
**10 条文档缺陷**（每条 `文件:行` + 现象 + 建议）已记入报告：缺 `LICENSE_SECRET`、钉版本不可行、README 与生产文档分叉且不提管理员/迁移、`docker-compose.yaml:14,164-174` 硬编码容器/卷/网络名导致**无法隔离且会复用已有数据**、首启额度被演示数据占满、CSRF 方法不对称（`DELETE` 无 `Origin` 直接 403）、占位值不在启动期 fail-closed、镜像 license 缺省 `business`（fail-open，仓库已是 `none`）、缺"可用节点组"路径、`.env.example:31-33` 的承诺被违背。
**副作用已披露并恢复**：`docker compose pull` 移动了本机共享的 `mysql:8.4.11` 标签，已还原原映射并删除拉入镜像。

**处置**：`task-34`（修文档与环境模板 + **用本地构建镜像**重跑到 online，把"发布镜像陈旧"与"文档错误"分开）→ `web-ddns`；`task-35`（`SEED_DEMO_DATA=false` 不生效 + license 缺省 fail-open，**仓库侧与镜像侧分开陈述**）→ `backend-truth`。

### `task-29`（F1 收口）交付
- **跨 host A/B**：新镜像（内置探针）跳转目标收到 **`[]`**；`cafaaba`（busybox wget 兜底）收到 `auth_present=true auth_len=38` ⇒ 旧路径确实外发凭据（已如实标注为兜底风险）。
- **响应体矩阵**：新路径 `http:200:agent`；其余 5 种（含 `{"data": oops}` / `{"data":42}`）全 `unverified:not_panel_json`——**旧 grep 路径会放过前两种**。
- **镜像体积**：15,003,286 → 21,114,130（curl+jq）→ **15,007,382（+4,096 / +0.03%）**（去掉 curl/jq，探针进二进制）。
- **反向变异**：把 `CheckRedirect` 改成跟随 ⇒ "目标零请求"那条**变红**。
- **一处对我方案的偏离（已采纳）**：用**标志**而非子命令——老二进制会把位置参数当"多余参数"**照常启动运行时**（危险），未知标志则被 `flag` 包安全拒绝（rc=2）；且**不提供 `--probe-credential`**（凭据只从 `agent.env` 读，不进 `ps`/`docker inspect`）。
- **裁决**：兜底路径**保留**（老镜像客观存在，诚实结论优于无法校验），但要求把"未来废掉它的前提条件"写进 `agent/README.md`。

### `task-33`（配置键审计）
`notify-center` 在 task-14 中**主动更正自己**（此前"库里没有 SMTP 行"是 `SELECT … | head -20` 截断导致的误判；真机复查有 5 行历史行，实现**忽略但不删除**、五行原样在位）。同类键 `RESEND_API_KEY`/`RESEND_FROM`/`EMAIL_PROVIDER` 也被发现"无生产读者" ⇒ **不"顺手修三个"，改为穷举审计**（以 `SECRET_CONFIG_NAMES` ∪ 真实 `GET /api/system/config` 键集为输入，逐键回答"有没有生产读者"，并**区分 DB 配置 vs env**）。

## 3.36 R6 终局独立评审（`task-32`）：**#10 未达成，但性质已改变**

报告：`docs/agent/terminal-alignment-review.md`（245 行；钉 SHA `2037d05`→发现推进到 `57d2520` 后按新 HEAD 重核旁项；**明确声明无浏览器、无任何写操作**）。

**判定**：#10 **未达成**，但理由**从"通路不存在"降级为"未证实 + 覆盖面"**：
- ② **HA 已消除**：真机 `GET /api/forwards/{1,2,3}/ha` 全 200，返回 `policy{false,false}` + `failover_candidate{status:"none"}` + `preference_options{status:"ok",nodes[...]}`（**期望/事实/候选/备选四层分开**，每节点带 `preference_rejection`/`accepts_new_business`）；"缺省即关"在**真库 + HTTP + 文案**三处一致；卡片挂在 `forward-detail.tsx:307`。多入口分组是**刻意取舍**，不计落后。
- ③ **诊断部分消除**：消费者 + 挂载（`node-workspace.tsx:961`）齐；真机 `status` → **200 且 `enabled:false`（不是 403）**；`unavailable`（取不到）与 `disabled`（没开）是**两个分支**。**但方法集仍 1 vs 7**——评审**自己核实**了 ForwardX 是 `ping/ping6/traceroute/traceroute6/mtr/mtr6/tcp`（**7 种**），并指出 R5-A 写的 8 含 iperf3 它未核到（**纠正了我方基线里的一个数字**）。
- ① **通知部分消除（未证实）**：链路在（`worker.ts:46` 注册 + `:242-266` 真 handler + `notification-facts-trigger.ts:622-668` 真依赖；真机日志 `cron_notification_facts ok` **≥15 拍**，且旧镜像 worker 无此节拍 ⇒ 来自 HEAD 代码）；渠道页/偏好/账本读投影皆已挂载，账本 UI 明写"没有记录 ≠ 没有失败"。**但**真库 0 行 / 0 行 / 凭据全空 / attention 0 事实 ⇒ **从未端到端投递过**。

**它明确拒绝的一条**：**不把 #1 折算进 #10**（"不同阶段门槛，互相折算会让两个条件都失去分辨率"）；并要求"**不会因为三条里两条被消除就把 #10 抬成基本达成**"——**翻转门槛**是"至少一次真实端到端投递 + 至少一条日常宽度差距被补齐"。

**它给出的最短路径 → 已派**：① `task-36`（通知端到端真实投递：成功 + 失败 + 保存≠投递，含假 SMTP 收信证据，"会发 220 问候语"）；② `task-26`（让默认部署能给出"落后/无法判定"）；③（可选）LG 补方法。

**闭环一条悬疑**：评审注意到 `deliveries/5` 曾在 03:16 返回 200 而现在整表 0 行、"原因未查明"——**原因是 `notify-center` 做 task-13 真机验证时临时插入 3 行、验完即删**（零残留）。评审当时**没有把它当证据**，这个判断是对的。评审的完整性另有一条自我约束：真机跑的是 `n4-0314` 镜像 ≠ HEAD，它明说"真机 HTTP 只作某次构建行为读"（反例：该镜像仍列出 `SMTP_*`，而 HEAD 已 400 拒写）。

## 3.37 Round 44：部署路径第二轮演练（文档已通）+ 两处新发现

### `task-34`：修复 + 用**本地构建镜像**重跑（把"发布镜像陈旧"与"文档错误"分开）
**Changed（逐处有理由）**：`.env.production.example` 补 `LICENSE_SECRET`（+ 用途与生成方式）；`production-deploy.md` §2.2 补该键与第二条 `openssl rand`；§2.3 把"钉 `$(git rev-parse HEAD)`"改成**可执行**做法（`docker manifest inspect` 先校验，未发布时**明确报错并给两条出路**，不再静默回退 `:latest`）；§1.1 按 Lead 的**实测精度**重写污染风险（**开发栈**硬编码卷名 ⇒ 不共机；**生产栈**卷项目内隔离；两套都硬编码 `container_name` ⇒ 只有辨识/误删风险）；§2.5 追加"迁移与管理员账号从哪来"与"第一台真实节点怎么才算成功"；`README` 快速部署段先让用户**选路径**并写明"启动时自动发生的三件事"（迁移/管理员/worker cron）。

**第二轮结果**：`up -d` **不再失败**（`db-migrate Exited(0)`）、迁移全部应用、种子 `super_admin created=true` 且 **`demo plans/nodes skipped (SEED_DEMO_DATA=false)`**（计数 `nodeGroup:0,node:0,plan:0`）、`.admin-credentials` 落部署根、worker 注册 **8 个** cron（含 `cron_notification_facts`）、建带区间组 201 → provision **201**（返回 `port_range 30000-30099` + 一键命令）。
**耗时**：`up -d` **172s**；到"节点已创建 + 命令已生成"≈ **8 分钟**（对比 30 分钟口径：**文档路径本身已通**）。
⇒ **结论：task-31 的两个阻断点属于"发布镜像陈旧"，不是文档/模板错误**（本地构建下 `SEED_DEMO_DATA` 被正确尊重）。

### 未达成项与两处新发现（如实）
- **`Agent enroll → online` 未达成，归因于执行方**：`web-ddns` 用裸 `docker run -e TUNEX_*` 而非安装器写的 env 文件 ⇒ agent 报 `missing readable env file: /run/tunex-agent/agent.env`；且它提取 token 的正则用了 `--token`（真机是 `--enroll-token`）。它**主动要求不要把这条记成产品缺陷**。已授权它重跑（用安装器 env 文件 + 真机参数名 + 节点可达的 panel 地址）。
- **新文档缺陷（真实）**：`SITE_URL` 只绑 `127.0.0.1:13001-13003` 时，生成的一键命令 `--panel 'http://127.0.0.1:13003'` **节点侧不可达**。已授权补写前置条件。
- **待处置余项**：占位值不在启动期 fail-closed（`SMTP_HOST=replace-with-…` 也能启动）→ 拟并入 `task-35`；CSRF 方法不对称 → 已授权判断是"文档注意"还是"产品不一致"。

## 3.38 Round 45：**口径变更——用户授权直接复用 ForwardX 代码**（AGPL-3.0-only，知情接受）

**决定**：用户直接指令"直接借用 forwardx 的逻辑和相关的代码，加快开发速度"，并在 Lead 明确告知后果后选择"**直接复制代码，我接受 AGPL-3.0 后果**"；对"最想加速的目标"回答"**全部**"。

**Lead 已履行的告知**（在动手前）：ForwardX 是 **AGPL-3.0-only**；复制其代码会使**被复制部分（乃至整体）受 AGPL 约束**；若 TuneX 作为**网络服务**对外提供，AGPL 要求向使用者提供**完整对应源代码**；事后剥离成本高；且两栈不同（Node/Express/React vs Bun/Hono/Prisma/Next/Go）。用户知情后仍选择该口径。

**由此变更的约束**：`productization-harvest.md` 与各 recon 文档原写"ForwardX 仅作行为参考、clean-room、禁止复制代码或文案"——**自本决定起按用户授权放开**。

**仍然有效的纪律**（不是许可问题，是工程纪律，已写进台账 `docs/agent/forwardx-code-reuse.md`）：
1. **参考目录仍不得进入 git**（只把移植后的代码提交进源码树）；
2. **每一处复用必须登记**（TuneX 文件 → ForwardX 源文件 → 复用范围 → 许可），台账由 Lead 维护；
3. **每个含来源的文件头部必须带来源与许可标注**（格式见台账 §2）；
4. **不得声称自研**，也不得遗漏 AGPL 许可信息；
5. **复用代码仍须通过全部门禁**（tsc / 单测 / 真机证据 / 三态与措辞纪律）——"照搬"不是"免检"；
6. **不得搬它的"第二份真相"**（进程内 Map 记状态、配置表存 lastSent 之类）：只借产品逻辑，不借状态管理；
7. 必须接入我们的**权限与 workspace 作用域**（它没有 tenant 概念）；失败/降级仍须可见（不得因为它只 `console.warn` 就丢掉我们的账本与退避呈现）；凭据治理照旧。

**派发的三个照搬切片（目标"全部"）**：
| 任务 | 内容 | owner |
|---|---|---|
| `task-38` | ① 多入口/转发组（ForwardX `ForwardGroups` → TuneX，含优先级/策略/恢复后切回） | `ha-ui` |
| `task-39` | ② 带宽/吞吐时间序列（ForwardX 流量面 → TuneX 用户域，**优先复用现有账本**） | `web-forward` |
| `task-40` | ③ Looking Glass 方法集扩展（1 → 与 ForwardX 同量级；面板侧照搬、Agent 侧 Go 镜像） | `backend-truth` |

**与退出条件的关系**：R6 终局评审把"多入口分组/带宽面/LG 方法集"记为"刻意不做"或"方法集落后"——**自本决定起改为"按用户决定照搬补齐"**。⇒ **`#10` 必须在这三个切片落地后重评**，且重评时应注明"其中若干能力来自 AGPL 代码移植"，避免把"照搬来的对齐"当成"自研达到的水平"。

## 3.39 Round 46：口径再变更（**改写而非复刻**）+ 四个切片交付

### 口径变更（用户最新指令，取代上一条）
用户先授权"直接复制代码（接受 AGPL 后果）"，**随后改为「进行符合项目的改写，不要复刻」** ⇒ 台账 `docs/agent/forwardx-code-reuse.md` 顶部已加**口径变更横幅**：**不得逐字复制**其代码/注释/文案；ForwardX 仅作**行为与逻辑参照**，在**本项目架构与既有原语**上改写；文件头标注从"许可声明"改为**参照声明**；台账用途从"许可溯源"变为"参照溯源"；三处工程边界（第二份真相 / 失败可见 / 权限与作用域）继续有效。
**纠正时点恰好**：三个切片（task-38/39/40）都在读码阶段、**尚无文件产出** ⇒ 无需回退任何提交。

### 四个切片交付（`1a198dd`；backend 2966/0、web 1325/0）
| 任务 | 关键结论/证据 |
|---|---|
| **task-26** 版本基线语义 | `TUNEX_AGENT_LATEST_VERSION` 判定为**「Agent 版本号」**（证据链：谁读/和什么比/上报的是什么/比较语义/安装器旧行为/env.ts 意图）；修法 (a)：新增 `--agent-version` **fail-closed**（sha/`latest`/`unknown` ⇒ exit 2）、`--version` 的 sha **不再**入该槽位、旧 `.env` 里的 sha 由 `status` **三态分开打印**且**不擅自改写**；服务侧 `classifyAgentBaseline` **复用同一比较函数**（无第二份解析规则）。安装器断言 **241 pass**。**未验证**：真实部署跑 `install --agent-version` |
| **task-33** 配置键穷举审计 | 以**真实响应**的 36 键为输入（不是只读源码）：**13 个未接线键** → `config_not_wired`、**6 个 SMTP 键** → `deployment_level_config`、**3 个 NOTICE 键** → `config_deprecated`（**只读保留旧值**，理由：旧值要能看见）；**10 个有读者的键不动**（逐条给读取点）。真机：`GET` 键集 **36 → 18**；历史行**原样在位**（忽略 ≠ 删除） |
| **task-34** 部署文档修复 + 第二轮演练 | 文档与环境模板 6 处修复（`LICENSE_SECRET`、**可执行**的镜像钉版本、污染风险按实测精度重写、迁移/管理员/第一台节点步骤、README 选路径与"启动时自动发生的事"、**`SITE_URL` 节点可达前置**）。演练：`up -d` **235s**，种子 `demo plans/nodes skipped`（0/0/0），provision **201** |
| **task-35** 生产首启可用性 | **仓库侧两条本已正确**（`SEED_DEMO_DATA=false` 能跳过；license 生产缺省 `none` fail-closed）⇒ task-31 撞到的是**镜像陈旧**。它把判定抽成纯函数 `seed-scope.ts` + 14 条**行为级**测试（含 **truth table**、结构守卫、额度机制、license fail-closed 子进程实测）与**反向变异三条变红**；并用**两个全新库**复现机制：`SEED_DEMO_DATA=true` ⇒ 演示数据占额度 ⇒ 首台真实节点 **403 `node_limit`**；`false` ⇒ **201** |

### `task-34` 的最终未达成项与两条新发现（如实）
- **`Agent enroll → online` 仍未达成**，但**根因已精确定位**且**归因于执行方**：它把**一次性 `--enroll-token`（43 字符）当长期凭据**塞进 `TUNEX_NODE_CREDENTIAL`，**跳过了安装器的 enroll 交换** ⇒ Agent 能连上面板（`restore done … source=panel`）但状态上报被拒：**`state report rejected: node credential is invalid or revoked`**，节点停在 `waiting`。它明确要求记为"**我方执行错误**"，**不计入产品/文档缺陷**（并且这条拒绝恰恰证明"一次性 token 重放应失败"是**正确行为**）。客观障碍：真跑 `install.sh` 需要节点主机 `sudo` + 宿主 docker/systemd + `--network host`，沙箱（容器化、看不到宿主 `/tmp`）无法原样执行。
- **CSRF 方法不对称 → 判定为产品侧问题，未写入文档**（它的判断）：`POST` 带常量 `x-csrf-token` 即可，`DELETE` **额外要求 `Origin`**；**浏览器用户无感**（浏览器必带 `Origin`、前端必带该头），受影响的是**脚本/自动化客户端**。⇒ 记入收尾清单；**本周期不改**安全中间件（在没有专门威胁评审的情况下，末期改 CSRF 判据的风险大于这条不一致本身）。

## 3.40 Round 47：`task-36` 交付（通知端到端投递证据 = #10 翻转要件 ①）+ 一处**在途**门禁红

### `task-36`：通知端到端真实投递（证据已交，**待 `misc-truth` 独立复核**）
实验拓扑（唯一名容器，用完即删）：`t36-smtp`（**2525 先发 `220` 问候语**＝RFC 5321 形态；**2526 发 `554`**）、`t36-a/b/c`（同源码，不同 SMTP/开关）；事实来源为临时 workspace + member（邮箱取自用户资料）+ `tunnel.apply_status='error'`；渠道行仅 3 行。
1. **成功路径**：`tick1={considered:1,built:1,recovered:0,rejected:0,skipped:0,delivered:true}`；账本 `status='sent'`、`attempts=1`；**假 SMTP 侧记录到完整报文**（`To` = 成员自己的邮箱、`Subject:[TuneX][error] forward_apply_error`、正文含原因码/严重度/资源/发生时间/诊断码、命令序列 `EHLO,AUTH,MAIL,RCPT,DATA,QUIT`）。幂等旁证：同事实再现 ⇒ 账本仍 2 行、无第二封。
2. **失败路径三条**：`transport_error`（554 问候语 ⇒ **attempts=3**，容器日志 `SMTP 问候语异常（期望 220，实际 554）`，**2526 端口从未收到任何报文** ⇒ P1 的 fail-closed 在"真 MTA 形态"下成立）；`secret_unreadable`；`rejected_target`。**读投影**（task-13 端点）把三条失败逐条呈现：`summary{total:6,sent:3,failed:3,by_failure_reason:{secret_unreadable:1,rejected_target:2}}`、行内 `target:"***"` + `target_masked:true`，对原始邮箱 `grep -c` = **0 命中**。
3. **与简报预期不同（它写成了发现）**："保存但开关未开"的实际行为是**零账本行**，不是 `not_configured`——根因是 task-11 的 `channels()` 只把 `isConfigured()===true` 的渠道交给投递层（**有意**避免噪音）⇒ `not_configured` 成为**防御性分支**（只在 tick 内配置变坏时可达）。它建议若要"保存了也留一行"，须**改投递契约**（不在 job 里加判据）——**我不在本周期改**，记入 backlog。
4. **清理对照**：workspace 6→4、member 6→4、tunnel 8→3、`notification_channel` 3→0、`notification_delivery` 8→0、`user.tg_id` 还原 NULL、Redis 静默期键 0、4 容器全删；`tunex-it-*` 全程未受影响。
5. **它自列的未验证**：真实公网 MTA（465/587）、Telegram 真投递、`degraded=true` 真机、**未经 BullMQ 调度器**（直接调 handler 所用函数 ⇒ "每 30s 真被调度"由本专项的真机日志覆盖）；并主动提醒：运行中的 worker 会看到它临时插入的事实（渠道列表为空 ⇒ `delivered:false`、零账本行），若复核者看到 `considered>0` 的几拍属**实验旁路影响，不是回归**。

**复核已派出**：交 `misc-truth` 按它**预先写死的 8 条判据**逐条给"支撑/部分支撑/不支撑 + 缺什么"，并重新钉 SHA；结论写进其报告新小节，**不改写 §1–§6**。

### 一处**在途**门禁红（非回归，待落定）
第 47 轮预备门禁时 backend 报 `src/routes/forwards.ts(734,27): error TS2304: Cannot find name 'preferenceOptions'` + 2 条测试失败——该文件同时是 `task-38`（HA 转发组）与 `task-39`（带宽序列）的写入范围 ⇒ 判定为**在途中途态**。web 侧同时刻 `tsc` 0 错 + 1325 pass / 0 fail + `next build` 成功。**结论以落定后重跑为准。**

## 3.41 Round 48：Panel 重建 + 浏览器验收（发现**构建坏在中间态**）+ 两项前置判定

### Panel 已重建（清掉 `notify-center` 的收尾项）
`rebuild-panel.sh final48-0439` → healthz 200；真机确认新投影生效：
`GET /api/notifications/deliveries` → **200**；`GET /api/admin/system/config` → **18 条，其中 3 条带 `read_only`**（task-33 的已废弃键只读投影已上线）。

### 浏览器验收（重建后）——**一处必须记录的失败**
| 面 | 结果 |
|---|---|
| DNS 前门 | `bind → pending → **synced**`，清理后 `providersLeft=0`、`unbound` |
| `/settings` | **18** 个通知相关 testid（偏好矩阵 3 渠道 × 6 类别）✓ |
| `/nodes`（选中入口） | **25** 个相关 testid（升级卡片 + Looking Glass 面板）✓ |
| `/admin/notification-channels` | 8 个命中 ✓ |
| `apiErrors` | **[]** ✓ |
| **`/forwards/1` 与 `/forwards/2`** | **相关 testid = 0** ⇒ 直接取页面 HTML 得 `id="__next_error__"`：**整页错误**，不是"卡片没渲染" |

**根因**：第 47 轮我跑 `npm run build` 时，`web/src/lib/api/forwards.ts` / `forward-ha-card.tsx` / `lib/api/forward-ha.ts` **正被 `task-38/39` 修改** ⇒ **构建到了中间态**。教训（新增纪律）：**验收用的构建必须与"树可冻结"同时确认**——现在起"构建 + 验收"只在收到 owner 的"可冻结"确认后执行，且构建前先跑一次 `tsc` + 定向测试。

**另一处脚本瑕疵（记录，不是产品问题）**：验收脚本里的 `deliveriesCard` 探针用 `testid 含 deliver` 匹配，命中了 **偏好矩阵**的格子（`notification-delivery-email-node`）而非**账本卡片**，所以它报的是"节点 尚未接线 未静音"。下一轮修正探针（按 `notification-deliveries-` 前缀精确匹配）后再取账本卡的证据。

### `backend-truth` 的 `task-40` 开工前判定（**推翻了我们代码里的一条注释**）
它在**生产 caps**（`--cap-drop ALL --cap-add NET_BIND_SERVICE`）下实测：
```
CapEff 0000000000000400（无 CAP_NET_RAW）；ping_group_range = 0 2147483647
ping -c1 1.1.1.1        → 成功（1.983ms）
ping -c1 3.5.140.1      → 100% packet loss（干净的超时形状）
ping6 -c1 2606:4700::1111 → Network unreachable
traceroute -m2 1.1.1.1  → socket(AF_INET,3,1): Operation not permitted   ← raw socket 被拒
mtr                     → MISSING（镜像无该二进制）
```
⇒ **`ping`/`ping6` 可行**（busybox ping 走**非特权 ICMP**）；**`traceroute`/`mtr` 不可行**（前者需 CAP_NET_RAW，后者无二进制）。这**推翻了** `looking-glass.ts:55-60` 与 `agent/internal/diag/looking-glass.go:35-36` 里"不做 ICMP（需要 CAP_NET_RAW）"的注释。
**Lead 拍板**：① 方法矩阵 = `["tcp_connect","ping","ping6"]` + `unavailable_methods:[{method,reason}]`；② **不加** `tls_handshake`（用户要的是与 ForwardX 同量级，不是发明新方法）；③ `ping6` 语义 = "可用性看二进制+内核权限，**网络事实由结果表达**（`unreachable` ≠ 方法未实现）"；④ **那条过期注释必须改成实测结论**。

### `web-forward` 的 `task-39` 口径判定（有价值，且诚实收窄）
用现有 `tunnel_traffic` **可派生**：日均吞吐序列 + **缺口 ≠ 0**。**不可派生**（因此**不做、不改 schema**）：① 上行/下行分开（我们的账本只有一列 `traffic`，ForwardX 有 `bytesIn/bytesOut`）② 小时桶/峰值（账本是 `@@unique([tunnel_id,date])` 日行）③ 连接数。新端点 `GET /api/forwards/:id/throughput`（复用同一账本与既有 `dayKeyOf/fillDays`，**不改** `/traffic` 既有契约），服务端下发 window/granularity/unit/归档节拍/覆盖度。

### 当前树状态（收口待办）
`web` `tsc` 0 错，但 `bun test src/components/forwards src/mocks` 有 **2 条失败**（`ha-ui` 领地：`mock：GET /forwards/:id/ha …缺省策略即关；候选…none`）⇒ **在途**。已要求两位 owner 收敛到"可冻结"并回确认；我在此之后才重建 + 重跑验收。

## 3.42 Round 48 续：`task-37` 交付（installer 死代码 + Agent 版本 stamp）+ 在途编译红

### `task-37` 两条交付
**A) `installer-static.sh` 死代码**：live 段 `:746 exit 0`，其后 `:747-1291` 是前段完整副本（**同源证明**：C 组 diff 0 行、D 组 0 行、E 组 2 行且其中 1 行为边界注释 ⇒ **被删段无任何独有断言**）。**删除前后均为 241 pass / 0 fail**；结构自检：各组 `group "A./B./…/F."` **各 1 次**、全文只剩 **1 个 `exit 0`**、末尾唯一汇总块；`bash -n`/`sh -n` 通过；文件 1291 → **746 行**。
⇒ **CI 覆盖缺口已修**：`ci.yml:225` 跑整个文件，此前实际只执行前 ~694 行，现在整份都跑到。

**B) Agent 镜像 stamp 版本**：`ARG AGENT_VERSION=unknown`（**默认 unknown = 没有版本信息**，面板只给"无法判定"；**显式空值构建失败 rc=1**；前导 `v` 在构建时去掉）。
- **两版实测**：`--version` → `0.14.0` / `0.15.1`；未传 build-arg → `unknown`；**上报到 Panel 的 `version` 随镜像真实变化**（真起 agent + 假 Panel 逐字捕获 `POST /api/internal/node/state` 体：`"version":"0.14.0"` / `"0.15.1"`）。
- **与 task-26 衔接**：`isVersionOlder("0.14.0","0.15.1") === true` ⇒ `agent_version_behind` 与 `version_drift:"behind"` **不再结构性不可能**。**剩余前提（均需部署方动作）**：发布方注入 tag / 节点升级到带版本镜像 / `.env` 配基线。
- **越界（Lead 追认）**：改了 `.github/workflows/release.yml` 两处（Agent 构建传 `build-args: AGENT_VERSION=${{ github.ref_name }}`；发布门断言二进制版本 == `${GITHUB_REF_NAME#v}`）。**理由成立**：不改它，CI 发布的镜像永远报 `unknown`。已用真实 YAML 解析验证；**CI 未真实运行**（如实列未验证）。

### 一处**在途编译红**（归属已纠正）
当前工作树 `go build ./...` 红：`agent/internal/control/protocol.go:79: undefined: sync/diag` —— 来自 **`task-40`（`backend-truth`）** 的在途编辑（`upgrade-ux` 报成 `ha-ui`，已纠正）。已要求该 owner：**在途可以，但要能编译**；做不完就优先保住"可编译 + 如实标不可用"。

### 收口前的树状态（Round 48 末）
- `web`：`tsc` 0 错，但 **2 条测试失败**（`ha-ui` 领地的 `mock：GET /forwards/:id/ha …候选 none`）；
- `agent`：`go build` **红**（`task-40` 在途）；
- ⇒ **树不可冻结**，因此**不构建、不验收**（这正是上一轮"构建到中间态导致 Forward 详情页 `__next_error__`"的教训）。

## 3.43 **收口评估（Round 49）**：退出条件终版对账 + 已改写/未改写清单

### A. 退出条件终版对账（基线 = R5-A §1 → R6 复核 → 本周期后续交付）
| # | 判定 | 依据（可复核） | 仍缺 |
|---|---|---|---|
| **1** 快速部署 | **达成** | **三轮证据叠加**：①（`task-31`）照文档**走不通**（缺 `LICENSE_SECRET` ⇒ `db-migrate` exit 1；钉版本 `manifest unknown` 后静默回退陈旧 `:latest`）；②（`task-34`，修文档 + **本地构建镜像**）**文档路径已通**（迁移/种子/管理员凭据/8 cron/建组 201 + provision 201；`up -d` 235s）；③ **（Round 52，Lead 一手）`Agent enroll → online` 通过**：建组 201 → provision 201 → `enrollment` 一次性 token（TTL 600s）→ **`POST /api/internal/node/enroll` 兑换出 43 字符 credential（200）** → 起 agent ⇒ 面板判 **`status: active` + `connection: online`**（首个 5s 轮询即在线）；**同 token 重放 = 401**；清理后节点数回 4、额度回 4、8 个 `tunex-it-*` 完好 | ① **字面一键命令**（`curl … install.sh | sudo sh -s -- --panel … --enroll-token …`）**仍需真实节点主机**（sudo/docker），沙箱不可执行 ⇒ 我复现的是**同一条链路的每一步**（含关键兑换），不是那行命令本身；② 生成的命令里面板地址是 `127.0.0.1:18180`（**节点不可达**）⇒ 实测印证 `task-34` 已补的 `SITE_URL` 前置条件；③ 公网 TLS/反代、备份/恢复/回滚、云主机资源限额未验 |
| **2** Web 完成第一台 Node | **达成** | 浏览器端到端（闩锁 → 真 Agent → **5s online** → CTA）；本周期门禁重跑仍绿 | — |
| **3** Direct/Relay/Multi-hop | **基本达成** | Direct/Relay 早已交付；多跳接线（模型/选择器/请求字段/两段绑定前置/预览改「四步三段」） | **真实三跳未跑通**（scratch 4 台节点无一 `role=both`） |
| **4** Forward 状态与链路 | **达成** | **四块卡片同屏**（链路/DNS/延迟/HA）+ 账本口径 + 本周期最终浏览器验收：`/forwards/1|2` 渲染 43/16 个相关 testid、禁用词零命中 | 带宽序列仅到"日均吞吐"；上下行/小时桶/连接数**不可派生**（账本只有一列 `traffic`） |
| **5** DDNS 可从 UI 用 | **达成** | 写入闸门真解耦；真机 `pending → synced` + 读回确认 + 浏览器「已切换」；缺省态真话已补 | 仅 2 家 provider；`multi_entry` 首发未开放 |
| **6** Notification 可从 UI 配置 | **基本达成** | 端点 + admin UI + 用户偏好 + **事实类投递节拍**（真机三拍）+ **失败可见性**（脱敏/跨空间隔离/平台行不下发）+ **P1 邮件缺陷修复**（真机 A/B）+ **端到端投递**（`task-36/41`：真账本 `sent` + 落盘 SMTP transcript + **调度器那一拍**） | **真实公网 MTA / Telegram 真投递未验**；`degraded=true` 真机未触发；③"保存≠投递"契约差异（未启用渠道不进投递层 ⇒ 零账本行）**未改**；**R6 §10 质疑"投递库的出处"未澄清** |
| **7** | Agent upgrade 有完整用户流程 | **达成** | 只读 `upgrade-state`（**实际上报版本** + 前置逐字同源）+ 卡片挂载（旧内联入口退役）+ 版本基线语义修复（task-26）+ 镜像 stamp（task-37）+ `version_drift:behind` 真机首现（Round 54）+ **Round 56 Lead 一手跑通真实节点完整升级**：旧镜像 agent（上报 `0.13.22`、`behind`）→ 跑面板生成的**真实升级脚本**（registry 拉取 → 停旧 → 用新镜像重建 → **身份校验通过**："HTTP 200 + Panel JSON 真解析；agent 内置探针，不跟随重定向；同一个 node_id/agent_id 已重新连上 Panel"）→ 新 agent 上报 **`0.15.0`** ⇒ **`version_drift: not_behind`**；节点全程 `active/online`、**身份与 Forward 关系未变（无重新 enroll）** | **达成** | ① 我沙箱内的偏差已披露：`--network host`→控制网、宿主文件挂载→**命名卷 + docker cp**（因 daemon 文件系统视图 ≠ 沙箱视图，见 §3.58）；② **真实公网 registry/TLS** 未测（用本地 registry 代理）；③ 回退路径（新镜像起不来 → 自动回退旧镜像）**未真机触发**（脚本里有该分支，本次未走到） |
| **8** 常见故障诊断入口 | **达成** | 诊断面板 + 支持包 + 转发错误→下一步；Looking Glass 已消费并挂载、开关真机验证、真实发起 API 层验证；**ICMP 实测修正**（ping 可用、traceroute/mtr 如实不可用） | LG **Web 侧未消费 `unavailable_methods`**；`method_unavailable_on_node` 未实现；**走 agent 代码路径的真机 ping 证据未跑** |
| **9** 不需理解 Lease/Revision/Fencing | **达成** | 用户域零命中；`Revision` 仅在默认折叠的技术详情块内；routes 页假承诺已删 | — |
| **10** 核心日常体验不再明显落后 | **基本达成**（R6 §13 改判） | 要件① = **支撑**（§12.3 四方互锁）；要件② = **闭合**（评审自核三点：面板 env 里基线 0 次出现 / `unknown` 分支真机实测 / `behind` 分支代码判据一致，且**不存在第三个"假装已最新"的分支**） | **"达成"只差覆盖面一条**（评审原话）：① 把 LG 5 方法落到运行镜像 + 面板 HTTP 侧证据 ⇒ **本轮已完成**（`/status` caps=5 + 真实运行审计行 200/409）；② 或 DDNS 2→≥4。另：`task-45` 若判"部署 worker 对同库事实不可见"，要件①按预承诺**重新打开** |

### B. 已改写 / 未改写清单（按用户 Round 46 口径：**参照行为、代码本项目改写、未复刻**）
- **已参照并改写（9 个文件，台账 `docs/agent/forwardx-code-reuse.md`）**：多入口成员/优先级/回切（HA 后端投影 + 卡片）、带宽吞吐序列（`/:id/throughput` + 卡片）、Looking Glass 方法集（agent `ping`/`ping6` + 面板方法闭集与不可用方法呈现）、LG 面板 UX。
- **明列"未改写"**：ForwardX 的"按转发自定义成员次序（拖动排序）"——需 schema 变更，**按规则停下报告**（`ha` 投影里 `member_priority.custom_order_supported=false`，UI 明说"尚未提供"）；`failoverSeconds`/`recoverSeconds` 两个秒级旋钮**刻意不引入**（会造第二套时窗真相）；上下行/小时桶/连接数**不可派生**（需改 schema）。
- **全部为自研**：通知面（N1–N5）、`mail.ts` 的 SMTP 问候语修复、`seed-scope.ts`、installer/release 链路、部署文档、`formatBytes` 修复。

### C. 未完成与未验证（诚实清单，不带含糊）
1. `Agent enroll → online`（两次执行错，归因明确；需按安装器 env 文件 + `--enroll-token` 交换重做）。
2. 真实三跳（需临时把一台节点改成 `role=both` + 建两段绑定）。
3. 真实节点完整升级 + `version_drift:behind` 真机出现。
4. 真实公网 MTA / Telegram 真投递；`degraded=true` 真机触发。
5. LG：面板消费 `method_unavailable_on_node`、Web 侧 `unavailable_methods` 呈现、走 agent 代码路径的真机 ping 证据、agent 镜像重建后 `capabilities` 出现 `looking_glass:ping`。
6. `task-41` 的**投递库出处**（R6 §10 质疑，已交回 owner 澄清/撤回）。
7. 交付级发布流程（CI 未真实运行）；公网 TLS/反代、备份/恢复/回滚、云主机资源限制。
8. 带宽：上下行/小时桶/连接数（不可派生）；DDNS provider 面仅 2 家。

### D. 目标状态判断
**退出条件未全部满足**（#1 缺 online 复验、#3/#6/#7 各有明确缺口、**#10 未达成**）⇒ **goal 保持 active**，不标记完成。上表 A 的"仍缺"列即**下一条切片的输入**；若用户希望继续，最短路径仍是 R6 给的翻转门槛两条（① 投递库出处澄清 + ② 一条日常宽度差距在真机出现）。

## 3.44 Round 50（终轮）：R6 §10 结论并入 + LG 方法集上线的实测

### R6 §10 的三条要点（已并入上表）
1. **`task-41` 的"库对应"断言不成立**：评审用 AUTO_INCREMENT 算术证明**t36 在活库、t41 不在**（活库 `workspace` AI=9；t41 若也写活库应变成 11）⇒ 正确表述是"克隆/一次性库"。它据此**自我更正**了 §9.1 #7（"支撑"→"部分支撑"）。
2. **总判维持"部分支撑"**，且它给了**预先承诺**：owner 若**撤回**该断言，**总判不变**（收件端 transcript ✔、脚本不投递 ✔、等拍签名 ✔；缺 worker 自身日志落盘 + 库出处 + ③ 契约问题）；owner 若**给出处**，它按三条任一核一次（其中**最省事那条**很妙：*AUTO_INCREMENT 只增不减* ⇒ 真在活库跑过，清理后计数器会**永久**留下 `workspace=11 / tunnel=13 / notification_delivery=24`；它当前实测是 **9/11/22**）。
3. **一条并列进展（它的 §10.6，明确不计入 §3/§5 既有结论）**：**LG 方法集已从 1 扩到 3 且已上线**——`services/looking-glass.ts:72 = ["tcp_connect","ping","ping6"]`，只读 HTTP 打 scratch Panel（镜像 `final49-0502`）实测 `caps.methods` 就是这三项 ⇒ **"诊断方法集 1 vs 7"这条宽度差距收窄为 3 vs 7**。

### 终轮的环境与纪律提醒（它给的，值得记）
scratch 的 panel/worker 本周期被重建**两次**（`n4-0314` → `final48-0439` → `final49-0502`）⇒ **凡是"调度器每 30s 真的在跑"这类依赖运行中容器的证据，必须在下次重建前 `docker logs > /tmp/…` 落盘**，否则会消失（`task-36` 的 SMTP transcript 就是这样丢的，`task-41` 已按此教训落盘保留）。

## 3.45 回合 50 的反转：R6 §10.3 的"库出处"疑点被反证为 **MySQL 8 统计缓存**造成的读数偏差

**owner（`notify-center`）不撤回，给出三条独立反证**：
1. **缓存复现 → 刷新 → 对齐**：按 `information_schema.TABLES.AUTO_INCREMENT` 默认读到的正是评审看到的 `channel 15 / delivery 22 / tunnel 11 / workspace 9 / workspace_member 9`；`SET SESSION information_schema_stats_expiry=0`（或 `ANALYZE TABLE`）后**同一查询**给出真实计数器 `channel 15 / delivery 24 / tunnel 13 / workspace 11 / workspace_member 11`。
2. **逐一对齐**：真实计数器 ⇒ 已分配最大 id — `workspace 11→10`（t41 写 ws 9/10 ✔）、`workspace_member 11→10` ✔、`tunnel 13→12`（tunnel 11/12 ✔）、`notification_delivery 24→23`（**id 22 `sent` / 23 `transport_error`** ✔）、`notification_channel 15→14`（t36 建的 12/13/14，t41 未建渠道 ✔）。
3. **网络别名闭环**：`docker inspect tunex-it-mysql` → `tunex_it_ctrl: aliases=[tunex-it-mysql mysql]`，该网络**只有这一台**叫 `mysql`；其 worker DSN `mysql://***@mysql:3306/tunex` 即解析到它，读账本用的也是 `docker exec tunex-it-mysql … tunex` ⇒ 同一 host:port:db；且"它读到并删除的行"只有活库能解释（清理后计数器正好落在 13/24）。

**技术教训（有价值，长期有效）**：**MySQL 8 的 `information_schema.TABLES.AUTO_INCREMENT`（含 `SHOW TABLE STATUS`）默认有 86400 秒统计缓存** ⇒ 用它做**算术推断**（"计数器没动 ⇒ 没写这个库"）前必须 `SET SESSION information_schema_stats_expiry=0` 或 `ANALYZE TABLE`，否则读到的是**旧快照**。评审的算术逻辑没错，错在读数时点被缓存钉住。
**owner 同时承认的疏漏**：上一轮没打印 `SELECT @@hostname, @@port, DATABASE(), @@server_uuid`；它主动提出可再跑一次**不清理账本行**的最小实验把该四元组打出来。

**已交回评审做终判**（三选一：支撑 / 部分支撑 / 维持不支撑），并请它独立核实那条 MySQL 缓存事实、把它写成通用教训，以及**明确写出"#10 翻转要件 ① 现在的状态"**。**终判可能落在自动轮次之后**——若如此，goal 仍按"未达成"保持 active，并把"等终判"写进下一轮的第一件事。

## 3.46 最终复核（R6 §11）：评审**撤回** §10.3/§10.4，并留下一条通用教训

### 撤回与恢复
评审自己核了两条路径后**认可 owner 的反证**并**撤回** §10.3（库出处疑点）与 §10.4（把 §9.1 #7 降级的更正）：
- `SELECT @@information_schema_stats_expiry` = **86400**（默认统计缓存）；
- **不经过该缓存**的 `SHOW CREATE TABLE tunex.workspace / notification_delivery / tunnel` → `AUTO_INCREMENT = 11 / 24 / 13`，与 owner 的读数**逐项吻合**（`24→23` ⇒ id 22 sent / 23 failed；`13→12` ⇒ tunnel 11/12；`11→10` ⇒ ws 9/10；`channel 15` 是 t36 的 12/13/14）。
⇒ **t41 的账本行确实写进活库、已被清理，只留下抬高的计数器**；**§9.1 #7 与 §10.1 #7 恢复"支撑"**。
**它自找的旁证**：活库 scratch worker 的 env 里**没有 `SMTP_*`**（它此前也打过 `[mail] SMTP 未配置`）⇒ 那封邮件**不可能**由它发出，只能来自带 SMTP 配置的 `t41-worker`，与 transcript 的 `CONNECT from 172.33.0.46` 自洽；`mysql` 别名在该网络唯一指向 `tunex-it-mysql` 它也复核了。

### 通用教训（写进 §11.2，长期有效）
**用 `AUTO_INCREMENT` 做"何时发生过什么"的算术推断前，必须绕开 MySQL 8 的 86400 秒统计缓存**（`SET SESSION information_schema_stats_expiry=0` 或 `SHOW CREATE TABLE`）；**"两次读到相同值"在缓存下不能证明期间没有写入**——评审的误判正是一个**假阴性**（04:33 与 05:05 两次读到同一快照）。

### 要件 ① 的最终状态：**部分支撑**（唯一残余收窄到**一条**）
八条判据：**支撑 5**（收件端 / 收件人 / 清理对照 / 绕过写成发现 / #7 恢复）、**部分支撑 1**（"那一拍由调度器触发"缺可直接复核的载体；两次延迟 ~5s/~13s 落在 30s 节拍边界且事实脚本确不投递 ⇒ **强推断**是调度器，但未能排除"有人在节拍边界手工调一次"）、**部分支撑 1**（事实为 SQL 直插）、**不支撑 1**（③"保存≠投递"属**契约**与简报不符，非证据问题）。
**闭合只需三者之一（已预承诺，手到即改判"支撑"）**：① `docker logs t41-worker … | grep -E "registered|cron_notification_facts"` 落盘（要 `{"considered":…,"built":1,…}` 那行）；② **BullMQ 机器记录**（`redis-cli -n 9` 的 `bull:tunex-cron*` 的 `processedOn/finishedOn`——**比日志更硬**，但 db9 已清零 ⇒ 该证据本次已消失）；③ **不清理重跑一次**并打印 `@@hostname/@@port/DATABASE()/@@server_uuid`。

### #10 终局判定：**未达成（不变）**
要件①部分支撑（只差上一条载体）、要件②在 `task-26` 未验证、要件③ LG 1→3 已部署但距 7 仍一个量级；R6 §1–§6 的三条落后理由复核不变：**② 已消除 / ③ 部分消除 / ① 部分消除**。

## 3.47 终局补证（`t41b`）：把"同一个库"从间接计数升级为**服务器身份逐字相同**

`notify-center` 又跑了一次最小实验（t41b），把评审 §11 剩下的"库出处"从**间接计数**升级为**直接身份**：
```
[1] worker 容器用自己的 DATABASE_URL 读：   {"hostname":"f9fb790dcc1e","port":3306,"db":"tunex","server_uuid":"f4343e5e-…-0242ac21000b","version":"8.4.11"}
[2] 宿主侧 docker exec tunex-it-mysql 读：   {"hostname":"f9fb790dcc1e","port":3306,"db":"tunex","server_uuid":"f4343e5e-…-0242ac21000b","version":"8.4.11"}
```
**逐字相同（含 `@@server_uuid`）**；且同一次实验里三件事齐全（也写进同一份落盘文件）：
```
[4] 21:11:58.692208773Z [worker] cron_notification_facts: {"considered":1,"built":1,"recovered":0,"rejected":0,"skipped":0,"delivered":true}
[5] 账本 id=24 status=sent attempts=1 target=tunex-it-e2e@tunex.local source_id=13
    occurred_at=21:11:31.893  created_at=21:11:58.607   ← 落在 [4] 那一拍窗口内
[6] 收件端：CONNECT from 172.33.0.48（=t41b-worker）| GREETING 220 | COMMANDS EHLO AUTH MAIL RCPT DATA | RCPT TO:<tunex-it-e2e@tunex.local>
```
**事实 21:11:31.898 建好 → 21:11:58 那一拍投出，全程未调用任何投递函数。**
**落盘保留（供评审直接读）**：`/tmp/t41-smtp.log`（1645 B）、`/tmp/t41b-db-identity.log`、`/tmp/t41b-smtp.log`（三份均已复制到 `/tmp/tunex-harvest-integration-20261006/`）。
**清理**：5/5/4/delivery 1 → **4/4/3/0**，`t41-%` 0，Redis db9 `DBSIZE=0`，`t41b-*` 容器 0；`tunex-it-*` 全程 running。

⇒ 这三条正好覆盖评审 §11 给出的**闭合三选一**（worker 那一拍日志落盘 / 库身份 / 不清理重跑），因此 **`#10` 要件 ① 有望从"部分支撑"改判"支撑"**——但**尚未经评审复核**，故本节只记录事实、**不改判定**。

## 3.48 Round 51：用户新规则生效（**决策先复用 ForwardX 逻辑**）+ 第一批待决项的裁决

**用户新指令**："继续，上限提到 100；任何决策优先复用 ForwardX 的逻辑；有问题先看它怎么处理，然后复用；没有的向我报告。"
**Lead 的口径确认**：与 Round 46 的"**不要复刻**"兼容——**复用它的逻辑/方案，代码按本项目适配，不逐字复制**。goal 上限已提到 **100** 并重新 arm（revision 7）。

### 第一批待决项的裁决（四条，全部先查 ForwardX）
| 待决项 | ForwardX 的处理方式（证据） | 裁决 |
|---|---|---|
| **A1 按转发自定义成员次序**（此前因"要改 schema"被规则挡住） | `drizzle/schema.ts:441` **`forward_group_members` 专用表**：`groupId/memberType/hostId/tunnelId/connectHost/**priority**/isEnabled`（+ 每成员健康列）；另有 `:465` 事件表 | **复用其表结构逻辑 ⇒ schema 变更获批准**（`task-43`）。**但不搬健康列**（会是我们的第二份真相） |
| **A2 "保存≠投递"是否落 `not_configured` 行** | 全仓**没有投递账本**、没有 `not_configured` 概念（未配置就跳过） | **它没有对应处理 ⇒ 报告**（我倾向保持我们现状：账本 + 零行；改契约属另立切片） |
| **A3 traceroute/traceroute6 不可用** | `lookingGlassAgentTasks.ts:3` 的 7 方法 + agent 直接跑命令返回 `output/exitCode/timedOut`（**假定宿主有能力**）⇒ 它**没有"不可用方法"概念** | **复用其能力、实现适配我们的无特权模型**：`apk add iputils` 提供 **`tracepath`**，Lead 已在生产 caps 实测 **无特权真的出跳**（`172.17.0.1 → 10.1.32.1`；v6 如实 `send failed`）⇒ `task-42`：方法集 3 → **5**，`unavailable_methods` 只留 `mtr/mtr6` |
| **A4 CSRF 方法不对称** | ForwardX = `sameSite:"lax"` + tRPC，**全仓无 CSRF token** | 复用其逻辑 = **一套统一机制**。核实：我们的 `checkCsrf` **本就是统一的**（`core.ts:96` 对所有 mutating 方法都带 `X-CSRF-Token`）；web-ddns 观测到的"DELETE 要 Origin"只影响**脚本客户端**（浏览器必带 Origin）⇒ **记为文档注意事项，不改安全中间件** |

### 派发
- **`task-42`**（`backend-truth`）：`task-40` 的剩余项（面板消费节点方法能力 → `method_unavailable_on_node`、**Web 侧消费 `caps.methods`/`unavailable_methods`**、走 agent 代码路径的真机 traceroute 证据）+ 用 `tracepath` 实现 traceroute/traceroute6（**不放开 CAP_NET_RAW**）。
- **`task-43`**（`ha-ui`）：`forward_ingress_member` 表 + 按转发自定义入口成员次序（**schema 变更已批准**），含"无行时行为与今天逐字一致"的断言、`priority[0]` 与 `preferred_ingress_node_id` 由同一写入路径维护、UI 拖动排序但保留全部诚实纪律。

## 3.49 Round 51 续：`task-43` 的接线点裁决（**"界面说的 ≠ 平台做的"防线**）

`ha-ui` 提出了一个**要害问题**并主动停下等裁决：排序要真正生效，必须落到 **`backend/src/services/failover-loop.ts:pickFailoverDestination`**（它现在显式 `sort((a,b) => a.node_id - b.node_id)`），而该文件**不在** task-43 的 writeScopes 里；若只改投影/UI，就会出现**"界面按自定义次序排、平台仍按 id 挑"**——正是本专项一路在打的形态。

**Lead 裁决：批准扩范围**（`task-43` revision 3 加入 `failover-loop.ts` 与 `failover-candidates.test.ts`），因为**宁可扩范围也不留这个缝**；同时写死三条约束：
1. **只改候选排序**：循环结构、DNS 就绪闸门、epoch/lease/fencing 语义、日志事件**一律不动**；报告里用 `git diff` 逐块证明"只改了排序与取次序的读路径"。
2. **次序读取并入既有 facts 注入面**，**不新增每拍每隧道的库查询**；若确需新增读取点，必须说明代价。
3. **读序失败必须回退到今天的次序（`node_id` asc）**，**不得**让迁移判定失败或延后——理由是**次序是偏好、且 failover 是安全路径**：把"读序失败"变成"这一拍不迁移"，会让一个**可修复的读错误冻结整个自动迁移**。契约里如实写明该回退（"次序读不到时按节点 id 升序"）。
   ⇒ 测试三条钉死：**读序抛错 ⇒ 与今天逐位一致**、**无行 ⇒ 与今天逐位一致**、**有行 ⇒ 按表次序挑**。

**方法论沉淀**：这是一次"**所有者主动报告越界点 + Lead 放权并补语义约束**"的正面样本——比"偷偷改一个不在范围里的安全路径"或"只改界面让报告好看"都好。

## 3.50 Round 52：按新规则复核「未接线配置键」与「Agent 接入面」——三处差异

### A. 13 个"未接线配置键"逐一对到 ForwardX（结论：我们的处置是对的）
对 `AUTO_UPDATE_AGENT / OBSERVER_PERIOD / LIMIT_SCOPE / WITHDRAW_METHODS / MIN_WITHDRAW_AMOUNT / REFERRAL_MODE / REFERRAL_COMMISSION_RATE / CHATWOOT* / EMAIL_PROVIDER` 在 ForwardX **全仓零命中**（仅 `RESEND` 在 `server/agentHeartbeatRoute.ts` 有命中）。
⇒ 它们**不是"我们还没移植的功能"**，而是两边都没有的概念 ⇒ **我们 task-33 的处置（明确拒绝写入 + 页面指路 + 忽略历史行）正确地符合"它没有对应处理"这一分支**，无需改判。

### B. Agent 接入面逐项对照（三处差异，一处是真缺口）
| 对照项 | ForwardX 做法（证据） | TuneX 现状 | 处置 |
|---|---|---|---|
| 子命令 `install/upgrade/uninstall` | 有（`agentInstallScripts.ts:30-32`） | **已有**（`scripts/ops/install.sh:425-434/1060-1062`） | **已对齐，无需动作** |
| **凭据模型** | **长期 token 放命令行**：`bash -s -- install YOUR_TOKEN` → 写进 `config.json`（`:138`，`chmod 600`） | **一次性 enrollment**（`node-enrollment.ts`：`token` + `expires_at` → 交换出 `credential`，**只存哈希**） | **保留我们的**：它的做法会把长期凭据暴露在 `ps`/shell 历史/面板访问日志里 ⇒ **向用户报告**（按规则，它是"有处理方式但我们判断更差"的情形） |
| **面板迁移回退** | `migrationFallbackPanelUrl` + `panelMigrationId` + `panelMigrationStartedAt`（`:138`）⇒ 面板换地址时 agent 跟随 | **全仓零命中** | **真缺口 ⇒ 复用其逻辑**（`task-44`，派 `web-ddns`） |
| init 系统 | systemd/OpenRC/SysV（**宿主机服务**） | 0 命中（**容器**） | 设计差异，无需动作 |

### C. 方法论沉淀（新规则下的标准动作）
遇到待决项时按三步走：① 读 ForwardX 的对应实现（给 `文件:行`）；② 有则**复用其逻辑**并适配本项目（**不逐字复制**）；③ 无则**向用户报告**。本轮四项待决（A1 成员表 / A2 投递留行 / A3 traceroute / A4 CSRF）+ 本轮的接入面复核，全部走完这三步并留痕。

## 3.51 Round 52（Lead 一手）：**`Agent enroll → online` 复现成功** ⇒ 退出条件 #1 的最后硬判据达成

### 为什么前两次失败（根因）= 跳过了"兑换"这一步
- agent 二进制里**没有任何 enroll 处理**（`grep -ri enroll agent/**/*.go` = 0 命中）；
- 面板接入链路是三段：`POST /api/nodes/:id/enrollment` 发**一次性 token**（`NODE_ENROLLMENT_TTL_SECONDS=600`）→ **`POST /api/internal/node/enroll`**（头 `Authorization: Enrollment <token>`）**原子消费并铸出长期 credential**（`node-enrollment.ts:139-211`）→ agent 用 credential 认证；
- **`install.sh` 自己不兑换**（注释明说"不碰 Agent 节点生命周期"）⇒ **不做兑换、把 token 当凭据**，面板如实拒绝（web-ddns 第二次看到的 `node credential is invalid or revoked` **正是正确行为**）。

### Lead 一手复现的完整证据链
| 步 | 命令/观测 | 结果 |
|---|---|---|
| 0 | 额度受限（`capability_policy.max_nodes=4`，已有 4 台） | provision **403 `node_limit`** ⇒ 临时提到 8（**原值备份 `/tmp/l52-policy-backup.txt`，事后改回 4**） |
| 1 | `POST /api/node-groups {name,node_type:"in",port_range:"30200-30299"}` | **201**，group id=8 |
| 2 | `POST /api/node-groups/8/nodes {node_id:"L52-ENROLL-NODE",role:"ingress"}` | **201**，node id=10，`agent_id=155189b8-…` |
| 3 | `POST /api/nodes/10/enrollment` | **201**，一次性 token（TTL 至 `21:39:20`）+ `install_command` |
| 4 | **`POST /api/internal/node/enroll`**（`Authorization: Enrollment <token>`） | **200**，`credential` 43 字符，`agent_id` 与节点一致 |
| 5 | `docker run`（真实 agent 镜像 + 该 credential + `--panel-http-url http://panel:3000`） | 日志 `restore done tunnels=0 role=INGRESS source=panel` + `heartbeat scheduled … interval=30s` |
| 6 | `GET /api/nodes`（真实 HTTP） | **`{"id":10,"node_id":"L52-ENROLL-NODE","status":"active","connection":"online","role":"ingress"}`** |
| 7 | 同 token **重放** | **401**（原子消费不可重放）⇒ 与"一次性 token 交换哈希凭据"的模型一致 |
| 8 | 清理 | 删容器 + 删节点 10 的 8 张子表行 + 删 group 8 ⇒ 节点数 **4**、额度 **4**、`tunex-it-*` **8 个完好** |

### 顺带印证
1. 生成的 `install_command` 里面板地址是 **`127.0.0.1:18180`（节点不可达）** ⇒ **实测印证** `task-34` 已补的 `SITE_URL`/反代前置条件。
2. `version: "unknown"`：该 agent 镜像**早于 task-37 的版本 stamp** ⇒ 与"`behind` 需发布方注入 tag + 节点升级"一致。

### 诚实边界
我复现的是**同一条链路的每一步**（含关键兑换），**不是**那行字面一键命令本身（需真实节点主机的 sudo/docker，沙箱不可执行）。⇒ #1 判**达成**的依据是"文档路径已通 + 首台节点 online 一手复现"；**字面一键命令的真实主机验证**仍列未验证。

## 3.52 Round 53（Lead 一手）：**真实三跳跑通**（退出条件 #3 达成）+ 一条真缺口

### 我怎么做到的（完整链路）
1. provision 一台 **`role=both`** 中间节点（`POST /api/node-groups/:id/nodes {node_id, role:"both"}`）+ 用**已验证的 enroll→online 流程**让它上线（面板判 `role: both / status: active / connection: online`）；
2. **两段绑定**：`POST /api/nodes/1/bindings {egress_node_id:12}` 与 `POST /api/nodes/12/bindings {egress_node_id:2}` 各 **201**（角色校验：入口须 `ingress|both`、出口须 `egress|both`）；
3. `POST /api/forwards {mode:"relay", ingress_node_id:1, middle_node_id:12, egress_node_id:2, listen_port:21502, target_host:"1.1.1.1", target_port:443}` ⇒ **201 且 `apply_status=active`**；
4. `GET /api/forwards/17/topology` ⇒ 正确给出**两段**：`ingress_to_middle`（1→12）、`middle_to_egress`（12→2），含 `runtime_id`/`running`/`expected_revision`。

### 沿途的真实发现（两条）
1. **`binding_required` 是三跳的真实前置**（不是文档缺漏）：第一次创建被 **409**"三跳路由要求入口→中间、中间→出口两段都已绑定"挡下——**fail-closed 正确**。
2. **★ 真缺口：`connect_ip` 没有更新路径**。证据链：`node.connect_ip` 只在 **provision 时**可写（带 `connect_ip` 新建节点 12 ⇒ 写入成功 `172.33.10.27`）；对**已存在**节点再 provision 时该字段**被忽略**（返回 `connect_ip: null`）；全仓**没有**节点更新端点（`nodesRoutes` 无 patch/put），reconciler/state 也**不从上报里学地址**。后果：**provision 时没填地址的节点永远不能当 RELAY 跳**（创建报 `502 invariant_violated: RELAY plan needs a <host>:<port> next_hop`）。
   **按用户规则对照 ForwardX**：它把"可拨号地址"放在**成员级** —— `drizzle/schema.ts:441` 的 `forward_group_members.connectHost`（成员自带连接地址）。⇒ **它的逻辑是"地址在成员/绑定层可设可改"**，而不是"只在节点创建那一刻定死"。**这正是应当复用的形态**（下一步切片：允许在绑定/成员层或节点更新端点设置可拨号地址，并让面板能从上报里学地址）。

### 环境还原
删两个测试 agent 容器 + 4 条涉及测试节点的绑定 + 节点 11/12 的全部子行 + 节点与组 ⇒ **本空间节点数 4、额度 4、转发总数 4、`tunex-it-*` 8 个完好**。

## 3.53 R6 终局评审 §12：**要件① 改判"支撑"** + 一条反观察 + #10 三级门槛

**要件 ① = 支撑（升级）**：评审按它 §11.4 **预先写死**的条件（"worker stdout / BullMQ 记录 / 不清理重跑，任一件到手即改判"）执行——本次到手 worker stdout 落盘，它**不留后门**地改判。八条判据：**6 支撑**、1 部分支撑（事实为 SQL 直插）、1 不支撑（③ 契约与简报不符，属产品契约而非证据问题）。
**它自核的三件硬核**：① 库身份 `f9fb790dcc1e / 3306 / f4343e5e-… / 8.4.11` 与 owner 两份读数逐字相同；② **绕开统计缓存**（`SHOW CREATE TABLE`）读出真计数器 `workspace 12 / member 12 / tunnel 14 / delivery 25 / channel 15` ⇒ 恰为"本轮分配过 ws 11、tunnel 13、delivery 24"，与其引用 id **一对一吻合**；③ "那一拍不可伪造"——`[worker] cron_notification_facts:` 前缀只由 `worker.ts:242-254` 打印、`ok (…since enqueue)` 来自 `:313` 的 completed 事件，账本 `created_at` 在同拍窗口内（早于完成日志 85ms）、transcript 同秒同源。

**⚠️ 一条它无法解释的反观察（§12.4）**：活库 scratch worker（镜像 `final49-0502`，**三个关键文件 md5 与 HEAD 逐字相同**）在事实窗口内**有一拍落在窗口却没有建出该事实**（beats `21:11:05.4 / **21:11:35.5** / 21:12:05.5` vs 事实存在 `21:11:31.893 → 21:11:58.6`；其全日志 `considered|built|delivered` 命中 0）。已排除代码版本、零提交、时钟、别名/DSN、候选查询与判定。它不动摇①的判定，但提出真实问题。
⇒ **判决实验已派**（`task-45`，`notify-center`）：**让事实在库里停留 ≥90 秒**，看**活库 worker** 是否任一拍打印 `built:1`；**始终不打印 ⇒ 新缺陷（部署 worker 对同库事实不可见）⇒ 评审会重新打开要件①**。两种结局都已写死。

**#10 三级门槛（评审定义，我采纳）**：**未达成** = ①未支撑 或 ①支撑但②未闭合（**当前**）→ **基本达成** = ①支撑 **+ ②闭合**（一条日常宽度差距**真机可验证闭合**）→ **达成** = 上述 + 覆盖面再收一条（LG 3→≥5 / DDNS 2→≥4）。
⇒ **下一目标明确：闭合要件②**。我计划用**已验证的 enroll→online 流程** + `task-37` 的 **stamp 镜像**，让 `version_drift: behind` 在**真机首次出现**（"默认部署永不提示版本落后"这条日常宽度差距当场闭合）。

## 3.54 Round 54（Lead 一手）：**要件 ② 闭合** —— `version_drift: behind` 真机首次出现（含反向验证）

### 实验（最小改动，无需重建镜像）
现有 4 台 agent 跑的是**旧镜像**（源码常量 `0.13.22`），因此只需**给面板配基线**即可制造"落后"：
1. 在 scratch compose 的 `panel`/`worker` env 加 `TUNEX_AGENT_LATEST_VERSION: "0.14.0"` → `docker compose up -d --no-deps panel worker`（**不重建镜像**），面板 healthy；
2. 真机 HTTP `GET /api/nodes/1/upgrade-state`：
```
reported: { version: "0.13.22", role:"INGRESS", reported_at:"2026-10-06T21:41:49.717Z", age_seconds:57 }
target:   { image:"ghcr.io/paimoncai/tunex-agent:latest", image_source:"builtin_default",
            expected_version:"0.14.0", version_drift:"behind" }        ← ★★ 真机首次出现
precondition: { ok:false, code:"node_not_in_maintenance",
                message:"升级前请先把节点置为 maintenance（避免在调度窗口内替换 Agent）；确认可以带业务升级时传 allow_active=true" }
```
3. **反向验证（因果证明）**：把基线从 compose 移除并重启面板 ⇒ **同一节点、同一上报版本**：
```
target: { expected_version: null, version_drift: "unknown" }            ← 回到「无法判定」，**不是**「已最新」
```
⇒ 因果链成立：**是基线把判定翻成 `behind`**，移除后如实回到 `unknown`（**没有把"未声明"说成"已最新"**，符合措辞纪律）。

### 这条为什么正好闭合评审的要件 ②
回顾 R5-A/R6 的表述：**"默认部署永不提示版本落后"**（`TUNEX_AGENT_LATEST_VERSION` 缺省 `""` → `version_drift` 永为 `unknown`；`install.sh --version <sha>` 又会写进不可比较的 git sha）。本周期完成的三段修复链：
1. **task-26**：语义判定为「Agent 版本号」，`install.sh` 新增 `--agent-version`（**fail-closed**：sha/`latest`/`unknown` ⇒ exit 2），`--version` 的 sha 不再入该槽位，服务侧复用同一个比较函数；
2. **task-37**：Agent 镜像 **stamp 版本**（`ARG AGENT_VERSION`，默认 `unknown`、空值构建失败，前导 `v` 去掉）；
3. **本轮**：真机 `behind` 出现 + 反向验证。
⇒ 「一条日常宽度差距在真机可验证地闭合」**成立**。按评审定义的三级门槛：**① 支撑 + ② 闭合 ⇒ #10 应为「基本达成」**（已提请评审复核改判）。

### 环境还原
compose 里的基线已移除、panel/worker 已重启（`TUNEX_AGENT_LATEST_VERSION` 未设置）；未新增节点/容器；`tunex-it-*` 8 个完好。

## 3.55 `task-42` 交付：Looking Glass 方法集 **3 → 5**（复用 ForwardX 的 traceroute 能力，无特权实现）
- **agent 侧**（真机、生产 caps、**走 agent 自己的代码路径**）：`capabilities` 出现 `looking_glass:traceroute|traceroute6`；`traceroute 1.1.1.1` **真出跳**（`172.17.0.1 → 172.17.0.1 → 103.185.248.1 (7ms)`）；`traceroute6` 如实 `error: send failed`（本节点无 v6 出网路径）；`ping` reachable；**私网目标发包前拒绝**；`mtr` 拒绝（不在闭集）。镜像 `15,003,286 → 15,634,726`（**+4.2%，就是 iputils**）。
- **★ 靠测量发现并修掉的真缺陷**：首次真机 traceroute **一跳都没有** —— 不是 tracepath 不行，而是 **tracepath 在管道里块缓冲，被 context kill 时未 flush 的输出整段丢失**。修法：**跳数上限 ≈ 时间预算 ×70% + flush 余量**（5000ms ⇒ 3 跳），随后立刻拿到真实跳（教训写进注释，否则后人会误判 tracepath 不稳）。
- **面板**：闭集 **3→5**；`unavailable_methods` **只剩 `mtr`/`mtr6`**（无二进制 + 默认需 raw socket）；`caveats` 改写为 **8 条真实边界**（并去掉 Markdown 标记）；**`method_unavailable_on_node` 已实现**（节点没上报该方法 ⇒ **409 且零指令下发**，含反向验证）。
- **Web**：`caps.methods` / `unavailable_methods` **已消费并渲染**（en 用本地化通用原因以免混中文）；本地 caveats 文案 4→8 跟上服务端。
- **门禁**：Go 13 包 0 FAIL；backend `tsc` 0 + **2969 pass / 0 fail**；web `tsc` 0 + **1354 pass / 0 fail**。
- **未完成（明列）**：① 面板 HTTP 侧真机 `/api/looking-glass/status` 响应与**审计行**未取证（只验了 agent 侧）；② **Web 不渲染 `hops`**（后端已下发逐跳，UI 只显示 status/detail）；③ `MaxTimeoutMS` 仍 5000 ⇒ 路径跟踪最多 3 跳（放宽属 caps 语义变更，未擅自动）。

## 3.56 Round 55：**面板 HTTP 侧 LG 证据**（"达成"所需的那一件）+ 一个**结构性缺陷防护** + #10 改判

### A. `task-42` 欠的"面板 HTTP 侧证据"——本轮补齐
重建面板到 **`final55b-0551`**（含 task-42 的 5 方法 + 节点级能力拒绝）后，真机：
```
GET /api/looking-glass/status → 200
  caps.methods = ["tcp_connect","ping","ping6","traceroute","traceroute6"]      ← ★ 5 种（原 3）
  caps.unavailable_methods = [{mtr:"镜像里没有 mtr 二进制；且 mtr 默认需要 raw socket（CAP_NET_RAW），
                               生产 caps 下不可用 —— 所以我们不做它，而不是假装支持"}, {mtr6: 同}]
  enabled=false, platform_admin_override=true

POST /api/looking-glass/nodes/1/tests  method=traceroute  → 409 method_unavailable_on_node
  "该节点没有上报方法 traceroute 的执行能力（未上报 looking_glass:traceroute）：不向做不到的节点下发
   注定失败的指令。可能原因：节点镜像里没有对应二进制，或内核不允许非特权 ICMP。"
POST /api/looking-glass/nodes/1/tests  method=tcp_connect → 200（真实报告：requested/pinned/entry.enabled=false,admin_override=true）
```
**审计行（真机库 `audit_log`）**：
```
6525  POST /api/looking-glass/nodes/:id/tests  200  2026-10-06 21:56:06.169   ← 真实发起
6523  POST /api/looking-glass/nodes/:id/tests  409  2026-10-06 21:56:05.075   ← 节点级拒绝
（LG 审计共 24 行；评审 §13 读到的是 20 行，本轮 +4 均为本次运行的 400/409/200）
```
⇒ 评审 §13 说的"**代码到位、部署未到位**"现在**两边都到位**：运行中的面板确实回 5 种方法、且**发起与拒绝都留审计**。**"达成"只差覆盖面这一条的判定**（已请评审独立复核 `/status` 与 `audit_log`）。

### B. 一个**结构性缺陷**：新建文件 0600 让面板起不来（第 4 次同类）
重建面板时**直接起不来**：`bun error: EACCES reading "/app/src/services/node-install.ts"` —— 容器内以 `bun` 用户运行，而宿主机上新建的源文件是 **0600**（`node-install.ts` 与 `node-install.test.ts`，另有 task-44 的 `panel_migration.go`/`_test.go`）。全仓扫描发现 **4 个** 0600 源文件，已全部修正为 644。
**为什么这次不"提醒一句了事"**：这类问题已咬 4 次（迁移文件 0600、新源文件 0600…），靠"记得 chmod"不可靠。已在 `backend/Dockerfile` 加**结构性防护**：
```
COPY src ./src
# 镜像内以 bun 用户运行，而宿主新建源文件可能是 0600 ⇒ 镜像里兜底放宽读权限，
# 让"主机文件模式"在结构上不可能再把容器打挂。
RUN chmod -R a+rX /app/src /app/prisma
```
⇒ 从此**即使有人提交 0600 文件，面板也不会再起不来**（防护在镜像里，不依赖任何人的记性）。这条同时值得作为**所有镜像的一般做法**（agent 镜像同理）。

### C. 一条**看起来像缺陷、实为旧镜像噪声**的观察（记录以免后人误判）
`audit_log` 里高频出现 **`POST /api/internal/heartbeat` → 404**。查证：**HEAD 里不存在该路由**（`internal-node.ts`/`app.ts` 均无），且 agent 代码注释明确写着"`/api/internal/heartbeat` **Panel 从未实现**、已移除"。⇒ 404 来自**旧镜像 `cafaaba`**（它仍打这条路径），**不是当前缺陷**；它反而印证了"节点需要升级"这件事的真实性（旧 agent 会持续产生 404 噪声）。

## 3.57 Round 56（Lead 一手）：真实节点**完整升级**跑通（退出条件 #7 → 达成）

### 链路（全部真机，脚本来自面板、未手改逻辑）
```
旧状态：容器 tunex-harvest-agent:cafaaba（源码常量 0.13.22）→ upgrade-state: reported 0.13.22 | expected 0.15.0 | version_drift=behind
执行：面板生成的升级脚本（sh 执行）
  tunex-upgrade: 当前镜像: tunex-harvest-agent:cafaaba
  tunex-upgrade: 目标镜像: 127.0.0.1:5050/tunex-agent:0.15.0
  tunex-upgrade: 拉取目标镜像（此时节点仍在正常服务）→ Status: Image is up to date
  tunex-upgrade: 停止旧 Agent（SIGTERM，最多 15 秒完成排空）
  tunex-upgrade: 用目标镜像重建容器（复用 agent.env 与 LKG 目录）
  tunex-upgrade: 身份校验通过（HTTP 200 + Panel JSON 真解析；agent 内置探针，不跟随重定向）：同一个 node_id/agent_id 已重新连上 Panel
  tunex-upgrade: 升级完成：当前运行 127.0.0.1:5050/tunex-agent:0.15.0，节点身份与 Forward 关系未变（身份校验：通过）
新状态：reported.version = 0.15.0 | expected 0.15.0 | version_drift = not_behind；节点 active/online；容器镜像 127.0.0.1:5050/tunex-agent:0.15.0
```
⇒ 同时验证了三件本周期才建成的东西：**镜像 stamp（task-37）**、**真实上报版本驱动的升级判定（task-26）**、**升级脚本里的身份探针（task-29/42）**。

### 顺带撞出的 **P0**（本周期最有价值的一次真实执行）：升级脚本**语法非法**
- 现象：`bash -n` / `dash -n` 双双 **rc=2**、`line 169: syntax error near unexpected token '('` ⇒ **任何节点都无法用生成的命令升级**；更糟的是它在"**已停掉旧容器**"之后才炸，节点会停在**无 agent**（本次实验就是这样）。
- 根因：探针块处于外层 shell 的单引号串里（`PROBE="$(docker exec … sh -c '…')"`），块内又出现 `jq -e 'type=="object" and (.data|type=="object")'` ⇒ **内层单引号提前终结外层引号**，`(.data|…)` 的 `(` 成了未加引号 token。
- 修法：内层单引号按 POSIX 写成 `'\''`（提交 `a1bba56`）；测试侧抽 `unescapeInnerBlock()`（`probeBody`/`identitySection` 两处还原转义，否则测的是**外层文本**而不是被测对象），并新增回归用例：对**渲染结果**跑 `sh -n`/`bash -n`/`dash -n` + 断言非空。
- **为什么此前 49 条用例没拦住**：它们全是**字符串断言**（"脚本里有这一步"），没有一条**解析/执行**渲染结果。另：这次我自己还踩过一次"**对空文件做语法检查**"的假绿，已把非空门槛写进用例。

### 一条**环境事实**（含对先前误判的更正）
宿主路径挂载在本沙箱**不可靠**：我 `stat` 宿主 `/tmp/…/agent.env` 是 **regular file**，而容器内同一路径是 **directory**；连 `alpine` 助手容器也看不到我的 `/tmp` ⇒ **docker daemon 的文件系统视图 ≠ 本沙箱视图**。
- **更正**：Round 56 早期我判断"另一个 DSH 会话把 `/etc/tunex-agent/agent.env` 写回去了"——**该归因是错的**；真因是 daemon 看到的是**它自己那边的** `/etc/tunex-agent/agent.env`。
- **可行做法**（本次采用）：配置走**命名卷**，用 `docker create` + `docker cp` 把 env 文件写进卷（`docker cp` 走 API，不经文件系统视图）。
- 这也解释了 `web-ddns` 早前报的那条"沙箱看不到宿主 `/tmp` 直接路径"——他当时判为"沙箱 artifact"，**判对了**。

## 4. Capability Map## 4. Capability Map

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

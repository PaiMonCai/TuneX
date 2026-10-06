# Round 1 — Agent Onboarding 调查与决策

> 2026-10-06。阶段：Recon；源码调查，不等同真实浏览器/安装验证。调查代理统一使用 `txapi/deepseek-v4.1-flash`。

## UX Auditor（R1-C）— 已收到

### 已有能力
- Backend `src/services/node-enrollment.ts:62-137` 已签发一次性 token 与安装命令；重签撤销未用 token（115-127），消费时轮换长期凭据（185-194）。不得重写。
- 用户 `/api/nodes` 已提供 connection / has_credential / admission 安全投影；`web/src/lib/node-lifecycle.ts:165-186` 已有阶段投影函数。
- 管理端 `web/src/components/admin/node-install-waiting.tsx` 已有等待、轮询、停止/重试；用户 `node-workspace.tsx:453-474` 仍是复制命令后关闭的旧对话框。
- 用户节点管理、enrollment、诊断、支持包、升级命令 API 已存在。

### 主要缺口（静态源码依据）
1. 用户添加节点必须已有节点组，用户 API 客户端没有创建节点组入口；生产默认不灌 demo 数据。创建组还受 entitlement 控制，禁止为了接入 UX 默认放开。
2. 用户安装没有等待/在线确认/成功下一步；管理端有闭环，但也没有创建 Forward CTA。
3. 重签命令缺少旧命令作废与已注册节点重装会轮换凭据的警告；TTL 只有静态说明。
4. 节点组加载失败后创建按钮禁用，无明确恢复；部分字段与统计硬编码中文。
5. 升级与诊断仅 selectedIngress 可达，镜像需手填，健康建议无动作；先记债务，避免首轮扩大范围。

### Leader 复核与修正
- 已直接阅读用户对话框（`web/src/components/nodes/node-workspace.tsx:453-474`）、管理员组件（`web/src/components/admin/node-install-waiting.tsx:108-153`）、用户 API（`web/src/lib/api/nodes.ts:117-144`）、Backend 用户路由（`backend/src/routes/nodes.ts:176-195`），确认基础能力与用户闭环缺口。
- **不能仅放宽 view 类型后直接复用管理员组件**：组件生成与轮询硬编码 `api.admin.createNodeEnrollment` / `api.admin.nodeLifecycle`。用户侧必须注入用户域数据源，或先提取共享展示/等待逻辑；不得令用户流程调用 admin-only API。
- 在线只能消费服务端 connection；online 不等于 health passed，也不保证 admission 可接新业务。没有健康证据不能显示“健康检查通过”，没有 forward:create 权限不能提供可操作创建按钮。
- 首个切片只承诺已有可用节点组的用户闭环；无组时提供真实、权限感知的前置条件说明，不把不存在的申请入口伪装为可用功能。
- 代理建议的自动生成名称/隐藏角色/自助建组需另行评估，当前不批准：不能默认改变角色或绕过 entitlement。
- 源码扫描/SSR 不能独立保护异步轮询与跨 Workspace 竞态；实现验收需包含受控异步行为测试。

## TuneX Capability Auditor（R1-A）— 已收到

- 安装命令唯一来源 `backend/src/services/node-enrollment.ts:62-86`；TTL/撤销/哈希/事务内单次抢占已有。installer 先拉镜像再消费令牌、宿主凭据 0600、容器只读挂载，不改协议或脚本。
- 用户数据源为 GET `/api/nodes`，没有单节点读端点；10s 列表轮询是本轮最小复用方案。只消费服务端 connection，不自行计算心跳窗口。
- 用户卡片 `node.version` 是管理配置字段，不是实际 `node_state_report.version`；本切片不冒称已检测 Agent 版本。
- 升级已具备 maintenance 前置、优雅排空、保持身份和失败回退。`TUNEX_PUBLIC_PANEL_URL` 配置不可发现；**已在 D2 中证实更严重**：标准 Agent 镜像没有 `curl`，且 `docker exec` 拿不到 entrypoint 现场 source 的凭据（发空 Bearer → 健康升级会被误判 401 并回退），curl 缺失时旧脚本还会先打印「未能完成身份校验」再打印「升级完成」。D2 已修（容器内 source 取凭据 + `wget` 回落 + 只有 200 才算通过 + 未校验明确标注），详见 [productization-status.md](./productization-status.md)。
- enrollment consume 的单次消费有真实 topology replay 401 覆盖，但没有便宜的直接单元测试；不能将 3 个脚本静态测试说成 enrollment 事务已验证。
- Leader 校正：R1-A 的“唯一真正产品缺口”措辞过窄，R1-C 已证实无节点组前置、失败恢复与安全确认同样需记录；First-run 缺 UI 不能推导必须新后端。

## ForwardX Product Researcher（R1-B）— 已收到

- 参考入口为主机管理 → Token 管理 → 添加主机，备注可选；列表状态、空态管理员分流、地址回环警告让用户知道下一步。
- 借鉴行为：有效期/后果可见，等待与失败可恢复，成功下一步，升级当前/目标版本与失败恢复。文案与实现均自行设计。
- 拒绝：明文长期 token/可重用模型、前端拼安装命令、远程升级波次。保留 TuneX 的一次性哈希 enrollment、Backend 命令渲染、操作者在节点执行升级与服务端状态投影。
- 参考许可证：AGPL-3.0-only（参考 package.json 声明及 LICENSE）；不复制 TS/Go/Shell/组件实现，不提交参考副本。
- 本轮 DEFER：客户端覆盖面板地址、改安装脚本自检/错误输出、registry 预检、升级等待状态。均需独立契约/范围评估。
- Leader 校正：没有安装凭据也能等待，但命令过期不意味着 Agent 离线；若已 online/已消费并离线，不能把原命令过期说成安装失败。不能把统一 invalid_enrollment 401 区分成已过期与已使用两个确定结论。

## Capability Map

| Capability | TuneX Backend | TuneX Web | ForwardX | Gap | Action |
|---|---|---|---|---|---|
| 创建节点 + 一次性安装命令 | 已有 provision/enrollment/install.sh | user/admin 均有 | Token + 备注生成命令 | 不缺后端；用户无安全重签解释 | REUSE |
| 等待/在线闭环 | /nodes 安全投影已存在 | admin 有；user 缺 | 列表轮询 + 服务端徽章 | 用户复制后无下文 | INTEGRATE |
| 超时/重试/停止 | 无需新状态 | admin 已有 | 失败与下一步明确 | 用户缺异步恢复；共享实现需并发保护 | IMPROVE |
| 命令 TTL/重签后果 | expires_at/撤销语义已有 | 有静态 TTL 文案，无实际过期恢复 | 无过期，但后果与状态明确 | 短期命令过期应解释，不猜已消费 | EXPOSE |
| 成功下一步 | Forward 创建已有 | /forwards?ingress_node_id 已消费 | 主机列表可见 | 缺权限/准入感知 CTA | EXPOSE |
| 无节点组前置条件 | 建组已有且 entitlement 门控 | 用户空选择死路 | 空态按角色指引 | 用户需真实说明及加载重试 | IMPROVE |
| Agent 真实版本/健康 | state report / health / diagnostics 已有 | admin 有，用户安装未接 | 版本与状态可见 | online 不代表 health passed | DEFER |
| 升级 UI + 完成观察 | 脚本/回退/条件已有 | 诊断面板可生成，缺整合 | 当前/目标、等待/恢复 | 另做完整升级切片 | DEFER |
| 面板地址选择/校验 | SITE_URL 已渲染 | 无告警 | 当前/公开地址与回环告警 | 先定义安全 contract | DEFER |
| 远程自升级/长期明文 Token | 不符合 TuneX 边界 | 不需要 | 有实现 | 架构/安全不匹配 | REJECT |

## 首个 Vertical Slice — 用户端节点接入等待与恢复（批准实施）

### 用户价值与范围

已有可见节点组的 node:manage 用户：创建节点 → 保留原 enrollment → 复制安装命令 → 页面持续轮询 `/nodes` → online → 按 role/admission/forward:create 显示真实下一步。关命令对话框不重签、不终止页面级等待；切换 Workspace/权限或节点时丢弃旧响应并清除敏感命令。

无组的用户：明确前置条件、联系管理员/有权限的管理入口，禁用无效提交；不自动建组、不解除套餐策略、不提供不存在的申请链接。加载失败有重试。

失败恢复：waiting / installed_offline / unknown 区分；等待超时保留命令并允许继续；命令过期解释与显式重签（旧命令立即作废）。已注册节点须确认重装会在消费时轮换长期凭据，不自动重签。无健康/版本证据不编造勾选成功项。

### 并行实现边界与共享契约

- I1-A（共享等待组件/集成）：只写 `web/src/components/admin/node-install-waiting.tsx`、`web/src/lib/node-lifecycle-i18n.ts`、新增 `web/src/lib/node-install-polling.ts` 与其专属测试。为组件提供类型安全的泛型/重载最小 view；可注入 `loadView(nodeId)`、`createEnrollment(nodeId)`，默认仍走 admin API；`onViewChange` 保持调用方具体类型。现有 props 保留，新增 `successAction?: ReactNode`、`regenerateConfirm?: string`。保留 10s/30min 节奏。新增异步轮询测试覆盖 online 停止、timeout、失败恢复、single-flight、dispose 丢弃晚到响应；不得编辑用户组件/字典/状态文档。
- I1-B（用户体验接线）：只写 `web/src/components/nodes/node-workspace.tsx`、`web/src/lib/i18n/dictionaries.ts`、新增用户 onboarding 展示/适配 helper（如必要）及 `web/src/components/nodes/__tests__/add-node-onboarding.test.tsx`。基于上述 props 传用户 loadView/createEnrollment；全程 Workspace 与权限隔离；删除旧命令 dialog/copy 重复逻辑；无组/组加载失败恢复、名称与角色原契约保持，补中英文与安全确认。不得编辑共享组件/轮询库/生命周期字典/Backend。
- I1-C（独立审查）：依赖 I1-A/B 完成；只读检查 diff、异步竞态、用户不调 admin API、角色/权限/准入/敏感令牌、安全重签与实际测试证据；发现问题先报告给 Leader。
- Leader：独占本文件和状态文件，复核最终 diff 与行为测试，运行 typecheck、全量 Web tests、build。必要修正先等实现完成，避免写冲突。

### 明确不做

不修改 Backend、Agent、schema、迁移、CI；不自动生成名称或隐藏/改默认角色；不做自助建组、升级 backend、面板地址覆盖；不宣称 1–2 分钟真实接入目标已验证。

### 验收

- 创建已有节点组节点不额外 enrollment 重签；用户适配不会调用 admin API。
- waiting→offline/online 只消费服务端投影；online 停止，超时/错误可恢复，关 dialog 后等待持续。
- 不重叠轮询；unmount/节点/Workspace/权限切换丢弃旧响应及命令，不泄漏跨 Workspace 状态。
- 过期提示不误报已在线或已安装离线节点失败；重签必须显式且后果明确。
- 成功 CTA 仅在 ingress/both、admission=true、forward:create 有效时可用；egress 提供正确说明，不指向不可创建的入口。
- 全量既有 Web tests/typecheck/build 通过，新增异步行为与展示测试保护关键路径；真实浏览器与 Agent 接入仍需单独验证并如实记录。

## 验证边界

已完成 Web typecheck + 574 既有测试、Backend 重生成 Prisma 后 typecheck、3 个 installer 既有测试；未完成真实 UI/安装/Agent E2E，Redis 连接告警已记录状态文件。

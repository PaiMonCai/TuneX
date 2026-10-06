# First-run / 首条 Direct Forward — R2 预研收束

> 三路 Flash/high 只读预研完成；Leader 对冲突项另读代码复核。I1 未验收前不派发 R2 编码。仅研究产品行为，未复制参考实现，不新增 setup 状态或后端状态机。

## 1. 关键事实与前轮修正

- 默认免费策略 **允许**自建入口/出口组：`backend/prisma/migrations/20260924170000_capability_policy/migration.sql:75-81`。`capability-policy.ts` 的 EMPTY_ENTITLEMENT=false 是没有有效策略时的安全空值，不是默认已发放策略。前轮“默认不允许自建”的假设错误，现明确纠正。
- `POST /api/node-groups` 已有且 Workspace scoped，`node:manage` + 有效 entitlement 由后端裁决；`GET /api/me/capabilities` 已有。Web 缺 create 客户端、能力读取与自助入口。应 EXPOSE，而不是另建后台、放宽策略或自动建组。
- admin 建组落管理员个人空间，不是所选团队空间；用户 Forward 强制当前 Workspace 的节点归属。不能引导管理员在 admin console 给任意空间供组。
- 建组需要显式合法 `port_range` 才能后续 provision；API schema 允许省略，但 provision 失败分支可能500，而mock为409。最小用户表单必须采集区间；后端错误码债单独记录。
- 新个人空间免费额度为1节点/2转发；团队2节点/10转发，具体运行态必须读有效策略。禁止为了接入放宽额度、entitlement、权限或注册开关。
- Workspace 注册/seed时已自动创建，不能把重复建空间做成强制步骤。生产初始化管理员由env/seed与保护凭据文件产生，现有部署契约不是浏览器连库setup。
- 用户线路页只读，无 route→Forward 创建契约；首条Direct Forward不依赖RouteProfile，不给假入口。
- 首条Direct只需入口节点、名称、目标host/port，tcp默认；服务端role/admission/connection/forward:create才决定可操作性。online≠healthy/版本正确。

## 2. 调查冲突的 Leader 裁定

1. **自助组策略**：R2-A/C与迁移、用户路由相符；采用“默认允许，实时有效策略才是真相”。不继续传播R1默认禁止的结论。
2. **ingress query 是否预填**：`forward-workspace.tsx:282-285`设ingressFilter；`:364-370`的openCreate查找filteredIngress并交给emptyForwardCreateDraft，因此已有预选，R2-A“仅筛选不预填”不成立。R2无需再写一套预填。
3. **First-run参照范围**：ForwardX的setup仅数据库/迁移/admin；登录后Agent→线路→Forward向导并不存在，相关链条靠文档+空态。harvest六步形状属于TuneX自身产品决策，只吸收门控、三态、persona、真实前置与可恢复机制。
4. **概念压缩**：不能以“无需理解组”为理由偷偷生成组名/改角色。可以给最小表单和人话，但名称、方向/端口范围及真实归属必须明确。
5. **回看与隐藏**：不需要持久化setup_complete，也不需要以localStorage记录“已完成”真相；所有进度读时派生，事实不可得就unknown/degraded。

## 3. Capability Map

| Capability | Existing TuneX | Gap | Action |
|---|---|---|---|
| 初始管理员/部署 | env+seed+受保护管理员凭据 | 无浏览器setup，属于既定部署契约 | REUSE / 不另造入口 |
| 个人Workspace | 注册/seed事务自动创建 | 向导强制再建没有价值 | REUSE |
| 权限/角色 | workspaces permissions + request fence | 首屏/空态persona未清楚解释 | EXPOSE / IMPROVE |
| 自助入口组 | Workspace POST，entitlement锁内裁决 | 客户端/UI缺，现“联系管理员”不能走通 | EXPOSE |
| 有效能力/配额 | GET me/capabilities | Web未消费，不能直渲内部policy字段 | EXPOSE安全显示子集 |
| 首台节点等待 | I1共享轮询+用户适配进行最终审查 | 还需异步/浏览器验收，不能重写 | INTEGRATE I1 |
| 首条Direct | 现有dialog/API、query筛选和预选 | 无入口时无可执行上游链接 | IMPROVE |
| 首页下一步 | stats.visibility + attention三态 | 计费关闭时首装没有CTA；attention只异常不代表接入完成 | INTEGRATE派生提示 |
| route→Forward | 用户契约不存在 | 首条Direct不需要 | DEFER，不给假CTA |
| setup状态机/数据库配置 | 无需且与部署契约不同 | 会产生第二套真相 | REJECT |

## 4. 拟议下一最小完整切片（尚未派发）

**目标：无组的新Workspace在用户域能自己走到I1安装等待，再进入现有Direct Forward创建。**

- api.nodeGroups.create只包装既有用户端点；api.me.capabilities只取有效事实并在界面使用权限/entitlement/limits的明确子集，不展示内部policy key/ceiling/whitelist等。
- 自助组最小表单：用户显式名称、入口方向、合法端口范围；不自动命名、不默默改角色、响应token不进UI/状态/日志/SSR序列化。
- 所有动作使用当前Workspace、权限epoch和请求ticket；切空间、权限变化、A→B→A、late success/error/finally均要保护。
- 无entitlement或node:manage时说明真实原因，不给必失败按钮；请求失败=可重试degraded，后端403保留其原因与code，不能前端当允许即保证成功。
- `/nodes`真正的无组入口接到组创建成功后refetch，再沿用既有provision与保留enrollment流程。
- `/dashboard`首启提示纯读时派生，不把计数/online当healthy，不加强制全站setup gate；member/viewer给真实可执行或联系人指导，不默认给Admin链接。
- `/forwards`缺入口给实际`/nodes`链接；保留已有ingress query预选。不得把有任意转发当健康验证通过。
- 不新增Backend/schema/CI、不放配额，不做Route Builder/relay/multihop/admin跨Workspace建组。

## 5. 后续独立债务

- persona：Topbar Admin入口当前无条件展示；普通账号可能403→裸Next错误页。平台admin角色列表不只super_admin，必须读现有/auth/permissions并按真实权限处理，不能隐藏合法delegated admin。
- admin safe吞403显示“暂无数据”；受控错误/恢复页与权限原因需要独立小切片。
- 默认1节点限制、无自托管管理员策略发放UI；不得在first-run顺手改库或绕过能力服务。
- landing残留/tunnels概念、dashboard死词条、attention向admin组件导入轮询常量：后续清理，不改变底层判据。
- group无port_range后provision错误码与mock分叉；需要真实API确认与针对性测试后另定契约小修。

## 6. 证据与限制

R2三份调查均无写入/git/build/部署。R2-A额外跑attention定向20 pass，仅是mock/SSR守卫。所有产品路径计数为源码估计，不是浏览器计时。Leader正在用既有Integration topology做真库/Agent验证，结果另记状态文件；不把研究报告视为运行态通过。

后续验收：有效capability子集解析/缺失failclosed，node:manage×entitlement×quota×persona，合法区间与后端403，group token不渲染，scope/epoch late response，三态/重试，组→节点→online→Direct的实际用户路径，typecheck/fulltests/build及真实浏览器证据。

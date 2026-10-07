import type {
  DiagnoseReport,
  NodeDiagnosticsReport,
  NodeUpgradeCommand,
  AdminDashboardStats,
  AdminListInput,
  AdminResourceMeta,
  AdminRole,
  AdminRoleInput,
  AdminUserInput,
  AttentionPayload,
  AuditLog,
  AuditLogQuery,
  AuthSession,
  BalanceLog,
  DashboardStats,
  EgressPool,
  EgressPoolInput,
  EgressTarget,
  EgressTargetInput,
  FederationDisableResult,
  FederationEnableResult,
  FederationGrant,
  FederationGrantActionResult,
  FederationGrantCreateResult,
  FederationGrantInput,
  FederationHandshakeInput,
  FederationHandshakeResult,
  FederationInvitation,
  FederationInviteInput,
  FederationKeyRotateResult,
  FederationLease,
  FederationPeer,
  FederationPeerRevokeResult,
  FederationPeerRotateResult,
  FederationPingResult,
  FederationPlacement,
  FederationStatus,
  FederationUsageRecord,
  ID,
  LicenseInfo,
  ListQuery,
  LBStrategy,
  Node,
  NodeCredentialIssued,
  NodeCredentialRevoked,
  NodeEnrollmentIssued,
  NodeBinding,
  NodeDetail,
  NodeGroup,
  NodeGroupInput,
  NodeHealthList,
  NodeHealthSummary,
  NodeHealthValue,
  NodeHealthView,
  NodeImpactResult,
  NodeInput,
  NodeLifecycleChangeResult,
  NodeLifecycleValue,
  NodeLifecycleView,
  NodeRole,
  ConsumableRouteProfileList,
  Paginated,
  PasswordChangeInput,
  RouteProfileApplyInput,
  RouteProfileApplyResult,
  RouteProfileCreateInput,
  RouteProfileDetail,
  RouteProfileImpact,
  RouteProfilePatchInput,
  RouteProfilePublishInput,
  RouteProfilePublishResult,
  RouteProfileVersionBody,
  RouteProfileVersionEntry,
  RouteProfileView,
  PortForward,
  ForwardCreateInput,
  ForwardPatchInput,
  ForwardPreviewResult,
  ForwardListQuery,
  ForwardBatchInput,
  ForwardBatchResult,
  ForwardSummary,
  ProvisionNodeResult,
  Payment,
  Plan,
  PlanInput,
  PlanOrder,
  ProfileUpdateInput,
  SystemConfigItem,
  Ticket,
  TopupOrder,
  TrafficPoint,
  Tunnel,
  TunnelUpdateInput,
  User,
  UserNode,
  Workspace,
  WorkspaceAcceptInviteResult,
  WorkspaceCreateInput,
  WorkspaceInvite,
  WorkspaceInviteInput,
  WorkspaceMember,
  WorkspaceTrafficSummary,
} from "../types";
import { normalizeHealthSummary } from "../node-health";
// 运行态读数（状态端点）的线上形状：三态判定在 node-runtime-state.ts。
import type { NodeStatePayload } from "../node-runtime-state";
// 公告类型单独维护在 announcements.ts。
import type { Announcement } from "../announcements";
// 目标健康状态与理由码在 target-health.ts 维护。
import type { TargetPoolHealth } from "../target-health";
import { shouldRedirectToLogin } from "../workspace-permissions";
import type { EffectiveWorkspacePermissions, WorkspaceCustomRole, WorkspaceCustomRoleInput, WorkspaceMemberRoleInput } from "../workspace-permissions";

import { request, get, post, put, patch, del, applyMockSessionCookie, clearMockSessionCookie } from "./core";

/**
 * `/api/admin/node/:id/detail` 的**线上形状**（后端 `NodeDetail` 聚合，嵌套）。
 *
 * 只声明界面会用到的部分：`node` 是节点行本身（可能带若干界面不展示的列，
 * 结构上按 `Node` 处理）、`role` 是服务端派生值（`null` = 尚未声明角色）、
 * `pools` 是该节点的出口池数组、另外两个是计数。
 *
 * `credential` 字段**刻意不取**：它是凭据元数据视图，界面对凭据的展示
 * （是否已签发 / 轮换时间 / 是否被撤销）在 `node` 行自身就有显式列，
 * 取整个 `credential` 只会把凭据材料带进前端状态。
 */
interface AdminNodeDetailPayload {
  node?: Node | null;
  role?: NodeRole | null;
  pools?: EgressPool[] | null;
  pool_count?: number;
  tunnel_count?: number;
}

/**
 * 线上嵌套形状 → 界面扁平模型（`NodeDetail extends Node`）。
 *
 * 投影规则只有三条，且都不发明事实：
 *   1. `node` 的字段原样铺开；`node` 缺失时按空对象处理（调用方据 `id` 判空）；
 *   2. `role` 优先取顶层（服务端派生），缺失才回落到节点行自己的 `role`；
 *      `null` 是**真实取值**（尚未声明角色），不允许被填成默认角色；
 *   3. `pools` 非数组一律归 `[]`（后端保证是数组；这里只防坏载荷）。
 *
 * **不返回 `state`**：运行态由 `/admin/node/:id/state` 单独提供，聚合里没有它。
 * 若这里补一个 `state: null`，消费方会把它读成"该节点没有上报"——那正是本切片
 * 之前被禁的"把取不到说成没有"。
 */
export function projectNodeDetail(payload: AdminNodeDetailPayload | null | undefined): NodeDetail {
  const node = (payload?.node ?? {}) as Node;
  return {
    ...node,
    role: payload?.role ?? node.role ?? null,
    pools: Array.isArray(payload?.pools) ? payload.pools : [],
  };
}

export const adminApi = {
    stats: (cookie?: string) => get<AdminDashboardStats>("/admin/stats", undefined, cookie),
    users: (query?: ListQuery, cookie?: string) => get<Paginated<User>>("/admin/users", query, cookie),
    createUser: (input: AdminUserInput, cookie?: string) => post<User>("/admin/users", input, cookie),
    updateUser: (id: number, input: Partial<AdminUserInput>, cookie?: string) =>
      patch<User>(`/admin/users/${id}`, input, cookie),
    removeUser: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/users/${id}`, cookie),
    /**
     * 平台公告管理；授权由后端 RBAC 判定，前端直接展示后端失败原因。
     */
    announcements: {
      list: (cookie?: string) => get<Announcement[]>("/admin/announcements", undefined, cookie),
      create: (input: { type: string; title: string; body: string }, cookie?: string) =>
        post<Announcement>("/admin/announcements", input, cookie),
      revoke: (id: ID, cookie?: string) =>
        post<Announcement>(`/admin/announcements/${id}/revoke`, {}, cookie),
    },
    nodes: (query?: ListQuery, cookie?: string) => get<Paginated<Node>>("/admin/nodes", query, cookie),
    createNode: (input: NodeInput, cookie?: string) => post<Node>("/admin/nodes", input, cookie),
    updateNode: (id: number, input: Partial<NodeInput>, cookie?: string) =>
      patch<Node>(`/admin/nodes/${id}`, input, cookie),
    removeNode: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/nodes/${id}`, cookie),
    /**
     * 节点凭据端点：`/node/:id/credential[/rotate|/revoke]`。
     *
     * 三条端点都只接受节点主键（数字）或字符串 node_id 作 :id。
     * 其中 issue 已在上面那段注释之外额外多一条约束：**已持有有效凭据的节点
     * 只能 rotate**（issue 对有效凭据返回 409），否则误点两次「签发」会让
     * 线上 Agent 静默失联；revoke 保留哈希仅置 revoked 位；想彻底换钥匙只有
     * rotate 一条路（它覆盖哈希列）。
     *
     * 轮换/撤销是敏感写操作，后端挂了 60s/5 次的 user 维度限流
     * （`node-credential-rotation`），连续点击会被 429 挡回。
     */
    /** 生成/重新生成短时一键安装命令（会撤销尚未使用的旧 enrollment）。 */
    createNodeEnrollment: (id: ID, cookie?: string) =>
      post<NodeEnrollmentIssued>(`/admin/node/${id}/enrollment`, {}, cookie),
    /** 签发凭据（明文只此一次可见）。已有有效凭据 → 409 */
    issueNodeCredential: (id: ID, cookie?: string) =>
      post<NodeCredentialIssued>(`/admin/node/${id}/credential`, {}, cookie),
    /** 轮换凭据：覆盖哈希列，旧明文立即失效；从未签发 → 404 */
    rotateNodeCredential: (id: ID, cookie?: string) =>
      post<NodeCredentialIssued>(`/admin/node/${id}/credential/rotate`, {}, cookie),
    /** 撤销凭据：保留哈希 + 置 revoked 位，重连一律拒绝 */
    revokeNodeCredential: (id: ID, cookie?: string) =>
      post<NodeCredentialRevoked>(`/admin/node/${id}/credential/revoke`, {}, cookie),
    /**
     * 节点详情聚合（基础信息 + 服务端派生的 role + 凭据状态 + 出口池 + 计数）。
     *
     * 路径是后端的**真实**路径 `/admin/node/:id/detail`（单数 `node`，见
     * `backend/src/routes/node-admin.ts` 的 `nodeAdminRoutes.get("/node/:id/detail")`）。
     * 复数 `/admin/nodes/:id` 在真实后端**不存在** → 生产必然 404，详情页第一个请求
     * 就会失败（mock 实现了复数路径把它盖住，是本文件被反复踩的同一族缺陷）。
     *
     * 线上形状是**嵌套**的 `{node, role, credential, pools, pool_count, tunnel_count}`，
     * 而界面用的是扁平模型（`NodeDetail extends Node`），因此这里做一次**投影**而不是
     * 让每个消费方各自解析：`node` 的字段原样铺开，`role` 优先取顶层（服务端派生值，
     * 可能是 `null` = 尚未声明），`pools` 只取数组。
     *
     * **`state` 不在这个端点里**：运行态已拆成独立端点 `/admin/node/:id/state`，由
     * `loadNodeState` 单独取（它能区分"取不到"与"没有上报"，聚合里的 `state` 不能）。
     * 所以这里**不**给出 `state`，避免消费方把它读成"没有上报"。
     */
    nodeDetail: async (id: ID, cookie?: string): Promise<NodeDetail> => {
      const payload = await get<AdminNodeDetailPayload>(
        `/admin/node/${id}/detail`,
        undefined,
        cookie,
      );
      return projectNodeDetail(payload);
    },
    /**
     * 出口池 / 出口目标 CRUD。
     *
     * 路径全部是后端的真实单数路径（`/node/...`）：池与目标都是**全局寻址**
     * （`/node/pools/:poolId`、`/node/targets/:targetId`），只有"在某个节点下新建池"
     * 才需要 nodeId。复数 `/admin/nodes/...` 在真实后端不存在。
     *
     * 列表沿用后端的两层信封 `{data:{data,total}}`，这里解到最后一层返回数组，
     * 让调用方（`NodeEgressPoolsPanel`）拿到它声明的 `EgressPool[]`。
     *
     * 不变式由后端保证、前端必须如实展示的两条：
     *   1. 池内至少一个 active 且 weight>0 的目标（删到空 = 拒绝，属于服务层
     *      而非 DB 约束）；
     *   2. 目标修改只更新快照，不重建 ingress listener（热更新）。
     */
    pools: async (nodeId: ID, cookie?: string): Promise<EgressPool[]> => {
      const page = await get<{ data?: EgressPool[] }>(`/admin/node/${nodeId}/pools`, undefined, cookie);
      return Array.isArray(page?.data) ? page.data : [];
    },
    createPool: (nodeId: ID, input: EgressPoolInput, cookie?: string) =>
      post<EgressPool>(`/admin/node/${nodeId}/pools`, input, cookie),
    updatePool: (poolId: ID, input: Partial<EgressPoolInput>, cookie?: string) =>
      patch<EgressPool>(`/admin/node/pools/${poolId}`, input, cookie),
    removePool: (poolId: ID, cookie?: string) =>
      del<{ ok: boolean }>(`/admin/node/pools/${poolId}`, cookie),
    createTarget: (poolId: ID, input: EgressTargetInput, cookie?: string) =>
      post<EgressTarget>(`/admin/node/pools/${poolId}/targets`, input, cookie),
    updateTarget: (targetId: ID, input: Partial<EgressTargetInput>, cookie?: string) =>
      patch<EgressTarget>(`/admin/node/targets/${targetId}`, input, cookie),
    removeTarget: (targetId: ID, cookie?: string) =>
      del<{ ok: boolean }>(`/admin/node/targets/${targetId}`, cookie),
    /**
     * 运行态诊断（WP7 上报 → NodeStateView）。
     *
     * 路径是后端的**真实**路径 `/admin/node/:id/state`（单数 `node`，与
     * `backend/src/routes/node-admin.ts` 的 `nodeAdminRoutes.get("/node/:id/state")`
     * 逐字一致）。复数 `/admin/nodes/:id/state` 在真实后端**不存在** → 生产必然 404，
     * 曾经是「界面把 404 显示成没有上报」的根因（mock 实现了复数路径把它盖住）。
     *
     * 契约（真实后端）：节点存在时**一律 200** —— 从未上报是 `reported_at: null`
     * 的空态视图，不是 404、也不是 `null` 载荷；只有节点不存在才是 404。
     * 因此这里返回可空 `reported_at` 的线上形状，由 `nodeRuntimeStateFromPayload`
     * 区分「无上报」与「取不到（形状不认识）」。
     */
    nodeState: (id: ID, cookie?: string) =>
      get<NodeStatePayload | null>(`/admin/node/${id}/state`, undefined, cookie),
    /**
     * V4-WP6 §13.4.4：节点健康视图（后端 `routes/node-health.ts`）。
     *
     * 端点用**单数** `/admin/node/:id/health`（与 WP7 凭据端点同一前缀），
     * 返回 `{ data: NodeHealthView }`（单层信封 → 走通用解包）。
     * health / connection / reasons / telemetry 全部由后端合成，前端不重算：
     * §13.4.1 明文「Agent 只上报原始状态，不允许一句 health=healthy 成为
     * 最终真相」。
     *
     * 未上报的节点返回 200 + `telemetry = null`（不是 404）：新节点还没事实
     * 是正常状态，页面据此显示「等待首次上报」。
     */
    nodeHealth: (id: ID, cookie?: string) =>
      get<NodeHealthView>(`/admin/node/${id}/health`, undefined, cookie),
    /**
     * V5.2 §7（WP5/WP6）：出口池的**目标健康**视图。
     *
     * 路径用后端的**真实**路径 `/admin/node/pools/:poolId/health`（单数 `node`，
     * 与 `POST/PUT .../targets` 同一前缀；见 `backend/src/routes/node-admin.ts`）。
     * 响应 `{ data: { targets, observers, observed_at } }` 是单层信封 → 走通用解包。
     *
     * 与 `.../targets` 分开取，是因为两者是两类事实：那是**期望**（用户要什么），
     * 这是**观测 + 合成**（我们看到了什么、据此判断什么）。状态 / 理由 / 逐观测者
     * 明细全部由后端给出；前端只展示，并把 age 按本地时钟现算，**不重算、不取平均、
     * 不改 desired**。
     */
    poolTargetHealth: (poolId: ID, cookie?: string) =>
      get<TargetPoolHealth>(`/admin/node/pools/${poolId}/health`, undefined, cookie),
    /**
     * V4-WP6 §13.4.4：全量巡检（`?health=` / `?lifecycle=`）。
     *
     * 响应是单层信封 `{ data, total, summary }`，`summary` 是**过滤前**的
     * 四态计数——「有多少节点是 error」不需要先拉全部节点。通用解包会丢掉
     * summary，因此这里用 `unwrap: false` 并自己解出三个字段。
     */
    nodeHealthList: async (
      query?: { health?: NodeHealthValue | "all"; lifecycle?: NodeLifecycleValue | "all" },
      cookie?: string,
    ): Promise<NodeHealthList> => {
      const envelope = await request<NodeHealthList & { data?: NodeHealthView[] }>(
        "/admin/node/health",
        { method: "GET", query: query as ListQuery, cookie, unwrap: false },
      );
      return {
        data: Array.isArray(envelope?.data) ? envelope.data : [],
        total: typeof envelope?.total === "number" ? envelope.total : 0,
        summary: normalizeHealthSummary(envelope?.summary),
      };
    },
    /**
     * V4-WP5 §13.4.2：节点生命周期视图（后端 `routes/node-lifecycle.ts`）。
     *
     * 返回 `{ data: NodeLifecycleView }`，含三层状态里的 **Lifecycle** 层与
     * **Connection** 层：`lifecycle`（管理期望态）、`connection`（事实推导）、
     * `accepts_new_business`（准入谓词）、`admission_rejection`（拒绝原因码）、
     * `allowed_transitions`（当前状态下合法的迁移目标）。
     *
     * Health 层不在这里——它由 WP6 的 `/admin/node/:id/health` 给出。
     * UI 一律直接消费这三个字段，**不自行推导**：`allowed_transitions` 是
     * 「哪些按钮能点」的唯一依据，前端复刻一遍 `canTransition` 就会在
     * 服务层加状态时出现「按钮能点但 PATCH 409」。
     */
    nodeLifecycle: (id: ID, cookie?: string) =>
      get<NodeLifecycleView>(`/admin/node/${id}/lifecycle`, undefined, cookie),
    /**
     * V4-WP5 §13.4.2：变更生命周期（进入/退出 maintenance、disabled、
     * 进入 retiring）。
     *
     * body `{ lifecycle, note? }`：`note` 键缺失 = 不动备注，`null`/空串 =
     * 显式清空。响应 `{ data: { node, view } }`——`node` 是写后整行，
     * `view` 是同一行的新生命周期视图，两者同源不会不一致。
     *
     * 非法迁移由服务端以 409 `code=invalid_state` + `condition=
     * invalid_transition` 拒绝（附合法目标清单）；UI 必须按 `condition`
     * 给出下一步，不能只说「操作失败」。
     */
    setNodeLifecycle: (
      id: ID,
      input: { lifecycle?: NodeLifecycleValue; note?: string | null },
      cookie?: string,
    ) => patch<NodeLifecycleChangeResult>(`/admin/node/${id}/lifecycle`, input, cookie),
    /**
     * V4-WP5 §13.4.3：依赖影响检查（删除/收缩前的预览）。
     *
     * 返回五类依赖计数 + `role_check`。可选传 `next_role` / `port_min` +
     * `port_max`（+ `current_role`）让后端把「收缩是否可行」一并判了——
     * 判定与真正写入同源，前端**不复制** `checkRoleChange` 的规则。
     */
    nodeImpact: (
      id: ID,
      query?: { next_role?: string; port_min?: number; port_max?: number; current_role?: string },
      cookie?: string,
    ) => get<NodeImpactResult>(`/admin/node/${id}/impact`, query as ListQuery, cookie),
    /**
     * V4-WP5 §13.4.3：物理删除节点。
     *
     * 前置条件：`lifecycle === "retiring"` 且无任何依赖（§13.4.3「Node 删除
     * 永远不隐式级联删除 Forward」）。未退役 → 409 `invalid_state`；有依赖 →
     * 409 `dependency_blocked` + `dependencies` 清单。UI 用 impact 做**预览**，
     * 但最终裁决权在服务端。
     */
    deleteNodeLifecycle: (id: ID, cookie?: string) =>
      del<{ id: ID; deleted: true }>(`/admin/node/${id}/lifecycle`, cookie),
    nodeGroups: (query?: ListQuery, cookie?: string) => get<Paginated<NodeGroup>>("/admin/node-groups", query, cookie),
    createNodeGroup: (input: NodeGroupInput, cookie?: string) =>
      post<NodeGroup>("/admin/node-groups", input, cookie),
    updateNodeGroup: (id: number, input: Partial<NodeGroupInput>, cookie?: string) =>
      patch<NodeGroup>(`/admin/node-groups/${id}`, input, cookie),
    removeNodeGroup: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/node-groups/${id}`, cookie),
    plans: (query?: ListQuery, cookie?: string) => get<Paginated<Plan>>("/admin/plans", query, cookie),
    /// V5-WP20-4b：套餐表单的「绑定策略」下拉只用可绑集合（后端同一口径：
    /// 启用中且非平台上限模板），避免"UI 能选、保存 400"。
    planPolicyOptions: (cookie?: string) =>
      get<{ id: number; key: string; name: string; status: string; is_ceiling: boolean }[]>(
        "/admin/plan-policy-options",
        undefined,
        cookie,
      ),
    createPlan: (input: PlanInput, cookie?: string) => post<Plan>("/admin/plans", input, cookie),
    updatePlan: (id: number, input: Partial<PlanInput>, cookie?: string) =>
      patch<Plan>(`/admin/plans/${id}`, input, cookie),
    removePlan: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/plans/${id}`, cookie),
    tunnels: (query?: ListQuery, cookie?: string) => get<Paginated<Tunnel>>("/admin/tunnels", query, cookie),
    orders: (query?: ListQuery, cookie?: string) => get<Paginated<PlanOrder | TopupOrder>>("/admin/orders", query, cookie),
    tickets: (query?: ListQuery, cookie?: string) => get<Paginated<Ticket>>("/admin/tickets", query, cookie),
    /** 只读资源写操作（有对应后端端点时使用；无端点时由界面提示只读） */
    updateTunnel: (id: number, input: TunnelUpdateInput, cookie?: string) =>
      patch<Tunnel>(`/admin/tunnels/${id}`, input, cookie),
    removeTunnel: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/tunnels/${id}`, cookie),
    /** 余额流水（管理端全量） */
    balanceLogs: (query?: AdminListInput, cookie?: string) =>
      get<Paginated<BalanceLog>>("/admin/balance-logs", query as ListQuery, cookie),
    /** 支付方式列表（管理端） */
    payments: (cookie?: string) => get<Payment[]>("/payments", undefined, cookie),
    // —— RBAC 角色（仅超管）——
    roles: (cookie?: string) => get<AdminRole[]>("/admin/role", undefined, cookie),
    createRole: (input: AdminRoleInput, cookie?: string) => post<AdminRole>("/admin/role", input, cookie),
    updateRole: (id: number, input: Partial<AdminRoleInput>, cookie?: string) =>
      put<AdminRole>(`/admin/role/${id}`, input, cookie),
    removeRole: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/role/${id}`, cookie),
    updateUserRoles: (id: number, admin_role_ids: number[], cookie?: string) =>
      put<{ id: number; admin_roles: AdminRole[] }>(`/admin/user/${id}/roles`, { admin_role_ids }, cookie),
    /** 权限元数据（渲染角色编辑器） */
    metaResources: (cookie?: string) =>
      get<{ resources: AdminResourceMeta[] }>("/admin/meta/resources", undefined, cookie),
    // —— 系统配置 / License（仅具权限者）——
    systemConfig: (cookie?: string) => get<SystemConfigItem[]>("/admin/system/config", undefined, cookie),
    setSystemConfig: (name: string, value: string, cookie?: string) =>
      put<{ name: string; value: string }>(`/admin/system/config/${name}`, { value }, cookie),
    license: (cookie?: string) => get<LicenseInfo>("/admin/license", undefined, cookie),
    /** 审计日志（仅超级管理员可读） */
    auditLogs: (query?: AuditLogQuery, cookie?: string) =>
      get<Paginated<AuditLog>>("/admin/audit-logs", query as ListQuery, cookie),
    /**
     * V5.5 Federation（WP14/WP15/WP16）—— **只属于 Admin Console**。
     *
     * 路径与响应形状对齐 `backend/src/routes/admin-federation.ts`（唯一真相）。
     * 两条前端纪律：
     *   1. 列表端点返回 `{ data: [...] }` 信封 —— 通用解包会剥掉 `data`，这里拿到的
     *      就是数组本身；不要在这里再包一层或改成裸数组；
     *   2. 失败一律抛 `ApiError`，其 `data` 是后端 `federationErrorBody()` 的原始
     *      `{ code, message, retryable, peer_panel_id, correlation_id }`。
     *      页面必须按 `code` 分层展示「下一步」，不要压成一个 ERROR
     *      （见 `components/admin/federation/federation-status.ts`）。
     */
    federation: {
      status: (cookie?: string) => get<FederationStatus>("/admin/federation/status", undefined, cookie),
      enable: (cookie?: string) => post<FederationEnableResult>("/admin/federation/enable", {}, cookie),
      disable: (cookie?: string) => post<FederationDisableResult>("/admin/federation/disable", {}, cookie),

      peers: (cookie?: string) => get<FederationPeer[]>("/admin/federation/peers", undefined, cookie),
      /** 生成邀请：响应里的 `token` **只出现这一次**（库里只有 sha256），必须一次性展示。 */
      invitePeer: (input: FederationInviteInput, cookie?: string) =>
        post<FederationInvitation>("/admin/federation/peers/invite", input, cookie),
      handshake: (input: FederationHandshakeInput, cookie?: string) =>
        post<FederationHandshakeResult>("/admin/federation/peers/handshake", input, cookie),
      pingPeer: (id: number, cookie?: string) =>
        post<FederationPingResult>(`/admin/federation/peers/${id}/ping`, {}, cookie),
      rotatePeerKey: (id: number, cookie?: string) =>
        post<FederationPeerRotateResult>(`/admin/federation/peers/${id}/rotate`, {}, cookie),
      /** 撤销信任：**不可逆**；响应给出被连带失效的租约数。 */
      revokePeer: (id: number, cookie?: string) =>
        del<FederationPeerRevokeResult>(`/admin/federation/peers/${id}`, cookie),
      /** 轮转本机密钥（对所有可信 peer）。部分失败时 HTTP 502，体仍是 `FederationKeyRotateResult`。 */
      rotateLocalKey: (cookie?: string) => post<FederationKeyRotateResult>("/admin/federation/key/rotate", {}, cookie),

      grants: (cookie?: string) => get<FederationGrant[]>("/admin/federation/grants", undefined, cookie),
      createGrant: (input: FederationGrantInput, cookie?: string) =>
        post<FederationGrantCreateResult>("/admin/federation/grants", input, cookie),
      revokeGrant: (ref: string, cookie?: string) =>
        post<FederationGrantActionResult>(`/admin/federation/grants/${encodeURIComponent(ref)}/revoke`, {}, cookie),
      suspendGrant: (ref: string, cookie?: string) =>
        post<FederationGrantActionResult>(`/admin/federation/grants/${encodeURIComponent(ref)}/suspend`, {}, cookie),
      resumeGrant: (ref: string, cookie?: string) =>
        post<FederationGrantActionResult>(`/admin/federation/grants/${encodeURIComponent(ref)}/resume`, {}, cookie),

      leases: (cookie?: string) => get<FederationLease[]>("/admin/federation/leases", undefined, cookie),
      placements: (cookie?: string) => get<FederationPlacement[]>("/admin/federation/placements", undefined, cookie),
      usage: (cookie?: string) => get<FederationUsageRecord[]>("/admin/federation/usage", undefined, cookie),
    },
};

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
  NodeStateReport,
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
// 公告类型单独维护在 announcements.ts。
import type { Announcement } from "../announcements";
// 目标健康状态与理由码在 target-health.ts 维护。
import type { TargetPoolHealth } from "../target-health";
import { shouldRedirectToLogin } from "../workspace-permissions";
import type { EffectiveWorkspacePermissions, WorkspaceCustomRole, WorkspaceCustomRoleInput, WorkspaceMemberRoleInput } from "../workspace-permissions";

import { request, get, post, put, patch, del, applyMockSessionCookie, clearMockSessionCookie } from "./core";

export const forwardsApi = {
    summary: (cookie?: string) =>
      get<ForwardSummary>("/forwards/summary", undefined, cookie),
    /**
     * 列表支持服务端分页、排序和过滤。
     *
     * 带 `page` / `page_size` / `sort` / `order` 任一参数时后端返回
     * `Paginated<PortForward>`；不带则返回裸数组（冻结的旧契约）。
     * 用两个方法把这两种形态分开，调用点就无法"忘了带 page 却按分页读"。
     */
    list: (query?: ForwardListQuery, cookie?: string) =>
      get<PortForward[]>("/forwards", query, cookie),
    /** 分页形态：必须有分页/排序参数，响应为 `Paginated<PortForward>`。 */
    page: (query: ForwardListQuery, cookie?: string) =>
      get<Paginated<PortForward>>("/forwards", query, cookie),
    /**
     * 批量 retry / suspend / resume。
     *
     * 逐条结果 + 200（部分失败不改整体状态码），因此调用方必须读
     * `succeeded` / `failed` 而不是只看 promise 是否 reject。
     */
    batch: (
      input: ForwardBatchInput,
      cookie?: string,
    ) => post<ForwardBatchResult>("/forwards/batch", input, cookie),
    detail: (id: ID, cookie?: string) =>
      get<PortForward>(`/forwards/${id}`, undefined, cookie),
    traffic: (id: ID, days = 14, cookie?: string) =>
      get<TrafficPoint[]>(`/forwards/${id}/traffic`, { days }, cookie),
    create: (input: ForwardCreateInput, cookie?: string) =>
      post<PortForward>("/forwards", input, cookie),
    update: (id: ID, input: ForwardPatchInput, cookie?: string) =>
      patch<PortForward>(`/forwards/${id}`, input, cookie),
    /**
     * 保存前影响预览（不写库）。
     *
     * 与 update 共用后端同一个 candidate resolver，因此本方法放行 ⇔ update 接受。
     * UI 在每次字段变更后调用它渲染 impact warning。
     */
    preview: (id: ID, input: ForwardPatchInput, cookie?: string) =>
      post<ForwardPreviewResult>(`/forwards/${id}/preview`, input, cookie),
    action: (
      id: ID,
      action: "retry" | "suspend" | "resume",
      cookie?: string,
    ) => post<PortForward>(`/forwards/${id}/${action}`, {}, cookie),
    remove: (id: ID, cookie?: string) =>
      del<{ ok: true }>(`/forwards/${id}`, cookie),
    /**
     * Forward 诊断（只读）。
     *
     * 探针目标由**后端**从该转发的已授权期望状态推导，请求体不带 host/port ——
     * 因此这里刻意不接受任何参数：一个"带目标参数的诊断"就是把客户端变成内网扫描器。
     */
    diagnose: (id: ID, cookie?: string) =>
      post<DiagnoseReport>(`/forwards/${id}/diagnose`, {}, cookie),
};

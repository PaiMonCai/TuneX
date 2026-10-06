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

export const workspacesApi = {
    permissions: (id: number) => request<EffectiveWorkspacePermissions>(`/workspaces/${id}/permissions`, { noRedirect: true, workspaceId: id }),
    roles: (id: number) => get<WorkspaceCustomRole[]>(`/workspaces/${id}/roles`),
    createRole: (id: number, input: WorkspaceCustomRoleInput) => post<WorkspaceCustomRole>(`/workspaces/${id}/roles`, input),
    updateRole: (id: number, roleId: number, input: WorkspaceCustomRoleInput) => patch<WorkspaceCustomRole>(`/workspaces/${id}/roles/${roleId}`, input),
    deleteRole: (id: number, roleId: number) => del<{ ok: boolean }>(`/workspaces/${id}/roles/${roleId}`),
    assignRole: (id: number, userId: number, input: WorkspaceMemberRoleInput) => patch<WorkspaceMember>(`/workspaces/${id}/members/${userId}/role`, input),
    /** 当前用户可见的全部工作空间（含个人空间），带上各自角色 */
    list: (cookie?: string) => get<Workspace[]>("/workspaces", undefined, cookie),
    /** 创建团队空间（后端事务内发放默认策略），创建者成为 owner */
    create: (input: WorkspaceCreateInput, cookie?: string) =>
      post<Workspace>("/workspaces", input, cookie),
    members: (id: number, cookie?: string) =>
      get<WorkspaceMember[]>(`/workspaces/${id}/members`, undefined, cookie),
    /** 邀请成员；返回的 token 只出现一次，需当场展示 */
    invite: (id: number, input: WorkspaceInviteInput, cookie?: string) =>
      post<WorkspaceInvite>(`/workspaces/${id}/invites`, input, cookie),
    /** 用邀请 token 加入团队（按当前登录用户邮箱匹配） */
    acceptInvite: (token: string, cookie?: string) =>
      post<WorkspaceAcceptInviteResult>("/workspaces/invites/accept", { token }, cookie),
    /** 移除成员（owner 不可移除；也可用于「退出」：actor == targetId 时无需 manage 权限） */
    removeMember: (id: number, userId: number, cookie?: string) =>
      del<{ ok: boolean }>(`/workspaces/${id}/members/${userId}`, cookie),
    /**
     * workspace 流量聚合（口径与策略流量一致）。
     * 返回总流量 + 按隧道排行 + 按日界补齐的趋势序列。
     * @param id workspace id
     * @param params.days 趋势天数（1–90，默认 14，后端 `TRAFFIC_DEFAULT_DAYS`）
     * @param params.period 计量周期（day/month/total）；缺省取该空间生效策略的 traffic_period
     */
    traffic: (
      id: number,
      params?: { days?: number; period?: "day" | "month" | "total" },
      cookie?: string,
    ) =>
      get<WorkspaceTrafficSummary>(`/workspaces/${id}/traffic`, params as ListQuery, cookie),
  },
  // 认证

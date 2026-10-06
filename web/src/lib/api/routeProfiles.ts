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

export const routeProfilesApi = {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<RouteProfileView>>("/route-profiles", query, cookie),
    detail: (id: ID, cookie?: string) =>
      get<RouteProfileDetail>(`/route-profiles/${id}`, undefined, cookie),
    create: (input: RouteProfileCreateInput, cookie?: string) =>
      post<RouteProfileView & { version_id: number }>("/route-profiles", input, cookie),
    /** 只改 metadata；模板内容变更必须走 publishVersion。 */
    patch: (id: ID, input: RouteProfilePatchInput, cookie?: string) =>
      patch<RouteProfileView>(`/route-profiles/${id}`, input, cookie),
    /** 发布**新版本**（模板内容变更的唯一路径）。 */
    publishVersion: (id: ID, input: RouteProfilePublishInput, cookie?: string) =>
      post<RouteProfilePublishResult>(`/route-profiles/${id}/versions`, input, cookie),
    versions: (id: ID, limit = 50, cookie?: string) =>
      get<RouteProfileVersionEntry[]>(`/route-profiles/${id}/versions`, { limit }, cookie),
    version: (id: ID, version: number, cookie?: string) =>
      get<RouteProfileVersionBody>(`/route-profiles/${id}/versions/${version}`, undefined, cookie),
    /** Impact Analysis：**只读**，不触发任何下发（后端保证并有用例钉住）。 */
    impact: (id: ID, version?: number, cookie?: string) =>
      get<RouteProfileImpact>(`/route-profiles/${id}/impact`, version === undefined ? undefined : { version }, cookie),
    /** 显式 rollout：必须给出 forward_ids；dry_run=true 时只预览。 */
    apply: (id: ID, input: RouteProfileApplyInput, cookie?: string) =>
      post<RouteProfileApplyResult>(`/route-profiles/${id}/apply`, input, cookie),
    /** 消费侧可见/可选列表（普通用户；fail-closed：没有显式授权就看不到）。 */
    available: (cookie?: string) =>
      get<ConsumableRouteProfileList>("/route-profiles/available", undefined, cookie),
};

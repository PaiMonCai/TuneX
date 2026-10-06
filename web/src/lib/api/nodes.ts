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

export const nodesApi = {
    list: (cookie?: string) => get<UserNode[]>("/nodes", undefined, cookie),
    enrollment: (id: ID, cookie?: string) =>
      post<NodeEnrollmentIssued>(`/nodes/${id}/enrollment`, {}, cookie),
    bindings: (ingressId: ID, cookie?: string) =>
      get<NodeBinding[]>(`/nodes/${ingressId}/bindings`, undefined, cookie),
    bindEgress: (ingressId: ID, egress_node_id: ID, cookie?: string) =>
      post<NodeBinding>(`/nodes/${ingressId}/bindings`, { egress_node_id }, cookie),
    unbindEgress: (ingressId: ID, egressId: ID, cookie?: string) =>
      del<{ ok: boolean }>(`/nodes/${ingressId}/bindings/${egressId}`, cookie),
    /**
     * Node 级诊断；上报过期时后端返回 offline，不下发命令。
     */
    diagnostics: (id: ID, cookie?: string) =>
      get<NodeDiagnosticsReport>(`/nodes/${id}/diagnostics`, undefined, cookie),
    /**
     * Support Bundle 使用白名单采集和脱敏，返回 JSON 产物。
     */
    supportBundle: (id: ID, cookie?: string) =>
      get<Record<string, unknown>>(`/nodes/${id}/support-bundle`, undefined, cookie),
    /**
     * 渲染 Agent 升级脚本。
     *
     * 返回的是**操作者需要在节点上执行**的脚本；控制面不会远程替换 Agent。
     * `allow_active` 为 false 时后端会拒绝非 maintenance 节点（409）。
     */
    upgradeCommand: (id: ID, input: { agent_image: string; allow_active?: boolean }, cookie?: string) =>
      post<NodeUpgradeCommand>(`/nodes/${id}/upgrade-command`, input, cookie),
};

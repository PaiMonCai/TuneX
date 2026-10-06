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

export const authApi = {
    session: async (cookie?: string): Promise<AuthSession> => {
      const data = await request<User>("/auth/me", { cookie });
      // 真实后端 /me 返回平铺的用户对象，包装成 AuthSession.user 以匹配前端类型
      return { user: data, token: undefined };
    },
    login: async (email: string, password: string, cookie?: string) => {
      const session = await request<AuthSession>("/auth/login", {
        method: "POST",
        body: { email, password },
        noRedirect: true,
        cookie,
      });
      applyMockSessionCookie(session);
      return session;
    },
    register: async (email: string, password: string, cookie?: string) => {
      const session = await request<AuthSession>("/auth/register", {
        method: "POST",
        body: { email, password },
        noRedirect: true,
        cookie,
      });
      applyMockSessionCookie(session);
      return session;
    },
    logout: async () => {
      const res = await post<{ ok: boolean }>("/auth/logout");
      clearMockSessionCookie();
      return res;
    },
    /** 点击邮件链接验证邮箱。 */
    verifyEmail: (token: string) =>
      request<{ status: "verified" | "invalid"; message: string }>(
        `/auth/verify-email?token=${encodeURIComponent(token)}`,
        { method: "GET", noRedirect: true },
      ),
    /** 重新发送验证邮件（需登录）。 */
    resendVerification: async () => post<{ ok: boolean; expires_in: number }>("/auth/resend-verification"),
    /**
     * 忘记密码响应与邮箱是否存在无关，避免账号枚举。
     * 故前端不做「该邮箱未注册」的错误分支。
     */
    forgotPassword: async (email: string) =>
      post<{ ok: boolean; expires_in: number }>("/auth/forgot-password", { email }),
    /** 用邮件 token 设置新密码。 */
    resetPassword: async (token: string, password: string) =>
      post<{ ok: boolean }>("/auth/reset-password", { token, password }),
};

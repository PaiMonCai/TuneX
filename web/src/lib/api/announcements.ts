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

/**
 * 免打扰偏好的**服务端形状**（切片 N1）。类型就放在这里，不再往 `lib/types/` 加文件：
 * 这两条形状只服务本模块的两个端点，散到通用类型表里反而更容易被别处误用。
 *
 * `channel_kind` / `category` 刻意是**字符串**而不是联合类型：可选值是**服务端下发的闭集**
 * （`GET` 的 `channels` / `categories`），前端不得自带一份会漂移的副本。写死的联合类型会
 * 让"服务端新增一个类别"变成前端类型错误（而不是如实渲染 + 标注未知）。
 */
export interface NotificationMutePreference {
  channel_kind: string;
  category: string;
}

export interface NotificationPreferencesPayload {
  /** 当前用户的免打扰清单（存在 = 静音）。 */
  mutes: NotificationMutePreference[];
  /** 服务端下发的闭集：可静音的渠道。 */
  channels: string[];
  /** 服务端下发的闭集：可静音的类别。 */
  categories: string[];
}

export const announcementsApi = {
    list: (cookie?: string) => get<Announcement[]>("/announcements", undefined, cookie),
    dismiss: (id: ID, cookie?: string) =>
      post<{ announcement_id: number; already: boolean; dismissed_at: string }>(
        `/announcements/${id}/dismiss`,
        {},
        cookie,
      ),
    /**
     * 用户级免打扰偏好（`backend/src/routes/announcements.ts` 的 `/preferences`）。
     *
     * **它不是工作空间作用域的**：服务端只认会话用户（路由只做 `requireUser`），不读
     * `x-workspace-id`，也不经过任何工作空间权限判定。客户端在登录态下可能仍会带上
     * `x-workspace-id` 头（`lib/api/core.ts` 的既有行为），但服务端**忽略**它 ——
     * 前端不得据此把这份偏好当成"当前空间的通知设置"来渲染或缓存。
     *
     * 载荷辨认失败（不是 `{mutes,channels,categories}`）⇒ **抛错**，由此上层进入"取不到"分支。
     * 绝不把"读不出来"退回成空清单 —— 那会让页面声称"你什么都没静音"。
     */
    getPreferences: async (cookie?: string): Promise<NotificationPreferencesPayload> => {
      const raw = await get<unknown>("/announcements/preferences", undefined, cookie);
      return readPreferencesPayload(raw);
    },
    /**
     * 全量替换免打扰清单（PUT 语义：**整个清单**，不是增量补丁）。
     * 服务端 fail-closed：不认识的渠道/类别会让**整个请求** 400
     * （`unknown_channel_kind` / `unknown_category` / `not_an_array`），不做"丢掉不认识的项"。
     *
     * 返回值是**服务端回显的已落库清单**；`null` = 响应里没有可辨认的清单（调用方据此保留本地意图）。
     */
    putPreferences: async (mutes: readonly NotificationMutePreference[], cookie?: string) => {
      const raw = await put<unknown>(
        "/announcements/preferences",
        { mutes: mutes.map((mute) => ({ channel_kind: mute.channel_kind, category: mute.category })) },
        cookie,
      );
      const payload = raw && typeof raw === "object" ? (unwrapEnvelope(raw) as { mutes?: unknown }) : null;
      return { mutes: payload && Array.isArray(payload.mutes) ? (payload.mutes as NotificationMutePreference[]) : null };
    },
};

/**
 * 解一层 `{ data }` 信封。
 *
 * 为什么需要它：真实后端一律 `c.json({ data })`，`lib/api/core.ts` 在**真实模式**下会解包；
 * 但 mock 模式直接返回 handler 的 `body`（`core.ts:87`），而 mock 为了与真实响应**逐层同形**
 * 会带上外层 `{ data }`（既有 handler 的约定）。两种形状都收，行为在两种模式下一致。
 * 这不是"第二套真相"：它只认这一种已知的信封，别的形状一律当"读不出来"。
 */
function unwrapEnvelope(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).data;
  }
  return raw;
}

/** 辨认 `{ mutes, channels, categories }`。三样缺一（或类型不对）就是"读不出来"，不是"空"。
 *  导出只为让它可被测试直接驱动（两种信封形状 / 畸形载荷），不是给别处复用的入口。 */
export function readPreferencesPayload(raw: unknown): NotificationPreferencesPayload {
  const payload = unwrapEnvelope(raw);
  const row = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const mutes = row?.mutes;
  const channels = row?.channels;
  const categories = row?.categories;
  if (!Array.isArray(mutes) || !Array.isArray(channels) || !Array.isArray(categories)) {
    throw new Error("通知偏好应答无法辨认（缺少 mutes/channels/categories）：已按「取不到」处理，不做任何推测");
  }
  return {
    mutes: mutes.filter(
      (mute): mute is NotificationMutePreference =>
        !!mute && typeof mute === "object" && typeof (mute as { channel_kind?: unknown }).channel_kind === "string",
    ),
    channels: channels.filter((channel): channel is string => typeof channel === "string"),
    categories: categories.filter((category): category is string => typeof category === "string"),
  };
}

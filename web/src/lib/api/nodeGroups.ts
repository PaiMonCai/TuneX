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
  NodeType,
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

import { request, get, post, put, patch, del, applyMockSessionCookie, clearMockSessionCookie, ApiError } from "./core";

/* ================================================================== */
/* 自建节点组（用户域 `POST /api/node-groups`）                         */
/* ================================================================== */

/**
 * 建组入参。
 *
 * `port_range` 在本切片**必填**（后端 schema 允许省略，但没有合法连续端口范围的组
 * 之后无法 provision：`POST /node-groups/:id/nodes` 会 409 `PORT_RANGE_REQUIRED`）。
 * 让用户在第一步就给出区间，好过在第二步撞一个可修复的 409。
 */
export interface NodeGroupCreateInput {
  name: string;
  /** 方向；本切片只开放入口组（`in`）。 */
  node_type: NodeType;
  /** `start-end`，两端 1..65535 且 `start <= end`。 */
  port_range: string;
}

/**
 * 建组成功后**允许进入客户端状态**的全部字段。
 *
 * 后端响应里还有一个一次性 `token`（Agent 注册组凭据）。它不进这个类型，
 * 也不进组件 state / SSR payload / 日志 —— 见 {@link projectCreatedNodeGroup}。
 */
export interface CreatedNodeGroup {
  id: ID;
  name: string;
  node_type: NodeType;
}

/** 建组响应不是预期形状（fail-closed：不把残缺对象塞进界面）。 */
export class NodeGroupProjectionError extends Error {
  constructor() {
    super("节点组响应缺少界面所需字段");
    this.name = "NodeGroupProjectionError";
  }
}

/**
 * 建组响应 → {@link CreatedNodeGroup}（白名单投影）。
 *
 * **`token` 在这里被丢掉，且只在这里被读到一次**：调用方拿到的对象里没有它，
 * 因此没有任何下游路径能把组凭据渲染出来、写进 state 或打进日志。
 */
export function projectCreatedNodeGroup(raw: unknown): CreatedNodeGroup {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const id = Number(row?.id);
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  const nodeType = row?.node_type;
  if (!row || !Number.isInteger(id) || id <= 0 || name === "" || (nodeType !== "in" && nodeType !== "out")) {
    throw new NodeGroupProjectionError();
  }
  return { id, name, node_type: nodeType };
}

/* ================================================================== */
/* 后端错误码 → 「原因 + 下一步」                                       */
/* ================================================================== */

/** 建组 / provision 的「下一步」词典键（原因本身用后端原文，不另抄一份中文）。 */
export const NODE_GROUP_ERROR_NEXT_STEP_KEYS: Record<string, string> = {
  /** 403：策略未授予自建该类节点组的能力（能力未开通，不是超额）。 */
  custom_group_not_allowed: "node.groupErrorNextPolicy",
  /** 403：节点额度耗尽（真实额度，不该说成权限问题）。 */
  node_limit: "node.groupErrorNextNodeLimit",
  /** 409：节点组没有合法连续端口范围（可修复的状态冲突）。 */
  PORT_RANGE_REQUIRED: "node.groupErrorNextPortRange",
  /** 409：`node_id` 已被其它节点组占用（后端唯一键）。 */
  node_id_conflict: "node.groupErrorNextNodeIdConflict",
  /** 409：已存在不同角色的同名节点，需要先显式改角色。 */
  role_conflict: "node.groupErrorNextRoleConflict",
};

export interface NodeGroupApiErrorInfo {
  /** 后端 code（`data.code`）；没有就是 `null`（不猜）。 */
  code: string | null;
  /** HTTP 状态；非 ApiError 时为 `null`。 */
  status: number | null;
  /** 后端 message/error 原文；没有可用文本时为 `null`。 */
  message: string | null;
  /** 该码对应的「下一步」词典键；没有专门下一步时为 `null`。 */
  nextStepKey: string | null;
}

/**
 * 把建组 / provision 的失败翻译成「真实原因 + 下一步」。
 *
 * 原因用**后端原文**（`ApiError.message`，来自响应体的 `message` / `error`）；
 * 本函数只补一个不重复原因的下一步词典键。未知错误不编原因：`message` 照原文，
 * `nextStepKey` 为 `null`。
 */
export function nodeGroupApiErrorInfo(error: unknown): NodeGroupApiErrorInfo {
  const status = error instanceof ApiError ? error.status : null;
  const data = error instanceof ApiError ? error.data : null;
  const code =
    data && typeof data === "object" && !Array.isArray(data) && typeof (data as { code?: unknown }).code === "string"
      ? ((data as { code: string }).code)
      : null;
  const rawMessage = error instanceof Error ? error.message.trim() : "";
  return {
    code,
    status,
    message: rawMessage === "" ? null : rawMessage,
    nextStepKey: code ? NODE_GROUP_ERROR_NEXT_STEP_KEYS[code] ?? null : null,
  };
}

export const nodeGroupsApi = {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<NodeGroup>>("/node-groups", query, cookie),
    /**
     * 自建节点组（Workspace scoped，`node:manage` + 有效 entitlement 由后端裁决）。
     *
     * 响应里的组凭据 `token` **不出本函数**：投影只保留 id/name/node_type。
     * 后端拒绝码原样抛出（403 `custom_group_not_allowed` / 403 `node_limit` /
     * 409 `PORT_RANGE_REQUIRED` …），由调用方用 {@link nodeGroupApiErrorInfo} 取原因。
     */
    create: async (input: NodeGroupCreateInput, cookie?: string): Promise<CreatedNodeGroup> =>
      projectCreatedNodeGroup(
        await post<unknown>(
          "/node-groups",
          { name: input.name.trim(), node_type: input.node_type, port_range: input.port_range },
          cookie,
        ),
      ),
    provisionNode: (
      groupId: ID,
      input: {
        node_id: string;
        connect_ip?: string | null;
        role?: NodeRole;
        targets?: { host: string; port: number; weight?: number }[];
      },
      cookie?: string,
    ) => post<ProvisionNodeResult>(`/node-groups/${groupId}/nodes`, input, cookie),
};

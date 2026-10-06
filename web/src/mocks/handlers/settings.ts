import type {
  AdminRole,
  AttentionItem,
  AttentionReasonCode,
  AttentionSummary,
  BillingCycle,
  BalanceLog,
  EgressPool,
  EgressTarget,
  ID,
  LBStrategy,
  ListQuery,
  Node,
  NodeCredentialIssued,
  NodeCredentialRevoked,
  NodeEnrollmentIssued,
  NodeBinding,
  NodeGroup,
  NodeType,
  Plan,
  PlanOrder,
  PortForward,
  Ticket,
  TicketReply,
  TopupOrder,
  TrafficPoint,
  Tunnel,
  TunnelEgressPoolOption,
  TunnelMode,
  TunnelRuntimeAction,
  User,
  UserNode,
  UserPlan,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceTrafficSummary,
} from "@/lib/types";
import type { TargetHealthTargetView, TargetPoolHealth } from "@/lib/target-health";
import type { MockNodeBinding, MockWorkspaceInvite } from "../state";
import type { ForwardProtocol } from "@/lib/forward-protocol";
import * as rt from "../runtime";
import type { MockRequest, MockResponse, Store, MockForwardBatchAction, MockForwardBatchItemResult } from "../runtime";

const { TLS_PATH_ERROR_MESSAGES, SESSION_COOKIE, GB, sessionCookieValue, CYCLE_DAYS, COUPONS, ADMIN_RESOURCES, ADMIN_RESOURCE_KEYS, sanitizePermissions, TOPUP_AUTO_SETTLE_MS, nowIso, ok, fail, badRequest, notFound, failFlat, isLoggedIn, userFromCookie, paginate, MOCK_FORWARD_SORT_FIELDS, sortMockForwards, filterByKeyword, filterByStatus, nextId, asRecord, reqStr, numOrNull, reqNum, required, pick, parseList, isResponse, parseId, groupRef, withGroupStats, tunnelTrafficSeries, creditBalance, settleTopup, autoSettleTopups, payUrlFor, topupOrderNo, dashboardStats, adminStats, readPlanPayload, readNodeGroupPayload, readNodePayload, mockPoolTargetHealth, noEvidenceTargetView, handleEgressPools, nextPoolId, nextTargetId, APPLY_STATUSES, TUNNEL_MODES, FORWARD_BATCH_ACTIONS, FORWARD_BATCH_MAX_IDS, applyStatusOf, hasV3Columns, completeOrchestration, poolOfNode, poolRef, tunnelRuntimeAction, MOCK_ATTENTION_MAX_ITEMS, mockAttention, mockUserNode, mockBindingUsage, mockBindingView, healthWorld, impactWorld, mockIngressNode, parseMockTarget, mockForwardView, mockEnrollment, seed, poolTargetKey, getStore, resetStore, handleFederationMock, handleRouteProfileMock, mockFleetHealth, mockNodeHealth, mockResolveNode, MOCK_LIFECYCLES, MOCK_LIFECYCLE_NOTE_MAX, mockAllowedTransitions, mockCanTransition, mockDeleteGates, mockImpact, mockLifecycleChange, mockLifecycleOf, mockLifecycleView, mockRoleCheck, mockUserNodeStatus, applyMockForwardPatch, previewMockForwardUpdate, applyErrorIsRetryable, DEFAULT_FORWARD_PROTOCOL, forwardProtocolFact, forwardProtocolSupported, isForwardProtocol, tlsPathFieldErrors, mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } = rt;

export async function handleSettingsMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "settings") {
    if (seg[1] === "profile" && method === "GET") return ok(user);
    if (seg[1] === "profile" && (method === "PATCH" || method === "PUT")) {
      const body = asRecord(req.body);
      if (typeof body.email === "string") {
        const email = body.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
        if (db.users.some((x) => x.id !== user.id && x.email.toLowerCase() === email)) return badRequest("该邮箱已被占用");
        user.email = email;
      }
      Object.assign(user, pick<User>(body, ["note", "tg_id", "auto_renew"]));
      user.updated_at = nowIso();
      return ok(user);
    }
    if (seg[1] === "password" && method === "POST") {
      const body = asRecord(req.body);
      const current = reqStr(body.current_password);
      const next = reqStr(body.new_password);
      if (!current || !next) return badRequest("缺少必填字段");
      const expected = db.passwords[user.id] ?? seed.DEMO_CREDENTIALS.password;
      if (current !== expected) return badRequest("当前密码不正确");
      if (next.length < 6) return badRequest("新密码至少 6 位");
      db.passwords[user.id] = next;
      return ok({ ok: true });
    }
    // SEC-02 对齐：mock 轮换后明文列同样「只出现一次」——
    // 响应里回明文，但 user 对象上的 api_key 归 null（后端只存 sha256 哈希列）。
    // 前端一次性展示区读的是响应顶层字段，不是 user.*，故此形状即真实契约。
    if (seg[1] === "api-key" && method === "POST") {
      const rand = () => Math.random().toString(16).slice(2, 10);
      const key = `rk_live_${rand()}${rand()}`;
      user.api_key = null;
      user.updated_at = nowIso();
      return ok({ ok: true, api_key: key, user });
    }
    if (seg[1] === "subscription-key" && method === "POST") {
      const rand = () => Math.random().toString(16).slice(2, 10);
      const key = `sk_sub_${rand()}${rand()}`;
      user.subscription_key = null;
      user.updated_at = nowIso();
      return ok({ ok: true, subscription_key: key, user });
    }
  }

  // ---------- route-profiles（V5-WP13.5B；唯一真相 backend/src/routes/route-profiles.ts）----------
  // 非 /admin 前缀：后端复用 workspace 域 RBAC（read/manage），Admin 与 User 是同一套资源的两个 UX 面。
  return null;
}

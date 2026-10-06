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
import * as rt from "./runtime";
import type { MockRequest, MockResponse } from "./runtime";
export type { MockRequest, MockResponse } from "./runtime";
export { MOCK_ATTENTION_MAX_ITEMS } from "./runtime";
const { TLS_PATH_ERROR_MESSAGES, SESSION_COOKIE, GB, sessionCookieValue, CYCLE_DAYS, COUPONS, ADMIN_RESOURCES, ADMIN_RESOURCE_KEYS, sanitizePermissions, TOPUP_AUTO_SETTLE_MS, nowIso, ok, fail, badRequest, notFound, failFlat, isLoggedIn, userFromCookie, paginate, MOCK_FORWARD_SORT_FIELDS, sortMockForwards, filterByKeyword, filterByStatus, nextId, asRecord, reqStr, numOrNull, reqNum, required, pick, parseList, isResponse, parseId, groupRef, withGroupStats, tunnelTrafficSeries, creditBalance, settleTopup, autoSettleTopups, payUrlFor, topupOrderNo, dashboardStats, adminStats, readPlanPayload, readNodeGroupPayload, readNodePayload, mockPoolTargetHealth, noEvidenceTargetView, handleEgressPools, nextPoolId, nextTargetId, APPLY_STATUSES, TUNNEL_MODES, FORWARD_BATCH_ACTIONS, FORWARD_BATCH_MAX_IDS, applyStatusOf, hasV3Columns, completeOrchestration, poolOfNode, poolRef, tunnelRuntimeAction, MOCK_ATTENTION_MAX_ITEMS, mockAttention, mockUserNode, mockBindingUsage, mockBindingView, healthWorld, impactWorld, mockIngressNode, parseMockTarget, mockForwardView, mockEnrollment, seed, poolTargetKey, getStore, resetStore, handleFederationMock, handleRouteProfileMock, mockFleetHealth, mockNodeHealth, mockResolveNode, MOCK_LIFECYCLES, MOCK_LIFECYCLE_NOTE_MAX, mockAllowedTransitions, mockCanTransition, mockDeleteGates, mockImpact, mockLifecycleChange, mockLifecycleOf, mockLifecycleView, mockRoleCheck, mockUserNodeStatus, applyMockForwardPatch, previewMockForwardUpdate, applyErrorIsRetryable, DEFAULT_FORWARD_PROTOCOL, forwardProtocolFact, forwardProtocolSupported, isForwardProtocol, tlsPathFieldErrors, mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } = rt;

import { handleWorkspacesMock } from "./handlers/workspaces";
import { handleDashboardMock } from "./handlers/dashboard";
import { handleNodesMock } from "./handlers/nodes";
import { handleForwardsMock } from "./handlers/forwards";
import { handleTunnelsMock } from "./handlers/tunnels";
import { handleCatalogMock } from "./handlers/catalog";
import { handleCommerceMock } from "./handlers/commerce";
import { handleSettingsMock } from "./handlers/settings";
import { handleDdnsMock } from "./handlers/ddns";
import { handleRouteProfilesMock } from "./handlers/route-profiles";
import { handleAdminMock } from "./handlers/admin";

export async function handleMock(method: string, path: string, req: MockRequest): Promise<MockResponse> {
  const clean = path.split("?")[0].replace(/^\/+|\/+$/g, "");
  const seg = clean.split("/");
  const q = req.query;
  const db = getStore();
  const logged = isLoggedIn(req.cookie);

  // ---------- mock 自管理 ----------
  if (seg[0] === "_mock" && seg[1] === "reset" && method === "POST") {
    resetStore();
    return ok({ ok: true, boot_at: getStore().boot_at });
  }

  // ---------- auth ----------
  if (seg[0] === "auth") {
    // api 层用 `GET /auth/me`（与真实后端对齐），返回裸用户；`/auth/session` 为兼容旧调用返回 { user }
    if ((seg[1] === "session" || seg[1] === "me") && method === "GET") {
      if (!logged) return fail(401, "Unauthorized");
      const u = userFromCookie(db, req.cookie);
      const withPlan = { ...u, user_plan: db.userPlans.find((p) => p.user_id === u.id) ?? null };
      return ok(seg[1] === "me" ? withPlan : { user: withPlan });
    }
    /**
     * GET /auth/permissions —— 与真实后端同形：`{ super_admin, roles }`。
     *
     * mock 的后台准入模型**本身就是** super_admin 优先（见 handlers/admin.ts 的
     * `if (!user.super_admin) return fail(403, "需要管理员权限")`），所以这里如实投影：
     * 演示账号（super_admin）持有 super_admin 角色，其余账号 roles 为空。
     * **不**编造一个「有委派角色但 mock 的 /admin/* 一律 403」的假委派管理员 ——
     * 那会让 mock 自己前后矛盾。委派视角由 `admin-persona` 的单元测试覆盖。
     */
    if (seg[1] === "permissions" && method === "GET") {
      if (!logged) return fail(401, "Unauthorized");
      const u = userFromCookie(db, req.cookie);
      const isSuper = u.super_admin === true;
      // 外层 `{ data }` 与真实后端 `c.json({ data: {...} })` 一致（api 层会解包，
      // 两种写法客户端都能用；这里选择与真实响应逐层同形）。
      return ok({
        data: {
          super_admin: isSuper,
          roles: isSuper
            ? db.adminRoles
                .filter((role) => role.name === "super_admin")
                .map((role) => ({ id: role.id, name: role.name, permissions: role.permissions }))
            : [],
        },
      });
    }
    if (seg[1] === "login" && method === "POST") {
      const body = asRecord(req.body);
      const email = reqStr(body.email).toLowerCase();
      const password = reqStr(body.password);
      if (!email || !password) return badRequest("邮箱和密码不能为空");
      const found = db.users.find((u) => u.email.toLowerCase() === email);
      const expected = found ? db.passwords[found.id] : undefined;
      const isDemo = email === seed.DEMO_CREDENTIALS.email.toLowerCase() && password === seed.DEMO_CREDENTIALS.password;
      if (!found || (password !== expected && !isDemo)) return fail(401, "邮箱或密码错误");
      if (found.status !== "active") return fail(403, "账号已被禁用");
      return ok({
        user: { ...found, email_verified_at: found.email_verified_at ?? null },
        token: `mock-jwt-${found.id}`,
        email_verified: Boolean(found.email_verified_at),
        expires_at: new Date(Date.now() + 6048e5).toISOString(),
        // mock 模式下没有真实响应头，浏览器端无法拿到 Set-Cookie，
        // 故把会话 cookie 值随 body 下发，由 api 层在客户端写入 document.cookie。
        // 切到真实后端时这个字段会被忽略（后端走真正的 Set-Cookie）。
        session_cookie: sessionCookieValue(found.id),
      });
    }
    if (seg[1] === "register" && method === "POST") {
      const body = asRecord(req.body);
      const email = reqStr(body.email).toLowerCase();
      const password = reqStr(body.password);
      if (!email) return badRequest("邮箱不能为空");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
      if (password.length < 6) return badRequest("密码至少 6 位");
      if (db.users.some((u) => u.email.toLowerCase() === email)) return badRequest("该邮箱已注册");
      const id = nextId(db.users);
      const created: User = {
        id,
        email,
        super_admin: false,
        balance: 0,
        commission_balance: 0,
        tg_id: null,
        uid: `RX-${100000 + id}`,
        note: null,
        parent_id: null,
        referral_commission_rate: null,
        auto_renew: false,
        api_key: `rk_live_${Math.random().toString(16).slice(2, 18)}`,
        subscription_key: `sk_sub_${Math.random().toString(16).slice(2, 18)}`,
        status: "active",
        email_verified_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.users.push(created);
      db.passwords[id] = password;
      // TEN-03：注册即发一封 24h 验证邮件（mock 侧落内存 token，语义对齐后端）
      const now = Date.now();
      db.emailTokens.push({
        token: `mock-verify-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        email,
        purpose: "email_verify",
        expires_at: now + 24 * 60 * 60 * 1000,
        used_at: null,
        created_at: now,
      });
      return ok({
        user: created,
        token: `mock-jwt-${id}`,
        email_verified: false,
        session_cookie: sessionCookieValue(id),
      });
    }
    if (seg[1] === "logout" && method === "POST") return ok({ ok: true });

    /* -------------------- TEN-03 邮箱验证 / 密码重置 -------------------- */
    // 这三个端点与后端 /api/auth/* 同在免认证白名单内（前端可能未登录就点邮件链接），
    // 但各自的业务约束与后端严格一致：
    //   · verify-email：token 单次使用、过期即失效；用途不符拒绝
    //   · forgot-password：**存在与不存在的邮箱返回同一响应**（防枚举）
    //   · resend-verification：需要登录态（后端同理），已验证 → 409，60s 内 → 429
    //   · reset-password：token 单次使用；成功后所有未用 token 一并作废
    if (seg[1] === "verify-email" && method === "GET") {
      const token = reqStr(q?.token);
      if (!token) return fail(400, "验证链接无效");
      const row = db.emailTokens.find((x) => x.token === token && x.purpose === "email_verify");
      if (!row || row.used_at !== null || row.expires_at <= Date.now()) {
        return fail(400, "验证链接无效或已使用");
      }
      row.used_at = Date.now();
      const target = db.users.find((u) => u.email.toLowerCase() === row.email);
      if (target) target.email_verified_at = nowIso();
      return ok({ status: "verified", message: "邮箱验证成功" });
    }

    if (seg[1] === "forgot-password" && method === "POST") {
      const body = asRecord(req.body);
      const email = reqStr(body.email).toLowerCase();
      if (!email) return badRequest("邮箱不能为空");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
      // 防枚举：无论邮箱是否存在都返回同一响应，且已发出未过期重置信时不重复发
      const unused = db.emailTokens.find(
        (x) => x.email === email && x.purpose === "password_reset" && x.used_at === null,
      );
      if (!unused || unused.expires_at <= Date.now()) {
        const now = Date.now();
        for (const t of db.emailTokens) {
          if (t.email === email && t.purpose === "password_reset" && t.used_at === null) t.used_at = now;
        }
        db.emailTokens.push({
          token: `mock-reset-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          email,
          purpose: "password_reset",
          expires_at: now + 60 * 60 * 1000, // 1h，与后端一致
          used_at: null,
          created_at: now,
        });
      }
      return ok({ ok: true, expires_in: 3600 });
    }

    if (seg[1] === "resend-verification" && method === "POST") {
      if (!logged) return fail(401, "Unauthorized");
      // 注意：`user` 常量在下方登录闸之后才声明，这里显式取一次会话用户
      const me = userFromCookie(db, req.cookie);
      if (me.email_verified_at) return fail(409, "邮箱已完成验证");
      const now = Date.now();
      const last = db.emailTokens
        .filter((x) => x.email === me.email.toLowerCase() && x.purpose === "email_verify" && x.used_at === null)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (last && now - last.created_at < 60_000) return fail(429, "请求过于频繁，请稍后再试");
      for (const t of db.emailTokens) {
        if (t.email === me.email.toLowerCase() && t.purpose === "email_verify" && t.used_at === null) t.used_at = now;
      }
      db.emailTokens.push({
        token: `mock-verify-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        email: me.email.toLowerCase(),
        purpose: "email_verify",
        expires_at: now + 24 * 60 * 60 * 1000, // 24h，与后端一致
        used_at: null,
        created_at: now,
      });
      return ok({ ok: true, expires_in: 24 * 60 * 60 });
    }

    if (seg[1] === "reset-password" && method === "POST") {
      const body = asRecord(req.body);
      const token = reqStr(body.token);
      const password = reqStr(body.password);
      if (!token) return fail(400, "重置链接无效或已过期");
      if (password.length < 8) return fail(400, "密码至少 8 位");
      const row = db.emailTokens.find((x) => x.token === token && x.purpose === "password_reset");
      if (!row || row.used_at !== null || row.expires_at <= Date.now()) {
        return fail(400, "重置链接无效或已过期");
      }
      const target = db.users.find((u) => u.email.toLowerCase() === row.email);
      if (!target) return fail(400, "重置链接无效或已过期");
      row.used_at = Date.now();
      db.passwords[target.id] = password;
      // 所有未用 token（含邮箱验证信）一并作废
      const now = Date.now();
      for (const t of db.emailTokens) {
        if (target && t.email === target.email.toLowerCase() && t.used_at === null) t.used_at = now;
      }
      return ok({ ok: true });
    }
  }

  // 以下全部需要登录
  if (!logged) return fail(401, "Unauthorized");
  const user = userFromCookie(db, req.cookie);

  // Mock resource storage remains user-based demonstration data, not evidence
  // of real DB tenant isolation. Selected scope still exercises RBAC contracts.
  const scopeId = req.workspaceId ?? db.workspaces.find((w) => w.personal_user_id === user.id)?.id;
  const scopeMembership = db.workspaceMembers.find((m) => m.workspace_id === scopeId && m.user_id === user.id && m.active);
  // Route Profile 与 node-groups 同资源族（后端 `resolveWorkspaceAccess(c, action, "node")`）：
  // GET → read，写 → manage。
  if (seg[0] === "nodes" || seg[0] === "node-groups" || seg[0] === "forwards" || seg[0] === "route-profiles") {
    if (!scopeMembership) return notFound("工作空间不存在");
    const grants = mockEffectivePermissions(db, scopeMembership);
    const resource = seg[0] === "forwards" ? "forward" : "node";
    const action = method === "GET" ? "read" : resource === "node" ? "manage" :
      method === "DELETE" ? "delete" : method === "POST" && seg[1] === undefined ? "create" : "update";
    if (!grants.permissions[`${resource}:${action}` as keyof typeof grants.permissions]) return fail(403, "工作空间角色无权操作", "permission_denied");
    if (resource === "forward" && method !== "GET" && parseId(seg[1]) !== null && grants.forward_mutations === "own") {
      const tunnel = db.tunnels.find((row) => row.id === parseId(seg[1]));
      if (!tunnel || tunnel.user_id !== user.id) return fail(403, "只能修改本人创建的转发");
    }
  }

  const ctx: rt.MockAuthedRouteContext = { method, clean, seg, q, db, user, req, scopeId };
  {
    const result = await handleWorkspacesMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleDashboardMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleNodesMock(ctx);
    if (result) return result;
  }
  // DDNS 必须排在 `handleForwardsMock` **之前**：后者把整个 `/forwards/*` 命名空间认领了，
  // 未识别的子路径直接在它内部返回 404（`handlers/forwards.ts:592`），所以放在它之后
  // 永远轮不到这里。两个路径都很精确（`/ddns/providers*`、`/forwards/:id/dns`），
  // 不会抢走既有分支；`/forwards/**` 的 forward 族 RBAC 闸门在上面已经查过。
  {
    const result = await handleDdnsMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleForwardsMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleTunnelsMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleCatalogMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleCommerceMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleSettingsMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleRouteProfilesMock(ctx);
    if (result) return result;
  }
  {
    const result = await handleAdminMock(ctx);
    if (result) return result;
  }
  return notFound(`Mock route not found: ${method} /${clean}`);
}

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
import { mockCapabilitiesReport } from "../capabilities";
import type { MockRequest, MockResponse, Store, MockForwardBatchAction, MockForwardBatchItemResult } from "../runtime";

const { TLS_PATH_ERROR_MESSAGES, SESSION_COOKIE, GB, sessionCookieValue, CYCLE_DAYS, COUPONS, ADMIN_RESOURCES, ADMIN_RESOURCE_KEYS, sanitizePermissions, TOPUP_AUTO_SETTLE_MS, nowIso, ok, fail, badRequest, notFound, failFlat, isLoggedIn, userFromCookie, paginate, MOCK_FORWARD_SORT_FIELDS, sortMockForwards, filterByKeyword, filterByStatus, nextId, asRecord, reqStr, numOrNull, reqNum, required, pick, parseList, isResponse, parseId, groupRef, withGroupStats, tunnelTrafficSeries, creditBalance, settleTopup, autoSettleTopups, payUrlFor, topupOrderNo, dashboardStats, adminStats, readPlanPayload, readNodeGroupPayload, readNodePayload, mockPoolTargetHealth, noEvidenceTargetView, handleEgressPools, nextPoolId, nextTargetId, APPLY_STATUSES, TUNNEL_MODES, FORWARD_BATCH_ACTIONS, FORWARD_BATCH_MAX_IDS, applyStatusOf, hasV3Columns, completeOrchestration, poolOfNode, poolRef, tunnelRuntimeAction, MOCK_ATTENTION_MAX_ITEMS, mockAttention, mockUserNode, mockBindingUsage, mockBindingView, healthWorld, impactWorld, mockIngressNode, parseMockTarget, mockForwardView, mockEnrollment, seed, poolTargetKey, getStore, resetStore, handleFederationMock, handleRouteProfileMock, mockFleetHealth, mockNodeHealth, mockResolveNode, MOCK_LIFECYCLES, MOCK_LIFECYCLE_NOTE_MAX, mockAllowedTransitions, mockCanTransition, mockDeleteGates, mockImpact, mockLifecycleChange, mockLifecycleOf, mockLifecycleView, mockRoleCheck, mockUserNodeStatus, applyMockForwardPatch, previewMockForwardUpdate, applyErrorIsRetryable, DEFAULT_FORWARD_PROTOCOL, forwardProtocolFact, forwardProtocolSupported, isForwardProtocol, tlsPathFieldErrors, mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } = rt;

export async function handleWorkspacesMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "workspaces") {
    // POST /workspaces/invites/accept（注意：必须早于 /:id 分支，避免 "invites" 被当成 ID）
    if (seg[1] === "invites" && seg[2] === "accept" && method === "POST") {
      const body = asRecord(req.body);
      const token = reqStr(body.token);
      const invite = db.workspaceInvites.find(
        (x) => x.token === token && x.accepted_at === null && x.revoked_at === null && x.expires_at > Date.now(),
      );
      if (!invite || invite.email !== user.email.toLowerCase()) {
        return fail(404, "邀请不存在或已失效", "INVITE_INVALID");
      }
      const prior = db.workspaceMembers.find(
        (m) => m.workspace_id === invite.workspace_id && m.user_id === user.id,
      );
      if (prior?.active) return fail(409, "邀请已使用", "INVITE_ALREADY_MEMBER");
      invite.accepted_at = Date.now();
      db.workspaceMembers.push({
        id: nextId(db.workspaceMembers),
        workspace_id: invite.workspace_id,
        user_id: user.id,
        role: invite.role,
        active: true,
        created_at: nowIso(),
      });
      return ok({ workspace_id: invite.workspace_id });
    }

    // GET /workspaces：当前用户的所有 active 成员关系（含个人空间），带 role
    if (method === "GET" && seg[1] === undefined) {
      const mine = db.workspaceMembers.filter((m) => m.user_id === user.id && m.active);
      const rows: Workspace[] = [];
      for (const m of mine) {
        const ws = db.workspaces.find((w) => w.id === m.workspace_id);
        if (!ws) continue;
        rows.push({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          kind: ws.kind,
          role: m.role,
          created_at: ws.created_at,
        });
      }
      rows.sort((a, b) => a.id - b.id);
      return ok(rows);
    }

    // POST /workspaces：创建团队空间，创建者为 owner（mock 同步发默认策略由后端负责）
    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const name = reqStr(body.name);
      if (!name || name.length > 120) return badRequest("工作空间名称必须为 1–120 个字符");
      const id = nextId(db.workspaces);
      const ws: Workspace = {
        id,
        name,
        slug: `team-${Date.now().toString(36)}`,
        kind: "team",
        created_at: nowIso(),
        role: "owner",
      };
      db.workspaces.push({
        id,
        slug: ws.slug,
        name,
        kind: "team",
        personal_user_id: null,
        created_by_id: user.id,
        created_at: nowIso(),
      });
      db.workspaceMembers.push({
        id: nextId(db.workspaceMembers),
        workspace_id: id,
        user_id: user.id,
        role: "owner",
        active: true,
        created_at: nowIso(),
      });
      return ok(ws);
    }

    // /workspaces/:id[/...]
    const id = parseId(seg[1]);
    if (id !== null) {
      const membership = db.workspaceMembers.find(
        (m) => m.workspace_id === id && m.user_id === user.id && m.active,
      );
      const ws = db.workspaces.find((w) => w.id === id);
      if (!membership || !ws || (req.workspaceId !== undefined && req.workspaceId !== id)) return notFound("工作空间不存在");

      const effective = mockEffectivePermissions(db, membership);
      if (method === "GET" && seg[2] === "permissions") return ok(effective);
      if (seg[2] === "roles") {
        if (!effective.permissions[method === "GET" ? "member:read" : "member:manage"]) return fail(403, "无权管理工作空间角色");
        const roleId = parseId(seg[3]);
        const role = db.workspaceRoles.find((r) => r.id === roleId && r.workspace_id === id);
        if (method === "GET" && seg[3] === undefined) return ok(db.workspaceRoles.filter((r) => r.workspace_id === id));
        if (method === "DELETE") {
          if (!role) return notFound("角色不存在");
          if (!mockGrantSubset(effective, role.permissions)) return fail(403, "不能管理超出本人权限的角色");
          if (db.workspaceMembers.some((m) => m.role_id === role.id)) return fail(409, "角色仍被成员绑定，请先显式调整成员角色");
          db.workspaceRoles = db.workspaceRoles.filter((r) => r !== role);
          return ok({ ok: true });
        }
        if (method === "POST" || method === "PATCH") {
          if (method === "PATCH" && !role) return notFound("角色不存在");
          if (role && !mockGrantSubset(effective, role.permissions)) return fail(403, "不能管理超出本人权限的角色");
          const body = asRecord(req.body);
          const name = body.name === undefined ? role?.name : reqStr(body.name);
          const description = body.description === undefined ? role?.description ?? null : body.description;
          const perms = body.permissions === undefined ? role?.permissions : body.permissions;
          if (!name || name.length > 120 || (description !== null && (typeof description !== "string" || description.length > 255)) || !validMockRolePermissions(perms)) return badRequest("角色名称、说明或权限不合法");
          if (!mockGrantSubset(effective, perms)) return fail(403, "不能授予超出本人权限的权限");
          if (db.workspaceRoles.some((r) => r.workspace_id === id && r.id !== roleId && r.name === name)) return fail(409, "角色名称已存在");
          if (role && db.workspaceMembers.some((m) => m.role_id === role.id && m.role === "owner")) return fail(403, "不能影响 owner 角色");
          const value = { id: role?.id ?? nextId(db.workspaceRoles), workspace_id: id, name, description, permissions: { ...perms } };
          if (role) Object.assign(role, value); else db.workspaceRoles.push(value);
          return { status: role ? 200 : 201, body: value };
        }
      }
      if (method === "PATCH" && seg[2] === "members" && seg[4] === "role") {
        if (!effective.permissions["member:manage"]) return fail(403, "无权管理成员角色");
        const target = db.workspaceMembers.find((m) => m.workspace_id === id && m.user_id === parseId(seg[3]));
        if (!target) return notFound("成员不存在");
        if (target.role === "owner") return fail(403, "不能更改 owner 角色");
        const body = asRecord(req.body);
        if (Object.keys(body).length !== 1 || (!Object.hasOwn(body, "role_id") && !Object.hasOwn(body, "role"))) return badRequest("必须选择一种角色载荷");
        if (Object.hasOwn(body, "role_id")) {
          if (body.role_id !== null && (!Number.isSafeInteger(body.role_id) || Number(body.role_id) < 1)) return badRequest("非法角色 ID");
          const assigned = db.workspaceRoles.find((r) => r.workspace_id === id && r.id === body.role_id);
          if (body.role_id !== null && !assigned) return notFound("角色不存在");
          const candidate = assigned?.permissions ?? mockBasePermissions(target.role);
          if (!mockGrantSubset(effective, candidate)) return fail(403, "不能授予超出本人权限的角色");
          target.role_id = body.role_id as number | null;
        } else {
          if (body.role !== "admin" && body.role !== "member" && body.role !== "viewer") return badRequest("基础角色不合法");
          if (!mockGrantSubset(effective, mockBasePermissions(body.role))) return fail(403, "不能授予超出本人权限的角色");
          target.role = body.role; target.role_id = null;
        }
        return ok({ user_id: target.user_id, workspace_id: id, role: target.role, role_id: target.role_id, active: target.active });
      }

      // GET /:id/members：任一 active 成员可读
      if (method === "GET" && seg[2] === "members") {
        if (!effective.permissions["member:read"]) return fail(403, "没有查看成员权限");
        const rows: WorkspaceMember[] = db.workspaceMembers
          .filter((m) => m.workspace_id === id && m.active)
          .map((m) => {
            const u = db.users.find((x) => x.id === m.user_id);
            return { user_id: m.user_id, email: u?.email ?? "", role: m.role, role_id: m.role_id ?? null, custom_role_id: m.role_id ?? null, custom_role_name: db.workspaceRoles.find((r) => r.id === m.role_id && r.workspace_id === id)?.name ?? null, created_at: m.created_at };
          })
          .sort((a, b) => a.user_id - b.user_id);
        return ok(rows);
      }

      // GET /:id/traffic：workspace 流量聚合（OPS-03，与后端 /workspaces/:id/traffic 同构）
      if (method === "GET" && seg[2] === "traffic") {
        const days = Math.max(1, Math.min(90, Number(q?.days ?? 14) || 14));
        // mock 里没有 workspace_id 归属的隧道集合，用 demo 用户的隧道近似：
        // 按隧道累计流量 {traffic, traffic_cost} 拆分到各隧道分组 + 补齐日界序列。
        const mine = db.tunnels.filter((t) => t.user_id === user.id);
        const rows: WorkspaceTrafficSummary["by_tunnel"] = mine.map((t) => ({
          tunnel_id: t.id,
          name: t.name,
          tunnel_type: t.tunnel_type,
          in_node_group_id: t.in_node_group_id,
          in_node_group_name: t.in_node_group?.name ?? null,
          traffic: Number((t.traffic / GB).toFixed(2)),
          traffic_cost: Number((t.traffic_cost ?? t.traffic / GB).toFixed(2)),
        }));
        const by_tunnel: WorkspaceTrafficSummary["by_tunnel"] = [...rows].sort(
          (a, b) => b.traffic - a.traffic || a.tunnel_id - b.tunnel_id,
        );
        const total_traffic = Number(by_tunnel.reduce((s, x) => s + x.traffic, 0).toFixed(2));
        const total_traffic_cost = Number(by_tunnel.reduce((s, x) => s + x.traffic_cost, 0).toFixed(2));
        const gb = (n: number) => Math.round(n * 1024 * 1024 * 1024);
        const by_day = Array.from({ length: days }, (_, i) => {
          const wave = 0.6 + Math.abs(Math.sin(i * 0.9)) * 0.8;
          const t = gb(Number(((total_traffic / days) * wave).toFixed(3)));
          return {
            date: new Date(seed.now.getTime() - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
            traffic: t,
            traffic_cost: Number(((total_traffic_cost / days) * wave).toFixed(4)),
          };
        });
        const summary: WorkspaceTrafficSummary = {
          workspace_id: id,
          period: "total",
          since: new Date(seed.now.getTime() - (days - 1) * 86400000).toISOString(),
          total_traffic: gb(total_traffic),
          total_traffic_cost: total_traffic_cost,
          by_tunnel: by_tunnel.map((x) => ({ ...x, traffic: gb(x.traffic), traffic_cost: x.traffic_cost })),
          by_day,
          orphan_rows: 0,
        };
        return ok(summary);
      }

      // POST /:id/invites：仅 team + owner/admin；重复邮箱 409；成员+待接受邀请上限 5
      if (method === "POST" && seg[2] === "invites") {
        if (ws.kind !== "team" || !effective.permissions["member:manage"]) {
          return fail(403, "没有邀请权限", "FORBIDDEN");
        }
        const body = asRecord(req.body);
        const email = reqStr(body.email).toLowerCase();
        const role = (reqStr(body.role) || "member") as WorkspaceRole;
        if (!email || !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return badRequest("邮箱或角色不合法");
        if (role !== "admin" && role !== "member" && role !== "viewer") return badRequest("邮箱或角色不合法");
        if (db.workspaceMembers.some((m) => {
          const u = db.users.find((x) => x.id === m.user_id);
          return m.workspace_id === id && m.active && u?.email.toLowerCase() === email;
        })) {
          return fail(409, "该用户已经是工作空间成员", "ALREADY_MEMBER");
        }
        const activeCount = db.workspaceMembers.filter((m) => m.workspace_id === id && m.active).length;
        const pendingCount = db.workspaceInvites.filter(
          (x) => x.workspace_id === id && x.accepted_at === null && x.revoked_at === null && x.expires_at > Date.now(),
        ).length;
        const limit = 5;
        if (activeCount + pendingCount >= limit) {
          return fail(403, `工作空间成员数已达上限（${limit}）`, "MAX_MEMBERS");
        }
        // 重新邀请会把该邮箱旧的未用邀请作废（与后端 updateMany 语义一致）
        for (const old of db.workspaceInvites) {
          if (old.workspace_id === id && old.email === email && old.accepted_at === null && old.revoked_at === null) {
            old.revoked_at = Date.now();
          }
        }
        const token = `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
        const invite: MockWorkspaceInvite = {
          id: nextId(db.workspaceInvites),
          workspace_id: id,
          email,
          role,
          token,
          invited_by_id: user.id,
          expires_at: Date.now() + 7 * 86400000,
          accepted_at: null,
          revoked_at: null,
          created_at: Date.now(),
        };
        db.workspaceInvites.push(invite);
        const created: WorkspaceInvite = {
          id: invite.id,
          email,
          role,
          expires_at: new Date(invite.expires_at).toISOString(),
          token,
        };
        return ok(created);
      }

      // DELETE /:id/members/:userId：manage 角色，或 actor===target（退出）；owner 不可移除
      if (method === "DELETE" && seg[2] === "members" && parseId(seg[3]) !== null) {
        const targetId = parseId(seg[3])!;
        const target = db.workspaceMembers.find(
          (m) => m.workspace_id === id && m.user_id === targetId && m.active,
        );
        if (!target) return notFound("成员不存在");
        if (target.role === "owner") return fail(403, "不能移除 owner", "FORBIDDEN");
        if (user.id !== targetId && !effective.permissions["member:manage"]) {
          return fail(403, "没有移除权限", "FORBIDDEN");
        }
        target.active = false;
        return ok({ ok: true });
      }

      // GET /:id：当前空间详情（前端暂未使用，保留以对齐后端契约）
      if (method === "GET" && seg[2] === undefined) {
        return ok({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          kind: ws.kind,
          created_at: ws.created_at,
          role: membership.role,
        });
      }
    }
  }

  // ---------- me（R2 首启：当前工作空间的有效能力 / 额度 / 用量）----------
  // 与后端 `routes/me.ts` 同形：作用域由请求里的 workspace（`scopeId`）决定，
  // 权限/额度/entitlement 全部来自该工作空间的有效策略，跨空间不串。
  if (seg[0] === "me" && seg[1] === "capabilities" && method === "GET") {
    // 与后端逐字同形：`c.json({ data: report })`。
    return ok({ data: mockCapabilitiesReport(db, scopeId) });
  }

  // ---------- dashboard ----------
  return null;
}

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

export async function handleCatalogMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "node-groups") {
    if (method === "GET" && seg[1] === undefined) {
      const items = filterByStatus(db.nodeGroups, q).map((g) => withGroupStats(db, g));
      return ok(paginate(items, q));
    }

    const groupId = parseId(seg[1]);
    if (method === "POST" && groupId !== null && seg[2] === "nodes") {
      const group = db.nodeGroups.find((row) => row.id === groupId);
      if (!group) return notFound("节点组不存在");
      const body = asRecord(req.body);
      const nodeKey = reqStr(body.node_id);
      if (!nodeKey) return badRequest("node_id / connect_ip / role 不合法");
      if (db.nodes.some((node) => node.node_id === nodeKey)) {
        return fail(409, "节点 ID 已存在", "NODE_EXISTS");
      }

      const roleRaw = reqStr(body.role);
      const role =
        roleRaw === "ingress" || roleRaw === "egress" || roleRaw === "both"
          ? roleRaw
          : group.node_type === "out"
            ? "egress"
            : "ingress";
      const range = group.port_range?.split("-").map(Number) ?? [];
      const portMin = range.length === 2 && Number.isInteger(range[0]) ? range[0]! : null;
      const portMax = range.length === 2 && Number.isInteger(range[1]) ? range[1]! : null;
      if (
        portMin === null ||
        portMax === null ||
        portMin < 1 ||
        portMax > 65535 ||
        portMin > portMax
      ) {
        return fail(409, "节点组未配置可用于 v3 的连续端口范围", "PORT_RANGE_REQUIRED");
      }

      const id = nextId(db.nodes);
      const created: Node = {
        id,
        node_id: nodeKey,
        agent_id: `mock-agent-${id}-${Math.random().toString(36).slice(2, 8)}`,
        weight: 10,
        status: "active",
        connect_ip: reqStr(body.connect_ip) || null,
        version: "pending",
        backup: false,
        order_by: db.nodes.reduce((max, node) => Math.max(max, node.order_by), 0) + 10,
        custom_line: null,
        dns_status: false,
        node_group_id: group.id,
        node_group: { id: group.id, name: group.name, node_type: group.node_type },
        created_at: nowIso(),
        updated_at: nowIso(),
        online: false,
        traffic: 0,
        role,
        last_seen_at: null,
        port_range_min: portMin,
        port_range_max: portMax,
        lb_strategy: "round",
        has_credential: false,
        credential_revoked: false,
        credential_rotated_at: null,
        credential_last_rejected_at: null,
      };
      db.nodes.push(created);
      const projected = mockUserNode(db, created);
      return ok({
        node: projected,
        enrollment: mockEnrollment(projected),
      });
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- WP11 / WP13：用户侧可用出口池（创建 RELAY 隧道时选池） ----------
  // admin 侧 WP10 的 /admin/node/pools 是管理端全量视图（需要 admin 权限）；
  // 用户侧只暴露「有出口能力节点上的 active 池」，且只读池内目标摘要，
  // 不下发 node 主键之外的管理字段（不发明字段：字段名与 EgressPool/EgressTarget 对齐）。
  if (seg[0] === "egress-pools" && method === "GET") {
    const options: TunnelEgressPoolOption[] = [];
    for (const [nodeId, pools] of db.egressPools) {
      const node = db.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      // 出口能力：role=egress|both（ingress 节点不配池，§2.2 硬规则）
      if (node.role !== "egress" && node.role !== "both") continue;
      for (const p of pools) {
        if (p.status !== "active") continue;
        options.push({
          id: p.id,
          name: p.name,
          node_id: nodeId,
          node_label: `${node.node_id} (${node.connect_ip})`,
          lb_strategy: p.lb_strategy ?? null,
          status: p.status,
          targets: (db.egressTargets.get(p.id) ?? [])
            .filter((t) => t.status === "active")
            .map((t) => ({ host: t.host, port: t.port, weight: t.weight, status: t.status })),
        });
      }
    }
    const sorted = options.sort((a, b) => a.node_id - b.node_id || a.id - b.id);
    if (q?.pool_id !== undefined) {
      const want = Number(q.pool_id);
      return ok(sorted.filter((p) => p.id === want));
    }
    return ok(sorted);
  }

  // ---------- plans ----------
  if (seg[0] === "plans") {
    if (seg[1] === "purchase" && method === "POST") {
      const body = asRecord(req.body);
      const planId = reqNum(body.plan_id);
      if (planId === undefined) return badRequest("缺少 plan_id");
      const plan = db.plans.find((p) => p.id === planId);
      if (!plan) return notFound("套餐不存在");
      if (plan.status !== "active") return badRequest("该套餐已下架");
      if (plan.stock !== null && plan.stock <= 0) return badRequest("库存不足");

      const setupFee = plan.setup_fee ?? 0;
      let total = plan.price + setupFee;
      const couponCode = reqStr(body.coupon).toUpperCase();
      let couponId: number | null = null;
      if (couponCode) {
        const coupon = COUPONS[couponCode];
        if (!coupon) return badRequest("优惠码无效");
        couponId = 1;
        total = coupon.type === "percent" ? total * (1 - coupon.value / 100) : total - coupon.value;
        total = Number(Math.max(0, total).toFixed(2));
      }
      if (user.balance < total) return badRequest("余额不足，请先充值");

      // 1) 扣款 + 记账
      creditBalance(db, user, -total, "plan");
      if (plan.stock !== null) plan.stock = Math.max(0, plan.stock - 1);

      // 2) 订单
      const order: PlanOrder = {
        id: nextId(db.planOrders),
        user_id: user.id,
        user: { id: user.id, email: user.email },
        plan_id: plan.id,
        plan: { id: plan.id, name: plan.name, price: plan.price, billing_cycle: plan.billing_cycle },
        price: total,
        balance: user.balance,
        coupon_id: couponId,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.planOrders.unshift(order);

      // 3) 订阅：同套餐续期，否则换新
      const days = CYCLE_DAYS[plan.billing_cycle];
      const existing = db.userPlans.find((p) => p.user_id === user.id);
      let userPlan: UserPlan;
      if (existing && existing.plan_id === plan.id) {
        const base = Math.max(Date.now(), existing.expired_at ? Date.parse(existing.expired_at) : Date.now());
        existing.expired_at = plan.billing_cycle === "lifetime" ? null : new Date(base + days * 86400000).toISOString();
        existing.traffic = plan.traffic === null ? null : plan.traffic * GB;
        existing.max_tunnels = plan.max_tunnels;
        existing.plan = plan;
        existing.updated_at = nowIso();
        userPlan = existing;
      } else if (existing) {
        existing.plan_id = plan.id;
        existing.plan = plan;
        existing.expired_at = plan.billing_cycle === "lifetime" ? null : new Date(Date.now() + days * 86400000).toISOString();
        existing.traffic = plan.traffic === null ? null : plan.traffic * GB;
        existing.traffic_used = 0;
        existing.max_tunnels = plan.max_tunnels;
        if (existing.whitelist_ips && plan.whitelist_limit !== null) {
          existing.whitelist_ips = existing.whitelist_ips.slice(0, plan.whitelist_limit);
        }
        existing.updated_at = nowIso();
        userPlan = existing;
      } else {
        userPlan = {
          id: nextId(db.userPlans),
          user_id: user.id,
          traffic: plan.traffic === null ? null : plan.traffic * GB,
          traffic_used: 0,
          max_tunnels: plan.max_tunnels,
          whitelist_ips: null,
          expired_at: plan.billing_cycle === "lifetime" ? null : new Date(Date.now() + days * 86400000).toISOString(),
          plan_id: plan.id,
          plan,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.userPlans.push(userPlan);
      }
      user.user_plan = userPlan;

      return ok({
        ok: true,
        order_id: order.id,
        plan_id: plan.id,
        price: total,
        balance: user.balance,
        user_plan: userPlan,
      });
    }

    if (method === "GET" && seg[1] === undefined) {
      return ok(paginate(filterByStatus(filterByKeyword(db.plans, q, ["name"]), q), q));
    }
    const id = parseId(seg[1]);
    if (method === "GET" && id !== null) {
      const plan = db.plans.find((p) => p.id === id);
      return plan ? ok(plan) : notFound("套餐不存在");
    }
  }

  // ---------- payments / topups ----------
  return null;
}

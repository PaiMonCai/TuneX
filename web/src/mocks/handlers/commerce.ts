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

export async function handleCommerceMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "payments" && method === "GET") {
    return ok(
      db.payments
        .filter((p) => p.status === "active")
        .sort((a, b) => a.order_by - b.order_by)
        .map((p) => ({ id: p.id, name: p.name, method: p.method })),
    );
  }

  if (seg[0] === "topups") {
    if (method === "GET" && seg[1] === undefined) {
      autoSettleTopups(db);
      const mine = db.topupOrders.filter((o) => o.user_id === user.id);
      return ok(paginate(filterByStatus(filterByKeyword(mine, q, ["order_id"]), q), q));
    }

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const amount = numOrNull(body.amount);
      if (amount === null) return badRequest("充值金额必须是数字");
      if (amount < 1) return badRequest("单次充值最少 ¥1.00");
      if (amount > 100000) return badRequest("单次充值最多 ¥100000.00");
      const payment = db.payments.find((p) => p.id === reqNum(body.payment_id));
      if (!payment) return badRequest("支付方式不可用");
      if (payment.status !== "active") return badRequest("支付方式已停用");

      const bonus = amount >= 100 ? Number((amount * 0.05).toFixed(2)) : 0;
      const order_id = topupOrderNo(db);
      const order: TopupOrder = {
        id: nextId(db.topupOrders),
        user_id: user.id,
        user: { id: user.id, email: user.email },
        price: Number(amount.toFixed(2)),
        balance: 0,
        bonus,
        payment_id: payment.id,
        payment: { id: payment.id, name: payment.name, method: payment.method },
        pay_url: payUrlFor(order_id, payment),
        status: "pending",
        order_id,
        trade_id: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.topupOrders.unshift(order);
      // auto_pay / settle=true：立即模拟支付成功（便于自动化与演示）
      if (Boolean(body.auto_pay) || Boolean(body.settle)) settleTopup(db, order);
      return ok(order);
    }

    const id = parseId(seg[1]);
    if (id !== null) {
      const order = db.topupOrders.find((o) => o.id === id && o.user_id === user.id);
      if (!order) return notFound("充值订单不存在");
      if (method === "GET" && seg[2] === undefined) return ok(order);
      if (method === "POST" && (seg[2] === "pay" || seg[2] === "settle")) {
        if (order.status !== "pending") return badRequest("该订单已结束，无法支付");
        return ok(settleTopup(db, order));
      }
      if (method === "POST" && seg[2] === "cancel") {
        if (order.status !== "pending") return badRequest("该订单已结束，无法取消");
        order.status = "cancelled";
        order.updated_at = nowIso();
        return ok(order);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- tickets ----------
  if (seg[0] === "tickets") {
    if (method === "GET" && seg[1] === undefined) {
      const mine = db.tickets.filter((t) => t.user_id === user.id);
      return ok(paginate(filterByStatus(filterByKeyword(mine, q, ["title"]), q), q));
    }
    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const titleR = required(body, "title", "工单标题", 100);
      if (isResponse(titleR)) return titleR;
      const contentR = required(body, "content", "工单内容", 5000);
      if (isResponse(contentR)) return contentR;
      const ticket: Ticket = {
        id: nextId(db.tickets),
        title: titleR.value,
        content: contentR.value,
        status: "open",
        user_id: user.id,
        user: { id: user.id, email: user.email },
        replies: [],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.tickets.unshift(ticket);
      return ok(ticket);
    }
    const id = parseId(seg[1]);
    if (id !== null) {
      const ticket = db.tickets.find((t) => t.id === id && t.user_id === user.id);
      if (!ticket) return notFound("工单不存在");
      if (method === "GET" && seg[2] === undefined) return ok(ticket);
      if ((method === "PUT" || method === "PATCH") && seg[2] === undefined) {
        const body = asRecord(req.body);
        if (body.status !== undefined) {
          const s = reqStr(body.status);
          if (s !== "open" && s !== "closed") return badRequest("工单状态不合法");
          ticket.status = s;
        }
        if (body.title !== undefined) {
          const r = required(body, "title", "工单标题", 100);
          if (isResponse(r)) return r;
          ticket.title = r.value;
        }
        ticket.updated_at = nowIso();
        return ok(ticket);
      }
      if (method === "DELETE" && seg[2] === undefined) {
        db.tickets.splice(db.tickets.indexOf(ticket), 1);
        return ok({ ok: true, id: ticket.id });
      }
      if (method === "POST" && seg[2] === "replies") {
        const body = asRecord(req.body);
        const contentR = required(body, "content", "回复内容", 5000);
        if (isResponse(contentR)) return contentR;
        if (ticket.status === "closed") return badRequest("工单已关闭，无法回复");
        const reply: TicketReply = {
          id: nextId(ticket.replies ?? []),
          content: contentR.value,
          is_admin: Boolean(body.is_admin) || user.super_admin,
          ticket_id: ticket.id,
          user_id: user.id,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        ticket.replies = [...(ticket.replies ?? []), reply];
        ticket.updated_at = nowIso();
        return ok(reply);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- settings（个人中心） ----------
  return null;
}

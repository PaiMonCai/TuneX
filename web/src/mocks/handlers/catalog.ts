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
import { mockCapabilityPolicyFor, mockGroupVisibleInScope } from "../capabilities";
import type { MockRequest, MockResponse, Store, MockForwardBatchAction, MockForwardBatchItemResult } from "../runtime";

const { TLS_PATH_ERROR_MESSAGES, SESSION_COOKIE, GB, sessionCookieValue, CYCLE_DAYS, COUPONS, ADMIN_RESOURCES, ADMIN_RESOURCE_KEYS, sanitizePermissions, TOPUP_AUTO_SETTLE_MS, nowIso, ok, fail, badRequest, notFound, failFlat, isLoggedIn, userFromCookie, paginate, MOCK_FORWARD_SORT_FIELDS, sortMockForwards, filterByKeyword, filterByStatus, nextId, asRecord, reqStr, numOrNull, reqNum, required, pick, parseList, isResponse, parseId, groupRef, withGroupStats, tunnelTrafficSeries, creditBalance, settleTopup, autoSettleTopups, payUrlFor, topupOrderNo, dashboardStats, adminStats, readPlanPayload, readNodeGroupPayload, readNodePayload, mockPoolTargetHealth, noEvidenceTargetView, handleEgressPools, nextPoolId, nextTargetId, APPLY_STATUSES, TUNNEL_MODES, FORWARD_BATCH_ACTIONS, FORWARD_BATCH_MAX_IDS, applyStatusOf, hasV3Columns, completeOrchestration, poolOfNode, poolRef, tunnelRuntimeAction, MOCK_ATTENTION_MAX_ITEMS, mockAttention, mockUserNode, mockBindingUsage, mockBindingView, healthWorld, impactWorld, mockIngressNode, parseMockTarget, mockForwardView, mockEnrollment, seed, poolTargetKey, getStore, resetStore, handleFederationMock, handleRouteProfileMock, mockFleetHealth, mockNodeHealth, mockResolveNode, MOCK_LIFECYCLES, MOCK_LIFECYCLE_NOTE_MAX, mockAllowedTransitions, mockCanTransition, mockDeleteGates, mockImpact, mockLifecycleChange, mockLifecycleOf, mockLifecycleView, mockRoleCheck, mockUserNodeStatus, applyMockForwardPatch, previewMockForwardUpdate, applyErrorIsRetryable, DEFAULT_FORWARD_PROTOCOL, forwardProtocolFact, forwardProtocolSupported, isForwardProtocol, tlsPathFieldErrors, mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } = rt;

/**
 * 节点创建的能力/额度门控（镜像真机 `services/capability-policy.ts:checkNodeCreation`）。
 *
 * ── 为什么 mock 必须有它 ──
 * 旧 mock 的 provision 分支没有这道门：真机在 `max_nodes=1 / used=7` 下返回
 * `403 {code:"node_limit"}`，mock 却连发 5 次 201（used 一路涨到 12）——
 * "额度耗尽"这条最该在本地看到的失败路径，在 mock 里**永远看不到**。
 *
 * ── 计数口径 ──
 * 真机：`node.count({ where: { node_group: { workspace_id } } })`，即"**这个空间自己的组**里的行"。
 * mock 的对应物是 `nodeGroupWorkspace`（组 → 归属空间）：**种子组不在表里**
 * （它们是跨作用域演示数据，见 `capabilities.ts:mockGroupVisibleInScope`），
 * 所以演示种子那 7 行不计入任何空间的用量 —— 这条差异是 mock 的既有约定，
 * 已记入 `docs/agent/productization-status.md` 的"mock 与真实剩余分叉"表。
 *
 * ── 拒绝形状 ──
 * 真机 `routes/node-groups.ts`：`403 { error: <describeDeny 文案>, code: <reason> }`。
 * `no_active_policy`（空间没有任何生效策略）同样 fail-closed 拒绝，绝不默认放行。
 */
function mockCheckNodeCreation(
  db: Store,
  scopeId: number | undefined,
): { allowed: true } | { allowed: false; code: string; message: string } {
  const policy = mockCapabilityPolicyFor(db, scopeId);
  if (policy === undefined) {
    return { allowed: false, code: "no_active_policy", message: "工作空间没有任何生效的能力策略" };
  }
  const nodeCount = db.nodes.filter(
    (node) => db.nodeGroupWorkspace.get(node.node_group_id) === scopeId,
  ).length;
  const max = policy.max_nodes;
  if (max !== null && nodeCount >= max) {
    // 与后端 `describeDeny("node_limit")` 同文案
    return { allowed: false, code: "node_limit", message: `已达节点数量上限（${max} 个）` };
  }
  return { allowed: true };
}

export async function handleCatalogMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "node-groups") {
    if (method === "GET" && seg[1] === undefined) {
      // Workspace 隔离：种子组是跨作用域演示数据，**用户自建的组只在创建它的空间可见**。
      const visible = db.nodeGroups.filter((g) => mockGroupVisibleInScope(db, g.id, scopeId));
      const items = filterByStatus(visible, q).map((g) => withGroupStats(db, g));
      return ok(paginate(items, q));
    }

    /**
     * R2 自助建组（对齐后端 `routes/node-groups.ts` 的 `POST /`）。
     *
     * 三段判定与后端同序：形状校验（400）→ entitlement 门控（403
     * `custom_group_not_allowed`）→ 创建（201，`token` 只在这份响应里出现一次）。
     * 后端在这个端点上**没有**节点额度判定（`withWorkspaceQuotaLock` 只查
     * entitlement），mock 不发明一个后端不存在的 403 `node_limit`。
     */
    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const name = reqStr(body.name);
      const nodeType = reqStr(body.node_type);
      if (name === "" || name.length > 60 || (nodeType !== "in" && nodeType !== "out")) {
        return badRequest("节点组名称、方向或端口范围不合法");
      }
      const portRange = reqStr(body.port_range);
      if (portRange !== "") {
        const range = /^(\d{1,5})-(\d{1,5})$/.exec(portRange);
        if (!range) return badRequest("节点组名称、方向或端口范围不合法");
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start < 1 || end > 65535 || start > end) return badRequest("端口范围不合法");
      }
      const policy = mockCapabilityPolicyFor(db, scopeId);
      const allowed =
        nodeType === "in" ? policy?.allow_custom_in_group === true : policy?.allow_custom_out_group === true;
      if (!allowed) {
        return fail(
          403,
          `当前策略不允许自建${nodeType === "in" ? "入口" : "出口"}节点组`,
          "custom_group_not_allowed",
        );
      }
      const id = nextId(db.nodeGroups);
      const created: NodeGroup = {
        id,
        token: `ng_${id}_${Math.random().toString(36).slice(2, 10)}`,
        name,
        port_range: portRange === "" ? null : portRange,
        connect_ip: null,
        node_type: nodeType,
        load_balance_type: "round",
        allow_listen_protocol: true,
        allow_listen_protocols: ["tcp", "udp"],
        allow_tunnel_types: null,
        bypass_type: "blacklist",
        bypass_list: null,
        admission: false,
        block_protocols: null,
        traffic_rate: 1,
        need_out_node_group: nodeType === "in",
        allow_out_node_groups: null,
        allow_in_node_groups: null,
        order_by: db.nodeGroups.reduce((max, g) => Math.max(max, g.order_by), 0) + 10,
        user_id: user.id,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.nodeGroups.push(created);
      db.nodeGroupWorkspace.set(id, scopeId ?? -1);
      // 与后端一致：201 + `{ data: {...} }`（api 层 unwrap 后即为这个对象）。
      return {
        status: 201,
        body: {
          data: {
            id: created.id,
            name: created.name,
            node_type: created.node_type,
            // 组注册凭据：只回显一次，前端**必须**在投影里丢掉（见 lib/api/nodeGroups）。
            token: created.token,
            workspace_id: scopeId ?? null,
          },
        },
      };
    }

    const groupId = parseId(seg[1]);
    if (method === "POST" && groupId !== null && seg[2] === "nodes") {
      const group = db.nodeGroups.find((row) => row.id === groupId);
      if (!group) return notFound("节点组不存在");
      const body = asRecord(req.body);
      const nodeKey = reqStr(body.node_id);
      if (!nodeKey) return badRequest("node_id / connect_ip / role 不合法");

      // 同名语义与真实后端对齐（E2 复核 F6）：**同组同名是 201 重签**，不是 409。
      // 真实后端 `routes/node-groups.ts` 在这条路径上只做 identity/enrollment 重签
      // （行不变、id 不变、role/range/connect_ip 一律不动），旧命令被新的一次性
      // enrollment 取代 —— 这恰恰是用户最需要理解的安全语义，mock 不能演示成报错。
      // 只有**别的节点组**已占用这个 node_id 才是 409（后端那里也没有 code）。
      const existing = db.nodes.find((node) => node.node_id === nodeKey);
      if (existing && existing.node_group_id !== group.id) {
        return { status: 409, body: { error: "node_id 已被其它节点组占用" } };
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
      /**
       * 能力/额度门控 —— **必须在端口区间之前**（与真机同序）。
       *
       * 真机 `routes/node-groups.ts` 在锁内的顺序是：组归属/角色冲突 → **`checkNodeCreation`**
       * → 端口区间，并且注释里写明理由：能力拒绝是**改不了的事实**（去找管理员），
       * 区间未配置是**可修复的状态**；先报区间会把用户指向一条死路（那个空间可能连自建组
       * 都不允许）。这里照抄这个顺序，否则 mock 又会把两种拒绝的先后关系演示反。
       *
       * 旧实现**完全没有**这道门（R5-B 实测：真机 `max_nodes=1 used=7` ⇒ 403
       * `node_limit`，mock 连发 5 次 201、used 一路涨到 12）—— 也就是说"额度耗尽"
       * 这条最该在本地看到的失败路径，在 mock 里永远看不到。
       *
       * 只约束**新建行**：重签（同组同名）不动用量，真机也不看额度（`if (!existing)`）。
       */
      if (!existing) {
        const decision = mockCheckNodeCreation(db, scopeId);
        // 与真机同形：403 `{ error, code }`（`failFlat` 额外带上 `message`，
        // 客户端 `ApiError` 取文案时两条路都能走）。
        if (!decision.allowed) return failFlat(403, decision.message, decision.code);
      }
      if (
        !existing &&
        (portMin === null ||
          portMax === null ||
          portMin < 1 ||
          portMax > 65535 ||
          portMin > portMax)
      ) {
        return failFlat(409, "节点组未配置可用于 v3 的连续端口范围", "PORT_RANGE_REQUIRED");
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
      // 同组同名 → 复用同一行（id 不变）；新名字 → 新建一行。两条路径都返回
      // **新签发的一次性 enrollment**，与真实后端 `createNodeEnrollment` 一致。
      const target = existing ?? created;
      if (!existing) db.nodes.push(created);
      const projected = mockUserNode(db, target);
      // 201（真实后端 provision 恒为 201）+ `{ node, enrollment }`。
      //
      // 形状约定：`handleMock` 的 body 是**剥掉一层 `data` 之后**的视图（与
      // `GET /nodes` 同口径：真实后端 `{ data: [...] }`，mock 直接给数组）。真实后端
      // provision 的原始报文是 `{ data: { node, enrollment } }`，`api` 层的 `post()`
      // 会剥掉那层 `data` 得到 `ProvisionNodeResult = { node, enrollment }` —— 这里
      // 给的就是**同一个**客户端可见形状，创建与重签两条路径完全一致。
      return {
        status: 201,
        body: { node: projected, enrollment: mockEnrollment(projected) },
      };
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

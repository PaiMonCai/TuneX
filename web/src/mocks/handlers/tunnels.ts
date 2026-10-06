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

export async function handleTunnelsMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "tunnels") {
    const id = parseId(seg[1]);
    const sub = seg[2];

    if (method === "GET" && seg[1] === undefined) {
      // WP13：v3 过滤维度（apply_status / tunnel_mode / pending_only）叠加在
      // legacy 过滤之上；未知值一律忽略而不是返回空集（防 UI 传错值静默全空）。
      const applyFilter = reqStr(q?.apply_status);
      const modeFilter = reqStr(q?.tunnel_mode);
      const pendingOnly = q?.pending_only === true || q?.pending_only === "true" || q?.pending_only === "1";
      let mine = db.tunnels.filter((t) => t.user_id === user.id);
      if (APPLY_STATUSES.includes(applyFilter as (typeof APPLY_STATUSES)[number])) {
        mine = mine.filter((t) => applyStatusOf(t) === applyFilter);
      }
      if (TUNNEL_MODES.includes(modeFilter as (typeof TUNNEL_MODES)[number])) {
        mine = mine.filter((t) => t.tunnel_mode === modeFilter);
      }
      if (pendingOnly) {
        mine = mine.filter((t) => {
          const desired = t.config_revision ?? null;
          const applied = t.applied_revision ?? null;
          return desired !== null && applied !== null && applied < desired;
        });
      }
      return ok(paginate(filterByStatus(filterByKeyword(mine, q, ["name"]), q), q));
    }

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const nameR = required(body, "name", "隧道名称", 60);
      if (isResponse(nameR)) return nameR;
      const ngId = reqNum(body.in_node_group_id);
      if (ngId === undefined) return badRequest("必须指定入口节点组");
      const ng = db.nodeGroups.find((g) => g.id === ngId);
      if (!ng) return notFound("入口节点组不存在");

      const outId = numOrNull(body.out_node_group_id);
      if (outId !== null && !db.nodeGroups.some((g) => g.id === outId)) return notFound("出口节点组不存在");

      const listenPort = numOrNull(body.listen_port);
      if (listenPort !== null && (listenPort < 1 || listenPort > 65535)) return badRequest("监听端口必须在 1-65535 之间");
      if (listenPort !== null && db.tunnels.some((t) => t.in_node_group_id === ng.id && t.listen_port === listenPort)) {
        return badRequest("监听端口已被占用", "PORT_CONFLICT");
      }

      // WP13：DIRECT / RELAY mode + 出口池选择。缺省 tunnel_mode 时：
      //   · 有 out_node_group_id 或 egress_pool_id → relay
      //   · 否则 legacy direct（存量路径不变）
      const rawMode = reqStr(body.tunnel_mode);
      const poolId = numOrNull(body.egress_pool_id);
      const outIdParsed = numOrNull(body.out_node_group_id);
      const mode: Tunnel["tunnel_mode"] =
        rawMode === "relay" || rawMode === "direct"
          ? (rawMode as TunnelMode)
          : poolId !== null || outIdParsed !== null
            ? "relay"
            : "direct";
      const relay = mode === "relay";

      const tunnelType = (reqStr(body.tunnel_type) || "tcp") as Tunnel["tunnel_type"];
      const newId = nextId(db.tunnels);

      // forward 目标只在 DIRECT 下必填；RELAY 的目标在 EgressTarget 上（池内），
      // 因此 RELAY 允许 forward_addresses 为空数组（与 backend WP11 契约一致）。
      const forward = Array.isArray(body.forward_addresses)
        ? body.forward_addresses.map((s) => reqStr(s)).filter(Boolean)
        : parseList(body.forward_addresses) ?? [];
      if (!relay && forward.length === 0) return badRequest("至少需要一个转发目标");
      const badAddr = forward.find((a) => !/^(\[[0-9a-fA-F:]+\]|[^:\s]+):\d{1,5}$/.test(a));
      if (badAddr) return badRequest(`转发目标格式应为 host:port（${badAddr}）`);
      const remoteHost = reqStr(body.remote_host) || null;
      const remotePort = numOrNull(body.remote_port);
      // 直连目标可写在 forward_addresses（存量契约）或 remote_host/remote_port
      // （v3 列）；后者缺失时从 forward[0] 拆一份，保证 DIRECT 详情可展示。
      const derivedFromForward = forward[0]?.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/) ?? null;
      const finalRemoteHost = remoteHost ?? (derivedFromForward ? (derivedFromForward[1] ?? derivedFromForward[2]) : null);
      const finalRemotePort = remotePort ?? (derivedFromForward ? Number(derivedFromForward[3]) : null);
      const created: Tunnel = {
        id: newId,
        name: nameR.value,
        tunnel_type: tunnelType,
        category: reqStr(body.category) === "remote_port_forward" ? "remote_port_forward" : "port_forward",
        listen_ip: reqStr(body.listen_ip) || "0.0.0.0",
        listen_port: listenPort ?? 20000 + newId,
        listen_protocol: [tunnelType],
        status: "active",
        forward_addresses: forward,
        forward_addresses_protocol: forward.map(() => tunnelType),
        load_balance_type: (reqStr(body.load_balance_type) || "round") as Tunnel["load_balance_type"],
        ip_type: (reqStr(body.ip_type) || "ipv4") as Tunnel["ip_type"],
        order_by: db.tunnels.reduce((m, x) => Math.max(m, x.order_by), 0) + 10,
        ip_limit: numOrNull(body.ip_limit),
        client_limit: numOrNull(body.client_limit),
        bandwidth_limit: numOrNull(body.bandwidth_limit),
        traffic: 0,
        traffic_cost: 0,
        proxy_protocol: Boolean(body.proxy_protocol),
        in_node_group_id: ng.id,
        in_node_group: { id: ng.id, name: ng.name, node_type: ng.node_type },
        out_node_group_id: outId,
        out_node_group: outId ? groupRef(db, outId) ?? null : null,
        user_id: user.id,
        port_conflict_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        online: true,
        client_count: 0,
        // ── v3 增量列（WP13）：新行总是显式声明模式，不留给「未声明」──
        tunnel_mode: mode,
        remote_host: relay ? null : finalRemoteHost,
        remote_port: relay ? null : finalRemotePort,
        desired_status: "active",
        // 真实链路（§4.1）：persist_desired → pending → applying → active。
        // mock 创建后停在 pending（不做假 ACK），与后端的「期望状态已落库、
        // 尚未下发」一致；编排推进由后续运行操作/重算驱动。
        apply_status: "pending",
        config_revision: 1,
        applied_revision: 0,
        apply_error_code: null,
        apply_error: null,
        last_applied_at: null,
        egress_node_id: relay ? (poolId !== null ? poolOfNode(db, poolId) : null) : null,
        egress_port: relay ? 30000 + newId : null,
        egress_pool_id: relay ? poolId : null,
        egress_pool: relay ? poolRef(db, poolId) : null,
      };
      db.tunnels.push(created);
      return ok(created);
    }

    if (id !== null) {
      const t = db.tunnels.find((x) => x.id === id && x.user_id === user.id);
      if (!t) return notFound("隧道不存在");

      if (method === "GET" && sub === "traffic") {
        const days = Math.max(1, Number(q?.days ?? 14) || 14);
        return ok(tunnelTrafficSeries(t.id, t.traffic, days));
      }
      if (method === "GET" && sub === undefined) {
        return ok({ ...t, user: { id: t.user_id, email: db.users.find((u) => u.id === t.user_id)?.email ?? user.email } });
      }
      if (method === "PUT" || method === "PATCH") {
        if (sub === "toggle") {
          // 容错：部分客户端用 PUT 调 toggle
          t.status = t.status === "active" ? "inactive" : "active";
          t.online = t.status === "active";
          if (!t.online) t.client_count = 0;
          t.updated_at = nowIso();
          return ok(t);
        }
        const body = asRecord(req.body);
        if (body.name !== undefined) {
          const r = required(body, "name", "隧道名称", 60);
          if (isResponse(r)) return r;
          t.name = r.value;
        }
        if (body.in_node_group_id !== undefined) {
          const gid = numOrNull(body.in_node_group_id);
          const g = gid === null ? undefined : db.nodeGroups.find((x) => x.id === gid);
          if (!g) return notFound("入口节点组不存在");
          t.in_node_group_id = g.id;
          t.in_node_group = { id: g.id, name: g.name, node_type: g.node_type };
        }
        if (body.out_node_group_id !== undefined) {
          const oid = numOrNull(body.out_node_group_id);
          if (oid !== null && !db.nodeGroups.some((g) => g.id === oid)) return notFound("出口节点组不存在");
          t.out_node_group_id = oid;
          t.out_node_group = oid ? groupRef(db, oid) ?? null : null;
        }
        if (body.listen_port !== undefined) {
          const port = numOrNull(body.listen_port);
          if (port !== null && (port < 1 || port > 65535)) return badRequest("监听端口必须在 1-65535 之间");
          if (port !== null && db.tunnels.some((x) => x.id !== t.id && x.in_node_group_id === t.in_node_group_id && x.listen_port === port)) {
            return badRequest("监听端口已被占用", "PORT_CONFLICT");
          }
          t.listen_port = port;
        }
        if (body.forward_addresses !== undefined) {
          const forward = Array.isArray(body.forward_addresses)
            ? body.forward_addresses.map((s) => reqStr(s)).filter(Boolean)
            : parseList(body.forward_addresses) ?? [];
          if (forward.length === 0) return badRequest("至少需要一个转发目标");
          t.forward_addresses = forward;
          t.forward_addresses_protocol = forward.map(() => t.tunnel_type);
        }
        if (body.tunnel_type !== undefined) {
          t.tunnel_type = reqStr(body.tunnel_type) as Tunnel["tunnel_type"];
          t.listen_protocol = [t.tunnel_type];
          t.forward_addresses_protocol = t.forward_addresses.map(() => t.tunnel_type);
        }
        if (body.load_balance_type !== undefined) t.load_balance_type = reqStr(body.load_balance_type) as Tunnel["load_balance_type"];
        if (body.ip_type !== undefined) t.ip_type = reqStr(body.ip_type) as Tunnel["ip_type"];
        if (body.category !== undefined) {
          t.category = reqStr(body.category) === "remote_port_forward" ? "remote_port_forward" : "port_forward";
        }
        if (body.status !== undefined) {
          const s = reqStr(body.status);
          if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
          t.status = s;
          t.online = s === "active";
        }
        if (body.order_by !== undefined) t.order_by = numOrNull(body.order_by) ?? t.order_by;
        for (const key of ["ip_limit", "client_limit", "bandwidth_limit"] as const) {
          if (body[key] !== undefined) t[key] = numOrNull(body[key]);
        }
        if (body.proxy_protocol !== undefined) t.proxy_protocol = Boolean(body.proxy_protocol);
        // WP13 v3 列：只写 desired state；revision 自增/编排重入归 WP11 orchestrator
        if (body.tunnel_mode !== undefined) {
          const m = reqStr(body.tunnel_mode);
          if (m !== "direct" && m !== "relay") return badRequest("tunnel_mode 只能是 direct / relay");
          t.tunnel_mode = m;
        }
        if (body.out_node_group_id !== undefined) {
          const oid = numOrNull(body.out_node_group_id);
          if (oid !== null && !db.nodeGroups.some((g) => g.id === oid)) return notFound("出口节点组不存在");
          t.out_node_group_id = oid;
          t.out_node_group = oid ? groupRef(db, oid) ?? null : null;
        }
        if (body.egress_pool_id !== undefined) {
          const pid = numOrNull(body.egress_pool_id);
          t.egress_pool_id = pid;
          t.egress_pool = poolRef(db, pid);
          if (pid !== null) t.egress_node_id = poolOfNode(db, pid);
        }
        if (body.egress_node_id !== undefined) {
          t.egress_node_id = numOrNull(body.egress_node_id);
        }
        if (body.remote_host !== undefined) t.remote_host = reqStr(body.remote_host) || null;
        if (body.remote_port !== undefined) t.remote_port = numOrNull(body.remote_port);
        if (body.desired_status !== undefined) {
          const ds = reqStr(body.desired_status);
          if (ds !== "active" && ds !== "inactive") return badRequest("desired_status 只能是 active / inactive");
          t.desired_status = ds;
          // resume 语义：期望重新启用 → 重新入编排（revision 前进）
          if (ds === "active" && applyStatusOf(t) === "suspended") {
            t.config_revision = (t.config_revision ?? 0) + 1;
            t.apply_status = "pending";
            completeOrchestration(t);
          }
        }
        // 任何 desired/配置变更都让隧道「待下发」：applied < config
        if (t.config_revision !== undefined && t.config_revision !== null) {
          t.config_revision = t.config_revision + 1;
        }
        t.updated_at = nowIso();
        return ok(t);
      }
      if (method === "DELETE" && sub === undefined) {
        db.tunnels.splice(db.tunnels.indexOf(t), 1);
        return ok({ ok: true, id: t.id });
      }
      if (method === "POST" && sub === "toggle") {
        t.status = t.status === "active" ? "inactive" : "active";
        t.online = t.status === "active";
        if (!t.online) t.client_count = 0;
        t.updated_at = nowIso();
        return ok(t);
      }
      // WP11 运行操作：retry / suspend / resume（统一走编排器语义）
      if (method === "POST" && (sub === "retry" || sub === "suspend" || sub === "resume")) {
        return tunnelRuntimeAction(db, t, sub);
      }
      if (method === "POST" && sub === "reset-traffic") {
        t.traffic = 0;
        t.traffic_cost = 0;
        t.updated_at = nowIso();
        return ok(t);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- node groups（用户侧：列表 + V4 节点部署） ----------
  return null;
}

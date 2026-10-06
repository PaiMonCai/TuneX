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
import type { ForwardPatchInput } from "@/lib/types";
import type { TopologyDiagFact } from "@/lib/api/forwards";
import type { TargetHealthTargetView, TargetPoolHealth } from "@/lib/target-health";
import type { MockNodeBinding, MockWorkspaceInvite } from "../state";
import type { ForwardProtocol } from "@/lib/forward-protocol";
import * as rt from "../runtime";
import type { MockRequest, MockResponse, Store, MockForwardBatchAction, MockForwardBatchItemResult } from "../runtime";

const { TLS_PATH_ERROR_MESSAGES, SESSION_COOKIE, GB, sessionCookieValue, CYCLE_DAYS, COUPONS, ADMIN_RESOURCES, ADMIN_RESOURCE_KEYS, sanitizePermissions, TOPUP_AUTO_SETTLE_MS, nowIso, ok, fail, badRequest, notFound, failFlat, isLoggedIn, userFromCookie, paginate, MOCK_FORWARD_SORT_FIELDS, sortMockForwards, filterByKeyword, filterByStatus, nextId, asRecord, reqStr, numOrNull, reqNum, required, pick, parseList, isResponse, parseId, groupRef, withGroupStats, tunnelTrafficSeries, creditBalance, settleTopup, autoSettleTopups, payUrlFor, topupOrderNo, dashboardStats, adminStats, readPlanPayload, readNodeGroupPayload, readNodePayload, mockPoolTargetHealth, noEvidenceTargetView, handleEgressPools, nextPoolId, nextTargetId, APPLY_STATUSES, TUNNEL_MODES, FORWARD_BATCH_ACTIONS, FORWARD_BATCH_MAX_IDS, applyStatusOf, hasV3Columns, completeOrchestration, poolOfNode, poolRef, tunnelRuntimeAction, MOCK_ATTENTION_MAX_ITEMS, mockAttention, mockUserNode, mockBindingUsage, mockBindingView, healthWorld, impactWorld, mockIngressNode, parseMockTarget, mockForwardView, mockEnrollment, seed, poolTargetKey, getStore, resetStore, handleFederationMock, handleRouteProfileMock, mockFleetHealth, mockNodeHealth, mockResolveNode, MOCK_LIFECYCLES, MOCK_LIFECYCLE_NOTE_MAX, mockAllowedTransitions, mockCanTransition, mockDeleteGates, mockImpact, mockLifecycleChange, mockLifecycleOf, mockLifecycleView, mockRoleCheck, mockUserNodeStatus, applyMockForwardPatch, previewMockForwardUpdate, applyErrorIsRetryable, DEFAULT_FORWARD_PROTOCOL, forwardProtocolFact, forwardProtocolSupported, isForwardProtocol, tlsPathFieldErrors, mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } = rt;

/**
 * 拓扑 mock 的一跳一端：与后端 `forward-topology.ts:endpoint()` **同一读法**。
 *
 * 关键点是「找不到」不补默认值：该端没有出现在节点最近一次上报里 ⇒
 * `running: false` + `revision: null` + `diag: null`，这**不是**「不健康」，
 * 而是「节点这次没说」。mock 在这里造一个漂亮的事实，等于让开发期永远看不到
 * 真实环境里最重要的一条不确定性。
 */
function mockTopologyEndpoint(
  db: Store,
  nodeId: ID | null,
  runtimeId: string,
  nodeKey: string | null,
): {
  node_id: number;
  node_key: string;
  runtime_id: string;
  running: boolean;
  revision: number | null;
  diag: TopologyDiagFact | null;
} {
  const id = nodeId ?? 0;
  const key = nodeKey ?? String(id);
  const report = nodeId === null ? null : db.nodeStates.get(nodeId) ?? null;
  const tunnels = report?.tunnels ?? null;
  if (!Array.isArray(tunnels)) {
    return { node_id: id, node_key: key, runtime_id: runtimeId, running: false, revision: null, diag: null };
  }
  const entry = tunnels.find((row) => row.id === runtimeId) ?? null;
  return {
    node_id: id,
    node_key: key,
    runtime_id: runtimeId,
    running: entry !== null,
    revision: typeof entry?.revision === "number" ? entry.revision : null,
    diag: mockTopologyDiag(entry),
  };
}

/**
 * mock 上报里的 `diag` → 读取视图（镜像后端 `normalizeTunnelDiag` 的三态）：
 * 非对象 → `null`（没有证据）；对象 → 只收标量键，未知键原样保留。
 * 种子里没有 `diag` 块，所以默认就是 `null` —— 这正是真实 tcp 转发的形态。
 */
function mockTopologyDiag(entry: unknown): TopologyDiagFact | null {
  const raw = (entry as { diag?: unknown } | null | undefined)?.diag;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const protocol = typeof record.protocol === "string" ? record.protocol : null;
  const facts: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "protocol") continue;
    if (typeof value === "number" && Number.isFinite(value)) facts[key] = value;
    else if (typeof value === "string" || typeof value === "boolean") facts[key] = value;
  }
  return { protocol, facts, truncated: false };
}

/**
 * 多跳（三跳）的 mock 记忆：`tunnel id → middle node id`。
 *
 * 为什么用 `WeakMap<Store, …>` 而不是往 mock 的 `Tunnel` 行上加字段：
 *   ① `Tunnel` 是**真后端行**的镜像，而真后端的 `forwardView` **不含** `middle_node`
 *      （列表/详情读数看不到中间跳，只有 topology 有三段）—— mock 行上多一个字段，
 *      迟早会有人"顺手"投影出去，那就与真后端分叉了；
 *   ② 键是 store 对象 ⇒ `resetStore()` 换对象即自动归零，不需要改 `mocks/state.ts`。
 * 它只在两处被读：创建时的两段校验、topology 的三段构造。
 */
const MOCK_MIDDLE_HOPS = new WeakMap<Store, Map<number, number>>();

function middleHopsOf(db: Store): Map<number, number> {
  let rows = MOCK_MIDDLE_HOPS.get(db);
  if (!rows) {
    rows = new Map<number, number>();
    MOCK_MIDDLE_HOPS.set(db, rows);
  }
  return rows;
}

export async function handleForwardsMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "forwards") {
    const id = parseId(seg[1]);

    /**
     * V4-WP11C：POST /api/forwards/:id/diagnose（mock）。
     *
     * 形状必须与真实契约一致，尤其是 RELAY 的那一段：`method: "node_facts"` +
     * `verified: false`。mock 若把这一段渲染成"已验证可达"，界面就会在开发期
     * 掩盖掉真实环境里最重要的一条不确定性。
     */
    if (method === "POST" && id !== null && seg[2] === "diagnose") {
      const tunnel = db.tunnels.find((row) => row.id === id);
      if (!tunnel) return notFound("转发不存在");
      const view = mockForwardView(db, tunnel);
      const ingress = db.nodes.find((n) => n.id === view.ingress_node_id);
      const egress = db.nodes.find((n) => n.id === view.egress_node_id);
      const segments =
        view.mode === "relay"
          ? [
              {
                segment: "ingress_to_egress",
                method: "node_facts",
                verified: false,
                node_id: view.ingress_node_id ?? 0,
                node_key: ingress?.node_id ?? String(view.ingress_node_id ?? ""),
                targets: [],
                results: [],
                facts: {
                  hop: null,
                  expected_revision: view.config_revision ?? null,
                  ingress: { node_id: view.ingress_node_id ?? 0, reported: true, runtime_present: true, runtime_revision: view.config_revision ?? null, listener_port: view.listen_port ?? null },
                  egress: { node_id: view.egress_node_id ?? 0, reported: true, runtime_present: true, runtime_revision: view.config_revision ?? null, listener_port: null },
                },
                outcome: "ok",
                message: "两端运行时事实一致；该段未做连通性验证（不探测业务监听端口）",
              },
              {
                segment: "egress_to_target",
                method: "tcp_probe",
                verified: true,
                node_id: view.egress_node_id ?? 0,
                node_key: egress?.node_id ?? String(view.egress_node_id ?? ""),
                targets: [{ host: view.target_host ?? "", port: view.target_port ?? 0 }],
                results: [{ host: view.target_host ?? "", port: view.target_port ?? 0, status: "reachable", elapsed_ms: 3 }],
                outcome: "ok",
              },
            ]
          : [
              {
                segment: "ingress_to_target",
                method: "tcp_probe",
                verified: true,
                node_id: view.ingress_node_id ?? 0,
                node_key: ingress?.node_id ?? String(view.ingress_node_id ?? ""),
                targets: [{ host: view.target_host ?? "", port: view.target_port ?? 0 }],
                results: [{ host: view.target_host ?? "", port: view.target_port ?? 0, status: "reachable", elapsed_ms: 3 }],
                outcome: "ok",
              },
            ];
      return ok({
        forward_id: id,
        mode: view.mode,
        generated_at: nowIso(),
        segments,
        next_step: view.mode === "relay"
          ? "出口节点到目标的 TCP 可达；节点间那一段未做连通性验证，若业务仍不通请从两端节点日志继续排查。"
          : "入口节点到目标的 TCP 可达；若业务仍不通，请检查目标服务本身。",
      });
    }

    if (method === "GET" && seg[1] === "summary") {
      const rows = db.tunnels
        .filter((tunnel) => tunnel.user_id === user.id && tunnel.category === "port_forward")
        .map((tunnel) => mockForwardView(db, tunnel));
      return ok({
        total: rows.length,
        direct: rows.filter((row) => row.mode === "direct").length,
        relay: rows.filter((row) => row.mode === "relay").length,
        active: rows.filter((row) => row.apply_status === "active").length,
        error: rows.filter((row) => row.apply_status === "error").length,
        suspended: rows.filter((row) => row.apply_status === "suspended").length,
        pending: rows.filter(
          (row) => row.apply_status === "pending" || row.apply_status === "applying",
        ).length,
        traffic: rows.reduce((sum, row) => sum + row.traffic, 0),
        traffic_cost: rows.reduce((sum, row) => sum + row.traffic_cost, 0),
      });
    }

    if (method === "GET" && seg[1] === undefined) {
      const mode = reqStr(q?.mode);
      const applyStatus = reqStr(q?.apply_status);
      const ingressNodeId = Number(q?.ingress_node_id);
      const egressNodeId = Number(q?.egress_node_id);
      const keyword = reqStr(q?.keyword).toLowerCase();
      let rows = db.tunnels
        .filter((tunnel) => tunnel.user_id === user.id && tunnel.category === "port_forward")
        .map((tunnel) => mockForwardView(db, tunnel));
      if (mode === "direct" || mode === "relay") {
        rows = rows.filter((row) => row.mode === mode);
      }
      if (Number.isInteger(ingressNodeId) && ingressNodeId > 0) {
        rows = rows.filter((row) => Number(row.ingress_node_id) === ingressNodeId);
      }
      if (Number.isInteger(egressNodeId) && egressNodeId > 0) {
        rows = rows.filter((row) => Number(row.egress_node_id) === egressNodeId);
      }
      if (APPLY_STATUSES.includes(applyStatus as (typeof APPLY_STATUSES)[number])) {
        rows = rows.filter((row) => row.apply_status === applyStatus);
      }
      if (keyword) {
        rows = rows.filter((row) =>
          [
            row.name,
            row.ingress_node?.node_id ?? "",
            row.egress_node?.node_id ?? "",
            row.target_host ?? "",
            String(row.target_port ?? ""),
          ].some((value) => value.toLowerCase().includes(keyword)),
        );
      }
      // V4-WP9 §13.6：与后端 `routes/forwards.ts` 同一形态决策——带 page /
      // page_size / sort / order 任一参数 → 分页信封；否则 → 裸数组。
      // 口径一旦分叉，mock 下的分页行为就会与线上静默不一致。
      const wantsPage =
        q?.page !== undefined ||
        q?.page_size !== undefined ||
        q?.sort !== undefined ||
        q?.order !== undefined;
      if (!wantsPage) {
        return ok(rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
      }
      return ok(
        paginate(sortMockForwards(rows, reqStr(q?.sort), reqStr(q?.order)), q),
      );
    }

    /**
     * V4-WP9 §13.6：批量 retry / suspend / resume。
     *
     * 与后端同一契约：动作白名单（不含 delete）、ids 去重、单次上限 50、
     * 逐条结果 + 200（部分失败不改整体状态码）。**必须**在单条 POST 分支之前
     * 判定，否则 "batch" 会被当成 id 走进单条分支。
     */
    if (method === "POST" && seg[1] === "batch") {
      const body = asRecord(req.body);
      const rawAction = reqStr(body.action);
      if (
        !(FORWARD_BATCH_ACTIONS as readonly string[]).includes(rawAction)
      ) {
        return badRequest("不支持的批量动作");
      }
      const batchAction = rawAction as MockForwardBatchAction;
      if (!Array.isArray(body.ids)) return badRequest("ids 必须是数组");
      for (const raw of body.ids) {
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
          return badRequest("ids 只能包含正整数");
        }
      }
      const batchIds = [...new Set(body.ids as number[])];
      if (batchIds.length === 0) return badRequest("ids 不能为空");
      if (batchIds.length > FORWARD_BATCH_MAX_IDS) {
        return badRequest(`一次最多处理 ${FORWARD_BATCH_MAX_IDS} 条`);
      }

      const results: MockForwardBatchItemResult[] = [];
      for (const batchId of batchIds) {
        const row = db.tunnels.find((tunnel) => tunnel.id === batchId);
        if (!row) {
          results.push({
            id: batchId,
            ok: false,
            apply_status: null,
            code: "not_found",
            message: "端口转发不存在",
          });
          continue;
        }
        const outcome = tunnelRuntimeAction(db, row, batchAction);
        if (outcome.status >= 400) {
          const bodyOf = outcome.body as { message?: string; code?: string };
          results.push({
            id: batchId,
            ok: false,
            apply_status: mockForwardView(db, row).apply_status,
            code: bodyOf.code ?? "invalid_state",
            message: bodyOf.message ?? "动作被拒绝",
          });
          continue;
        }
        results.push({
          id: batchId,
          ok: true,
          apply_status: mockForwardView(db, row).apply_status,
        });
      }
      const succeeded = results.filter((row) => row.ok).length;
      return ok({
        action: batchAction,
        requested: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      });
    }

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const name = reqStr(body.name);
      const mode = reqStr(body.mode);
      const ingressId = reqNum(body.ingress_node_id);
      const egressId = numOrNull(body.egress_node_id);
      const targetHost = reqStr(body.target_host);
      const targetPort = reqNum(body.target_port);
      const listenPort = numOrNull(body.listen_port);

      if (
        !name ||
        (mode !== "direct" && mode !== "relay") ||
        ingressId === undefined ||
        !targetHost ||
        targetPort === undefined ||
        targetPort < 1 ||
        targetPort > 65535 ||
        (listenPort !== null && (listenPort < 1 || listenPort > 65535))
      ) {
        return badRequest("端口转发参数不合法");
      }

      /*
       * V5-WP5-A1：协议 + tls 路径，与后端 `ForwardCreateSchema` /
       * `tlsPathsForProtocol` 同一口径：
       *   · 省略协议 = V4 的 tcp（入口的「省略即默认」只在这里成立）；
       *   · 显式未知协议 → 400（`z.enum(FORWARD_PROTOCOLS)`）；
       *   · tls 必须给出两个以 `/` 开头的绝对路径；非 tls 携带路径 → 400。
       * mock 若不拦，前端就会在开发期看到一次「成功」，线上（或 Gate）才 400 ——
       * 这正是 mock 需要镜像契约的理由。
       */
      const rawProtocol = reqStr(body.protocol);
      const protocol: ForwardProtocol =
        rawProtocol === "" ? DEFAULT_FORWARD_PROTOCOL : (rawProtocol as ForwardProtocol);
      if (!isForwardProtocol(protocol)) {
        return badRequest("不支持的转发协议");
      }
      const tlsPathError = tlsPathFieldErrors(
        protocol,
        reqStr(body.tls_cert_path),
        reqStr(body.tls_key_path),
      );
      // 预检返回的是 i18n key（给界面用）；mock 这里给出的是**人话错误体**，
      // 与后端 `tlsPathsForProtocol` 的 reason 同义（不然 toast 里会画出 key）。
      const tlsPathMessage = tlsPathError.tls_cert_path ?? tlsPathError.tls_key_path;
      if (tlsPathMessage) {
        return badRequest(TLS_PATH_ERROR_MESSAGES[tlsPathMessage] ?? "证书/私钥路径不合法");
      }
      const tlsCertPath = protocol === "tls" ? reqStr(body.tls_cert_path) : "";
      const tlsKeyPath = protocol === "tls" ? reqStr(body.tls_key_path) : "";

      const ingressRaw = db.nodes.find((node) => node.id === ingressId);
      if (!ingressRaw) return notFound("入口节点不存在");
      const ingress = mockUserNode(db, ingressRaw);
      if (ingress.role !== "ingress" && ingress.role !== "both") {
        return badRequest("该节点不具备入口能力");
      }

      let egress: UserNode | null = null;
      if (mode === "relay") {
        if (egressId === null) return badRequest("RELAY 转发必须指定出口节点");
        const egressRaw = db.nodes.find((node) => node.id === egressId);
        if (!egressRaw) return notFound("出口节点不存在");
        egress = mockUserNode(db, egressRaw);
        if (egress.role !== "egress" && egress.role !== "both") {
          return badRequest("选择的节点不具备出口能力");
        }
        const bound = db.nodeBindings.some(
          (binding) =>
            binding.ingress_node_id === ingress.id &&
            binding.egress_node_id === egress!.id,
        );
        if (!bound) return fail(409, "该出口尚未绑定到当前入口节点", "BINDING_REQUIRED");
      } else if (egressId !== null) {
        return badRequest("DIRECT 转发不能指定出口节点");
      }

      /**
       * V5.4 三跳：`middle_node_id` 的两段邻接许可。
       *
       * 与后端 `forward-service.ts:764-783` **同一判据**：三跳用的两条邻接是
       * `(入口→中间)` 与 `(中间→出口)`，缺任何一段即 409 `binding_required`
       * （`(入口→出口)` 那条**不被使用**）。mock 此前**完全忽略**这个字段 —— 那正是
       * "mock 替后端撒谎"：本地 200、线上 409。
       *
       * DIRECT 上后端**不校验也不使用** `middle_node_id`（create 只在 `if (egress)` 里查两段，
       * `forward-service.ts:761`），这是已知的后端缺口；mock 如实照做（不替它"修"），
       * 而 Web 侧的载荷生成器对 DIRECT 一律**不发**这个键。
       */
      const middleId = numOrNull(body.middle_node_id);
      if (mode === "relay" && middleId !== null) {
        const inbound = db.nodeBindings.some(
          (binding) => binding.ingress_node_id === ingress.id && binding.egress_node_id === middleId,
        );
        const outbound = db.nodeBindings.some(
          (binding) => binding.ingress_node_id === middleId && binding.egress_node_id === egress?.id,
        );
        if (!inbound || !outbound) {
          return fail(409, "三跳路由要求入口→中间、中间→出口两段都已绑定", "BINDING_REQUIRED");
        }
      }

      const effectiveListenPort = listenPort ?? 20000 + nextId(db.tunnels);
      const conflict = db.tunnels.some((tunnel) => {
        const rowIngress = mockIngressNode(db, tunnel);
        return rowIngress?.id === ingress.id && tunnel.listen_port === effectiveListenPort;
      });
      if (conflict) return fail(409, "该入口端口已被占用", "PORT_CONFLICT");

      const newId = nextId(db.tunnels);
      const target =
        targetHost.includes(":") && !targetHost.startsWith("[")
          ? `[${targetHost}]:${targetPort}`
          : `${targetHost}:${targetPort}`;
      const created: Tunnel = {
        id: newId,
        name,
        /*
         * legacy `tunnel_type` 只写契约给出的镜像值；`ws` 在 legacy 枚举里没有
         * 对应值，**不写**这一列（后端的 `legacyTunnelTypeColumn("ws")` 返回空对象，
         * 于是列保留 DB 默认值；`forward_protocol` 才是唯一的协议事实）。
         * 这里之所以仍写一个具体值，是因为 mock 的 store 行必须有值才自洽 ——
         * 用默认的 `wss` 模拟「列保留默认」的行为。
         */
        tunnel_type: protocol === "ws" ? "wss" : protocol,
        forward_protocol: protocol,
        tls_cert_path: tlsCertPath === "" ? null : tlsCertPath,
        tls_key_path: tlsKeyPath === "" ? null : tlsKeyPath,
        category: "port_forward",
        listen_ip: "0.0.0.0",
        listen_port: effectiveListenPort,
        listen_protocol: [protocol],
        status: "active",
        forward_addresses: [target],
        forward_addresses_protocol: [protocol],
        load_balance_type: "round",
        ip_type: "ipv4",
        order_by: db.tunnels.reduce((max, row) => Math.max(max, row.order_by), 0) + 10,
        ip_limit: null,
        client_limit: null,
        bandwidth_limit: null,
        traffic: 0,
        traffic_cost: 0,
        proxy_protocol: false,
        in_node_group_id: ingress.node_group_id,
        in_node_group: groupRef(db, ingress.node_group_id) ?? undefined,
        out_node_group_id: egress?.node_group_id ?? null,
        out_node_group: egress ? groupRef(db, egress.node_group_id) ?? null : null,
        user_id: user.id,
        port_conflict_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        online: false,
        client_count: 0,
        tunnel_mode: mode,
        ingress_node_id: ingress.id,
        egress_node_id: egress?.id ?? null,
        egress_port: mode === "relay" ? 30000 + newId : null,
        egress_pool_id: null,
        egress_pool: null,
        remote_host: mode === "direct" ? targetHost : null,
        remote_port: mode === "direct" ? targetPort : null,
        desired_status: "active",
        apply_status: "pending",
        config_revision: 1,
        applied_revision: 0,
        apply_error_code: null,
        apply_error: null,
        last_applied_at: null,
      };
      db.tunnels.unshift(created);
      // 记住中间跳：`forwardView` 不投影它（与真后端一致），但 topology 要按三段画。
      if (mode === "relay" && middleId !== null) middleHopsOf(db).set(newId, middleId);
      completeOrchestration(created);
      created.online = true;
      return ok(mockForwardView(db, created));
    }

    if (id !== null) {
      const tunnel = db.tunnels.find(
        (row) =>
          row.id === id &&
          row.user_id === user.id &&
          row.category === "port_forward",
      );
      if (!tunnel) return notFound("端口转发不存在");

      if (method === "GET" && seg[2] === "traffic") {
        const days = Math.max(1, Math.min(90, Number(q?.days ?? 14) || 14));
        return ok(tunnelTrafficSeries(tunnel.id, tunnel.traffic, days));
      }
      /**
       * GET /api/forwards/:id/topology（mock）。
       *
       * 与后端 `services/forward-topology.ts` **同一套推导**，而不是另编一份演示数据：
       *   · DIRECT：`segments` 一定是空数组 + `observed_at: null` + `stale_segments: 0`
       *     （DIRECT 没有节点间段，这是设计结论 —— mock 若在这里塞一段假链路，
       *     开发期就再也看不到真实形态）；
       *   · RELAY：一段 `ingress_to_egress`，两端 runtime id 用后端同一个命名约定
       *     （`tunex-<id>-relay` / `tunex-<id>-egress`），`running`/`revision` 从 mock 的
       *     节点状态上报（`db.nodeStates`）里找，找不到就是 `false`/`null` —— 与后端的
       *     「没有上报 ≠ 不健康」同一个读法，绝不在这里补一个"看起来在跑"的默认值。
       */
      if (method === "GET" && seg[2] === "topology") {
        const view = mockForwardView(db, tunnel);
        if (view.mode === "direct") {
          return ok({
            forward_id: id,
            mode: "direct",
            segments: [],
            observed_at: null,
            stale_segments: 0,
          });
        }
        const ingressNode = db.nodes.find((node) => node.id === view.ingress_node_id) ?? null;
        const egressNode = db.nodes.find((node) => node.id === view.egress_node_id) ?? null;

        /*
         * V5.4 三跳：`(入口→出口)` 被拆成 `ingress_to_middle` + `middle_to_egress` 两段
         * （与 `services/forward-probe-plan.ts:141-172` 同一套段名与 runtime 命名约定：
         * 中间跳的 runtime 与出口同形 —— 那一段的"出端 runtime"就是出口 runtime）。
         *
         * 第一段的下一跳是中间跳的**中继端口**：mock 不跑调度器、没有 `apply_transit`，
         * 因此 `hop` 如实给 `null`（展示层写"未给出"而不是编一个端口）。
         */
        const middleId = middleHopsOf(db).get(Number(id)) ?? null;
        if (middleId !== null) {
          const middleNode = db.nodes.find((node) => node.id === middleId) ?? null;
          const ingressToMiddle = {
            segment: "ingress_to_middle" as const,
            from: mockTopologyEndpoint(db, view.ingress_node_id, `tunex-${id}-relay`, ingressNode?.node_id ?? null),
            to: mockTopologyEndpoint(db, middleId, `tunex-${id}-egress`, middleNode?.node_id ?? null),
            hop: null,
            expected_revision: view.config_revision ?? null,
          };
          const middleToEgress = {
            segment: "middle_to_egress" as const,
            from: mockTopologyEndpoint(db, middleId, `tunex-${id}-egress`, middleNode?.node_id ?? null),
            to: mockTopologyEndpoint(db, view.egress_node_id, `tunex-${id}-egress`, egressNode?.node_id ?? null),
            hop:
              egressNode?.connect_ip && tunnel.egress_port
                ? { host: egressNode.connect_ip, port: tunnel.egress_port }
                : null,
            expected_revision: view.config_revision ?? null,
          };
          const middleSegments = [ingressToMiddle, middleToEgress];
          const middleReports = [view.ingress_node_id, middleId, view.egress_node_id]
            .map((nodeId) => (nodeId == null ? null : db.nodeStates.get(nodeId) ?? null))
            .filter((row): row is NonNullable<typeof row> => row !== null);
          const middleObservedAt =
            middleReports
              .map((row) => row.reported_at)
              .filter((value): value is string => typeof value === "string" && value !== "")
              .sort()
              .at(-1) ?? null;
          // 与后端同一口径：只有「该节点有过上报、但最近一次上报里缺这一端」才计 stale。
          const middleStale =
            (db.nodeStates.has(view.ingress_node_id ?? -1) && !ingressToMiddle.from.running ? 1 : 0) +
            (db.nodeStates.has(middleId) && !ingressToMiddle.to.running ? 1 : 0) +
            (db.nodeStates.has(middleId) && !middleToEgress.from.running ? 1 : 0) +
            (db.nodeStates.has(view.egress_node_id ?? -1) && !middleToEgress.to.running ? 1 : 0);
          return ok({
            forward_id: id,
            mode: "relay",
            segments: middleSegments,
            observed_at: middleObservedAt,
            stale_segments: middleStale,
          });
        }

        const segment = {
          segment: "ingress_to_egress" as const,
          from: mockTopologyEndpoint(
            db,
            view.ingress_node_id,
            `tunex-${id}-relay`,
            ingressNode?.node_id ?? null,
          ),
          to: mockTopologyEndpoint(
            db,
            view.egress_node_id,
            `tunex-${id}-egress`,
            egressNode?.node_id ?? null,
          ),
          // 下一跳 = 出口节点的内部地址 + 该转发的出口端口（后端 `forward.egress_connect_ip`
          // / `egress_port` 同源）。缺任一项就是 `null`：展示用的地址宁可没有，不可编。
          hop:
            egressNode?.connect_ip && tunnel.egress_port
              ? { host: egressNode.connect_ip, port: tunnel.egress_port }
              : null,
          expected_revision: view.config_revision ?? null,
        };
        const reports = [view.ingress_node_id, view.egress_node_id]
          .map((nodeId) => (nodeId == null ? null : db.nodeStates.get(nodeId) ?? null))
          .filter((row): row is NonNullable<typeof row> => row !== null);
        const observedAt =
          reports
            .map((row) => row.reported_at)
            .filter((value): value is string => typeof value === "string" && value !== "")
            .sort()
            .at(-1) ?? null;
        // 与后端同一口径：只有「该节点有过上报、但最近一次上报里没有这一端」才算 stale。
        const stale =
          (db.nodeStates.has(view.ingress_node_id ?? -1) && !segment.from.running ? 1 : 0) +
          (db.nodeStates.has(view.egress_node_id ?? -1) && !segment.to.running ? 1 : 0);
        return ok({
          forward_id: id,
          mode: "relay",
          segments: [segment],
          observed_at: observedAt,
          stale_segments: stale,
        });
      }
      /**
       * GET /api/forwards/:id/latency（mock）。
       *
       * 与后端 `routes/forwards.ts` / `services/latency-history.ts` **同一套口径**，尤其是
       * 那些"看起来可以简化、简化了就骗人"的地方：
       *   · 四态 `status`（ok / no_samples / no_observer / ambiguous_target）按同一判据分支，
       *     而不是有空数组就报「没有数据」；
       *   · `granularity=sample` 且窗口下界早于原始保留期（24h）⇒ **409 `raw_window_expired`**
       *     （与 200 `no_samples` 是两件事）；
       *   · 窗口超上限 ⇒ 400 `window_too_long` + `data.max_hours`（**不静默截短**）；
       *   · `latency_ms: null` 表示那一次没有测得 —— mock 的夹具里同时包含 `null` 与真 0，
       *     这样开发期能看见两者的区别（真实档案里两者都存在）；
       *   · 点数超过上限 ⇒ `truncated: true`（保留期/上限的判定全在服务端，mock 只是照做）。
       *
       * mock 没有小时档案夹具：`granularity=hour` 如实返回 `no_samples`（这不是"缺实现"，
       * 而是真实存在的"数据缺口"形态 —— 集成拓扑上 hour/24h 就是这个答案）。
       */
      if (method === "GET" && seg[2] === "latency") {
        const rawGranularity = reqStr(q?.granularity);
        if (rawGranularity !== "sample" && rawGranularity !== "hour") {
          return fail(400, "granularity 必须是 sample 或 hour", "invalid_granularity", {
            error_layer: "input",
          });
        }
        const granularity = rawGranularity;
        const maxHours = granularity === "sample" ? 24 : 720;
        const hasHours = q?.hours !== undefined;
        const hasFrom = q?.from !== undefined;
        const hasTo = q?.to !== undefined;
        if (!hasHours && !hasFrom && !hasTo) {
          return fail(400, "缺少时间窗口：给 hours，或同时给 from 与 to", "missing_window", {
            error_layer: "input",
          });
        }
        if (hasHours && (hasFrom || hasTo)) {
          return fail(400, "hours 与 from/to 互斥，只能给一种", "invalid_window", {
            error_layer: "input",
          });
        }
        const now = new Date();
        let from: Date;
        let to: Date;
        let hours: number;
        const tooLong = () =>
          fail(
            400,
            `${granularity} 粒度最多读 ${maxHours} 小时窗口（服务端硬上限）`,
            "window_too_long",
            { max_hours: maxHours, granularity },
          );
        if (hasHours) {
          const n = Number(q?.hours);
          if (!Number.isInteger(n) || n < 1) {
            return fail(400, "hours 必须是 ≥1 的整数", "invalid_window", { error_layer: "input" });
          }
          if (n > maxHours) return tooLong();
          to = now;
          from = new Date(now.getTime() - n * 3_600_000);
          hours = n;
        } else {
          if (!hasFrom || !hasTo) {
            return fail(400, "from 与 to 必须成对给出", "invalid_window", { error_layer: "input" });
          }
          const rawFrom = new Date(String(q?.from));
          const rawTo = new Date(String(q?.to));
          if (Number.isNaN(rawFrom.getTime()) || Number.isNaN(rawTo.getTime())) {
            return fail(400, "from/to 必须是可解析的时间（ISO 8601）", "invalid_window", {
              error_layer: "input",
            });
          }
          to = rawTo.getTime() > now.getTime() ? now : rawTo;
          if (rawFrom.getTime() >= to.getTime()) {
            return fail(
              400,
              "窗口是半开区间 [from, to)，必须 from < to（窗口不能全落在将来）",
              "invalid_window",
              { error_layer: "input" },
            );
          }
          hours = Math.round(((to.getTime() - rawFrom.getTime()) / 3_600_000) * 1000) / 1000;
          if (hours > maxHours) return tooLong();
          from = rawFrom;
        }
        if (granularity === "sample" && from.getTime() < now.getTime() - 24 * 3_600_000) {
          return fail(
            409,
            "该窗口的原始样本已按保留期清理（原始层只覆盖最近 24 小时）；改用 granularity=hour 或把窗口前移",
            "raw_window_expired",
            { error_layer: "retention" },
          );
        }

        const windowView = { from: from.toISOString(), to: to.toISOString(), hours };
        const mode = tunnel.tunnel_mode === "relay" ? "relay" : "direct";
        const noObserver = (reason: string) =>
          ok({
            forward_id: id,
            mode,
            granularity,
            window: windowView,
            dimension: null,
            status: "no_observer",
            reason,
            series: [],
            truncated: false,
          });

        // 观测方 = 出口节点；DIRECT / 无池 / 无 active 目标 ⇒ 按构造没有维度（不查档案）。
        if (tunnel.tunnel_mode !== "relay") return noObserver("direct_not_observed");
        const egressNodeId = tunnel.egress_node_id ?? null;
        if (egressNodeId === null) return noObserver("no_egress_pool");
        /**
         * 池的取法：`egress_pool_id` 优先（真后端每行都有这一列，见
         * `forward-service.ts:1100`），缺失时按**出口节点的归属**回填一个池。
         *
         * 为什么允许这个回填：mock 的种子行与 mock 自己的创建路径都没写 `egress_pool_id`
         * （`Tunnel` 行上也确实没有池），于是开发期永远只能看到 `no_observer/no_egress_pool`
         * —— 那是**种子的缺口**，不是这条转发真实的观测形态。回填只补"哪个池"这一个事实，
         * 池里目标数量、active 过滤、多目标拒绝猜全部照后端口径走。
         * 找不到归属池时仍旧如实报 `no_egress_pool`。
         */
        const ownedPoolId =
          tunnel.egress_pool_id ??
          [...db.egressTargets.keys()].find((poolKey) =>
            (db.egressPools.get(egressNodeId) ?? []).some((row) => row.id === poolKey),
          ) ??
          null;
        if (ownedPoolId === null) return noObserver("no_egress_pool");
        const targets = (db.egressTargets.get(ownedPoolId) ?? [])
          .filter((target) => target.status === "active")
          .sort((a, b) => a.order_by - b.order_by || a.id - b.id);
        if (targets.length === 0) return noObserver("no_active_target");
        if (targets.length > 1) {
          return ok({
            forward_id: id,
            mode,
            granularity,
            window: windowView,
            dimension: null,
            status: "ambiguous_target",
            reason: "multiple_targets",
            candidate_targets: targets.length,
            series: [],
            truncated: false,
          });
        }
        const target = targets[0]!;
        // 目标身份归一化与 `node-state.ts:targetKeyOf` 同一口径（小写、去尾点、去方括号）。
        const targetKey = `${target.host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "")}:${target.port}`;
        const dimension = { observer_node_id: egressNodeId, target_key: targetKey };
        if (granularity === "hour") {
          return ok({
            forward_id: id,
            mode,
            granularity,
            window: windowView,
            dimension,
            status: "no_samples",
            reason: null,
            series: [],
            truncated: false,
          });
        }
        const observerNode = db.nodes.find((node) => node.id === egressNodeId) ?? null;
        const source = `${observerNode?.node_id ?? egressNodeId}/tcp_connect`;
        const cadenceMs = 30_000; // 观测节拍 30s（`node-lifecycle.ts` 同源）
        const maxPoints = 2000;
        const spanMs = to.getTime() - from.getTime();
        const available = Math.max(1, Math.floor(spanMs / cadenceMs));
        const count = Math.min(available, maxPoints);
        const series = Array.from({ length: count }, (_, index) => {
          const at = new Date(from.getTime() + index * cadenceMs);
          // 每 7 个点有 1 次测不到（null），每 5 个点有 1 次测得 0 ms —— 两者必须可分辨。
          const missing = index % 7 === 3;
          const value = missing ? null : index % 5 === 0 ? 0 : 6 + ((index * 13) % 90);
          return {
            at: at.toISOString(),
            latency_ms: value,
            samples: 1,
            successes: missing ? 0 : 1,
            failures: missing ? 1 : 0,
            latency_min_ms: value,
            latency_max_ms: value,
            observation_source: source,
          };
        });
        return ok({
          forward_id: id,
          mode,
          granularity,
          window: windowView,
          dimension,
          status: "ok",
          reason: null,
          series,
          truncated: available > maxPoints,
        });
      }
      if (method === "GET" && seg[2] === undefined) {
        return ok(mockForwardView(db, tunnel));
      }
      if (method === "PATCH" && seg[2] === undefined) {
        // V4-WP4（镜像 V4-WP1 契约）：编辑 = 全字段 patch + expected_revision。
        // 校验只有一个实现：applyMockForwardPatch 与 preview 共用
        // resolveMockForwardCandidate，因此 preview 放行 ⇔ PATCH 接受。
        const body = asRecord(req.body);
        const patched = applyMockForwardPatch(db, tunnel, body as ForwardPatchInput);
        if (!patched.ok) {
          const e = patched.error;
          // 与后端 send() 的错误体同形：{ message, code, data }，
          // data.latest_revision 让 UI 能给出「最新 revision 是多少」。
          return fail(e.status, e.message, e.code, e.data);
        }
        return ok(patched.view);
      }
      if (method === "POST" && seg[2] === "preview") {
        // V4-WP1 §13.3.3 preview：保存前影响面，不写库。
        const body = asRecord(req.body);
        const previewed = previewMockForwardUpdate(db, tunnel, body as ForwardPatchInput);
        if (!previewed.ok) {
          const e = previewed.error;
          return fail(e.status, e.message, e.code, e.data);
        }
        return ok(previewed.result);
      }
      if (
        method === "POST" &&
        (seg[2] === "retry" ||
          seg[2] === "suspend" ||
          seg[2] === "resume")
      ) {
        const result = tunnelRuntimeAction(db, tunnel, seg[2]);
        if (result.status >= 400) return result;
        return ok(mockForwardView(db, tunnel));
      }
      if (method === "DELETE" && seg[2] === undefined) {
        db.tunnels.splice(db.tunnels.indexOf(tunnel), 1);
        return ok({ ok: true });
      }
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- tunnels ----------
  return null;
}

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
import type { TargetHealthTargetView, TargetPoolHealth } from "@/lib/target-health";
import type { MockNodeBinding, MockWorkspaceInvite } from "../state";
import type { ForwardProtocol } from "@/lib/forward-protocol";
import * as rt from "../runtime";
import type { MockRequest, MockResponse, Store, MockForwardBatchAction, MockForwardBatchItemResult } from "../runtime";

const { TLS_PATH_ERROR_MESSAGES, SESSION_COOKIE, GB, sessionCookieValue, CYCLE_DAYS, COUPONS, ADMIN_RESOURCES, ADMIN_RESOURCE_KEYS, sanitizePermissions, TOPUP_AUTO_SETTLE_MS, nowIso, ok, fail, badRequest, notFound, failFlat, isLoggedIn, userFromCookie, paginate, MOCK_FORWARD_SORT_FIELDS, sortMockForwards, filterByKeyword, filterByStatus, nextId, asRecord, reqStr, numOrNull, reqNum, required, pick, parseList, isResponse, parseId, groupRef, withGroupStats, tunnelTrafficSeries, creditBalance, settleTopup, autoSettleTopups, payUrlFor, topupOrderNo, dashboardStats, adminStats, readPlanPayload, readNodeGroupPayload, readNodePayload, mockPoolTargetHealth, noEvidenceTargetView, handleEgressPools, nextPoolId, nextTargetId, APPLY_STATUSES, TUNNEL_MODES, FORWARD_BATCH_ACTIONS, FORWARD_BATCH_MAX_IDS, applyStatusOf, hasV3Columns, completeOrchestration, poolOfNode, poolRef, tunnelRuntimeAction, MOCK_ATTENTION_MAX_ITEMS, mockAttention, mockUserNode, mockBindingUsage, mockBindingView, healthWorld, impactWorld, mockIngressNode, parseMockTarget, mockForwardView, mockEnrollment, seed, poolTargetKey, getStore, resetStore, handleFederationMock, handleRouteProfileMock, mockFleetHealth, mockNodeHealth, mockResolveNode, MOCK_LIFECYCLES, MOCK_LIFECYCLE_NOTE_MAX, mockAllowedTransitions, mockCanTransition, mockDeleteGates, mockImpact, mockLifecycleChange, mockLifecycleOf, mockLifecycleView, mockRoleCheck, mockUserNodeStatus, applyMockForwardPatch, previewMockForwardUpdate, applyErrorIsRetryable, DEFAULT_FORWARD_PROTOCOL, forwardProtocolFact, forwardProtocolSupported, isForwardProtocol, tlsPathFieldErrors, mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } = rt;

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

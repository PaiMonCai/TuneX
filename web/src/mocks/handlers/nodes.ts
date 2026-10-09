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

export async function handleNodesMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "nodes") {
    if (method === "GET" && seg[1] === undefined) {
      return ok(db.nodes.map((node) => mockUserNode(db, node)));
    }

    const nodeId = parseId(seg[1]);
    if (nodeId !== null) {
      const node = db.nodes.find((row) => row.id === nodeId);
      if (!node) return notFound("节点不存在");
      const projected = mockUserNode(db, node);

      if (method === "POST" && seg[2] === "enrollment") {
        return ok(mockEnrollment(projected));
      }
        /**
       * V4-WP11C：用户侧 Node 诊断 / 支持包 / 升级命令（mock）。
       *
       * 与真实后端同一套语义，特别是"离线是结论不是错误"：状态上报过期的节点
       * 返回 reachability=offline 且 agent_facts 为空，这样界面在开发期也能看到
       * 真实的分支，而不是永远只有 happy path。
       */
      if (method === "GET" && seg[2] === "diagnostics") {
        const state = db.nodeStates.get(node.id) ?? null;
        const ageSeconds = state?.reported_at
          ? Math.max(0, Math.round((Date.now() - Date.parse(state.reported_at)) / 1000))
          : null;
        const reachability =
          ageSeconds === null ? "unknown" : ageSeconds > 75 ? "offline" : "online";
        const forwards = db.tunnels.filter(
          (t) => t.category === "port_forward" && (t.ingress_node_id === node.id || t.egress_node_id === node.id),
        );
        return ok({
          node_id: node.id,
          node_key: node.node_id,
          generated_at: nowIso(),
          reachability,
          agent_facts:
            reachability === "online"
              ? {
                  version: (state as { version?: string } | null)?.version ?? "0.0.0-mock",
                  role: String(node.role ?? "INGRESS").toUpperCase(),
                  agent_id: String(node.agent_id ?? "mock-agent"),
                  node_id: node.node_id,
                  runtime: {
                    tunnel_count: forwards.filter((t) => t.apply_status === "active").length,
                    truncated: false,
                    ports_total: forwards.length,
                    listen_ports: forwards
                      .map((t) => t.listen_port)
                      .filter((p): p is number => typeof p === "number"),
                    tunnels: forwards.map((t) => ({
                      id: `tunex-${t.id}-${t.tunnel_mode ?? "direct"}`,
                      mode: String(t.tunnel_mode ?? "direct").toUpperCase(),
                      ingress_port: t.listen_port ?? 0,
                      revision: t.config_revision ?? 1,
                      crosses_node: t.tunnel_mode === "relay",
                    })),
                  },
                  state_dir: {
                    path: "/var/lib/tunex-agent/desired-lkg.json",
                    configured: true,
                    dir_exists: true,
                    cache_present: true,
                    cache_valid: true,
                  },
                  process: {
                    uptime_seconds: 3600,
                    started_at: nowIso(),
                    go_version: "go1.27.1",
                    os: "linux",
                    arch: "amd64",
                    cpu_count: 4,
                    gomaxprocs: 4,
                    goroutines: 20,
                    heap_bytes: 1024,
                  },
                  shutting_down: false,
                }
              : null,
          agent_facts_error:
            reachability === "online"
              ? null
              : { error_code: reachability === "offline" ? "offline" : "never_reported", message: "节点未上报或上报已过期" },
          panel: {
            id: node.id,
            node_id: node.node_id,
            agent_id: node.agent_id ?? null,
            role: node.role ?? null,
            lifecycle: node.lifecycle ?? "active",
            status: node.status ?? null,
            last_seen_at: node.updated_at ?? null,
            reported: state
              ? {
                  version: (state as { version?: string }).version ?? null,
                  role: (state as { role?: string }).role ?? null,
                  control_protocol_version: 1,
                  capabilities: state.capabilities ?? null,
                  reported_revision: 1,
                  known_revision: 1,
                  reported_at: (state as { reported_at?: string }).reported_at ?? null,
                  age_seconds: ageSeconds,
                  last_error: null,
                  error_count: 0,
                }
              : null,
            forwards: {
              total: forwards.length,
              active: forwards.filter((t) => t.apply_status === "active").length,
              pending: forwards.filter((t) => t.apply_status === "pending").length,
              failed: forwards.filter((t) => t.apply_status === "error").length,
              unconverged: 0,
            },
          },
          next_step: reachability === "offline" ? "节点已超过 75 秒没有上报：请检查节点主机与 Agent 进程。" : null,
        });
      }

      if (method === "GET" && seg[2] === "support-bundle") {
        const state = db.nodeStates.get(node.id) ?? null;
        return ok({
          schema_version: 1,
          generated_at: nowIso(),
          panel_version: "mock",
          node: { id: node.id, node_id: node.node_id, agent_id: node.agent_id ?? null, role: node.role ?? null, lifecycle: node.lifecycle ?? "active" },
          state_report: state ?? null,
          forwards: [],
          rollouts: [],
          audit: [],
          truncated: null,
          notes: ["mock 产物：真实后端会按白名单采集并脱敏"],
        });
      }

      if (method === "POST" && seg[2] === "upgrade-command") {
        const body = asRecord(req.body);
        const image = reqStr(body.agent_image);
        if (!image) return badRequest("agent_image 不能为空");
        if ((node.lifecycle ?? "active") !== "maintenance" && body.allow_active !== true) {
          return fail(409, "升级前请先把节点置为 maintenance", "node_not_in_maintenance");
        }
        return ok({
          node: { id: node.id, node_id: node.node_id, agent_id: node.agent_id ?? null, lifecycle: node.lifecycle ?? "active" },
          target_image: image,
          allow_active: body.allow_active === true,
          script: `#!/bin/sh\n# TuneX Agent 升级脚本（mock）\nset -eu\nCONTAINER="tunex-agent"\nTARGET_IMAGE="${image}"\n# mock：真实后端会渲染完整的拉取/排空/重建/校验/回退步骤\n`,
          preserves: { node_identity: true, credential: true, lkg_state: true, forwards: true },
          rollback_hint: "用旧镜像重新运行安装脚本",
          downtime: "升级窗口内该节点不接受新业务；在途连接最多等待 15 秒完成排空",
        });
      }


      if (seg[2] === "bindings") {
        if (projected.role !== "ingress" && projected.role !== "both") {
          return badRequest("该节点不具备入口能力");
        }

        if (method === "GET" && seg[3] === undefined) {
          return ok(
            db.nodeBindings
              .filter((binding) => binding.ingress_node_id === nodeId)
              .map((binding) => mockBindingView(db, binding))
              .filter((binding): binding is NodeBinding => binding !== null),
          );
        }

        if (method === "POST" && seg[3] === undefined) {
          const body = asRecord(req.body);
          const egressId = reqNum(body.egress_node_id);
          if (egressId === undefined) return badRequest("出口节点 ID 不合法");
          const egressRaw = db.nodes.find((row) => row.id === egressId);
          if (!egressRaw) return notFound("出口节点不存在");
          const egress = mockUserNode(db, egressRaw);
          if (egress.id === projected.id) return badRequest("入口和出口不能是同一节点");
          if (egress.role !== "egress" && egress.role !== "both") {
            return badRequest("出口节点角色必须是 egress 或 both");
          }

          let binding = db.nodeBindings.find(
            (row) =>
              row.ingress_node_id === nodeId &&
              row.egress_node_id === egressId,
          );
          if (!binding) {
            binding = {
              id: nextId(db.nodeBindings),
              ingress_node_id: nodeId,
              egress_node_id: egressId,
              created_at: nowIso(),
            };
            db.nodeBindings.push(binding);
          }
          return ok(mockBindingView(db, binding));
        }

        const egressId = parseId(seg[3]);
        if (method === "DELETE" && egressId !== null) {
          // V4-WP9 §13.6：与后端同一判定 + 同一文案（binding-usage.ts），
          // 并在错误响应里回传使用量，前端错误分支也能刷新按钮状态。
          const usage = mockBindingUsage(db, nodeId, egressId);
          if (usage.unbind_blocked) {
            return fail(
              409,
              `该出口仍被 ${usage.used_by_forward_count} 条端口转发使用，请先删除或改为其它出口`,
              "BINDING_IN_USE",
              usage,
            );
          }
          db.nodeBindings = db.nodeBindings.filter(
            (row) =>
              !(
                row.ingress_node_id === nodeId &&
                row.egress_node_id === egressId
              ),
          );
          return ok({ ok: true });
        }
      }
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- forwards（V4 product API） ----------
  return null;
}

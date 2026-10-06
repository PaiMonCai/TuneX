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

export async function handleAdminMock(ctx: rt.MockAuthedRouteContext): Promise<rt.MockResponse | null> {
  const { method, clean, seg, q, db, user, req, scopeId } = ctx;
  if (seg[0] === "admin") {
    if (!user.super_admin) return fail(403, "需要管理员权限");

    if (seg[1] === "stats" && method === "GET") return ok(adminStats(db));

    // ----- federation（V5.5 WP14/WP15/WP16）-----
    // 实现全在 ./federation.ts（自包含、可离线单测）；这里只做路径分发。
    // 唯一真相是 backend/src/routes/admin-federation.ts，错误体形状见该模块头注释。
    if (seg[1] === "federation") {
      const fedRes = handleFederationMock({ method, seg: seg.slice(2), body: req.body, state: db.federation });
      if (fedRes) return fedRes;
      return notFound(`Mock route not found: ${method} /${clean}`);
    }

    // ----- meta/resources（权限元数据，渲染角色编辑器） -----
    if (seg[1] === "meta" && seg[2] === "resources" && method === "GET") {
      const isSuper = user.super_admin;
      return ok({
        resources: ADMIN_RESOURCES.map((r) => ({
          ...r,
          apiPrefixes: [] as string[],
          granted: isSuper ? "write" : null,
        })),
      });
    }

    // ----- role（RBAC 角色，仅超管） -----
    if (seg[1] === "role") {
      const userCount = (roleId: number) => db.users.filter((u) => (u.admin_roles ?? []).some((r) => r.id === roleId)).length;
      if (method === "GET" && seg[2] === undefined) {
        return ok(db.adminRoles.map((r) => ({ ...r, _count: { users: userCount(r.id) } })));
      }
      if (method === "POST" && seg[2] === undefined) {
        const body = asRecord(req.body);
        const name = reqStr(body.name);
        if (!name) return badRequest("名称不能为空");
        if (db.adminRoles.some((r) => r.name === name)) return fail(409, "角色名称已存在");
        const role: AdminRole = {
          id: nextId(db.adminRoles),
          name,
          description: reqStr(body.description) || null,
          permissions: sanitizePermissions(body.permissions),
          _count: { users: 0 },
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.adminRoles.push(role);
        return ok(role);
      }
      const rid = parseId(seg[2]);
      if (rid !== null) {
        const role = db.adminRoles.find((r) => r.id === rid);
        if (!role) return notFound("角色不存在");
        if (method === "PUT" || method === "PATCH") {
          const body = asRecord(req.body);
          if (body.name !== undefined) {
            const name = reqStr(body.name);
            if (!name) return badRequest("名称不能为空");
            if (db.adminRoles.some((r) => r.id !== rid && r.name === name)) return fail(409, "角色名称已存在");
            role.name = name;
          }
          if (body.description !== undefined) role.description = reqStr(body.description) || null;
          if (body.permissions !== undefined) role.permissions = sanitizePermissions(body.permissions);
          role.updated_at = nowIso();
          return ok(role);
        }
        if (method === "DELETE") {
          const using = userCount(rid);
          if (using > 0) return fail(409, `该角色仍被 ${using} 个用户使用，请先解除分配`);
          db.adminRoles.splice(db.adminRoles.indexOf(role), 1);
          return ok({ ok: true, id: rid });
        }
      }
    }

    // ----- user/:id/roles（给用户分配角色，仅超管） -----
    if (seg[1] === "user" && parseId(seg[2]) !== null && seg[3] === "roles" && (method === "PUT" || method === "PATCH")) {
      const uid = parseId(seg[2])!;
      const target = db.users.find((u) => u.id === uid);
      if (!target) return notFound("用户不存在");
      const body = asRecord(req.body);
      const ids: number[] = Array.isArray(body.admin_role_ids) ? (body.admin_role_ids as number[]) : [];
      target.admin_roles = db.adminRoles.filter((r) => ids.includes(r.id));
      target.updated_at = nowIso();
      return ok({ id: target.id, admin_roles: target.admin_roles });
    }

    // ----- system/config（系统设置） -----
    if (seg[1] === "system" && seg[2] === "config") {
      if (method === "GET" && seg[3] === undefined) return ok(db.systemConfig);
      if (method === "PUT" && seg[3] !== undefined) {
        const name = seg[3];
        const body = asRecord(req.body);
        if (typeof body.value !== "string") return badRequest("value 必须为字符串");
        const row = db.systemConfig.find((c) => c.name === name);
        if (row) {
          row.value = body.value;
          row.updated_at = nowIso();
          return ok({ name, value: body.value });
        }
        const created = {
          id: nextId(db.systemConfig),
          name,
          value: body.value,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.systemConfig.push(created);
        return ok({ name, value: body.value });
      }
    }

    // ----- license -----
    if (seg[1] === "license" && seg[2] === undefined && method === "GET") {
      return ok(db.license ?? { type: "none" });
    }

    // ----- balance-logs（管理端全量余额流水） -----
    if (seg[1] === "balance-logs" && method === "GET") {
      return ok(paginate(filterByStatus(db.balanceLogs, q), q));
    }

    // ----- users -----
    if (seg[1] === "users") {
      if (method === "GET" && seg[2] === undefined) {
        const items = filterByStatus(filterByKeyword(db.users, q, ["email", "uid"]), q);
        return ok(paginate(items, q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const body = asRecord(req.body);
        const emailR = required(body, "email", "邮箱", 120);
        if (isResponse(emailR)) return emailR;
        const email = emailR.value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
        if (db.users.some((u) => u.email.toLowerCase() === email)) return badRequest("该邮箱已存在");
        const id = nextId(db.users);
        const created: User = {
          id,
          email,
          super_admin: Boolean(body.super_admin),
          balance: numOrNull(body.balance) ?? 0,
          commission_balance: numOrNull(body.commission_balance) ?? 0,
          tg_id: reqStr(body.tg_id) || null,
          uid: reqStr(body.uid) || `RX-${100000 + id}`,
          note: reqStr(body.note) || null,
          parent_id: numOrNull(body.parent_id),
          referral_commission_rate: numOrNull(body.referral_commission_rate),
          auto_renew: Boolean(body.auto_renew),
          api_key: `rk_live_${Math.random().toString(16).slice(2, 18)}`,
          subscription_key: `sk_sub_${Math.random().toString(16).slice(2, 18)}`,
          status: reqStr(body.status) === "inactive" ? "inactive" : "active",
          email_verified_at: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.users.push(created);
        if (reqStr(body.password)) db.passwords[id] = reqStr(body.password);
        return ok(created);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const target = db.users.find((u) => u.id === id);
        if (!target) return notFound("用户不存在");
        if (method === "GET" && seg[3] === undefined) {
          return ok({ ...target, user_plan: db.userPlans.find((p) => p.user_id === target.id) ?? null });
        }
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const body = asRecord(req.body);
          if (body.email !== undefined) {
            const emailR = required(body, "email", "邮箱", 120);
            if (isResponse(emailR)) return emailR;
            const email = emailR.value.toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
            if (db.users.some((u) => u.id !== target.id && u.email.toLowerCase() === email)) return badRequest("该邮箱已注册");
            target.email = email;
          }
          if (body.status !== undefined) {
            const s = reqStr(body.status);
            if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
            target.status = s;
          }
          if (body.balance !== undefined) {
            const nb = numOrNull(body.balance);
            if (nb === null) return badRequest("余额必须是数字");
            creditBalance(db, target, Number((nb - target.balance).toFixed(2)), "admin_adjust");
          }
          if (body.commission_balance !== undefined) {
            const cb = numOrNull(body.commission_balance);
            if (cb === null) return badRequest("佣金余额必须是数字");
            target.commission_balance = cb;
          }
          if (body.note !== undefined) target.note = reqStr(body.note) || null;
          if (body.uid !== undefined) target.uid = reqStr(body.uid) || null;
          if (body.tg_id !== undefined) target.tg_id = reqStr(body.tg_id) || null;
          if (body.super_admin !== undefined) target.super_admin = Boolean(body.super_admin);
          if (body.auto_renew !== undefined) target.auto_renew = Boolean(body.auto_renew);
          if (body.referral_commission_rate !== undefined) {
            target.referral_commission_rate = numOrNull(body.referral_commission_rate);
          }
          if (body.password !== undefined) {
            const pwd = reqStr(body.password);
            if (pwd.length < 6) return badRequest("密码至少 6 位");
            db.passwords[target.id] = pwd;
          }
          target.updated_at = nowIso();
          return ok(target);
        }
        if (method === "DELETE" && seg[3] === undefined) {
          if (target.id === user.id) return badRequest("不能删除当前登录账号");
          if (db.tunnels.some((t) => t.user_id === target.id)) return badRequest("该用户仍有隧道，请先删除隧道");
          db.users.splice(db.users.indexOf(target), 1);
          const planIdx = db.userPlans.findIndex((p) => p.user_id === target.id);
          if (planIdx >= 0) db.userPlans.splice(planIdx, 1);
          delete db.passwords[target.id];
          return ok({ ok: true, id: target.id });
        }
      }
    }

    // ----- nodes -----
    if (seg[1] === "nodes") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.nodes, q, ["node_id", "connect_ip"]), q), q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const parsed = readNodePayload(db, asRecord(req.body), false);
        if (isResponse(parsed)) return parsed;
        const id = nextId(db.nodes);
        const node: Node = {
          id,
          node_id: parsed.patch.node_id ?? `node-${id}`,
          weight: parsed.patch.weight ?? 10,
          status: parsed.patch.status ?? "active",
          connect_ip: parsed.patch.connect_ip ?? "0.0.0.0",
          version: parsed.patch.version ?? "1.0.0",
          backup: parsed.patch.backup ?? false,
          order_by: parsed.patch.order_by ?? db.nodes.reduce((m, x) => Math.max(m, x.order_by), 0) + 10,
          custom_line: parsed.patch.custom_line ?? null,
          dns_status: parsed.patch.dns_status ?? false,
          node_group_id: parsed.patch.node_group_id ?? db.nodeGroups[0]?.id ?? 1,
          node_group: parsed.patch.node_group,
          created_at: nowIso(),
          updated_at: nowIso(),
          online: (parsed.patch.status ?? "active") === "active",
          traffic: 0,
          // v3 新列：未声明就是 null（存量节点迁移进来的行就是空值，mock 必须复刻这一点）
          role: parsed.patch.role ?? null,
          port_range_min: parsed.patch.port_range_min ?? null,
          port_range_max: parsed.patch.port_range_max ?? null,
          lb_strategy: parsed.patch.lb_strategy ?? null,
          last_seen_at: null,
          // v3 凭据派生字段：新节点 = 从未签发（hash 为 null → has_credential=false）
          has_credential: false,
          credential_revoked: false,
          credential_rotated_at: null,
          credential_last_rejected_at: null,
        };
        db.nodes.push(node);
        return ok(node);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const node = db.nodes.find((n) => n.id === id);
        if (!node) return notFound("节点不存在");
        if (method === "GET" && seg[3] === undefined) {
          // GET /admin/nodes/:id —— WP12 详情页聚合契约（NodeDetail）：
          // 基础字段（含凭据派生字段） + 出口池 + 最近一条状态上报。
          // 后端 WP10 未合并前 mock 直接按这个形状返回，前端零改动切换真实 API。
          return ok({
            ...node,
            pools: (db.egressPools.get(node.id) ?? []).map((p) => ({
              ...p,
              targets: db.egressTargets.get(p.id) ?? [],
            })),
            state: db.nodeStates.get(node.id) ?? null,
          });
        }
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const parsed = readNodePayload(db, asRecord(req.body), true, id);
          if (isResponse(parsed)) return parsed;
          Object.assign(node, parsed.patch);
          if (parsed.patch.status !== undefined) node.online = parsed.patch.status === "active";
          node.updated_at = nowIso();
          return ok(node);
        }
        if (method === "DELETE" && seg[3] === undefined) {
          db.nodes.splice(db.nodes.indexOf(node), 1);
          db.nodeCredentials.delete(node.id);
          db.egressPools.delete(node.id);
          return ok({ ok: true, id: node.id });
        }
        // ----- WP12 出口池：/admin/nodes/:id/pools[/:poolId[/targets[/:targetId]]] -----
        if (seg[3] === "pools") return handleEgressPools(db, node, method, seg.slice(4), req);
        // 注意：**没有** /admin/nodes/:id/state（复数）分支。
        // 真实后端只有单数 `nodeAdminRoutes.get("/node/:id/state")`；
        // mock 曾经实现复数路径，于是本地/mock 永远看不到线上的 404 —— 那种「mock 骗人」
        // 比缺实现更坏。运行态在下面与其它单数 `/admin/node/...` 端点一起分发。
      }
    }

    // ----- V5.2 §7：出口池目标健康 —— GET /admin/node/pools/:poolId/health -----
    /*
     * 与真实后端同一路径（单数 `/admin/node`）与同一响应形状：
     * `{ data: { targets, observers, observed_at } }`（mock 里 api.ts 不解包，
     * 所以这里返回**内层**对象，与 `api.admin.poolTargetHealth` 的 `get()` 对齐）。
     *
     * 数据来源是 `seed.mockTargetHealthFixtures`（**夹具，不是合成**，见 data.ts）：
     *   · 期望清单来自池当前的 targets（所以加/删目标立刻反映，且 `unhealthy` 的
     *     目标照旧在列表里 —— 观测没有删除权）；
     *   · 没有夹具的目标按「没有证据」渲染（`unknown` + `no_observation`）——
     *     这不是猜，而是契约事实：从未被观测过的目标只能是 `unknown`；
     *   · 时间戳按**本次请求时刻**回填（夹具只声明 age），否则演示数据会因为
     *     种子日期而全部显示为过期。
     */
    if (seg[1] === "node" && seg[2] === "pools" && seg[4] === "health" && method === "GET") {
      const poolId = parseId(seg[3]);
      if (poolId === null) return badRequest("非法池 ID");
      const entry = [...db.egressPools.entries()].find(([, pools]) =>
        pools.some((p) => p.id === poolId),
      );
      if (!entry) return notFound("池不存在");
      const pool = entry[1].find((p) => p.id === poolId)!;
      const targets = db.egressTargets.get(poolId) ?? [];
      const now = Date.now();
      const outcome = mockPoolTargetHealth(targets, seed.mockTargetHealthFixtures, now);
      return ok(outcome);
    }

    // ----- WP7/WP12 运行态：GET /admin/node/:id/state（单数，与真实后端同路同形）-----
    /*
     * 唯一真相是 `backend/src/routes/node-admin.ts` 的
     * `nodeAdminRoutes.get("/node/:id/state")` + `services/node-admin-state.ts`
     * 的 `NodeStateView`：
     *   · 节点存在 → **一律 200**：从未上报是 `reported_at: null` 的空态视图
     *     （`tunnels: []` / `used_ports: []` / `egress_pools: {}` / `stale: true`），
     *     既不是 404，也不是 `null` 载荷 —— 「没有上报」与「取不到」必须可分；
     *   · 节点不存在 → 404（`resolveNodeId` 失败）。
     * 响应是**解包后**的载荷（mock 模式下 api.ts 不再剥 `{ data }` 信封）。
     */
    if (seg[1] === "node" && method === "GET" && seg[3] === "state") {
      const node = mockResolveNode(db.nodes, seg[2]);
      if (!node) return notFound("节点不存在");
      const report = db.nodeStates.get(node.id);
      return ok(report ?? mockEmptyNodeState(node));
    }

    // ----- V4-WP6 §13.4.4 健康：单数 /admin/node/health 与前缀 /admin/node/:id/health -----
    // 形状对齐 backend/src/routes/node-health.ts：
    //   · fleet 返回 `{ data, total, summary }`（summary 是**过滤前**全量）；
    //   · 单节点返回裸 view（api.ts 的 get() 在真实模式下会剥掉 `{ data }`）。
    // 注册顺序同理：字面量 `health` 必须在前，否则会被当成节点标识。
    if (seg[1] === "node" && method === "GET" && seg[2] === "health" && seg[3] === undefined) {
      const result = mockFleetHealth(healthWorld(db), {
        health: typeof q?.health === "string" ? q.health : null,
        lifecycle: typeof q?.lifecycle === "string" ? q.lifecycle : null,
      });
      if ("invalid" in result) return fail(400, result.invalid, "invalid_input");
      return ok({ data: result.items, total: result.total, summary: result.summary });
    }
    if (seg[1] === "node" && method === "GET" && seg[3] === "health") {
      const node = mockResolveNode(db.nodes, seg[2]);
      if (!node) return notFound("节点不存在");
      return ok(mockNodeHealth(healthWorld(db), node));
    }

    // ----- V4-WP7 §13.4.2/§13.4.3 生命周期：单数 /admin/node/:id/lifecycle|impact -----
    // 形状对齐 backend/src/routes/node-lifecycle.ts：
    //   · GET  lifecycle  → `{ data: NodeLifecycleView }`
    //   · PATCH lifecycle → `{ data: { node, view } }`
    //   · GET  impact     → `{ data: { impact, role_check } }`
    //   · DELETE lifecycle→ `{ data: { id, deleted } }`
    // 错误体带 `code` / `condition` / `dependencies`（§13.5 要求可区分错误码，
    // UI 据此给出不同的下一步；丢掉 condition 就等于把所有拒绝渲染成
    // 同一句「操作失败」）。
    if (seg[1] === "node" && seg[3] === "lifecycle") {
      const node = mockResolveNode(db.nodes, seg[2]);
      if (!node) return notFound("节点不存在");
      const stored = db.nodeLifecycle.get(node.id);
      const current = mockLifecycleOf(node, stored);

      if (method === "GET") {
        return ok(mockLifecycleView(node, current, seed.now));
      }

      if (method === "PATCH" || method === "PUT") {
        const body = asRecord(req.body);
        const raw = body.lifecycle;
        // `undefined` / `null` / 空串 = 本次不改生命周期（与后端 parseLifecycle 同义）
        const requested =
          raw === undefined || raw === null || raw === "" ? null : String(raw).trim().toLowerCase();
        if (requested !== null && !(MOCK_LIFECYCLES as string[]).includes(requested)) {
          return failFlat(400, "生命周期状态必须是 active / maintenance / disabled / retiring", "invalid_input");
        }
        if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
          return failFlat(400, "备注必须是字符串", "invalid_input");
        }
        if (typeof body.note === "string" && body.note.trim().length > MOCK_LIFECYCLE_NOTE_MAX) {
          return failFlat(400, `备注长度不能超过 ${MOCK_LIFECYCLE_NOTE_MAX}`, "invalid_input");
        }
        // 未指定 lifecycle 且没有 note 键 = 什么都不做（返回当前视图）
        if (requested === null && body.note === undefined) {
          return ok({ node, view: mockLifecycleView(node, current, seed.now) });
        }
        if (requested !== null && !mockCanTransition(current, requested)) {
          return failFlat(
            409,
            `不能从 ${current} 迁移到 ${requested}；可用目标：${mockAllowedTransitions(current).join(" / ") || "无"}`,
            "invalid_state",
            { condition: "invalid_transition" },
          );
        }
        const next = (requested ?? current) as import("@/lib/types").NodeLifecycleValue;
        const note =
          body.note === undefined ? (stored?.note ?? null) : reqStr(body.note) || null;
        db.nodeLifecycle.set(node.id, { lifecycle: next, note, updated_at: nowIso() });
        // PATCH 也把生命周期写回节点行：`/admin/nodes` 列表与 `/impact` 之外的
        // 读面（NodeDetail）读的是节点行，不同步会出现「详情说维护中、列表说使用中」。
        // 备注同理只存在于节点行（`lifecycleView` 的键是固定的十个，不含备注），
        // 不写回这里，详情页就永远看不到自己刚填的原因。
        node.lifecycle = next;
        node.lifecycle_note = note;
        node.lifecycle_updated_at = nowIso();
        node.updated_at = nowIso();
        return ok(mockLifecycleChange(node, next, seed.now));
      }

      if (method === "DELETE") {
        const gate = mockDeleteGates({ lifecycle: current, impact: mockImpact(impactWorld(db), node.id) });
        if (!gate.ok) {
          const impact = mockImpact(impactWorld(db), node.id);
          const code = gate.condition === "node_not_retiring" ? "invalid_state" : "dependency_blocked";
          return failFlat(409, gate.message, code, { condition: gate.condition, dependencies: impact });
        }
        db.nodes.splice(db.nodes.indexOf(node), 1);
        db.nodeCredentials.delete(node.id);
        db.egressPools.delete(node.id);
        db.egressTargets.delete(node.id);
        db.nodeLifecycle.delete(node.id);
        db.nodeLeases.delete(node.id);
        db.nodeStates.delete(node.id);
        return ok({ id: node.id, deleted: true });
      }
    }

    if (seg[1] === "node" && method === "GET" && seg[3] === "impact") {
      const node = mockResolveNode(db.nodes, seg[2]);
      if (!node) return notFound("节点不存在");
      const nextRole = typeof q?.next_role === "string" ? q.next_role : undefined;
      const portMin = q?.port_min !== undefined ? Number(q.port_min) : undefined;
      const portMax = q?.port_max !== undefined ? Number(q.port_max) : undefined;
      const nextPortRange =
        portMin !== undefined && portMax !== undefined && Number.isFinite(portMin) && Number.isFinite(portMax)
          ? { min: portMin, max: portMax }
          : undefined;
      // `current_role` 缺省 = 沿用节点自身角色（与后端路由的 currentRole ?? null 同义）
      const currentRole =
        typeof q?.current_role === "string" ? q.current_role : (node.role ?? null);
      const impact = mockImpact(impactWorld(db), node.id);
      const check = {
        ...(nextPortRange ? { nextPortRange } : {}),
        ...(nextRole !== undefined || nextPortRange ? { nextRole: nextRole ?? currentRole } : {}),
      };
      return ok({
        impact,
        role_check: mockRoleCheck({
          currentRole,
          impact,
          ...check,
          activeLeasePorts: db.nodeLeases.get(node.id) ?? [],
        }),
      });
    }

    // ----- WP12 凭据：/admin/node/:id/credential[/rotate|/revoke] -----
    // 路径是单数 node（不是 nodes），与后端已合并的 WP7 路由一致。
    // 注意 path 已被 split("/")，所以 action 是 seg[3]，rotate/revoke 在 seg[4]。
    if (seg[1] === "node" && method === "POST" && seg[3] === "credential") {
      const id = parseId(seg[2]);
      if (id !== null) {
        const node = db.nodes.find((n) => n.id === id);
        if (!node) return notFound("节点不存在");
        const action = seg[4]; // undefined | "rotate" | "revoke"
        if (action === "revoke") {
          // 吊销：哈希保留 + revoked 位置位。响应只回 { revoked: true }，
          // 绝不把明文再吐出来一次（契约：NodeCredentialRevoked）
          if (!node.has_credential) return badRequest("该节点尚未签发凭据，无法吊销");
          if (node.credential_revoked) return badRequest("凭据已处于吊销状态");
          node.credential_revoked = true;
          node.credential_last_rejected_at = nowIso();
          node.updated_at = nowIso();
          const revokedBody: NodeCredentialRevoked = { revoked: true, node_id: node.id, node_key: node.node_id };
          return ok(revokedBody);
        }
        // 签发（/credential）或轮转（/credential/rotate）：明文只在本次响应可见
        const isRotate = action === "rotate";
        if (action !== undefined && !isRotate) return notFound("接口不存在");
        const issued = db.nodeCredentials.get(node.id);
        if (isRotate && !node.has_credential) {
          return badRequest("当前没有生效凭据，无法轮转（请先签发）");
        }
        const rotation = (issued?.rotation_count ?? (node.has_credential ? 1 : 0)) + 1;
        const issuedAt = nowIso();
        db.nodeCredentials.set(node.id, {
          rotation_count: rotation,
          issued_at: issuedAt,
          last_rejected_at: issued?.last_rejected_at ?? null,
        });
        node.has_credential = true;
        node.credential_revoked = false;
        node.credential_rotated_at = issuedAt;
        node.credential_last_rejected_at = null;
        node.updated_at = issuedAt;
        // mock 假 token：真实后端也只在该响应里给一次明文（NodeCredentialIssued）
        const credential = `tunx_mock_${node.node_id}_${rotation}_${Math.random().toString(36).slice(2, 10)}`;
        const issuedBody: NodeCredentialIssued = {
          credential,
          node_id: node.id,
          node_key: node.node_id,
          ...(isRotate ? { rotated_at: issuedAt } : { issued_at: issuedAt }),
        };
        return ok(issuedBody);
      }
    }

    // ----- node-groups -----
    if (seg[1] === "node-groups") {
      if (method === "GET" && seg[2] === undefined) {
        const items = filterByStatus(filterByKeyword(db.nodeGroups, q, ["name", "token"]), q).map((g) => withGroupStats(db, g));
        return ok(paginate(items, q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const parsed = readNodeGroupPayload(db, asRecord(req.body), false);
        if (isResponse(parsed)) return parsed;
        const id = nextId(db.nodeGroups);
        const group: NodeGroup = {
          id,
          token: parsed.patch.token ?? `ng_${id}`,
          name: parsed.patch.name ?? `节点组 ${id}`,
          port_range: parsed.patch.port_range ?? null,
          connect_ip: parsed.patch.connect_ip ?? null,
          node_type: parsed.patch.node_type ?? "in",
          load_balance_type: parsed.patch.load_balance_type ?? "round",
          allow_listen_protocol: parsed.patch.allow_listen_protocol ?? false,
          allow_listen_protocols: parsed.patch.allow_listen_protocols ?? null,
          allow_tunnel_types: parsed.patch.allow_tunnel_types ?? null,
          bypass_type: parsed.patch.bypass_type ?? "blacklist",
          bypass_list: parsed.patch.bypass_list ?? null,
          admission: parsed.patch.admission ?? false,
          block_protocols: parsed.patch.block_protocols ?? null,
          traffic_rate: parsed.patch.traffic_rate ?? 1,
          need_out_node_group: parsed.patch.need_out_node_group ?? false,
          allow_out_node_groups: parsed.patch.allow_out_node_groups ?? null,
          allow_in_node_groups: parsed.patch.allow_in_node_groups ?? null,
          order_by: parsed.patch.order_by ?? db.nodeGroups.reduce((m, x) => Math.max(m, x.order_by), 0) + 100,
          user_id: user.id,
          created_at: nowIso(),
          updated_at: nowIso(),
          node_count: 0,
          online_node_count: 0,
        };
        db.nodeGroups.push(group);
        return ok(group);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const group = db.nodeGroups.find((g) => g.id === id);
        if (!group) return notFound("节点组不存在");
        if (method === "GET" && seg[3] === undefined) return ok(withGroupStats(db, group));
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const parsed = readNodeGroupPayload(db, asRecord(req.body), true, id);
          if (isResponse(parsed)) return parsed;
          Object.assign(group, parsed.patch);
          group.updated_at = nowIso();
          return ok(withGroupStats(db, group));
        }
        if (method === "DELETE" && seg[3] === undefined) {
          if (db.nodes.some((n) => n.node_group_id === group.id)) return badRequest("请先移除该节点组下的节点");
          if (db.tunnels.some((t) => t.in_node_group_id === group.id || t.out_node_group_id === group.id)) {
            return badRequest("该节点组仍被隧道引用，无法删除");
          }
          db.nodeGroups.splice(db.nodeGroups.indexOf(group), 1);
          return ok({ ok: true, id: group.id });
        }
      }
    }

    // ----- plans -----
    if (seg[1] === "plans") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.plans, q, ["name"]), q), q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const parsed = readPlanPayload(db, asRecord(req.body), false);
        if (isResponse(parsed)) return parsed;
        const id = nextId(db.plans);
        const plan: Plan = {
          id,
          name: parsed.patch.name ?? `套餐 ${id}`,
          description: parsed.patch.description ?? null,
          original_price: parsed.patch.original_price ?? null,
          price: parsed.patch.price ?? 0,
          max_tunnels: parsed.patch.max_tunnels ?? null,
          traffic: parsed.patch.traffic ?? null,
          ip_limit: parsed.patch.ip_limit ?? null,
          client_limit: parsed.patch.client_limit ?? null,
          bandwidth_limit: parsed.patch.bandwidth_limit ?? null,
          whitelist_limit: parsed.patch.whitelist_limit ?? null,
          allow_custom_in_node_group: parsed.patch.allow_custom_in_node_group ?? false,
          allow_custom_out_node_group: parsed.patch.allow_custom_out_node_group ?? false,
          all_in_node_groups: parsed.patch.all_in_node_groups ?? false,
          all_out_node_groups: parsed.patch.all_out_node_groups ?? false,
          setup_fee: parsed.patch.setup_fee ?? null,
          billing_cycle: parsed.patch.billing_cycle ?? "month",
          status: parsed.patch.status ?? "active",
          renewable: parsed.patch.renewable ?? true,
          stock: parsed.patch.stock ?? null,
          order_by: parsed.patch.order_by ?? db.plans.reduce((m, x) => Math.max(m, x.order_by), 0) + 100,
          created_at: nowIso(),
          updated_at: nowIso(),
          node_groups: parsed.patch.node_groups ?? [],
        };
        db.plans.push(plan);
        return ok(plan);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const plan = db.plans.find((p) => p.id === id);
        if (!plan) return notFound("套餐不存在");
        if (method === "GET" && seg[3] === undefined) return ok(plan);
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const parsed = readPlanPayload(db, asRecord(req.body), true);
          if (isResponse(parsed)) return parsed;
          Object.assign(plan, parsed.patch);
          plan.updated_at = nowIso();
          return ok(plan);
        }
        if (method === "DELETE" && seg[3] === undefined) {
          if (db.userPlans.some((p) => p.plan_id === plan.id)) return badRequest("该套餐仍有用户订阅，无法删除");
          db.plans.splice(db.plans.indexOf(plan), 1);
          return ok({ ok: true, id: plan.id });
        }
      }
    }

    // ----- tunnels（管理端全量） -----
    if (seg[1] === "tunnels") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.tunnels, q, ["name"]), q), q));
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const tunnel = db.tunnels.find((t) => t.id === id);
        if (!tunnel) return notFound("隧道不存在");
        if (method === "GET" && seg[3] === undefined) return ok(tunnel);
        if (method === "DELETE" && seg[3] === undefined) {
          db.tunnels.splice(db.tunnels.indexOf(tunnel), 1);
          return ok({ ok: true, id: tunnel.id });
        }
        if (method === "POST" && seg[3] === "toggle") {
          tunnel.status = tunnel.status === "active" ? "inactive" : "active";
          tunnel.online = tunnel.status === "active";
          tunnel.updated_at = nowIso();
          return ok(tunnel);
        }
      }
    }

    // ----- orders -----
    if (seg[1] === "orders" && method === "GET") {
      const kind = String(q?.kind ?? "all");
      const planOrders = db.planOrders.map((o) => ({ ...o, kind: "plan" as const }));
      const topOrders = db.topupOrders.map((o) => ({ ...o, kind: "topup" as const }));
      const all = kind === "plan" ? planOrders : kind === "topup" ? topOrders : [...planOrders, ...topOrders];
      return ok(paginate(all, q));
    }

    // ----- tickets（管理端全量） -----
    if (seg[1] === "tickets") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.tickets, q, ["title"]), q), q));
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const ticket = db.tickets.find((t) => t.id === id);
        if (!ticket) return notFound("工单不存在");
        if (method === "GET" && seg[3] === undefined) return ok(ticket);
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const body = asRecord(req.body);
          if (body.status !== undefined) {
            const s = reqStr(body.status);
            if (s !== "open" && s !== "closed") return badRequest("工单状态不合法");
            ticket.status = s;
          }
          ticket.updated_at = nowIso();
          return ok(ticket);
        }
        if (method === "POST" && seg[3] === "replies") {
          const body = asRecord(req.body);
          const contentR = required(body, "content", "回复内容", 5000);
          if (isResponse(contentR)) return contentR;
          const reply: TicketReply = {
            id: nextId(ticket.replies ?? []),
            content: contentR.value,
            is_admin: true,
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
    }

    // ----- balance logs -----
    if (seg[1] === "balance-logs" && method === "GET") {
      return ok(paginate(db.balanceLogs, q));
    }

    // ----- audit-logs（审计日志，只读；列表倒序）-----
    if (seg[1] === "audit-logs" && method === "GET" && seg[2] === undefined) {
      let items = [...db.auditLogs].sort((a, b) => b.id - a.id);
      const kw = String(q?.keyword ?? "").trim().toLowerCase();
      if (kw) {
        items = items.filter((a) =>
          [a.path, a.action, a.actor_email ?? "", a.resource].some((v) =>
            String(v).toLowerCase().includes(kw),
          ),
        );
      }
      const actorType = q?.actor_type;
      if (actorType && actorType !== "all") items = items.filter((a) => a.actor_type === actorType);
      const meth = q?.method;
      if (meth && meth !== "all") items = items.filter((a) => a.method === meth);
      return ok(paginate(items, q));
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }
  return null;
}

/**
 * 从未上报的**空态视图**（形状 = 真实后端 `NodeStateView`，字段逐个对齐
 * `backend/src/services/node-admin-state.ts` 的 `getNodeState`）。
 *
 * 为什么不是 `null`：客户端把「载荷为 null」判成**响应形状不认识 = 取不到**
 * （见 `lib/node-runtime-state.ts`），而「从未上报」是 200 的契约事实。
 * 两者混成同一个值，界面就又会把「接口坏了」显示成「节点还没上报」。
 */
function mockEmptyNodeState(node: Node) {
  return {
    node_id: node.id,
    node_key: node.node_id,
    role: node.role ?? null,
    reported_role: null,
    role_mismatch: false,
    online: node.status === "active",
    status: node.status,
    last_seen_at: node.last_seen_at ?? null,
    reported_at: null,
    age_seconds: null,
    // 无快照 = 无新鲜证据（后端 `snapshot ? isStaleState(...) : true` 同一口径）
    stale: true,
    version: null,
    reported_revision: null,
    tunnels: [],
    used_ports: [],
    egress_pools: {},
    last_error: null,
    control_protocol_version: null,
    capabilities: null,
  };
}

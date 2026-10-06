/**
 * Node runtime/state read models and credential-state projections.
 */
import { DEFAULT_POOL_NAME, err, toAdminError, deps, asRow, asRows, falsy, parseOk, parseFail, parseNodeRole, isValidTargetPort, parsePortRange, parseLbStrategy, parseEgressStatus, parseRequiredHost, parseOptionalHost, parsePoolName, parseTargetPort, parseWeight, parseOrderBy, parseRemark, hasEgressCapability, poolHasViableTarget, isRoleMismatch, stateAgeSeconds, isStaleState, credentialStateOf, jsonOr } from "./node-admin-core.ts";
import type { NodeRoleValue, EgressStatusValue, NodeAdminError, NodeRow, StateReportRow, EgressPoolRow, EgressTargetRow, NodeAdminDb, NodeAdminDeps, ParseResult, NodeCredentialState } from "./node-admin-core.ts";

/* ================================================================== */
/* runtime / state query（读 node_state_report，WP7 落库的快照）          */
/* ================================================================== */

export interface NodeStateView {
  node_id: number;
  node_key: string;
  role: NodeRoleValue | null;
  reported_role: string | null;
  role_mismatch: boolean;
  online: boolean;
  status: string;
  last_seen_at: Date | null;
  reported_at: Date | null;
  age_seconds: number | null;
  stale: boolean;
  version: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  used_ports: unknown;
  egress_pools: unknown;
  last_error: string | null;
  /**
   * V4-WP11B 控制协议协商事实。
   * `null` = 该 Agent 未上报（按基线动作处理），数组 = 其自述实现的动作清单。
   * 两者在下发判定里含义不同，因此这里也不做「null → []」的归一。
   */
  control_protocol_version: number | null;
  capabilities: string[] | null;
}

/**
 * 单节点运行态视图。
 *
 * 三个「不一致」都在这里显式标注而不是抹平：
 *   · `role_mismatch`：Agent 自报角色 vs 面板角色。以 `node.role` 为准
 *     （§7.4「role 不回填、不猜」的延伸），不一致只提示不覆盖；
 *   · `stale` / `online`：快照陈旧（DB 侧单一真相）与 `node.status`
 *     （Redis 防抖翻转）是两套口径，前端两个都展示——管理员需要知道
 *     「offline-detector 说在线但五分钟没上报」这种自相矛盾的情况。
 */
export async function getNodeState(
  nodeId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; state: NodeStateView } | NodeAdminError> {
  const { db: pd, now } = await deps(inject);

  const node = asRow<NodeRow>(
    await pd.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        node_id: true,
        role: true,
        status: true,
        last_seen_at: true,
      },
    }),
  );
  if (!node) return err("not_found", "节点不存在");

  const snapshot = asRow<StateReportRow>(
    await pd.nodeStateReport.findUnique({
      where: { node_id: nodeId },
      select: {
        node_id: true,
        version: true,
        role: true,
        reported_revision: true,
        tunnels: true,
        egress_pools: true,
        used_ports: true,
        last_error: true,
        reported_at: true,
        // V4-WP11B: the operator needs to see "this node cannot receive action X
        // yet" before it happens, not as a dispatch failure afterwards.
        control_protocol_version: true,
        capabilities: true,
      },
    }),
  );

  const roleParsed = parseNodeRole(node.role);
  const nowDate = now();
  const age = snapshot ? stateAgeSeconds(snapshot.reported_at, nowDate) : null;
  const stale = snapshot ? isStaleState(snapshot.reported_at, nowDate) : true;

  return {
    ok: true,
    state: {
      node_id: node.id,
      node_key: node.node_id,
      role: roleParsed.ok ? roleParsed.value : null,
      reported_role: snapshot?.role ?? null,
      role_mismatch: snapshot ? isRoleMismatch(snapshot.role, node.role) : false,
      online: node.status === "active",
      status: node.status,
      last_seen_at: node.last_seen_at ?? null,
      reported_at: snapshot?.reported_at ?? null,
      age_seconds: age,
      stale,
      version: snapshot?.version ?? null,
      reported_revision: snapshot?.reported_revision ?? null,
      tunnels: jsonOr(snapshot?.tunnels, []),
      used_ports: jsonOr(snapshot?.used_ports, []),
      egress_pools: jsonOr(snapshot?.egress_pools, {}),
      last_error: snapshot?.last_error ?? null,
      // Negotiation facts, surfaced verbatim. `capabilities: null` means "this
      // Agent never told us" and must NOT be rendered as an empty list: the two
      // have different meanings for what the panel is allowed to send.
      control_protocol_version: snapshot?.control_protocol_version ?? null,
      capabilities: Array.isArray(snapshot?.capabilities) ? snapshot?.capabilities : null,
    },
  };
}

export interface FleetStateOptions {
  /** 面板角色过滤：缺省 / 空串 = 不过滤，`all` 视为不过滤。 */
  role?: string | null;
  /** 在线过滤：`true` / `false` / `1` / `0` / `yes` / `no`；缺省或空串 = 不过滤。 */
  online?: string | null;
  /** 上报过期的过滤（同上）。 */
  stale?: string | null;
}

/**
 * 查询串里的三段布尔解析：`?online=true` / `?online=false` / `?online=` / 缺省。
 *
 * 空串与缺省都是「不过滤」（面板的下拉框没选时发 `?online=`），不是 false——
 * 把人家的下拉默认值当成「只看离线」会变成最常见的面板误报来源。
 */
function parseBoolQuery(input: unknown): boolean | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  return !falsy(input);
}

/** 面板的角色过滤下拉：「all」与空串都是「全部」，不是非法角色。 */
function normalizeRoleQuery(input: string | null | undefined): string | null | undefined {
  if (input === undefined || input === null) return input;
  const v = input.trim().toLowerCase();
  if (v === "" || v === "all") return null;
  return v;
}

/** 全量节点运行态（管理端巡检页）。`role` / `online` / `stale` 三段过滤。 */
export async function listNodeStates(
  options: FleetStateOptions = {},
  inject?: NodeAdminDeps,
): Promise<{ ok: true; states: NodeStateView[]; total: number } | NodeAdminError> {
  const { db: pd, now } = await deps(inject);

  const roleParsed = parseNodeRole(normalizeRoleQuery(options.role));
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const onlineFilter = parseBoolQuery(options.online);
  const staleFilter = parseBoolQuery(options.stale);

  const where: Record<string, unknown> = {};
  if (roleParsed.value !== null) where.role = roleParsed.value;
  if (onlineFilter === true) where.status = "active";
  if (onlineFilter === false) where.status = { not: "active" };

  const nodes = asRows<NodeRow>(
    await pd.node.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      select: {
        id: true,
        node_id: true,
        role: true,
        status: true,
        last_seen_at: true,
      },
    }),
  );

  const nowDate = now();
  const states: NodeStateView[] = [];
  for (const node of nodes) {
    const snapshot = asRow<StateReportRow>(
      await pd.nodeStateReport.findUnique({
        where: { node_id: node.id },
        select: {
          node_id: true,
          version: true,
          role: true,
          reported_revision: true,
          tunnels: true,
          egress_pools: true,
          used_ports: true,
          last_error: true,
          reported_at: true,
          control_protocol_version: true,
          capabilities: true,
        },
      }),
    );
    const roleVal = parseNodeRole(node.role);
    const age = snapshot ? stateAgeSeconds(snapshot.reported_at, nowDate) : null;
    const stale = snapshot ? isStaleState(snapshot.reported_at, nowDate) : true;
    if (staleFilter !== undefined && stale !== staleFilter) continue;
    states.push({
      node_id: node.id,
      node_key: node.node_id,
      role: roleVal.ok ? roleVal.value : null,
      reported_role: snapshot?.role ?? null,
      role_mismatch: snapshot ? isRoleMismatch(snapshot.role, node.role) : false,
      online: node.status === "active",
      status: node.status,
      last_seen_at: node.last_seen_at ?? null,
      reported_at: snapshot?.reported_at ?? null,
      age_seconds: age,
      stale,
      version: snapshot?.version ?? null,
      reported_revision: snapshot?.reported_revision ?? null,
      tunnels: jsonOr(snapshot?.tunnels, []),
      used_ports: jsonOr(snapshot?.used_ports, []),
      egress_pools: jsonOr(snapshot?.egress_pools, {}),
      last_error: snapshot?.last_error ?? null,
          // Same rule as the single-node view: null means "not reported", and the
      // two cases must not be collapsed into an empty list.
      control_protocol_version: snapshot?.control_protocol_version ?? null,
      capabilities: Array.isArray(snapshot?.capabilities) ? snapshot?.capabilities : null,
});
  }
  return { ok: true, states, total: states.length };
}

/**
 * credential 列表（状态查询，**绝不下发明文或哈希**）。
 *
 * 逐个节点 include `state_report` 会让查询变成 N+1，这里一次性按节点
 * **分桶**拉取：快照按 `node_id` 唯一，Map 查找是 O(1)。
 */
export async function listNodeStatesWithCredentials(
  options: FleetStateOptions = {},
  inject?: NodeAdminDeps,
): Promise<
  | { ok: true; items: Array<NodeStateView & { credential: NodeCredentialState }>; total: number }
  | NodeAdminError
> {
  const { db: pd, now } = await deps(inject);

  const roleParsed = parseNodeRole(normalizeRoleQuery(options.role));
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const onlineFilter = parseBoolQuery(options.online);
  const staleFilter = parseBoolQuery(options.stale);

  const where: Record<string, unknown> = {};
  if (roleParsed.value !== null) where.role = roleParsed.value;
  if (onlineFilter === true) where.status = "active";
  if (onlineFilter === false) where.status = { not: "active" };

  const nodes = asRows<NodeRow>(
    await pd.node.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      select: {
        id: true,
        node_id: true,
        role: true,
        status: true,
        last_seen_at: true,
        node_credential_hash: true,
        credential_revoked: true,
        credential_rotated_at: true,
        credential_last_rejected_at: true,
      },
    }),
  );

  // 快照一次拉全再按 node_id 分桶（没有 include 的 N+1）。
  const reports = asRows<StateReportRow>(
    await pd.nodeStateReport.findMany({
      select: {
        node_id: true,
        version: true,
        role: true,
        reported_revision: true,
        tunnels: true,
        egress_pools: true,
        used_ports: true,
        last_error: true,
        reported_at: true,
        control_protocol_version: true,
        capabilities: true,
      },
    }),
  );
  const byNode = new Map(reports.map((r) => [r.node_id, r]));

  const nowDate = now();
  const items: Array<NodeStateView & { credential: NodeCredentialState }> = [];
  for (const node of nodes) {
    const snapshot = byNode.get(node.id) ?? null;
    const roleVal = parseNodeRole(node.role);
    const age = snapshot ? stateAgeSeconds(snapshot.reported_at, nowDate) : null;
    const stale = snapshot ? isStaleState(snapshot.reported_at, nowDate) : true;
    if (staleFilter !== undefined && stale !== staleFilter) continue;
    items.push({
      node_id: node.id,
      node_key: node.node_id,
      role: roleVal.ok ? roleVal.value : null,
      reported_role: snapshot?.role ?? null,
      role_mismatch: snapshot ? isRoleMismatch(snapshot.role, node.role) : false,
      online: node.status === "active",
      status: node.status,
      last_seen_at: node.last_seen_at ?? null,
      reported_at: snapshot?.reported_at ?? null,
      age_seconds: age,
      stale,
      version: snapshot?.version ?? null,
      reported_revision: snapshot?.reported_revision ?? null,
      tunnels: jsonOr(snapshot?.tunnels, []),
      used_ports: jsonOr(snapshot?.used_ports, []),
      egress_pools: jsonOr(snapshot?.egress_pools, {}),
      last_error: snapshot?.last_error ?? null,
      // 状态投影：只有布尔/时间戳，没有哈希也没有明文。
      credential: credentialStateOf(node),
      // Negotiation facts; `null` (never reported) is preserved as null.
      control_protocol_version: snapshot?.control_protocol_version ?? null,
      capabilities: Array.isArray(snapshot?.capabilities) ? snapshot?.capabilities : null,
    });
  }
  return { ok: true, items, total: items.length };
}

/**
 * 单节点凭据状态（`GET /api/admin/node/:id/credential`）。
 *
 * 「list/get」在 WP7 只交付了 issue/rotate/revoke，这里补的是**读**——
 * 面板需要回答「这个节点签过吗 / 撤销了吗 / 上次什么时候动过 / 谁还在拿旧
 * 钥匙敲门」。明文与哈希都不出现在响应里（见 {@link credentialStateOf}）。
 */
export async function getNodeCredential(
  nodeId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; credential: NodeCredentialState } | NodeAdminError> {
  const { db: pd } = await deps(inject);
  const node = asRow<{
    id: number;
    node_id: string;
    role: string | null;
    node_credential_hash: string | null;
    credential_revoked: boolean;
    credential_rotated_at: Date | null;
    credential_last_rejected_at: Date | null;
  }>(
    await pd.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        node_id: true,
        role: true,
        node_credential_hash: true,
        credential_revoked: true,
        credential_rotated_at: true,
        credential_last_rejected_at: true,
      },
    }),
  );
  if (!node) return err("not_found", "节点不存在");
  return { ok: true, credential: credentialStateOf(node) };
}


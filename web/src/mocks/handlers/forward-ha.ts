/**
 * `GET /api/forwards/:id/ha` 与 `PUT /api/forwards/:id/preferred-ingress` 的 mock。
 *
 * ── 为什么单独一个文件（而不是塞进 `handlers/forwards.ts`）──
 * 那份文件正被另一个切片占用（写冲突），而且本文件的形状是一条**独立契约**。
 * 分发点由 Lead 统一接线：必须放在 `handleForwardsMock` **之前**，因为
 * `handleForwardsMock` 把整个 `/forwards/*` 命名空间认领了，未识别的子路径会在它内部
 * 直接 404（与 `handleDdnsMock` 排在它前面的理由逐字相同）。
 *
 * 导出：`handleForwardHaMock(ctx: MockAuthedRouteContext): Promise<MockResponse | null>`
 * （ctx 形状与 `handleForwardsMock` / `handleDdnsMock` 完全一致：`{ method, clean, seg, q, db, user, req, scopeId }`）。
 * 未命中本文件的路径一律返回 `null`，让后面的 handler 继续处理。
 *
 * ── 与真实后端同形的三条纪律 ──
 *
 *   1. **策略缺省即关**：`db.systemConfig` 里没有 `FAILOVER_POLICY` ⇒ 两个开关都 `false`
 *      （生产缺省），坏 JSON ⇒ 也 `false` 但带 `parse_error`。mock **绝不**默认成"已启用"
 *      —— 那会让开发期看到一幅比生产更乐观的画面，正是本专项反复吃过亏的形态；
 *   2. **三态可分**：候选 `available` / `none` / `unavailable`。mock 里只有"候选查询抛错"
 *      才会出现 `unavailable`（正常数据面不会），所以这里用 `status: "none"` 表示"判定过，
 *      确实没有"，两者**不共用**文案；
 *   3. **期望与事实分开**：`preferred_ingress_node_id` 存在 mock 自己的模块级 Map 里
 *      （真实库里是 `tunnel.preferred_ingress_node_id` 列；Web 侧的 `Tunnel` 类型没有这一列，
 *      本文件不为了 mock 去改 `lib/types.ts`）；`connection` / `accepts_new_business` 来自
 *      与用户节点列表**同一份**投影（`mockUserNode`），`can_be_preferred` 只用写入路径
 *      自己的两条规则（同组 + `role ∈ {ingress, both}`）。
 */
import * as rt from "@/mocks/runtime";
import type { MockResponse } from "@/mocks/runtime";
import { fail, mockIngressNode, mockUserNode, notFound, ok, parseId } from "@/mocks/runtime";

/**
 * 「恢复后切回」要连续健康多少次才能回切：与后端 `services/failover-thresholds.ts` 的
 * `FAILOVER_THRESHOLDS.FAILBACK_HEALTHY_CHECKS` **同一个语义**（mock 里重复一个数字是为了
 * 让开发期看到的进度分母与生产一致；它不是第二条策略真相 —— 生产读的是后端那份）。
 */
const FAILBACK_HEALTHY_CHECKS = 3;

/** preferred ingress：mock 侧的内存态（key = forward id）。 */
const preferredByForward = new Map<number, number | null>();

/**
 * task-43：入口成员次序（意图）的内存态，key = forward id。
 *
 * mock 里没有数据库，所以用一个 Map 顶替 `forward_ingress_member` 表；**只有意图**
 * （node_id + is_enabled），与真实表一致 —— 不存任何连接/健康事实。
 */
const memberOrderByForward = new Map<number, Array<{ node_id: number; is_enabled: boolean }>>();
/** 读序失败开关（测试用：证明"读不到次序 ⇒ 回退平台默认次序"）。 */
let orderUnreadable = false;

/** 测试用：清空 mock 的偏好态（`resetStore()` 不会碰本模块的 Map）。 */
export function resetForwardHaMock(): void {
  preferredByForward.clear();
  memberOrderByForward.clear();
  orderUnreadable = false;
}

/** 测试用：模拟次序读不到（真实环境的对应物是成员表查询失败）。 */
export function setForwardHaOrderUnreadable(value: boolean): void {
  orderUnreadable = value;
}

function roleAcceptsIngress(role: string | null): boolean {
  return role === "ingress" || role === "both";
}

function readPolicy(db: rt.Store): {
  auto_failover: boolean;
  auto_failback: boolean;
  parse_error: string | null;
} {
  const row = db.systemConfig.find((item) => item.name === "FAILOVER_POLICY");
  const raw = row?.value ?? null;
  if (raw === null || raw === "") return { auto_failover: false, auto_failback: false, parse_error: null };
  try {
    const parsed = JSON.parse(raw) as { auto_failover?: unknown; auto_failback?: unknown };
    return {
      auto_failover: parsed.auto_failover === true,
      auto_failback: parsed.auto_failback === true,
      parse_error: null,
    };
  } catch (error) {
    return {
      auto_failover: false,
      auto_failback: false,
      parse_error: (error as Error)?.message ?? String(error),
    };
  }
}

function projectionOf(db: rt.Store, forwardId: number): MockResponse | null {
  const tunnel = db.tunnels.find((row) => row.id === forwardId);
  if (!tunnel) return notFound("转发不存在");
  // 现任入口：mock 与它自己的转发视图**同一处解析**（`mockIngressNode`）。
  // 真实后端读 `tunnel.ingress_node_id` 列；mock 种子行里这一列常常为空，共用同一个
  // 解析函数才不会出现"HA 卡片说没有归属、详情页同时显示着一台入口"这种自相矛盾。
  const activeIngress = mockIngressNode(db, tunnel)?.id ?? tunnel.ingress_node_id ?? null;
  const preferred = preferredByForward.has(forwardId)
    ? preferredByForward.get(forwardId) ?? null
    : null;
  /**
   * 接管判定的 mock 镜像（**同一个词表**：与 `services/ingress-candidate.ts` 的
   * `candidateRejection` 顺序一致：现任 → 准入 → 角色 → 凭据 → 在线）。
   * 它只用于开发期演示，`available`/`none` 与真实后端同一口径；措辞纪律由卡片层守。
   */
  function takeoverRejection(node: {
    id: number;
    role: string | null;
    connection: string;
    accepts_new_business: boolean;
    admission_rejection: string | null;
    credential_revoked: boolean;
  }): string | null {
    if (activeIngress !== null && node.id === activeIngress) return "current_owner";
    if (!node.accepts_new_business) return node.admission_rejection ?? "node_not_admitted";
    if (!roleAcceptsIngress(node.role ?? null)) return node.role == null ? "role_undeclared" : "role_mismatch";
    if (node.credential_revoked) return "node_credential_revoked";
    if (node.connection !== "online") return "node_not_online";
    return null;
  }

  const intent = memberOrderByForward.get(forwardId) ?? [];
  const intentRank = new Map<number, number>();
  const intentOrder = new Map<number, number>();
  const intentDisabled = new Set<number>();
  let enabledRank = 0;
  intent.forEach((row, index) => {
    intentRank.set(row.node_id, index + 1);
    if (row.is_enabled) {
      intentOrder.set(row.node_id, enabledRank);
      enabledRank += 1;
    } else {
      intentDisabled.add(row.node_id);
    }
  });
  const orderRank = (nodeId: number): number | null => intentOrder.get(nodeId) ?? null;

  const nodes: Array<ReturnType<typeof shapeMember>> = [];
  function shapeMember(node: ReturnType<typeof mockUserNode>) {
    const isDisabled = intentDisabled.has(node.id);
    const rejection = isDisabled
      ? "member_disabled"
      : takeoverRejection({
          id: node.id,
          role: node.role ?? null,
          connection: node.connection ?? "offline",
          accepts_new_business: node.accepts_new_business === true,
          admission_rejection: node.admission_rejection ?? null,
          credential_revoked: node.credential_revoked === true,
        });
    const canTakeOver = rejection === null;
    return {
      node_id: node.id,
      name: node.node_id,
      role: node.role ?? null,
      node_group_id: node.node_group_id,
      is_active_ingress: node.id === activeIngress,
      is_preferred: node.id === preferred,
      is_failback_target: preferred !== null && node.id === preferred && preferred !== activeIngress,
      can_be_preferred: roleAcceptsIngress(node.role ?? null),
      preference_rejection: roleAcceptsIngress(node.role ?? null)
        ? null
        : node.role == null
          ? "role_undeclared"
          : "role_mismatch",
      connection: node.connection ?? "offline",
      lifecycle: node.lifecycle ?? "active",
      accepts_new_business: node.accepts_new_business === true,
      admission_rejection: node.admission_rejection ?? null,
      can_take_over: canTakeOver,
      takeover_rejection: rejection,
      failover_rank: null as number | null,
      in_saved_order: intentRank.has(node.id),
      member_rank: intentRank.get(node.id) ?? null,
      is_disabled: isDisabled,
    };
  }

  db.nodes
    .filter((node) => node.node_group_id === tunnel.in_node_group_id)
    .map((node) => mockUserNode(db, node))
    .sort((a, b) => {
      const ra = intentRank.get(a.id) ?? null;
      const rb = intentRank.get(b.id) ?? null;
      if (ra !== null && rb !== null) return ra - rb;
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      return a.id - b.id;
    })
    .forEach((node) => nodes.push(shapeMember(node)));

  // 接管次序：只对能接管的成员按"意图次序优先、其余按 node id 升序"编号（与后端同一规则）。
  nodes
    .filter((node) => node.can_take_over)
    .sort((a, b) => {
      const ra = orderRank(a.node_id);
      const rb = orderRank(b.node_id);
      if (ra !== null && rb !== null) return ra - rb;
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      return a.node_id - b.node_id;
    })
    .forEach((node, index) => {
      node.failover_rank = index + 1;
    });

  // 候选：与后端 `pickFailoverDestination` 同一口径（非现任 + 准入 + 角色 + 此刻在线），
  // 取 id 最小的一台 —— 也就是 `failover_rank === 1` 的那台。
  const candidate = nodes.find((node) => node.failover_rank === 1);
  const policy = readPolicy(db);

  return ok({
    forward_id: tunnel.id,
    preferred_ingress_node_id: preferred,
    active_ingress_node_id: activeIngress,
    policy,
    failover_candidate: {
      status: candidate ? "available" : "none",
      node_id: candidate ? candidate.node_id : null,
      reason: null,
    },
    ingress_members: { status: "ok", nodes },
    member_priority: {
      source: !orderUnreadable && intent.length > 0 ? "forward_member_table" : "platform_rule_node_id_asc",
      custom_order_supported: true,
      order_readable: !orderUnreadable,
    },
    failback: {
      auto_failback: policy.auto_failback,
      target_node_id: preferred !== null && preferred !== activeIngress ? preferred : null,
      preferred_ingress_node_id: preferred,
      progress: {
        // Web 侧的 `Tunnel` 类型没有 `failback_healthy_checks`（真实库里是 tunnel 的列）；
        // mock 用一个可选读数，缺省 0 —— 与生产"没有计数即 0"的语义一致。
        healthy_checks: Number((tunnel as { failback_healthy_checks?: number }).failback_healthy_checks ?? 0),
        required_checks: FAILBACK_HEALTHY_CHECKS,
        met:
          Number((tunnel as { failback_healthy_checks?: number }).failback_healthy_checks ?? 0) >=
          FAILBACK_HEALTHY_CHECKS,
      },
    },
  });
}

function setPreferred(db: rt.Store, forwardId: number, nodeId: number | null): MockResponse {
  const tunnel = db.tunnels.find((row) => row.id === forwardId);
  if (!tunnel) return notFound("转发不存在");
  if (nodeId !== null) {
    const node = db.nodes.find((row) => row.id === nodeId);
    if (!node) return fail(404, "节点不存在", "preferred_not_found");
    if (node.node_group_id !== tunnel.in_node_group_id) {
      return fail(400, "首选节点必须属于该转发的入口节点组", "preferred_node_group_mismatch");
    }
    const view = mockUserNode(db, node);
    if (!roleAcceptsIngress(view.role ?? null)) {
      return fail(400, "该节点的角色不能作为入口（需要 ingress 或 both）", "preferred_role_mismatch");
    }
  }
  preferredByForward.set(forwardId, nodeId);
  return ok({ tunnel_id: forwardId, preferred_ingress_node_id: nodeId });
}

export async function handleForwardHaMock(ctx: rt.MockAuthedRouteContext): Promise<MockResponse | null> {
  const { method, seg, db } = ctx;
  if (seg[0] !== "forwards") return null;
  const id = parseId(seg[1]);
  if (seg[2] === "ha" && method === "GET" && id !== null) {
    return projectionOf(db, id);
  }
  if (seg[2] === "ingress-members" && method === "PUT" && id !== null) {
    const tunnel = db.tunnels.find((row) => row.id === id);
    if (!tunnel) return notFound("转发不存在");
    const body = rt.asRecord(ctx.req.body);
    const raw = body.members;
    if (!Array.isArray(raw)) return fail(400, "members 不合法", "invalid_input");
    const parsed: Array<{ node_id: number; is_enabled: boolean }> = [];
    for (const item of raw as unknown[]) {
      const row = rt.asRecord(item);
      const nodeId = row.node_id;
      if (typeof nodeId !== "number" || !Number.isInteger(nodeId) || nodeId <= 0) {
        return fail(400, "node_id 不合法", "invalid_input");
      }
      if (parsed.some((m) => m.node_id === nodeId)) {
        return fail(400, `成员次序里出现重复的节点 #${nodeId}`, "member_duplicated");
      }
      parsed.push({ node_id: nodeId, is_enabled: row.is_enabled !== false });
    }
    for (const member of parsed) {
      const node = db.nodes.find((row) => row.id === member.node_id);
      if (!node) return fail(404, `节点 #${member.node_id} 不存在`, "member_node_not_found");
      if (node.node_group_id !== tunnel.in_node_group_id) {
        return fail(400, `节点 #${member.node_id} 不在该转发的入口节点组里`, "member_node_group_mismatch");
      }
      if (!roleAcceptsIngress(mockUserNode(db, node).role ?? null)) {
        return fail(400, `节点 #${member.node_id} 的角色不能作为入口（需要 ingress 或 both）`, "member_role_mismatch");
      }
    }
    if (parsed.length === 0) memberOrderByForward.delete(id);
    else memberOrderByForward.set(id, parsed);
    // 与成员表**同一条写入路径**维护回切目标（第一台启用的成员）。
    const preferred = parsed.find((member) => member.is_enabled)?.node_id ?? null;
    preferredByForward.set(id, preferred);
    return ok({
      tunnel_id: id,
      members: parsed.map((member, index) => ({ ...member, priority: index })),
      preferred_ingress_node_id: preferred,
    });
  }
  if (seg[2] === "preferred-ingress" && method === "PUT" && id !== null) {
    const body = rt.asRecord(ctx.req.body);
    const raw = body.node_id;
    if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)) {
      return fail(400, "node_id 不合法", "invalid_input");
    }
    return setPreferred(db, id, raw as number | null);
  }
  return null;
}

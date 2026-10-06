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

/** preferred ingress：mock 侧的内存态（key = forward id）。 */
const preferredByForward = new Map<number, number | null>();

/** 测试用：清空 mock 的偏好态（`resetStore()` 不会碰本模块的 Map）。 */
export function resetForwardHaMock(): void {
  preferredByForward.clear();
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
  const nodes = db.nodes
    .filter((node) => node.node_group_id === tunnel.in_node_group_id)
    .map((node) => mockUserNode(db, node))
    .sort((a, b) => a.id - b.id)
    .map((node) => ({
      node_id: node.id,
      name: node.node_id,
      role: node.role ?? null,
      node_group_id: node.node_group_id,
      is_active_ingress: node.id === activeIngress,
      is_preferred: node.id === preferred,
      // 写入路径规则：同组（已按组过滤）+ role ∈ {ingress,both}
      can_be_preferred: roleAcceptsIngress(node.role ?? null),
      preference_rejection: roleAcceptsIngress(node.role ?? null)
        ? null
        : node.role == null
          ? "role_undeclared"
          : "role_mismatch",
      // 以下三项是**并列事实**（连接 / 准入 / 生命周期），不是"能不能当首选"的判据。
      connection: node.connection,
      lifecycle: node.lifecycle,
      accepts_new_business: node.accepts_new_business,
      admission_rejection: node.admission_rejection ?? null,
    }));

  // 候选：与后端 `pickFailoverDestination` 同一口径（非现任 + 准入 + 角色 + 此刻在线），
  // 取 id 最小的一台。
  const candidate = nodes.find(
    (node) =>
      node.node_id !== activeIngress &&
      roleAcceptsIngress(node.role ?? null) &&
      node.connection === "online" &&
      node.accepts_new_business === true,
  );

  return ok({
    forward_id: tunnel.id,
    preferred_ingress_node_id: preferred,
    active_ingress_node_id: activeIngress,
    policy: readPolicy(db),
    failover_candidate: {
      status: candidate ? "available" : "none",
      node_id: candidate ? candidate.node_id : null,
      reason: null,
    },
    preference_options: { status: "ok", nodes },
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

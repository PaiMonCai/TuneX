/**
 * Binding usage：绑定使用量的**响应投影 + 阻塞判定**。
 *
 * 问题：解绑的后果此前只能通过「先删，再被 409 告知还有 N 条转发在用」发现。
 * 用户在删除前看不到影响面，就会反复试错；而 409 的文案又只存在于一个
 * `c.json(...)` 字面量里，前端无法复用（无法在按钮上提前禁用）。
 *
 * 这里把三件事收敛到一处：
 *   1. 使用量的**响应字段名**（`used_by_forward_count`）——前端类型、mock、
 *      路由都只能认这个名字；
 *   2. 「是否阻塞解绑」的判定（> 0）；
 *   3. 409 的**人类可读文案**——同一个句子既用于错误响应，也用于前端确认框，
 *      这样「后端拒绝的理由」与「前端提示的理由」不会漂移。
 *
 * 注意这是**投影**，不新增数据库列：使用量由 `tunnel` 表实时统计得出，
 * 存成列反而会引入一致性维护成本。
 */

/** 一个绑定的使用量投影。 */
export interface BindingUsage {
  used_by_forward_count: number;
  /** > 0 时解绑会被 409 拒绝。 */
  unbind_blocked: boolean;
}

/**
 * 由转发条数推导使用量。
 *
 * 负数按 0 处理：调用方是 DB count，负数只可能来自坏数据，不能让它
 * 变成「unbind_blocked=false 但文案说 -3 条」这种自相矛盾的响应。
 */
export function bindingUsage(forwardCount: number): BindingUsage {
  const count = Number.isFinite(forwardCount) && forwardCount > 0
    ? Math.floor(forwardCount)
    : 0;
  return { used_by_forward_count: count, unbind_blocked: count > 0 };
}

/**
 * 解绑被阻塞时的文案（后端 409 与前端提示共用一句话）。
 *
 * 文案要求：说清**数量**与**下一步**。只写「无法解绑」会让用户去找文档。
 */
export function unbindBlockedMessage(forwardCount: number): string {
  return `该出口仍被 ${Math.max(0, Math.floor(forwardCount))} 条端口转发使用，请先删除或改为其它出口`;
}

/**
 * 解绑确认框的提示语。数量为 0 与 > 0 走两种语气：
 *   · 0：陈述「当前没有转发使用它」（用户仍需确认，因为解绑会让新建转发失去这个出口）；
 *   · > 0：明确这是**阻塞**而不是警告（按钮应当被禁用）。
 */
export function unbindHint(usage: BindingUsage): string {
  return usage.unbind_blocked
    ? unbindBlockedMessage(usage.used_by_forward_count)
    : "当前没有端口转发使用该出口，解绑后新建中继转发将需要重新绑定";
}

/**
 * 批量统计用：把 `[ingress, egress] → count` 的查询结果投影成每个绑定的使用量。
 *
 * 入参是「按 pair 计数的原始行」，出参是按 pair key 索引的使用量表；
 * 缺失的 pair 视为 0（新绑定）。键的拼法只在这里定义，避免路由与 mock
 * 各自拼出不同的分隔符导致静默 0。
 */
export function bindingUsageKey(ingressNodeId: number, egressNodeId: number): string {
  return `${ingressNodeId}:${egressNodeId}`;
}

export function bindingUsageMap(
  rows: Array<{
    ingress_node_id: number | null;
    egress_node_id: number | null;
    count: number;
  }>,
): Map<string, BindingUsage> {
  const out = new Map<string, BindingUsage>();
  for (const row of rows) {
    // `null` 入口只出现在非 relay / 历史坏数据里，不是可用的绑定，跳过即可。
    if (row.egress_node_id === null || row.ingress_node_id === null) continue;
    out.set(
      bindingUsageKey(row.ingress_node_id, row.egress_node_id),
      bindingUsage(row.count),
    );
  }
  return out;
}

/** 查表；未统计到即 0（新绑定 / 没有 relay 转发）。 */
export function lookupBindingUsage(
  map: Map<string, BindingUsage>,
  ingressNodeId: number,
  egressNodeId: number,
): BindingUsage {
  return map.get(bindingUsageKey(ingressNodeId, egressNodeId)) ?? bindingUsage(0);
}

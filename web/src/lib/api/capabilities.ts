/**
 * 「当前工作空间有效能力」的安全投影（`GET /api/me/capabilities`）。
 *
 * ── 为什么必须投影，而不是把响应直接交给界面 ──
 * 后端这个端点返回的是**完整的判定内部结构**：`policy.key` / `policy.revision` /
 * `policy.ceiling`（平台硬上限）/ `policy.entitlements.whitelist_ips`（入口准入白名单）/
 * `policy.entitlements.allowed_in_group_ids` / `active_policies[].source` 等。
 * 它们是控制面事实，不是客户端状态：一旦进入组件 state，就会顺着 SSR payload、
 * 日志、错误上报和未来的调试面板漏出去，而且会诱导前端「自己再判一遍权限」——
 * 那是第二套真相。
 *
 * 所以这里做一次**白名单投影**：只有界面真的要用、且对用户无内部歧义的字段能过关。
 * 其余字段（含上面列举的每一个）在本模块之外不存在。
 *
 * ── fail-closed ──
 * 投影只认**明确写出的**字段：`allow_custom_in_group` 不是布尔、`max_nodes` 不是
 * number|null、用量计数缺失 —— 任一情况都返回 `null`（= 不知道），由调用方显示
 * 「暂时取不到」。绝不默认成 `true` / `0` / 不限，那会把「读不到」变成「允许」或
 * 「一切正常」。
 */
import { get } from "./core";

/**
 * 界面可用的能力子集。
 *
 * 每个字段都直接来自后端有效策略（`EffectivePolicy` 的授予值），前端不推算、
 * 不缓存、不合并本地默认值。
 */
export interface WorkspaceCapabilities {
  /** 当前有效策略是否授予「自建入口节点组」。默认免费策略为 true，但真相只在响应里。 */
  allow_custom_in_group: boolean;
  /** 当前有效策略是否授予「自建出口节点组」（本切片不消费，保留给组表单的方向选择）。 */
  allow_custom_out_group: boolean;
  /** 节点额度上限；`null` = 不限（不是「取不到」）。 */
  max_nodes: number | null;
  /** 已用节点数（后端计数）。 */
  nodes_used: number;
  /** 转发（隧道）额度上限；`null` = 不限。 */
  max_tunnels: number | null;
  /** 已用转发数（后端计数）。 */
  tunnels_used: number;
  /** `true` = 工作空间当前**没有任何有效策略**：一切能力都应被拒绝。 */
  policy_missing: boolean;
  /**
   * 后端给出的拒绝原文（`describeDeny` 的唯一实现，前端不另抄一份）；`null` = 没有被拒。
   * 这是**面向用户的说明文本**，不是内部字段。
   */
  deny_message: string | null;
}

/** 投影失败：响应不是本模块认识的安全形状（fail-closed，不猜）。 */
export class CapabilityProjectionError extends Error {
  constructor(reason: string) {
    super(`capabilities 响应缺少界面所需字段：${reason}`);
    this.name = "CapabilityProjectionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function limitOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

function countOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  return null;
}

/**
 * 原始响应 → 安全子集；形状不认识时返回 `null`。
 *
 * 只读三个位置：`policy.entitlements` / `limits` / 顶层用量计数与 `expiry`，
 * 其余一律丢弃（包括整个 `policy` 对象的其它字段）。
 */
export function projectWorkspaceCapabilities(input: unknown): WorkspaceCapabilities | null {
  if (!isRecord(input)) return null;

  const policy = input.policy;
  if (!isRecord(policy)) return null;
  const entitlements = policy.entitlements;
  if (!isRecord(entitlements)) return null;

  const allowIn = entitlements.allow_custom_in_group;
  const allowOut = entitlements.allow_custom_out_group;
  if (typeof allowIn !== "boolean" || typeof allowOut !== "boolean") return null;

  const limits = input.limits;
  if (!isRecord(limits)) return null;
  const maxNodes = limitOrNull(limits.max_nodes);
  const maxTunnels = limitOrNull(limits.max_tunnels);
  if (maxNodes === undefined || maxTunnels === undefined) return null;

  const nodesUsed = countOf(input.nodes);
  const tunnelsUsed = countOf(input.tunnels);
  if (nodesUsed === null || tunnelsUsed === null) return null;

  // `deny_scope` / `deny_message` 都是后端 expiry 投影里的**用户可见**结论；
  // 缺失按「没有拒绝结论」读（不臆造一句拒绝）。
  const expiry = isRecord(input.expiry) ? input.expiry : {};
  const denyMessage = typeof expiry.deny_message === "string" && expiry.deny_message.trim() !== ""
    ? expiry.deny_message
    : null;

  return {
    allow_custom_in_group: allowIn,
    allow_custom_out_group: allowOut,
    max_nodes: maxNodes,
    nodes_used: nodesUsed,
    max_tunnels: maxTunnels,
    tunnels_used: tunnelsUsed,
    policy_missing: expiry.deny_scope === true,
    deny_message: denyMessage,
  };
}

/**
 * `GET /api/me/capabilities` → 安全子集。
 *
 * 作用域由调用方的会话/`x-workspace-id` 决定（与其它用户域端点同一口径），
 * 本模块不解析 Workspace，也不缓存结果：切 Workspace 后必须重新取。
 */
export const capabilitiesApi = {
  current: async (cookie?: string): Promise<WorkspaceCapabilities> => {
    const raw = await get<unknown>("/me/capabilities", undefined, cookie);
    const projected = projectWorkspaceCapabilities(raw);
    if (!projected) throw new CapabilityProjectionError("policy.entitlements / limits / usage");
    return projected;
  },
};

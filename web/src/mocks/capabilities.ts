/**
 * R2 First-run mock —— 有效能力策略与「组归属」的 mock 实现。
 *
 * ── 为什么单独一个文件 ──
 * `GET /api/me/capabilities` 与 `POST /api/node-groups` 是同一件事的两面：
 * 「这个工作空间**允许**自建入口组吗」+「创建的组**属于**哪个工作空间」。
 * 两者都必须按 Workspace 隔离，所以放在一起，并由契约测试直接调用。
 *
 * ── 形状必须等于真实后端 ──
 * 返回值是后端 `getWorkspaceUsageReport()` 的完整形状（含 `policy.key` /
 * `policy.ceiling` / `entitlements.whitelist_ips` / `active_policies[].source`
 * 这些**内部字段**）：前端的安全投影正是为了过滤它们而存在，mock 如果只回投影后的
 * 子集，就永远测不出「内部字段有没有漏到客户端」。缺省（没有策略）= `deny_scope`
 * + 全部 entitlement 关闭，与真实后端「无有效发放即拒绝一切」一致，绝不默认放行。
 */
import type { ID } from "@/lib/types";
import type { MockStore } from "./state";

/** 当前作用域的有效策略；`undefined` = 该空间没有任何有效策略（fail-closed）。 */
export function mockCapabilityPolicyFor(db: MockStore, workspaceId: ID | undefined) {
  if (workspaceId === undefined) return undefined;
  return db.capabilityPolicies.get(workspaceId);
}

/**
 * 该组在当前作用域是否可见。
 *
 * 种子组（不在 `nodeGroupWorkspace` 里）是跨作用域演示数据 —— mock 的既有约定，
 * 与 `GET /node-groups` 现在的行为一致；**用户新建的组只在其创建者的工作空间可见**。
 */
export function mockGroupVisibleInScope(db: MockStore, groupId: ID, workspaceId: ID | undefined): boolean {
  const owner = db.nodeGroupWorkspace.get(groupId);
  if (owner === undefined) return true;
  return owner === workspaceId;
}

/** 当前作用域可见的组 id。 */
export function mockVisibleGroupIds(db: MockStore, workspaceId: ID | undefined): ID[] {
  return db.nodeGroups.filter((g) => mockGroupVisibleInScope(db, g.id, workspaceId)).map((g) => g.id);
}

/**
 * `GET /api/me/capabilities` 的响应体（`{ data: report }` 里的 `report`）。
 *
 * 内部字段（policy key / ceiling / whitelist / source）**故意保留**：它们是前端
 * 安全投影必须剥掉的东西，去掉就无法断言剥离行为。
 */
export function mockCapabilitiesReport(db: MockStore, workspaceId: ID | undefined): Record<string, unknown> {
  const policy = mockCapabilityPolicyFor(db, workspaceId);
  const policyMissing = policy === undefined;

  const entitlements = policyMissing
    ? {
        tunnel_types: [] as string[],
        allow_custom_in_group: false,
        allow_custom_out_group: false,
        allowed_in_group_ids: [] as number[],
        allowed_out_group_ids: [] as number[],
        allow_shared_entry: false,
        whitelist_ips: null as string[] | null,
      }
    : {
        tunnel_types: ["tcp", "udp", "tls", "wss", "mtls"],
        allow_custom_in_group: policy.allow_custom_in_group,
        allow_custom_out_group: policy.allow_custom_out_group,
        // 内部字段：命中「共享入口组白名单」的判定用，界面不需要也不允许拿到。
        allowed_in_group_ids: [1, 2] as number[] | null,
        allowed_out_group_ids: [2, 3] as number[] | null,
        allow_shared_entry: true,
        whitelist_ips: ["10.0.0.0/8"] as string[] | null,
      };

  const limits = {
    max_tunnels: policy?.max_tunnels ?? null,
    max_nodes: policy?.max_nodes ?? null,
    max_members: policyMissing ? null : policy.max_nodes === 1 ? 1 : 10,
    traffic_limit: null as number | null,
    traffic_period: "month",
    bandwidth_limit: null as number | null,
    client_limit: null as number | null,
    ip_limit: null as number | null,
  };

  const visibleGroups = mockVisibleGroupIds(db, workspaceId);
  const nodes = db.nodes.filter((n) => visibleGroups.includes(n.node_group_id)).length;
  const tunnels = db.tunnels.length;
  const members = db.workspaceMembers.filter((m) => m.workspace_id === workspaceId && m.active).length;

  return {
    tunnels,
    nodes,
    members,
    traffic_used: 0,
    traffic_used_unattributed_federated: 0,
    expiry: {
      policy_expires_at: null,
      in_grace: false,
      grace_expires_at: null,
      /** `deny_scope=true` = 无任何有效策略；文案与后端 `describeDeny` 同源（mock 里照抄语义）。 */
      deny_scope: policyMissing,
      deny_reason: policyMissing ? "no_active_policy" : null,
      deny_message: policyMissing ? "工作空间没有任何生效的能力策略" : null,
    },
    limits,
    policy: {
      workspace_id: workspaceId ?? -1,
      revision: policyMissing ? 0 : 1,
      entitlements,
      limits,
      /** 平台硬上限（内部字段，前端安全投影必须丢掉）。 */
      ceiling: { ...limits, max_tunnels: null, max_nodes: null },
      active_policies: policyMissing
        ? []
        : [
            {
              id: workspaceId ?? -1,
              key: "mock_free_default",
              name: "Mock 默认免费策略",
              source: "system_default",
              expires_at: null,
            },
          ],
      grace_policies: [] as string[],
      grace_expires_at: null,
      deny_scope: policyMissing,
      deny_reason: policyMissing ? "no_active_policy" : null,
    },
  };
}

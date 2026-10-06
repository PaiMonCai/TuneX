/**
 * R2 First-run —— API 层的两个安全边界（行为测试，stub 掉 fetch）。
 *
 * 1. **`GET /api/me/capabilities` 必须投影**：后端返回的是含判定内部结构
 *    （`policy.key` / `policy.ceiling` / `entitlements.whitelist_ips` /
 *    `allowed_in_group_ids` / `active_policies[].source`）的完整报告；界面只允许拿到
 *    白名单子集。这里断言「内部字段一个都没进返回值」，并且**形状不认识就抛**
 *    （fail-closed：绝不把残缺对象当成允许）。
 * 2. **`POST /api/node-groups` 必须丢掉组凭据 `token`**：它只回显一次，绝不能进入
 *    客户端状态 / SSR payload / 日志。
 *
 * 跑法（web 目录）：bun test src/lib/api/__tests__/first-run-api.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/core";
import {
  capabilitiesApi,
  CapabilityProjectionError,
  projectWorkspaceCapabilities,
} from "@/lib/api/capabilities";
import {
  nodeGroupApiErrorInfo,
  nodeGroupsApi,
  NodeGroupProjectionError,
  projectCreatedNodeGroup,
} from "@/lib/api/nodeGroups";

/* ================================================================== */
/* fetch stub                                                          */
/* ================================================================== */

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

const originalFetch = globalThis.fetch;

function stubFetch(payload: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ================================================================== */
/* 真实后端形状的 capabilities 报告（含内部字段）                        */
/* ================================================================== */

const realReport = {
  tunnels: 0,
  nodes: 0,
  members: 1,
  traffic_used: 0,
  traffic_used_unattributed_federated: 0,
  expiry: {
    policy_expires_at: "2026-11-06T00:00:00.000Z",
    in_grace: false,
    grace_expires_at: null,
    deny_scope: false,
    deny_reason: null,
    deny_message: null,
  },
  limits: {
    max_tunnels: 2,
    max_nodes: 1,
    max_members: 1,
    traffic_limit: 107374182400,
    traffic_period: "month",
    bandwidth_limit: null,
    client_limit: null,
    ip_limit: null,
  },
  policy: {
    workspace_id: 1,
    revision: 7,
    entitlements: {
      tunnel_types: ["tcp", "udp", "tls", "wss", "mtls"],
      allow_custom_in_group: true,
      allow_custom_out_group: false,
      allowed_in_group_ids: [1, 2],
      allowed_out_group_ids: null,
      allow_shared_entry: true,
      whitelist_ips: ["10.0.0.0/8", "192.168.0.0/16"],
    },
    limits: { max_tunnels: 2, max_nodes: 1 },
    ceiling: { max_tunnels: null, max_nodes: null, max_members: null, traffic_limit: null },
    active_policies: [
      { id: 3, key: "free_personal", name: "免费个人版", source: "system_default", expires_at: null },
    ],
    grace_policies: [],
    grace_expires_at: null,
    deny_scope: false,
    deny_reason: null,
  },
};

describe("capabilities 安全投影：界面只拿得到白名单子集", () => {
  test("内部结构（policy / ceiling / whitelist / source / 组白名单）一个都不进返回值", () => {
    const projected = projectWorkspaceCapabilities(realReport);
    expect(projected).toEqual({
      allow_custom_in_group: true,
      allow_custom_out_group: false,
      max_nodes: 1,
      nodes_used: 0,
      max_tunnels: 2,
      tunnels_used: 0,
      policy_missing: false,
      deny_message: null,
    });
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      '"policy":',
      '"limits":',
      "ceiling",
      "whitelist",
      "allowed_in_group_ids",
      "allowed_out_group_ids",
      "traffic_limit",
      "revision",
      '"source"',
      "active_policies",
      "free_personal",
      "10.0.0.0",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // 键集就是这八个：新增字段会立刻红（防止有人顺手透传）。
    expect(Object.keys(projected!).sort()).toEqual(
      [
        "allow_custom_in_group",
        "allow_custom_out_group",
        "deny_message",
        "max_nodes",
        "max_tunnels",
        "nodes_used",
        "policy_missing",
        "tunnels_used",
      ].sort(),
    );
  });

  test("无有效策略：policy_missing + deny_message 照原文带出（用户可见的拒绝理由）", () => {
    const projected = projectWorkspaceCapabilities({
      ...realReport,
      expiry: { ...realReport.expiry, deny_scope: true, deny_reason: "no_active_policy", deny_message: "工作空间没有任何生效的能力策略" },
      policy: {
        ...realReport.policy,
        entitlements: { ...realReport.policy.entitlements, allow_custom_in_group: false, allow_custom_out_group: false },
      },
    });
    expect(projected?.policy_missing).toBe(true);
    expect(projected?.allow_custom_in_group).toBe(false);
    expect(projected?.deny_message).toBe("工作空间没有任何生效的能力策略");
  });

  test("形状不认识就返回 null（fail-closed：不默认成允许 / 不限）", () => {
    expect(projectWorkspaceCapabilities(null)).toBeNull();
    expect(projectWorkspaceCapabilities([])).toBeNull();
    expect(projectWorkspaceCapabilities({})).toBeNull();
    // 缺少 policy.entitlements
    expect(projectWorkspaceCapabilities({ ...realReport, policy: { limits: {} } })).toBeNull();
    // allow_custom_in_group 不是布尔（例如后端改名 / 前端读错字段）
    expect(
      projectWorkspaceCapabilities({
        ...realReport,
        policy: { ...realReport.policy, entitlements: { ...realReport.policy.entitlements, allow_custom_in_group: "true" } },
      }),
    ).toBeNull();
    // 缺 limits.max_nodes
    expect(projectWorkspaceCapabilities({ ...realReport, limits: { max_tunnels: 2 } })).toBeNull();
    // 缺用量计数
    expect(projectWorkspaceCapabilities({ ...realReport, nodes: undefined })).toBeNull();
    // 计数是脏值
    expect(projectWorkspaceCapabilities({ ...realReport, tunnels: "3" })).toBeNull();
  });

  test("max_* = null 是「不限」，不是「取不到」（必须原样保留 null）", () => {
    const projected = projectWorkspaceCapabilities({
      ...realReport,
      limits: { ...realReport.limits, max_nodes: null, max_tunnels: null },
    });
    expect(projected?.max_nodes).toBeNull();
    expect(projected?.max_tunnels).toBeNull();
  });
});

describe("capabilitiesApi.current：请求路径与失败行为", () => {
  test("GET /api/me/capabilities，返回投影后的对象（不含内部字段）", async () => {
    const calls = stubFetch({ data: realReport });
    const projected = await capabilitiesApi.current();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/api/me/capabilities");
    expect(projected.allow_custom_in_group).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("whitelist");
  });

  test("响应形状不认识 → 抛 CapabilityProjectionError（不是静默返回一个空对象）", async () => {
    stubFetch({ data: { policy: { entitlements: {} }, limits: {} } });
    await expect(capabilitiesApi.current()).rejects.toBeInstanceOf(CapabilityProjectionError);
  });

  test("后端 403 → ApiError 保留状态码与原文（界面据此区分「没权限」与「暂时取不到」）", async () => {
    stubFetch({ error: "工作空间角色无权操作", code: "permission_denied" }, 403);
    const error = await capabilitiesApi.current().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe("工作空间角色无权操作");
  });
});

/* ================================================================== */
/* 建组：token 绝不进入客户端状态                                        */
/* ================================================================== */

describe("nodeGroups.create：组凭据 token 在投影处被丢掉", () => {
  test("返回对象只有 id/name/node_type，JSON 里没有 token", async () => {
    const secret = "ng_7_supersecret";
    const calls = stubFetch({
      data: { id: 7, name: "香港-入口", node_type: "in", token: secret, workspace_id: 1 },
    });
    const created = await nodeGroupsApi.create({ name: "  香港-入口  ", node_type: "in", port_range: "20000-20100" });

    expect(created).toEqual({ id: 7, name: "香港-入口", node_type: "in" });
    expect(Object.keys(created).sort()).toEqual(["id", "name", "node_type"]);
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(JSON.stringify(created)).not.toContain("token");
    // 提交的请求体带上了必填端口范围与方向（本切片固定入口）。
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/api/node-groups");
    expect(calls[0]!.body).toEqual({ name: "香港-入口", node_type: "in", port_range: "20000-20100" });
  });

  test("响应缺字段 → NodeGroupProjectionError（不把残缺对象塞进界面）", async () => {
    stubFetch({ data: { id: 7, token: "ng_7_x" } });
    await expect(nodeGroupsApi.create({ name: "g", node_type: "in", port_range: "1-2" })).rejects.toBeInstanceOf(
      NodeGroupProjectionError,
    );
    expect(() => projectCreatedNodeGroup(null)).toThrow(NodeGroupProjectionError);
    expect(() => projectCreatedNodeGroup({ id: 0, name: "x", node_type: "in" })).toThrow(NodeGroupProjectionError);
    expect(() => projectCreatedNodeGroup({ id: 1, name: "  ", node_type: "in" })).toThrow(
      NodeGroupProjectionError,
    );
  });

  test("后端错误原样抛出：403 custom_group_not_allowed 保留 code 与原文", async () => {
    stubFetch({ error: "当前策略不允许自建入口节点组", code: "custom_group_not_allowed" }, 403);
    const error = await nodeGroupsApi
      .create({ name: "g", node_type: "in", port_range: "1-2" })
      .catch((e: unknown) => e);
    const info = nodeGroupApiErrorInfo(error);
    expect(info.status).toBe(403);
    expect(info.code).toBe("custom_group_not_allowed");
    expect(info.message).toBe("当前策略不允许自建入口节点组");
    expect(info.nextStepKey).toBe("node.groupErrorNextPolicy");
  });
});

describe("nodeGroupApiErrorInfo：错误码 → 真实原因 + 下一步", () => {
  const apiError = (status: number, message: string, code?: string) =>
    new ApiError(status, message, { message, ...(code ? { code } : {}) });

  test("三个关键码各有自己的下一步（不把能力未开通说成额度问题）", () => {
    const notAllowed = nodeGroupApiErrorInfo(apiError(403, "当前策略不允许自建入口节点组", "custom_group_not_allowed"));
    const limit = nodeGroupApiErrorInfo(apiError(403, "已达节点数量上限（1 个）", "node_limit"));
    const range = nodeGroupApiErrorInfo(
      apiError(409, "节点组未配置端口范围，无法添加节点", "PORT_RANGE_REQUIRED"),
    );
    expect(notAllowed.nextStepKey).toBe("node.groupErrorNextPolicy");
    expect(limit.nextStepKey).toBe("node.groupErrorNextNodeLimit");
    expect(range.nextStepKey).toBe("node.groupErrorNextPortRange");
    expect(range.status).toBe(409);
    // 三种原因的下一步文案必须互不相同。
    expect(new Set([notAllowed.nextStepKey, limit.nextStepKey, range.nextStepKey]).size).toBe(3);
  });

  test("冲突码与未知错误：有专门下一步就给，没有就不编", () => {
    expect(nodeGroupApiErrorInfo(apiError(409, "node_id 已被其它节点组占用", "node_id_conflict")).nextStepKey).toBe(
      "node.groupErrorNextNodeIdConflict",
    );
    expect(nodeGroupApiErrorInfo(apiError(409, "已存在节点角色为 egress", "role_conflict")).nextStepKey).toBe(
      "node.groupErrorNextRoleConflict",
    );
    const validation = nodeGroupApiErrorInfo(apiError(400, "节点组名称、方向或端口范围不合法"));
    expect(validation.code).toBeNull();
    expect(validation.nextStepKey).toBeNull();
    expect(validation.message).toBe("节点组名称、方向或端口范围不合法");
  });

  test("非 ApiError（网络层 / 编程错误）不伪造状态码与 code", () => {
    const info = nodeGroupApiErrorInfo(new TypeError("Failed to fetch"));
    expect(info.status).toBeNull();
    expect(info.code).toBeNull();
    expect(info.nextStepKey).toBeNull();
    expect(info.message).toBe("Failed to fetch");
    expect(nodeGroupApiErrorInfo(undefined).message).toBeNull();
  });
});

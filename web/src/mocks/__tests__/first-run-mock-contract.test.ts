/**
 * R2 First-run —— mock 与真实后端**契约一致**的守卫。
 *
 * 这个文件存在的理由：`POST /node-groups` 与 `GET /me/capabilities` 是首启链路的
 * 两个真实端点。如果 mock 把它们做成「谁都能建组、能力永远是允许」，前端在开发期
 * 看到的是一条永远走通的路径，而真实环境的 403 / 409 分支从未被走过 —— 那正是
 * 「必失败按钮」的温床。这里逐条钉住：
 *
 *   A. 形状等于后端：`{ data: report }` 含 `policy.entitlements` / `limits` / `expiry`
 *      （**含内部字段**，以便证明前端的投影真的在剥）；
 *   B. entitlement 门控：策略不允许 → 403 `custom_group_not_allowed`；无策略 → 同样拒绝（fail-closed）；
 *   C. `node:manage` 不绕过：只有 `:read` 的角色建组得到 403；
 *   D. Workspace 隔离：A 空间建的组不会出现在 B 空间的列表里，能力读数也各按各的空间；
 *   E. 组凭据只回显一次，且被 api 投影丢掉；
 *   F. `PORT_RANGE_REQUIRED` 用 `failFlat`（`{error, code}`）与真实后端同形。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/first-run-mock-contract.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { getStore, MOCK_TEAM_CAPABILITY_POLICY, resetStore } from "@/mocks/state";
import { mockCapabilitiesReport, mockGroupVisibleInScope } from "@/mocks/capabilities";
import { projectWorkspaceCapabilities } from "@/lib/api/capabilities";
import { nodeGroupApiErrorInfo, projectCreatedNodeGroup } from "@/lib/api/nodeGroups";
import { ApiError } from "@/lib/api/core";

const PERSONAL_WS = 1;

interface CallOptions {
  cookie?: string;
  workspaceId?: number;
}

/** 会话 cookie：`isLoggedIn` 只检查存在性，`u<id>` 选择用户（与既有 mock 测试同口径）。 */
const session = (userId: number) => `tunex_session=u${userId}`;

async function call(method: string, path: string, body?: unknown, opts: CallOptions = {}) {
  return handleMock(method, path, {
    body,
    query: {},
    cookie: opts.cookie ?? session(1),
    workspaceId: opts.workspaceId ?? PERSONAL_WS,
  } as never);
}

beforeEach(() => {
  resetStore();
});

/* ================================================================== */
/* A. /me/capabilities 的形状与投影                                      */
/* ================================================================== */

describe("A. GET /me/capabilities：形状与真实后端一致，且投影才进界面", () => {
  test("未登录 → 401（能力读数不是公开信息）", async () => {
    const res = await handleMock("GET", "me/capabilities", { query: {}, cookie: "" } as never);
    expect(res.status).toBe(401);
  });

  test("返回 { data: report }：含 policy.entitlements / limits / expiry 与用量计数", async () => {
    const res = await call("GET", "me/capabilities");
    expect(res.status).toBe(200);
    const report = (res.body as { data?: Record<string, unknown> }).data!;
    expect(typeof report.nodes).toBe("number");
    expect(typeof report.tunnels).toBe("number");
    expect(typeof report.members).toBe("number");
    expect(report.expiry).toBeDefined();
    const policy = report.policy as Record<string, unknown>;
    // 内部字段必须在（前端投影的意义就是把这几个剥掉）。
    expect((policy.entitlements as Record<string, unknown>).whitelist_ips).toBeDefined();
    expect((policy.entitlements as Record<string, unknown>).allowed_in_group_ids).toBeDefined();
    expect((policy.active_policies as { source: string }[])[0]!.source).toBe("system_default");
    expect(policy.ceiling).toBeDefined();
    expect(policy.key ?? (policy.active_policies as { key: string }[])[0]!.key).toBeDefined();
  });

  test("个人空间：默认策略允许自建入口组（投影后 allow_custom_in_group = true）", async () => {
    const res = await call("GET", "me/capabilities");
    const projected = projectWorkspaceCapabilities((res.body as { data: unknown }).data);
    expect(projected).not.toBeNull();
    expect(projected!.allow_custom_in_group).toBe(true);
    expect(projected!.allow_custom_out_group).toBe(false);
    expect(projected!.max_nodes).toBe(1);
    expect(JSON.stringify(projected)).not.toContain("whitelist");
  });

  test("Workspace 隔离：团队空间的能力读数与个人空间不同（各按各的策略）", async () => {
    const store = getStore();
    const team = store.workspaces.find((w) => w.kind === "team")!;
    const personal = await call("GET", "me/capabilities", undefined, { workspaceId: PERSONAL_WS });
    const teamRes = await call("GET", "me/capabilities", undefined, { workspaceId: team.id });
    const personalCaps = projectWorkspaceCapabilities((personal.body as { data: unknown }).data)!;
    const teamCaps = projectWorkspaceCapabilities((teamRes.body as { data: unknown }).data)!;
    expect(personalCaps.allow_custom_out_group).toBe(false);
    expect(teamCaps.allow_custom_out_group).toBe(MOCK_TEAM_CAPABILITY_POLICY.allow_custom_out_group);
    expect(personalCaps.max_nodes).not.toBe(teamCaps.max_nodes);
  });

  test("没有有效策略的空间：deny_scope + 全部 entitlement 关闭（fail-closed，不默认放行）", async () => {
    const store = getStore();
    const orphan = store.workspaces.find((w) => w.kind === "personal")!.id + 1000;
    const report = mockCapabilitiesReport(store, orphan) as {
      expiry: { deny_scope: boolean; deny_message: string | null };
      policy: { entitlements: { allow_custom_in_group: boolean } };
    };
    expect(report.expiry.deny_scope).toBe(true);
    expect(report.expiry.deny_message).toBeTruthy();
    expect(report.policy.entitlements.allow_custom_in_group).toBe(false);
    const projected = projectWorkspaceCapabilities(report)!;
    expect(projected.allow_custom_in_group).toBe(false);
    expect(projected.policy_missing).toBe(true);
  });
});

/* ================================================================== */
/* B. POST /node-groups：门控、创建与凭据                                */
/* ================================================================== */

describe("B. POST /node-groups：entitlement + node:manage + 隔离", () => {
  test("策略允许 → 201，回显 workspace_id 与一次性 token；组只出现在该空间的列表里", async () => {
    const store = getStore();
    const team = store.workspaces.find((w) => w.kind === "team")!;

    const res = await call(
      "POST",
      "node-groups",
      { name: "首启-入口组", node_type: "in", port_range: "20000-20100" },
      { workspaceId: PERSONAL_WS },
    );
    expect(res.status).toBe(201);
    const created = (res.body as { data: { id: number; name: string; node_type: string; token: string; workspace_id: number } }).data;
    expect(created.name).toBe("首启-入口组");
    expect(created.node_type).toBe("in");
    expect(created.workspace_id).toBe(PERSONAL_WS);
    // 凭据在响应里（真实后端同形），但 api 投影必须把它丢掉。
    expect(typeof created.token).toBe("string");
    expect(JSON.stringify(projectCreatedNodeGroup(created))).not.toContain(created.token);

    // 同一个空间能看到它。
    const sameList = await call("GET", "node-groups", undefined, { workspaceId: PERSONAL_WS });
    const ids = ((sameList.body as { data: { id: number }[] }).data).map((g) => g.id);
    expect(ids).toContain(created.id);
    expect(mockGroupVisibleInScope(store, created.id, PERSONAL_WS)).toBe(true);

    // 另一个空间看不到它（Workspace 隔离）。
    expect(mockGroupVisibleInScope(store, created.id, team.id)).toBe(false);
    const otherList = await call("GET", "node-groups", undefined, { workspaceId: team.id });
    const otherIds = ((otherList.body as { data: { id: number }[] }).data).map((g) => g.id);
    expect(otherIds).not.toContain(created.id);
    // 种子组仍是跨作用域演示数据（mock 既有约定，不因隔离改动而消失）。
    expect(otherIds.length).toBeGreaterThan(0);
  });

  test("策略未授予自建入口组 → 403 custom_group_not_allowed（不是额度、不是 400）", async () => {
    const store = getStore();
    store.capabilityPolicies.set(PERSONAL_WS, {
      allow_custom_in_group: false,
      allow_custom_out_group: false,
      max_nodes: 1,
      max_tunnels: 2,
    });
    const res = await call("POST", "node-groups", { name: "g", node_type: "in", port_range: "1-2" });
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe("custom_group_not_allowed");
    const info = nodeGroupApiErrorInfo(new ApiError(res.status, "x", res.body));
    expect(info.nextStepKey).toBe("node.groupErrorNextPolicy");
  });

  test("没有有效策略的空间（未登记）→ 同样拒绝，绝不默认放行", async () => {
    const store = getStore();
    store.capabilityPolicies.delete(PERSONAL_WS);
    const res = await call("POST", "node-groups", { name: "g", node_type: "in", port_range: "1-2" });
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe("custom_group_not_allowed");
  });

  test("只有 :read 的成员（无 node:manage）→ 403，权限不被绕过", async () => {
    const store = getStore();
    const team = store.workspaces.find((w) => w.kind === "team")!;
    const member = store.workspaceMembers.find((m) => m.workspace_id === team.id && m.role === "member")!;
    const res = await call(
      "POST",
      "node-groups",
      { name: "g", node_type: "in", port_range: "1-2" },
      { cookie: session(member.user_id), workspaceId: team.id },
    );
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe("permission_denied");
  });

  test("形状校验：名称/方向/端口范围不合法 → 400（与后端同一批分支）", async () => {
    const cases: Record<string, unknown>[] = [
      { name: "", node_type: "in", port_range: "1-2" },
      { name: "a".repeat(61), node_type: "in", port_range: "1-2" },
      { name: "g", node_type: "sideways", port_range: "1-2" },
      { name: "g", node_type: "in", port_range: "20000" },
      { name: "g", node_type: "in", port_range: "20100-20000" },
      { name: "g", node_type: "in", port_range: "0-100" },
      { name: "g", node_type: "in", port_range: "1-65536" },
    ];
    for (const body of cases) {
      const res = await call("POST", "node-groups", body);
      expect(res.status).toBe(400);
    }
  });

  test("未登录 → 401", async () => {
    const res = await handleMock("POST", "node-groups", { body: { name: "g", node_type: "in" }, query: {}, cookie: "" } as never);
    expect(res.status).toBe(401);
  });
});

/* ================================================================== */
/* D. 首启链路真能走下去：建组 → 用这个组加节点                            */
/* ================================================================== */

describe("D. 建好的组真的能接着用于下一步（不是只能建出来摆着看）", () => {
  test("新建的入口组带着端口范围，可以直接 provision 出节点（真实后端恒返回 201）", async () => {
    const created = await call("POST", "node-groups", {
      name: "首启-链路",
      node_type: "in",
      port_range: "30000-30010",
    });
    const groupId = (created.body as { data: { id: number } }).data.id;

    const provisioned = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "first-run-edge" });
    // 真实后端 `POST /api/node-groups/:id/nodes` **恒返回 201**（新建与同名重签都是；
    // 已用真实 MySQL + 真实 TCP 实测）。这里曾经写 200 —— 那是 mock 的旧行为，
    // 不是契约，别再改回去。mock 的 body 是「剥掉一层 data 之后」的视图，见
    // `mocks/handlers/catalog.ts` provision 分支的注释。
    expect(provisioned.status).toBe(201);
    const payload = provisioned.body as { node?: { node_id: string; node_group_id: number }; enrollment?: { install_command: string } };
    expect(payload.node?.node_id).toBe("first-run-edge");
    expect(payload.node?.node_group_id).toBe(groupId);
    // 安装命令是「加节点 → 等待上线」那一步的真实产物（I1 链路复用，不另造）。
    expect(typeof payload.enrollment?.install_command).toBe("string");

    // 新节点出现在当前工作空间的用户节点列表里。
    const nodes = await call("GET", "nodes");
    const rows = nodes.body as { node_id: string }[];
    expect(rows.some((n) => n.node_id === "first-run-edge")).toBe(true);
  });

  test("没有端口范围的新组：provision 一定失败（界面在第一步就要求填范围的理由）", async () => {
    const created = await call("POST", "node-groups", { name: "首启-无范围", node_type: "in" });
    const groupId = (created.body as { data: { id: number } }).data.id;
    const provisioned = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "no-range-edge" });
    expect(provisioned.status).toBe(409);
    expect((provisioned.body as { code?: string }).code).toBe("PORT_RANGE_REQUIRED");
  });
});


/* ================================================================== */
/* C. PORT_RANGE_REQUIRED：failFlat 形状与真实后端一致                    */
/* ================================================================== */

describe("C. provision 的 PORT_RANGE_REQUIRED 与真实后端同形（failFlat：{error, code}）", () => {
  test("没有端口范围的组 → 409 + code=PORT_RANGE_REQUIRED，且错误体是扁平 {error, code}", async () => {
    // 建一个后端允许但端口范围缺失的组（schema 里 port_range 可选）。
    const created = await call("POST", "node-groups", { name: "无范围组", node_type: "in" });
    expect(created.status).toBe(201);
    const groupId = (created.body as { data: { id: number } }).data.id;

    const res = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "edge-no-range" });
    expect(res.status).toBe(409);
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("PORT_RANGE_REQUIRED");
    // failFlat：`error` 与 `message` 同文；不再是 `{ message }`-only 的形状。
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe(body.message);
    expect(String(body.error)).toContain("端口范围");

    // 界面侧的映射：短文案 + 正确的下一步。
    const info = nodeGroupApiErrorInfo(new ApiError(res.status, String(body.error), body));
    expect(info.code).toBe("PORT_RANGE_REQUIRED");
    expect(info.nextStepKey).toBe("node.groupErrorNextPortRange");
  });
});

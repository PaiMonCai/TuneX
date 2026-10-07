/**
 * DDNS mock 的**契约测试**：与真实后端同路径、同形状、同错误码、同语义。
 *
 * mock 骗人比缺实现更坏，所以这里每条断言都对着契约本身：
 *   · `/ddns/providers` 增删查的路径与 201/404/400/403 分流；
 *   · **provider 列表永不含凭据**（连封存串都不给，只有 `has_credential`）；
 *   · `/forwards/:id/dns` 的读投影含 D4 的三个字段；绑定后只可能是 `pending`；
 *   · 错误码逐条对齐（`dns_address_unavailable` / `dns_record_type_mismatch` /
 *     `dns_mode_record_type_conflict` / `dns_provider_not_found` …）；
 *   · 权限三态：`settings:read` 能读不能写，非成员 404。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/ddns-mock-contract.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import { mockIngressNode } from "@/mocks/runtime";

const OWNER = "tunex_session=u1"; // 演示用户（super_admin）
const MEMBER = "tunex_session=u3"; // 演示团队里的 member（有 settings:read，无 settings:manage）

/** 个人空间 id：演示数据按用户顺序建空间（`mocks/state.ts` 的 build()）。 */
function personalWorkspaceId(userId: number): number {
  const row = getStore().workspaces.find((w) => w.personal_user_id === userId);
  if (!row) throw new Error(`找不到用户 ${userId} 的个人空间`);
  return row.id;
}
function teamWorkspaceId(): number {
  const row = getStore().workspaces.find((w) => w.slug === "team-demo-ops");
  if (!row) throw new Error("找不到演示团队空间");
  return row.id;
}

const call = <T>(method: string, path: string, options: { body?: unknown; cookie?: string; workspaceId?: number } = {}) =>
  handleMock(method, path, {
    cookie: options.cookie ?? OWNER,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  }) as Promise<{ status: number; body: T }>;

interface DdnsErrorBody {
  error: string;
  code: string;
  error_layer?: string;
}
interface ProviderBody {
  id: number;
  name: string;
  type: string;
  workspace_id: number | null;
  platform_level: boolean;
  has_credential: boolean;
  created_at: string | null;
}
interface BindingBody {
  state: string;
  domain: string | null;
  record_type: string | null;
  mode: string | null;
  provider_id: number | null;
  expected_values: string[];
  confirmed_values: string[];
  synced_at: string | null;
  verified: boolean;
  last_error: string | null;
  auto_resolve: boolean;
  attempt_count: number | null;
  next_attempt_at: string | null;
}

const SECRET = "cf-token-DO-NOT-LEAK-9f3a";

beforeEach(() => {
  resetStore();
});

describe("mock：/ddns/providers（路径 + 形状 + 凭据不外泄）", () => {
  test("GET 空列表 = 200 { data: [] }", async () => {
    const res = await call<{ data: ProviderBody[] }>("GET", "ddns/providers", { workspaceId: personalWorkspaceId(1) });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test("POST = 201，形状与后端逐字一致，且**响应里找不到凭据/封存串**", async () => {
    const res = await call<{ data: ProviderBody }>("POST", "ddns/providers", {
      workspaceId: personalWorkspaceId(1),
      body: { name: "生产 CF", type: "cloudflare", credential: { token: SECRET } },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "生产 CF",
      type: "cloudflare",
      workspace_id: personalWorkspaceId(1),
      platform_level: false,
      has_credential: true,
    });
    expect(Object.keys(res.body.data).sort()).toEqual(
      ["created_at", "has_credential", "id", "name", "platform_level", "type", "workspace_id"].sort(),
    );
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("sealed_config");
  });

  test("POST 的凭据**不被保存**：列表里既无明文也无封存串", async () => {
    await call("POST", "ddns/providers", {
      workspaceId: personalWorkspaceId(1),
      body: { name: "生产 CF", type: "cloudflare", credential: { token: SECRET } },
    });
    const list = await call<{ data: ProviderBody[] }>("GET", "ddns/providers", { workspaceId: personalWorkspaceId(1) });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("sealed_config");
    expect(raw).not.toContain("v1.");
    expect(list.body.data[0]!.has_credential).toBe(true);
  });

  test("平台级 provider：只有平台管理员能建、只有平台管理员看得见", async () => {
    const created = await call<{ data: ProviderBody }>("POST", "ddns/providers", {
      workspaceId: personalWorkspaceId(1),
      body: { name: "平台 CF", type: "huawei", credential: { token: SECRET }, platform_level: true },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.workspace_id).toBeNull();
    expect(created.body.data.platform_level).toBe(true);

    // 非管理员建平台级 ⇒ 403 dns_provider_forbidden（不是 200、也不是 500）
    const denied = await call<DdnsErrorBody>("POST", "ddns/providers", {
      cookie: "tunex_session=u2",
      workspaceId: personalWorkspaceId(2),
      body: { name: "偷建", type: "huawei", credential: { token: SECRET }, platform_level: true },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("dns_provider_forbidden");

    // 非管理员的列表里看不到平台级凭据（否则能从列表推断平台配置）
    const memberList = await call<{ data: ProviderBody[] }>("GET", "ddns/providers", {
      cookie: MEMBER,
      workspaceId: teamWorkspaceId(),
    });
    expect(memberList.status).toBe(200);
    expect(memberList.body.data).toEqual([]);
  });

  test("权限三态：member 能读（settings:read）但不能写（settings:manage）", async () => {
    const ws = teamWorkspaceId();
    const read = await call<{ data: ProviderBody[] }>("GET", "ddns/providers", { cookie: MEMBER, workspaceId: ws });
    expect(read.status).toBe(200);

    const write = await call<DdnsErrorBody>("POST", "ddns/providers", {
      cookie: MEMBER,
      workspaceId: ws,
      body: { name: "x", type: "cloudflare", credential: { token: SECRET } },
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("permission_denied");
  });

  test("非成员 ⇒ 404（不区分「不存在」与「不是你的」）", async () => {
    const res = await call<{ message: string }>("GET", "ddns/providers", { workspaceId: personalWorkspaceId(3) });
    expect(res.status).toBe(404);
  });

  test("非法输入 ⇒ 400 invalid_input（类型 / 缺 token / 空名 / 多余字段）", async () => {
    const ws = personalWorkspaceId(1);
    const cases: unknown[] = [
      { name: "x", type: "route53", credential: { token: SECRET } },
      { name: "x", type: "cloudflare", credential: {} },
      { name: "", type: "cloudflare", credential: { token: SECRET } },
      { name: "x", type: "cloudflare", credential: { token: SECRET }, ttl: 60 },
    ];
    for (const body of cases) {
      const res = await call<DdnsErrorBody>("POST", "ddns/providers", { workspaceId: ws, body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_input");
    }
  });

  test("DELETE：200 { deleted } / 404 dns_provider_not_found / 400 invalid_input", async () => {
    const ws = personalWorkspaceId(1);
    const created = await call<{ data: ProviderBody }>("POST", "ddns/providers", {
      workspaceId: ws,
      body: { name: "to-delete", type: "cloudflare", credential: { token: SECRET } },
    });
    const id = created.body.data.id;
    const deleted = await call<{ data: { deleted: boolean } }>("DELETE", `ddns/providers/${id}`, { workspaceId: ws });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);

    const missing = await call<DdnsErrorBody>("DELETE", "ddns/providers/999999", { workspaceId: ws });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("dns_provider_not_found");
    expect(missing.body.error_layer).toBe("ddns");

    const bad = await call<DdnsErrorBody>("DELETE", "ddns/providers/abc", { workspaceId: ws });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_input");
  });
});

describe("mock：/forwards/:id/dns（读投影 + 五态 + 错误码）", () => {
  function connectIpOf(forwardId: number): string {
    const store = getStore();
    const tunnel = store.tunnels.find((row) => row.id === forwardId);
    if (!tunnel) throw new Error(`种子隧道 ${forwardId} 不存在`);
    const node = mockIngressNode(store, tunnel);
    if (!node) throw new Error(`种子隧道 ${forwardId} 没有入口节点`);
    return store.nodes.find((row) => row.id === node.id)?.connect_ip ?? "";
  }

  test("GET 未绑定：expected_values 只来自入口 connect_ip；D4 三字段存在且 fail-closed", async () => {
    const res = await call<{ data: BindingBody }>("GET", "forwards/1/dns", { workspaceId: personalWorkspaceId(1) });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("unbound");
    expect(res.body.data.domain).toBeNull();
    expect(res.body.data.expected_values).toEqual([connectIpOf(1)]);
    expect(res.body.data.auto_resolve).toBe(false);
    expect(res.body.data.attempt_count).toBeNull();
    expect(res.body.data.next_attempt_at).toBeNull();
  });

  test("POST 200 只能是 pending（synced_at/verified/confirmed 全空）", async () => {
    const res = await call<{ data: BindingBody }>("POST", "forwards/1/dns", {
      workspaceId: personalWorkspaceId(1),
      body: { domain: "Node1.Example.COM.", record_type: "A", mode: "single_active" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("pending");
    expect(res.body.data.domain).toBe("node1.example.com"); // 归一化（大小写 + 尾点）
    expect(res.body.data.synced_at).toBeNull();
    expect(res.body.data.verified).toBe(false);
    expect(res.body.data.confirmed_values).toEqual([]);
    expect(res.body.data.attempt_count).toBe(0); // 已绑定 ⇒ 计数存在（不是 null）
    expect(res.body.data.next_attempt_at).toBeNull();
  });

  test("auto_resolve 是服务端读投影：POST 带 true ⇒ 响应 true；不带 ⇒ false", async () => {
    const on = await call<{ data: BindingBody }>("POST", "forwards/1/dns", {
      workspaceId: personalWorkspaceId(1),
      body: { domain: "a.example.com", record_type: "A", mode: "single_active", auto_resolve: true },
    });
    expect(on.body.data.auto_resolve).toBe(true);
    const off = await call<{ data: BindingBody }>("POST", "forwards/1/dns", {
      workspaceId: personalWorkspaceId(1),
      body: { domain: "b.example.com", record_type: "A", mode: "single_active" },
    });
    expect(off.body.data.auto_resolve).toBe(false);
  });

  test("错误码：域名 / 记录类型 / 形态 / 服务商 / 缺字段", async () => {
    const ws = personalWorkspaceId(1);
    const cases: { body: unknown; status: number; code: string }[] = [
      { body: { domain: "localhost", record_type: "A", mode: "single_active" }, status: 400, code: "dns_domain_invalid" },
      { body: { domain: "a.example.com", record_type: "AAAA", mode: "single_active" }, status: 400, code: "dns_record_type_mismatch" },
      { body: { domain: "a.example.com", record_type: "CNAME", mode: "multi_entry" }, status: 400, code: "dns_mode_record_type_conflict" },
      { body: { domain: "a.example.com", record_type: "A", mode: "single_active", provider_id: 999 }, status: 404, code: "dns_provider_not_found" },
      { body: { domain: "a.example.com", record_type: "A" }, status: 400, code: "invalid_input" },
      { body: { domain: "a.example.com", record_type: "A", mode: "single_active", ttl_seconds: 10 }, status: 400, code: "invalid_input" },
    ];
    for (const entry of cases) {
      const res = await call<DdnsErrorBody>("POST", "forwards/1/dns", { workspaceId: ws, body: entry.body });
      expect(`${JSON.stringify(entry.body)} -> ${res.status}/${res.body.code}`).toBe(
        `${JSON.stringify(entry.body)} -> ${entry.status}/${entry.code}`,
      );
    }
  });

  test("DELETE 幂等 ⇒ 200 unbound，且退避两列投影为 null", async () => {
    const ws = personalWorkspaceId(1);
    await call("POST", "forwards/1/dns", {
      workspaceId: ws,
      body: { domain: "a.example.com", record_type: "A", mode: "single_active", auto_resolve: true },
    });
    const first = await call<{ data: BindingBody }>("DELETE", "forwards/1/dns", { workspaceId: ws });
    expect(first.status).toBe(200);
    expect(first.body.data.state).toBe("unbound");
    expect(first.body.data.domain).toBeNull();
    expect(first.body.data.auto_resolve).toBe(false);
    expect(first.body.data.attempt_count).toBeNull();
    expect(first.body.data.next_attempt_at).toBeNull();
    expect(first.body.data.expected_values).toEqual([]);

    const second = await call<{ data: BindingBody }>("DELETE", "forwards/1/dns", { workspaceId: ws });
    expect(second.status).toBe(200);
    expect(second.body.data.state).toBe("unbound");
  });

  test("转发不存在 / ID 非法 ⇒ 404 ddns_not_found / 400 invalid_input", async () => {
    const ws = personalWorkspaceId(1);
    const missing = await call<DdnsErrorBody>("GET", "forwards/9999/dns", { workspaceId: ws });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("ddns_not_found");

    const bad = await call<DdnsErrorBody>("GET", "forwards/abc/dns", { workspaceId: ws });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_input");
  });

  test("他人的转发：member 的 own-only 语义下解绑被拒（不静默放行）", async () => {
    const ws = teamWorkspaceId();
    const res = await call<{ message: string }>("DELETE", "forwards/1/dns", { cookie: MEMBER, workspaceId: ws });
    expect(res.status).toBe(403);
  });
});

/**
 * V5-WP17.2 —— DNS 前门的**绑定落库**（零外呼）与状态投影。
 *
 * 钉住的不变量，每条都对应一种真实故障：
 *
 * ① **入口没有 `connect_ip` ⇒ 拒绝**（契约 F1）。猜地址 = 写出一条把客户端引向黑洞的记录，
 *    而"面板显示一切正常"会让它藏很久 —— 所以这条必须是**第一步**拦住的前置条件。
 * ② **写成功 ≠ 已确认**（D2/F7）：没有读回时状态只能是 `synced_unverified`。产品若把它当
 *    `synced` 呈现，就会在"面板说切了、客户端还连旧 IP"时仍然显示已切换 —— 多租户下最坏的一类。
 * ③ **凭据封存用独立的 HKDF info**：联邦那把派生密钥**打不开** DDNS 的密文（域分离不是洁癖：
 *    一把密钥被两个用途共用，一处泄漏就是两处都泄漏）。
 * ④ **跨租户一律"不存在"**（404）；平台级凭据与平台共享入口组要平台管理员（403）。
 * ⑤ **provider 视图永远不含凭据**（连封存态都不给）——列表泄漏密文等于泄漏凭据本身。
 */
import { describe, expect, test } from "bun:test";
import { deriveSealKey, unsealSecret } from "../federation/seal.ts";
import {
  DDNS_ERROR_CODES,
  DDNS_TTL_SECONDS,
  bindForwardDns,
  createDnsProvider,
  deleteDnsProvider,
  dnsBindingState,
  dnsRecordTypeForAddress,
  dnsStateFor,
  isSealedDdnsConfig,
  listDnsProviders,
  normalizeDnsDomain,
  openDdnsCredential,
  sealDdnsCredential,
  unbindForwardDns,
} from "../ddns-binding.ts";
import type { DdnsDb, DdnsDeps } from "../ddns-binding.ts";

const SECRET = "test-master-secret";
const WORKSPACE = 7;

/* ------------------------------------------------------------------ */
/* 替身                                                                */
/* ------------------------------------------------------------------ */

interface StubOptions {
  tunnel?: Record<string, unknown> | null;
  node?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
  foreignGrant?: Record<string, unknown> | null;
  updated?: Record<string, unknown>;
  providers?: Array<Record<string, unknown>>;
  platformAdmin?: boolean;
}

function stubDeps(over: StubOptions = {}): DdnsDeps & { updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  const updated = over.updated ?? {
    dns_domain: "edge.example.com",
    dns_record_type: "A",
    dns_mode: "multi_entry",
    dns_provider_id: 3,
    dns_confirmed_values: [],
    dns_synced_at: null,
    dns_verified: false,
    dns_last_error: null,
  };
  const db = {
    tunnel: {
      findFirst: async () =>
        over.tunnel === undefined
          ? { id: 11, workspace_id: WORKSPACE, category: "port_forward", ingress_node_id: 5, dns_domain: null }
          : over.tunnel,
      // 替身要**真的应用写入**：返回一份写前快照会让"解绑后状态是 unbound"这类断言
      // 变成在测替身而不是在测产品（本文件第一版就踩了这个：解绑用例拿回绑定态）。
      update: async (args: unknown) => {
        updates.push(args as Record<string, unknown>);
        const data = (args as { data?: Record<string, unknown> }).data ?? {};
        return { ...updated, ...data };
      },
    },
    dNSProvider: {
      findFirst: async () =>
        over.provider === undefined ? { id: 3, workspace_id: WORKSPACE, config: "v1.a.b.c" } : over.provider,
      findMany: async () => over.providers ?? [],
      create: async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        return { id: 9, created_at: new Date("2026-10-05T00:00:00Z"), ...data };
      },
      delete: async () => ({}),
    },
    nodeGroupGrant: { findFirst: async () => over.foreignGrant ?? null },
    node: {
      findUnique: async () =>
        over.node === undefined ? { id: 5, connect_ip: "203.0.113.9", node_group_id: 2 } : over.node,
    },
  } as unknown as DdnsDb;
  return {
    db,
    isPlatformAdmin: async () => over.platformAdmin === true,
    sealSecretKey: SECRET,
    updates,
  };
}

const bindInput = {
  workspaceId: WORKSPACE,
  userId: 1,
  tunnelId: 11,
  domain: "Edge.Example.com.",
  recordType: "A" as const,
  mode: "multi_entry" as const,
  providerId: 3,
  autoResolve: false,
};

/* ------------------------------------------------------------------ */
/* ① 归一化与语法                                                     */
/* ------------------------------------------------------------------ */

describe("V5-WP17.2: 域名归一化（大小写与尾点抹平，非法输入拒绝）", () => {
  test("归一化：大小写与尾点折叠成同一个名字", () => {
    expect(normalizeDnsDomain("Edge.Example.COM.")).toBe("edge.example.com");
    expect(normalizeDnsDomain("  a.b.c  ")).toBe("a.b.c");
  });

  test("非法输入一律拒绝：单标签、通配符、空标签、超长、非法字符", () => {
    for (const bad of ["localhost", "*.example.com", "a..b", "-a.com", "a-.com", "", "x".repeat(254), "a b.com"]) {
      expect(normalizeDnsDomain(bad), `应当拒绝 ${JSON.stringify(bad)}`).toBeNull();
    }
    expect(normalizeDnsDomain(123)).toBeNull();
    expect(normalizeDnsDomain(null)).toBeNull();
  });

  test("通配符标签被**故意**排除：它会把「可用入口集合」变成「任意地址集合」", () => {
    expect(normalizeDnsDomain("*.edge.example.com")).toBeNull();
  });
});

describe("V5-WP17.2: 地址族 → 记录类型", () => {
  test("IPv4 → A，IPv6 → AAAA，其它 → null", () => {
    expect(dnsRecordTypeForAddress("203.0.113.9")).toBe("A");
    expect(dnsRecordTypeForAddress("2001:db8::1")).toBe("AAAA");
    expect(dnsRecordTypeForAddress("edge.example.com")).toBeNull();
    expect(dnsRecordTypeForAddress("203.0.113.999")).toBeNull();
    expect(dnsRecordTypeForAddress("")).toBeNull();
    expect(dnsRecordTypeForAddress(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ② 状态投影：禁止假成功                                              */
/* ------------------------------------------------------------------ */

describe("V5-WP17.2: dns_state 投影（D2/F7 —— 只有 synced 才能说「已切换」）", () => {
  const base = { dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "multi_entry" };

  test("无域名 ⇒ unbound", () => {
    expect(dnsStateFor({ ...base, dns_domain: null })).toBe("unbound");
    expect(dnsStateFor({ ...base, dns_domain: "   " })).toBe("unbound");
  });

  test("已绑定但没同步过 ⇒ pending", () => {
    expect(dnsStateFor({ ...base, dns_synced_at: null })).toBe("pending");
  });

  test("写成功但**没有读回** ⇒ synced_unverified（不得显示「已切换」）", () => {
    expect(dnsStateFor({ ...base, dns_synced_at: new Date("2026-10-05T01:00:00Z"), dns_verified: false })).toBe(
      "synced_unverified",
    );
  });

  test("读回确认才是 synced", () => {
    expect(dnsStateFor({ ...base, dns_synced_at: new Date("2026-10-05T01:00:00Z"), dns_verified: true })).toBe("synced");
  });

  test("有最后错误 ⇒ error（压过已同步状态：错误必须可解释）", () => {
    expect(
      dnsStateFor({
        ...base,
        dns_synced_at: new Date("2026-10-05T01:00:00Z"),
        dns_verified: true,
        dns_last_error: "provider 返回 401",
      }),
    ).toBe("error");
  });

  test("期望值集是**推导**的，不是某一列：调用方给什么就透出什么", () => {
    const state = dnsBindingState({ ...base, dns_confirmed_values: ["203.0.113.9"] }, ["203.0.113.9", "203.0.113.10"]);
    expect(state.expected_values).toEqual(["203.0.113.9", "203.0.113.10"]);
    expect(state.confirmed_values).toEqual(["203.0.113.9"]);
    expect(state.state).toBe("pending");
  });
});

/* ------------------------------------------------------------------ */
/* ③ 凭据封存：域分离                                                  */
/* ------------------------------------------------------------------ */

describe("V5-WP17.2: 凭据封存（独立 HKDF info）", () => {
  test("封存-解封往返成立", () => {
    const sealed = sealDdnsCredential({ token: "tok_123", endpoint: "https://dns.test/api", zone: "example.com" }, SECRET);
    expect(isSealedDdnsConfig(sealed)).toBe(true);
    expect(openDdnsCredential(sealed, SECRET)).toEqual({
      token: "tok_123",
      endpoint: "https://dns.test/api",
      zone: "example.com",
    });
  });

  test("**联邦那把派生密钥打不开 DDNS 的密文**（域分离是可断言的属性，不是注释）", () => {
    const sealed = sealDdnsCredential({ token: "tok_123" }, SECRET);
    expect(() => unsealSecret(sealed, deriveSealKey(SECRET))).toThrow();
  });

  test("另有密钥（或换了主密钥）也打不开：解封失败必须**抛错**，不能静默当成没有凭据", () => {
    const sealed = sealDdnsCredential({ token: "tok_123" }, SECRET);
    expect(() => openDdnsCredential(sealed, "another-secret")).toThrow();
  });

  test("空 token 拒绝封存；明文 JSON 不被认作已封存", () => {
    expect(() => sealDdnsCredential({ token: "   " }, SECRET)).toThrow();
    expect(isSealedDdnsConfig(JSON.stringify({ token: "plain" }))).toBe(false);
    expect(isSealedDdnsConfig({ token: "plain" })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* ①②④ 绑定：前置条件、作用域、共享组                                */
/* ------------------------------------------------------------------ */

describe("V5-WP17.2: bindForwardDns 的前置条件与作用域", () => {
  test("入口节点 connect_ip 为空 ⇒ 拒绝（dns_address_unavailable），且**不动库**", async () => {
    const deps = stubDeps({ node: { id: 5, connect_ip: null, node_group_id: 2 } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DDNS_ERROR_CODES.dns_address_unavailable);
    expect(deps.updates).toEqual([]);
  });

  test("没有入口节点（ingress_node_id 为空）⇒ 同样是 dns_address_unavailable", async () => {
    const deps = stubDeps({ tunnel: { id: 11, workspace_id: WORKSPACE, category: "port_forward", ingress_node_id: null, dns_domain: null } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_address_unavailable);
  });

  test("记录类型与地址族不匹配 ⇒ 拒绝（A 配 IPv6 只会写出一条连不上的记录）", async () => {
    const deps = stubDeps({ node: { id: 5, connect_ip: "2001:db8::1", node_group_id: 2 } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_record_type_mismatch);
  });

  test("多入口 + CNAME ⇒ 拒绝（一个 CNAME 装不下「可用入口集合」）", async () => {
    const deps = stubDeps();
    const result = await bindForwardDns(deps, { ...bindInput, recordType: "CNAME" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_mode_record_type_conflict);
  });

  test("TTL 越界（<60 抖动、>3600 超出最坏切换窗口）⇒ 拒绝", async () => {
    const deps = stubDeps();
    for (const ttl of [DDNS_TTL_SECONDS.min - 1, DDNS_TTL_SECONDS.max + 1, 12.5]) {
      const result = await bindForwardDns(deps, { ...bindInput, ttlSeconds: ttl });
      expect(result.ok, `TTL=${ttl} 应被拒`).toBe(false);
      if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_ttl_out_of_range);
    }
  });

  test("provider 属于**别的** workspace ⇒ 404（不区分「不存在」与「不是你的」）", async () => {
    const deps = stubDeps({ provider: { id: 3, workspace_id: 999, config: "v1.a.b.c" } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_provider_not_found);
  });

  test("平台级 provider（workspace_id = NULL）：非平台管理员 ⇒ 403", async () => {
    const deps = stubDeps({ provider: { id: 3, workspace_id: null, config: "v1.a.b.c" } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_provider_forbidden);
  });

  test("平台级 provider + 平台管理员 ⇒ 放行", async () => {
    const deps = stubDeps({ provider: { id: 3, workspace_id: null, config: "v1.a.b.c" }, platformAdmin: true });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(true);
  });

  test("凭据不是封存形态（历史明文行）⇒ 拒绝用于绑定", async () => {
    const deps = stubDeps({ provider: { id: 3, workspace_id: WORKSPACE, config: { token: "plain" } } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_provider_credential_invalid);
  });

  test("平台共享入口组（对 workspace 之外的 user 有 active grant）⇒ 租户写被拒（F6 ③）", async () => {
    const deps = stubDeps({ foreignGrant: { id: 1 } });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.shared_group_dns_denied);
  });

  test("平台共享入口组 + 平台管理员 ⇒ 放行（只能由平台管理员用平台级凭据配）", async () => {
    const deps = stubDeps({ foreignGrant: { id: 1 }, platformAdmin: true });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(true);
  });

  test("成功路径：域名被归一化落库，且**确认态被作废**（期望值集变了）", async () => {
    const deps = stubDeps();
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(true);
    expect(deps.updates).toHaveLength(1);
    const data = (deps.updates[0] as { data: Record<string, unknown> }).data;
    expect(data.dns_domain).toBe("edge.example.com");
    expect(data.dns_verified).toBe(false);
    expect(data.dns_synced_at).toBeNull();
    expect(data.dns_confirmed_values).toEqual([]);
    if (result.ok) {
      expect(result.value.state).toBe("pending");
      expect(result.value.expected_values).toEqual(["203.0.113.9"]);
    }
  });

  test("转发不属于本 workspace ⇒ 404（作用域先于一切校验）", async () => {
    const deps = stubDeps({ tunnel: null });
    const result = await bindForwardDns(deps, bindInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.ddns_not_found);
  });
});

describe("V5-WP17.2: unbindForwardDns（幂等收敛）", () => {
  test("解绑清空全部 dns_* 列，且**不动 provider 行**", async () => {
    const deps = stubDeps({
      tunnel: { id: 11, dns_domain: "edge.example.com" },
      updated: {
        dns_domain: null,
        dns_record_type: null,
        dns_mode: null,
        dns_provider_id: null,
        dns_confirmed_values: [],
        dns_synced_at: null,
        dns_verified: false,
        dns_last_error: null,
      },
    });
    const result = await unbindForwardDns(deps, { workspaceId: WORKSPACE, userId: 1, tunnelId: 11 });
    expect(result.ok).toBe(true);
    const data = (deps.updates[0] as { data: Record<string, unknown> }).data;
    expect(data.dns_domain).toBeNull();
    expect(data.dns_provider_id).toBeNull();
    expect(result.ok && result.value.state).toBe("unbound");
  });

  test("本来就没绑也算成功（幂等），但状态是 unbound 而不是错误", async () => {
    const deps = stubDeps({ tunnel: { id: 11, dns_domain: null } });
    const result = await unbindForwardDns(deps, { workspaceId: WORKSPACE, userId: 1, tunnelId: 11 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("unbound");
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ provider：封存落库、视图不泄漏凭据                                 */
/* ------------------------------------------------------------------ */

describe("V5-WP17.2: provider 的增删查", () => {
  test("创建时 `config` 落库的是封存串，明文 token 不出现在写入参数里", async () => {
    const deps = stubDeps();
    const result = await createDnsProvider(deps, {
      workspaceId: WORKSPACE,
      userId: 1,
      name: "my-dns",
      type: "cloudflare",
      credential: { token: "super-secret-token" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has_credential).toBe(true);
    // 视图里没有凭据字段 —— 列表泄漏密文等于泄漏凭据本身。
    expect(Object.keys(result.value)).not.toContain("config");
    expect(JSON.stringify(result.value)).not.toContain("super-secret-token");
  });

  test("非平台管理员不能创建平台级 provider", async () => {
    const deps = stubDeps();
    const result = await createDnsProvider(deps, {
      workspaceId: WORKSPACE,
      userId: 1,
      name: "platform-dns",
      type: "cloudflare",
      credential: { token: "t" },
      platformLevel: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_provider_forbidden);
  });

  test("列表：非平台管理员只看得到本 workspace 的（否则能从列表推断平台配置了谁）", async () => {
    const deps = stubDeps({
      providers: [
        { id: 1, name: "mine", type: "cloudflare", workspace_id: WORKSPACE, config: "v1.a.b.c", created_at: null },
      ],
    });
    const result = await listDnsProviders(deps, { workspaceId: WORKSPACE, userId: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.platform_level).toBe(false);
      expect(JSON.stringify(result.value)).not.toContain("v1.a.b.c");
    }
  });

  test("删除：跨 workspace 的 provider 一律「不存在」", async () => {
    const deps = stubDeps({ provider: null });
    const result = await deleteDnsProvider(deps, { workspaceId: WORKSPACE, userId: 1, providerId: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DDNS_ERROR_CODES.dns_provider_not_found);
  });
});

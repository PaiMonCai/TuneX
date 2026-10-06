/**
 * V5-WP17.3 —— DDNS 执行器：值集规划、provider 适配、**L1 读回**、退避、审计。
 *
 * 钉住的不变量：
 *
 * ① **零外呼是有判据的**：未开启自动解析、值集没变、退避窗口内 —— 三种情况都必须**一个请求
 *    都不发**。它们各自对应一次真实事故：把用户没开的功能偷偷打开、每拍重写一次 DNS、
 *    在对端限流时火上浇油。
 * ② **值集是集合**：同一组地址换个顺序**不是**变化。否则每一拍都会写一次 DNS，
 *    而幂等性会被做成随机行为。
 * ③ **禁止假成功**（D2）：写成功 ≠ 已确认。读回不一致、或 provider 根本不支持读回，
 *    结论都只能是 `synced_unverified`。
 * ④ **失败不改归属、不清空域名**：地址不可用时空值集**绝不能**写下去（那会抹掉整个域名的
 *    记录集）；失败只写 `dns_*` 与退避状态。
 * ⑤ **退避分级**：可重试的错误排下一次尝试，**不可重试**的（4xx：凭据错、域名不存在）
 *    不排 —— 否则运维会看到"系统在重试"而实际上是等一个人来改配置。
 */
import { describe, expect, test } from "bun:test";
import {
  DDNS_BACKOFF_MS,
  DdnsProviderError,
  createHttpDdnsProviderClient,
  desiredDnsValuesFor,
  nextAttemptDelayMs,
  normalizeDnsValues,
  planDdnsValueChanges,
  syncForwardDns,
  type DdnsFetch,
  type DdnsProviderClient,
  type DdnsSyncDeps,
} from "../ddns-executor.ts";
import type { AuditEntry } from "../audit.ts";

const NOW = new Date("2026-10-05T04:00:00Z");

/* ================================================================== */
/* ① 纯函数：归一化与规划                                              */
/* ================================================================== */

describe("V5-WP17.3: 值集归一化", () => {
  test("去空白、去重、排序", () => {
    expect(normalizeDnsValues([" 203.0.113.9 ", "203.0.113.2", "203.0.113.9", "", "  "])).toEqual([
      "203.0.113.2",
      "203.0.113.9",
    ]);
  });
});

describe("V5-WP17.3: 值集规划（creates / removals / updates）", () => {
  test("新增与删除各自成组", () => {
    const plan = planDdnsValueChanges(["a", "b"], ["b", "c"]);
    expect(plan.creates).toEqual(["a"]);
    expect(plan.removals).toEqual(["c"]);
    expect(plan.updates).toEqual([]);
    expect(plan.changed).toBe(true);
  });

  test("**顺序无关**：同一组地址换个顺序不是变化（否则每拍都会写 DNS）", () => {
    const plan = planDdnsValueChanges(["b", "a"], ["a", "b"]);
    expect(plan.changed).toBe(false);
    expect(plan.creates).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  test("只有 TTL 变了 ⇒ updates 非空（值集没变，但确实要说一句话）", () => {
    const plan = planDdnsValueChanges(["a"], ["a"], true);
    expect(plan.updates).toEqual(["a"]);
    expect(plan.changed).toBe(true);
    // 值集也变了的时候，updates 不重复表达"值"这一层。
    expect(planDdnsValueChanges(["a", "b"], ["a"], true).updates).toEqual([]);
  });

  test("空集 vs 空集 ⇒ 无变化（不产生任何外呼）", () => {
    expect(planDdnsValueChanges([], []).changed).toBe(false);
  });
});

describe("V5-WP17.3: 期望值集按形态推导", () => {
  test("single_active ⇒ owner 地址；multi_entry ⇒ 可用集合（排序去重）", () => {
    expect(desiredDnsValuesFor({ mode: "single_active", ownerIp: "203.0.113.9" })).toEqual(["203.0.113.9"]);
    expect(
      desiredDnsValuesFor({ mode: "multi_entry", availableIps: ["203.0.113.9", "203.0.113.2", "203.0.113.9"] }),
    ).toEqual(["203.0.113.2", "203.0.113.9"]);
  });

  test("**没有地址就返回空集**（空集不是「写一个空的记录集」，调用方必须当成不可用）", () => {
    expect(desiredDnsValuesFor({ mode: "single_active", ownerIp: null })).toEqual([]);
    expect(desiredDnsValuesFor({ mode: "single_active", ownerIp: "   " })).toEqual([]);
    expect(desiredDnsValuesFor({ mode: "multi_entry", availableIps: [] })).toEqual([]);
  });
});

describe("V5-WP17.3: 退避阶梯", () => {
  test("按次数递进并在末级封顶", () => {
    expect(nextAttemptDelayMs(1)).toBe(DDNS_BACKOFF_MS[0]!);
    expect(nextAttemptDelayMs(2)).toBe(DDNS_BACKOFF_MS[1]!);
    expect(nextAttemptDelayMs(99)).toBe(DDNS_BACKOFF_MS[DDNS_BACKOFF_MS.length - 1]!);
    // 0/负数按第一次处理（不产生 0 延迟 —— 那等于没有退避）。
    expect(nextAttemptDelayMs(0)).toBe(DDNS_BACKOFF_MS[0]!);
    expect(nextAttemptDelayMs(-5)).toBe(DDNS_BACKOFF_MS[0]!);
  });
});

/* ================================================================== */
/* provider 适配（注入 fetch）                                          */
/* ================================================================== */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("V5-WP17.3: HTTP provider 适配器", () => {
  const client = (fetchImpl: DdnsFetch) =>
    createHttpDdnsProviderClient({ endpoint: "https://dns.test/api/", token: "tok", fetchImpl });

  test("读回：404 是**空记录集**，不是「读不到」", async () => {
    const c = client(async () => new Response("", { status: 404 }));
    expect(await c.readValues({ domain: "a.example.com", recordType: "A" })).toEqual([]);
  });

  test("读回：5xx / 429 可重试，4xx 不可重试（凭据错重试一万次也不会变对）", async () => {
    const five = client(async () => new Response("boom", { status: 503 }));
    await expect(five.readValues({ domain: "a.example.com", recordType: "A" })).rejects.toMatchObject({
      retryable: true,
    });
    const four = client(async () => new Response("nope", { status: 403 }));
    await expect(four.readValues({ domain: "a.example.com", recordType: "A" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  test("读回：响应缺少 values[] ⇒ 不可重试（这是契约不匹配，不是暂时故障）", async () => {
    const c = client(async () => jsonResponse(200, { ok: true }));
    await expect(c.readValues({ domain: "a.example.com", recordType: "A" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  test("写入：把 values 原样送出去，并把 endpoint 的尾斜杠处理掉", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const c = client(async (input, init) => {
      seen = { url: String(input), body: JSON.parse(String(init?.body)) };
      return jsonResponse(200, { ok: true });
    });
    await c.writeValues({ domain: "a.example.com", recordType: "A", values: ["203.0.113.9"], ttlSeconds: 300 });
    expect(seen!.url).toBe("https://dns.test/api/records");
    expect(seen!.body).toMatchObject({ domain: "a.example.com", type: "A", values: ["203.0.113.9"], ttl: 300 });
    expect(c.supportsReadBack).toBe(true);
  });
});

/* ================================================================== */
/* 同步：零外呼判据 + 读回 + 退避 + 审计                                */
/* ================================================================== */

interface StubOptions {
  binding?: Record<string, unknown> | null;
  provider?: { id: number; config: unknown } | null;
  desired?: { ok: true; values: string[] } | { ok: false; reason: string };
  client?: DdnsProviderClient;
}

function stubDeps(over: StubOptions = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const audits: AuditEntry[] = [];
  let clientBuilt = 0;
  const binding =
    over.binding === undefined
      ? {
          id: 11,
          workspace_id: 7,
          dns_domain: "edge.example.com",
          dns_record_type: "A",
          dns_mode: "multi_entry",
          dns_provider_id: 3,
          dns_auto_resolve: true,
          dns_confirmed_values: ["203.0.113.9"],
          dns_synced_at: NOW,
          dns_verified: true,
          dns_last_error: null,
          dns_attempt_count: 0,
          dns_next_attempt_at: null,
          ingress_node_id: 5,
          config_revision: 1,
        }
      : over.binding;

  const deps: DdnsSyncDeps = {
    db: {
      tunnel: {
        findFirst: async (args: unknown) => {
          const select = (args as { select?: Record<string, unknown> }).select ?? {};
          if ("dns_provider" in select) {
            return { dns_provider: over.provider === undefined ? { id: 3, config: "v1.a.b.c" } : over.provider };
          }
          return binding;
        },
        update: async (args: unknown) => {
          writes.push((args as { data: Record<string, unknown> }).data);
          return {};
        },
      },
    },
    desiredValues: async () => over.desired ?? { ok: true, values: ["203.0.113.9"] },
    clientFor: () => {
      clientBuilt += 1;
      if (over.client) return over.client;
      // 默认替身像真实 provider 一样：读回**回声**刚写进去的值。
      let written: string[] = [];
      return {
        supportsReadBack: true,
        readValues: async () => written,
        writeValues: async (request: { values: readonly string[] }) => {
          written = [...request.values];
        },
      };
    },
    now: () => NOW,
    auditSink: { write: async (entry) => void audits.push(entry) },
  };
  return { deps, writes, audits, clientBuilt: () => clientBuilt };
}

describe("V5-WP17.3: 同步的零外呼判据", () => {
  test("未绑定 ⇒ noop，一个请求都不发", async () => {
    const s = stubDeps({ binding: null });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("noop");
    expect(s.clientBuilt()).toBe(0);
  });

  test("未开启自动解析 ⇒ 只回报建议值集（**零外呼**）", async () => {
    const s = stubDeps({ binding: { ...(bindingRow()), dns_auto_resolve: false } });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("suggested");
    expect(result.desired).toEqual(["203.0.113.9"]);
    expect(s.clientBuilt()).toBe(0);
  });

  test("值集没变 ⇒ noop（**零外呼**）：停掉一个入口不该产生任何 DNS 写", async () => {
    const s = stubDeps({ desired: { ok: true, values: ["203.0.113.9"] } });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("noop");
    expect(s.clientBuilt()).toBe(0);
    expect(s.writes).toEqual([]);
  });

  test("退避窗口内 ⇒ backoff（零外呼），并回报下一次最早尝试时刻", async () => {
    const future = new Date(NOW.getTime() + 60_000);
    const s = stubDeps({
      binding: { ...(bindingRow()), dns_confirmed_values: [], dns_next_attempt_at: future },
    });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("backoff");
    expect(result.next_attempt_at).toBe(future.toISOString());
    expect(s.clientBuilt()).toBe(0);
  });

  test("地址不可用（期望值集为空）⇒ unavailable，**绝不写空集**", async () => {
    const s = stubDeps({ desired: { ok: false, reason: "owner 没有 connect_ip" } });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("unavailable");
    expect(s.writes).toEqual([]);
    expect(s.clientBuilt()).toBe(0);
    expect(s.audits).toHaveLength(1);
  });
});

describe("V5-WP17.3: 写入与 L1 读回（禁止假成功）", () => {
  test("写成功且读回一致 ⇒ synced，并记下确认值", async () => {
    const s = stubDeps({ desired: { ok: true, values: ["203.0.113.2", "203.0.113.9"] } });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("synced");
    expect(s.writes[0]).toMatchObject({
      dns_verified: true,
      dns_confirmed_values: ["203.0.113.2", "203.0.113.9"],
      dns_last_error: null,
      dns_attempt_count: 0,
      dns_next_attempt_at: null,
    });
  });

  test("写成功但读回不一致 ⇒ synced_unverified，且**不改已确认值集**", async () => {
    const s = stubDeps({
      desired: { ok: true, values: ["203.0.113.2"] },
      client: { supportsReadBack: true, readValues: async () => ["203.0.113.9"], writeValues: async () => {} },
    });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("synced_unverified");
    expect(s.writes[0]).toMatchObject({ dns_verified: false, dns_confirmed_values: ["203.0.113.9"] });
  });

  test("provider 不支持读回 ⇒ 只能是 synced_unverified（不是 synced）", async () => {
    const s = stubDeps({
      desired: { ok: true, values: ["203.0.113.2"] },
      client: { supportsReadBack: false, readValues: async () => null, writeValues: async () => {} },
    });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("synced_unverified");
  });

  test("读回 `null`（读不到）与读回空集是两件事：前者不算确认", async () => {
    const s = stubDeps({
      desired: { ok: true, values: ["203.0.113.2"] },
      client: { supportsReadBack: true, readValues: async () => null, writeValues: async () => {} },
    });
    expect((await syncForwardDns(s.deps, { tunnelId: 11 })).action).toBe("synced_unverified");
  });
});

describe("V5-WP17.3: 失败与退避（不改归属、不回退）", () => {
  test("可重试失败：记错误 + 次数 +1 + 排下一次尝试（**不动** epoch/revision）", async () => {
    const s = stubDeps({
      desired: { ok: true, values: ["203.0.113.2"] },
      client: {
        supportsReadBack: true,
        readValues: async () => [],
        writeValues: async () => {
          throw new DdnsProviderError("provider 写入失败：HTTP 429", true);
        },
      },
    });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("error");
    expect(result.next_attempt_at).toBe(new Date(NOW.getTime() + nextAttemptDelayMs(1)).toISOString());
    const data = s.writes[0]!;
    expect(data.dns_attempt_count).toBe(1);
    expect(String(data.dns_last_error)).toContain("429");
    // F7：失败**不**动归属相关的事实。
    expect(data).not.toHaveProperty("config_revision");
    expect(data).not.toHaveProperty("ingress_node_id");
    expect(s.audits).toHaveLength(1);
  });

  test("不可重试失败（4xx）⇒ **不排**退避：挂着下次时间会让运维以为系统在重试", async () => {
    const s = stubDeps({
      desired: { ok: true, values: ["203.0.113.2"] },
      client: {
        supportsReadBack: true,
        readValues: async () => [],
        writeValues: async () => {
          throw new DdnsProviderError("provider 写入失败：HTTP 403", false);
        },
      },
    });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("error");
    expect(result.next_attempt_at).toBeNull();
    expect(s.writes[0]!.dns_next_attempt_at).toBeNull();
  });

  test("凭据不可用（未封存）⇒ 报错，且**不构造客户端**", async () => {
    const s = stubDeps({
      desired: { ok: true, values: ["203.0.113.2"] },
      provider: { id: 3, config: { token: "plaintext" } },
    });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("error");
    expect(result.error).toContain("封存");
    expect(s.clientBuilt()).toBe(0);
  });

  test("值集没变时**连 provider 都不看**：零外呼包含「不读凭据」这一层", async () => {
    // 这条与上面那条成对：同一个未封存的凭据，在"值集没变"时不该产生任何错误 ——
    // 一个坏配置不该在没有工作要做的时候变成告警。
    const s = stubDeps({ provider: { id: 3, config: { token: "plaintext" } } });
    const result = await syncForwardDns(s.deps, { tunnelId: 11 });
    expect(result.action).toBe("noop");
    expect(s.clientBuilt()).toBe(0);
  });
});

/** 同步的默认绑定行：让各例只改自己关心的那一维（函数声明提升，故可放在文件末尾）。 */
function bindingRow() {
  return {
    id: 11,
    workspace_id: 7,
    dns_domain: "edge.example.com",
    dns_record_type: "A",
    dns_mode: "multi_entry",
    dns_provider_id: 3,
    dns_auto_resolve: true,
    dns_confirmed_values: ["203.0.113.9"],
    dns_synced_at: NOW,
    dns_verified: true,
    dns_last_error: null,
    dns_attempt_count: 0,
    dns_next_attempt_at: null,
    ingress_node_id: 5,
    config_revision: 1,
  };
}

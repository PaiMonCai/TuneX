/**
 * DDNS API 客户端的**传输层**行为测试：凭据只进请求体，不进 URL / 存储。
 *
 * 这里刻意不用 mock 分发（`handleMock`），而是把 `fetch` 换成探针，走**真实**的
 * `request()` 路径，于是能钉住三件必须为真的事：
 *   ① 路径与后端逐字一致（`/api/ddns/providers`、`/api/forwards/:id/dns`）；
 *   ② token 只出现在 body 里，**不出现在 URL**；
 *   ③ 全流程不写 localStorage（凭据不落地）。
 *
 * 注意：`API_MOCK` 是模块求值时读的常量，所以必须先设环境变量再**动态** import。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.NEXT_PUBLIC_API_MOCK = "0";

const SECRET = "cf-token-DO-NOT-LEAK-abc123";
const WORKSPACE_ID = 42;

interface Call {
  url: string;
  method: string;
  body: string | null;
  workspaceHeader: string | null;
}

const calls: Call[] = [];
const storageWrites: string[] = [];
let originalFetch: typeof globalThis.fetch | undefined;
let originalLocalStorage: unknown;

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    setItem: (key: string) => storageWrites.push(key),
    getItem: () => null,
    removeItem: () => undefined,
    clear: () => undefined,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      workspaceHeader: headers["x-workspace-id"] ?? null,
    });
    const payload = calls.length === 1 ? { data: { id: 1, has_credential: true } } : { data: { deleted: true } };
    return new Response(JSON.stringify(payload), { status: calls.length === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
});

describe("ddnsApi：路径与工作空间作用域", () => {
  test("provider CRUD 与 DNS 前门路径与后端逐字一致，且显式带 x-workspace-id", async () => {
    const { ddnsApi } = await import("@/lib/api/ddns");
    await ddnsApi.listProviders({ workspaceId: WORKSPACE_ID });
    expect(calls[0]).toMatchObject({ url: "http://backend:3000/api/ddns/providers", method: "GET", workspaceHeader: String(WORKSPACE_ID) });
    expect(calls[0]!.url).not.toContain(SECRET);

    calls.length = 0;
    await ddnsApi.forwardDns({ workspaceId: WORKSPACE_ID }, 7);
    expect(calls[0]).toMatchObject({ url: "http://backend:3000/api/forwards/7/dns", method: "GET", workspaceHeader: String(WORKSPACE_ID) });

    calls.length = 0;
    await ddnsApi.unbindForwardDns({ workspaceId: WORKSPACE_ID }, 7);
    expect(calls[0]).toMatchObject({ url: "http://backend:3000/api/forwards/7/dns", method: "DELETE" });
  });

  test("POST：token 只在 body，URL 里没有它，也没有别的地方写过凭据", async () => {
    calls.length = 0;
    storageWrites.length = 0;
    const { ddnsApi } = await import("@/lib/api/ddns");
    await ddnsApi.createProvider(
      { workspaceId: WORKSPACE_ID },
      { name: "生产 CF", type: "cloudflare", credential: { token: SECRET } },
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://backend:3000/api/ddns/providers");
    expect(call.url).not.toContain(SECRET);
    expect(call.method).toBe("POST");
    expect(call.body).toContain(SECRET);
    expect(JSON.parse(call.body!)).toEqual({
      name: "生产 CF",
      type: "cloudflare",
      credential: { token: SECRET },
    });
    expect(storageWrites).toEqual([]);
  });

  test("绑定走 POST body：首发只发 A/AAAA 与 single_active，且**不发** ttl_seconds", async () => {
    calls.length = 0;
    const { ddnsApi } = await import("@/lib/api/ddns");
    await ddnsApi.bindForwardDns(
      { workspaceId: WORKSPACE_ID },
      9,
      { domain: "node9.example.com", record_type: "AAAA", mode: "single_active", provider_id: 3, auto_resolve: true },
    );
    expect(calls[0]!.url).toBe("http://backend:3000/api/forwards/9/dns");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      domain: "node9.example.com",
      record_type: "AAAA",
      mode: "single_active",
      provider_id: 3,
      auto_resolve: true,
    });
    expect(calls[0]!.body).not.toContain("ttl");
  });
});

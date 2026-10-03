/**
 * V5-WP5-A1：mock 的 Forward 协议面必须与真实后端**同形**。
 *
 * 这个文件存在的理由和 `diagnostics-mock-v4.test.ts` 一样：mock 是前端开发期唯一
 * 能看到的东西。V5.1a 之前 `mockForwardView` 把 `protocol` 硬编码成 `"tcp"`，
 * 于是 tls/ws 的界面在 mock 下**永远看不到**（真实后端却会下发它们）——这正是
 * V5-G0 在真实下发面上抓到的缺陷形态：「投影忘了选协议列」。
 *
 * 因此这里断言三件事：
 *   1. 种子里的历史协议（tls / udp / wss）**照实**投影，并带 `protocol_supported`；
 *   2. 走 mock 创建 tls / ws 转发会成功，且响应形状与真实 `forwardView` 相同；
 *   3. 非法的协议/路径组合（非 tls 带路径、tls 缺路径、未知协议）在 mock 里同样 400
 *      —— 否则前端会在开发期看到一次「成功」，线上才失败。
 */
import { describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import { DEMO_CREDENTIALS } from "@/mocks/data";
import type { Paginated, PortForward } from "@/lib/types";

const WS = 1;

async function loginCookie(): Promise<string> {
  resetStore();
  const res = await handleMock("POST", "auth/login", {
    body: { email: DEMO_CREDENTIALS.email, password: DEMO_CREDENTIALS.password },
    query: {},
  } as never);
  const body = res.body as { session_cookie?: string } | undefined;
  return body?.session_cookie ?? "";
}

async function call<T>(method: string, path: string, cookie: string, body?: unknown) {
  const res = await handleMock(method, path, {
    body,
    query: {},
    cookie: `tunex_session=${cookie}`,
    workspaceId: WS,
  } as never);
  return { status: res.status, body: res.body as T, raw: res.body as Record<string, unknown> };
}

describe("mock：协议事实照实投影（不再把所有行都写成 tcp）", () => {
  test("种子里的 tcp / tls / udp / wss 各自照实投影，并带 protocol_supported", async () => {
    const cookie = await loginCookie();
    const { body } = await call<PortForward[]>("GET", "forwards", cookie);
    const byId = new Map(body.map((row) => [Number(row.id), row]));

    expect(byId.get(1)?.protocol).toBe("tcp");
    expect(byId.get(1)?.protocol_supported).toBe(true);

    // 种子 2：legacy `tunnel_type: "tls"` —— 协议列缺省时回落 legacy 列（V5-WP0 口径）
    expect(byId.get(2)?.protocol).toBe("tls");
    expect(byId.get(2)?.protocol_supported).toBe(true);

    // 种子 3 / 4：历史协议，运行时未开放 —— 事实照实，不回落成 tcp
    expect(byId.get(3)?.protocol).toBe("udp");
    expect(byId.get(3)?.protocol_supported).toBe(false);
    expect(byId.get(4)?.protocol).toBe("wss");
    expect(byId.get(4)?.protocol_supported).toBe(false);
  });

  test("响应形状与真实 forwardView 一致：不投影证书路径（面板看不到节点文件）", async () => {
    const cookie = await loginCookie();
    const { body } = await call<PortForward>("GET", "forwards/2", cookie);
    expect(body.protocol).toBe("tls");
    // 后端 forwardView 只给出协议事实，不把节点本地路径暴露给面板 —— mock 同形
    expect(Object.keys(body)).not.toContain("tls_cert_path");
    expect(Object.keys(body)).not.toContain("tls_key_path");
  });
});

describe("mock：创建 tls / ws 与真实契约同一口径", () => {
  const base = {
    name: "proto-front",
    mode: "direct" as const,
    ingress_node_id: 1,
    target_host: "10.0.0.9",
    target_port: 8443,
  };

  test("tls：两个绝对路径齐备才 200，且协议落成 tls", async () => {
    const cookie = await loginCookie();
    const created = await call<PortForward>("POST", "forwards", cookie, {
      ...base,
      protocol: "tls",
      tls_cert_path: "/etc/tunex/tls/front.crt",
      tls_key_path: "/etc/tunex/tls/front.key",
    });
    expect(created.status).toBe(200);
    expect(created.body.protocol).toBe("tls");
    expect(created.body.protocol_supported).toBe(true);

    // 详情页读到的也是同一条事实
    const detail = await call<PortForward>("GET", `forwards/${created.body.id}`, cookie);
    expect(detail.body.protocol).toBe("tls");
  });

  test("ws：创建成功并出现在列表里（legacy 枚举没有 ws，只能靠 forward_protocol）", async () => {
    const cookie = await loginCookie();
    const created = await call<PortForward>("POST", "forwards", cookie, {
      ...base,
      name: "proto-ws",
      protocol: "ws",
    });
    expect(created.status).toBe(200);
    expect(created.body.protocol).toBe("ws");
    expect(created.body.protocol_supported).toBe(true);

    const list = await call<PortForward[] | Paginated<PortForward>>("GET", "forwards", cookie);
    const rows = Array.isArray(list.body) ? list.body : list.body.data;
    expect(rows.some((row) => Number(row.id) === Number(created.body.id) && row.protocol === "ws")).toBe(true);
  });

  test("tls 缺路径 / 非 tls 带路径 / 未知协议一律 400（不在开发期给你假的成功）", async () => {
    const cookie = await loginCookie();
    const cases: Record<string, unknown>[] = [
      { ...base, protocol: "tls" },
      { ...base, protocol: "tls", tls_cert_path: "/etc/tunex/tls/front.crt" },
      { ...base, protocol: "tls", tls_cert_path: "etc/front.crt", tls_key_path: "/etc/front.key" },
      { ...base, protocol: "tcp", tls_cert_path: "/etc/front.crt", tls_key_path: "/etc/front.key" },
      { ...base, protocol: "ws", tls_cert_path: "/etc/front.crt", tls_key_path: "/etc/front.key" },
      { ...base, protocol: "wss" },
      { ...base, protocol: "udp" },
    ];
    for (const body of cases) {
      const res = await call<unknown>("POST", "forwards", cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  test("省略协议 = V4 的 tcp（入口的「省略即默认」只在这里成立）", async () => {
    const cookie = await loginCookie();
    const created = await call<PortForward>("POST", "forwards", cookie, { ...base, name: "proto-default" });
    expect(created.status).toBe(200);
    expect(created.body.protocol).toBe("tcp");
    expect(created.body.protocol_supported).toBe(true);
  });
});

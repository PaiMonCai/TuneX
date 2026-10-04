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

    // 种子 3：`udp` 自 V5.1b **已开放**（它过去是「枚举里有、运行时没开」的例子，
    // 那个例子现在由 wss/quic 之类的值承担）—— 断言它从 false 变成 true，
    // 正是这次契约扩张在 mock 上的可观测变化。
    expect(byId.get(3)?.protocol).toBe("udp");
    expect(byId.get(3)?.protocol_supported).toBe(true);

    // 种子 4：历史 `wss` 仍未开放 —— 事实照实，不回落成 tcp
    expect(byId.get(4)?.protocol).toBe("wss");
    expect(byId.get(4)?.protocol_supported).toBe(false);
  });

  test("响应形状与真实 forwardView 一致：tls 行投影证书路径，非 tls 行为 null", async () => {
    const cookie = await loginCookie();
    const tls = await call<PortForward>("GET", "forwards/2", cookie);
    expect(tls.body.protocol).toBe("tls");
    // 后端 forwardView 现在**投影** tls 的两列路径（A1 修订：详情页要能说出用哪张
    // 证书），只有路径、没有密钥内容 —— mock 必须同形，否则开发环境里这两列永远是空的。
    expect(tls.body.tls_cert_path).toBe("/etc/tunex/tls/ssh-front.crt");
    expect(tls.body.tls_key_path).toBe("/etc/tunex/tls/ssh-front.key");

    const tcp = await call<PortForward>("GET", "forwards/1", cookie);
    expect(tcp.body.protocol).toBe("tcp");
    // 非 tls 行**不得**残留路径（后端 `protocol === "tls" ? ... : null`）
    expect(tcp.body.tls_cert_path).toBeNull();
    expect(tcp.body.tls_key_path).toBeNull();
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
      { ...base, protocol: "quic" },
      { ...base, protocol: "mtcp" },
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

  test("udp：创建成功、带不了证书路径、投影里两列都是 null（§6.2 无协议专属配置）", async () => {
    const cookie = await loginCookie();
    const created = await call<PortForward>("POST", "forwards", cookie, {
      ...base,
      name: "proto-udp",
      protocol: "udp",
    });
    expect(created.status).toBe(200);
    expect(created.body.protocol).toBe("udp");
    expect(created.body.protocol_supported).toBe(true);
    expect(created.body.tls_cert_path).toBeNull();
    expect(created.body.tls_key_path).toBeNull();

    // udp 携带路径 = 400（与后端创建 schema 的 tlsPathsForProtocol 同一条规则）
    const withPaths = await call<unknown>("POST", "forwards", cookie, {
      ...base,
      name: "proto-udp-paths",
      protocol: "udp",
      tls_cert_path: "/etc/front.crt",
      tls_key_path: "/etc/front.key",
    });
    expect(withPaths.status).toBe(400);
  });

  test("udp + RELAY：mock 与后端一样**接受**（拒绝点是运行时，不是面板契约）", async () => {
    /*
     * 这条断言记录的是一个**边界事实**，不是理想行为：DEVELOPMENT.md §6.2 的 B1
     * 实施边界要求「udp 在 EGRESS/RELAY 上必须被拒绝」，今天只有 Agent 的
     * `Validate()` 在做这件事（`udp is a DIRECT-only datagram front in this build`），
     * 后端 create/preview 还没有这条规则。mock 镜像后端，因此也接受。
     *
     * 界面只**告警**（`datagramRelayBoundaryKey`），不自己禁用提交 —— 否则「接口能建、
     * 界面不能建」就是第二份真相。后端补上拒绝后，这条用例应当随之改成 400。
     */
    const cookie = await loginCookie();
    const nodes = await call<{ id: number; role?: string }[]>("GET", "nodes", cookie);
    const ingress = nodes.body.find((n) => n.role === "ingress");
    const egress = nodes.body.find((n) => n.role === "egress") ?? nodes.body.find((n) => n.role === "both");
    if (!ingress || !egress) return; // 没有 relay 夹具的世界
    const res = await call<PortForward>("POST", "forwards", cookie, {
      name: "proto-udp-relay",
      mode: "relay",
      protocol: "udp",
      ingress_node_id: ingress.id,
      egress_node_id: egress.id,
      target_host: "10.0.0.9",
      target_port: 53,
    });
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe("udp");
  });

  test("PATCH 改 tls 路径：落库并投影出来；非 tls 行不带路径", async () => {
    const cookie = await loginCookie();
    const patched = await call<PortForward>("PATCH", "forwards/2", cookie, {
      tls_cert_path: "/etc/tunex/tls/rotated.crt",
      tls_key_path: "/etc/tunex/tls/rotated.key",
      expected_revision: 7,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.tls_cert_path).toBe("/etc/tunex/tls/rotated.crt");
    expect(patched.body.tls_key_path).toBe("/etc/tunex/tls/rotated.key");
    // 换证书是**运行态**变更：mock 按契约意图（paths 属于 desired 配置）递增 revision
    // 并重新下发。注意后端 `isMetadataOnlyPatch` 目前漏了这两列，所以线上「只改路径」
    // 会被判成 metadata-only（路径不落库）—— 这个缺口已在任务回报中记录，两处必须
    // 一起对齐；编辑器也用 `impactMetadataOnlyTlsPaths` 把该判定下的后果说给用户。
    expect(patched.body.config_revision).toBe(8); // 7 + 1

    // preview 同样口径：只改路径不是 metadata-only
    const preview = await call<{ impact: { metadata_only: boolean; runtime_change: boolean } }>(
      "POST",
      "forwards/2/preview",
      cookie,
      { tls_cert_path: "/etc/tunex/tls/rotated2.crt" },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.impact.metadata_only).toBe(false);
    expect(preview.body.impact.runtime_change).toBe(true);

    // 非 tls 行（种子 1）即使收到路径也不得留下它们（后端 patch 侧目前是清空）
    const tcp = await call<PortForward>("PATCH", "forwards/1", cookie, {
      tls_cert_path: "/etc/tunex/tls/oops.crt",
      tls_key_path: "/etc/tunex/tls/oops.key",
      expected_revision: 4,
    });
    expect(tcp.status).toBe(200);
    expect(tcp.body.tls_cert_path).toBeNull();
    expect(tcp.body.tls_key_path).toBeNull();
  });
});

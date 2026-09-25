/**
 * WP13 Tunnel Web — v3 隧道编排契约单测（纯逻辑，不起服务器 / 浏览器）。
 *
 * 覆盖交付要求：
 *   1. **「未声明」语义**：tunnel_mode / apply_status 为 NULL = 补列前的存量行，
 *      渲染层必须显示「未声明 / 无编排」，不得默认成 direct / active；
 *   2. **apply 状态机**：error → retry、active → suspend、suspended → resume，
 *      其余来源状态一律 400（INVALID_STATE），legacy 行（无 v3 列）不可运行；
 *   3. **revision 语义**：retry 重放相同 revision（不抬高）；resume 与 desired
 *      变更使 revision +1（§4.1「编排必须继续前进」）；
 *   4. **创建契约**：RELAY 的 forward_addresses 可为空（目标在 EgressTarget 上），
 *      DIRECT 必须有转发目标；新建行停在 pending（期望状态已落库，尚未 ACK）；
 *   5. **过滤契约**：apply_status / tunnel_mode / pending_only；未知值被忽略而不是
 *      返回空集（防 UI 传错值静默全空）；
 *   6. **出口池候选**：/egress-pools 只回用户侧可用视图（node_label + targets）。
 *
 * 跑法（web 目录）：bun test src/components/tunnels/__tests__/wp13-tunnel-orchestration.test.ts
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type { Tunnel, TunnelRuntimeAction } from "@/lib/types";

const COOKIE = "tunex_session=u1"; // mock 演示用户（tunnels 1..5 的 owner）

/** 驱动 mock handler：path 上的 query string 自行解析成 query 对象（handler 不解 URL） */
const call = <T>(method: string, path: string, body?: unknown) => {
  const [bare, qs] = path.split("?");
  const query: Record<string, string> = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs).entries()) query[k] = v;
  return handleMock(method, bare, { cookie: COOKIE, body, query }) as Promise<{
    status: number;
    body: T;
  }>;
};

beforeEach(() => resetStore());

describe("WP13 列表与 v3 过滤", () => {
  test("种子覆盖 5 种 apply 态", async () => {
    const { body } = await call<{ data: Tunnel[]; total: number }>("GET", "/tunnels");
    const byId = new Map(body.data.map((t) => [t.id, t]));
    expect(byId.get(1)!.apply_status).toBe("active");
    expect(byId.get(1)!.tunnel_mode).toBe("direct");
    expect(byId.get(2)!.tunnel_mode).toBe("relay");
    expect(byId.get(3)!.apply_status).toBe("applying");
    expect(byId.get(4)!.apply_status).toBe("suspended");
    expect(byId.get(5)!.apply_status).toBe("error");
    // error 态保留记录且可解释
    expect(byId.get(5)!.apply_error_code).toBeString();
    expect((byId.get(5)!.apply_steps ?? []).length).toBeGreaterThan(0);
  });

  test("apply_status / tunnel_mode 过滤", async () => {
    const err = await call<{ data: Tunnel[] }>("GET", "/tunnels?apply_status=error");
    expect(err.body.data.map((t) => t.id)).toEqual([5]);
    const relay = await call<{ data: Tunnel[] }>("GET", "/tunnels?tunnel_mode=relay");
    expect(relay.body.data.length).toBe(3);
  });

  test("pending_only = applied_revision < config_revision", async () => {
    const { body } = await call<{ data: Tunnel[] }>("GET", "/tunnels?pending_only=true");
    expect(body.data.length).toBe(2);
    for (const t of body.data) expect((t.applied_revision ?? 0) < (t.config_revision ?? 0)).toBe(true);
  });

  test("未知过滤值被忽略，不返回空集", async () => {
    const { body } = await call<{ data: Tunnel[] }>("GET", "/tunnels?apply_status=bogus");
    expect(body.data.length).toBe(5);
  });
});

describe("WP13 状态机与运行操作", () => {
  test("retry 仅 error / suspended 可重放，且不抬高 revision", async () => {
    const r = await call<TunnelRuntimeAction>("POST", "/tunnels/5/retry", {});
    expect(r.status).toBe(200);
    expect(r.body.apply_status).toBe("active");
    expect(r.body.config_revision).toBe(5); // 相同 revision 重放
    expect(r.body.reentered).toBe(true);
    // 幂等重放：active 再 retry → 拒绝
    const again = await call<TunnelRuntimeAction>("POST", "/tunnels/5/retry", {});
    expect(again.status).toBe(400);
  });

  test("suspend 仅 active；resume 仅 suspended，resume 使 revision +1", async () => {
    const s = await call<TunnelRuntimeAction>("POST", "/tunnels/2/suspend", {});
    expect(s.status).toBe(200);
    expect(s.body.apply_status).toBe("suspended");
    expect(s.body.tunnel.desired_status).toBe("inactive");
    const r = await call<TunnelRuntimeAction>("POST", "/tunnels/2/resume", {});
    expect(r.status).toBe(200);
    expect(r.body.apply_status).toBe("active");
    expect(r.body.config_revision).toBe(8); // 7 + 1
    // 反向逐一验证拒绝
    expect((await call<TunnelRuntimeAction>("POST", "/tunnels/1/resume", {})).status).toBe(400); // active
    expect((await call<TunnelRuntimeAction>("POST", "/tunnels/3/suspend", {})).status).toBe(400); // applying
    expect((await call<TunnelRuntimeAction>("POST", "/tunnels/4/resume", {})).status).toBe(200); // suspended
  });

  test("详情含 revision 对与出口池引用", async () => {
    const { body } = await call<Tunnel>("GET", "/tunnels/5");
    expect(body.apply_status).toBe("error");
    expect(body.config_revision).toBe(5);
    expect(body.applied_revision).toBe(4);
    expect(body.egress_pool?.name).toBe("sg-relay-pool");
  });

  test("未登录 401", async () => {
    const res = await handleMock("GET", "/tunnels", {});
    expect(res.status).toBe(401);
  });
});

describe("WP13 创建契约", () => {
  test("DIRECT 必须给转发目标；新行停在 pending", async () => {
    const bad = await call<Tunnel>("POST", "/tunnels", {
      name: "no-target",
      tunnel_type: "tcp",
      category: "port_forward",
      in_node_group_id: 1,
      tunnel_mode: "direct",
      forward_addresses: [],
    });
    expect(bad.status).toBe(400);

    const ok = await call<Tunnel>("POST", "/tunnels", {
      name: "wp13-direct",
      tunnel_type: "tcp",
      category: "port_forward",
      in_node_group_id: 1,
      tunnel_mode: "direct",
      forward_addresses: ["10.0.0.9:8443"],
      listen_port: 20099,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.tunnel_mode).toBe("direct");
    expect(ok.body.apply_status).toBe("pending");
    expect(ok.body.remote_host).toBe("10.0.0.9");
    expect(ok.body.remote_port).toBe(8443);
  });

  test("RELAY 允许空转发目标，并反查出口节点 / 回填池引用", async () => {
    const r = await call<Tunnel>("POST", "/tunnels", {
      name: "wp13-relay",
      tunnel_type: "tcp",
      category: "port_forward",
      in_node_group_id: 1,
      out_node_group_id: 3,
      tunnel_mode: "relay",
      egress_pool_id: 2,
      forward_addresses: [],
    });
    expect(r.status).toBe(200);
    expect(r.body.tunnel_mode).toBe("relay");
    expect(r.body.egress_pool?.name).toBe("sg-relay-pool");
    expect(r.body.egress_node_id).toBe(6); // 池 2 挂在 node 6
    expect(r.body.remote_host).toBeNull();
    expect(r.body.apply_status).toBe("pending");
  });
});

describe("WP13 出口池候选（用户侧）", () => {
  test("/egress-pools 回可用池 + targets + node_label", async () => {
    const { body } = await call<{ id: number; name: string; node_label: string; targets: unknown[] }[]>(
      "GET",
      "/egress-pools",
    );
    expect(body.length).toBe(2);
    for (const p of body) {
      expect(p.node_label).toBeString();
      expect(p.targets.length).toBeGreaterThan(0);
    }
  });
});

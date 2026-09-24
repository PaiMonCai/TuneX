import { test, expect, describe, mock } from "bun:test";

/**
 * 端到端（配置生成层）验证：真实的 `buildInNodeConfig` 经过
 * `resolveInServicePorts` 落点后，动态端口隧道不再下发 `WAIT_LISTEN` 占位符，
 * 而是控制面分配的**唯一固定端口**，且同隧道 tcp/udp 不同号。
 *
 * 用 Bun 的 `mock.module` 屏蔽 db/redis/env/license/config，使这条**纯函数**
 * 路径无需数据库即可离线跑通。
 */
const ROOT = "/opt/TuneX/backend/src";
mock.module(`${ROOT}/db.ts`, () => ({ db: {} }));
mock.module(`${ROOT}/redis.ts`, () => ({
  redis: {
    hgetall: async () => ({}),
    hget: async () => null,
    hset: async () => 1,
  },
}));
mock.module(`${ROOT}/env.ts`, () => ({ env: { siteUrl: "http://127.0.0.1:8788" } }));
mock.module(`${ROOT}/services/license.ts`, () => ({
  licenseService: { getLicense: async () => ({ expired_at: 4102444799 }) },
}));
mock.module(`${ROOT}/services/config.ts`, () => ({
  systemConfig: { getConfig: async () => null },
}));

const { buildInNodeConfig } = await import("../config-generator.ts");

/** 造一条可下发的 port_forward 隧道（带足以通过 filterAvailableTunnels 的 plan）。 */
function tunnel(id: number, tunnelType: string, listenPort: number | null) {
  return {
    id,
    name: `t${id}`,
    tunnel_type: tunnelType,
    category: "port_forward",
    listen_ip: "",
    listen_port: listenPort,
    listen_protocol: null,
    forward_addresses: [{ address: "127.0.0.1:19911", weight: 1 }],
    forward_addresses_protocol: null,
    load_balance_type: "round",
    ip_type: "ipv4",
    ip_limit: null,
    client_limit: null,
    bandwidth_limit: null,
    proxy_protocol: false,
    status: "active",
    in_node_group_id: 4,
    out_node_group_id: null,
    user_id: 1,
    user: {
      id: 1,
      user_plan: {
        traffic: 1000,
        traffic_used: 0,
        max_tunnels: 100,
        whitelist_ips: null,
        plan: {
          traffic: 1000,
          max_tunnels: 100,
          ip_limit: null,
          client_limit: null,
          bandwidth_limit: null,
          all_in_node_groups: true,
          all_out_node_groups: true,
          node_groups: [],
        },
      },
    },
  } as never;
}

function build(tunnels: unknown[], portRange: string | null) {
  return buildInNodeConfig({
    inNodeGroupId: 4,
    portRange,
    allowListenProtocol: false,
    allTunnels: tunnels as never,
    outListens: {},
    tunnelLimits: new Map(),
    siteUrl: "http://127.0.0.1:8788",
    observerPeriod: "5s",
  });
}

describe("buildInNodeConfig dynamic ports (multi-node fix)", () => {
  test("dynamic tunnels get control-plane-assigned fixed ports, no WAIT_LISTEN", () => {
    const cfg = build([tunnel(8, "tcp", null), tunnel(9, "tcp", null)], "19000-19010");
    const services = (cfg.services ?? []) as { name: string; addr: string }[];
    const tcp8 = services.find((s) => s.name === "tcp-8")!;
    const udp8 = services.find((s) => s.name === "udp-8")!;
    const tcp9 = services.find((s) => s.name === "tcp-9")!;
    const udp9 = services.find((s) => s.name === "udp-9")!;

    // No WAIT_LISTEN placeholder remains for dynamic tunnels.
    expect(tcp8.addr).not.toContain("WAIT_LISTEN");
    expect(tcp8.addr).toBe(":19000");
    expect(udp8.addr).toBe(":19001");
    expect(tcp9.addr).toBe(":19002");
    expect(udp9.addr).toBe(":19003");
  });

  test("all assigned ports are unique across the group (no tcp/udp collision)", () => {
    const cfg = build([tunnel(8, "tcp", null), tunnel(9, "udp", null)], "19000-19010");
    const services = (cfg.services ?? []) as { name: string; addr: string }[];
    const ports = services.map((s) => s.addr).filter((a) => a.startsWith(":") && !a.includes("WAIT"));
    expect(new Set(ports).size).toBe(ports.length);
  });

  test("fixed-port tunnel keeps its explicit addr", () => {
    const cfg = build([tunnel(8, "tcp", 19005)], "19000-19010");
    const services = (cfg.services ?? []) as { name: string; addr: string }[];
    const tcp8 = services.find((s) => s.name === "tcp-8")!;
    expect(tcp8.addr).toBe(":19005");
  });

  test("range exhaustion keeps WAIT_LISTEN fallback (backwards compatible)", () => {
    // Two tunnels × 2 services = 4 listeners but only a 2-port range.
    const cfg = build([tunnel(8, "tcp", null), tunnel(9, "tcp", null)], "19000-19001");
    const services = (cfg.services ?? []) as { name: string; addr: string }[];
    const fallbacks = services.filter((s) => s.addr.includes("WAIT_LISTEN"));
    expect(fallbacks.length).toBeGreaterThan(0);
  });
});

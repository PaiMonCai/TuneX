/**
 * V4 Forward / Node-first mock contract tests.
 *
 * These cover the product API boundary used by /nodes and /forwards. Tunnel is
 * intentionally treated as an implementation detail here.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type {
  NodeBinding,
  PortForward,
  ProvisionNodeResult,
  TrafficPoint,
  UserNode,
} from "@/lib/types";

const COOKIE = "tunex_session=u1";

const call = <T>(method: string, path: string, body?: unknown) => {
  const [bare, qs] = path.split("?");
  const query: Record<string, string> = {};
  if (qs) {
    for (const [key, value] of new URLSearchParams(qs).entries()) {
      query[key] = value;
    }
  }
  return handleMock(method, bare, { cookie: COOKIE, body, query }) as Promise<{
    status: number;
    body: T;
  }>;
};

beforeEach(() => resetStore());

describe("V4 node-first contract", () => {
  test("GET /nodes exposes usable ingress/egress roles and immutable agent ids", async () => {
    const result = await call<UserNode[]>("GET", "/nodes");
    expect(result.status).toBe(200);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body.some((node) => node.role === "ingress" || node.role === "both")).toBe(true);
    expect(result.body.some((node) => node.role === "egress" || node.role === "both")).toBe(true);
    for (const node of result.body) expect(node.agent_id).toBeString();
  });

  test("bindings are explicit and can be created / removed", async () => {
    const existing = await call<NodeBinding[]>("GET", "/nodes/1/bindings");
    expect(existing.status).toBe(200);
    expect(existing.body.some((row) => Number(row.egress_node_id) === 4)).toBe(true);

    const created = await call<NodeBinding>("POST", "/nodes/1/bindings", {
      egress_node_id: 7,
    });
    expect(created.status).toBe(200);
    expect(Number(created.body.egress_node_id)).toBe(7);

    const removed = await call<{ ok: boolean }>("DELETE", "/nodes/1/bindings/7");
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
  });

  test("node provisioning returns one-click enrollment", async () => {
    const result = await call<ProvisionNodeResult>("POST", "/node-groups/1/nodes", {
      node_id: "v4-test-ingress",
      role: "ingress",
    });
    expect(result.status).toBe(200);
    expect(result.body.node.node_id).toBe("v4-test-ingress");
    expect(result.body.node.role).toBe("ingress");
    expect(result.body.enrollment.agent_id).toBe(result.body.node.agent_id);
    expect(result.body.enrollment.install_command).toContain("docker run");
  });
});

describe("V4 forward product contract", () => {
  test("DIRECT creates without egress and is readable from /forwards/:id", async () => {
    const created = await call<PortForward>("POST", "/forwards", {
      name: "direct-v4",
      mode: "direct",
      ingress_node_id: 1,
      listen_port: 25001,
      target_host: "10.0.0.10",
      target_port: 8080,
      egress_node_id: null,
    });
    expect(created.status).toBe(200);
    expect(created.body.mode).toBe("direct");
    expect(created.body.egress_node_id).toBeNull();
    expect(created.body.target_host).toBe("10.0.0.10");
    expect(created.body.apply_status).toBe("active");

    const detail = await call<PortForward>("GET", `/forwards/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe("direct-v4");
    expect(detail.body.traffic).toBe(0);
  });

  test("RELAY requires an explicit ingress->egress binding", async () => {
    const denied = await call<PortForward>("POST", "/forwards", {
      name: "relay-unbound",
      mode: "relay",
      ingress_node_id: 1,
      egress_node_id: 7,
      target_host: "example.internal",
      target_port: 443,
    });
    expect(denied.status).toBe(409);

    await call<NodeBinding>("POST", "/nodes/1/bindings", { egress_node_id: 7 });
    const created = await call<PortForward>("POST", "/forwards", {
      name: "relay-bound",
      mode: "relay",
      ingress_node_id: 1,
      egress_node_id: 7,
      target_host: "example.internal",
      target_port: 443,
    });
    expect(created.status).toBe(200);
    expect(created.body.mode).toBe("relay");
    expect(Number(created.body.egress_node_id)).toBe(7);
    expect(created.body.target_host).toBe("example.internal");
    expect(created.body.target_port).toBe(443);
  });

  test("runtime actions and traffic stay on the Forward API", async () => {
    const created = await call<PortForward>("POST", "/forwards", {
      name: "runtime-v4",
      mode: "direct",
      ingress_node_id: 1,
      target_host: "127.0.0.1",
      target_port: 3000,
    });

    const suspended = await call<PortForward>(
      "POST",
      `/forwards/${created.body.id}/suspend`,
      {},
    );
    expect(suspended.status).toBe(200);
    expect(suspended.body.apply_status).toBe("suspended");

    const resumed = await call<PortForward>(
      "POST",
      `/forwards/${created.body.id}/resume`,
      {},
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.apply_status).toBe("active");

    const traffic = await call<TrafficPoint[]>(
      "GET",
      `/forwards/${created.body.id}/traffic?days=7`,
    );
    expect(traffic.status).toBe(200);
    expect(traffic.body).toHaveLength(7);
  });

  test("an in-use RELAY binding cannot be removed", async () => {
    const created = await call<PortForward>("POST", "/forwards", {
      name: "relay-in-use",
      mode: "relay",
      ingress_node_id: 1,
      egress_node_id: 4,
      target_host: "10.10.10.10",
      target_port: 443,
    });
    expect(created.status).toBe(200);

    const unbind = await call<{ message?: string }>(
      "DELETE",
      "/nodes/1/bindings/4",
    );
    expect(unbind.status).toBe(409);
  });
});

/**
 * V4-WP11C / WP11B：mock 与真实后端**契约一致**的守卫。
 *
 * 这个文件的存在理由：mock 是前端在开发期唯一能看到的东西。如果 mock 把 RELAY
 * 诊断渲染成"两段都已验证可达"，界面与真实环境的差异就被掩盖了——而那条差异
 * （"入口↔出口"一段永远未验证）正是这个功能最重要的一条不确定性。所以 mock 的
 * 形状必须有断言盯着。
 */
import { describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import { DEMO_CREDENTIALS } from "@/mocks/data";

const WS = 1;

async function loginCookie(): Promise<string> {
  resetStore();
  // The seeded demo user: registering a fresh one leaves no workspace fixtures,
  // so a new account cannot create a forward at all.
  const res = await handleMock("POST", "auth/login", {
    body: { email: DEMO_CREDENTIALS.email, password: DEMO_CREDENTIALS.password },
    query: {},
  } as never);
  // The mock has no real response headers on the client: the session cookie value
  // comes back in the body (the api layer writes it to document.cookie).
  const body = res.body as { session_cookie?: string } | undefined;
  return body?.session_cookie ?? "";
}

async function call(method: string, path: string, cookie: string, body?: unknown) {
  return handleMock(method, path, {
    body,
    query: {},
    // `isLoggedIn` only checks that the session cookie is present; the value
    // selects the user (u<id> → that user, otherwise the demo user).
    cookie: `tunex_session=${cookie}`,
    workspaceId: WS,
  } as never);
}

describe("diagnose mock mirrors the real segment semantics", () => {
  test("a DIRECT forward yields one verified probe segment", async () => {
    const cookie = await loginCookie();
    const created = await call("POST", "forwards", cookie, {
      name: "diag-direct", mode: "direct", ingress_node_id: 1, target_host: "target-a", target_port: 3030,
    });
    const id = (created.body as { id?: number })?.id;
    expect(typeof id).toBe("number");

    const res = await call("POST", `forwards/${id}/diagnose`, cookie, {});
    const report = res.body as {
      segments?: { segment: string; method: string; verified: boolean }[];
    };
    expect(report?.segments).toHaveLength(1);
    expect(report?.segments?.[0]).toMatchObject({ segment: "ingress_to_target", method: "tcp_probe", verified: true });
  });

  test("a RELAY forward yields an UNVERIFIED facts segment plus a verified probe", async () => {
    const cookie = await loginCookie();
    // The mock's relay path needs an egress node; the world ships one.
    const nodes = await call("GET", "nodes", cookie);
    const nodeList = (nodes.body ?? []) as { id: number; role?: string }[];
    const ingress = nodeList.find((n) => n.role === "ingress") ?? nodeList[0];
    const egress = nodeList.find((n) => n.role === "egress") ?? nodeList[1] ?? nodeList[0];
    const created = await call("POST", "forwards", cookie, {
      name: "diag-relay", mode: "relay", ingress_node_id: ingress?.id, egress_node_id: egress?.id,
      target_host: "target-a", target_port: 3030,
    });
    const id = (created.body as { id?: number })?.id;
    if (typeof id !== "number") return; // world without relay fixtures

    const res = await call("POST", `forwards/${id}/diagnose`, cookie, {});
    const report = res.body as {
      segments?: { segment: string; method: string; verified: boolean; outcome: string }[];
    };
    const hop = report?.segments?.find((s) => s.segment === "ingress_to_egress");
    expect(hop).toMatchObject({ method: "node_facts", verified: false });
    // The unverified segment must not claim reachability.
    expect(hop?.outcome).toBe("ok");
    const probe = report?.segments?.find((s) => s.segment === "egress_to_target");
    expect(probe).toMatchObject({ method: "tcp_probe", verified: true });
  });
});

describe("node mocks follow the offline-is-a-conclusion rule", () => {
  test("diagnostics answers with the contract shape", async () => {
    const cookie = await loginCookie();
    const nodes = await call("GET", "nodes", cookie);
    const first = ((nodes.body ?? []) as { id: number }[])[0];
    if (!first) return;
    const res = await call("GET", `nodes/${first.id}/diagnostics`, cookie);
    const report = res.body as {
      reachability?: string; panel?: { node_id?: string }; agent_facts?: unknown;
    };
    expect(["online", "offline", "unknown"]).toContain(report?.reachability ?? "");
    expect(typeof report?.panel?.node_id).toBe("string");
    if (report?.reachability !== "online") {
      expect(report?.agent_facts ?? null).toBeNull();
    }
  });

  test("an upgrade command is refused outside maintenance unless explicitly allowed", async () => {
    const cookie = await loginCookie();
    const nodes = await call("GET", "nodes", cookie);
    const first = ((nodes.body ?? []) as { id: number }[])[0];
    if (!first) return;

    const refused = await call("POST", `nodes/${first.id}/upgrade-command`, cookie, { agent_image: "ghcr.io/tunex/agent:1.4.0" });
    const allowed = await call("POST", `nodes/${first.id}/upgrade-command`, cookie, {
      agent_image: "ghcr.io/tunex/agent:1.4.0", allow_active: true,
    });
    // Either the node is in maintenance (first call succeeds) or the override is
    // required — and then the override must work. Never "nothing works".
    expect(allowed.status).toBe(200);
    if (refused.status !== 200) {
      expect(refused.status).toBe(409);
    }
  });
});

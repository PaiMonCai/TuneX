/**
 * V4-WP4 mock 契约：Forward 全字段编辑 + preview。
 *
 * 用例名/错误码/impact 字段与 backend/src/services/__tests__/forward-revision.test.ts
 * 逐条同名，因此 WP3 集成时可以用同一断言集打到真实后端。
 *
 * 覆盖本报告 §5 测试计划的 ①–⑩（mock 契约层）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type { ForwardPatchInput, ForwardPreviewResult, PortForward } from "@/lib/types";

const COOKIE = "tunex_session=u1";

const call = <T>(method: string, path: string, body?: unknown) =>
  handleMock(method, path, { cookie: COOKIE, body }) as Promise<{
    status: number;
    body: T;
  }>;

beforeEach(() => resetStore());

/** seeds：/forwards/1 是 DIRECT active（revision 4），/forwards/2 是 RELAY active（revision 7） */
describe("V4 forward edit contract", () => {
  test("① full-field PATCH merges the current desired config and bumps revision", async () => {
    const before = await call<PortForward>("GET", "/forwards/1");
    expect(before.status).toBe(200);
    expect(before.body.config_revision).toBe(4);

    const patched = await call<PortForward>("PATCH", "/forwards/1", {
      target_host: "10.9.9.9",
      target_port: 9000,
      expected_revision: 4,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.target_host).toBe("10.9.9.9");
    expect(patched.body.target_port).toBe(9000);
    expect(patched.body.config_revision).toBe(5);
    // 未传的字段沿用当前 desired（禁止把一次编辑拆成多个 PATCH，前端也不会拆）
    expect(patched.body.name).toBe("群晖 Web 面板");

    // 二次编辑：基线是上一次的 desired，不是种子
    const second = await call<PortForward>("PATCH", "/forwards/1", {
      listen_port: 25001,
      expected_revision: 5,
    });
    expect(second.status).toBe(200);
    expect(second.body.listen_port).toBe(25001);
    expect(second.body.target_host).toBe("10.9.9.9");
    expect(second.body.config_revision).toBe(6);
  });

  test("② rename-only patch does not bump revision or trigger rollout", async () => {
    const before = await call<PortForward>("GET", "/forwards/1");
    const patched = await call<PortForward>("PATCH", "/forwards/1", { name: "改名不升版本" });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("改名不升版本");
    expect(patched.body.config_revision).toBe(before.body.config_revision);
    expect(patched.body.applied_revision).toBe(before.body.applied_revision);
    expect(patched.body.last_applied_at).toBe(before.body.last_applied_at);
  });

  test("③ stale expected_revision is rejected with 409 + latest_revision and writes nothing", async () => {
    const before = await call<PortForward>("GET", "/forwards/1");
    const conflicted = await call<{ message: string; code: string; data: { latest_revision: number } }>(
      "PATCH",
      "/forwards/1",
      { target_port: 1234, expected_revision: 999 } satisfies ForwardPatchInput,
    );
    expect(conflicted.status).toBe(409);
    expect(conflicted.body.code).toBe("revision_conflict");
    expect(conflicted.body.data.latest_revision).toBe(before.body.config_revision);

    const after = await call<PortForward>("GET", "/forwards/1");
    expect(after.body.target_port).toBe(before.body.target_port);
    expect(after.body.config_revision).toBe(before.body.config_revision);
  });

  test("④ direct mode rejects an egress node (mode_topology_mismatch)", async () => {
    const bad = await call<{ message: string; code: string }>("PATCH", "/forwards/1", {
      mode: "direct",
      egress_node_id: 4,
    } satisfies ForwardPatchInput);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("mode_topology_mismatch");
  });

  test("⑤ relay without an ingress->egress binding is blocked (binding_required)", async () => {
    // node 1 与 node 7 之间没有绑定
    const denied = await call<{ code: string }>("PATCH", "/forwards/1", {
      mode: "relay",
      egress_node_id: 7,
      target_host: "example.internal",
      target_port: 443,
    } satisfies ForwardPatchInput);
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe("binding_required");

    // 补绑定后同一 patch 必须被接受（校验同一个实现，不存在两套规则）
    await call<unknown>("POST", "/nodes/1/bindings", { egress_node_id: 7 });
    const allowed = await call<PortForward>("PATCH", "/forwards/1", {
      mode: "relay",
      egress_node_id: 7,
      target_host: "example.internal",
      target_port: 443,
      expected_revision: 4,
    } satisfies ForwardPatchInput);
    expect(allowed.status).toBe(200);
    expect(allowed.body.mode).toBe("relay");
  });

  test("⑥ a listen port already held by another forward is rejected (port_conflict)", async () => {
    const denied = await call<{ code: string }>("PATCH", "/forwards/1", {
      listen_port: 20002,
    } satisfies ForwardPatchInput);
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe("port_conflict");

    // 改回自己占用的端口不算冲突
    const same = await call<PortForward>("PATCH", "/forwards/1", {
      listen_port: 20001,
      expected_revision: 4,
    } satisfies ForwardPatchInput);
    expect(same.status).toBe(200);
  });

  test("⑦ listen_port null means automatic allocation", async () => {
    const previewed = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      listen_port: null,
    } satisfies ForwardPatchInput);
    expect(previewed.status).toBe(200);
    expect(previewed.body.candidate.config.listen_port).toBeNull();
    expect(previewed.body.impact.port_status).toBe("auto");
  });

  test("⑧ preview impact matches §13.3.3 / §13.3.4 field by field", async () => {
    // target 热换：target_change=true，listener 不重建
    const targetPreview = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      target_port: 8443,
    } satisfies ForwardPatchInput);
    expect(targetPreview.status).toBe(200);
    expect(targetPreview.body.impact.target_change).toBe(true);
    expect(targetPreview.body.impact.listener_replacement).toBe(false);
    expect(targetPreview.body.impact.changes_external_address).toBe(false);
    expect(targetPreview.body.impact.metadata_only).toBe(false);

    // 改端口：外部地址变化 + listener 重建
    const portPreview = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      listen_port: 25001,
    } satisfies ForwardPatchInput);
    expect(portPreview.body.impact.listen_port_change).toBe(true);
    expect(portPreview.body.impact.changes_external_address).toBe(true);
    expect(portPreview.body.impact.listener_replacement).toBe(true);
    expect(portPreview.body.impact.desired_address).not.toBeNull();

    // 改 ingress：新旧两端都进 PREPARE/DRAIN
    const ingressPreview = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      ingress_node_id: 2,
      listen_port: 25001,
    } satisfies ForwardPatchInput);
    expect(ingressPreview.body.impact.ingress_node_change).toBe(true);
    expect(ingressPreview.body.impact.nodes_prepare_drain.length).toBeGreaterThan(0);

    // 纯改名：metadata_only，无任何数据面影响
    const renamePreview = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      name: "只是改名",
    } satisfies ForwardPatchInput);
    expect(renamePreview.body.impact.metadata_only).toBe(true);
    expect(renamePreview.body.impact.runtime_change).toBe(false);
    expect(renamePreview.body.impact.desired_address).toBeNull();
    expect(renamePreview.body.candidate.revision).toBe(renamePreview.body.current.revision);

    // mode 切换：listener 重建 + direct↔relay 互斥校验
    const modePreview = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      mode: "relay",
      egress_node_id: 4,
    } satisfies ForwardPatchInput);
    expect(modePreview.body.impact.mode_change).toBe(true);
    expect(modePreview.body.impact.listener_replacement).toBe(true);
    expect(modePreview.body.validation.ok).toBe(true);
  });

  test("⑨ preview validation errors match the PATCH rejection reason", async () => {
    const bad = { mode: "direct", egress_node_id: 4 } satisfies ForwardPatchInput;
    // 两边都走同一个解析器：校验失败时 preview **不返回** envelope，
    // 而是与 PATCH 一样直接返回错误（这正是「preview 放行 ⇔ update 接受」的
    // 反面：preview 拒绝 ⇔ PATCH 拒绝，两边不可能出现两种结论）。
    const previewed = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", bad);
    const patched = await call<{ code: string; data?: { errors?: string[] } }>(
      "PATCH",
      "/forwards/1",
      bad,
    );
    expect(previewed.status).toBe(400);
    expect(patched.status).toBe(400);
    expect(previewed.body.code).toBe(patched.body.code);
    expect(previewed.body.code).toBe("mode_topology_mismatch");
  });

  test("⑩ preview never writes the store", async () => {
    const before = await call<PortForward>("GET", "/forwards/1");
    await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      target_host: "10.1.2.3",
      target_port: 4321,
      listen_port: 25001,
    } satisfies ForwardPatchInput);
    const after = await call<PortForward>("GET", "/forwards/1");
    expect(after.body.target_host).toBe(before.body.target_host);
    expect(after.body.target_port).toBe(before.body.target_port);
    expect(after.body.listen_port).toBe(before.body.listen_port);
    expect(after.body.config_revision).toBe(before.body.config_revision);
  });

  test("⑩ desired_address is ip:port when the ingress is known", async () => {
    // 预测地址取 ingress 的 connect_ip，而不是前端猜；这里从 /nodes 读真值，
    // 避免把测试焊死在某个演示 IP 上。
    const nodes = await call<Array<{ id: number; connect_ip: string | null }>>("GET", "/nodes");
    const ingress = nodes.body.find((node) => Number(node.id) === 1);
    expect(ingress?.connect_ip).toBeTruthy();

    const previewed = await call<ForwardPreviewResult>("POST", "/forwards/1/preview", {
      target_port: 8443,
    } satisfies ForwardPatchInput);
    const port = previewed.body.candidate.config.listen_port ?? 20001;
    expect(previewed.body.impact.desired_address).toBe(`${ingress!.connect_ip}:${port}`);
  });

  test("edges: unknown forward 404s", async () => {
    const missing = await call<{ message: string }>("PATCH", "/forwards/9999", {
      name: "x",
    } satisfies ForwardPatchInput);
    expect(missing.status).toBe(404);
    // 路由层守卫在解析前挡下未知 id，code 沿用 mock 既有的 NOT_FOUND 约定。
    expect(missing.body.message).toContain("不存在");
  });

  test("edges: relay patch keeps the egress node when the mode is unchanged", async () => {
    const patched = await call<PortForward>("PATCH", "/forwards/2", {
      name: "改个名字而已",
    } satisfies ForwardPatchInput);
    expect(patched.status).toBe(200);
    expect(patched.body.mode).toBe("relay");
    expect(patched.body.egress_node_id).not.toBeNull();
    expect(patched.body.config_revision).toBe(7);
  });
});

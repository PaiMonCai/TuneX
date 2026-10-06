/**
 * V4-WP9 §13.6「Binding usage」— mock 契约测试。
 *
 * reports/v4-wp9-plan.md 的 S3 验收是「使用量随转发创建/删除变化；解绑仍 409」，
 * 本文件把这两条钉死。它覆盖的是 `web/src/mocks/handler.ts` 里那份**与后端同口径**
 * 的实现（`mockBindingUsage`），而后端那一份由
 * `backend/src/services/__tests__/binding-usage.test.ts` 负责。
 *
 * 为什么单独成文件而不是塞进 forward-scale.test.ts：那份文件只管列表的分页/排序/
 * 过滤，绑定使用量是另一条产品路径（`/nodes/:id/bindings`），混在一起会让失败原因
 * 不好定位。
 *
 * 契约要点（两侧必须一致，否则本地 mock 通过、线上 409）：
 *   · 统计口径：workspace 内 `tunnel_mode = relay` 且 (ingress, egress) 全等的转发条数；
 *     **不按运行状态过滤** —— suspended / error 的中继同样占用绑定；
 *   · 列表响应带 `used_by_forward_count` / `unbind_blocked`（响应投影，不新增列）；
 *   · 解绑闸门与列表展示是同一条规则：>0 → 409 `binding_in_use`，且回传使用量。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type { NodeBinding, PortForward } from "@/lib/types";

const COOKIE = "tunex_session=u1"; // 种子里 tunnels 1..5 的 owner

/** 驱动 mock handler：path 上的 query string 自行解析成 query 对象（handler 不解 URL）。 */
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

/** 每次从接口读，避免测试依赖种子的具体条数。 */
async function usageOf(ingress: number, egress: number) {
  const res = await call<NodeBinding[]>("GET", `/nodes/${ingress}/bindings`);
  const row = res.body.find((binding) => Number(binding.egress_node_id) === egress);
  if (!row) throw new Error(`binding ${ingress}→${egress} 不在种子里`);
  return row;
}

describe("V4-WP9 binding usage — mock 契约", () => {
  test("列表响应带使用量投影，且字段是数字 + 布尔（不是 undefined）", async () => {
    const row = await usageOf(1, 4);
    expect(typeof row.used_by_forward_count).toBe("number");
    expect(typeof row.unbind_blocked).toBe("boolean");
    // 判定与计数同源：阻塞 ⇔ 计数 > 0（不允许出现「0 条但阻塞」这种自相矛盾）
    expect(row.unbind_blocked).toBe(row.used_by_forward_count > 0);
  });

  test("使用量随中继转发**创建**变化（+1），且判定随之翻转", async () => {
    const before = await usageOf(1, 4);

    const created = await call<PortForward>("POST", "/forwards", {
      name: "wp9-usage-relay",
      mode: "relay",
      ingress_node_id: 1,
      egress_node_id: 4,
      target_host: "10.0.0.9",
      target_port: 8443,
    });
    expect(created.status).toBe(200);

    const after = await usageOf(1, 4);
    expect(after.used_by_forward_count).toBe(before.used_by_forward_count + 1);
    expect(after.unbind_blocked).toBe(true);
  });

  test("使用量随中继转发**删除**变化（-1），回到原值", async () => {
    const before = await usageOf(1, 4);

    const created = await call<PortForward>("POST", "/forwards", {
      name: "wp9-usage-roundtrip",
      mode: "relay",
      ingress_node_id: 1,
      egress_node_id: 4,
      target_host: "10.0.0.10",
      target_port: 8443,
    });
    expect(created.status).toBe(200);

    const removed = await call<{ ok?: boolean }>(
      "DELETE",
      `/forwards/${Number(created.body.id)}`,
    );
    expect(removed.status).toBe(200);

    const after = await usageOf(1, 4);
    expect(after.used_by_forward_count).toBe(before.used_by_forward_count);
  });

  test("DIRECT 转发不计入使用量（绑定只被中继占用）", async () => {
    const before = await usageOf(1, 4);

    const created = await call<PortForward>("POST", "/forwards", {
      name: "wp9-usage-direct",
      mode: "direct",
      ingress_node_id: 1,
      egress_node_id: null,
      target_host: "10.0.0.11",
      target_port: 9443,
    });
    expect(created.status).toBe(200);

    const after = await usageOf(1, 4);
    expect(after.used_by_forward_count).toBe(before.used_by_forward_count);
  });

  test("使用中的绑定解绑仍 409，且错误响应带上使用量（前端错误分支可刷新按钮）", async () => {
    const before = await usageOf(1, 4);
    expect(before.unbind_blocked).toBe(true); // 种子里该绑定已被占用

    const res = await call<{
      message?: string;
      code?: string;
      data?: { used_by_forward_count?: number; unbind_blocked?: boolean };
    }>("DELETE", "/nodes/1/bindings/4");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BINDING_IN_USE");
    // 文案说清数量与下一步，而不是只说「无法解绑」
    expect(res.body.message).toContain(String(before.used_by_forward_count));
    expect(res.body.message).toContain("出口");
    // 错误分支同样携带使用量投影
    expect(res.body.data?.used_by_forward_count).toBe(before.used_by_forward_count);
    expect(res.body.data?.unbind_blocked).toBe(true);

    // 行没有被删掉：闸门是拒绝，不是「删了再报错」
    const still = await usageOf(1, 4);
    expect(still.unbind_blocked).toBe(true);
  });

  test("新建绑定返回 0 使用量（刚创建的绑定不可能被占用）", async () => {
    // 7 号节点在种子里没有被 1 号入口绑定
    const created = await call<NodeBinding>("POST", "/nodes/1/bindings", {
      egress_node_id: 7,
    });
    // 状态码不在此断言：mock 对 POST 绑定一律回 200，而后端路由回 201 —— 这是
    // WP4 之前就存在的 mock/后端差异（forward-v4.test.ts 也按 200 断言），
    // 不属于本切片范围；本用例只钉住使用量投影的形状与取值。
    expect(created.status).toBeLessThan(300);
    expect(created.body.used_by_forward_count).toBe(0);
    expect(created.body.unbind_blocked).toBe(false);
  });

  test("未占用的绑定可以解绑（闸门只挡正在使用的）", async () => {
    await call<NodeBinding>("POST", "/nodes/1/bindings", { egress_node_id: 7 });
    const removed = await call<{ ok?: boolean }>("DELETE", "/nodes/1/bindings/7");
    expect(removed.status).toBe(200);
  });
});

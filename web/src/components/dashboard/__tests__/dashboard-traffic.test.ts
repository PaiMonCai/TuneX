/**
 * OPS-03 仪表盘流量装配单测（纯逻辑，不起服务器、不连后端）。
 *
 * 覆盖交付要求里的「dashboard 组件的数据获取逻辑（可用 mock）」：
 *   1. **作用域正确**：请求带的是传入的 workspaceId（cookie 里解析出的当前空间），
 *      没有 workspace 时**不发请求**（不猜个人空间，避免展示别的空间的流量）；
 *   2. **成功**：by_day 直接进图表、by_tunnel 进排行，status=ok；
 *   3. **空数据**：接口成功但全是 0 → status=empty（页面显示空态而非报错）；
 *   4. **失败**：接口 403/500 → status=error 且带可展示消息，**不伪装成没有流量**；
 *   5. **脏契约**：后端返回缺字段时退化成空数组，不让渲染路径 500。
 *
 * 跑法（web 目录）：bun test src/components/dashboard/__tests__/dashboard-traffic.test.ts
 * 与后端约定不同，这里是纯内存测试，直接 bun test 即可（无 DB/Redis 依赖）。
 */
import { test, expect, describe } from "bun:test";
import { loadDashboardTraffic, TRAFFIC_TREND_DAYS } from "../dashboard-traffic";
import type { WorkspaceTrafficSummary } from "@/lib/types";

const day = (n: number, traffic: number, cost = Number((traffic / 1073741824).toFixed(4))) => ({
  date: `2026-09-${String(n).padStart(2, "0")}`,
  traffic,
  traffic_cost: cost,
});

function summary(over: Partial<WorkspaceTrafficSummary> = {}): WorkspaceTrafficSummary {
  return {
    workspace_id: 7,
    period: "total",
    since: null,
    total_traffic: 0,
    total_traffic_cost: 0,
    by_tunnel: [],
    by_day: [],
    orphan_rows: 0,
    ...over,
  };
}

describe("loadDashboardTraffic", () => {
  test("成功：by_day 进图表、by_tunnel 进排行", async () => {
    const calls: Array<[number, number]> = [];
    const r = await loadDashboardTraffic({
      workspaceId: 7,
      fetchTraffic: async (id, days) => {
        calls.push([id, days]);
        return summary({
          total_traffic: 3 * 1024 ** 3,
          by_tunnel: [
            { tunnel_id: 2, name: "B", tunnel_type: "tcp", in_node_group_id: 3, in_node_group_name: "IN-B", traffic: 2 * 1024 ** 3, traffic_cost: 2 },
            { tunnel_id: 1, name: "A", tunnel_type: "tcp", in_node_group_id: 3, in_node_group_name: "IN-B", traffic: 1024 ** 3, traffic_cost: 1 },
          ],
          by_day: [day(28, 1024 ** 3), day(29, 2 * 1024 ** 3)],
        });
      },
    });
    // 用当前 workspace id 与默认 14 天请求
    expect(calls).toEqual([[7, TRAFFIC_TREND_DAYS]]);
    expect(r.status).toBe("ok");
    expect(r.points).toHaveLength(2);
    expect(r.points[0].traffic).toBe(1024 ** 3);
    // 排行保持后端给的降序，前端不再排序（单一真相源）
    expect(r.tunnels.map((x) => x.tunnel_id)).toEqual([2, 1]);
    expect(r.message).toBeNull();
  });

  test("days 可覆盖（趋势天数由调用方决定）", async () => {
    const calls: number[] = [];
    await loadDashboardTraffic({
      workspaceId: 3,
      days: 7,
      fetchTraffic: async (_id, days) => {
        calls.push(days);
        return summary({ by_day: [day(29, 1)] });
      },
    });
    expect(calls).toEqual([7]);
  });

  test("没有 workspace id：不发请求，状态 no-workspace", async () => {
    let called = false;
    const r = await loadDashboardTraffic({
      workspaceId: null,
      fetchTraffic: async () => {
        called = true;
        return summary();
      },
    });
    expect(called).toBe(false);
    expect(r.status).toBe("no-workspace");
    expect(r.points).toEqual([]);
  });

  test("非法 workspace id（0 / 负数 / 非整数）一律不发请求", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      let called = false;
      const r = await loadDashboardTraffic({
        workspaceId: bad,
        fetchTraffic: async () => {
          called = true;
          return summary();
        },
      });
      expect(called).toBe(false);
      expect(r.status).toBe("no-workspace");
    }
  });

  test("空数据：接口成功但全 0 → empty（空态，不是报错）", async () => {
    const r = await loadDashboardTraffic({
      workspaceId: 7,
      fetchTraffic: async () =>
        summary({
          by_tunnel: [],
          by_day: [day(28, 0), day(29, 0)],
        }),
    });
    expect(r.status).toBe("empty");
    // 空态仍然返回序列长度（图表需要稳定点数，页面据 status 决定文案）
    expect(r.points).toHaveLength(2);
    expect(r.message).toBeNull();
  });

  test("接口失败：status=error + 可展示消息，且不返回半个摘要", async () => {
    const r = await loadDashboardTraffic({
      workspaceId: 7,
      fetchTraffic: async () => {
        throw new Error("Request failed with status 403");
      },
    });
    expect(r.status).toBe("error");
    expect(r.message).toBe("Request failed with status 403");
    expect(r.summary).toBeNull();
    expect(r.points).toEqual([]);
  });

  test("非 Error 的失败（字符串/裸对象）也有兜底消息", async () => {
    const r = await loadDashboardTraffic({
      workspaceId: 7,
      fetchTraffic: async () => {
        throw "boom";
      },
    });
    expect(r.status).toBe("error");
    expect(r.message).toBe("流量数据暂时不可用");
  });

  test("脏契约：by_day / by_tunnel 缺失时退化为空数组，不抛错", async () => {
    const r = await loadDashboardTraffic({
      workspaceId: 7,
      fetchTraffic: async () =>
        ({ workspace_id: 7, period: "total", total_traffic: 0 }) as unknown as WorkspaceTrafficSummary,
    });
    expect(r.status).toBe("empty");
    expect(r.points).toEqual([]);
    expect(r.tunnels).toEqual([]);
  });

  test("只有隧道排行没有日序列：仍算有数据（ok）", async () => {
    const r = await loadDashboardTraffic({
      workspaceId: 7,
      fetchTraffic: async () =>
        summary({
          by_tunnel: [
            { tunnel_id: 9, name: "x", tunnel_type: "tcp", in_node_group_id: 1, in_node_group_name: "g", traffic: 5, traffic_cost: 0 },
          ],
          by_day: [],
        }),
    });
    expect(r.status).toBe("ok");
    expect(r.tunnels).toHaveLength(1);
    expect(r.points).toEqual([]);
  });
});

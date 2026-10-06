/**
 * D5 —— mock 的**运行态端点**必须与真实后端同路、同形、同语义。
 *
 * 这个文件守的是「mock 存在的意义」那一类事实（同 `target-health-mock.test.ts`）：
 *
 *   1. **可达性**：`GET node/:id/state`（单数）在 mock 里必须真的存在并返回载荷。
 *      旧实现在 **复数** `/admin/nodes/:id/state` 上实现了它，于是本地/mock 永远
 *      看不到线上必然发生的 404 —— mock 骗人比缺实现更坏。
 *   2. **形状**：节点存在时**一律 200**：有上报 → 落库快照；从未上报 →
 *      `reported_at: null` 的空态视图（对齐 `services/node-admin-state.ts` 的
 *      `NodeStateView`），**不是 404、也不是 `null` 载荷**。节点不存在才是 404。
 *   3. **语义**：把 mock 的响应喂给客户端的三态映射函数，必须得到
 *      `reported`（有上报）与 `never_reported`（无上报）两种**不同**结果 ——
 *      这样「取不到」与「没有上报」在 mock 环境里也不会被混成一个值。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/node-runtime-state-mock.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import { nodeRuntimeStateFromPayload } from "@/lib/node-runtime-state";
import type { NodeStatePayload } from "@/lib/node-runtime-state";

const COOKIE = "tunex_session=u1"; // mock 演示用户（super_admin）
const call = <T>(method: string, path: string) =>
  handleMock(method, path, { cookie: COOKIE }) as Promise<{ status: number; body: T }>;

/** 种子：node 6 有状态上报；node 1 从未上报（`mocks/data.ts` 的 mockNodeStateReports）。 */
const REPORTED_NODE = 6;
const SILENT_NODE = 1;

beforeEach(() => {
  resetStore();
});

describe("mock：运行态端点的可达性与路径", () => {
  test("GET node/:id/state（单数）可达且 200", async () => {
    const res = await call<NodeStatePayload>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  test("复数 /admin/nodes/:id/state 不存在（后端也没有这条路由）", async () => {
    const res = await call<{ message?: string }>("GET", `admin/nodes/${REPORTED_NODE}/state`);
    expect(res.status).toBe(404);
  });

  test("节点不存在 → 404（不是在 200 里假装「没有上报」）", async () => {
    const res = await call<{ message?: string }>("GET", "admin/node/999999/state");
    expect(res.status).toBe(404);
  });

  test("按 node_id 字符串也能解析（与后端 resolveNodeId 同口径）", async () => {
    const res = await call<NodeStatePayload>("GET", "admin/node/hk-in-01/state");
    expect(res.status).toBe(200);
    expect(res.body.node_id).toBe(SILENT_NODE);
  });
});

describe("mock：有上报 = 落库快照；没有上报 = 200 空态视图", () => {
  test("有上报：reported_at 是可解析时刻（快照原样）", async () => {
    const { status, body } = await call<NodeStatePayload>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(status).toBe(200);
    expect(typeof body.reported_at).toBe("string");
    expect(Number.isFinite(Date.parse(body.reported_at!))).toBe(true);
    expect(body.version).toBe("1.8.4");
    expect(Array.isArray(body.used_ports)).toBe(true);
    expect(body.egress_pools).toBeTruthy();
  });

  test("没有上报：200 + 空态视图（字段逐个对齐后端 NodeStateView，绝不是 null）", async () => {
    const { status, body } = await call<NodeStatePayload | null>("GET", `admin/node/${SILENT_NODE}/state`);
    expect(status).toBe(200);
    expect(body).not.toBeNull();
    const view = body as NodeStatePayload & {
      node_key: string;
      online: boolean;
      stale: boolean;
      capabilities: string[] | null;
      control_protocol_version: number | null;
    };
    expect(view.node_id).toBe(SILENT_NODE);
    expect(view.node_key).toBe("hk-in-01");
    expect(view.reported_at).toBeNull();
    expect(view.age_seconds).toBeNull();
    expect(view.reported_revision).toBeNull();
    expect(view.version).toBeNull();
    expect(view.last_error).toBeNull();
    expect(view.tunnels).toEqual([]);
    expect(view.used_ports).toEqual([]);
    expect(view.egress_pools).toEqual({});
    // 无快照 = 无新鲜证据（后端 `snapshot ? isStale : true`）
    expect(view.stale).toBe(true);
    // NULL 不等于空数组/空对象：这两个字段必须保持 null（老 Agent 没上报过）
    expect(view.capabilities).toBeNull();
    expect(view.control_protocol_version).toBeNull();
  });

  test("mock 的两种响应喂给客户端三态映射 → 分别是 reported / never_reported（不可混）", async () => {
    const reported = await call<NodeStatePayload>("GET", `admin/node/${REPORTED_NODE}/state`);
    const silent = await call<NodeStatePayload>("GET", `admin/node/${SILENT_NODE}/state`);
    expect(nodeRuntimeStateFromPayload(reported.body).status).toBe("reported");
    expect(nodeRuntimeStateFromPayload(silent.body).status).toBe("never_reported");
  });
});

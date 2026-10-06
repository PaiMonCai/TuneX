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

/* ================================================================== */
/* 键集恒等（P1-3）：**两个分支都**必须恰好是 NodeStateView 的 19 键      */
/* ================================================================== */

/**
 * `NodeStateView` 的键集（逐字抄自 `backend/src/services/node-admin-state.ts:11-35`）。
 *
 * 为什么钉**键集相等**而不是"包含某些键"：这条缺陷的原始形态正是"公共子集断言"——
 * 旧测试只检查两个分支**都有**的那些键，于是"有上报分支少了 10 个视图键、多了 10 个
 * 落库键"这件事在测试里完全看不见。键集相等才让 mock 的形状**真的**等于真机的形状。
 */
const NODE_STATE_VIEW_KEYS = [
  "age_seconds",
  "capabilities",
  "control_protocol_version",
  "egress_pools",
  "last_error",
  "last_seen_at",
  "node_id",
  "node_key",
  "online",
  "reported_at",
  "reported_revision",
  "reported_role",
  "role",
  "role_mismatch",
  "stale",
  "status",
  "tunnels",
  "used_ports",
  "version",
] as const;

describe("P1-3：state 端点的**两个分支**键集恒等于 NodeStateView（19 键）", () => {
  test("有上报（node 6）与从未上报（node 1）都是 19 键，且没有 undefined 值", async () => {
    for (const nodeId of [REPORTED_NODE, SILENT_NODE]) {
      const { status, body } = await call<Record<string, unknown>>("GET", `admin/node/${nodeId}/state`);
      expect(status).toBe(200);
      // 键集**顺序无关、数量相等**：多一个落库键少一个视图键都算失败
      expect(Object.keys(body).sort()).toEqual([...NODE_STATE_VIEW_KEYS]);
      // 键存在但值是 `undefined` 等于"这一格没投影"：JSON 会把它整个丢掉
      const undefinedKeys = Object.keys(body).filter((key) => body[key] === undefined);
      expect(undefinedKeys).toEqual([]);
    }
  });

  test("落库行独有的列**不得**出现（known_revision/hostname/host_metrics/… 端点不返回）", async () => {
    const { body } = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    for (const rowOnly of [
      "known_revision",
      "agent_started_at",
      "hostname",
      "os",
      "arch",
      "runtime_counts",
      "host_metrics",
      "error_count",
      "last_error_at",
      "updated_at",
    ]) {
      expect(Object.keys(body)).not.toContain(rowOnly);
    }
  });

  test("role（面板侧）与 reported_role（Agent 自报）是两个字段，不得并成一个", async () => {
    const { body } = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    // 种子：node.role="both"，上报行 role="both"（两值相等，但字段必须各自存在）
    expect(body.role).toBe("both");
    expect(body.reported_role).toBe("both");
    expect(typeof body.role_mismatch).toBe("boolean");
  });

  test("角色不一致：改一侧的值后 role_mismatch 变 true（大小写归一后比较）", async () => {
    const store = resetStore();
    const node = store.nodes.find((row) => row.id === REPORTED_NODE)!;
    const report = store.nodeStates.get(REPORTED_NODE)!;
    // Agent 自报 egress、面板认定 both ⇒ 不一致
    report.role = "EGRESS";
    const mismatch = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(mismatch.body.role_mismatch).toBe(true);
    expect(mismatch.body.reported_role).toBe("EGRESS");
    expect(mismatch.body.role).toBe("both");
    // 只差大小写 ⇒ 不算不一致（与后端 `isRoleMismatch` 同口径）
    report.role = "BOTH";
    const same = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(same.body.role_mismatch).toBe(false);
    // 一侧为空 ⇒ 不判不一致（"无法判定"不是"不一致"）
    report.role = null;
    const oneSided = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(oneSided.body.role_mismatch).toBe(false);
    expect(node.role).toBe("both");
  });

  test("age_seconds 与 stale 由 reported_at 推出，且 stale 与 online 互不替代", async () => {
    const store = resetStore();
    const report = store.nodeStates.get(REPORTED_NODE)!;
    // 新鲜快照（10 秒前）⇒ age≈10、stale=false
    report.reported_at = new Date(Date.now() - 10_000).toISOString();
    const fresh = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(fresh.body.age_seconds).toBeGreaterThanOrEqual(9);
    expect(fresh.body.age_seconds).toBeLessThanOrEqual(12);
    expect(fresh.body.stale).toBe(false);
    // 陈旧快照（超过后端阈值 300 秒）⇒ stale=true，但 online 仍由 node.status 决定
    report.reported_at = new Date(Date.now() - 400_000).toISOString();
    const stale = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(stale.body.stale).toBe(true);
    expect(stale.body.online).toBe(true);
    // 无快照 ⇒ age=null、stale=true（"没有新鲜证据"），而 online 与它无关
    report.reported_at = null as unknown as string;
    const noSnapshot = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(noSnapshot.body.age_seconds).toBeNull();
    expect(noSnapshot.body.stale).toBe(true);
    expect(noSnapshot.body.online).toBe(true);
  });

  test("capabilities：未上报保持 null，上报数组则原样透传（null ≠ []）", async () => {
    const store = resetStore();
    const report = store.nodeStates.get(REPORTED_NODE)! as Record<string, unknown>;
    report.capabilities = ["restart", "upgrade"];
    const withCaps = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(withCaps.body.capabilities).toEqual(["restart", "upgrade"]);
    report.capabilities = null;
    const noCaps = await call<Record<string, unknown>>("GET", `admin/node/${REPORTED_NODE}/state`);
    expect(noCaps.body.capabilities).toBeNull();
  });
});

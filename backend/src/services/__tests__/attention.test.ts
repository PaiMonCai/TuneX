/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard 待办聚合（`services/attention.ts`）。
 *
 * 覆盖的行为（全部离线，注入内存替身 + 注入重试谓词，不碰 DB/Redis）：
 *   A. 节点三类待办：等待安装（waiting）、管理态挡新业务（maintenance /
 *      disabled / retiring）、离线；且**互斥**、按「先解决最前置问题」排序
 *      （维护中的节点即使掉线也只报维护，不报「离线故障」）。
 *   B. 健康节点/已暂停转发不进清单（否则 Dashboard 永远一片红）。
 *   C. Forward 三类：apply_status=error（带 apply_error_code + 重试语义）、
 *      已 active 但 applied < desired（revision 落后）、pending/applying。
 *   D. 重试语义来自**注入的** isRetryable（生产是 scheduler.ts 的同一实现）：
 *      不可重试的错误（如 node_credential_missing）不得被标成可重试。
 *   E. summary 计数与 items 一致；排序确定；items 截断但 total 仍报全量。
 *   F. 静态守卫：本模块不复制判定 —— 源码里不出现 90s 窗口、status==="active"
 *      比较、生命周期白名单或自身维护的重试码表。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/attention.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectAttention, ATTENTION_MAX_ITEMS } from "../attention.ts";
import { CONNECTION_ONLINE_WINDOW_MS, NODE_LIFECYCLES } from "../node-lifecycle.ts";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const fresh = () => new Date(NOW.getTime() - 5_000);
const stale = () => new Date(NOW.getTime() - CONNECTION_ONLINE_WINDOW_MS - 1_000);

interface FakeNode {
  id: number;
  node_id: string;
  status?: string | null;
  lifecycle?: string | null;
  last_seen_at?: Date | null;
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

interface FakeForward {
  id: number;
  name: string;
  apply_status?: string | null;
  apply_error_code?: string | null;
  config_revision?: number | null;
  applied_revision?: number | null;
}

/** 一台「已安装、新鲜上报、正常使用中」的节点。 */
function okNode(over: Partial<FakeNode> = {}): FakeNode {
  return {
    id: 1,
    node_id: "hk-in-01",
    status: "active",
    lifecycle: "active",
    last_seen_at: fresh(),
    node_credential_hash: "a".repeat(64),
    credential_revoked: false,
    ...over,
  };
}

function dbWith(nodes: FakeNode[], forwards: FakeForward[] = []) {
  return {
    node: {
      async findMany() {
        return nodes;
      },
    },
    tunnel: {
      async findMany() {
        return forwards;
      },
    },
  };
}

/** 与 scheduler.ts 的 RETRYABLE 集合同形的测试替身（生产走真实 injection）。 */
const retryableFake = (code: string) => code !== "node_credential_missing";

function collect(nodes: FakeNode[], forwards: FakeForward[] = []) {
  return collectAttention(7, {
    db: dbWith(nodes, forwards) as never,
    now: () => NOW,
    isRetryable: retryableFake,
  });
}

describe("WP10 resource-family visibility", () => {
  for (const visibility of [{ nodes: false, forwards: true }, { nodes: true, forwards: false }, { nodes: false, forwards: false }]) {
    test(JSON.stringify(visibility), async () => {
      let nodeReads = 0; let forwardReads = 0;
      const result = await collectAttention(7, {
        db: {
          node: { findMany: async () => { nodeReads++; return [okNode({ node_credential_hash: null })]; } },
          tunnel: { findMany: async () => { forwardReads++; return [{ id: 42, name: "private", apply_status: "error" }]; } },
        } as never,
        now: () => NOW, isRetryable: retryableFake,
      }, visibility);
      expect(nodeReads).toBe(visibility.nodes ? 1 : 0);
      expect(forwardReads).toBe(visibility.forwards ? 1 : 0);
      expect(result.items.some((item) => item.kind === "node")).toBe(visibility.nodes);
      expect(result.items.some((item) => item.kind === "forward")).toBe(visibility.forwards);
    });
  }
});

describe("A. 节点待办：三类且互斥", () => {
  test("无凭据 → node_waiting_install（warning，下一步是去安装）", async () => {
    const { items, summary } = await collect([okNode({ node_credential_hash: null })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "node",
      id: 1,
      name: "hk-in-01",
      severity: "warning",
      reason_code: "node_waiting_install",
      retryable: null,
    });
    expect(summary.nodes_waiting_install).toBe(1);
    expect(summary.nodes_offline).toBe(0);
  });

  test("maintenance / disabled / retiring → 管理态码，severity=info（不是故障）", async () => {
    const { items, summary } = await collect([
      okNode({ id: 1, node_id: "n-maint", lifecycle: "maintenance" }),
      okNode({ id: 2, node_id: "n-dis", lifecycle: "disabled" }),
      okNode({ id: 3, node_id: "n-ret", lifecycle: "retiring" }),
    ]);
    expect(items.map((i) => i.reason_code)).toEqual([
      "node_in_maintenance",
      "node_disabled",
      "node_retiring",
    ]);
    expect(items.every((i) => i.severity === "info")).toBe(true);
    expect(summary.nodes_restricted).toBe(3);
    expect(summary.nodes_offline).toBe(0);
  });

  test("维护中的节点即使掉线也只报管理态（不把预期关机报成离线故障）", async () => {
    const { items, summary } = await collect([
      okNode({ lifecycle: "maintenance", last_seen_at: stale() }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].reason_code).toBe("node_in_maintenance");
    expect(summary.nodes_offline).toBe(0);
    expect(summary.nodes_restricted).toBe(1);
  });

  test("已装但心跳超窗 → connection_offline（warning）", async () => {
    const { items, summary } = await collect([okNode({ last_seen_at: stale() })]);
    expect(items[0]).toMatchObject({ reason_code: "connection_offline", severity: "warning" });
    expect(summary.nodes_offline).toBe(1);
  });

  test("凭据已撤销 → offline（不是 waiting）", async () => {
    const { items } = await collect([okNode({ credential_revoked: true })]);
    expect(items[0].reason_code).toBe("connection_offline");
  });

  test("waiting 优先于 lifecycle 拒绝（先安装，再谈管理态）", async () => {
    const { items } = await collect([okNode({ node_credential_hash: null, lifecycle: "disabled" })]);
    expect(items[0].reason_code).toBe("node_waiting_install");
  });
});

describe("B. 健康节点不进清单", () => {
  test("在线 + active + 有凭据 → 没有待办", async () => {
    const { items, total, summary } = await collect([okNode()]);
    expect(items).toEqual([]);
    expect(total).toBe(0);
    expect(summary).toEqual({
      nodes_offline: 0,
      nodes_waiting_install: 0,
      nodes_restricted: 0,
      forwards_error: 0,
      forwards_pending: 0,
    });
  });

  test("suspended 是用户主动暂停，不是待办", async () => {
    const { items } = await collect([okNode()], [
      { id: 9, name: "paused", apply_status: "suspended" },
    ]);
    expect(items).toEqual([]);
  });
});

describe("C. Forward 待办", () => {
  test("apply_status=error → forward_apply_error + 错误码 + 重试结论", async () => {
    const { items, summary } = await collect([okNode()], [
      { id: 11, name: "web", apply_status: "error", apply_error_code: "ingress_ack_failed" },
    ]);
    expect(items[0]).toMatchObject({
      kind: "forward",
      id: 11,
      name: "web",
      severity: "error",
      reason_code: "forward_apply_error",
      apply_error_code: "ingress_ack_failed",
      retryable: true,
    });
    expect(summary.forwards_error).toBe(1);
  });

  test("不可自愈的错误码 → retryable=false（否则会给一个注定无效的重试按钮）", async () => {
    const { items } = await collect([okNode()], [
      { id: 12, name: "locked", apply_status: "error", apply_error_code: "node_credential_missing" },
    ]);
    expect(items[0].retryable).toBe(false);
  });

  test("没有错误码的失败 → retryable=null（不猜）", async () => {
    const { items } = await collect([okNode()], [
      { id: 13, name: "opaque", apply_status: "error", apply_error_code: null },
    ]);
    expect(items[0].retryable).toBeNull();
  });

  test("active 但 applied < desired → runtime_revision_behind（warning）", async () => {
    const { items, summary } = await collect([okNode()], [
      { id: 14, name: "lag", apply_status: "active", config_revision: 5, applied_revision: 3 },
    ]);
    expect(items[0]).toMatchObject({ reason_code: "runtime_revision_behind", severity: "warning" });
    expect(summary.forwards_pending).toBe(1);
  });

  test("active 且 applied == desired → 不进清单（收敛完成）", async () => {
    const { items } = await collect([okNode()], [
      { id: 15, name: "synced", apply_status: "active", config_revision: 5, applied_revision: 5 },
    ]);
    expect(items).toEqual([]);
  });

  test("pending / applying → forward_pending_apply（info：还在下发，不用动手）", async () => {
    const { items, summary } = await collect([okNode()], [
      { id: 16, name: "p", apply_status: "pending" },
      { id: 17, name: "a", apply_status: "applying" },
    ]);
    expect(items.map((i) => i.reason_code)).toEqual([
      "forward_pending_apply",
      "forward_pending_apply",
    ]);
    expect(summary.forwards_pending).toBe(2);
  });
});

describe("E. 排序、计数与截断", () => {
  test("顺序确定：severity（error→warning→info）→ kind（node 先）→ id", async () => {
    const { items } = await collect(
      [
        okNode({ id: 3, node_id: "offline", last_seen_at: stale() }),
        okNode({ id: 4, node_id: "maint", lifecycle: "maintenance" }),
      ],
      [
        { id: 5, name: "failed", apply_status: "error", apply_error_code: "ingress_ack_failed" },
        { id: 6, name: "pending", apply_status: "pending" },
      ],
    );
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      "forward:5", // error
      "node:3", // warning（node 先于同级的 forward）
      "node:4", // info
      "forward:6", // info
    ]);
  });

  test("summary 与 items 同源；total = 命中全量，items 截断到上限", async () => {
    const many = Array.from({ length: ATTENTION_MAX_ITEMS + 5 }, (_, i) =>
      okNode({ id: i + 1, node_id: `off-${i + 1}`, last_seen_at: stale() }),
    );
    const { items, total, summary } = await collect(many);
    expect(total).toBe(ATTENTION_MAX_ITEMS + 5);
    expect(items).toHaveLength(ATTENTION_MAX_ITEMS);
    expect(summary.nodes_offline).toBe(ATTENTION_MAX_ITEMS + 5);
  });

  test("generated_at 用注入的时刻，不读真实时钟", async () => {
    const { generated_at } = await collect([]);
    expect(generated_at).toBe(NOW.toISOString());
  });
});

/* ================================================================== */
/* 静态守卫：聚合层不复制判定                                          */
/* ================================================================== */

const raw = readFileSync(new URL("../attention.ts", import.meta.url), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/**
 * 节点段落（`nodeAttention` 起、到 Forward 段落前）—— 在线/准入判定只允许出现在
 * 这里，且必须经由 `deriveConnection` / `nodeAdmission`。Forward 段落里的
 * `apply_status === "active"` 是**另一个域**（转发下发状态），不属于本守卫。
 */
const nodeSection = code.slice(0, code.indexOf("function forwardAttention"));

describe("F. 静态守卫：待办判定复用既有实现", () => {
  test("调用 deriveConnection 与 nodeAdmission（不自己判在线/准入）", () => {
    expect(code).toContain("deriveConnection(");
    expect(code).toContain("nodeAdmission(");
  });

  test("不出现 90s 在线窗口阈值", () => {
    expect(code).not.toMatch(/90_?000|CONNECTION_ONLINE_WINDOW_MS/);
  });

  test("节点段落不出现 status === \"active\" 形式的在线判据", () => {
    expect(nodeSection.length).toBeGreaterThan(0);
    expect(nodeSection).not.toMatch(/status\s*===\s*["']active["']/);
  });

  test("不自己维护重试码表（重试语义只有一个来源：scheduler.ts 的 isRetryable）", () => {
    // 出现任何具体 scheduler 错误码字面量即说明在本地复制了 RETRYABLE 判定。
    expect(code).not.toMatch(/ingress_ack_failed|egress_ack_failed|port_allocation_failed/);
    expect(code).toContain("isRetryable");
  });

  test("生命周期取值不以白名单形式出现（判定权在 node-lifecycle.ts）", () => {
    // `"active"` 只允许作为「列缺省」出现（历史行/旧 fixture 无 lifecycle 列时）；
    // 其余三个取值完全不得以 lifecycle 值的形式出现在本模块。
    for (const lifecycle of NODE_LIFECYCLES.filter((v) => v !== "active")) {
      expect(code).not.toContain(`"${lifecycle}"`);
    }
    // node_in_maintenance / node_disabled / node_retiring 是准入**拒绝码**，
    // 属于本层需要分流的输出，允许出现（但必须是码，不是 lifecycle 值）。
    expect(code).toContain("node_in_maintenance");
  });
});

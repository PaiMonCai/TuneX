/**
 * V4-WP5 — Node lifecycle 离线测试（不连 MySQL / Redis / 网络）。
 *
 * 依据 `DEVELOPMENT.md` §13.4。验收口径：
 *   1. **三层状态不复用一列**：lifecycle 与 legacy status 是两个正交维度；
 *   2. **迁移白名单**：retiring 是单向门（→ 任意拒绝）、disabled → maintenance
 *      拒绝、同值幂等；
 *   3. **准入谓词唯一**：`nodeAdmission` 一处判定，connection=waiting 优先于
 *      lifecycle 拒绝，且三种拒绝给**不同** code；
 *   4. **删除不级联**：六道闸门逐条缺失都有可读原因；lifecycle != retiring 时
 *      优先报 `node_not_retiring` 并仍附依赖清单；
 *   5. **角色收缩 impact**：BOTH→ingress 仍有 ingress Forward → 拒；
 *      端口区间收缩罩住 active 租约 → 拒并列出端口；
 *   6. **凭据哈希绝不外泄**：lifecycleView 只给布尔；响应体 JSON 不含哈希；
 *   7. **本层没有下发能力**：服务源码静态断言——不 import socket/*、
 *      control-protocol/*、portPool，无 listen()/connect，不碰 redis。
 *
 * ── 替身设计 ──
 * `node-lifecycle.ts` 把 db 做成可注入（`LifecycleDeps`），每个函数都有
 * `inject?: LifecycleDeps`，所以**全部用例走参数注入**：不连库、不写
 * mock.module、也不依赖任何全局状态。
 *
 * 唯一需要 mock 的是模块顶层那句 `const defaultDb = db`（来自 `../db.ts`）：
 * 它在模块求值时求值一次，若指向真实 PrismaClient，一旦某条路径漏传 inject
 * 就会真的去连 MySQL。因此这里按 node-credential.test.ts 的同一模式，先
 * `mock.module("../../db.ts")` 再 `await import` 被测服务——`defaultDb`
 * 落到一个「任何调用都抛错」的哨兵上，漏传 inject 会立刻炸而不是静默连库。
 * 这与 Bun 的 mock.module 是进程级注册表这一事实共同决定：**同一个替身
 * 会被同进程后加载的文件看到**（routes/__tests__ 的 db 替身同理）。
 *
 * 替身复刻两条真实 Prisma 行为：
 *   · `node.update` / `node.delete` 对不存在的 id 抛 P2025；
 *   · `count` 只数真实匹配的行（released 租约不算 active）。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { LifecycleDb, LifecycleNodeRow, NodeImpact } from "../node-lifecycle.ts";
import { mockDb, resetLifecycleStub } from "../../__tests__/lifecycle-db-stub.ts";

// mock.module 必须在本文件引用被测模块**之前**注册才会生效：ESM 的提升语义
// 会把静态 import hoist 到文件顶部，所以这里不能静态 import 被测服务，改用
// "先 mock，再 await import" 的顺序（与 node-credential.test.ts 同一模式）。
//
// 替身来自共享模块 `src/__tests__/lifecycle-db-stub.ts`：同进程内
// routes/__tests__ 注册的是同一个对象，谁先注册都不会把对方的用例打挂。
// 本文件的用例全部走参数 `inject`，所以这个 mock 只是兜住模块顶层那句
// `const defaultDb = db`——它不该被调用；真被调用会落到空壳模型上。
mockDb();

const lifecycle = await import("../node-lifecycle.ts");

const {
  NODE_LIFECYCLES,
  acceptsNewBusiness,
  allowedTransitions,
  businessRejectionCode,
  canTransition,
  changeLifecycle,
  checkRoleChange,
  deleteGates,
  deleteNode,
  deriveConnection,
  emptyImpact,
  getNodeImpact,
  getNodeLifecycle,
  lifecycleAcceptsBusiness,
  lifecycleView,
  listActiveLeasePorts,
  nodeAdmission,
  parseLifecycle,
  parseLifecycleNote,
  portRangeWouldOrphan,
  LIFECYCLE_ERROR_STATUS,
} = lifecycle;

/* ------------------------------------------------------------------ */
/* 内存 DB 替身                                                        */
/* ------------------------------------------------------------------ */

let nodes = new Map<number, LifecycleNodeRow>();
let tunnelRows: Array<{ id: number; ingress_node_id: number | null; egress_node_id: number | null }> = [];
let bindingRows: Array<{ id: number; ingress_node_id: number; egress_node_id: number }> = [];
let leaseRows: Array<{ id: number; node_id: number; port: number; status: string }> = [];
let poolRows: Array<{ id: number; node_id: number }> = [];

function resetState(): void {
  nodes = new Map();
  tunnelRows = [];
  bindingRows = [];
  leaseRows = [];
  poolRows = [];
}

function prismaNotFound(): Error {
  const e = new Error("Record to delete does not exist.");
  (e as Error & { code: string }).code = "P2025";
  return e;
}

function seedNode(over: Partial<LifecycleNodeRow> = {}): LifecycleNodeRow {
  const id = nodes.size + 1;
  const row: LifecycleNodeRow = {
    id,
    node_id: `node-${id}`,
    role: "both",
    status: "active",
    lifecycle: "active",
    last_seen_at: NOW,
    port_range_min: null,
    port_range_max: null,
    node_credential_hash: "a".repeat(64),
    credential_revoked: false,
    lifecycle_note: null,
    lifecycle_updated_at: null,
    ...over,
  };
  nodes.set(id, row);
  return row;
}

/** 固定「现在」，让 90s 在线窗口可预测。 */
const NOW = new Date("2026-09-27T00:00:00.000Z");

function deps() {
  return { db: makeDb(), now: () => NOW };
}

/** 复刻 count / findMany 的最小投影（只数真实匹配的行）。 */
function makeDb(): LifecycleDb {
  return {
    node: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        const row = nodes.get(where.id as number) ?? null;
        return row ? { ...row } : null;
      },
      async findFirst() {
        return nodes.size > 0 ? { ...[...nodes.values()][0] } : null;
      },
      async findMany({ where }: { where?: Record<string, unknown> } = {}) {
        let rows = [...nodes.values()];
        if (where?.lifecycle !== undefined) {
          rows = rows.filter((n) => n.lifecycle === where.lifecycle);
        }
        return rows.map((r) => ({ ...r }));
      },
      async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
        const row = nodes.get(where.id);
        if (!row) throw prismaNotFound();
        Object.assign(row, data);
        return { ...row };
      },
      async delete({ where }: { where: { id: number } }) {
        if (!nodes.has(where.id)) throw prismaNotFound();
        nodes.delete(where.id);
        return {};
      },
    },

    tunnel: {
      async count({ where }: { where: Record<string, unknown> }) {
        if (where?.ingress_node_id !== undefined) {
          return tunnelRows.filter((t) => t.ingress_node_id === where.ingress_node_id).length;
        }
        if (where?.egress_node_id !== undefined) {
          return tunnelRows.filter((t) => t.egress_node_id === where.egress_node_id).length;
        }
        return tunnelRows.length;
      },
      async findMany() {
        return tunnelRows.map((t) => ({ ...t }));
      },
    },

    nodeBinding: {
      async count({ where }: { where: Record<string, unknown> }) {
        const or = (where?.OR ?? []) as Array<{ ingress_node_id?: number; egress_node_id?: number }>;
        return bindingRows.filter((b) =>
          or.some((c) => b.ingress_node_id === c.ingress_node_id || b.egress_node_id === c.egress_node_id),
        ).length;
      },
      async findMany() {
        return bindingRows.map((b) => ({ ...b }));
      },
    },

    nodePortLease: {
      async count({ where }: { where: Record<string, unknown> }) {
        return leaseRows.filter((l) => l.node_id === where.node_id && l.status === where.status).length;
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        return leaseRows
          .filter((l) => l.node_id === where.node_id && l.status === where.status)
          .map((l) => ({ ...l }));
      },
    },

    egressPool: {
      async count({ where }: { where: Record<string, unknown> }) {
        return poolRows.filter((p) => p.node_id === where.node_id).length;
      },
    },
  };
}

beforeEach(() => {
  resetState();
});

/* ================================================================== */
/* 入参解析                                                            */
/* ================================================================== */

describe("parseLifecycle", () => {
  test("四种合法值（大小写/空白归一化）", () => {
    for (const v of NODE_LIFECYCLES) {
      const r = parseLifecycle(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(v);
    }
    const r = parseLifecycle("  Maintenance ");
    expect(r.ok && r.value).toBe("maintenance");
  });

  test("undefined / null / 空串 = 未指定（本次不动），不报错", () => {
    for (const v of [undefined, null, "", "   "]) {
      const r = parseLifecycle(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeNull();
    }
  });

  test("未知值 → 拒绝（fail-closed）", () => {
    for (const v of ["retired", true, 3, {}, [], "MAINTENANCE!"]) {
      expect(parseLifecycle(v).ok).toBe(false);
    }
    // "active " 是**合法**的：trim + lowercase 后命中
    expect(parseLifecycle("active ").ok).toBe(true);
  });
});

describe("parseLifecycleNote", () => {
  test("可选：缺失 → null，空串 → null，trim 保留内容", () => {
    expect(parseLifecycleNote(undefined)).toEqual({ ok: true, value: null });
    expect(parseLifecycleNote(null)).toEqual({ ok: true, value: null });
    expect(parseLifecycleNote("")).toEqual({ ok: true, value: null });
    expect(parseLifecycleNote(" 磁盘维护 ")).toEqual({ ok: true, value: "磁盘维护" });
  });

  test("非字符串 / 超长 → 拒绝", () => {
    expect(parseLifecycleNote(7).ok).toBe(false);
    expect(parseLifecycleNote("x".repeat(256)).ok).toBe(false);
  });
});

/* ================================================================== */
/* 迁移白名单                                                          */
/* ================================================================== */

describe("canTransition — 迁移白名单（§13.4.2）", () => {
  test("active ↔ maintenance 双向", () => {
    expect(canTransition("active", "maintenance")).toBe(true);
    expect(canTransition("maintenance", "active")).toBe(true);
  });

  test("retiring 是单向门：→ 任意一律拒绝", () => {
    for (const to of NODE_LIFECYCLES) {
      expect(canTransition("retiring", to)).toBe(to === "retiring");
    }
  });

  test("disabled → maintenance 拒绝（语义无意义），disabled → active 允许", () => {
    expect(canTransition("disabled", "maintenance")).toBe(false);
    expect(canTransition("disabled", "active")).toBe(true);
    expect(canTransition("disabled", "retiring")).toBe(true);
  });

  test("maintenance → disabled / retiring 允许（不要求先退出维护）", () => {
    expect(canTransition("maintenance", "disabled")).toBe(true);
    expect(canTransition("maintenance", "retiring")).toBe(true);
  });

  test("active → 全四态允许（含直接退役）", () => {
    for (const to of NODE_LIFECYCLES) expect(canTransition("active", to)).toBe(true);
  });

  test("同值迁移合法（幂等保存）", () => {
    for (const v of NODE_LIFECYCLES) expect(canTransition(v, v)).toBe(true);
  });

  test("未知来源/目标 → 拒绝（fail-closed）", () => {
    expect(canTransition("bogus", "active")).toBe(false);
    expect(canTransition("active", "bogus")).toBe(false);
    expect(canTransition(null, "active")).toBe(false);
    expect(canTransition(undefined, "active")).toBe(false);
  });
});

describe("allowedTransitions", () => {
  test("retiring 的可用目标只有自己（UI 应隐藏迁移按钮，只留删除）", () => {
    expect(allowedTransitions("retiring")).toEqual(["retiring"]);
  });

  test("active 的可用目标含全部四态", () => {
    expect([...allowedTransitions("active")].sort()).toEqual([...NODE_LIFECYCLES].sort());
  });

  test("disabled 的目标 = {active, disabled, retiring}（不含 maintenance）", () => {
    expect([...allowedTransitions("disabled")].sort()).toEqual(["active", "disabled", "retiring"]);
  });

  test("未知来源 → 空数组（前端据此禁用按钮）", () => {
    expect(allowedTransitions("bogus")).toEqual([]);
    expect(allowedTransitions(null)).toEqual([]);
  });
});

/* ================================================================== */
/* 准入谓词（三层状态之 Lifecycle 维度）                                 */
/* ================================================================== */

describe("lifecycle 维度的准入判断", () => {
  test("只有 active 接受新业务", () => {
    expect(lifecycleAcceptsBusiness("active")).toBe(true);
    for (const v of ["maintenance", "disabled", "retiring"] as const) {
      expect(lifecycleAcceptsBusiness(v)).toBe(false);
    }
    // fail-closed：未知/缺失一律不接受
    expect(lifecycleAcceptsBusiness("bogus")).toBe(false);
    expect(lifecycleAcceptsBusiness(null)).toBe(false);
  });

  test("每种拒绝态给不同 code（§13.5：错误码必须有区分度）", () => {
    expect(businessRejectionCode("maintenance")).toBe("node_in_maintenance");
    expect(businessRejectionCode("disabled")).toBe("node_disabled");
    expect(businessRejectionCode("retiring")).toBe("node_retiring");
    // 未知值按 disabled 处理（fail-closed）
    expect(businessRejectionCode("bogus")).toBe("node_disabled");
    expect(businessRejectionCode(null)).toBe("node_disabled");
    // active 不产生拒绝码，但也返回一个 fail-closed 值（调用方需先用
    // lifecycleAcceptsBusiness 判，不能只看 code 判断）
    expect(businessRejectionCode("active")).toBe("node_disabled");
  });
});

/** 在线节点的基础输入（有凭据 + 刚上报 + status=active）。 */
const ONLINE = {
  status: "active",
  last_seen_at: NOW,
  has_credential: true,
  credential_revoked: false,
  now: NOW,
};

describe("deriveConnection — 连接态（节点/凭据 推导，非新列）", () => {
  test("无凭据 = waiting（等待安装）", () => {
    expect(deriveConnection({ ...ONLINE, has_credential: false })).toBe("waiting");
  });

  test("有凭据 + status=active + 最近上报 = online", () => {
    expect(deriveConnection(ONLINE)).toBe("online");
  });

  test("超窗（>90s）= offline", () => {
    const stale = new Date(NOW.getTime() - 91_000);
    expect(deriveConnection({ ...ONLINE, last_seen_at: stale })).toBe("offline");
  });

  test("窗口边界恰好 90s 仍算 online（> 才离线）", () => {
    const edge = new Date(NOW.getTime() - 90_000);
    expect(deriveConnection({ ...ONLINE, last_seen_at: edge })).toBe("online");
  });

  test("从未上报 = offline（不是 waiting：凭据已说明它装过）", () => {
    expect(deriveConnection({ ...ONLINE, last_seen_at: null })).toBe("offline");
  });

  test("已撤销凭据 = offline（主动断开，不是还在等安装）", () => {
    expect(deriveConnection({ ...ONLINE, credential_revoked: true })).toBe("offline");
  });

  test("status=inactive（offline-detector 翻的）= offline", () => {
    expect(deriveConnection({ ...ONLINE, status: "inactive" })).toBe("offline");
  });

  test("status=inactive 但无凭据 = waiting（安装态优先于健康态）", () => {
    expect(deriveConnection({ ...ONLINE, status: "inactive", has_credential: false })).toBe("waiting");
  });
});

describe("nodeAdmission — lifecycle 与 connection 两个维度都给拒绝码", () => {
  test("active lifecycle + online = 准入", () => {
    expect(nodeAdmission({ ...ONLINE, lifecycle: "active" }).ok).toBe(true);
    expect(acceptsNewBusiness({ ...ONLINE, lifecycle: "active" })).toBe(true);
  });

  test("waiting 优先于 lifecycle 拒绝：节点没装好，谈不到维护状态", () => {
    const r = nodeAdmission({ ...ONLINE, has_credential: false, lifecycle: "maintenance" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.condition).toBe("node_waiting_install");
  });

  test("三种拒绝 lifecycle 给三个不同 code（不复用『操作失败』）", () => {
    const codes = (["maintenance", "disabled", "retiring"] as const).map((lifecycle) => {
      const r = nodeAdmission({ ...ONLINE, lifecycle });
      return r.ok ? "ok" : r.condition;
    });
    expect(codes).toEqual(["node_in_maintenance", "node_disabled", "node_retiring"]);
  });

  test("offline 的 active 节点仍然准入——连接态不是准入条件，只是状态", () => {
    expect(nodeAdmission({ ...ONLINE, status: "inactive", lifecycle: "active" }).ok).toBe(true);
  });
});

/* ================================================================== */
/* impact / delete gates                                               */
/* ================================================================== */

describe("portRangeWouldOrphan", () => {
  test("无目标区间 = 不判定（null 整体或端点 null）", () => {
    expect(portRangeWouldOrphan(null, [80, 443])).toEqual([]);
    expect(portRangeWouldOrphan({ min: null, max: 20000 }, [80])).toEqual([]);
    expect(portRangeWouldOrphan({ min: 10000, max: null }, [99999])).toEqual([]);
  });

  test("区间外端口被列出；区间内（含端点）不列", () => {
    expect(portRangeWouldOrphan({ min: 10000, max: 20000 }, [80, 10000, 20000, 20001])).toEqual([80, 20001]);
  });

  test("区间外端口按输入顺序列出（不去重：端口唯一约束下重复输入=重复计数）", () => {
    expect(portRangeWouldOrphan({ min: 10000, max: 20000 }, [20001, 80, 20001])).toEqual([20001, 80, 20001]);
  });
});

describe("deleteGates — 六道闸门（§13.4.3 永不级联删除 Forward）", () => {
  test("retiring + 无依赖 → 通过", () => {
    expect(deleteGates({ lifecycle: "retiring", impact: emptyImpact() }).ok).toBe(true);
  });

  test("未退役 → node_not_retiring（优先于依赖检查，仍附依赖清单）", () => {
    const r = deleteGates({ lifecycle: "active", impact: { ...emptyImpact(), ingress_forward_count: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.condition).toBe("node_not_retiring");
      expect(r.dependencies.ingress_forward_count).toBe(5);
    }
  });

  test("仍有入口 Forward → node_still_used_as_ingress", () => {
    const r = deleteGates({ lifecycle: "retiring", impact: { ...emptyImpact(), ingress_forward_count: 2 } });
    if (!r.ok) expect(r.condition).toBe("node_still_used_as_ingress");
  });

  test("仍有出口 Forward → node_still_used_as_egress", () => {
    const r = deleteGates({ lifecycle: "retiring", impact: { ...emptyImpact(), egress_forward_count: 1 } });
    if (!r.ok) expect(r.condition).toBe("node_still_used_as_egress");
  });

  test("入口优先于出口（先报更根本的问题）", () => {
    const r = deleteGates({
      lifecycle: "retiring",
      impact: { ...emptyImpact(), ingress_forward_count: 1, egress_forward_count: 1 },
    });
    if (!r.ok) expect(r.condition).toBe("node_still_used_as_ingress");
  });

  test("binding / active 租约 / 出口池任一不为空 → dependency_blocked", () => {
    for (const key of ["binding_count", "active_port_lease_count", "egress_pool_count"] as const) {
      const r = deleteGates({ lifecycle: "retiring", impact: { ...emptyImpact(), [key]: 3 } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.condition).toBe("dependency_blocked");
        expect(r.dependencies[key]).toBe(3);
      }
    }
  });

  test("Forward 优先于其余依赖（用户的数据先讲）", () => {
    const r = deleteGates({
      lifecycle: "retiring",
      impact: { ...emptyImpact(), egress_forward_count: 1, binding_count: 9 },
    });
    if (!r.ok) expect(r.condition).toBe("node_still_used_as_egress");
  });
});

describe("checkRoleChange — §13.4.3 impact check", () => {
  test("BOTH → ingress 但仍有出口 Forward → 阻止并带条数", () => {
    const r = checkRoleChange({
      node: { id: 1, role: "both" },
      impact: { ...emptyImpact(), egress_forward_count: 2 },
      check: { nextRole: "ingress" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.condition).toBe("node_still_used_as_egress");
      expect(r.message).toContain("2");
    }
  });

  test("BOTH → egress 但仍有入口 Forward → 阻止", () => {
    const r = checkRoleChange({
      node: { id: 1, role: "both" },
      impact: { ...emptyImpact(), ingress_forward_count: 1 },
      check: { nextRole: "egress" },
    });
    if (!r.ok) expect(r.condition).toBe("node_still_used_as_ingress");
  });

  test("干净时可降级（both → ingress / egress）", () => {
    for (const nextRole of ["ingress", "egress"] as const) {
      expect(
        checkRoleChange({ node: { id: 1, role: "both" }, impact: emptyImpact(), check: { nextRole } }).ok,
      ).toBe(true);
    }
  });

  test("升级（ingress → both）不触发任何阻塞", () => {
    expect(
      checkRoleChange({
        node: { id: 1, role: "ingress" },
        impact: { ...emptyImpact(), ingress_forward_count: 3 },
        check: { nextRole: "both" },
      }).ok,
    ).toBe(true);
  });

  test("nextRole 缺失 = 本次不改角色（沿用当前 role 判定）", () => {
    expect(
      checkRoleChange({
        node: { id: 1, role: "both" },
        impact: { ...emptyImpact(), egress_forward_count: 9 },
        check: {},
      }).ok,
    ).toBe(true);
    // both 保持 both：不丢能力，不阻塞
    expect(
      checkRoleChange({
        node: { id: 1, role: "ingress" },
        impact: { ...emptyImpact(), ingress_forward_count: 9 },
        check: {},
      }).ok,
    ).toBe(true);
  });

  test("nextRole=null（本次不改角色）不判角色阻塞", () => {
    expect(
      checkRoleChange({
        node: { id: 1, role: "both" },
        impact: { ...emptyImpact(), egress_forward_count: 9 },
        check: { nextRole: null },
      }).ok,
    ).toBe(true);
  });

  test("端口区间收缩罩住 active 租约 → 阻止并列出端口", () => {
    const r = checkRoleChange({
      node: { id: 1, role: "both" },
      impact: emptyImpact(),
      check: { nextPortRange: { min: 10000, max: 20000 }, activeLeasePorts: [9999, 10001] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.condition).toBe("port_range_would_orphan_leases");
      expect(r.message).toContain("9999");
    }
  });

  test("未配置端口区间（两端 null）= 不判定悬空", () => {
    expect(
      checkRoleChange({
        node: { id: 1, role: "both" },
        impact: emptyImpact(),
        check: { nextPortRange: { min: null, max: null }, activeLeasePorts: [80] },
      }).ok,
    ).toBe(true);
    expect(
      checkRoleChange({
        node: { id: 1, role: "both" },
        impact: emptyImpact(),
        check: { activeLeasePorts: [80] },
      }).ok,
    ).toBe(true);
  });
});

/* ================================================================== */
/* impact 统计（where 语义）                                            */
/* ================================================================== */

describe("getNodeImpact", () => {
  test("五类计数各取各的维度（tunnel 两侧 / binding 两侧 / active 租约 / 池）", async () => {
    const node = seedNode();
    // findUnique 只返回第一行，因此这里必须只有这一个节点。
    tunnelRows = [
      { id: 1, ingress_node_id: node.id, egress_node_id: null },
      { id: 2, ingress_node_id: node.id, egress_node_id: 999 },
      { id: 3, ingress_node_id: 999, egress_node_id: node.id },
      { id: 4, ingress_node_id: 999, egress_node_id: 999 },
    ];
    bindingRows = [
      { id: 1, ingress_node_id: node.id, egress_node_id: 999 },
      { id: 2, ingress_node_id: 999, egress_node_id: 999 },
    ];
    leaseRows = [
      { id: 1, node_id: node.id, port: 10001, status: "active" },
      { id: 2, node_id: node.id, port: 10002, status: "released" },
      { id: 3, node_id: 999, port: 10003, status: "active" },
    ];
    poolRows = [{ id: 1, node_id: node.id }, { id: 2, node_id: 999 }];

    const r = await getNodeImpact(node.id, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.impact.ingress_forward_count).toBe(2);
    expect(r.impact.egress_forward_count).toBe(1);
    expect(r.impact.binding_count).toBe(1); // 只算涉及它的
    expect(r.impact.active_port_lease_count).toBe(1); // released 不算
    expect(r.impact.egress_pool_count).toBe(1);
    expect(r.impact.blockers).toEqual([]);
  });

  test("节点不存在 → not_found", async () => {
    const r = await getNodeImpact(42, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("从未被引用的节点 → 全零 impact", async () => {
    const node = seedNode();
    const r = await getNodeImpact(node.id, deps());
    if (r.ok) expect(r.impact).toEqual(emptyImpact());
  });
});

describe("listActiveLeasePorts", () => {
  test("只取 active 的端口，按 DB 顺序原样返回", async () => {
    const node = seedNode();
    leaseRows = [
      { id: 1, node_id: node.id, port: 20001, status: "active" },
      { id: 2, node_id: node.id, port: 20002, status: "released" },
      { id: 3, node_id: node.id, port: 20003, status: "active" },
    ];
    expect(await listActiveLeasePorts(node.id, deps())).toEqual([20001, 20003]);
  });

  test("节点不存在 / 无 active 租约 → 空数组", async () => {
    expect(await listActiveLeasePorts(999, deps())).toEqual([]);
    const node = seedNode();
    leaseRows = [{ id: 1, node_id: node.id, port: 20001, status: "released" }];
    expect(await listActiveLeasePorts(node.id, deps())).toEqual([]);
  });
});

/* ================================================================== */
/* 写：生命周期变更                                                     */
/* ================================================================== */

describe("changeLifecycle", () => {
  test("active → maintenance 写入三个字段并回投影", async () => {
    const node = seedNode();
    const r = await changeLifecycle(node.id, { lifecycle: "maintenance", note: "磁盘维护" }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node.lifecycle).toBe("maintenance");
    expect(r.node.lifecycle_note).toBe("磁盘维护");
    expect(r.node.lifecycle_updated_at).toEqual(NOW);
    expect(r.view.lifecycle).toBe("maintenance");
    expect(r.view.accepts_new_business).toBe(false);
    expect(r.view.admission_rejection).toBe("node_in_maintenance");
  });

  test("maintenance → active 后恢复准入", async () => {
    const node = seedNode({ lifecycle: "maintenance" });
    const r = await changeLifecycle(node.id, { lifecycle: "active" }, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.view.accepts_new_business).toBe(true);
    expect(r.view.admission_rejection).toBeNull();
  });

  test("retiring → active 拒绝（单向门）并附合法目标", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const r = await changeLifecycle(node.id, { lifecycle: "active" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_state");
      expect(r.condition).toBe("invalid_transition");
      expect(r.message).toContain("retiring");
    }
  });

  test("disabled → maintenance 拒绝", async () => {
    const node = seedNode({ lifecycle: "disabled" });
    const r = await changeLifecycle(node.id, { lifecycle: "maintenance" }, deps());
    if (!r.ok) expect(r.condition).toBe("invalid_transition");
  });

  test("同值迁移合法（幂等保存：note 变了也写）", async () => {
    const node = seedNode({ lifecycle: "maintenance" });
    const r = await changeLifecycle(node.id, { lifecycle: "maintenance", note: "继续维护" }, deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.lifecycle).toBe("maintenance");
      expect(r.node.lifecycle_note).toBe("继续维护");
    }
  });

  test("lifecycle 键缺失 = 不改生命周期（幂等返回当前视图）", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const r = await changeLifecycle(node.id, { note: "备注" }, deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.lifecycle).toBe("retiring");
  });

  test("note 空串 = 显式清空（无 lifecycle 键时也走写入）", async () => {
    const node = seedNode({ lifecycle: "maintenance", lifecycle_note: "旧原因" });
    const cleared = await changeLifecycle(node.id, { note: "" }, deps());
    expect(cleared.ok).toBe(true);
    // 服务契约：`note !== undefined` 即写库（键缺失只动 lifecycle_note 也写），
    // 因此清空必须生效——否则用户无法去掉一条过期备注。
    if (cleared.ok) expect(cleared.node.lifecycle_note).toBeNull();
  });

  test("note 缺失 = 不动备注（null 不参与写入）", async () => {
    const node = seedNode({ lifecycle: "maintenance", lifecycle_note: "保留我" });
    const untouched = await changeLifecycle(node.id, {}, deps());
    expect(untouched.ok).toBe(true);
    if (untouched.ok) expect(untouched.node.lifecycle_note).toBe("保留我");
  });

  test("非法入参 → 400（不碰 DB）", async () => {
    const node = seedNode();
    const r = await changeLifecycle(node.id, { lifecycle: "bogus" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
    expect(nodes.get(node.id)!.lifecycle).toBe("active");
  });

  test("节点不存在 → 404", async () => {
    const r = await changeLifecycle(999, { lifecycle: "maintenance" }, deps());
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("update 抛 P2025 → 映射 not_found", async () => {
    const node = seedNode();
    // 第一次 changeLifecycle 之前删掉行，替身 update 会抛 P2025
    nodes.delete(node.id);
    const r = await changeLifecycle(node.id, { lifecycle: "maintenance" }, deps());
    if (!r.ok) expect(r.code).toBe("not_found");
  });
});

/* ================================================================== */
/* 写：物理删除                                                         */
/* ================================================================== */

describe("deleteNode", () => {
  test("未退役 → node_not_retiring，行不动", async () => {
    const node = seedNode({ lifecycle: "active" });
    const r = await deleteNode(node.id, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_state");
      expect(r.condition).toBe("node_not_retiring");
      expect(r.dependencies).toBeDefined();
    }
    expect(nodes.has(node.id)).toBe(true);
  });

  test("retiring + 干净 → 删除成功", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const r = await deleteNode(node.id, deps());
    expect(r.ok).toBe(true);
    expect(nodes.has(node.id)).toBe(false);
  });

  test("retiring + 仍有入口 Forward → 拒绝且不删行", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    tunnelRows = [{ id: 1, ingress_node_id: node.id, egress_node_id: null }];
    const r = await deleteNode(node.id, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("dependency_blocked");
    expect(nodes.has(node.id)).toBe(true);
  });

  test("retiring + 仍有绑定/租约/池 → DependencyBlocked 且不删行", async () => {
    for (const setup of [
      () => (bindingRows = [{ id: 1, ingress_node_id: 1, egress_node_id: 2 }]),
      () => (leaseRows = [{ id: 1, node_id: 1, port: 10001, status: "active" }]),
      () => (poolRows = [{ id: 1, node_id: 1 }]),
    ]) {
      resetState();
      const node = seedNode({ lifecycle: "retiring" });
      setup();
      const r = await deleteNode(node.id, deps());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("dependency_blocked");
        expect(r.dependencies).toBeDefined();
      }
      expect(nodes.has(node.id)).toBe(true);
    }
  });

  test("节点不存在 → 404", async () => {
    const r = await deleteNode(999, deps());
    if (!r.ok) expect(r.code).toBe("not_found");
  });
});

/* ================================================================== */
/* 投影：凭据纪律                                                       */
/* ================================================================== */

describe("lifecycleView — 哈希绝不外泄", () => {
  test("凭据只给布尔，投影里没有哈希字段", () => {
    const node = seedNode({ node_credential_hash: "f".repeat(64) });
    const view = lifecycleView(node, NOW);
    expect(view.has_credential).toBe(true);
    expect(JSON.stringify(view)).not.toContain("ffffffff");
    expect(Object.keys(view)).not.toContain("node_credential_hash");
  });

  test("视图不透出 lifecycle_note / 内部时间戳之外的敏感段", () => {
    const view = lifecycleView(seedNode({ node_credential_hash: "deadbeef" }), NOW);
    expect(Object.keys(view).sort()).toEqual([
      "accepts_new_business",
      "admission_rejection",
      "allowed_transitions",
      "connection",
      "credential_revoked",
      "has_credential",
      "id",
      "lifecycle",
      "node_id",
      "role",
    ]);
  });

  test("无凭据 → waiting + 拒绝码 node_waiting_install", () => {
    const node = seedNode({ node_credential_hash: null });
    const view = lifecycleView(node, NOW);
    expect(view.connection).toBe("waiting");
    expect(view.has_credential).toBe(false);
    expect(view.accepts_new_business).toBe(false);
    expect(view.admission_rejection).toBe("node_waiting_install");
  });

  test("offline 的 active 节点：accepts_new_business 仍为 true", () => {
    const node = seedNode({ status: "inactive", last_seen_at: new Date(NOW.getTime() - 600_000) });
    const view = lifecycleView(node, NOW);
    expect(view.connection).toBe("offline");
    expect(view.accepts_new_business).toBe(true);
  });

  test("allowed_transitions 随 lifecycle 变化", () => {
    expect(lifecycleView(seedNode({ lifecycle: "retiring" }), NOW).allowed_transitions).toEqual(["retiring"]);
    expect(lifecycleView(seedNode({ lifecycle: "disabled" }), NOW).allowed_transitions).toEqual([
      "active",
      "disabled",
      "retiring",
    ]);
  });
});

describe("getNodeLifecycle — 层与 node-admin.ts 解耦（只读投影）", () => {
  test("存在 → 视图；不存在 → not_found", async () => {
    const node = seedNode({ lifecycle: "maintenance" });
    const r = await getNodeLifecycle(node.id, deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.view.lifecycle).toBe("maintenance");
      expect(r.view.connection).toBe("online");
    }
    const miss = await getNodeLifecycle(999, deps());
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.code).toBe("not_found");
  });
});

describe("LIFECYCLE_ERROR_STATUS — 错误码 → HTTP 状态映射", () => {
  test("四类错误码各有唯一状态", () => {
    expect(LIFECYCLE_ERROR_STATUS).toEqual({
      invalid_input: 400,
      not_found: 404,
      invalid_state: 409,
      dependency_blocked: 409,
    });
  });
});

/* ================================================================== */
/* 边界：本层没有下发能力（与 node-admin.ts 同一纪律）                    */
/* ================================================================== */

describe("WP5 边界：只判 lifecycle，不做下发", () => {
  test("服务源码不 import socket / control-protocol / portPool", async () => {
    const src = await Bun.file(new URL("../node-lifecycle.ts", import.meta.url).pathname).text();
    expect(src).not.toMatch(/from "\.\.\/(socket|services\/control-protocol|services\/portPool)/);
    expect(src).not.toMatch(/configPusher|pushConfig|revision\+\+/);
    expect(src).not.toMatch(/\blisten\s*\(|new WebSocket|\.connect\(/);
  });

  test("只 export 函数与纯字面量常量，没有 Server / Transport 构造器", async () => {
    const mod = await import("../node-lifecycle.ts");
    for (const [name, exported] of Object.entries(mod)) {
      if (typeof exported === "function") continue;
      const isLiteral =
        typeof exported === "string" ||
        typeof exported === "number" ||
        (Array.isArray(exported) && exported.every((v) => typeof v === "string")) ||
        (typeof exported === "object" &&
          exported !== null &&
          Object.values(exported as Record<string, unknown>).every(
            (v) => typeof v === "number" || typeof v === "string",
          ));
      if (!isLiteral) throw new Error(`node-lifecycle exported non-literal ${name}`);
    }
  });
});

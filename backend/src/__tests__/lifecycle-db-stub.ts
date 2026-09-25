/**
 * WP5 测试共享替身 —— `db.ts` 的进程级替换（内部测试工具，不进生产构建）。
 *
 * ── 为什么需要这个文件 ──
 * 多个 WP5 测试文件都要替换 `../../db.ts`：
 *   · `services/__tests__/node-lifecycle.test.ts`（服务层，走参数注入，
 *     但仍需 mock 模块顶层的 `defaultDb`）
 *   · `routes/__tests__/node-lifecycle-route.test.ts`（路由层，路由模块
 *     顶层 `import { db }`）
 *
 * Bun 的 `mock.module` 是**进程级**注册表：同一进程内，所有解析
 * `db.ts` 的模块都拿到最后注册的那个替身。如果两个文件各自注册**不同**的
 * 替身对象，先注册的文件的替身会把后加载文件的用例打挂（表现为 500 /
 * "forgot to pass inject" 之类与用例无关的报错）。
 *
 * 因此替身必须**只有一份、且语义完整**：本文件导出唯一的 `dbStub` 与
 * `mockDb()`。两侧测试都应调用 `mockDb()`，注册的是同一个对象；
 * 数据存在模块级 Map/Array 里，任一侧 `resetLifecycleStub()` 即清空。
 *
 * ── 覆盖的模型面 ──
 * node / tunnel / nodeBinding / nodePortLease / egressPool —— 与
 * `services/node-lifecycle.ts`、`services/node-admin.ts`（resolveNodeId）
 * 的真实调用面对齐。未列出的模型用空壳（`count → 0`、`findMany → []`），
 * 这样同进程其他文件即便解析到这里也不会崩。
 */
import { mock } from "bun:test";

interface StubNodeRow {
  id: number;
  node_id: string;
  role: string | null;
  status: string;
  lifecycle: string;
  last_seen_at: Date | null;
  port_range_min: number | null;
  port_range_max: number | null;
  node_credential_hash: string | null;
  credential_revoked: boolean;
  lifecycle_note: string | null;
  lifecycle_updated_at: Date | null;
}

const nodes = new Map<number, StubNodeRow>();
const tunnelRows: Array<{ id: number; ingress_node_id: number | null; egress_node_id: number | null }> = [];
const bindingRows: Array<{ id: number; ingress_node_id: number; egress_node_id: number }> = [];
const leaseRows: Array<{ id: number; node_id: number; port: number; status: string }> = [];
const poolRows: Array<{ id: number; node_id: number }> = [];

/** 基准时间：固定，让 90s 在线窗口的判定可预测。 */
export const STUB_NOW = new Date("2026-09-27T00:00:00.000Z");

/** 测试里用来断言「哈希绝不外泄」的哨兵值（非真实凭据形态）。 */
export const STUB_CRED_HASH = "e".repeat(64);

function prismaNotFound(): Error {
  const e = new Error("Record to update/delete does not exist.");
  (e as Error & { code: string }).code = "P2025";
  return e;
}

function seedStubNode(over: Partial<StubNodeRow> = {}): StubNodeRow {
  const id = nodes.size + 1;
  const row: StubNodeRow = {
    id,
    node_id: `node-${id}`,
    role: "both",
    status: "active",
    lifecycle: "active",
    last_seen_at: STUB_NOW,
    port_range_min: null,
    port_range_max: null,
    node_credential_hash: STUB_CRED_HASH,
    credential_revoked: false,
    lifecycle_note: null,
    lifecycle_updated_at: null,
    ...over,
  };
  nodes.set(id, row);
  return row;
}

function hasStubNode(id: number): boolean {
  return nodes.has(id);
}

function stubNode(id: number): StubNodeRow | undefined {
  return nodes.get(id);
}

function pushStubTunnel(row: { ingress_node_id: number | null; egress_node_id: number | null }): void {
  tunnelRows.push({ id: tunnelRows.length + 1, ...row });
}

function pushStubBinding(row: { ingress_node_id: number; egress_node_id: number }): void {
  bindingRows.push({ id: bindingRows.length + 1, ...row });
}

function pushStubLease(row: { node_id: number; port: number; status: string }): void {
  leaseRows.push({ id: leaseRows.length + 1, ...row });
}

function pushStubPool(row: { node_id: number }): void {
  poolRows.push({ id: poolRows.length + 1, ...row });
}

/** 唯一的 db 替身对象。两侧测试都通过 {@link mockDb} 注册它。 */
export const dbStub = {
  node: {
    async findUnique({ where }: { where: Record<string, unknown> }) {
      if (where.id !== undefined) {
        const row = nodes.get(where.id as number);
        return row ? { ...row } : null;
      }
      if (where.node_id !== undefined) {
        const row = [...nodes.values()].find((n) => n.node_id === where.node_id);
        return row ? { ...row } : null;
      }
      return null;
    },
    async findMany({ where }: { where?: Record<string, unknown> } = {}) {
      let rows = [...nodes.values()];
      if (where?.lifecycle !== undefined) rows = rows.filter((n) => n.lifecycle === where.lifecycle);
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
  },

  nodeBinding: {
    async count({ where }: { where: Record<string, unknown> }) {
      const or = (where?.OR ?? []) as Array<{ ingress_node_id?: number; egress_node_id?: number }>;
      return bindingRows.filter((b) =>
        or.some((c) => b.ingress_node_id === c.ingress_node_id || b.egress_node_id === c.egress_node_id),
      ).length;
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

  // 未显式覆盖的模型：空壳（其他测试文件解析到这里时不会崩）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as unknown as Record<string, any>;

/**
 * 在**任何** `import "../node-lifecycle.ts"` 之前调用。
 *
 * 幂等：多次调用注册的是同一个 `dbStub` 对象，所以服务层/路由层测试谁先
 * 注册都无所谓，后注册的不会覆盖数据语义。
 */
export function mockDb(): void {
  mock.module(new URL("../db.ts", import.meta.url).pathname, () => ({ db: dbStub }));
}

/** 清空替身持有的全部状态（beforeEach 调用）。 */
export function resetLifecycleStub(): void {
  nodes.clear();
  tunnelRows.length = 0;
  bindingRows.length = 0;
  leaseRows.length = 0;
  poolRows.length = 0;
}

export const stubState = {
  seedNode: seedStubNode,
  hasNode: hasStubNode,
  node: stubNode,
  pushTunnel: pushStubTunnel,
  pushBinding: pushStubBinding,
  pushLease: pushStubLease,
  pushPool: pushStubPool,
  nodeCount: () => nodes.size,
};

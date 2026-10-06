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
 *
 * ── 加载顺序约束（`bun test src` 单进程实测得出）──
 * 注册替身**不能**救回一个已经把 `db.ts` 冻进模块作用域的模块：
 * 若某测试文件先于本替身把 `node-lifecycle.ts`（经 `forward-rollout.ts` /
 * `forward-rollout-exec.ts` → `portPool.ts` → `db.ts` 这条链）拉进模块
 * 注册表，该模块的 db 绑定已指向真实 PrismaClient，本替身之后注册也改不
 * 动它，表现为路由层 500 + `pd.node.findUnique is not a function`。
 * 因此 `node-lifecycle.ts` **不得**在模块顶层 import `db.ts`（它现在用
 * `loadDefaultDb()` 惰性 import）。新增测试文件时保持同一取向：
 * 先 `mockDb()`，再 `await import` 被测模块。
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
  /** V4-WP6：面板侧记录/回填的 Agent 版本（health 的版本基线之一）。 */
  version?: string | null;
}

/**
 * V4-WP6 —— `node_state_report` 行（遥测快照）。
 *
 * 字段刻意与 Prisma `NodeStateReport` 同名（含 WP6 新增的遥测列），这样
 * services 层的 select 投影在替身上「原样可用」，不必为每个字段写映射。
 */
export interface StubStateReportRow {
  node_id: number;
  version: string | null;
  role: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  egress_pools: unknown;
  used_ports: unknown;
  last_error: string | null;
  reported_at: Date | null;
  // ── V4-WP6 遥测列 ──
  known_revision?: number | null;
  agent_started_at?: Date | null;
  hostname?: string | null;
  os?: string | null;
  arch?: string | null;
  runtime_counts?: unknown;
  host_metrics?: unknown;
  error_count?: number | null;
  last_error_at?: Date | null;
}

const nodes = new Map<number, StubNodeRow>();
/** 每节点一行快照（与真实 upsert 语义一致：不是时序追加）。 */
const stateReports = new Map<number, StubStateReportRow>();
const tunnelRows: Array<{
  id: number;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  name?: string | null;
  tunnel_mode?: string | null;
  desired_status?: string | null;
  config_revision?: number | null;
  apply_status?: string | null;
  apply_error?: string | null;
  listen_port?: number | null;
  egress_port?: number | null;
}> = [];
const bindingRows: Array<{ id: number; ingress_node_id: number; egress_node_id: number }> = [];
const leaseRows: Array<{ id: number; node_id: number; port: number; status: string }> = [];
const poolRows: Array<{ id: number; node_id: number }> = [];
const federationLeaseRows: Array<{
  id: number;
  node_id: number | null;
  state: string;
  last_error_code: string | null;
}> = [];

/**
 * 心跳偏移（毫秒）：替身节点默认 `last_seen_at` 取「**播种这一刻**」往前
 * 这么久——相对时间，不是固定时刻。
 *
 * 为什么不能钉一个固定 `STUB_NOW`（WP5 踩过的坑）：路由层被测
 * `getNodeLifecycle` 不注入 `now`，读的是真实时钟。固定时刻一旦落在真实
 * 90s 在线窗口之外（写完它的当天晚些时候再跑就会），active 节点被判
 * offline，「active + online」断言随即失败——同一份代码换个时间跑就红。
 * 用相对播种时刻的偏移则永远新鲜；要构造「超窗离线」时，调用方显式传一个
 * 大于 `CONNECTION_ONLINE_WINDOW_MS` 的历史偏移即可（见
 * `routes/__tests__/node-lifecycle-route.test.ts`）。
 */
export const HEARTBEAT_AGE_MS = 5_000;

/** 新鲜心跳时刻：相对当前时间，让 90s 在线窗口判定稳定成立。 */
export function freshHeartbeat(ageMs: number = HEARTBEAT_AGE_MS): Date {
  return new Date(Date.now() - ageMs);
}

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
    last_seen_at: freshHeartbeat(),
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

function pushStubTunnel(row: {
  ingress_node_id: number | null;
  egress_node_id: number | null;
  name?: string | null;
  tunnel_mode?: string | null;
  desired_status?: string | null;
  config_revision?: number | null;
  apply_status?: string | null;
  apply_error?: string | null;
  listen_port?: number | null;
  egress_port?: number | null;
}): void {
  tunnelRows.push({ id: tunnelRows.length + 1, ...row });
}

/**
 * 播种一条快照（V4-WP6）。
 *
 * 缺省值刻意取「上线且一切正常」那一侧（新鲜心跳、revision 0、零错误），
 * 用例要构造异常时显式覆盖某个字段即可——这样「忘了设字段」不会静默变成
 * 一个看起来正常的 health，而是需要被显式写的那个事实。
 */
function seedStubStateReport(over: Partial<StubStateReportRow> & { node_id: number }): StubStateReportRow {
  const row: StubStateReportRow = {
    version: "1.4.0",
    role: "BOTH",
    reported_revision: 0,
    tunnels: [],
    egress_pools: {},
    used_ports: [],
    last_error: null,
    reported_at: freshHeartbeat(),
    known_revision: 0,
    agent_started_at: new Date(Date.now() - 3_600_000),
    hostname: `node-${over.node_id}`,
    os: "linux",
    arch: "amd64",
    runtime_counts: { direct: 0, relay_ingress: 0, relay_egress: 0, total: 0 },
    host_metrics: null,
    error_count: 0,
    last_error_at: null,
    ...over,
  };
  stateReports.set(row.node_id, row);
  return row;
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
      if (where?.middle_node_id !== undefined) {
        return tunnelRows.filter(
          (t) => (t as typeof t & { middle_node_id?: number | null }).middle_node_id === where.middle_node_id,
        ).length;
      }
      return tunnelRows.length;
    },
    /** V4-WP6：health 需要 Forward 的 desired 面（含 OR ingress/egress）。 */
    async findMany({ where }: { where?: Record<string, unknown> } = {}) {
      let rows = [...tunnelRows];
      const or = (where?.OR ?? []) as Array<{ ingress_node_id?: number; egress_node_id?: number }>;
      if (or.length > 0) {
        rows = rows.filter((t) =>
          or.some((c) => t.ingress_node_id === c.ingress_node_id || t.egress_node_id === c.egress_node_id),
        );
      }
      return rows.map((r) => ({ ...r }));
    },
  },

  /**
   * V4-WP6：快照读面。`upsert` 与真实语义一致（每节点一行）。
   * `select` 被忽略：替身回整行，services 层的投影只读自己点名的字段。
   */
  nodeStateReport: {
    async findUnique({ where }: { where: { node_id: number } }) {
      const row = stateReports.get(where.node_id);
      return row ? { ...row } : null;
    },
    async findMany() {
      return [...stateReports.values()].map((r) => ({ ...r }));
    },
    async upsert({ where, create, update }: { where: { node_id: number }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      const existing = stateReports.get(where.node_id);
      const next = existing
        ? { ...existing, ...update }
        : ({ node_id: where.node_id, ...create } as unknown as StubStateReportRow);
      stateReports.set(where.node_id, next as StubStateReportRow);
      return { ...next };
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

  federationLease: {
    async count({ where }: { where: Record<string, unknown> }) {
      const nodeId = where.node_id as number;
      return federationLeaseRows.filter((row) => {
        if (row.node_id !== nodeId) return false;
        if (["reserved", "active", "releasing", "failed"].includes(row.state)) return true;
        return ["revoked", "expired", "released"].includes(row.state) && row.last_error_code !== null;
      }).length;
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
  stateReports.clear();
  tunnelRows.length = 0;
  bindingRows.length = 0;
  leaseRows.length = 0;
  poolRows.length = 0;
  federationLeaseRows.length = 0;
}

export const stubState = {
  seedNode: seedStubNode,
  hasNode: hasStubNode,
  node: stubNode,
  /** V4-WP6：播种/读取快照行。 */
  seedStateReport: seedStubStateReport,
  stateReport: (nodeId: number) => stateReports.get(nodeId),
  stateReportCount: () => stateReports.size,
  pushTunnel: pushStubTunnel,
  pushBinding: pushStubBinding,
  pushLease: pushStubLease,
  pushPool: pushStubPool,
  pushFederationLease: (row: {
    node_id: number | null;
    state: string;
    last_error_code?: string | null;
  }) => {
    federationLeaseRows.push({
      id: federationLeaseRows.length + 1,
      node_id: row.node_id,
      state: row.state,
      last_error_code: row.last_error_code ?? null,
    });
  },
  nodeCount: () => nodes.size,
};

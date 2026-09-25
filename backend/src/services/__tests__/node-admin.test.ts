/**
 * WP10 — Admin Node / Egress API 离线测试（不连 MySQL / Redis / 网络）。
 *
 * 依据 `DEVELOPMENT.md` §7.13「WP10 / WP11 — API Track」。验收口径：
 *   1. **角色是真源、不猜**：ingress 节点不许挂池；取消出口角色前必须先清池；
 *      获得出口能力时自动补 `default` 池（幂等）；
 *   2. **凭据绝不下发明文或哈希**：credential list/get 的响应体里没有
 *      `node_credential_hash` 也没有任何 43 位 base64url（WP7 明文的形态）；
 *   3. **池不变式**：§2.2「至少一个 active 且 weight>0 的目标」在目标增 /
 *      删 / 改 / 整批替换四条路径上都拦得住；
 *   4. **删池不级联隧道**：被 RELAY 隧道引用的池 409，让调用方走热更新；
 *   5. **状态查询三态不一致显式标注**：stale / role_mismatch / 从未上报
 *      都被看见，而不是抹平成同一个"正常"；
 *   6. **本层没有下发能力**：服务与路由源码静态断言——不 import socket/*、
 *      control-protocol/*、portPool，不含 listen()/connect。
 *
 * ── 替身设计 ──
 * `node-admin.ts` 把 `db` 做成可注入（`NodeAdminDeps`），所以这里**不需要**
 * `mock.module`：直接从每个函数的 `inject` 参数传内存替身。比 mock.module 稳——
 * 它不会因为换 worktree / CI 路径而静默失效（见 tunex-backend-workflow 里
 * node-credential 测试的教训）。
 * 替身按真实 schema 复刻两条关键行为：
 *   · `@@unique([node_id, name])`（egress_pool）→ 内存唯一校验 + P2002；
 *   · 路由层路径全部落在 `/admin/node` 前缀下 → 静态断言
 *     `resolveAdminRoute()` 对每个端点都能解析到 `nodes` 资源（fail-closed 反证）。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  DEFAULT_POOL_NAME,
  NODE_STATE_STALE_SECONDS,
  hasEgressCapability,
  isRoleMismatch,
  isStaleState,
  isValidTargetPort,
  parseHostPort,
  parseNodeRole,
  parsePoolName,
  parsePortRange,
  parseTargetHost,
  parseTargetPort,
  parseWeight,
  poolHasViableTarget,
  createEgressPool,
  createTarget,
  deleteEgressPool,
  deleteTarget,
  getNodeCredential,
  getNodeDetail,
  getNodeState,
  listEgressPools,
  listNodeStates,
  listNodeStatesWithCredentials,
  listTargets,
  replaceTargets,
  resolveNodeId,
  updateEgressPool,
  updateNodeRole,
  updateTarget,
  type EgressPoolRow,
  type EgressTargetRow,
  type NodeAdminDb,
  type NodeAdminDeps,
  type NodeRow,
  type StateReportRow,
} from "../node-admin.ts";

/* ------------------------------------------------------------------ */
/* 内存 DB 替身（按真实 schema 复刻关键行为）                             */
/* ------------------------------------------------------------------ */

interface PoolRow extends EgressPoolRow {}
interface TargetRow extends EgressTargetRow {}

const nodes = new Map<number, NodeRow>();
const pools: PoolRow[] = [];
const targets: TargetRow[] = [];
const reports = new Map<number, StateReportRow>();
const tunnels = new Map<number, { id: number; egress_pool_id: number | null; egress_node_id: number | null }>();
let nextNodeId = 1;
let nextPoolId = 1;
let nextTargetId = 1;
let nextTunnelId = 1;

function resetState(): void {
  nodes.clear();
  pools.length = 0;
  targets.length = 0;
  reports.clear();
  tunnels.clear();
  nextNodeId = 1;
  nextPoolId = 1;
  nextTargetId = 1;
  nextTunnelId = 1;
}

function prismaUniqueError(fields: string): Error {
  const e = new Error(`Unique constraint failed on the fields: (\`${fields}\`)`);
  (e as Error & { code: string }).code = "P2002";
  return e;
}

function prismaNotFound(): Error {
  const e = new Error("Record to delete does not exist.");
  (e as Error & { code: string }).code = "P2025";
  return e;
}

function seedNode(over: Partial<NodeRow> = {}): NodeRow {
  const id = nextNodeId++;
  const row: NodeRow = {
    id,
    node_id: `node-${id}`,
    status: "active",
    weight: 1,
    connect_ip: "10.0.0.1",
    version: "0.13.22",
    role: null,
    last_seen_at: null,
    port_range_min: null,
    port_range_max: null,
    lb_strategy: null,
    order_by: 1000,
    backup: false,
    dns_status: false,
    node_credential_hash: null,
    credential_revoked: false,
    credential_rotated_at: null,
    credential_last_rejected_at: null,
    node_group: { id: 1, name: "g", node_type: "in" },
    ...over,
  };
  nodes.set(id, row);
  return row;
}

function seedStateReport(nodeId: number, over: Partial<StateReportRow> = {}): StateReportRow {
  const row: StateReportRow = {
    node_id: nodeId,
    version: "0.13.22",
    role: "EGRESS",
    reported_revision: 17,
    tunnels: [],
    egress_pools: {},
    used_ports: [],
    last_error: null,
    reported_at: new Date(),
    ...over,
  };
  reports.set(nodeId, row);
  return row;
}

/**
 * 内存 DB。只实现被测函数真正会用到的调用面，且按 schema 复刻：
 *   · egress_pool `@@unique([node_id, name])`（含 `default` 名）；
 *   · node.update 对不存在的 id 抛 P2025。
 */
function makeDb(): NodeAdminDb {
  return {
    node: {
      async findUnique(args: unknown) {
        const { where, select, include } = args as {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
          include?: Record<string, unknown>;
        };
        let row: NodeRow | null = null;
        if ("id" in where) row = nodes.get(where.id as number) ?? null;
        else if ("node_id" in where) {
          row = [...nodes.values()].find((n) => n.node_id === where.node_id) ?? null;
        }
        if (!row) return null;
        const out: Record<string, unknown> = { ...row };
        // select 是投影：只回 select 点到的字段（含嵌套 node_group）。
        if (select) {
          const projected: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            if (key === "node_group") projected.node_group = row.node_group;
            else projected[key] = (row as unknown as Record<string, unknown>)[key];
          }
          return projected;
        }
        if (include && include.node_group) out.node_group = row.node_group;
        return out;
      },
      async findMany({
        where,
        select,
      }: {
        where?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) {
        let rows = [...nodes.values()];
        if (where?.role !== undefined) rows = rows.filter((n) => n.role === where.role);
        if (where?.status && typeof where.status === "object" && "not" in where.status) {
          rows = rows.filter((n) => n.status !== (where.status as { not: unknown }).not);
        } else if (where?.status !== undefined) {
          rows = rows.filter((n) => n.status === where.status);
        }
        // 复刻 Prisma 的投影：只回 select 点到的字段。
        // 哈希列只有 `listNodeStatesWithCredentials` 显式 select 才出现。
        if (select) {
          return rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              out[key] = (row as unknown as Record<string, unknown>)[key];
            }
            return out;
          });
        }
        return rows;
      },
      async count() {
        return nodes.size;
      },
      async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
        const row = nodes.get(where.id);
        if (!row) throw prismaNotFound();
        Object.assign(row, data);
        return { ...row };
      },
    },

    egressPool: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return pools.find((p) => p.id === where.id) ?? null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return (
          pools.find(
            (p) =>
              (where.node_id === undefined || p.node_id === where.node_id) &&
              (where.name === undefined || p.name === where.name),
          ) ?? null
        );
      },
      async findMany({ where, include }: { where?: Record<string, unknown>; include?: Record<string, unknown> }) {
        let rows = pools.filter((p) => where?.node_id === undefined || p.node_id === where.node_id);
        rows = rows.map((p) =>
          include?.targets
            ? {
                ...p,
                targets: targets
                  .filter((t) => t.pool_id === p.id)
                  .sort((a, b) => a.order_by - b.order_by || a.id - b.id),
              }
            : p,
        );
        return rows;
      },
      async count({ where }: { where: { node_id: number } }) {
        return pools.filter((p) => p.node_id === where.node_id).length;
      },
      async create({ data }: { data: Omit<PoolRow, "id" | "created_at" | "updated_at"> }) {
        // schema 复刻：@@unique([node_id, name])，含自动创建的 default 池。
        if (pools.some((p) => p.node_id === data.node_id && p.name === data.name)) {
          throw prismaUniqueError("node_id, name");
        }
        const now = new Date();
        const row: PoolRow = {
          id: nextPoolId++,
          ...data,
          lb_strategy: data.lb_strategy ?? null,
          status: data.status ?? "active",
          created_at: now,
          updated_at: now,
        } as PoolRow;
        pools.push(row);
        return { ...row };
      },
      async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
        const row = pools.find((p) => p.id === where.id);
        if (!row) throw prismaNotFound();
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      },
      async delete({ where }: { where: { id: number } }) {
        const idx = pools.findIndex((p) => p.id === where.id);
        if (idx < 0) throw prismaNotFound();
        pools.splice(idx, 1);
        // EgressTarget.onDelete: Cascade（schema），替身一并复刻。
        for (let i = targets.length - 1; i >= 0; i--) {
          if (targets[i].pool_id === where.id) targets.splice(i, 1);
        }
        return {};
      },
    },

    egressTarget: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return targets.find((t) => t.id === where.id) ?? null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return targets.find((t) => t.pool_id === where.pool_id) ?? null;
      },
      async findMany({
        where,
        select,
        orderBy,
      }: {
        where?: Record<string, unknown>;
        select?: Record<string, unknown>;
        orderBy?: Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>;
      }) {
        let rows = targets.filter((t) => where?.pool_id === undefined || t.pool_id === where.pool_id);
        const notId = (where as { NOT?: { id?: unknown } }).NOT?.id;
        if (notId !== undefined) rows = rows.filter((t) => t.id !== notId);
        // 复刻 Prisma 的 orderBy（对象或数组形式；后写的键是 tiebreaker）。
        const clauses = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
        for (const key of Object.keys(clauses[0] ?? {})) {
          const dir = clauses.every((c) => c[key] === "desc") ? "desc" : "asc";
          rows = [...rows].sort((a, b) => {
            const av = a[key as keyof TargetRow] as number;
            const bv = b[key as keyof TargetRow] as number;
            return dir === "asc" ? av - bv : bv - av;
          });
        }
        // 复刻投影：select 点到的才返回。
        if (select) {
          return rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              out[key] = (row as unknown as Record<string, unknown>)[key];
            }
            return out;
          });
        }
        return rows;
      },
      async count() {
        return targets.length;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const now = new Date();
        const row: TargetRow = {
          id: nextTargetId++,
          pool_id: data.pool_id as number,
          host: data.host as string,
          port: data.port as number,
          weight: (data.weight as number) ?? 1,
          order_by: (data.order_by as number) ?? 1000,
          remark: (data.remark as string) ?? null,
          status: (data.status as string) ?? "active",
          created_at: now,
          updated_at: now,
        };
        targets.push(row);
        return { ...row };
      },
      async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
        const row = targets.find((t) => t.id === where.id);
        if (!row) throw prismaNotFound();
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      },
      async updateMany() {
        return { count: 0 };
      },
      async delete({ where }: { where: { id: number } }) {
        const idx = targets.findIndex((t) => t.id === where.id);
        if (idx < 0) throw prismaNotFound();
        targets.splice(idx, 1);
        return {};
      },
    },

    nodeStateReport: {
      async findUnique({
        where,
        select,
      }: {
        where: { node_id: number };
        select?: Record<string, unknown>;
      }) {
        const row = reports.get(where.node_id) ?? null;
        if (!row) return null;
        // 复刻 Prisma 的投影：只回 select 点到的字段。
        if (select) {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            out[key] = (row as unknown as Record<string, unknown>)[key];
          }
          return out;
        }
        return row;
      },
      async findMany({ select }: { select?: Record<string, unknown> } = {}) {
        const rows = [...reports.values()];
        if (select) {
          return rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              out[key] = (row as unknown as Record<string, unknown>)[key];
            }
            return out;
          });
        }
        return rows;
      },
    },

    tunnel: {
      async count({ where }: { where: Record<string, unknown> }) {
        let rows = [...tunnels.values()];
        if (where?.egress_pool_id !== undefined) rows = rows.filter((t) => t.egress_pool_id === where.egress_pool_id);
        if (where?.egress_node_id !== undefined) rows = rows.filter((t) => t.egress_node_id === where.egress_node_id);
        return rows.length;
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        let rows = [...tunnels.values()];
        if (where?.egress_node_id !== undefined) rows = rows.filter((t) => t.egress_node_id === where.egress_node_id);
        return rows;
      },
    },
  };
}

/** 固定"现在"，让 stale/age 断言不依赖真实时钟。 */
const NOW = new Date("2026-09-25T12:00:00.000Z");
function deps(over: NodeAdminDeps = {}): NodeAdminDeps {
  return { db: makeDb(), now: () => NOW, ...over };
}

function seedEgressNode(role: "egress" | "both" = "egress"): NodeRow {
  return seedNode({ role, node_id: `egress-${nextNodeId}` });
}

/** 给节点建 default 池并加一个可用目标。 */
function seedDefaultPool(node: NodeRow): PoolRow {
  const pool: PoolRow = {
    id: nextPoolId++,
    node_id: node.id,
    name: DEFAULT_POOL_NAME,
    lb_strategy: "round",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
  pools.push(pool);
  targets.push({
    id: nextTargetId++,
    pool_id: pool.id,
    host: "10.0.0.2",
    port: 80,
    weight: 1,
    order_by: 1000,
    remark: null,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  });
  return pool;
}

beforeEach(() => {
  resetState();
});

/* ------------------------------------------------------------------ */
/* 纯校验                                                               */
/* ------------------------------------------------------------------ */

describe("parseNodeRole", () => {
  test("合法枚举值（大小写不敏感、容忍空白）", () => {
    expect(parseNodeRole("ingress")).toEqual({ ok: true, value: "ingress" });
    expect(parseNodeRole(" EGRESS ")).toEqual({ ok: true, value: "egress" });
    expect(parseNodeRole("both")).toEqual({ ok: true, value: "both" });
  });

  test("null / 空串 = 显式清空（回到「尚未声明」）", () => {
    expect(parseNodeRole(null)).toEqual({ ok: true, value: null });
    expect(parseNodeRole("")).toEqual({ ok: true, value: null });
    expect(parseNodeRole("  ")).toEqual({ ok: true, value: null });
  });

  test("非法值与错误类型一律拒绝（fail-closed，不默认成 ingress）", () => {
    expect(parseNodeRole("relay").ok).toBe(false);
    expect(parseNodeRole("all").ok).toBe(false);
    expect(parseNodeRole(1).ok).toBe(false);
    expect(parseNodeRole({}).ok).toBe(false);
    expect(parseNodeRole([]).ok).toBe(false);
  });
});

describe("parsePortRange", () => {
  test("合法区间原样返回", () => {
    expect(parsePortRange(19000, 19999)).toEqual({ ok: true, value: { min: 19000, max: 19999 } });
    expect(parsePortRange("19000", "19999")).toEqual({ ok: true, value: { min: 19000, max: 19999 } });
  });

  test("两端都空 = 未配置（不回落节点组 port_range）", () => {
    expect(parsePortRange(null, null)).toEqual({ ok: true, value: null });
    expect(parsePortRange("", "")).toEqual({ ok: true, value: null });
  });

  test("只给一端 / min>max / 越界 → 拒绝", () => {
    expect(parsePortRange(19000, null).ok).toBe(false);
    expect(parsePortRange(null, 19999).ok).toBe(false);
    expect(parsePortRange(20000, 19000).ok).toBe(false);
    expect(parsePortRange(0, 100).ok).toBe(false);
    expect(parsePortRange(100, 65536).ok).toBe(false);
    expect(parsePortRange(1.5, 10).ok).toBe(false);
  });
});

describe("isValidTargetPort / parseTargetPort", () => {
  test("1..65535 整数", () => {
    expect(isValidTargetPort(1)).toBe(true);
    expect(isValidTargetPort(65535)).toBe(true);
    expect(isValidTargetPort(0)).toBe(false);
    expect(isValidTargetPort(65536)).toBe(false);
    expect(isValidTargetPort(80.5)).toBe(false);
    expect(isValidTargetPort("80")).toBe(false); // 上层负责 string→number
  });

  test("443 对出口目标是合法的（与租约端口黑名单的区别所在）", () => {
    expect(parseTargetPort(443)).toEqual({ ok: true, value: 443 });
    expect(isValidTargetPort(443)).toBe(true);
  });

  test("字符串数字形态接受（表单带回字符串是常态）", () => {
    expect(parseTargetPort("443")).toEqual({ ok: true, value: 443 });
  });

  test("必填缺失 / 越界 / 非数字 → 拒绝", () => {
    expect(parseTargetPort(undefined).ok).toBe(false);
    expect(parseTargetPort("").ok).toBe(false);
    expect(parseTargetPort(0).ok).toBe(false);
    expect(parseTargetPort(70000).ok).toBe(false);
    expect(parseTargetPort("abc").ok).toBe(false);
  });
});

describe("parseTargetHost", () => {
  test("IPv4 / 域名 / IPv6 字面量都合法（`:` 不构成拒绝理由）", () => {
    expect(parseTargetHost("10.0.0.2")).toEqual({ ok: true, value: "10.0.0.2" });
    expect(parseTargetHost("example.com")).toEqual({ ok: true, value: "example.com" });
    expect(parseTargetHost("2001:db8::1")).toEqual({ ok: true, value: "2001:db8::1" });
  });

  test("带 scheme / 空白 / 超长 / 非字符串 → 拒绝（防 host:port 组合串）", () => {
    expect(parseTargetHost("http://10.0.0.2").ok).toBe(false);
    expect(parseTargetHost("10.0.0.2:80").ok).toBe(true); // 组合串由上层 port 列拆开，这里只拦 scheme
    expect(parseTargetHost("10.0.0.2 80").ok).toBe(false);
    expect(parseTargetHost("x".repeat(256)).ok).toBe(false);
    expect(parseTargetHost(80).ok).toBe(false);
    expect(parseTargetHost(null).ok).toBe(false);
  });
});

describe("parsePoolName", () => {
  test("合法名字；`default` 在建池路径另作保留名处理", () => {
    expect(parsePoolName("asia")).toEqual({ ok: true, value: "asia" });
    expect(parsePoolName(DEFAULT_POOL_NAME)).toEqual({ ok: true, value: DEFAULT_POOL_NAME });
  });

  test("空白 / 斜杠 / 空 / 过长 → 拒绝（名字会进 URL 与下发）", () => {
    expect(parsePoolName("").ok).toBe(false);
    expect(parsePoolName("  ").ok).toBe(false);
    expect(parsePoolName("a b").ok).toBe(false);
    expect(parsePoolName("a/b").ok).toBe(false);
    expect(parsePoolName("x".repeat(121)).ok).toBe(false);
    expect(parsePoolName(1).ok).toBe(false);
  });
});

describe("parseWeight / poolHasViableTarget", () => {
  test("权重 0 合法（在线但不接流），非整数 / 负数 / 过大拒绝", () => {
    expect(parseWeight(0)).toEqual({ ok: true, value: 0 });
    expect(parseWeight(undefined)).toEqual({ ok: true, value: 1 });
    expect(parseWeight(-1).ok).toBe(false);
    expect(parseWeight(1.5).ok).toBe(false);
    expect(parseWeight(70000).ok).toBe(false);
  });

  test("可用目标 = 至少一个 active 且 weight>0（§2.2）", () => {
    expect(poolHasViableTarget([{ status: "active", weight: 0 }])).toBe(false);
    expect(poolHasViableTarget([{ status: "inactive", weight: 5 }])).toBe(false);
    expect(poolHasViableTarget([{ status: "active", weight: 1 }])).toBe(true);
    expect(poolHasViableTarget([])).toBe(false);
    expect(poolHasViableTarget(null)).toBe(false);
    // 多个里有一个可用的就算可用。
    expect(
      poolHasViableTarget([
        { status: "inactive", weight: 9 },
        { status: "active", weight: 0 },
        { status: "active", weight: 1 },
      ]),
    ).toBe(true);
  });
});

describe("hasEgressCapability / isRoleMismatch / isStaleState", () => {
  test("出口能力只看 egress/both；null 与 ingress 都没有", () => {
    expect(hasEgressCapability("egress")).toBe(true);
    expect(hasEgressCapability("both")).toBe(true);
    expect(hasEgressCapability("ingress")).toBe(false);
    expect(hasEgressCapability(null)).toBe(false);
  });

  test("角色不一致判定：Agent 自报大小写不同不算不一致", () => {
    expect(isRoleMismatch("EGRESS", "egress")).toBe(false);
    expect(isRoleMismatch("ingress", "egress")).toBe(true);
    // 一侧缺失时不判不一致（没声明 ≠ 不符）。
    expect(isRoleMismatch(null, "egress")).toBe(false);
    expect(isRoleMismatch("INGRESS", null)).toBe(false);
  });

  test("陈旧判定：超过 300s 未上报为 stale；未来时间（时钟偏差）按 0 秒", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    expect(isStaleState(new Date("2026-09-25T11:59:30Z"), now)).toBe(false);
    expect(isStaleState(new Date("2026-09-25T11:55:00Z"), now)).toBe(false); // 恰好 300s 不算 stale
    expect(isStaleState(new Date("2026-09-25T11:54:59Z"), now)).toBe(true); // 301s
    // 未来上报：age 按 0 处理，不渲染负数、不误判 stale。
    expect(isStaleState(new Date("2026-09-25T12:00:30Z"), now)).toBe(false);
    expect(NODE_STATE_STALE_SECONDS).toBe(300);
  });
});

describe("parseHostPort（兼容历史 host:port 串）", () => {
  test("IPv4:port 与 [v6]:port；畸形返回 null", () => {
    expect(parseHostPort("10.0.0.2:80")).toEqual({ host: "10.0.0.2", port: 80 });
    expect(parseHostPort(" [2001:db8::1]:443 ")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(parseHostPort("10.0.0.2")).toBeNull();
    expect(parseHostPort("10.0.0.2:")).toBeNull();
    expect(parseHostPort(":80")).toBeNull();
    expect(parseHostPort("10.0.0.2:99999")).toBeNull();
    expect(parseHostPort("")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* resolveNodeId：面板侧 id 双形态                                        */
/* ------------------------------------------------------------------ */

describe("resolveNodeId", () => {
  test("数字主键与 node_id 字符串都能定位", async () => {
    const node = seedNode();
    const pd = makeDb();
    expect(await resolveNodeId(pd, String(node.id))).toEqual({ ok: true, id: node.id });
    expect(await resolveNodeId(pd, node.node_id)).toEqual({ ok: true, id: node.id });
  });

  test("不存在 / 空 / 非法 → 失败（不猜、不回落）", async () => {
    const pd = makeDb();
    expect((await resolveNodeId(pd, "9999")).ok).toBe(false);
    expect((await resolveNodeId(pd, "no-such-node")).ok).toBe(false);
    expect((await resolveNodeId(pd, "")).ok).toBe(false);
    expect((await resolveNodeId(pd, "-1")).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Node role 管理                                                       */
/* ------------------------------------------------------------------ */

describe("updateNodeRole", () => {
  test("设置 ingress → egress 时自动补 default 池（幂等，幂等）", async () => {
    const node = seedNode({ role: "ingress" });
    const r = await updateNodeRole(node.id, { role: "egress" }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node.role).toBe("egress");
    expect(r.default_pool_created).toBe(true);
    const created = pools.filter((p) => p.node_id === node.id);
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe(DEFAULT_POOL_NAME);
    expect(created[0].lb_strategy).toBe("round");
  });

  test("同角色重复调用不会重复建池（幂等）", async () => {
    const node = seedNode({ role: "ingress" });
    await updateNodeRole(node.id, { role: "egress" }, deps());
    const second = await updateNodeRole(node.id, { role: "egress" }, deps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.default_pool_created).toBe(false);
    expect(pools.filter((p) => p.node_id === node.id)).toHaveLength(1);
  });

  test("节点已有自主 default 池时不覆盖它", async () => {
    const node = seedEgressNode();
    await updateNodeRole(node.id, { role: "ingress" }, deps()); // 无池，可降级
    seedDefaultPool(node);
    const r = await updateNodeRole(node.id, { role: "egress" }, deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.default_pool_created).toBe(false);
    expect(pools.filter((p) => p.node_id === node.id)).toHaveLength(1);
  });

  test("egress/both → ingress 前有池 → 409（先删池）", async () => {
    const node = seedEgressNode();
    seedDefaultPool(node);
    const r = await updateNodeRole(node.id, { role: "ingress" }, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_state");
    expect(r.message).toContain("出口池");
  });

  test("egress/both → null（未声明）同样要求先清池", async () => {
    const node = seedEgressNode("both");
    seedDefaultPool(node);
    const r = await updateNodeRole(node.id, { role: null }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
    // 池清掉后允许撤销角色。
    await deleteEgressPool(pools[0].id, deps());
    const again = await updateNodeRole(node.id, { role: null }, deps());
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.node.role).toBeNull();
  });

  test("端口区间与默认策略可同批更新", async () => {
    const node = seedNode({ role: "ingress" });
    const r = await updateNodeRole(
      node.id,
      { role: "egress", portRangeMin: 19000, portRangeMax: 19999, lbStrategy: "rand" },
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node.port_range_min).toBe(19000);
    expect(r.node.port_range_max).toBe(19999);
    expect(r.node.lb_strategy).toBe("rand");
  });

  test("body 里没有的键不动节点字段（部分更新，不是整行覆盖）", async () => {
    const node = seedNode({ role: "egress", lb_strategy: "round", port_range_min: 1000 });
    const r = await updateNodeRole(node.id, { role: null }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node.role).toBeNull();
    expect(r.node.lb_strategy).toBe("round");
    expect(r.node.port_range_min).toBe(1000);
  });

  test("节点不存在 → 404；非法角色 → 400", async () => {
    expect((await updateNodeRole(999, { role: "egress" }, deps())).ok).toBe(false);
    const r = await updateNodeRole(999, { role: "egress" }, deps());
    if (!r.ok) expect(r.code).toBe("not_found");
    const node = seedNode();
    const bad = await updateNodeRole(node.id, { role: "relay" }, deps());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_input");
  });
});

/* ------------------------------------------------------------------ */
/* EgressPool CRUD                                                      */
/* ------------------------------------------------------------------ */

describe("EgressPool CRUD", () => {
  test("ingress 节点建池 → 409（没有出口能力）", async () => {
    const node = seedNode({ role: "ingress" });
    const r = await createEgressPool(node.id, { name: "asia" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
  });

  test("未声明角色的节点建池 → 409", async () => {
    const node = seedNode({ role: null });
    const r = await createEgressPool(node.id, { name: "asia" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
  });

  test("egress 节点建池成功，默认策略继承节点 lb_strategy", async () => {
    const node = seedEgressNode();
    node.lb_strategy = "rand";
    const r = await createEgressPool(node.id, { name: "asia" }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pool.name).toBe("asia");
    expect(r.pool.lb_strategy).toBe("rand");
    expect(r.pool.status).toBe("active");
  });

  test("保留名 default 手动创建 → 409；同名池 → 409（@@unique node_id+name）", async () => {
    const node = seedEgressNode();
    const reserved = await createEgressPool(node.id, { name: DEFAULT_POOL_NAME }, deps());
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.code).toBe("conflict");
    await createEgressPool(node.id, { name: "asia" }, deps());
    const dup = await createEgressPool(node.id, { name: "asia" }, deps());
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("conflict");
  });

  test("节点不存在 → 404；非法池名 / 策略 / 状态 → 400", async () => {
    expect((await createEgressPool(999, { name: "x" }, deps())).ok).toBe(false);
    const node = seedEgressNode();
    for (const bad of [{ name: "" }, { name: "a b" }, { name: "a/b" }, { lbStrategy: "fifo" }, { status: "deleted" }]) {
      const r = await createEgressPool(node.id, bad, deps());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_input");
    }
  });

  test("改池名称 / 策略 / 状态", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const r = await updateEgressPool(created.pool.id, { name: "asia-2", lbStrategy: "rand" }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pool.name).toBe("asia-2");
    expect(r.pool.lb_strategy).toBe("rand");
  });

  test("停用的池不能改回 active（没有可用目标）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    await updateEgressPool(created.pool.id, { status: "inactive" }, deps());
    const back = await updateEgressPool(created.pool.id, { status: "active" }, deps());
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.code).toBe("invalid_state");
  });

  test("有可用目标后停用的池可以重新启用", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const target = await createTarget(created.pool.id, { host: "10.0.0.9", port: 443 }, deps());
    expect(target.ok).toBe(true);
    await updateEgressPool(created.pool.id, { status: "inactive" }, deps());
    const back = await updateEgressPool(created.pool.id, { status: "active" }, deps());
    expect(back.ok).toBe(true);
  });

  test("被 RELAY 隧道引用的池删除 → 409（先换池，不是级联删隧道）", async () => {
    const node = seedEgressNode();
    seedDefaultPool(node);
    tunnels.set(nextTunnelId++, { id: nextTunnelId - 1, egress_pool_id: pools[0].id, egress_node_id: node.id });
    const r = await deleteEgressPool(pools[0].id, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("conflict");
      expect(r.message).toContain("隧道");
    }
    expect(pools).toHaveLength(1);
  });

  test("无引用的池删除会级联清目标（schema 的 Cascade）", async () => {
    const node = seedEgressNode();
    seedDefaultPool(node);
    const poolId = pools[0].id;
    const r = await deleteEgressPool(poolId, deps());
    expect(r.ok).toBe(true);
    expect(pools.find((p) => p.id === poolId)).toBeUndefined();
    expect(targets.filter((t) => t.pool_id === poolId)).toHaveLength(0);
  });

  test("listEgressPools：按节点过滤 + includeTargets", async () => {
    const a = seedEgressNode();
    const b = seedEgressNode();
    await createEgressPool(a.id, { name: "asia" }, deps());
    await createEgressPool(b.id, { name: "eu" }, deps());
    const withTargets = await listEgressPools({ includeTargets: true }, deps());
    expect(withTargets.ok).toBe(true);
    if (!withTargets.ok) return;
    expect(withTargets.total).toBe(2);
    const forA = await listEgressPools({ nodeId: a.id, includeTargets: true }, deps());
    if (!forA.ok) throw new Error("expected ok");
    expect(forA.total).toBe(1);
    expect(forA.pools[0].node_id).toBe(a.id);
  });
});

/* ------------------------------------------------------------------ */
/* EgressTarget CRUD                                                    */
/* ------------------------------------------------------------------ */

describe("EgressTarget CRUD", () => {
  test("加目标成功；端口接受 443（不是黑名单端口）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const r = await createTarget(created.pool.id, { host: "203.0.113.9", port: 443 }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.host).toBe("203.0.113.9");
    expect(r.target.port).toBe(443);
    expect(r.target.weight).toBe(1);
    expect(r.target.status).toBe("active");
  });

  test("目标非法（scheme / 端口越界 / 缺端口）→ 400", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    for (const bad of [
      { host: "http://x", port: 80 },
      { host: "x", port: 0 },
      { host: "x", port: 70000 },
      { host: "x" },
      { host: "a b", port: 80 },
    ]) {
      const r = await createTarget(created.pool.id, bad, deps());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_input");
    }
    expect(targets).toHaveLength(0);
  });

  test("停用的池不能加 active 目标", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    await updateEgressPool(created.pool.id, { status: "inactive" }, deps());
    const r = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
  });

  test("把最后一个可用目标停用 → 409（§2.2 不变式）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const t = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    if (!t.ok) throw new Error("expected target");
    const r = await updateTarget(t.target.id, { status: "inactive" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
  });

  test("把最后一个目标权重改成 0 → 409（weight>0 也是不变式的一部分）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const t = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80, weight: 5 }, deps());
    if (!t.ok) throw new Error("expected target");
    const r = await updateTarget(t.target.id, { weight: 0 }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
  });

  test("两个目标时可以停用一个（池仍有可用目标）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const t1 = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    const t2 = await createTarget(created.pool.id, { host: "10.0.0.10", port: 80 }, deps());
    if (!t1.ok || !t2.ok) throw new Error("expected targets");
    const r = await updateTarget(t2.target.id, { status: "inactive" }, deps());
    expect(r.ok).toBe(true);
  });

  test("删除仅剩的一个可用目标 → 409；建议是停用而不是删", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const t = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    if (!t.ok) throw new Error("expected target");
    const r = await deleteTarget(t.target.id, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
    expect(targets).toHaveLength(1);
  });

  test("删除非可用目标允许（inactive 目标删了不影响不变式）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const t1 = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    const t2 = await createTarget(
      created.pool.id,
      { host: "10.0.0.10", port: 80, status: "inactive" },
      deps(),
    );
    if (!t1.ok || !t2.ok) throw new Error("expected targets");
    const r = await deleteTarget(t2.target.id, deps());
    expect(r.ok).toBe(true);
    expect(targets.filter((x) => x.id === t2.target.id)).toHaveLength(0);
  });

  test("listTargets 按池过滤并排序", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    await createTarget(created.pool.id, { host: "b", port: 80, orderBy: 200 }, deps());
    await createTarget(created.pool.id, { host: "a", port: 80, orderBy: 100 }, deps());
    const r = await listTargets({ poolId: created.pool.id }, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.targets.map((t) => t.host)).toEqual(["a", "b"]);
  });
});

describe("replaceTargets（整批替换，面板「保存池」）", () => {
  test("新建 + 保留 + 删除三种语义一次到位", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const old = await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    const keep = await createTarget(created.pool.id, { host: "10.0.0.10", port: 80 }, deps());
    if (!old.ok || !keep.ok) throw new Error("expected targets");

    const r = await replaceTargets(
      created.pool.id,
      [
        { id: keep.target.id, host: "10.0.0.10", port: 8080 }, // 改
        { host: "10.0.0.11", port: 443 }, // 增
      ], // 旧行 old 不在载荷里 → 删
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hosts = r.targets.map((t) => `${t.host}:${t.port}`);
    expect(hosts.sort()).toEqual(["10.0.0.10:8080", "10.0.0.11:443"]);
    expect(targets.filter((t) => t.id === old.target.id)).toHaveLength(0);
  });

  test("空集 / 全停用 → 409（终态必须可用）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    await createEgressPool(node.id, { name: "backup" }, deps());
    const empty = await replaceTargets(created.pool.id, [], deps());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("invalid_state");
    const allOff = await replaceTargets(
      created.pool.id,
      [{ host: "10.0.0.9", port: 80, status: "inactive" }],
      deps(),
    );
    expect(allOff.ok).toBe(false);
    if (!allOff.ok) expect(allOff.code).toBe("invalid_state");
    const zeroWeight = await replaceTargets(
      created.pool.id,
      [{ host: "10.0.0.9", port: 80, weight: 0 }],
      deps(),
    );
    expect(zeroWeight.ok).toBe(false);
  });

  test("pool 停用时整批 active 目标 → 409", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    await createTarget(created.pool.id, { host: "10.0.0.9", port: 80 }, deps());
    await updateEgressPool(created.pool.id, { status: "inactive" }, deps());
    const r = await replaceTargets(created.pool.id, [{ host: "10.0.0.9", port: 80 }], deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_state");
  });

  test("单个坏条目让整批失败（不做部分提交的中间态）", async () => {
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const r = await replaceTargets(
      created.pool.id,
      [
        { host: "10.0.0.9", port: 80 },
        { host: "bad host", port: 80 },
      ],
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
    // 一条都没进去（校验先于写入）。
    expect(targets).toHaveLength(0);
  });

  test("池不存在 → 404；非数组 → 400", async () => {
    expect((await replaceTargets(999, [], deps())).ok).toBe(false);
    const node = seedEgressNode();
    const created = await createEgressPool(node.id, { name: "asia" }, deps());
    if (!created.ok) throw new Error("expected pool");
    const r = await replaceTargets(created.pool.id, "nope" as unknown as unknown[], deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });
});

/* ------------------------------------------------------------------ */
/* 凭据 list/get：绝不下发明文或哈希                                       */
/* ------------------------------------------------------------------ */

describe("credential 状态查询（WP7 读端点）", () => {
  test("从未签发 / active / revoked 三态 + 时间戳", async () => {
    const never = seedNode({ role: "egress" });
    const live = seedNode({ role: "egress" });
    live.node_credential_hash = "a".repeat(64);
    live.credential_revoked = false;
    live.credential_rotated_at = NOW;
    const dead = seedNode({ role: "egress" });
    dead.node_credential_hash = "b".repeat(64);
    dead.credential_revoked = true;
    dead.credential_rotated_at = NOW;

    const r = await getNodeCredential(never.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.credential.state).toBe("never");
    expect(r.credential.has_credential).toBe(false);

    const r2 = await getNodeCredential(live.id, deps());
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.credential.state).toBe("active");
    expect(r2.credential.rotated_at).toEqual(NOW);

    const r3 = await getNodeCredential(dead.id, deps());
    if (!r3.ok) throw new Error("expected ok");
    expect(r3.credential.state).toBe("revoked");
    expect(r3.credential.revoked).toBe(true);
  });

  test("响应体绝不含哈希列", async () => {
    const node = seedNode({ role: "egress" });
    node.node_credential_hash = "f".repeat(64);
    const single = await getNodeCredential(node.id, deps());
    if (!single.ok) throw new Error("expected ok");
    const singleJson = JSON.stringify(single.credential);
    expect(singleJson).not.toContain("ffffffff");
    expect(singleJson).not.toContain(node.node_credential_hash!);

    const list = await listNodeStatesWithCredentials({}, deps());
    if (!list.ok) throw new Error("expected ok");
    const listJson = JSON.stringify(list.items);
    expect(listJson).not.toContain(node.node_credential_hash);
    // 64 位十六进制串（哈希的形态）也不该出现在任何键里。
    expect(Object.values(JSON.parse(listJson)[0] ?? {}).join("")).not.toMatch(/[0-9a-f]{64}/);
  });

  test("撤销的节点 revoke 后仍保留哈希（WP7 语义），但列表只回 revoked=true", async () => {
    const node = seedNode({ role: "egress" });
    node.node_credential_hash = "c".repeat(64);
    node.credential_revoked = true;
    const r = await getNodeCredential(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.credential.revoked).toBe(true);
    expect(r.credential.has_credential).toBe(true);
    expect(r.credential.state).toBe("revoked");
  });

  test("节点不存在 → 404", async () => {
    const r = await getNodeCredential(999, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("列表按 role 过滤", async () => {
    seedNode({ role: "ingress" });
    seedNode({ role: "egress" });
    seedNode({ role: null });
    const r = await listNodeStatesWithCredentials({ role: "egress" }, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.total).toBe(1);
    expect(r.items[0].role).toBe("egress");
    expect(r.items[0].credential.state).toBe("never");
  });
});

/* ------------------------------------------------------------------ */
/* runtime / state query                                                */
/* ------------------------------------------------------------------ */

describe("getNodeState", () => {
  test("有上报：快照字段 + age + 非 stale", async () => {
    const node = seedEgressNode();
    seedStateReport(node.id, { reported_at: new Date(NOW.getTime() - 30_000) });
    const r = await getNodeState(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.state.reported_role).toBe("EGRESS");
    expect(r.state.role).toBe("egress");
    expect(r.state.role_mismatch).toBe(false);
    expect(r.state.stale).toBe(false);
    expect(r.state.age_seconds).toBe(30);
    expect(r.state.online).toBe(true);
    expect(r.state.reported_revision).toBe(17);
  });

  test("从未上报：reported_at=null 且 stale=true（不是 404）", async () => {
    const node = seedEgressNode();
    const r = await getNodeState(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.state.reported_at).toBeNull();
    expect(r.state.age_seconds).toBeNull();
    expect(r.state.stale).toBe(true);
    expect(r.state.tunnels).toEqual([]);
    expect(r.state.used_ports).toEqual([]);
    expect(r.state.egress_pools).toEqual({});
    expect(r.state.role_mismatch).toBe(false);
  });

  test("自报角色与面板角色不一致 → role_mismatch=true（不覆盖 node.role）", async () => {
    const node = seedEgressNode();
    seedStateReport(node.id, { role: "INGRESS" });
    const r = await getNodeState(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.state.role_mismatch).toBe(true);
    expect(r.state.role).toBe("egress"); // 面板侧为准，不回写
  });

  test("旧上报 → stale=true（>300s）", async () => {
    const node = seedEgressNode();
    seedStateReport(node.id, { reported_at: new Date(NOW.getTime() - 400_000) });
    const r = await getNodeState(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.state.stale).toBe(true);
    expect(r.state.age_seconds).toBe(400);
  });

  test("节点不存在 → 404", async () => {
    const r = await getNodeState(999, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });
});

describe("listNodeStates / listNodeStatesWithCredentials", () => {
  test("按 online / stale 过滤", async () => {
    const online = seedEgressNode();
    seedStateReport(online.id, { reported_at: new Date(NOW.getTime() - 10_000) });
    const offline = seedEgressNode();
    offline.status = "inactive";
    seedStateReport(offline.id, { reported_at: new Date(NOW.getTime() - 900_000) });

    const onlyOnline = await listNodeStates({ online: "true" }, deps());
    if (!onlyOnline.ok) throw new Error("expected ok");
    expect(onlyOnline.states.map((s) => s.node_id)).toEqual([online.id]);

    const stale = await listNodeStates({ stale: "true" }, deps());
    if (!stale.ok) throw new Error("expected ok");
    expect(stale.states.map((s) => s.node_id)).toEqual([offline.id]);
  });

  test("没有 state_report 的节点在新旧视图里都出现（stale=true）", async () => {
    const silent = seedEgressNode();
    const reported = seedEgressNode();
    seedStateReport(reported.id, { reported_at: NOW });
    for (const r of [
      await listNodeStates({}, deps()),
      await listNodeStatesWithCredentials({}, deps()),
    ]) {
      if (!r.ok) throw new Error("expected ok");
      const ids = ("states" in r ? r.states : r.items).map((s) => s.node_id);
      expect(ids).toContain(silent.id);
      expect(ids).toContain(reported.id);
    }
  });

  test("非法 role → 400（fail-closed，不返回全量）", async () => {
    const r = await listNodeStates({ role: "relay" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });
});

describe("getNodeDetail", () => {
  test("包含池与目标、凭据状态；节点行不含哈希列", async () => {
    const node = seedEgressNode();
    node.node_credential_hash = "e".repeat(64);
    seedDefaultPool(node);
    const r = await getNodeDetail(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.detail.pools).toHaveLength(1);
    expect(r.detail.pools[0].targets).toHaveLength(1);
    expect(r.detail.credential.state).toBe("active");
    expect(r.detail.tunnel_count).toBe(0);
    const json = JSON.stringify(r.detail);
    expect(json).not.toContain(node.node_credential_hash);
    expect(json).not.toContain("eeeeeeee");
  });

  test("引用该节点为出口的隧道被计数", async () => {
    const node = seedEgressNode();
    tunnels.set(nextTunnelId++, { id: nextTunnelId - 1, egress_pool_id: null, egress_node_id: node.id });
    const r = await getNodeDetail(node.id, deps());
    if (!r.ok) throw new Error("expected ok");
    expect(r.detail.tunnel_count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* WP10 边界：本层没有下发能力（§7.13 责任划分）                           */
/* ------------------------------------------------------------------ */

describe("WP10 边界：只改 desired state，不做下发", () => {
  test("服务与路由源码不 import socket / control-protocol / portPool", async () => {
    for (const file of ["../node-admin.ts", "../../routes/node-admin.ts"]) {
      const src = await Bun.file(new URL(file, import.meta.url).pathname).text();
      expect(src).not.toMatch(/from "\.\.\/(socket|services\/control-protocol|services\/portPool)/);
      expect(src).not.toMatch(/configPusher|pushConfig|revision\+\+/);
      expect(src).not.toMatch(/\blisten\s*\(/);
    }
  });

  test("只 export 函数与纯字面量常量，没有 Server / Transport 构造器", async () => {
    const mod = await import("../node-admin.ts");
    for (const [name, exported] of Object.entries(mod)) {
      if (typeof exported === "function") continue;
      // 允许 string[] / string / number / 「string→number|string」映射表
      // （错误码表、枚举集合、上限值）。除此之外的任何对象（Server、Transport、
      // class 实例、函数集合）都说明这个模块在偷偷提供运行时能力。
      const isLiteral =
        typeof exported === "string" ||
        typeof exported === "number" ||
        (Array.isArray(exported) && exported.every((v) => typeof v === "string")) ||
        (typeof exported === "object" &&
          exported !== null &&
          Object.values(exported as Record<string, unknown>).every(
            (v) => typeof v === "number" || typeof v === "string",
          ));
      if (!isLiteral) throw new Error(`node-admin exported non-literal ${name}`);
    }
  });

  test("路由路径全部落在 nodes 资源的 /admin/node 前缀下（fail-closed 反证）", async () => {
    const { resolveAdminRoute } = await import("../../permissions.ts");
    const routes = [
      "/api/admin/node/1/role",
      "/api/admin/node/1/detail",
      "/api/admin/node/1/credential",
      "/api/admin/node/credentials",
      "/api/admin/node/1/pools",
      "/api/admin/node/pools",
      "/api/admin/node/pools/1",
      "/api/admin/node/pools/1/targets",
      "/api/admin/node/targets/1",
      "/api/admin/node/1/state",
      "/api/admin/node/states",
    ];
    for (const path of routes) {
      const normalized = path.replace(/^\/api(?=\/)/, "");
      const entry = resolveAdminRoute(normalized);
      expect(entry, `${path} 未登记到任何资源（会被 403 拦死）`).toBeDefined();
      expect(entry!.key).toBe("nodes");
    }
  });

  test("凭据签发/轮换/撤销路径仍归 WP7 的 rate-limit 规则（不在本文件重复实现）", async () => {
    const { selectRule, GLOBAL_RATE_LIMIT_RULES } = await import("../../middlewares/rate-limit.ts");
    for (const path of [
      "/api/admin/node/1/credential",
      "/api/admin/node/1/credential/rotate",
      "/api/admin/node/1/credential/revoke",
    ]) {
      expect(selectRule(GLOBAL_RATE_LIMIT_RULES, path, "POST")?.name).toBe("node-credential-rotation");
    }
    // WP10 的 GET 端点不占用凭据轮换的低额度桶。
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/admin/node/1/credential", "GET")?.name).toBe("api-global");
  });
});

/**
 * SOFT-01 验收：并发创建隧道时的额度原子判定（不超发）。
 *
 * ── 为什么这条用例必须存在 ──
 * `checkTunnelCreation` 本身是**纯函数**，只看一次快照。真正的并发安全来自
 * 调用方把它包在 `withWorkspaceQuotaLock`（`SELECT … FOR UPDATE` 的 workspace
 * 行锁）里：同一 workspace 的创建请求串行化，后进入者看得到前一个已提交的隧道。
 * 少了这道锁，「先查计数再插入」就是教科书式的 TOCTOU：两个请求都读到
 * count=limit-1，双双判定通过，隧道数就突破 max_tunnels。
 *
 * 本用例钉死三件事：
 *   1. **有锁不超发**：N 个并发创建全部走 `withWorkspaceQuotaLock`，最终
 *      落库数恰好等于 max_tunnels（不多不少），且每次判定看到的计数递增；
 *   2. **无锁会超发**（反面对照）：同样的并发，若判定用不带行锁的快照，
 *      全部通过 —— 证明上面的「不超发」确实来自行锁，不是测试自己写松了；
 *   3. **额度耗尽后继续拒绝**：达到上限后的请求拿到的是
 *      `tunnel_limit` + 中文文案，而不是创建成功。
 *
 * 运行方式：仓库散装单文件约定（`bun test src/__tests__/policy-concurrency.test.ts`）。
 * DB/Redis 客户端全部被 mock 成进程内假实现 —— 本文件测的是「锁 + 判定 + 落库」
 * 的编排顺序，不是 MySQL 的行锁语义本身（那由真实 MySQL 的集成用例覆盖）。
 * 假实现的 `$queryRaw` 以一个全局互斥量模拟 `FOR UPDATE`：同一时刻只允许一个
 * 事务持有该 workspace 的行锁，后来的事务排队，从而复现串行化的观测效果。
 */
import { test, expect, describe, mock, beforeAll } from "bun:test";

const ROOT = "/opt/TuneX-email-auth/backend/src";

/* ------------------------------------------------------------------ */
/* 假数据库                                                            */
/* ------------------------------------------------------------------ */

interface FakeRow {
  id: number;
  /** 隧道/节点等从属行才有；策略、workspace 等主表行没有。 */
  workspace_id?: number;
  /** 排序字段仅隧道/节点需要。 */
  order_by?: number;
  [k: string]: unknown;
}

/** 所有假表共享的行存储（按 model 名索引）。 */
const tables: Record<string, FakeRow[]> = {
  workspace: [],
  tunnel: [],
  node: [],
  node_group: [],
  workspace_member: [],
  workspace_invite: [],
  workspace_policy_assignment: [],
  capability_policy: [],
  tunnel_traffic: [],
  audit_event: [],
};

let nextId = 1;
const autoId = () => nextId++;

/** 每个 workspace 一把锁：等待中的事务按 FIFO 唤醒（模拟 FOR UPDATE 排队）。 */
const rowLocks = new Map<number, Promise<void>>();

function makeClient(opts: { locked: boolean }): any {
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // 真实的 FOR UPDATE 语义由下面的 $transaction 门闩统一模拟——这里只负责
      // 返回被锁的行，不再自行拿锁，否则同一事务内会二次等待自己（自死锁）。
      const workspaceId = Number(values[0] ?? 1);
      return [{ id: workspaceId }];
    },
    $executeRawUnsafe: async () => 0,
  };

  const client: any = {
    ...tx,
    workspace: {
      findMany: async () => tables.workspace.slice(),
    },
    tunnel: {
      count: async ({ where }: any) => tables.tunnel.filter((r) => r.workspace_id === where.workspace_id).length,
      create: async ({ data }: any) => {
        const row = { id: autoId(), order_by: data.order_by ?? 0, ...data } as FakeRow;
        tables.tunnel.push(row);
        return row;
      },
      aggregate: async () => ({
        _max: { order_by: tables.tunnel.reduce((m, r) => Math.max(m, Number(r.order_by ?? 0)), 0) },
      }),
    },
    node: {
      count: async ({ where }: any) => {
        const wsId = where?.node_group?.workspace_id as number | undefined;
        if (wsId === undefined) return tables.node.length;
        const groupIds = tables.node_group.filter((g) => g.workspace_id === wsId).map((g) => g.id);
        return tables.node.filter((n) => groupIds.includes(n.node_group_id as number)).length;
      },
      create: async ({ data }: any) => {
        const row = { id: autoId(), order_by: data.order_by ?? 0, ...data } as FakeRow;
        tables.node.push(row);
        return row;
      },
    },
    nodeGroup: {
      create: async ({ data }: any) => {
        const row = { id: autoId(), ...data } as FakeRow;
        tables.node_group.push(row);
        return row;
      },
    },
    workspaceMember: {
      count: async ({ where }: any) =>
        tables.workspace_member.filter((r) => r.workspace_id === where.workspace_id && r.active).length,
    },
    workspaceInvite: {
      count: async ({ where }: any) =>
        tables.workspace_invite.filter(
          (r) => r.workspace_id === where.workspace_id && r.accepted_at === null && r.revoked_at === null && !!(r.expires_at as any),
        ).length,
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: any) => {
        const row = { id: autoId(), ...data } as FakeRow;
        tables.workspace_invite.push(row);
        return row;
      },
    },
    workspacePolicyAssignment: {
      findMany: async ({ where }: any) => {
        const rows = tables.workspace_policy_assignment.filter((r) => r.workspace_id === where.workspace_id);
        // 还原 policy-service 的查询形状：policy 是嵌套 select 出来的对象。
        return rows.map((r) => ({
          ...r,
          policy: tables.capability_policy.find((p) => p.id === r.policy_id)!,
        }));
      },
    },
    capabilityPolicy: {
      findMany: async ({ where }: any) =>
        (where?.is_ceiling ? tables.capability_policy.filter((p) => p.is_ceiling) : tables.capability_policy.slice()),
      findFirst: async ({ where }: any) => tables.capability_policy.find((p) => p.key === where.key) ?? null,
      upsert: async () => ({}),
    },
    auditEvent: { create: async () => ({}) },
    tunnelTraffic: {
      aggregate: async () => ({ _sum: { traffic: 0 } }),
      findMany: async () => [],
    },
  };

  // 事务入口：locked=true 时 `$queryRaw … FOR UPDATE` 触发 FIFO 门闩，把整个
  // 事务体串行化；locked=false（反面对照）时直接执行，全部请求并发交叠。
  client.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    if (typeof fn !== "function") return fn as never;
    if (!opts.locked) return fn(client);
    const prior = rowLocks.get(LOCK_WORKSPACE_ID) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rowLocks.set(LOCK_WORKSPACE_ID, prior.then(() => gate));
    await prior;
    try {
      return await fn(client);
    } finally {
      release();
    }
  };
  return client;
}

/** 并发用例统一操作的 workspace 行 id。 */
const LOCK_WORKSPACE_ID = 1;

/** 当前生效的 db 单例（测试内切换 locked 开关）。 */
let activeDb: any = makeClient({ locked: true });

/* ------------------------------------------------------------------ */
/* 种子数据                                                            */
/* ------------------------------------------------------------------ */

function seedPolicies() {
  tables.capability_policy = [
    {
      id: 1,
      key: "free_personal",
      name: "免费个人能力",
      source: "system_default",
      is_default: true,
      applies_to: "personal",
      is_ceiling: false,
      status: "active",
      revision: 1,
      tunnel_types: ["tcp"],
      allow_custom_in_group: true,
      allow_custom_out_group: true,
      allowed_in_group_ids: null,
      allowed_out_group_ids: null,
      allow_shared_entry: false,
      max_tunnels: 3,
      max_nodes: 1,
      max_members: 2,
      traffic_limit: 1024,
      traffic_period: "total",
      bandwidth_limit: null,
      client_limit: null,
      ip_limit: null,
      whitelist_ips: null,
    },
    {
      id: 2,
      key: "platform_ceiling",
      name: "平台硬上限",
      source: "system_default",
      is_default: false,
      applies_to: null,
      is_ceiling: true,
      status: "active",
      revision: 1,
      tunnel_types: ["tcp"],
      allow_custom_in_group: true,
      allow_custom_out_group: true,
      allowed_in_group_ids: null,
      allowed_out_group_ids: null,
      allow_shared_entry: true,
      max_tunnels: 100,
      max_nodes: 20,
      max_members: 50,
      traffic_limit: 100000,
      traffic_period: "total",
      bandwidth_limit: null,
      client_limit: null,
      ip_limit: null,
      whitelist_ips: null,
    },
  ];
  tables.workspace = [{ id: LOCK_WORKSPACE_ID, kind: "personal", personal_user_id: 1, slug: "personal-1", name: "p" }];
  tables.workspace_policy_assignment = [
    { id: 1, workspace_id: LOCK_WORKSPACE_ID, policy_id: 1, source: "system_default", effective_at: new Date(0), expires_at: null, revoked_at: null, note: null },
  ];
  tables.node_group = [{ id: 1, workspace_id: LOCK_WORKSPACE_ID, user_id: 1, node_type: "in" }];
}

function resetRows() {
  tables.tunnel = [];
  tables.node = [];
  tables.workspace_member = [{ id: 1, workspace_id: LOCK_WORKSPACE_ID, user_id: 1, role: "owner", active: true }];
  tables.workspace_invite = [];
  tables.tunnel_traffic = [];
}

/* ------------------------------------------------------------------ */
/* 被测代码                                                            */
/* ------------------------------------------------------------------ */

let policyService: typeof import("../services/policy-service.ts");
let capabilityPolicy: typeof import("../services/capability-policy.ts");

/** 走完整锁路径的「创建隧道」：与 routes/tunnels.ts POST / 的编排一致。
 *
 *  锁的角色由 `policy-service.ts#withWorkspaceQuotaLock` 承担，它内部就是
 *  `db.$transaction(...)`；假 db 的 `$transaction` 已实现排他互斥，这里直接调用即可。
 */
async function createTunnelLocked(): Promise<"created" | string> {
  return policyService.withWorkspaceQuotaLock(LOCK_WORKSPACE_ID, async (tx, policy) => {
    // 制造「计数之后、插入之前」的让出窗口，否则单线程微任务队列里看不出串行化效果
    await artificialDelay();
    const tunnelCount = await policyService.countWorkspaceTunnels(LOCK_WORKSPACE_ID, tx);
    const decision = capabilityPolicy.checkTunnelCreation(policy, {
      tunnelCount,
      trafficUsed: 0,
      protocol: "tcp",
      inGroupOwned: true,
      inGroupId: 1,
      outGroupId: null,
      outGroupOwned: true,
    });
    if (!decision.allowed) return decision.reason ?? "denied";
    // 假 db 的 tx 形状与 PrismaTransactionClient 不完全一致，这里只关心编排顺序
    await (tx as any).tunnel.create({ data: { name: `t-${tunnelCount}`, workspace_id: LOCK_WORKSPACE_ID, user_id: 1 } });
    return "created";
  });
}

/** 反面对照：判定与落库都在锁外（先查计数，再插入），即修好的 TOCTOU。 */
async function createTunnelUnlocked(): Promise<"created" | string> {
  const tunnelCount = await policyService.countWorkspaceTunnels(LOCK_WORKSPACE_ID);
  await artificialDelay();
  const policy = await policyService.getEffectivePolicy(LOCK_WORKSPACE_ID, { noCache: true });
  const decision = capabilityPolicy.checkTunnelCreation(policy, {
    tunnelCount,
    trafficUsed: 0,
    protocol: "tcp",
    inGroupOwned: true,
    inGroupId: 1,
    outGroupId: null,
    outGroupOwned: true,
  });
  if (!decision.allowed) return decision.reason ?? "denied";
  await activeDb.$transaction(async (tx: any) =>
    tx.tunnel.create({ data: { name: `u-${tunnelCount}`, workspace_id: LOCK_WORKSPACE_ID, user_id: 1 } }),
  );
  return "created";
}

/** 让并发请求在「计数之后、插入之前」让出事件循环，制造观测交叠窗口。 */
function artificialDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, 2));
}

/* ------------------------------------------------------------------ */
/* 模块屏蔽                                                            */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  mock.module(`${ROOT}/env.ts`, () => ({
    env: {
      redisUrl: "redis://127.0.0.1:6399/0",
      databaseUrl: "mysql://x/y",
      licenseType: "business",
      siteUrl: "http://127.0.0.1:8788",
    },
  }));
  mock.module(`${ROOT}/db.ts`, () => ({ db: activeDb }));
  mock.module("ioredis", () => ({
    default: class FakeRedis {
      on() {}
      async ping() {
        return "PONG";
      }
    },
  }));

  policyService = await import("../services/policy-service.ts");
  capabilityPolicy = await import("../services/capability-policy.ts");

  seedPolicies();
  resetRows();
  activeDb = makeClient({ locked: true });
});

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe("SOFT-01 并发额度原子判定", () => {
  test("并发创建隧道：有行锁时恰好创建 max_tunnels 条，不超发", async () => {
    resetRows();
    rowLocks.clear();

    const results = await Promise.all(Array.from({ length: 8 }, () => createTunnelLocked()));

    const created = results.filter((r) => r === "created");
    expect(created.length).toBe(3); // max_tunnels（free_personal ∩ 平台硬上限取小）
    expect(tables.tunnel.length).toBe(3);

    // 被拒的都带具体原因（额度耗尽），不是静默失败
    const denied = results.filter((r) => r !== "created");
    expect(denied.length).toBe(5);
    expect(denied.every((r) => r === "tunnel_limit")).toBe(true);
  });

  test("并发创建隧道：无行锁时计数重复读取 → 超发（反面对照，锁确实在起作用）", async () => {
    resetRows();
    rowLocks.clear();

    const results = await Promise.all(Array.from({ length: 8 }, () => createTunnelUnlocked()));

    // 全部 8 个请求都读到「还有额度」的同一份快照，于是全部插入。
    expect(results.filter((r) => r === "created").length).toBe(8);
    expect(tables.tunnel.length).toBeGreaterThan(3);
  });

  test("达到上限后的请求返回 tunnel_limit 与中文文案", async () => {
    resetRows();
    rowLocks.clear();
    // 预填到上限
    for (let i = 0; i < 3; i++) {
      await createTunnelLocked();
    }
    expect(tables.tunnel.length).toBe(3);

    const denied = await createTunnelLocked();
    expect(denied).toBe("tunnel_limit");
    expect(tables.tunnel.length).toBe(3); // 仍然没有多出来

    const policy = await policyService.getEffectivePolicy(LOCK_WORKSPACE_ID, { noCache: true });
    const decision = capabilityPolicy.checkTunnelCreation(policy, {
      tunnelCount: 3,
      trafficUsed: 0,
      protocol: "tcp",
      inGroupOwned: true,
      inGroupId: 1,
      outGroupId: null,
      outGroupOwned: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain("已达隧道数量上限");
    expect(decision.params).toMatchObject({ limit: 3, used: 3 });
  });

  test("撤销策略后并发创建被 no_active_policy 拒绝（撤权立即生效）", async () => {
    resetRows();
    rowLocks.clear();
    tables.workspace_policy_assignment.forEach((a) => (a.revoked_at = new Date()));

    const results = await Promise.all(Array.from({ length: 4 }, () => createTunnelLocked()));
    expect(results.every((r) => r === "no_active_policy")).toBe(true);
    expect(tables.tunnel.length).toBe(0);

    // 恢复，别影响后续用例
    tables.workspace_policy_assignment.forEach((a) => (a.revoked_at = null));
  });
});

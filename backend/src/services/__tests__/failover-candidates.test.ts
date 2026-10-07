/**
 * V5-WP17.1 —— 入口候选**同源化** + 契约 D4 收口（首选入口的存储与回切）。
 *
 * 钉住的东西：
 *
 * ① **两处判定必须同源**。故障转移循环与 Route Profile 编译器各自回答"这台机器能不能当入口"，
 *    两边各写一份过滤的症状是"编译器认为可用、迁移却挑了一台指挥不动的机器"——两处看起来
 *    各自都对，只是**不同**。所以这里既有行为断言（同一份函数的判定表），也有**结构性断言**
 *    （两边都引用同一模块、且旧的启发式已经消失）。
 * ② **transit 与 egress 同口径**。抽公共实现时我一度把 transit 写成只接受 `both`，那会
 *    **悄悄收紧三跳准入**（`role=egress` 的机器今天能当中转，改完就不能了）。重构的前提是
 *    不改变任何一方的语义，所以这条单独钉住。
 * ③ **失败必须可区分**：原因码要指出**第一个**不满足的条件，而不是一个笼统的"不可用"。
 * ④ **首选入口（D4）**：偏好能真的被写下来（这是"写了功能但没有任何写入路径"的收口），
 *    且设置偏好会**重新计数**——否则旧偏好攒下的连续健康次数会被算到新节点头上，
 *    等于绕过 `FAILBACK_HEALTHY_CHECKS` 要防的事。
 * ⑤ **显式停用的成员不参与回切**（task-47，P1 缺陷现场）：`is_enabled=false` 只过滤了
 *    `candidate`，`preferred` 仍原样透出 ⇒ 停用成员照样被算成回切目标、`decideFailover`
 *    给出 `action=failback, to_node_id=6`。三处（候选 / 首选 / 写路径与读投影）现在共用
 *    同一份 `IngressOrderIndex`，且这条用例**跑完整决策链**断言行为，不做静态字符串匹配。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateRejection, roleAcceptsPosition, type CandidateFacts } from "../ingress-candidate.ts";
import { pickFailoverDestination } from "../failover-loop.ts";
import { buildDecisionInput, readFailoverDecisionFacts } from "../failover-executor.ts";
import { decideFailover } from "../failover-policy.ts";
import {
  buildIngressMemberViews,
  PREFERRED_INGRESS_ERROR_CODES,
  preferredIngressOf,
  setPreferredIngressNode,
} from "../preferred-ingress.ts";
import type { IngressMemberIntentRow, IngressMemberRow, PreferredIngressDb } from "../preferred-ingress.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = new Date("2026-10-05T04:00:00Z");

/** 一台"什么都对"的节点；每个用例只改它需要的那一维。 */
function node(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    node_id: 5,
    node_group_id: 2,
    role: "ingress",
    lifecycle: "active",
    status: "active",
    last_seen_at: new Date(NOW.getTime() - 10_000),
    has_credential: true,
    credential_revoked: false,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* ① / ③ 共用判定表                                                    */
/* ------------------------------------------------------------------ */

describe("V5-WP17.1: 候选判定的唯一实现（准入 → 生命周期 → 角色 → 在线）", () => {
  test("全部满足 ⇒ 合格", () => {
    expect(candidateRejection(node(), "ingress", { requireOnline: true, now: NOW })).toBeNull();
  });

  test("凭据被吊销报**能行动的那个原因**，而不是笼统的「它离线」", () => {
    // `deriveConnection` 把"吊销"和"很久没上报"都归成 offline；运维要能分出"去重新登记"
    // 与"等它回来"，所以吊销必须先于在线判定报出来。
    expect(candidateRejection(node({ credential_revoked: true }), "ingress", { requireOnline: true, now: NOW })).toBe(
      "node_credential_revoked",
    );
    // 没有被吊销、只是太久没上报 ⇒ 才是在线问题。
    expect(
      candidateRejection(node({ last_seen_at: new Date(NOW.getTime() - 3_600_000) }), "ingress", {
        requireOnline: true,
        now: NOW,
      }),
    ).toBe("node_not_online");
  });

  test("生命周期：非 active 被**准入**拦下（白名单只能收窄、放不宽）", () => {
    const suspended = node({ lifecycle: "suspended" });
    // 不是 `lifecycle_not_allowed` 而是准入条件码 —— 准入先判，且它只接受 active。
    expect(candidateRejection(suspended, "ingress", { now: NOW })).not.toBeNull();
    // 这条断言记录了一个**注释与现实不符**的事实：把白名单写成含 suspended 也放不进去。
    expect(candidateRejection(suspended, "ingress", { allowedLifecycles: ["active", "suspended"], now: NOW })).not.toBeNull();
  });

  test("角色：未声明与不匹配是两个码（排障时要分得开）", () => {
    expect(candidateRejection(node({ role: null }), "ingress", { now: NOW })).toBe("role_undeclared");
    expect(candidateRejection(node({ role: "egress" }), "ingress", { now: NOW })).toBe("role_mismatch");
    expect(candidateRejection(node({ role: "both" }), "ingress", { now: NOW })).toBeNull();
  });

  test("**transit 与 egress 同口径**：`role=egress` 的机器仍然是合格的中转", () => {
    // 抽公共实现时这条差点被我改成只接受 `both` —— 那会悄悄收紧三跳准入。
    expect(roleAcceptsPosition("egress", "transit")).toBe(true);
    expect(roleAcceptsPosition("both", "transit")).toBe(true);
    expect(roleAcceptsPosition("ingress", "transit")).toBe(false);
    expect(candidateRejection(node({ role: "egress" }), "transit", { now: NOW })).toBeNull();
  });

  test("在线是一个**显式开关**：编译器不要求，故障转移要求", () => {
    const stale = node({ last_seen_at: new Date(NOW.getTime() - 60 * 60_000) });
    expect(candidateRejection(stale, "ingress", { now: NOW })).toBeNull();
    expect(candidateRejection(stale, "ingress", { requireOnline: true, now: NOW })).toBe("node_not_online");
  });
});

/* ------------------------------------------------------------------ */
/* ① 结构性：两处真的同源                                              */
/* ------------------------------------------------------------------ */

describe("V5-WP17.1: 两处判定真的同源（结构性断言）", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  test("编译器与故障转移循环都引用同一模块，且编译器不再自己调 nodeAdmission", () => {
    const compiler = read("services/route-profile-compiler.ts");
    const loop = read("services/failover-loop.ts");
    expect(compiler).toContain("ingress-candidate.ts");
    expect(loop).toContain("ingress-candidate.ts");
    // 各自再调一次 nodeAdmission 就是两份判定重新分叉的开始。
    expect(compiler).not.toContain("nodeAdmission(");
    expect(loop).not.toContain("nodeAdmission(");
  });

  test("旧的启发式（上报时间戳当作「在线」）已经从候选来源里消失", () => {
    const loop = read("services/failover-loop.ts");
    // `reported_at > now - 5min` 是"最近有人说它活着"的代理指标，与"面板能指挥它"不是同一件事。
    expect(loop).not.toContain("state_report: { reported_at:");
    expect(loop).not.toContain("5 * 60_000");
  });
});

/* ------------------------------------------------------------------ */
/* ④ 首选入口：写入路径                                                */
/* ------------------------------------------------------------------ */

function stubPreferredDb(over: {
  tunnel?: Record<string, unknown> | null;
  node?: Record<string, unknown> | null;
}): PreferredIngressDb & { writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    tunnel: {
      findFirst: async () =>
        over.tunnel === undefined
          ? { id: 11, in_node_group_id: 2, ingress_node_id: 5, preferred_ingress_node_id: null }
          : over.tunnel,
      update: async (args: unknown) => {
        writes.push((args as { data: Record<string, unknown> }).data);
        return {};
      },
    },
    node: {
      findUnique: async () =>
        over.node === undefined
          ? {
              id: 6,
              node_group_id: 2,
              role: "ingress",
              lifecycle: "active",
              status: "active",
              last_seen_at: NOW,
              node_credential_hash: "hash",
              credential_revoked: false,
            }
          : over.node,
    },
  };
}

describe("V5-WP17.1（D4 收口）: 首选入口的写入路径", () => {
  test("设置成功：写列 + **把连续健康计数清零**", async () => {
    const db = stubPreferredDb({});
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: 11, nodeId: 6 });
    expect(result.ok).toBe(true);
    expect(db.writes).toEqual([{ preferred_ingress_node_id: 6, failback_healthy_checks: 0 }]);
  });

  test("清除偏好（node_id = null）同样可行，并回到「不回切」的行为", async () => {
    const db = stubPreferredDb({});
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: 11, nodeId: null });
    expect(result.ok).toBe(true);
    expect(db.writes[0]?.preferred_ingress_node_id).toBeNull();
  });

  test("组外节点被拒（偏好一个组外的机器没有任何意义）", async () => {
    const db = stubPreferredDb({ node: { id: 6, node_group_id: 99, role: "ingress" } });
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: 11, nodeId: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PREFERRED_INGRESS_ERROR_CODES.preferred_node_group_mismatch);
    expect(db.writes).toEqual([]);
  });

  test("角色当不了入口的节点被拒（否则每一拍都算出一个永不满足的条件）", async () => {
    const db = stubPreferredDb({
      node: { id: 6, node_group_id: 2, role: "egress", lifecycle: "active", status: "active", node_credential_hash: "hash" },
    });
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: 11, nodeId: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PREFERRED_INGRESS_ERROR_CODES.preferred_role_mismatch);
  });

  test("**当前离线也能设为首选**：偏好说的是「它回来后优先归它」，不是在线的门槛", async () => {
    const db = stubPreferredDb({
      node: {
        id: 6,
        node_group_id: 2,
        role: "ingress",
        lifecycle: "active",
        status: "offline",
        last_seen_at: new Date(NOW.getTime() - 6 * 60 * 60_000),
        node_credential_hash: "hash",
        credential_revoked: false,
      },
    });
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: 11, nodeId: 6 });
    expect(result.ok).toBe(true);
  });

  test("跨 workspace 的转发 ⇒ 找不到（作用域先于一切）", async () => {
    const db = stubPreferredDb({ tunnel: null });
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: 11, nodeId: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PREFERRED_INGRESS_ERROR_CODES.preferred_not_found);
  });

  test("读投影：非数字一律按「没有偏好」处理（不回切）", () => {
    expect(preferredIngressOf({ preferred_ingress_node_id: 6 })).toBe(6);
    expect(preferredIngressOf({ preferred_ingress_node_id: null })).toBeNull();
    expect(preferredIngressOf({})).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ④ 首选入口：候选来源真的用它                                        */
/* ------------------------------------------------------------------ */

function stubCandidateDb(rows: Array<Record<string, unknown>>, preferred: number | null) {
  return {
    tunnel: { findUnique: async () => ({ in_node_group_id: 2, preferred_ingress_node_id: preferred }) },
    node: { findMany: async () => rows },
  };
}

/**
 * 替身行必须是**真实 DB 形状**：`Node` 没有 `has_credential` 列，它是派生的
 * （`node_credential_hash != null`）。本文件原来给的是 `has_credential: true` —— 那正是
 * "替身比真库更宽松"的例子：字段写错在单测里永远通过，直到真拓扑里 Prisma 抛
 * `Unknown field` 才暴露（该错误曾让每一拍 failover 扫描中止，闸门与 DNS 后继因此从未运行）。
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: 6,
  node_group_id: 2,
  role: "ingress",
  lifecycle: "active",
  status: "active",
  last_seen_at: NOW,
  node_credential_hash: "hash",
  credential_revoked: false,
  ...over,
});

describe("V5-WP17.1: 候选来源用同一份判定，并真的读偏好", () => {
  test("不合格的备用节点不会被选中（今天它会被选中，然后迁移到一台指挥不动的机器上）", async () => {
    const db = stubCandidateDb([row({ id: 6, lifecycle: "suspended" })], null);
    const picked = await pickFailoverDestination({ tunnel_id: 11, workspace_id: 7, owner_node_id: 5, now: NOW }, db);
    expect(picked.candidate_node_id).toBeNull();
  });

  test("合格节点里按 id 取第一个（没有偏好时不做「更聪明」的排序）", async () => {
    const db = stubCandidateDb([row({ id: 8 }), row({ id: 6 })], null);
    const picked = await pickFailoverDestination({ tunnel_id: 11, workspace_id: 7, owner_node_id: 5, now: NOW }, db);
    expect(picked.candidate_node_id).toBe(6);
  });

  test("偏好 ≠ 现任 ⇒ 原样报出（即使它今天不合格，判定交给策略去解释）", async () => {
    const db = stubCandidateDb([row({ id: 8 }), row({ id: 6, status: "offline", last_seen_at: new Date(NOW.getTime() - 3_600_000) })], 6);
    const picked = await pickFailoverDestination({ tunnel_id: 11, workspace_id: 7, owner_node_id: 5, now: NOW }, db);
    expect(picked.preferred_node_id).toBe(6);
    // 但它**不会**被当成迁移候选。
    expect(picked.candidate_node_id).toBe(8);
  });

  test("偏好就是现任 ⇒ 报 null（回切的定义就是离开现任，否则每拍一条无意义的条件不满足）", async () => {
    const db = stubCandidateDb([row({ id: 8 })], 5);
    const picked = await pickFailoverDestination({ tunnel_id: 11, workspace_id: 7, owner_node_id: 5, now: NOW }, db);
    expect(picked.preferred_node_id).toBeNull();
  });

  test("没有偏好 ⇒ null（今天的行为：不回切）", async () => {
    const db = stubCandidateDb([row({ id: 8 })], null);
    const picked = await pickFailoverDestination({ tunnel_id: 11, workspace_id: 7, owner_node_id: 5, now: NOW }, db);
    expect(picked.preferred_node_id).toBeNull();
  });
});

/* ================================================================== */
/* ⑤ task-47：显式停用的成员不得参与回切                                 */
/* ================================================================== */
//
// ── 缺陷现场（P1）──
// `forward_ingress_member.is_enabled=false` 只过滤了 `candidate`，`preferredId` 仍原样透出：
// 节点 6 被显式停用后，回切决策照样给出 `action=failback, to_node_id=6`（同一拍候选却是 null）。
// 三处必须用**同一份** `IngressOrderIndex`：候选选择、回切目标、写路径与读投影。
//
// 用例全部走**真实函数链**（`pickFailoverDestination` → `readFailoverDecisionFacts` →
// `decideFailover`）：只有行为断言才挡得住"改回去"，静态字符串匹配挡不住。

const GROUP = 2;
const OWNER = 5;
/** 列里残留的偏好：被显式停用的那一台。 */
const DISABLED = 6;
const ENABLED = 8;
const TUNNEL = 11;

/** 成员次序：`disableFirst` 决定节点 6（列里残留的偏好）是被显式停用还是启用。 */
const intentRows = (disableFirst: boolean): IngressMemberIntentRow[] => [
  { node_id: DISABLED, priority: 0, is_enabled: !disableFirst },
  { node_id: ENABLED, priority: 1, is_enabled: true },
];

interface TestNodeRow extends IngressMemberRow {
  node_credential_hash: string;
  credential_revoked: boolean;
  lifecycle: string;
  status: string;
}

function nodeRow(id: number, over: Partial<TestNodeRow> = {}): TestNodeRow {
  return {
    id,
    node_id: `node-${id}`,
    role: "ingress",
    lifecycle: "active",
    status: "active",
    last_seen_at: NOW,
    node_group_id: GROUP,
    node_credential_hash: "hash",
    credential_revoked: false,
    ...over,
  };
}

/** 候选来源替身：与 `pickFailoverDestination` 的真实查询形状一致（含成员次序读面）。 */
function memberDb(intent: readonly IngressMemberIntentRow[] | null, throwOnRead = false) {
  return {
    tunnel: {
      findUnique: async () => ({ in_node_group_id: GROUP, preferred_ingress_node_id: DISABLED }),
    },
    node: { findMany: async () => [nodeRow(DISABLED), nodeRow(ENABLED)] },
    forwardIngressMember: {
      findMany: async () => {
        if (throwOnRead) throw new Error("intent read failed");
        return [...(intent ?? [])];
      },
    },
  };
}

/** 生产决策链：候选/偏好 → 决策事实 → 纯策略（三处必须给出同一个答案）。 */
async function decideThroughPolicy(intent: readonly IngressMemberIntentRow[] | null, throwOnRead = false) {
  const read = await readFailoverDecisionFacts(
    { tunnelId: TUNNEL, now: NOW },
    {
      db: {
        tunnel: {
          findUnique: async () => ({
            id: TUNNEL,
            workspace_id: 3,
            tunnel_mode: "direct",
            config_revision: 1,
            ingress_node_id: OWNER,
            egress_node_id: null,
            egress_pool_id: null,
            remote_host: "10.0.0.9",
            remote_port: 443,
          }),
        },
        node: { findUnique: async (args: unknown) => nodeRow((args as { where: { id: number } }).where.id) },
        targetObservation: {
          findMany: async () => [
            {
              node_id: OWNER,
              target_key: "10.0.0.9:443",
              reachable: true,
              latency_ms: 10,
              consecutive_success: 5,
              consecutive_failure: 0,
              success_rate: 1,
              observed_at: new Date(NOW.getTime() - 1_000),
              observation_source: `${OWNER}/tcp_connect`,
            },
          ],
        },
        forwardRollout: { findFirst: async () => null },
      },
      loadLease: async () => ({
        tunnel_id: TUNNEL,
        owner_node_id: OWNER,
        epoch: 2,
        lease_expires_at: new Date(NOW.getTime() + 60_000),
        revision: 1,
      }),
      // 两个开关都开、连续健康次数也够、冷却已过、候选在线且端口可用 ——
      // 唯一还能阻止回切的就是"首选成员被显式停用"这一条。正对照因此必须是 failback。
      policy: () => ({ auto_failover: true, auto_failback: true }),
      destinations: (ctx) =>
        pickFailoverDestination({ ...ctx, now: NOW }, memberDb(intent, throwOnRead)),
      portAvailability: async () => 4,
      failbackHealthyChecks: async () => 3,
    },
  );
  if (!read.ok) throw new Error(`决策事实读取失败: ${read.code}`);
  return { facts: read.facts, decision: decideFailover(buildDecisionInput(read.facts, NOW)) };
}

function stubPreferredDbWithIntent(
  intent: readonly IngressMemberIntentRow[] | null,
  options: { throwOnRead?: boolean } = {},
): PreferredIngressDb & { writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    tunnel: {
      findFirst: async () => ({
        id: TUNNEL,
        in_node_group_id: GROUP,
        ingress_node_id: OWNER,
        preferred_ingress_node_id: null,
      }),
      update: async (args: unknown) => {
        writes.push((args as { data: Record<string, unknown> }).data);
        return {};
      },
    },
    node: { findUnique: async (args: unknown) => nodeRow((args as { where: { id: number } }).where.id) },
    forwardIngressMember: {
      findMany: async () => {
        if (options.throwOnRead) throw new Error("intent read failed");
        return [...(intent ?? [])];
      },
    },
  };
}

describe("task-47: 显式停用的成员不参与回切（候选 / 首选 / 决策三处同源）", () => {
  test("停用的首选不再被报成回切目标，候选改选下一台启用的成员", async () => {
    const picked = await pickFailoverDestination(
      { tunnel_id: TUNNEL, workspace_id: 7, owner_node_id: OWNER, now: NOW },
      memberDb(intentRows(true)),
    );
    // 修复前：preferred_node_id = 6（停用的那一台）；candidate 已经是 8。
    expect(picked.preferred_node_id).toBeNull();
    expect(picked.candidate_node_id).toBe(ENABLED);
  });

  test("扫描器注入的批次序（options.order）走同一份判定：停用 ⇒ preferred 为 null", async () => {
    const picked = await pickFailoverDestination(
      { tunnel_id: TUNNEL, workspace_id: 7, owner_node_id: OWNER, now: NOW },
      memberDb(intentRows(true)),
      { order: intentRows(true) },
    );
    expect(picked.preferred_node_id).toBeNull();
    expect(picked.candidate_node_id).toBe(ENABLED);
  });

  test("次序**读不到**（抛错 ⇒ null）时既有语义逐位不变：偏好照原样报出，不凭空禁用", async () => {
    const picked = await pickFailoverDestination(
      { tunnel_id: TUNNEL, workspace_id: 7, owner_node_id: OWNER, now: NOW },
      memberDb(null, true),
    );
    expect(picked.preferred_node_id).toBe(DISABLED);
    expect(picked.candidate_node_id).toBe(DISABLED);
  });

  test("决策链：首选被显式停用 ⇒ **不发生回切**（修复前：action=failback, to_node_id=6）", async () => {
    const { facts, decision } = await decideThroughPolicy(intentRows(true));
    expect(facts.placement.preferred_node_id).toBeNull();
    expect(facts.failback).toBeNull();
    expect(decision.action).toBe("hold");
    expect(decision.migration).toBeNull();
    expect(decision.blockers.map((b) => b.reason)).toContain("owner_reachable");
    // 停用只排除那一台，不是让整个组停摆：候选仍然上岗。
    expect(facts.candidate?.node_id).toBe(ENABLED);
  });

  test("正对照：同一条链、只把 is_enabled 翻成 true ⇒ 回切照常发生（用例不是恒真）", async () => {
    const { facts, decision } = await decideThroughPolicy(intentRows(false));
    expect(facts.placement.preferred_node_id).toBe(DISABLED);
    expect(facts.failback?.candidate.node_id).toBe(DISABLED);
    expect(decision.action).toBe("failback");
    expect(decision.migration?.to_node_id).toBe(DISABLED);
  });

  test("决策链：次序读不到（异常）⇒ 回切按既有语义照常发生（一次读错误不冻结/不禁用）", async () => {
    const { decision } = await decideThroughPolicy(null, true);
    expect(decision.action).toBe("failback");
    expect(decision.migration?.to_node_id).toBe(DISABLED);
  });

  test("读投影与写路径同契约：停用成员 can_be_preferred=false + member_disabled，且不是回切目标", () => {
    const views = buildIngressMemberViews([nodeRow(OWNER), nodeRow(DISABLED), nodeRow(ENABLED)], {
      activeIngressId: OWNER,
      // 列里残留的偏好（修复前可写进去、读侧又照实投影的那种状态）。
      preferredId: DISABLED,
      now: NOW,
      intent: intentRows(true),
    });
    const disabled = views.find((view) => view.node_id === DISABLED)!;
    expect(disabled.is_preferred).toBe(true);
    expect(disabled.can_be_preferred).toBe(false);
    expect(disabled.preference_rejection).toBe("member_disabled");
    // 关键：写路径规则与回切目标投影都跟 `pickFailoverDestination` 同答案。
    expect(disabled.is_failback_target).toBe(false);
    expect(disabled.can_take_over).toBe(false);
    expect(disabled.takeover_rejection).toBe("member_disabled");

    const enabled = views.find((view) => view.node_id === ENABLED)!;
    expect(enabled.can_be_preferred).toBe(true);
    expect(enabled.preference_rejection).toBeNull();
  });

  test("写路径：被显式停用的节点拒绝设为首选，且一个字都不落库", async () => {
    const db = stubPreferredDbWithIntent(intentRows(true));
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: TUNNEL, nodeId: DISABLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PREFERRED_INGRESS_ERROR_CODES.preferred_disabled);
    expect(db.writes).toEqual([]);
  });

  test("写路径：次序里明确启用的节点照常可写（停用只挡那一台）", async () => {
    const db = stubPreferredDbWithIntent(intentRows(true));
    const result = await setPreferredIngressNode({ db }, { workspaceId: 7, tunnelId: TUNNEL, nodeId: ENABLED });
    expect(result.ok).toBe(true);
    expect(db.writes[0]?.preferred_ingress_node_id).toBe(ENABLED);
  });

  test("写路径：次序里没有这台节点 / 次序读不到 ⇒ 不凭空禁用，既有语义（离线也可写）不变", async () => {
    const notListed = stubPreferredDbWithIntent([{ node_id: ENABLED, priority: 0, is_enabled: true }]);
    const listed = await setPreferredIngressNode({ db: notListed }, { workspaceId: 7, tunnelId: TUNNEL, nodeId: DISABLED });
    expect(listed.ok).toBe(true);

    const unreadable = stubPreferredDbWithIntent(null, { throwOnRead: true });
    const offline = await setPreferredIngressNode(
      { db: unreadable },
      { workspaceId: 7, tunnelId: TUNNEL, nodeId: DISABLED },
    );
    expect(offline.ok).toBe(true);
    expect(unreadable.writes[0]?.preferred_ingress_node_id).toBe(DISABLED);
  });
});

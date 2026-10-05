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
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateRejection, roleAcceptsPosition, type CandidateFacts } from "../ingress-candidate.ts";
import { pickFailoverDestination } from "../failover-loop.ts";
import {
  PREFERRED_INGRESS_ERROR_CODES,
  preferredIngressOf,
  setPreferredIngressNode,
} from "../preferred-ingress.ts";
import type { PreferredIngressDb } from "../preferred-ingress.ts";

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

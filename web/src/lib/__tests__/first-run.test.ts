/**
 * R2 First-run —— `lib/first-run.ts` 的**纯逻辑**行为测试（无 IO / 无浏览器）。
 *
 * 盯的是产品验收里最容易被"顺手写错"的几条：
 *
 *   A. **唯一下一步**：无组→建组 / 有组无节点→加节点 / 有节点无转发→建转发 /
 *      有转发→完成；
 *   B. **persona 分派**：无 `node:manage` 与「有权限但策略未授予」是**两种**不同的
 *      真话（前者找管理员要权限，后者找管理员开能力）；
 *   C. **事实缺失 ≠ done**：任何一个计数取不到、能力投影缺失、权限未知，都必须
 *      `unknown`，绝不显示「已经完成」或「一切正常」；
 *   D. 文案键在 zh/en 两本字典里都存在且非空（不产生裸 key）。
 *
 * 跑法（web 目录）：bun test src/lib/__tests__/first-run.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  deriveFirstRunStep,
  FIRST_RUN_FACT_NAMES,
  FIRST_RUN_TEXT_KEYS,
  firstRunHref,
  firstRunQuotaText,
  firstRunTextKeys,
  NEED_OPERATOR_HINT_KEYS,
  type FirstRunDecision,
  type FirstRunFacts,
} from "@/lib/first-run";
import type { WorkspaceCapabilities } from "@/lib/api/capabilities";
import { en, zh, type Dict } from "@/lib/i18n/dictionaries";

/* ================================================================== */
/* fixtures                                                            */
/* ================================================================== */

const caps = (over: Partial<WorkspaceCapabilities> = {}): WorkspaceCapabilities => ({
  allow_custom_in_group: true,
  allow_custom_out_group: false,
  max_nodes: 1,
  nodes_used: 0,
  max_tunnels: 2,
  tunnels_used: 0,
  policy_missing: false,
  deny_message: null,
  ...over,
});

const facts = (over: Partial<FirstRunFacts> = {}): FirstRunFacts => ({
  canManageNodes: true,
  groups: 0,
  nodes: 0,
  forwards: 0,
  capabilities: caps(),
  ...over,
});

/** 点号取值（与 `lib/i18n` 的 translate 同口径，用于断言不是裸 key）。 */
function lookup(dict: Dict, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (cur, part) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined),
    dict,
  );
}

/* ================================================================== */
/* A. 唯一下一步                                                        */
/* ================================================================== */

describe("A. 事实 → 唯一下一步", () => {
  const table: [string, FirstRunFacts, FirstRunDecision][] = [
    ["没有任何资源、有权限、策略允许自建 → 建组", facts(), { step: "create_group" }],
    ["有组没节点 → 加节点", facts({ groups: 1 }), { step: "add_node" }],
    ["有组有节点没转发 → 建转发", facts({ groups: 1, nodes: 1 }), { step: "create_forward" }],
    ["已经有转发 → 完成", facts({ groups: 1, nodes: 2, forwards: 1 }), { step: "done" }],
    ["有转发（组列表为空也要先认完成的事实）", facts({ groups: 0, nodes: 1, forwards: 3 }), { step: "done" }],
    [
      "有节点但组列表为空 → 建转发（节点只能存在于组里；手上真的要动作是建转发）",
      facts({ groups: 0, nodes: 1 }),
      { step: "create_forward" },
    ],
  ];

  for (const [name, input, expected] of table) {
    test(name, () => {
      expect(deriveFirstRunStep(input)).toEqual(expected);
    });
  }

  test("计数为 0 与「取不到」是两件事：0 会继续派生，null 一律 unknown", () => {
    expect(deriveFirstRunStep(facts({ groups: 0 }))).toEqual({ step: "create_group" });
    expect(deriveFirstRunStep(facts({ groups: null }))).toEqual({ step: "unknown", missing: ["groups"] });
    expect(deriveFirstRunStep(facts({ nodes: null }))).toEqual({ step: "unknown", missing: ["nodes"] });
    expect(deriveFirstRunStep(facts({ forwards: null }))).toEqual({ step: "unknown", missing: ["forwards"] });
    expect(deriveFirstRunStep(facts({ capabilities: null }))).toEqual({
      step: "unknown",
      missing: ["capabilities"],
    });
    expect(deriveFirstRunStep(facts({ canManageNodes: null }))).toEqual({
      step: "unknown",
      missing: ["node_permission"],
    });
  });

  test("事实缺失绝不落回 done / create_group（这是最容易犯的谎）", () => {
    const partial = deriveFirstRunStep(facts({ groups: null, forwards: null, nodes: 5 }));
    expect(partial.step).toBe("unknown");
    if (partial.step === "unknown") {
      expect(partial.missing).toEqual(["groups", "forwards"]);
      expect(partial.missing).not.toContain("nodes");
    }
    expect(deriveFirstRunStep(facts({ forwards: null })).step).not.toBe("done");
    expect(deriveFirstRunStep(facts({ capabilities: null })).step).not.toBe("create_group");
  });

  test("负数 / NaN / 小数等不可用计数按「取不到」处理", () => {
    expect(deriveFirstRunStep(facts({ groups: -1 })).step).toBe("unknown");
    expect(deriveFirstRunStep(facts({ nodes: Number.NaN })).step).toBe("unknown");
    // 2.7 → 2：计数是整数语义，不因为一条脏数据卡住整个派生。
    expect(deriveFirstRunStep(facts({ nodes: 2.7, groups: 1 }))).toEqual({ step: "create_forward" });
  });
});

/* ================================================================== */
/* B. persona / entitlement 分派                                        */
/* ================================================================== */

describe("B. 无组时的两种真话（persona × entitlement）", () => {
  test("有 node:manage、策略允许自建 → 给真的自助建组", () => {
    expect(deriveFirstRunStep(facts({ canManageNodes: true }))).toEqual({ step: "create_group" });
  });

  test("没有 node:manage → need_operator(permission)：自己做不了，要找有权限的人", () => {
    expect(deriveFirstRunStep(facts({ canManageNodes: false }))).toEqual({
      step: "need_operator",
      reason: "permission",
    });
  });

  test("有 node:manage 但策略未授予 entitlement → need_operator(policy_not_granted)", () => {
    expect(
      deriveFirstRunStep(facts({ canManageNodes: true, capabilities: caps({ allow_custom_in_group: false }) })),
    ).toEqual({ step: "need_operator", reason: "policy_not_granted" });
  });

  test("工作空间完全没有有效策略（deny_scope）→ 也是 policy_not_granted，不给必失败按钮", () => {
    expect(
      deriveFirstRunStep(
        facts({
          capabilities: caps({
            allow_custom_in_group: false,
            allow_custom_out_group: false,
            max_nodes: null,
            max_tunnels: null,
            policy_missing: true,
            deny_message: "工作空间没有任何生效的能力策略",
          }),
        }),
      ),
    ).toEqual({ step: "need_operator", reason: "policy_not_granted" });
  });

  test("两者都不满足时先报权限（用户能立刻判断该找谁），而不是报一个他无法区分的策略问题", () => {
    expect(
      deriveFirstRunStep(facts({ canManageNodes: false, capabilities: caps({ allow_custom_in_group: false }) })),
    ).toEqual({ step: "need_operator", reason: "permission" });
  });

  test("已有节点时不再回到「建组 / 找管理员」：entitlement 与 persona 不改变已完成的事实", () => {
    expect(deriveFirstRunStep(facts({ groups: 1, nodes: 1, canManageNodes: false }))).toEqual({
      step: "create_forward",
    });
    expect(
      deriveFirstRunStep(facts({ groups: 1, nodes: 1, capabilities: caps({ allow_custom_in_group: false }) })),
    ).toEqual({ step: "create_forward" });
  });
});

/* ================================================================== */
/* C. 跳转                                                              */
/* ================================================================== */

describe("C. 只给真的能走通的跳转", () => {
  test("加节点 → /nodes；建转发 → /forwards", () => {
    expect(firstRunHref({ step: "add_node" })).toBe("/nodes");
    expect(firstRunHref({ step: "create_forward" })).toBe("/forwards");
  });

  test("need_operator / unknown / done 没有页面可跳（不给假入口）", () => {
    expect(firstRunHref({ step: "need_operator", reason: "permission" })).toBeNull();
    expect(firstRunHref({ step: "need_operator", reason: "policy_not_granted" })).toBeNull();
    expect(firstRunHref({ step: "unknown", missing: ["groups"] })).toBeNull();
    expect(firstRunHref({ step: "done" })).toBeNull();
    // 建组是在原地打开最小表单，不是跳走（跳到 /nodes 还要用户自己再找一次入口）。
    expect(firstRunHref({ step: "create_group" })).toBeNull();
  });
});

/* ================================================================== */
/* D. 文案键与额度行                                                    */
/* ================================================================== */

describe("D. 文案键与额度行", () => {
  test("每个步骤的 title/hint/action 键在两本字典里都存在、非空、不是裸 key", () => {
    const decisions: FirstRunDecision[] = [
      { step: "create_group" },
      { step: "need_operator", reason: "permission" },
      { step: "need_operator", reason: "policy_not_granted" },
      { step: "add_node" },
      { step: "create_forward" },
      { step: "done" },
      { step: "unknown", missing: ["groups"] },
    ];
    for (const decision of decisions) {
      const keys = firstRunTextKeys(decision);
      for (const key of [keys.title, keys.hint]) {
        for (const dict of [zh, en]) {
          const text = lookup(dict, key);
          expect(typeof text).toBe("string");
          expect(String(text).trim().length).toBeGreaterThan(0);
          expect(text).not.toBe(key);
        }
      }
      // 可执行步骤必须有 action 键，且该键两本字典都在。
      if (decision.step === "add_node" || decision.step === "create_forward" || decision.step === "create_group") {
        expect(keys.action).not.toBeNull();
        for (const dict of [zh, en]) {
          expect(typeof lookup(dict, keys.action!)).toBe("string");
        }
      }
    }
  });

  test("need_operator 的两种原因映射到两句不同的说明", () => {
    expect(firstRunTextKeys({ step: "need_operator", reason: "permission" }).hint).toBe(
      NEED_OPERATOR_HINT_KEYS.permission,
    );
    expect(firstRunTextKeys({ step: "need_operator", reason: "policy_not_granted" }).hint).toBe(
      NEED_OPERATOR_HINT_KEYS.policy_not_granted,
    );
    expect(NEED_OPERATOR_HINT_KEYS.permission).not.toBe(NEED_OPERATOR_HINT_KEYS.policy_not_granted);
  });

  test("每个 step 都有文案键定义（新增 step 时会立刻红）", () => {
    for (const step of ["create_group", "need_operator", "add_node", "create_forward", "done", "unknown"] as const) {
      expect(FIRST_RUN_TEXT_KEYS[step]).toBeDefined();
    }
    expect(FIRST_RUN_FACT_NAMES.length).toBe(5);
  });

  test("额度行：不限显示 common.unlimited；取不到就什么都不说（不写「不限」）", () => {
    const t = (key: string, params?: Record<string, string | number>) => {
      if (key === "firstRun.quotaLine") {
        return `${params?.nodesUsed}/${params?.nodesMax} · ${params?.tunnelsUsed}/${params?.tunnelsMax}`;
      }
      if (key === "common.unlimited") return "不限";
      return key;
    };
    expect(firstRunQuotaText(t, caps({ nodes_used: 1, max_nodes: 1, tunnels_used: 0, max_tunnels: 2 }))).toBe(
      "1/1 · 0/2",
    );
    expect(firstRunQuotaText(t, caps({ nodes_used: 0, max_nodes: null, tunnels_used: 0, max_tunnels: null }))).toBe(
      "0/不限 · 0/不限",
    );
    expect(firstRunQuotaText(t, null)).toBeNull();
    expect(firstRunQuotaText(t, undefined)).toBeNull();
  });
});

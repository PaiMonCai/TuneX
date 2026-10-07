/**
 * R2 First-run —— 「新装的 Workspace 下一步是什么」的**纯逻辑**（无 React / 无网络 / 无 IO）。
 *
 * ── 这个文件解决什么 ──
 * 第一次使用 TuneX 的人打开 Dashboard 时，页面上只有计数卡片和「有没有异常」，
 * 没有任何一句「你现在该做什么」。要给出那句话，只需要四个**已经存在**的事实：
 *
 *   1. 我在当前工作空间有没有 `node:manage`（能不能自己建组 / 加节点）；
 *   2. 有几个可用的入口节点组（同一份 `GET /api/node-groups` 列表）；
 *   3. 有几台节点（`GET /api/nodes`）；
 *   4. 有几条转发（`GET /api/forwards`）；
 *   加 5. 当前有效能力（`GET /api/me/capabilities` 的**安全投影**，只为了知道
 *   策略有没有授予 `allow_custom_in_group`）。
 *
 * 本文件把这些事实派生成**唯一**一个下一步：`create_group` / `need_operator` /
 * `add_node` / `create_forward` / `done` / `unknown`。
 *
 * ── 为什么没有状态机、没有 localStorage、没有 setup 标记 ──
 * 进度是**读时派生**的：任何时候都从上面这五个事实重新算一遍。一旦落库或写
 * localStorage，就会出现第二套真相 —— 用户删掉转发、切了工作空间、权限被收回之后，
 * 那份「已完成」仍然留在浏览器里，并被界面当成事实。
 *
 * ── 「不知道」不是「没问题」 ──
 * 任何一个事实缺失（请求失败、权限读不到、capabilities 形状不认识）都返回
 * `unknown`，并带上缺了哪几项。绝不因为「没查到问题」就显示达成或一切正常。
 */
import type { WorkspaceCapabilities } from "./api/capabilities";

/** 唯一的下一步。 */
export type FirstRunStep =
  | "create_group"
  | "need_operator"
  | "add_node"
  | "create_forward"
  | "done"
  | "unknown";

/** 派生下一步所需的事实；`null` 一律表示「取不到」。 */
export type FirstRunFactName =
  | "node_permission"
  | "groups"
  | "nodes"
  | "forwards"
  | "capabilities";

export const FIRST_RUN_FACT_NAMES: readonly FirstRunFactName[] = [
  "node_permission",
  "groups",
  "nodes",
  "forwards",
  "capabilities",
];

/**
 * `need_operator` 的两种真实原因（必须分开，因为下一步不同）：
 *   · `permission`        —— 当前账户没有 `node:manage`，自己做不了，需要管理员/有权限的成员；
 *   · `policy_not_granted` —— 有权限，但当前有效策略没有授予自建入口组的能力（能力未开通）。
 */
export type NeedOperatorReason = "permission" | "policy_not_granted";

export type FirstRunDecision =
  | { step: "create_group" }
  | { step: "need_operator"; reason: NeedOperatorReason }
  | { step: "add_node" }
  | { step: "create_forward" }
  | { step: "done" }
  /** 事实缺失：`missing` 列出缺哪几项（用于可观测与测试，界面只显示通用说明）。 */
  | { step: "unknown"; missing: FirstRunFactName[] };

/** 派生输入。计数用 `number | null`：`null` = 这一次没读到，不是 0。 */
export interface FirstRunFacts {
  /** `node:manage`；`null` = 权限投影还没到 / 不可信。 */
  canManageNodes: boolean | null;
  /** 当前工作空间的入口/可用节点组数量。 */
  groups: number | null;
  nodes: number | null;
  forwards: number | null;
  capabilities: WorkspaceCapabilities | null;
}

function usableCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * 事实 → 唯一下一步。
 *
 * 判定顺序（每一步都是「先确认事实、再下结论」）：
 *   1. 任何事实缺失 → `unknown`（**绝不**当成 0 或当成完成）；
 *   2. 已有转发 → `done`（首启引导已经走完，不再打扰）；
 *   3. 有节点没转发 → `create_forward`；
 *   4. 有组没节点 → `add_node`；
 *   5. 没有组 → 能自建就给 `create_group`，不能就给 `need_operator`（带真实原因）。
 *
 * 第 3 步排在第 4 步前面：节点只能存在于某个组里，所以「有节点、组列表却是空的」
 * 只可能是列表口径差异（例如组被删、节点归属另一个可见范围）。这种时候用户手上
 * 确实有可用的入口，正确动作是建第一条转发，而不是再建一个组。
 */
export function deriveFirstRunStep(facts: FirstRunFacts): FirstRunDecision {
  const missing: FirstRunFactName[] = [];
  if (facts.canManageNodes === null || facts.canManageNodes === undefined) missing.push("node_permission");
  if (usableCount(facts.groups) === null) missing.push("groups");
  if (usableCount(facts.nodes) === null) missing.push("nodes");
  if (usableCount(facts.forwards) === null) missing.push("forwards");
  if (!facts.capabilities) missing.push("capabilities");
  if (missing.length > 0) return { step: "unknown", missing };

  const groups = usableCount(facts.groups)!;
  const nodes = usableCount(facts.nodes)!;
  const forwards = usableCount(facts.forwards)!;
  const capabilities = facts.capabilities!;

  if (forwards > 0) return { step: "done" };
  if (nodes > 0) return { step: "create_forward" };
  if (groups > 0) return { step: "add_node" };

  if (facts.canManageNodes !== true) return { step: "need_operator", reason: "permission" };
  if (capabilities.allow_custom_in_group !== true) {
    return { step: "need_operator", reason: "policy_not_granted" };
  }
  return { step: "create_group" };
}

/* ================================================================== */
/* 文案 / 跳转（词典键在这里落定，界面只负责取词）                        */
/* ================================================================== */

export interface FirstRunTextKeys {
  title: string;
  hint: string;
  /** 主按钮键；`null` = 这一步没有可执行入口（例如只读账户）。 */
  action: string | null;
}

/** 各步骤的词典键（zh / en 两本字典必须都有；测试会校验非空）。 */
export const FIRST_RUN_TEXT_KEYS: Record<FirstRunStep, FirstRunTextKeys> = {
  create_group: {
    title: "firstRun.createGroupTitle",
    hint: "firstRun.createGroupHint",
    action: "firstRun.createGroupAction",
  },
  need_operator: {
    title: "firstRun.needOperatorTitle",
    hint: "firstRun.needOperatorHintPermission",
    action: null,
  },
  add_node: {
    title: "firstRun.addNodeTitle",
    hint: "firstRun.addNodeHint",
    action: "firstRun.addNodeAction",
  },
  create_forward: {
    title: "firstRun.createForwardTitle",
    hint: "firstRun.createForwardHint",
    action: "firstRun.createForwardAction",
  },
  done: { title: "firstRun.doneTitle", hint: "firstRun.doneHint", action: null },
  unknown: { title: "firstRun.unknownTitle", hint: "firstRun.unknownHint", action: null },
};

/** `need_operator` 的两种原因各有一句说明。 */
export const NEED_OPERATOR_HINT_KEYS: Record<NeedOperatorReason, string> = {
  permission: "firstRun.needOperatorHintPermission",
  policy_not_granted: "firstRun.needOperatorHintPolicy",
};

/** 该结论对应的文案键（`need_operator` 的 hint 随原因变化）。 */
export function firstRunTextKeys(decision: FirstRunDecision): FirstRunTextKeys {
  const base = FIRST_RUN_TEXT_KEYS[decision.step];
  if (decision.step === "need_operator") {
    return { ...base, hint: NEED_OPERATOR_HINT_KEYS[decision.reason] };
  }
  return base;
}

/**
 * 该步骤的可执行入口。
 *
 * 只给**真的能走通**的链接：
 *   · `add_node`      → `/nodes`（I1 的「加节点 → 等待上线」链路都在那里）；
 *   · `create_forward`→ `/forwards`（列表页自带创建入口与 `?ingress_node_id=` 预选）；
 *   · `need_operator` / `unknown` → `null`：没有可跳转的页面能替用户解决它。
 * `create_group` 不是链接：它在原地打开最小建组表单（见 FirstRunPanel），
 * 因为 `/nodes` 的同名入口还需要用户在节点页里再找一次。
 */
export function firstRunHref(decision: FirstRunDecision): string | null {
  switch (decision.step) {
    case "add_node":
      return "/nodes";
    case "create_forward":
      return "/forwards";
    default:
      return null;
  }
}

/**
 * 额度用量一行（节点 / 转发）。
 *
 * `max_* === null` 表示**不限**（后端语义），渲染成 `common.unlimited`；
 * capabilities 取不到时返回 `null`：不知道就什么都不说，不写「不限」。
 */
export function firstRunQuotaText(
  t: (key: string, params?: Record<string, string | number>) => string,
  capabilities: WorkspaceCapabilities | null | undefined,
): string | null {
  if (!capabilities) return null;
  const limit = (value: number | null) => (value === null ? t("common.unlimited") : String(value));
  return t("firstRun.quotaLine", {
    nodesUsed: capabilities.nodes_used,
    nodesMax: limit(capabilities.max_nodes),
    tunnelsUsed: capabilities.tunnels_used,
    tunnelsMax: limit(capabilities.max_tunnels),
  });
}

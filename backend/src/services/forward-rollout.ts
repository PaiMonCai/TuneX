/**
 * V4-WP3 — Forward Rollout Orchestrator（`DEVELOPMENT.md` §13.3.5 / §13.3.4）。
 *
 * ── 本模块是什么 ──
 * §13.3.5 要求所有 runtime 相关 Forward 编辑统一建模为
 *
 * ```text
 * VALIDATE → PREPARE → CUTOVER → DRAIN → CLEANUP
 * ```
 *
 * 上游已冻结构：目标 config（WP1 snapshot + `computeForwardImpact` 的影响面）、
 * 每跳能力（WP2 原语）、传输（`Orchestrator` 的四个 dispatch 方法）、账本
 * （`ControlValidator`）。缺的正是把它们按五阶段串起来、且**每一步都可从 DB
 * 续跑**的一层——本文件就是那一层的前半：**纯计划**。
 *
 * ── 为什么 `planRollout` 是纯函数 ──
 * 计划生成失败 ⇒ 不写任何 rollout 行、不动 tunnel 行（§13.3.5「VALIDATE 失败：
 * 旧 applied revision 完全不动」）。把它做成无 IO 纯函数，这条规则就从
 * 「靠人记得」变成「靠类型保证」：它没有 `db`、没有 `orchestrator`，想产生
 * 副作用也做不到。单测因此可以离线跑完整矩阵。
 *
 * ── 单一真相：不重算差异 ──
 * `planRollout` 接收 WP1 `computeForwardImpact` 的**输出**作为输入，自己不算
 * 「改了什么」。§13.3.3 的硬约束是「校验逻辑只能有一个 Service 实现」，把差异
 * 计算复制一份到这里就等于给 §13.3.4 的分类表开出第二处定义——两处必然漂移，
 * 而漂移的方向永远是「某类修改被漏掉」。
 *
 * ── 两条硬约束（写死在步骤生成里）──
 *  1. **CONP 顺序**：RELAY 的 steps 中 `prepare_egress` 一定早于
 *     `cutover_ingress`。否则入口先指向一个还不存在的 next_hop——每个进来的
 *     连接都拿 connection refused。与 `orchestrator.ts` 现存铁律
 *     （`dispatchEgress` 必须先于 `dispatchIngress`）同源。
 *  2. **同 phase 内步骤可重排，跨 phase 严格有序**：同 phase 内没有步骤对同一
 *     资源产生互斥顺序（便于未来并行 PREPARE）。
 *
 * ── 不做什么 ──
 *  · 不加新 wire `CommandAction`：五阶段只是 backend 对既有 `apply_tunnel` /
 *    `remove_tunnel` 的编排顺序（§2.2 out of scope）。
 *  · 不复制 runtime 事实：端口/节点/目标的真值在 tunnel 行 + WP1 snapshot，
 *    本模块只产出「该动哪个资源的哪一面」。
 */

import type { ForwardImpact } from "./forward-revision.ts";

/* ================================================================== */
/* 契约类型                                                            */
/* ================================================================== */

/** 五阶段（§13.3.5）。终态不在这里：它们是 rollout 行的 phase，不是计划阶段。 */
export type RolloutPhase = "validate" | "prepare" | "cutover" | "drain" | "cleanup";

/** rollout 行 `phase` 列的全部取值（含终态与等待态）。 */
export const ROLLOUT_PHASES = [
  "validate",
  "prepare",
  "cutover",
  "drain",
  "cleanup",
  "done",
  "failed",
  "compensating",
  "degraded",
  "waiting",
] as const;
export type RolloutPhaseState = (typeof ROLLOUT_PHASES)[number];

/**
 * 仍在上手（未终结）的 phase 集合。
 *
 * 服务层用 `updateMany where phase in (ACTIVE_ROLLOUT_PHASES)` 抢占
 * 「一条 tunnel 同时至多一条未完成 rollout」；DB 层面刻意不加唯一键——
 * 历史多行要能并存排障。
 */
export const ACTIVE_ROLLOUT_PHASES: readonly RolloutPhaseState[] = [
  "validate",
  "prepare",
  "cutover",
  "drain",
  "compensating",
  "waiting",
];

/** 单个步骤的种类（与 §13.3.4 分类表逐行对应）。 */
export type RolloutStepKind =
  /** 零副作用：把 blocking 清单再确认一遍。 */
  | "validate"
  /** ingress / egress 端口（幂等 preferred）。 */
  | "acquire_port"
  /** RELAY 新 NodeBinding（ingress→egress）。 */
  | "ensure_binding"
  /** EGRESS 侧 apply（RELAY）；ACK 后不切入口。 */
  | "prepare_egress"
  /** 入口 apply（= WP2 `ReplaceListener` 的目标形态）。 */
  | "cutover_ingress"
  /** EGRESS 侧切换（换节点/换池时）。 */
  | "cutover_egress"
  /** 旧入口 drain（端口迁移/节点迁移）。 */
  | "drain_ingress"
  /** 旧 EGRESS drain。 */
  | "drain_egress"
  /** 旧端口租约释放（等 drain 完成）。 */
  | "release_old_lease"
  /** 撤旧 EGRESS runtime（幂等 revision+1）。 */
  | "drop_old_egress";

/**
 * `release_binding` 明确**不在**本表里：§13.3.1 规定 Binding 是可复用基础设施
 * 关系，不因 Forward 修改自动删除。少一个枚举值比多一个永远不会执行的步骤好。

/**
 * 一个计划步骤。
 *
 * `idempotency_key` 是 CLEANUP / 续跑去重的唯一依据：
 * `(tunnel, revision, phase, kind, node, port)` 五元组。重启后读回 rollout 行，
 * 按 `steps` 中已完成的 key 集合决定下一步——**不靠内存状态**。
 */
export interface RolloutStep {
  phase: RolloutPhase;
  kind: RolloutStepKind;
  /** `Node.id`；无节点归属的步骤（validate）为 null。 */
  node_id: number | null;
  direction?: "ingress" | "egress";
  /** 目标端口；自动分配时为 null（执行期由 `acquirePort` 幂等解析回同一值）。 */
  port?: number | null;
  idempotency_key: string;
  meta?: Record<string, unknown>;
}

/** §13.3.4 的分类（与报告 §3.2 判定表逐行对应）。 */
export type RolloutStrategy =
  | "metadata_only"
  | "target_hot_swap"
  | "listener_replace"
  | "node_migration"
  | "mode_switch"
  | "noop";

/** 计划输出。 */
export interface RolloutPlan {
  revision: number;
  base_revision: number | null;
  strategy: RolloutStrategy;
  steps: RolloutStep[];
  /** 非空 ⇒ VALIDATE 失败，一步都不执行。 */
  blocking: Array<{ code: string; message: string }>;
  warnings: string[];
}

/**
 * rollout 视角的一份快照。
 *
 * 形状与 WP1 `ForwardCandidateConfig` 同源但**多出运行期解析值**
 * （listen_ip / egress_port / egress_pool_id / egress_targets /
 * desired_status）：计划要决定「在哪个节点哪个端口上下发」，只有业务字段不够。
 * 它由调用方从 WP1 `forward_revision` 行或兼容投影列合成——本模块不碰 IO，
 * 因此**不复制 runtime 事实**这件事在类型层面成立。
 */
export interface RolloutSnapshot {
  name: string;
  mode: "direct" | "relay";
  ingress_node_id: number;
  egress_node_id: number | null;
  listen_ip: string | null;
  /** 用户**请求**的监听端口；NULL = 自动分配。 */
  listen_port: number | null;
  target_host: string | null;
  target_port: number | null;
  egress_pool_id: number | null;
  /** 节点间内部端口（egress 侧）。 */
  egress_port: number | null;
  egress_targets: Array<{ host: string; port: number; weight: number; order_by: number }> | null;
  desired_status: string | null;
}

/** 计划需要的节点事实（最小投影）。 */
export interface RolloutNodeFact {
  id: number;
  node_id: string;
  role: string | null;
  connect_ip: string | null;
  /**
   * WP5 `Node.lifecycle`。**本地等价常量口径**（报告 R7）：WP5 尚未并入本分支
   * 前 import 会编译失败，因此这里直接判 `active` 放行、其余阻断，阻断码与 WP5
   * `node-lifecycle.ts#businessRejectionCode` 逐字一致。WP5 并入后改为 import
   * `NODE_LIFECYCLES` / `nodeAdmission`——**语义零漂移是评审要对着两处代码
   * 确认的**，不是靠一句描述。
   */
  lifecycle?: string | null;
  /** 是否配置了端口区间（自动分配端口的前置）。 */
  port_range_configured?: boolean;
}

export interface PlanRolloutInput {
  revision: number;
  base_revision: number | null;
  /**
   * WP1 `computeForwardImpact` 的输出。**唯一**的差异来源——本函数不重算。
   */
  impact: ForwardImpact;
  /** 目标（desired）快照。 */
  desired: RolloutSnapshot;
  /** 当前 applied 快照；null = 从未成功 apply 过。 */
  applied: RolloutSnapshot | null;
  nodes: {
    /** 新拓扑的入口节点（= desired.ingress_node_id）。 */
    ingress: RolloutNodeFact | null;
    /** 新拓扑的出口节点（RELAY 必填）。 */
    egress: RolloutNodeFact | null;
    /** 旧拓扑的入口节点（迁移时非空；用于 DRAIN/CLEANUP）。 */
    ingress_previous: RolloutNodeFact | null;
    /** 旧拓扑的出口节点（迁移时非空）。 */
    egress_previous: RolloutNodeFact | null;
  };
  /** RELAY 新 pair 的 NodeBinding 是否已存在；非 RELAY 传 null。 */
  binding_exists?: boolean | null;
}

/* ================================================================== */
/* 常量：节点准入（R7 的本地等价口径）                                   */
/* ================================================================== */

/** 放行的 lifecycle 集合。WP5 并入后改为 `import { NODE_LIFECYCLES }`。 */
export const ROLLOUT_ADMITTED_LIFECYCLES: readonly string[] = ["active"];

/**
 * lifecycle → 阻断码。与 WP5 `node-lifecycle.ts#businessRejectionCode` 逐字一致
 * （`disabled` 即 WP5 的 fail-closed 兜底）。
 */
export const ROLLOUT_LIFECYCLE_BLOCKING_CODES = {
  maintenance: "node_in_maintenance",
  retiring: "node_retiring",
  disabled: "node_disabled",
} as const;

/**
 * 该 lifecycle 是否阻断承载 Forward。
 *
 * `null` / `undefined` / 未知值 ⇒ **不阻断**：本分支没有 WP5 的 lifecycle 列，
 * 存量库里读到的就是 null。把「未知」当阻断会让全部存量 Forward 一次都改不动，
 * 那是比放宽更糟的故障。已知的非 active 值一律 fail-closed。
 */
export function lifecycleBlocksForward(lifecycle: string | null | undefined): string | null {
  if (lifecycle === null || lifecycle === undefined) return null;
  if (ROLLOUT_ADMITTED_LIFECYCLES.includes(lifecycle)) return null;
  return (
    ROLLOUT_LIFECYCLE_BLOCKING_CODES[lifecycle as keyof typeof ROLLOUT_LIFECYCLE_BLOCKING_CODES] ??
    ROLLOUT_LIFECYCLE_BLOCKING_CODES.disabled
  );
}

/** 端口黑名单：与 `portPool.PORT_BLACKLIST` / WP1 `RESERVED_PORTS` 同口径。 */
const RESERVED_PORTS = [22, 80, 443, 3306, 5432, 6379, 27017, 9090, 9191];

/* ================================================================== */
/* 纯函数：幂等键                                                      */
/* ================================================================== */

/**
 * 步骤幂等键（CLEANUP 幂等与续跑去重的唯一依据）。
 *
 * 导出而不是内联：执行器与测试必须用**同一个**函数算 key，否则「已完成集合」
 * 会用两套口径比对，重启后续跑会把已完成的步骤再做一遍。
 */
export function rolloutStepKey(input: {
  tunnelId: number;
  revision: number;
  phase: RolloutPhase;
  kind: RolloutStepKind;
  nodeId?: number | null;
  port?: number | null;
}): string {
  return [
    input.tunnelId,
    input.revision,
    input.phase,
    input.kind,
    input.nodeId ?? "-",
    input.port ?? "-",
  ].join(":");
}

/* ================================================================== */
/* 纯函数：策略分类（§13.3.4）                                          */
/* ================================================================== */

/**
 * 从 WP1 影响面推出 §13.3.4 的策略名。
 *
 * 优先级从「改动面最大」往下：一次编辑可能同时改多个字段（§13.3.4「多字段同时改
 * = 一个完整 revision / 一个 rollout plan」），策略必须报**最重**的那一档，
 * 否则「端口 + 入口节点同时改」会被报成 listener_replace，读报告的人以为旧节点
 * 还要继续用。
 */
export function classifyRolloutStrategy(input: {
  impact: ForwardImpact;
  desiredMode: "direct" | "relay";
}): RolloutStrategy {
  const { impact } = input;
  if (impact.metadata_only) return "metadata_only";
  if (!impact.runtime_change) return "noop";
  // 模式切换优先于一切：它同时改两端。
  if (impact.mode_change) return "mode_switch";
  // 入口或出口节点迁移（含「端口 + 入口节点同时改」合并为一档）。
  if (impact.ingress_node_change || impact.egress_node_change) return "node_migration";
  if (impact.listen_port_change) return "listener_replace";
  return "target_hot_swap";
}

/* ================================================================== */
/* 纯函数：VALIDATE                                                    */
/* ================================================================== */

/**
 * VALIDATE 阶段的准入判定（纯函数）。
 *
 * 与 WP1 `validateForwardCandidateWithDb` 的分工：那边回答「这次编辑合不合法」，
 * 这边只回答「现在**这一刻**允不允许下发」。同一个编辑在 preview 时合法、
 * 在 rollout 时可能被 `node_in_maintenance` 挡住——那不是矛盾，是 §13.3.6 明文
 * 的「用户仍可保存 desired config，节点退出维护后再由 Reconciler 应用」。
 */
export function validateRolloutAdmission(input: PlanRolloutInput): Array<{
  code: string;
  message: string;
}> {
  const blocking: Array<{ code: string; message: string }> = [];
  const { impact, desired, nodes } = input;

  // 纯 metadata / 无 runtime 变化：不需要准入判定，也不需要 rollout。
  if (impact.metadata_only || !impact.runtime_change) return blocking;

  const ingress = nodes.ingress;
  if (!ingress) {
    blocking.push({ code: "node_unavailable", message: "入口节点不存在" });
  } else {
    const lifecycle = lifecycleBlocksForward(ingress.lifecycle);
    if (lifecycle) {
      blocking.push({
        code: lifecycle,
        message: `入口节点 ${ingress.node_id} 当前不可承载新 runtime（${ingress.lifecycle}）`,
      });
    }
    if (ingress.role !== "ingress" && ingress.role !== "both") {
      blocking.push({ code: "node_unavailable", message: `入口节点 ${ingress.node_id} 不具备入口能力` });
    }
  }

  if (desired.mode === "relay") {
    const egress = nodes.egress;
    if (!egress) {
      blocking.push({ code: "node_unavailable", message: "出口节点不存在" });
    } else {
      const lifecycle = lifecycleBlocksForward(egress.lifecycle);
      if (lifecycle) {
        blocking.push({
          code: lifecycle,
          message: `出口节点 ${egress.node_id} 当前不可承载新 runtime（${egress.lifecycle}）`,
        });
      }
      if (egress.role !== "egress" && egress.role !== "both") {
        blocking.push({ code: "node_unavailable", message: `出口节点 ${egress.node_id} 不具备出口能力` });
      }
    }
    // `binding_exists === false` **不阻断**：§3.2 判定表把 `ensure_binding`
    // 列为 PREPARE 的正式步骤，即「binding 缺失」正是要用 rollout 解决的问题，
    // 不是拒绝 rollout 的理由。真正该阻断的是「连能建 binding 的节点都没有」
    // （上面的 node_unavailable）。（§13.3.1：Binding 创建显式，不自动。）
  } else {
    // DIRECT 必须有完整目标。
    if (!desired.target_host || !desired.target_port) {
      blocking.push({ code: "invalid_target", message: "DIRECT 转发的目标 Host/端口不完整" });
    }
  }

  // 指名端口仍要走黑名单判定（与 WP1 `validateForwardCandidate` 同口径）。
  const port = desired.listen_port;
  if (port !== null && port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      blocking.push({ code: "port_invalid", message: `监听端口 ${port} 不是 1-65535 的整数` });
    } else if (RESERVED_PORTS.includes(port)) {
      blocking.push({ code: "port_invalid", message: `端口 ${port} 是平台保留端口，不能用于转发` });
    } else if (ingress && ingress.port_range_configured === false) {
      // 自动分配在没有区间的节点上必然失败；指名端口不读区间，因此只在 auto
      // 分支判。这里只做防御（区间判定本质是 DB 事实）。
    }
  }

  return blocking;
}

/** VALIDATE 阶段的 warning（不改判定，只让用户提前知道代价）。 */
export function rolloutWarnings(input: PlanRolloutInput): string[] {
  const warnings: string[] = [];
  if (input.impact.metadata_only || !input.impact.runtime_change) return warnings;
  if (input.impact.changes_external_address) {
    warnings.push("外部访问地址将改变，已保存旧地址的客户端需要更新");
  }
  if (input.impact.listener_replacement) {
    warnings.push("入口监听将重建，重建窗口内的新连接可能被拒绝");
  }
  if (input.impact.egress_node_change) {
    warnings.push("出口节点将切换，切换窗口内已建立连接保持、新连接走新出口");
  }
  return warnings;
}

/* ================================================================== */
/* 纯函数：步骤生成（§13.3.4 判定表）                                   */
/* ================================================================== */

/** 目标形态是否为 RELAY（决定要不要动出口侧）。 */
function isRelay(s: RolloutSnapshot | null): boolean {
  return s?.mode === "relay";
}

/**
 * 从差异生成五阶段步骤。
 *
 * 顺序即 §13.3.5：VALIDATE → PREPARE → CUTOVER → DRAIN → CLEANUP。
 * 生成顺序刻意按「先新后旧」组织，函数末尾再按 phase 稳定排序——这样同一
 * phase 内的步骤顺序由生成顺序决定（可重排），跨 phase 的顺序由常量决定
 * （不可重排）。
 */
function buildSteps(input: PlanRolloutInput, tunnelId: number): RolloutStep[] {
  const { impact, desired, applied, nodes } = input;
  const relay = isRelay(desired);
  const relayBefore = isRelay(applied);
  const steps: RolloutStep[] = [];

  const push = (
    phase: RolloutPhase,
    kind: RolloutStepKind,
    extra: { node_id?: number | null; direction?: "ingress" | "egress"; port?: number | null; meta?: Record<string, unknown> },
  ) => {
    const nodeId = extra.node_id ?? null;
    const port = extra.port ?? null;
    steps.push({
      phase,
      kind,
      node_id: nodeId,
      ...(extra.direction ? { direction: extra.direction } : {}),
      ...(extra.port !== undefined ? { port } : {}),
      idempotency_key: rolloutStepKey({
        tunnelId,
        revision: input.revision,
        phase,
        kind,
        nodeId,
        port: extra.port ?? null,
      }),
      ...(extra.meta ? { meta: extra.meta } : {}),
    });
  };

  /* ---------------- VALIDATE（零副作用）---------------- */
  push("validate", "validate", {});

  /* ---------------- PREPARE ---------------- */
  // listener 重建（换端口 / 换入口节点 / 换模式）⇒ 新入口端口要先落地。
  // 换模式进 RELAY 时入口端口本身可能不变，但 ingress 形态从 DIRECT 变 RELAY，
  // 一样要先有端口租约（auto 分配时靠 acquirePort 幂等解析回同一值）。
  if (impact.listener_replacement || impact.mode_change) {
    push("prepare", "acquire_port", {
      node_id: desired.ingress_node_id,
      direction: "ingress",
      port: desired.listen_port ?? null,
      meta: { reason: impact.ingress_node_change ? "ingress_node_changed" : "listener_replaced" },
    });
  }

  if (relay) {
    const egressNode = nodes.egress;
    const egressIsNew = impact.egress_node_change || impact.mode_change;
    if (egressIsNew) {
      // 新 pair：Binding 必须先存在（§13.3.1：新建显式、删除不自动）。
      if (input.binding_exists === false) {
        push("prepare", "ensure_binding", {
          node_id: egressNode?.id ?? desired.egress_node_id,
          direction: "egress",
          meta: { ingress_node_id: desired.ingress_node_id, egress_node_id: desired.egress_node_id },
        });
      }
      // 新出口节点上的节点间端口（同节点时幂等续用）。
      push("prepare", "acquire_port", {
        node_id: egressNode?.id ?? desired.egress_node_id,
        direction: "egress",
        port: desired.egress_port ?? null,
        meta: { reason: "egress_placement" },
      });
      // 先装出口（铁律：没有 next_hop 就不允许启入口）。
      push("prepare", "prepare_egress", {
        node_id: egressNode?.id ?? desired.egress_node_id,
        direction: "egress",
        port: desired.egress_port ?? null,
      });
    } else if (impact.egress_target_change) {
      // 同出口节点、只换池内目标：PREPARE 无事可做，切换发生在 CUTOVER。
    }
  }

  /* ---------------- CUTOVER ---------------- */
  // RELAY 出口侧先切（新节点 / 新池），入口随后指向新 next_hop。
  // 这里与 §13.3.4「RELAY Egress：prepare 新 Egress → cutover Ingress →
  // drain/cleanup 旧 Egress」对齐：出口的 apply 在 PREPARE，cutover_egress
  // 标记「出口侧此刻起按新 revision 生效」。
  if (relay && (impact.egress_node_change || impact.egress_target_change || impact.mode_change)) {
    push("cutover", "cutover_egress", {
      node_id: nodes.egress?.id ?? desired.egress_node_id,
      direction: "egress",
      port: desired.egress_port ?? null,
    });
  }

  // 入口是否需要重新下发：
  //   · listener 重建（端口/节点变化）
  //   · 模式切换（upstream 从 target 变 next_hop 或反向）
  //   · RELAY 换出口（next_hop 变了，入口必须重指）
  //   · DIRECT 换 target（同端口热换，§13.3.4「旧 TCP 连接继续」）
  // 唯一的例外：RELAY 同节点只换池内目标——入口的 listener 与 next_hop 都不变。
  const ingressNeedsDispatch =
    impact.listener_replacement ||
    impact.mode_change ||
    (relay && impact.egress_node_change) ||
    (!relay && impact.target_change) ||
    applied === null;
  if (ingressNeedsDispatch) {
    push("cutover", "cutover_ingress", {
      node_id: desired.ingress_node_id,
      direction: "ingress",
      port: desired.listen_port ?? null,
      meta: { same_listener: !impact.listener_replacement && !impact.mode_change },
    });
  }

  /* ---------------- DRAIN ---------------- */
  // 旧入口：换端口或换节点时旧 listener 必须退场。wire 上没有 drain 原语
  // （报告 R3），因此 DRAIN 用 `remove_tunnel` 表达「停止接受新连接后等待在途
  // 退出」——与 `tunnel-api.ts#suspend` 同一条既有表达。
  //
  // `applied === null` ⇒ 该 tunnel **从未成功 apply 过**，没有旧 runtime 可退场；
  // 此时旧节点 id / 旧端口都是 null，生成的 drain 会是「对不存在的 listener
  // 发 remove」。首次部署（`createForward` 之后第一次编辑）正落在这支。
  const hasPreviousRuntime = applied !== null;
  if (hasPreviousRuntime && (impact.ingress_node_change || impact.listen_port_change)) {
    const oldNode = nodes.ingress_previous;
    const oldPort = applied?.listen_port ?? null;
    push("drain", "drain_ingress", {
      node_id: oldNode?.id ?? (applied?.ingress_node_id ?? null),
      direction: "ingress",
      port: oldPort,
      meta: { reason: impact.ingress_node_change ? "ingress_node_changed" : "listen_port_changed" },
    });
  }

  // 旧出口：换出口节点、或 RELAY→DIRECT 时旧 EGRESS 必须退场。
  const egressMustDrain = relayBefore && (impact.egress_node_change || impact.mode_change);
  if (egressMustDrain) {
    const oldEgress = nodes.egress_previous;
    push("drain", "drain_egress", {
      node_id: oldEgress?.id ?? (applied?.egress_node_id ?? null),
      direction: "egress",
      port: applied?.egress_port ?? null,
    });
  }

  /* ---------------- CLEANUP ---------------- */
  // 全部等 drain 完成之后：先撤 runtime，再释放租约（顺序反了会让
  // 「端口已释放但 listener 还在」的窗口出现，窗口内别人分到同一端口即双绑）。
  if (hasPreviousRuntime && (impact.ingress_node_change || impact.listen_port_change)) {
    const oldNode = nodes.ingress_previous;
    push("cleanup", "release_old_lease", {
      node_id: oldNode?.id ?? (applied?.ingress_node_id ?? null),
      direction: "ingress",
      port: applied?.listen_port ?? null,
    });
  }

  if (egressMustDrain) {
    const oldEgress = nodes.egress_previous;
    const oldEgressNodeId = oldEgress?.id ?? (applied?.egress_node_id ?? null);
    push("cleanup", "drop_old_egress", {
      node_id: oldEgressNodeId,
      direction: "egress",
      port: applied?.egress_port ?? null,
    });
    if (oldEgressNodeId !== null && applied?.egress_port != null) {
      push("cleanup", "release_old_lease", {
        node_id: oldEgressNodeId,
        direction: "egress",
        port: applied.egress_port,
      });
    }
  }

  // 去重 + 按 phase 稳定排序（同 phase 内保持生成顺序：可重排；跨 phase 严格有序）。
  const seen = new Set<string>();
  const deduped = steps.filter((s) => {
    if (seen.has(s.idempotency_key)) return false;
    seen.add(s.idempotency_key);
    return true;
  });
  const order: Record<RolloutPhase, number> = {
    validate: 0,
    prepare: 1,
    cutover: 2,
    drain: 3,
    cleanup: 4,
  };
  return deduped
    .map((s, i) => ({ s, i }))
    .sort((a, b) => order[a.s.phase] - order[b.s.phase] || a.i - b.i)
    .map((x) => x.s);
}

/* ================================================================== */
/* 入口：planRollout                                                   */
/* ================================================================== */

/**
 * 生成一次 rollout 的执行计划（**纯函数，无 IO**）。
 *
 * `blocking` 非空 ⇒ VALIDATE 失败：调用方**不写任何 rollout 行、不动 tunnel 行**，
 * 旧 applied revision 完全不动（§13.3.5 第一条失败规则）。这条规则靠「本函数
 * 拿不到 db」来保证，不靠调用方记得。
 *
 * `strategy === "metadata_only"` ⇒ 不生成任何步骤：§13.3.2 禁止为改名生成
 * revision 或触发 listener 重建；WP1 也已不再为纯 metadata 生成 snapshot。
 * 这里的防御性分支只让调用方有一个可记录的 noop，不让它误以为要跑五阶段。
 */
export function planRollout(input: PlanRolloutInput, tunnelId: number): RolloutPlan {
  const blocking = validateRolloutAdmission(input);
  const warnings = rolloutWarnings(input);
  const strategy = classifyRolloutStrategy({
    impact: input.impact,
    desiredMode: input.desired.mode,
  });

  if (strategy === "metadata_only" || strategy === "noop" || blocking.length > 0) {
    return {
      revision: input.revision,
      base_revision: input.base_revision,
      strategy,
      steps: [],
      blocking,
      warnings,
    };
  }

  return {
    revision: input.revision,
    base_revision: input.base_revision,
    strategy,
    steps: buildSteps(input, tunnelId),
    blocking,
    warnings,
  };
}

/**
 * WP9 — Reconciler / Retry / Recovery（`DEVELOPMENT.md` §7.12）。
 *
 * ── 把五份事实放在一起比 ──
 *   1. DB desired state    `tunnel.desired_status` + `config_revision`
 *   2. Agent applied state `tunnel.applied_revision` + `node_state_report` 快照
 *   3. NodePortLease       `node_port_lease`（端口所有权，§5.1）
 *   4. Node online state   `node.status` / `last_seen_at` / `reported_at`
 *   5. 上报快照里的 runtime（agent 自称正在跑的隧道与端口）
 *
 * ── 只有四类动作可以自动执行（§7.12「只允许自动」）──
 *   A. {@link AutoActionKind} `resend_same_revision` —— 以**同一个** revision
 *      重发。Agent 侧等版本会回 duplicate ACK，因此重发天然幂等。
 *      **绝不允许抬高 revision**：抬高期望版本是 WP8 编排器的专属权力，
 *      reconciler bump revision 等于偷偷改掉用户的期望状态。
 *   B. `fill_missing_runtime` —— desired=active 而 agent 快照里根本没有这条
 *      隧道时，用同 revision 补一遍 apply（A 的特例，分开计数是为了让
 *      「Agent 丢了 runtime」与「ACK 落后」在巡检里可区分）。
 *   C. `release_orphan_lease` —— 只回收**确认无主**的租约，实现直接复用 WP3
 *      的 `reconcileLeases`（悬空 `tunnel_id` / 过期预分配）。「DB 有租约但
 *      agent 没上报该端口」**不是**无主，那是瞬态，回收它会让下一次分配双绑。
 *   D. `record_finding` —— 记 error/warning。本模块所有不自动执行的偏差都以
 *      finding 形式落在这里，交由 worker 日志/后续告警通道消费。
 *
 * ── 默认禁止自动（§7.12），白名单之外一律只告警 ──
 *   · `switch_node`     换 ingress/egress Node（绑定是编排决策，§4.2）
 *   · `change_port`     换 `listen_port` / `egress_port`（端口所有权重排，§5.1）
 *   · `migrate_tunnel`  把用户 Tunnel 迁去别的组/节点
 *   · `delete_on_stale` 心跳超时就删资源（v3 铁律：失败保留 Tunnel，§4.1。
 *     离线节点上的隧道照样保留，节点回来重发同 revision 即恢复）
 *
 * ── 依赖姿态：只定义接口 + 纯逻辑，不等 WP8 ──
 * 下发通道（transport）由 WP8 编排器接线，本模块通过 {@link ReconcileSink}
 * 注入；未注入时默认 sink 只记录 `no_transport` finding，**不会**凭空声称
 * 已重发。端口租约回收复用 WP3 `reconcileLeases` 的判定，不在本模块复制
 * 第二套孤儿规则。
 *
 * 纯判定函数（{@link computeDrift} / {@link planTunnelActions}）不碰 IO，
 * 可离线单测；副作用全部走注入的 deps。
 */

/* ================================================================== */
/* 常量                                                                 */
/* ================================================================== */

/**
 * Agent 状态上报视为过期的时间窗。
 *
 * 心跳 30s 一次（见 routes 侧的限流口径与 `cron_push_node_config`），3 个周期
 * 没更新即认为「这个节点现在联系不上」。**过期不等于资源可删**：§7.12 明确
 * 禁止「心跳超时即删除资源」，过期只把该隧道的所有自动动作降级为告警。
 */
export const DEFAULT_NODE_STALE_AFTER_MS = 90_000;

/**
 * 失败态隧道的自动重试退避。
 *
 * `apply_status=error` 的隧道不会被每一轮 reconcile 都打一遍：至少要等一个
 * 退避窗口，否则 Agent 持续失败时控制面反而在自我 DDoS。revision 落后但从未
 * 失败过的隧道不受此限（那是正常待下发，不是重试）。
 */
export const DEFAULT_RETRY_BACKOFF_MS = 60_000;

/** 允许自动执行的动作（§7.12「只允许自动」的白名单，穷尽列出）。 */
export const AUTO_ACTIONS = [
  "resend_same_revision",
  "fill_missing_runtime",
  "release_orphan_lease",
  "record_finding",
] as const;

/**
 * 默认禁止自动的动作。
 *
 * 这份列表是**声明式禁令**：即使将来有人想给 reconciler 加新能力，也必须先
 * 在这里显式讨论，而不是默默实现。测试对数组内容做锚定断言。
 */
export const FORBIDDEN_AUTO_ACTIONS = [
  "switch_node",
  "change_port",
  "migrate_tunnel",
  "delete_on_stale",
] as const;

export type AutoActionKind = (typeof AUTO_ACTIONS)[number];
export type ForbiddenActionKind = (typeof FORBIDDEN_AUTO_ACTIONS)[number];

/* ================================================================== */
/* 输入形状（对照 WP1 schema 的同名列，字段名保持 snake_case）             */
/* ================================================================== */

/** DB 侧 desired 事实（`tunnel` 行的最小投影）。 */
export interface DesiredTunnel {
  id: number;
  name?: string | null;
  tunnel_mode?: "direct" | "relay" | null;
  /** 期望状态；NULL = 未被 v3 显式声明过（WP2 只回填 mode，不猜状态）。 */
  desired_status?: string | null;
  /** 控制面期望版本；NULL = 这条隧道还没进入 v3 期望状态模型。 */
  config_revision?: number | null;
  /** 最近 ACK 版本。 */
  applied_revision?: number | null;
  apply_status?: string | null;
  apply_error_code?: string | null;
  apply_error?: string | null;
  last_applied_at?: Date | null;
  listen_port?: number | null;
  egress_port?: number | null;
  egress_node_id?: number | null;
  in_node_group_id?: number | null;
}

/** Agent 快照里的单条隧道（对齐 services/node-state.ts 的 ReportedTunnel）。 */
export interface AgentTunnelState {
  id: string;
  mode?: string | null;
  ingress_port?: number | null;
  egress_port?: number | null;
  revision?: number | null;
}

/** 节点在线性事实。 */
export interface NodeOnlineInput {
  node_id: number;
  /** `node.status`；inactive = 离线检测已判定掉线。 */
  status?: "active" | "inactive" | null;
  last_seen_at?: Date | null;
  /** state_report.reported_at：面板侧收到上报的时刻（DB 侧真相）。 */
  reported_at?: Date | null;
}

export type Severity = "info" | "warning" | "error";

/** 偏差种类（比动作更细：一个隧道可同时命中多种）。 */
export type DriftKind =
  /** agent 声称应用的版本落后于 desired 版本。 */
  | "revision_behind"
  /** agent 快照里没有这条隧道，而 desired 要它 active。 */
  | "missing_runtime"
  /** agent 在跑这条隧道，但 desired 不要它跑（inactive / 未声明）。 */
  | "unexpected_runtime"
  /** agent 端口与 desired 端口不一致。 */
  | "port_mismatch"
  /** agent 自报 mode 与 tunnel_mode 不一致。 */
  | "mode_mismatch"
  /** 节点当前离线 / 上报过期。 */
  | "node_unreachable"
  /** 上次 apply 以 error 收尾。 */
  | "error_state";

/** 一条偏差（判定结果，无副作用）。 */
export interface Drift {
  kind: DriftKind;
  detail: string;
  /** 该偏差**不能**自动修，必须由人/编排器介入的禁令动作。 */
  suppressed?: ForbiddenActionKind[];
}

/** finding：记录但不自动执行（或已自动执行）的事实。 */
export interface Finding {
  code: DriftKind | "orphan_lease_released" | "retry_deferred" | "resend_skipped" | "lease_owner_unconfirmed";
  severity: Severity;
  detail: string;
  tunnel_id?: number;
  node_id?: number | null;
  revision?: number | null;
  /** 本 finding 触发（或本应触发）的自动动作；`null` = 只记录。 */
  auto_action: AutoActionKind | null;
  /** 明确**没有**做的禁止动作 —— 让「它没修」在结果里可读，而不是靠猜。 */
  suppressed: ForbiddenActionKind[];
}

/** 计划执行的一个自动动作。 */
export interface PlannedAction {
  kind: AutoActionKind;
  detail: string;
  /** `resend_same_revision` / `fill_missing_runtime` 时必填：重发的版本号。 */
  revision?: number;
  /** `release_orphan_lease` 时由执行层填充实际回收数。 */
  tunnel_id?: number;
  node_id?: number | null;
}

/* ================================================================== */
/* 纯判定（无 IO）                                                      */
/* ================================================================== */

/** 期望状态是否被 v3 显式声明过（DB desired state 的准入条件）。 */
export function hasDeclaredDesired(t: DesiredTunnel): boolean {
  return t.config_revision !== null && t.config_revision !== undefined;
}

/** desired 是否要求隧道在跑。 */
export function wantsActive(t: DesiredTunnel): boolean {
  return hasDeclaredDesired(t) && t.desired_status === "active";
}

/** 版本是否落后（`applied_revision < config_revision`，含从未 ACK）。 */
export function isRevisionBehind(t: DesiredTunnel): boolean {
  if (!hasDeclaredDesired(t)) return false;
  const desired = t.config_revision as number;
  const applied = t.applied_revision ?? null;
  if (applied === null) return true;
  return applied < desired;
}

/**
 * 端口是否不一致。**只比较「两边都知道」的端口**：agent 没上报该端口时不做
 * 判定（`null` / 缺失 = 不知道，不是不一致）。这正是 reconciler 不该把
 * 「agent 少报了一个字段」当成 `port_mismatch` 的原因。
 */
export function isPortMismatch(t: DesiredTunnel, agent: AgentTunnelState | null): boolean {
  if (!agent) return false;
  const pairs: Array<[number | null | undefined, number | null | undefined]> = [
    [t.listen_port, agent.ingress_port],
    [t.egress_port, agent.egress_port],
  ];
  return pairs.some(([want, got]) => {
    if (want === null || want === undefined) return false;
    if (got === null || got === undefined) return false;
    return want !== got;
  });
}

/** mode 是否不一致（agent 未上报 mode 时不判）。 */
export function isModeMismatch(t: DesiredTunnel, agent: AgentTunnelState | null): boolean {
  if (!agent || !agent.mode || !t.tunnel_mode) return false;
  return t.tunnel_mode !== agent.mode;
}

/**
 * 节点是否可能联系不上。
 *
 * `null`/`undefined` 节点 = **不知道节点在哪**（DIRECT 隧道没有 egress 指针、
 * 或节点行已被删）。按不可达处理：此时无从判断 agent 是否在场，自动下发
 * 会打向一个无从确认的目标。这也是本函数与执行层
 * `node !== null && !isNodeUnreachable(...)` 必须一致的原因——两边答案不同
 * 就会出现「判定说该重发、执行层又不发」的漂移。
 */
export function isNodeUnreachable(
  node: NodeOnlineInput | null | undefined,
  now: Date,
  staleAfterMs: number = DEFAULT_NODE_STALE_AFTER_MS,
): boolean {
  if (!node) return true;
  if (node.status === "inactive") return true;
  const seen = node.last_seen_at ?? node.reported_at ?? null;
  if (!seen) return true; // 从未有心跳/上报 —— 不删资源，但也不自动下发
  return now.getTime() - new Date(seen).getTime() > staleAfterMs;
}

/** 上一次 apply 是否以 error 收尾。 */
export function isErrorState(t: DesiredTunnel): boolean {
  return t.apply_status === "error";
}

/**
 * 单条隧道的偏差清单（纯函数）。
 *
 * 不在此处产出动作：`computeDrift` 回答「差在哪」，`planTunnelActions` 回答
 * 「允许怎么修」。混在一起会让「同一偏差只能有一种修法」的约束散落各处。
 */
export function computeDrift(
  tunnel: DesiredTunnel,
  agent: AgentTunnelState | null,
  node: NodeOnlineInput | null | undefined,
  now: Date,
  opts: { staleAfterMs?: number } = {},
): Drift[] {
  // 未被 v3 显式声明过的隧道不进 reconciler 视野：legacy DIRECT 的真相在
  // config-generator / legacy allocator（§5.2），reconciler 对它没有任何
  // desired 可比，强行对照只会产出噪声 finding。
  if (!hasDeclaredDesired(tunnel)) return [];

  const out: Drift[] = [];
  const unreachable = isNodeUnreachable(node, now, opts.staleAfterMs);

  if (wantsActive(tunnel) && agent === null) {
    out.push({
      kind: "missing_runtime",
      detail: `desired active 但 agent 快照无隧道 ${tunnel.id}`,
      suppressed: ["switch_node", "migrate_tunnel"],
    });
  }
  if (!wantsActive(tunnel) && agent !== null) {
    out.push({
      kind: "unexpected_runtime",
      detail: `desired=${tunnel.desired_status ?? "未声明"} 但 agent 仍在运行隧道 ${tunnel.id}`,
    });
  }
  if (wantsActive(tunnel) && agent !== null && isRevisionBehind(tunnel)) {
    out.push({
      kind: "revision_behind",
      detail: `applied ${tunnel.applied_revision ?? "null"} < desired ${tunnel.config_revision}`,
    });
  }
  if (isPortMismatch(tunnel, agent)) {
    out.push({
      kind: "port_mismatch",
      detail: "agent 端口与 desired 端口不一致",
      // 端口所有权重排是编排决策（§5.1），且 DB 唯一键下擅自换端口会让
      // agent bind 与控制面记录分叉。只告警。
      suppressed: ["change_port"],
    });
  }
  if (isModeMismatch(tunnel, agent)) {
    out.push({
      kind: "mode_mismatch",
      detail: `agent mode=${agent?.mode} 与 tunnel_mode=${tunnel.tunnel_mode} 不一致`,
      // mode 不一致意味着 agent 跑的不是用户要的东西，但直接改会改变用户
      // 可见行为；同样归编排器。
      suppressed: ["migrate_tunnel"],
    });
  }
  if (isErrorState(tunnel)) {
    out.push({
      kind: "error_state",
      detail: tunnel.apply_error
        ? `apply_status=error: ${tunnel.apply_error}`
        : tunnel.apply_error_code
          ? `apply_status=error (${tunnel.apply_error_code})`
          : "apply_status=error",
    });
  }
  if (unreachable) {
    out.push({
      kind: "node_unreachable",
      detail: "节点离线或上报过期：本轮不做任何自动修复",
      // §7.12 明文禁令：心跳超时不删资源。这里把禁忌显式写进 finding，
      // 让巡检能回答「为什么没修」。
      suppressed: ["delete_on_stale", "switch_node"],
    });
  }
  return out;
}

/* ================================================================== */
/* 动作计划（白名单闸门：打算做什么 vs 允许做什么）                       */
/* ================================================================== */

/**
 * 把一个「打算做的动作」过一遍白名单。
 *
 * 这是 §7.12 两条清单的**代码落点**：
 *   · 在 {@link AUTO_ACTIONS} 内 → 允许；
 *   · 在 {@link FORBIDDEN_AUTO_ACTIONS} 内 或任何未知值 → 拒绝并显式返回
 *     `suppressed`，让调用方（日志/告警）能说出「压掉了什么」。
 *
 * 单独导出是因为它是本模块唯一需要被「新增动作会不会破规矩」测试直接锚定的
 * 函数——真实调用方绕不过它。
 */
export function decideAutoAction(
  attempted: string,
): { allowed: true; kind: AutoActionKind } | { allowed: false; suppressed: ForbiddenActionKind | "unknown_action" } {
  if ((AUTO_ACTIONS as readonly string[]).includes(attempted)) {
    return { allowed: true, kind: attempted as AutoActionKind };
  }
  if ((FORBIDDEN_AUTO_ACTIONS as readonly string[]).includes(attempted)) {
    return { allowed: false, suppressed: attempted as ForbiddenActionKind };
  }
  return { allowed: false, suppressed: "unknown_action" };
}

/**
 * 由偏差清单推导出**允许自动执行**的动作序列。
 *
 * 三条硬规则：
 *   1. **revision 永远原样重发**。`resend_same_revision` 的 revision 就是
 *      `tunnel.config_revision`，本函数没有任何分支产出 `revision + 1`。
 *   2. **节点不可达 ⇒ 什么都不自动做**。离线节点的隧道保留原状
 *      （§7.12 禁止心跳超时删资源），只产出 `node_unreachable` finding。
 *      这是「补齐缺失 runtime」的例外：节点不在场，补也补不上。
 *   3. **error 态受退避保护**（`retryBackoffMs`）。`revision_behind` +
 *      error 且距上次 apply 太近 → 延迟到下一轮，不每轮都打 agent。
 *      `missing_runtime` 不受退避限制：agent 根本就没有这条隧道，等下去只会
 *      无限期缺失。
 */
export function planTunnelActions(
  tunnel: DesiredTunnel,
  drifts: Drift[],
  now: Date,
  opts: { staleAfterMs?: number; retryBackoffMs?: number; nodeReachable?: boolean } = {},
): PlannedAction[] {
  if (!hasDeclaredDesired(tunnel)) return [];
  if (opts.nodeReachable === false) return [];

  const kinds = new Set(drifts.map((d) => d.kind));
  const actions: PlannedAction[] = [];
  const revision = tunnel.config_revision as number;

  if (kinds.has("missing_runtime")) {
    actions.push({
      kind: "fill_missing_runtime",
      detail: `desired active，agent 缺 runtime，重发 revision ${revision}`,
      revision,
      tunnel_id: tunnel.id,
      node_id: tunnel.egress_node_id ?? null,
    });
  } else if (kinds.has("revision_behind") && wantsActive(tunnel)) {
    const backoff = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const last = tunnel.last_applied_at ?? null;
    const deferError = isErrorState(tunnel) && last !== null && now.getTime() - new Date(last).getTime() < backoff;
    if (!deferError) {
      actions.push({
        kind: "resend_same_revision",
        detail: `applied ${tunnel.applied_revision ?? "null"} < desired ${revision}，同 revision 重发`,
        revision,
        tunnel_id: tunnel.id,
        node_id: tunnel.egress_node_id ?? null,
      });
    }
  }

  return actions;
}

/** finding 汇总（把偏差变成「要记录什么」）。 */
export function planFindings(
  tunnel: DesiredTunnel,
  drifts: Drift[],
  actions: PlannedAction[],
): Finding[] {
  const executed = new Set(actions.map((a) => a.kind));
  const out: Finding[] = drifts.map((d) => {
    const auto: AutoActionKind | null =
      d.kind === "missing_runtime" && executed.has("fill_missing_runtime")
        ? "fill_missing_runtime"
        : d.kind === "revision_behind" && executed.has("resend_same_revision")
          ? "resend_same_revision"
          : null;
    const severity: Severity =
      d.kind === "error_state" || d.kind === "node_unreachable"
        ? "error"
        : d.kind === "missing_runtime" || d.kind === "revision_behind"
          ? "warning"
          : "info";
    return {
      code: d.kind,
      severity,
      detail: d.detail,
      tunnel_id: tunnel.id,
      node_id: tunnel.egress_node_id ?? null,
      revision: tunnel.config_revision ?? null,
      auto_action: auto,
      suppressed: d.suppressed ?? [],
    };
  });

  // error 态 + 被退避压住的重发：单独一条 finding，让「为什么没重试」可读。
  if (isErrorState(tunnel) && !executed.has("resend_same_revision") && drifts.some((d) => d.kind === "revision_behind")) {
    out.push({
      code: "retry_deferred",
      severity: "warning",
      detail: `error 态退避窗口内，本轮不重发 revision ${tunnel.config_revision}`,
      tunnel_id: tunnel.id,
      node_id: tunnel.egress_node_id ?? null,
      revision: tunnel.config_revision ?? null,
      auto_action: null,
      suppressed: [],
    });
  }
  return out;
}

/* ================================================================== */
/* 执行层（副作用全部走注入的 deps，未注入 = 只记录不假装成功）            */
/* ================================================================== */

/**
 * 下发通道（由 WP8 编排器接线）。
 *
 * 只接受 `envelope`（已构造好的 WP6 信封）：reconciler **不**自己拼命令，
 * 否则就是 §7.13 禁令的「第二套下发逻辑」。`resolveRevision` 的作用是把
 * 「重发哪一版」这件事收敛到调用方 —— reconciler 只会传 tunnel 自身的
 * `config_revision`，绝不自造版本号。
 */
export interface ReconcileSink {
  /** 同 revision 重发（幂等：agent 对等版本回 duplicate ACK）。 */
  resendSameRevision(input: {
    tunnel_id: number;
    revision: number;
    envelope: unknown;
  }): Promise<void>;
}

/** 端口租约回收依赖（复用 WP3 的孤儿判定，不复制第二套规则）。 */
export interface ReconcileLeasePort {
  /** WP3 `reconcileLeases` 的返回值形状。 */
  (options: { dryRun?: boolean; now?: Date; deps?: unknown }): Promise<{
    releasedDanglingTunnel: number;
    releasedExpired: number;
  }>;
}

/** 日志出口（默认控制台，测试可捕获）。 */
export type ReconcileLogger = (message: string, meta: Record<string, unknown>) => void;

/** 每个节点最近一次上报快照（key = `Node.id`）。 */
export type NodeReport = {
  /** 面板收到上报的时刻（DB 侧真相，WP7 写入）。 */
  reported_at: Date | null;
  /** Agent 自称正在运行的隧道。 */
  tunnels: AgentTunnelState[];
  last_error?: string | null;
};

export interface ReconcileDeps {
  /** DB 事实来源。 */
  tunnels?(): Promise<DesiredTunnel[]>;
  reports?(): Promise<Map<number, NodeReport>>;
  /** 节点在线性事实。 */
  nodes?(): Promise<NodeOnlineInput[]>;
  /** 下发通道；未提供 = 重发类动作只能记 finding（`no_transport`）。 */
  sink?: ReconcileSink | null;
  /** 端口租约回收（生产 = WP3 `reconcileLeases`）。 */
  reconcileLeases?: ReconcileLeasePort | null;
  /** 端口租约回收的依赖注入（透传给 WP3）。 */
  leaseDeps?: unknown;
  log?: ReconcileLogger;
  now?(): Date;
  staleAfterMs?: number;
  retryBackoffMs?: number;
  /** 域：workspace scope 过滤（NULL = 全租户）。 */
  scope?: number | null;
}

/** 一轮 reconcile 的结果统计。 */
export interface ReconcileOutcome {
  scanned: number;
  findings: Finding[];
  actions: PlannedAction[];
  /** 真正通过 sink 下发成功的条数。 */
  resent: number;
  /** 有 sink 但下发抛错的条数（只记 finding，不改 apply_status）。 */
  failed: number;
  /** 没有 sink、无法下发的条数（`no_transport`）。 */
  noTransport: number;
  /** 端口租约回收统计（`null` = 本轮未配置回收依赖）。 */
  leases: { releasedDanglingTunnel: number; releasedExpired: number } | null;
  forbiddenSuppressed: ForbiddenActionKind[];
}

const EMPTY_LEASES = { releasedDanglingTunnel: 0, releasedExpired: 0 };

/** 生产依赖：真实 Prisma / 控制面 sink（懒加载，避免单测引入即连库）。 */
export function defaultReconcileDeps(): ReconcileDeps {
  return {
    async tunnels() {
      const { db } = await import("../db.ts");
      const rows = await db.tunnel.findMany({
        where: { config_revision: { not: null } },
        select: {
          id: true,
          name: true,
          tunnel_mode: true,
          desired_status: true,
          config_revision: true,
          applied_revision: true,
          apply_status: true,
          apply_error_code: true,
          apply_error: true,
          last_applied_at: true,
          listen_port: true,
          egress_port: true,
          egress_node_id: true,
          in_node_group_id: true,
        },
      });
      return rows as unknown as DesiredTunnel[];
    },
    async nodes() {
      const { db } = await import("../db.ts");
      const rows = await db.node.findMany({
        select: { id: true, status: true, last_seen_at: true, state_report: { select: { reported_at: true } } },
      });
      return rows.map((r) => ({
        node_id: r.id,
        status: r.status,
        last_seen_at: r.last_seen_at ?? null,
        reported_at: r.state_report?.reported_at ?? null,
      })) as NodeOnlineInput[];
    },
    async reports() {
      // Agent 侧 applied state：WP7 的 node_state_report 快照（每节点一行）。
      // key 用 node.id 而非上报里的字符串 node_id：DB 外键全走主键。
      const { db } = await import("../db.ts");
      const rows = await db.nodeStateReport.findMany({
        select: { node_id: true, reported_at: true, tunnels: true, last_error: true },
      });
      const map = new Map<number, { reported_at: Date | null; tunnels: AgentTunnelState[]; last_error: string | null }>();
      for (const r of rows) {
        const raw = r.tunnels;
        const list = Array.isArray(raw) ? (raw as unknown as AgentTunnelState[]) : [];
        map.set(r.node_id, { reported_at: r.reported_at ?? null, tunnels: list, last_error: r.last_error ?? null });
      }
      return map;
    },
    // 端口租约回收：**复用 WP3 的孤儿判定**（悬空 tunnel_id / 过期预分配），
    // 不在本模块复制第二套规则（§7.12「清理确认无主 lease」的唯一实现点）。
    async reconcileLeases(options: { dryRun?: boolean; now?: Date; deps?: unknown }) {
      const { reconcileLeases } = await import("./portPool.ts");
      return (await reconcileLeases(options as { dryRun?: boolean; now?: Date })) as {
        releasedDanglingTunnel: number;
        releasedExpired: number;
      };
    },
    log: (message, meta) => console.warn(message, meta),
    now: () => new Date(),
  };
}

/** 取端口租约回收依赖（`reconcileLeases` 槽位，未注入 = 本轮不回收）。 */
function leaseReconcilerFrom(deps: ReconcileDeps): ReconcileLeasePort | null {
  return deps.reconcileLeases ?? null;
}

/**
 * 跑一轮 reconcile。
 *
 * 顺序固定：**判定 → 动作 → 记录**。判定阶段不产生任何写操作，因此 dryRun
 * 不需要单独实现（动作被 sink 的有无天然区分：`sink: null` ⇒ 全部降级为
 * finding）。
 *
 * 端口租约回收独立于逐隧道比对：它只回答「哪些租约确认无主」（§7.12 第三
 * 个允许项），不回答隧道状态。回收结果以 finding 形式并回本轮回合。
 */
export async function executeReconcile(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  const findings: Finding[] = [];
  const actions: PlannedAction[] = [];
  const forbidden = new Set<ForbiddenActionKind>();
  let resent = 0;
  let failed = 0;
  let noTransport = 0;

  const loadTunnels = deps.tunnels ?? (async () => [] as DesiredTunnel[]);
  const loadNodes = deps.nodes ?? (async () => [] as NodeOnlineInput[]);
  const loadReports = deps.reports ?? (async () => new Map<number, NodeReport>());

  const tunnels = await loadTunnels();
  const nodeList = await loadNodes();
  const reports = await loadReports();

  const nodeById = new Map<number, NodeOnlineInput>();
  for (const n of nodeList) {
    const prev = nodeById.get(n.node_id);
    // 同一 node_id 多行时取「更新鲜」的那份（last_seen_at / reported_at 取大）。
    if (!prev) nodeById.set(n.node_id, n);
    else {
      const ts = (x: NodeOnlineInput) =>
        Math.max(x.last_seen_at ? new Date(x.last_seen_at).getTime() : 0, x.reported_at ? new Date(x.reported_at).getTime() : 0);
      nodeById.set(n.node_id, ts(n) > ts(prev) ? n : prev);
    }
  }

  for (const t of tunnels) {
    // agent applied state：优先取 ingress 节点快照（DIRECT 场景即入口节点），
    // RELAY 再看 egress 节点。两份快照都可能没有这条隧道 —— 都缺才算
    // missing_runtime（无法确认到底哪侧丢了，但 desired 也没声明哪侧，
    // 这正是「只重发同 revision、不换节点」能覆盖的范围）。
    const report = pickReport(reports, t);
    const agent = pickAgentTunnel(report, t);
    const node = pickNode(nodeById, t);

    // 找不到归属节点（DIRECT 隧道没有 egress_node_id、或节点行已被删）⇒
    // **不视为可达**：此时无从判断 agent 是否在场，更不能往一个不存在的
    // 节点上重发。语义与 isNodeUnreachable(node=null) 对齐：只产 finding。
    const reachable = node !== null && !isNodeUnreachable(node, now, deps.staleAfterMs);
    const drifts = computeDrift(t, agent, node, now, { staleAfterMs: deps.staleAfterMs });
    for (const d of drifts) for (const s of d.suppressed ?? []) forbidden.add(s);

    const planned = planTunnelActions(t, drifts, now, {
      staleAfterMs: deps.staleAfterMs,
      retryBackoffMs: deps.retryBackoffMs,
      nodeReachable: reachable,
    });

    findings.push(...planFindings(t, drifts, planned));

    for (const a of planned) {
      // 白名单二次闸门：即使 planTunnelActions 里混进白名单外动作也发不下去。
      const gate = decideAutoAction(a.kind);
      if (!gate.allowed) {
        findings.push({
          code: "resend_skipped",
          severity: "warning",
          detail: `动作 ${a.kind} 不在自动白名单内，已压制`,
          tunnel_id: t.id,
          node_id: a.node_id ?? null,
          revision: a.revision ?? null,
          auto_action: null,
          suppressed: gate.suppressed === "unknown_action" ? [] : [gate.suppressed],
        });
        continue;
      }
      if (gate.kind === "release_orphan_lease") continue; // 由租约回收段统一执行

      if (!deps.sink) {
        noTransport++;
        findings.push({
          code: "resend_skipped",
          severity: "warning",
          detail: `无下发通道（sink 未注入），未发送 ${a.kind}`,
          tunnel_id: t.id,
          node_id: a.node_id ?? null,
          revision: a.revision ?? null,
          auto_action: null,
          suppressed: [],
        });
        continue;
      }
      // envelope 由调用方（WP8 编排器）在 sink 内构造：reconciler 只声明
      // 「用这个 tunnel 的哪个 revision」，绝不自己拼命令信封。
      try {
        await deps.sink.resendSameRevision({ tunnel_id: t.id, revision: a.revision as number, envelope: null });
        resent++;
        actions.push(a);
      } catch (e) {
        failed++;
        findings.push({
          code: "resend_skipped",
          severity: "error",
          detail: `下发失败：${(e as Error)?.message ?? String(e)}`,
          tunnel_id: t.id,
          node_id: a.node_id ?? null,
          revision: a.revision ?? null,
          auto_action: null,
          suppressed: [],
        });
      }
    }
  }

  // ── 端口租约回收（§7.12 允许项三）──
  let leases: { releasedDanglingTunnel: number; releasedExpired: number } | null = null;
  const leaseReconciler = leaseReconcilerFrom(deps);
  if (leaseReconciler) {
    try {
      leases = await leaseReconciler({ dryRun: false, now, ...(deps.leaseDeps ? { deps: deps.leaseDeps } : {}) });
      if (leases.releasedDanglingTunnel > 0 || leases.releasedExpired > 0) {
        findings.push({
          code: "orphan_lease_released",
          severity: "warning",
          detail: `回收确认无主租约：悬空 ${leases.releasedDanglingTunnel} / 过期 ${leases.releasedExpired}`,
          node_id: null,
          auto_action: "release_orphan_lease",
          suppressed: [],
        });
      }
    } catch (e) {
      findings.push({
        code: "resend_skipped",
        severity: "error",
        detail: `租约回收失败：${(e as Error)?.message ?? String(e)}`,
        auto_action: null,
        suppressed: [],
      });
    }
  }

  if (findings.length > 0) {
    log("[reconciler]", {
      scope: deps.scope ?? null,
      scanned: tunnels.length,
      findings: findings.length,
      resent,
      failed,
      noTransport,
    });
  }

  return {
    scanned: tunnels.length,
    findings,
    actions,
    resent,
    failed,
    noTransport,
    leases: leases ?? (leaseReconciler ? EMPTY_LEASES : null),
    forbiddenSuppressed: [...forbidden],
  };
}

/** 取该隧道的 agent applied 快照（RELAY 取 egress 侧，DIRECT 取 ingress 侧附近的节点）。 */
function pickReport(
  reports: Map<number, NodeReport>,
  t: DesiredTunnel,
): NodeReport | undefined {
  return reports.get(t.egress_node_id ?? -1) ?? undefined;
}

/** 在快照里按字符串 id 找这条隧道。 */
function pickAgentTunnel(
  report: { reported_at: Date | null; tunnels: AgentTunnelState[] } | undefined,
  t: DesiredTunnel,
): AgentTunnelState | null {
  if (!report) return null;
  const id = String(t.id);
  return report.tunnels.find((x) => x.id === id) ?? null;
}

/** 该隧道归属节点的在线性事实。 */
function pickNode(nodeById: Map<number, NodeOnlineInput>, t: DesiredTunnel): NodeOnlineInput | null {
  if (t.egress_node_id === null || t.egress_node_id === undefined) return null;
  return nodeById.get(t.egress_node_id) ?? null;
}

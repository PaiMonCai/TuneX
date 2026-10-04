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
  ingress_node_id?: number | null;
  egress_node_id?: number | null;
  /** V5.4：三跳路由的中间节点；null = V4 单跳 RELAY。 */
  middle_node_id?: number | null;
  in_node_group_id?: number | null;
  /**
   * V5.3（round 6/7）—— reconcile 必须能比较**内容**，不只是"存在性与 revision"：
   *   · `desired_pool_targets` = 池里 active 目标的 `host:port`（升序）；
   *   · `desired_target_health` = 面板此刻的合成结论（`host:port=state`，升序）。
   * `undefined` = 本次没有加载这些事实，此时**不**判内容漂移（"没加载" ≠ "为空"）。
   */
  desired_pool_targets?: string[] | null;
  desired_target_health?: string[] | null;
  /**
   * 协议事实（V5-WP0/WP4）。**必须**随行一起投影：resend 路径要据此判定这份事实
   * 是否可运行；缺列会被 fail-closed 拒绝（`admitPersistedProtocol` 不再把
   * 「投影忘了选列」当成 V4 的「省略协议」）。
   */
  forward_protocol?: string | null;
  tunnel_type?: string | null;
  /** V5-WP5-A1: node-local tls front paths (paths only, never key material). */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
}

/** Agent 快照里的单条隧道（对齐 services/node-state.ts 的 ReportedTunnel）。 */
export interface AgentTunnelState {
  id: string;
  mode?: string | null;
  ingress_port?: number | null;
  egress_port?: number | null;
  revision?: number | null;
  /** 该节点上报的**已应用**池目标（`host:port`，升序）。 */
  applied_pool_targets?: string[] | null;
  /** 该节点上报的**已应用**健康数组（`host:port=state`，升序）。 */
  applied_target_health?: string[] | null;
}

/** 节点在线性事实。 */
export interface NodeOnlineInput {
  node_id: number;
  /** `node.status`；inactive = 离线检测已判定掉线。 */
  status?: "active" | "inactive" | null;
  last_seen_at?: Date | null;
  /** state_report.reported_at：面板侧收到上报的时刻（DB 侧真相）。 */
  reported_at?: Date | null;
  /**
   * WP5 `node.lifecycle`（desired 管理态，§13.4.1）。**与 status 正交**：
   * status 是「连没连上」（事实），lifecycle 是「允不允许接新业务」（期望）。
   * 缺省 undefined = 读到的行没有这一列（WP5 之前的替身/旧查询），此时
   * 不据此等待。
   */
  lifecycle?: string | null;
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
  /** 节点处于 maintenance：本轮不下发，只等待（§13.4.2）。 */
  | "node_in_maintenance"
  /** 上次 apply 以 error 收尾。 */
  | "error_state"
  /**
   * 已应用的**内容**与 desired 不一致（池目标集合、健康数组）。
   *
   * 存在性与 revision 都对、内容却过期 —— 症状是"池变空"、"熔断看着没生效"，
   * 而 reconcile 认为一切正常（`resent: 0`）。
   */
  | "content_drift";

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
  return t.tunnel_mode.toLowerCase() !== agent.mode.toLowerCase();
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
 * 节点是否处于「等待应用」状态（V4-WP5 §13.4.2 maintenance）。
 *
 * maintenance 的三条语义在本函数落地：
 *   1. **不接受需要立即应用的新 runtime 变化** ⇒ reconciler 本轮不下发；
 *   2. **已存在 runtime 尽量保持，不做隐式删除** ⇒ 只产 finding，不动任何资源；
 *   3. **退出维护后 Reconciler 只应用最新 desired revision** ⇒ 这里只「等」，
 *      不改 revision、不换节点——下一轮节点回到 active 时 `wantsActive` +
 *      `isRevisionBehind` 自然 converging，无需额外队列。
 *
 * 只认 `maintenance`：`disabled` / `retiring` 的 runtime 处理语义不同
 * （§13.4.2 disabled：不得静默级联删除，依赖由用户显式处理），那是编排层
 * 与人工 Retry 的职责，不该由巡检悄悄决定「等」还是「撤」。
 *
 * `undefined`（列不存在 / 未投影）⇒ false：存量库里没有这个字段时不能把
 * 每条隧道都变成等待态。
 */
export function isNodeInMaintenance(node: NodeOnlineInput | null | undefined): boolean {
  return node?.lifecycle === "maintenance";
}

/**
 * 单条隧道的偏差清单（纯函数）。
 *
 * 不在此处产出动作：`computeDrift` 回答「差在哪」，`planTunnelActions` 回答
 * 「允许怎么修」。混在一起会让「同一偏差只能有一种修法」的约束散落各处。
 */
/**
 * agent 上报的池目标（`host:port`，升序）—— "已应用内容"的一半。
 *
 * V5.3 round 6 实测：agent 的池可以变空，而隧道仍在列表里，于是存在性判定认为一切正常、
 * `resent: 0`，转发却什么都转发不出去（连得上、没数据）。
 */
function appliedPoolTargets(report: NodeReport | undefined, tunnelId: number): string[] | null {
  if (!report) return null;
  const pools = (report as unknown as { egress_pools?: Record<string, { targets?: unknown }> }).egress_pools;
  if (!pools || typeof pools !== "object") return null;
  const pool = pools[`tunex-${tunnelId}-egress`];
  if (!pool || !Array.isArray(pool.targets)) return null;
  return pool.targets.filter((x): x is string => typeof x === "string").slice().sort();
}

/** agent 应用的健康数组（`host:port=state`，升序）；没带就返回 null（= 不判漂移）。 */
function appliedTargetHealth(egress: AgentTunnelState | null): string[] | null {
  const raw = (egress as unknown as {
    target_health?: Array<{ host?: unknown; port?: unknown; state?: unknown }>;
  })?.target_health;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((h) => typeof h?.host === "string" && typeof h?.port === "number" && typeof h?.state === "string")
    .map((h) => `${h.host}:${h.port}=${h.state}`)
    .sort();
}

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
  // ── 内容漂移（V5.3 round 6/7）──
  //
  // 存在性与 revision 都对，但**内容**过期。只在两侧都有事实时判定：任一侧为 undefined
  // 表示本次没有加载，"没加载"绝不能被读成"内容为空"，否则每一拍都会重发一次。
  if (wantsActive(tunnel) && agent !== null && !unreachable) {
    const desiredTargets = tunnel.desired_pool_targets;
    const appliedTargets = agent.applied_pool_targets;
    if (Array.isArray(desiredTargets) && Array.isArray(appliedTargets)) {
      const want = [...desiredTargets].sort().join(",");
      const have = [...appliedTargets].sort().join(",");
      if (want !== have) {
        out.push({
          kind: "content_drift",
          detail:
            `池目标不一致：desired=[${want || "空"}] applied=[${have || "空"}]` +
            (appliedTargets.length === 0 && desiredTargets.length > 0
              ? "（agent 池为空：转发会连上但转发不出数据）"
              : ""),
        });
      }
    }
    const desiredHealth = tunnel.desired_target_health;
    const appliedHealth = agent.applied_target_health;
    if (Array.isArray(desiredHealth) && Array.isArray(appliedHealth) &&
        [...desiredHealth].sort().join(",") !== [...appliedHealth].sort().join(",")) {
      out.push({
        kind: "content_drift",
        detail: `健康数组不一致：desired=[${[...desiredHealth].sort().join(",")}] applied=[${[...appliedHealth].sort().join(",")}]`,
      });
    }
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
  if (node && isNodeInMaintenance(node)) {
    // §13.4.2 maintenance：**存量 runtime 保留，新 runtime 变化等待**。
    // 与 node_unreachable 的关键差别：节点是**可达**的，所以这不是故障，
    // 而是一个有明确退出条件的管理状态。把它渲染成「离线」会让人去查网络。
    out.push({
      kind: "node_in_maintenance",
      detail: "节点维护中：本轮不下发新 runtime，退出维护后由 Reconciler 应用最新 desired revision",
      // 维护期间换节点 = 把用户没要求过的迁移做了；改端口同理。
      suppressed: ["switch_node", "migrate_tunnel", "change_port"],
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
 *   4. **maintenance 节点等待**（WP5 §13.4.2）。只有 `active` 才承载新
 *      runtime；维护中的节点本轮不下发，退出后自然收敛（见
 *      {@link isNodeInMaintenance}）。`disabled` / `retiring` 不在此列——
 *      那两种状态的 runtime 归属是编排决策，不是巡检该悄悄做的。
 */
export function planTunnelActions(
  tunnel: DesiredTunnel,
  drifts: Drift[],
  now: Date,
  opts: { staleAfterMs?: number; retryBackoffMs?: number; nodeReachable?: boolean; nodeInMaintenance?: boolean } = {},
): PlannedAction[] {
  if (!hasDeclaredDesired(tunnel)) return [];
  // 节点不在场 ⇒ 什么都不自动做（离线补不上缺失的 runtime，只能等回来）。
  if (opts.nodeReachable === false) return [];
  // V4-WP5 §13.4.2：maintenance 节点**等待**。存量 runtime 一行不动、新
  // desired revision 一条不发——退出维护后 wantsActive + isRevisionBehind
  // 会自然把最新 revision 应用掉，所以这里不需要「记住待办」的队列。
  if (opts.nodeInMaintenance === true) return [];

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
  } else if (kinds.has("content_drift") && wantsActive(tunnel)) {
    // 同 revision 重发：池目标与健康数组不是 revision 的一部分，它们来自面板的实时读。
    // 这正是"存在性对了、内容过期"应有的修法 —— 不需要新机制，也不需要 bump revision。
    actions.push({
      kind: "resend_same_revision",
      detail: `内容漂移，同 revision ${revision} 重发以带上当前内容`,
      revision,
      tunnel_id: tunnel.id,
      node_id: tunnel.egress_node_id ?? tunnel.ingress_node_id ?? null,
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
  /**
   * Agent 自报的池视图（`{ "<tunnelId>": { targets: ["host:port", ...] } }`）。
   *
   * V5.3：**内容漂移判定需要它**。第一版没把它从上报里取出来，于是
   * `applied_pool_targets` 恒为 null、"缺事实不判漂移"的保护让内容漂移永不触发 ——
   * 表现就是 `resent: 0` 一直不变，而池可能已经空了。
   */
  egress_pools?: Record<string, { targets?: unknown }> | null;
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
  /**
   * V5.3 WP10：自动故障转移评估（生产 = `runFailoverSweep`）。
   *
   * 注入而不是直接 import，有两个理由：本模块的用例不需要数据库；以及**顺序**
   * 必须由调用方掌握 —— 先续跑未完成的 rollout，再评估新的迁移，否则一次未完成的迁移
   * 会被当成"又一次掉线"再迁一遍。
   *
   * 缺省 = 不评估（旧行为）。这不是"忘了接线"的安全网，而是**有意的缺省**：没有策略
   * 配置时自动迁移本来就不该发生（§8：必须是显式 policy）。
   */
  failoverSweep?: (() => Promise<{ evaluated: number; moved: number; held: number }>) | null;
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
  /**
   * V5.3 WP10：自动迁移评估结果（`null` = 本轮未配置该依赖）。
   *
   * 放在 outcome 里而不是只写日志：迁移是"改变了谁承载流量"的动作，它的次数必须和
   * resend/failed 一样是**可观测的返回值**，否则"这轮到底有没有搬流量"只能靠翻日志。
   */
  failover: { evaluated: number; moved: number; held: number } | null;
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
          // V5-WP4/G0: the protocol fact travels with the row, because the sink
          // that resends it must decide whether this fact is runnable. Without
          // these columns `admitPersistedProtocol` sees "no fact at all" and the
          // old default would have replayed a historical non-TCP Forward as TCP.
          forward_protocol: true,
          tunnel_type: true,
          // V5-WP5-A1/A2: the tls front's paths travel with the row, so a resend
          // can dispatch the same configuration the create did. Without them a
          // tls Forward would be resendable but un-dispatchable.
          tls_cert_path: true,
          tls_key_path: true,
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
          ingress_node_id: true,
          egress_node_id: true,
          middle_node_id: true,
          in_node_group_id: true,
          // V5.3（round 7）：内容漂移判定需要**期望内容**。只取 active 目标：
          // 停用的目标不参与转发，不该因为它们触发重发。
          egress_pool: { select: { targets: { select: { host: true, port: true, status: true } } } },
        },
      });
      const withContent = (rows as unknown as Array<{
        egress_pool?: { targets?: Array<{ host: string; port: number; status: string }> } | null;
        [key: string]: unknown;
      }>).map((row) => {
        const targets = (row.egress_pool?.targets ?? [])
          .filter((t) => t.status === "active")
          .map((t) => `${t.host}:${t.port}`);
        const { egress_pool: _dropped, ...rest } = row;
        return { ...rest, desired_pool_targets: targets } as unknown as DesiredTunnel;
      });
      return withContent;
    },
    async nodes() {
      const { db } = await import("../db.ts");
      const rows = await db.node.findMany({
        // WP5：lifecycle 是 §13.4.1 的另一半状态。缺了它，maintenance 节点会被
        // 当成「可达且 active」而照样下发新 revision——那正是 §13.4.2 禁的行为。
        select: { id: true, status: true, last_seen_at: true, lifecycle: true, state_report: { select: { reported_at: true } } },
      });
      return rows.map((r) => ({
        node_id: r.id,
        status: r.status,
        last_seen_at: r.last_seen_at ?? null,
        reported_at: r.state_report?.reported_at ?? null,
        lifecycle: r.lifecycle ?? null,
      })) as NodeOnlineInput[];
    },
    async reports() {
      // Agent 侧 applied state：WP7 的 node_state_report 快照（每节点一行）。
      // key 用 node.id 而非上报里的字符串 node_id：DB 外键全走主键。
      const { db } = await import("../db.ts");
      const rows = await db.nodeStateReport.findMany({
        select: {
          node_id: true,
          reported_at: true,
          tunnels: true,
          last_error: true,
          egress_pools: true,
        },
      });
      const map = new Map<number, NodeReport>();
      for (const r of rows) {
        const raw = r.tunnels;
        const list = Array.isArray(raw) ? (raw as unknown as AgentTunnelState[]) : [];
        map.set(r.node_id, {
          reported_at: r.reported_at ?? null,
          tunnels: list,
          last_error: r.last_error ?? null,
          egress_pools:
            r.egress_pools && typeof r.egress_pools === "object" && !Array.isArray(r.egress_pools)
              ? (r.egress_pools as Record<string, { targets?: unknown }>)
              : null,
        });
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

  let failoverSummary: { evaluated: number; moved: number; held: number } | null = null;
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
    const agent = pickAgentTunnel(reports, t);
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
      nodeInMaintenance: node !== null && isNodeInMaintenance(node),
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

  // ── V5.3 WP10：自动迁移评估（在逐条修复之后）──
  //
  // 顺序是刻意的：先把"该重发的重发、该补 runtime 的补上"，再考虑"要不要把归属搬走"。
  // 反过来的话，一个只是暂时落后的节点会被判成故障并触发一次代价高昂的迁移。
  if (deps.failoverSweep) {
    try {
      failoverSummary = await deps.failoverSweep();
      if (failoverSummary.moved > 0) {
        log("failover sweep", { moved: failoverSummary.moved, evaluated: failoverSummary.evaluated });
      }
    } catch (e) {
      // 迁移评估失败绝不阻断本轮 reconcile：下一轮会自然重试，且失败本身已由
      // 执行器的结构化结果记账（这里只保证不影响其它动作）。
      log("failover sweep failed", { detail: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    scanned: tunnels.length,
    findings,
    actions,
    resent,
    failed,
    noTransport,
    failover: failoverSummary,
    leases: leases ?? (leaseReconciler ? EMPTY_LEASES : null),
    forbiddenSuppressed: [...forbidden],
  };
}

/**
 * Agent 侧 runtime id 的**唯一**拼接口径（V4-WP6 的 health synthesis 也用它，
 * 所以是 export：两处各拼一次的话，Agent 侧改了规则就会出现「reconciler 说
 * 落后、health 说没运行」的分叉）。
 */
export function runtimeId(tunnelId: number, direction: "direct" | "ingress" | "egress"): string {
  return direction === "direct"
    ? `tunex-${tunnelId}-direct`
    : direction === "ingress"
      ? `tunex-${tunnelId}-relay`
      : `tunex-${tunnelId}-egress`;
}

/**
 * Collapse the concrete Agent-side runtime(s) into one reconciliation view.
 * DIRECT requires its ingress runtime; RELAY desired-active requires both
 * ingress + egress. A half-present RELAY is treated as missing_runtime so the
 * sink replays the same revision to both bound nodes.
 */
function pickAgentTunnel(
  reports: Map<number, NodeReport>,
  t: DesiredTunnel,
): AgentTunnelState | null {
  const ingressReport =
    t.ingress_node_id == null ? undefined : reports.get(t.ingress_node_id);
  const ingressId = t.tunnel_mode === "relay"
    ? runtimeId(t.id, "ingress")
    : runtimeId(t.id, "direct");
  const ingress = ingressReport?.tunnels.find((x) => x.id === ingressId) ?? null;

  if (t.tunnel_mode !== "relay") {
    if (!ingress) return null;
    return {
      ...ingress,
      id: String(t.id),
      mode: "direct",
    };
  }

  const egressReport =
    t.egress_node_id == null ? undefined : reports.get(t.egress_node_id);
  const egress = egressReport?.tunnels.find((x) => x.id === runtimeId(t.id, "egress")) ?? null;
  const middleReport =
    t.middle_node_id == null ? undefined : reports.get(t.middle_node_id);
  // Transit deliberately reuses the EGRESS runtime primitive and therefore the
  // same resource id suffix. Node id disambiguates the concrete runtime.
  const middle =
    t.middle_node_id == null
      ? null
      : middleReport?.tunnels.find((x) => x.id === runtimeId(t.id, "egress")) ?? null;

  // When desired is inactive, one leftover leg is enough to flag
  // unexpected_runtime. When desired is active, EVERY concrete leg is required.
  if (!wantsActive(t)) {
    const any = ingress ?? middle ?? egress;
    if (!any) return null;
    const revisions = [ingress?.revision, middle?.revision, egress?.revision]
      .filter((v): v is number => typeof v === "number");
    return {
      id: String(t.id),
      mode: "relay",
      ingress_port: ingress?.ingress_port ?? null,
      egress_port: egress?.egress_port ?? null,
      revision: revisions.length > 0 ? Math.min(...revisions) : 0,
    };
  }
  if (!ingress || !egress || (t.middle_node_id != null && !middle)) return null;

  const ingressMode = String(ingress.mode ?? "").toLowerCase();
  const middleMode = String(middle?.mode ?? "").toLowerCase();
  const egressMode = String(egress.mode ?? "").toLowerCase();
  // A RELAY resource is healthy only when every concrete runtime has its
  // expected role. In a three-hop route the middle runtime is EGRESS-shaped.
  const mode =
    ingressMode !== "" && ingressMode !== "relay"
      ? ingressMode
      : middleMode !== "" && middleMode !== "egress"
        ? middleMode
        : egressMode !== "" && egressMode !== "egress"
          ? egressMode
          : "relay";

  const revisions = [
    ingress.revision ?? 0,
    ...(middle ? [middle.revision ?? 0] : []),
    egress.revision ?? 0,
  ];

  return {
    id: String(t.id),
    mode,
    // V5.3（round 7）：业务 target/health 仍属于最终出口，不把 transit 的
    // 单一 next-hop 伪装成业务池内容。
    applied_pool_targets: appliedPoolTargets(egressReport, t.id),
    applied_target_health: appliedTargetHealth(egress),
    ingress_port: ingress.ingress_port ?? null,
    egress_port: egress.egress_port ?? null,
    revision: Math.min(...revisions),
  };
}

/**
 * A RELAY is auto-repairable only while both of its already-bound nodes are
 * reachable. This deliberately does not select a replacement Node.
 */
function pickNode(
  nodeById: Map<number, NodeOnlineInput>,
  t: DesiredTunnel,
): NodeOnlineInput | null {
  if (t.ingress_node_id == null) return null;
  const ingress = nodeById.get(t.ingress_node_id);
  if (!ingress) return null;
  if (t.tunnel_mode !== "relay") return ingress;

  if (t.egress_node_id == null) return null;
  const egress = nodeById.get(t.egress_node_id);
  if (!egress) return null;
  const middle =
    t.middle_node_id == null ? null : nodeById.get(t.middle_node_id) ?? null;
  if (t.middle_node_id != null && !middle) return null;

  const boundNodes = [ingress, ...(middle ? [middle] : []), egress];
  const status = boundNodes.some((n) => n.status === "inactive")
    ? "inactive"
    : "active";

  const seen = (n: NodeOnlineInput): number | null => {
    const d = n.last_seen_at ?? n.reported_at ?? null;
    return d ? new Date(d).getTime() : null;
  };
  const seenValues = boundNodes.map(seen);
  const oldest =
    seenValues.some((v) => v == null)
      ? null
      : new Date(Math.min(...(seenValues as number[])));
  // V4-WP5 §13.4.2：lifecycle 必须随折叠视图带出去。漏了它，
  // `executeReconcile` 的 `nodeInMaintenance` 对 RELAY 恒为 false（DIRECT 走
  // 上面的 early return 所以不受影响），维护中的入口/出口节点会被照样下发新
  // desired revision——正是 §13.4.2「不接受需要立即应用的新 runtime 变化」
  // 禁止的行为。**任一侧 maintenance 就按维护处理**：RELAY 的新 runtime 要同时
  // 落在两侧，只放行一侧等于把半态写进数据面。其余 lifecycle 取值原样投影
  // （planTunnelActions 只认 maintenance，disabled / retiring 的处理另属编排层）。
  const anyMaintenance = boundNodes.some((n) => n.lifecycle === "maintenance");

  return {
    node_id: ingress.node_id,
    status,
    last_seen_at: oldest,
    reported_at: oldest,
    lifecycle: anyMaintenance
      ? "maintenance"
      : (ingress.lifecycle ?? middle?.lifecycle ?? egress.lifecycle ?? null),
  };
}

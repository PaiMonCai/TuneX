/**
 * WP8 — Scheduler + RELAY Orchestrator（Track C，集成型工作包）。
 *
 * 依据 `DEVELOPMENT.md` §7.11「WP8 — Scheduler + RELAY Orchestrator」与
 * §4.1「Tunnel 是期望状态，不是一次 HTTP 操作」、§4.2「RELAY 编排铁律」。
 *
 * ── 本模块负责什么 ──
 *  把「用户要一条 RELAY 隧道」这个意图，按 §7.11 冻结的**固定顺序**编排到底：
 *
 *    auth/quota
 *    → desired Tunnel=pending
 *    → bind ingress/egress Node
 *    → acquire ports
 *    → revision++
 *    → apply Egress
 *    → Egress ACK
 *    → apply Ingress
 *    → Ingress ACK
 *    → active
 *
 * ── 本模块不负责什么 ──
 *  · 不碰 HTTP 路由（WP11 才挂端�点；本模块只交付服务层，与 WP6 contract
 *    测试同一模式——零 hono 依赖，可在无 DB 环境下离线单测）。
 *  · 不做 Reconciler 的周期对账（WP9）。这里只在**一次**创建流程内做补偿。
 *  · 不物理删除 Tunnel：任何失败都保留行（§4.1「失败时保留 Tunnel，
 *    前端展示原因并允许 Retry」）。
 *  · 不接最终 transport：下发走 {@link AgentGateway} 接口（见 orchestrator.ts），
 *    默认实现经 WP6 命令信封 / {@link ControlValidator}，Agent 侧 HTTP 通道
 *    由 WP7 的 node session 落地后接入。WP8 只冻结「谁先谁后、失败怎么补偿」。
 *
 * ── 失败补偿（§7.11「任何失败」四条硬要求）──
 *   1. 保留 Tunnel —— 一律 `db.tunnel.update`，没有任何 `delete` 调用；
 *   2. `apply_status = "error"`；
 *   3. 写结构化错误 —— `apply_error_code`（机器码）+ `apply_error`（人读原文），
 *      错误码是 §7.11 之后各 WP 共用的稳定标识，不是临时字符串；
 *   4. 执行补偿 —— 按「已经走到哪一步」回滚**已产生的副作用**：已 ACK 的
 *      Egress 必须先 remove 掉（否则它会继续占着出口端口收流量），已占的
 *      端口租约释放掉，`desired_status` 归位。
 *
 * 补偿的顺序与下发**相反**（Egress 后进先出）：这是「先出口后入口」（§1.1）的
 * 镜像——撤的时候也必须先撤出口，否则入口还在往一个已经拆掉的出口灌流量。
 */

/* ================================================================== */
/* 依赖（全部可注入）                                                  */
/* ================================================================== */

import { db } from "../db.ts";
import { decideNodeAuth } from "./node-credential.ts";
import { acquirePort, releaseLease } from "./portPool.ts";
import type { AcquirePortOutcome } from "./portPool.ts";
import {
  countWorkspaceTunnels,
  getEffectivePolicy,
  sumWorkspaceTraffic,
} from "./policy-service.ts";
import { checkTunnelCreation } from "./capability-policy.ts";
import { canUseNodeGroup } from "./node-group-access.ts";
import { Orchestrator, type DispatchFailure, type EgressDispatchOutcome, type RelayDispatchOutcome } from "./orchestrator.ts";
import type { ControlValidator } from "./control-protocol/index.ts";
import type { RuntimeUseChecker } from "./forward-rollout-exec.ts";
import type { RuntimeUseDenied } from "./forward-capability.ts";
import {
  DEFAULT_FORWARD_PROTOCOL,
  admitPersistedProtocol,
  buildForwardRuntimePlan,
  forwardRuntimePlanViolations,
  normalizeForwardProtocol,
  persistedForwardProtocol,
  type ForwardRuntimePlan,
  type ForwardProtocol,
} from "./forward-contract.ts";
import {
  admitRuntimeFromStore,
  admissionFailureDetail,
  type AdmissionTarget,
  type CapabilityFactsLoader,
  type RuntimeAdmissionDenied,
} from "./runtime-admission.ts";

/* ================================================================== */
/* 常量与状态机                                                        */
/* ================================================================== */

/**
 * §4.1 的 apply 状态机（承载于 `Tunnel.apply_status` VARCHAR(20)）。
 *
 * WP1 的 schema 注释明确写了「状态值由 `Tunnel.apply_status` 承载，枚举随
 * WP8 编排器一起收敛」——本文件就是那个收敛点。刻意**不用 Prisma 枚举**，
 * 与 WP1 的决定一致：DB 列是已落地的 VARCHAR，应用层状态机在此定义即可，
 * 不需要为了几个字面量再 ALTER 一次表。
 */
export const APPLY_STATUS = {
  /** 记录已建，尚未开始编排（auth/quota 通过 → 落库 → 下一步之前）。 */
  pending: "pending",
  /** 编排进行中（可能长驻：等待 Agent ACK）。 */
  applying: "applying",
  /** 两端 ACK 齐，隧道生效。 */
  active: "active",
  /** 编排失败；Tunnel 保留，`apply_error_code/apply_error` 说明原因。 */
  error: "error",
  /** 被管理员/策略显式暂停（§4.1；WP11 的 suspend 端点使用）。 */
  suspended: "suspended",
} as const;

export type ApplyStatus = (typeof APPLY_STATUS)[keyof typeof APPLY_STATUS];

/** `desired_status` 只有两态（§4.1）。 */
export const DESIRED_STATUS = {
  active: "active",
  inactive: "inactive",
} as const;
export type DesiredStatus = (typeof DESIRED_STATUS)[keyof typeof DESIRED_STATUS];

/**
 * §7.11 编排失败的**结构化错误码**（`Tunnel.apply_error_code`，VARCHAR(64)）。
 *
 * 设计约束（§4.1 / §3.2「配置失败必须返回结构化错误码」）：
 *  · **机器可判定**：前端按 code 决定展示「重试」还是「联系管理员」；
 *  · **稳定**：一旦写入不随文案改版；
 *  · 与协议层 {@link ErrorCode} 分开：那是 Agent↔Panel 的报文错误码，
 *    这是控制面**编排阶段**的失败原因。两者用同一批词（timeout /
 *    node_*）是故意的，让排障时能对上看。
 */
export const SCHEDULER_ERROR_CODES = {
  /* ── ① auth / quota（编排开始前，Tunnel 记录都还没建）── */
  /** 没有可用策略 / 策略已过期（fail-closed，见 capability-policy.ts）。 */
  policy_denied: "policy_denied",
  /** 隧道数达到 max_tunnels。 */
  tunnel_limit: "tunnel_limit",
  /** 流量额度耗尽。 */
  traffic_exhausted: "traffic_exhausted",
  /** 入口或出口节点组未授权（自有判定 + NodeGroupGrant 都不过）。 */
  node_group_not_allowed: "node_group_not_allowed",
  /** Existing runtime target scope was revoked; distinct from database errors. */
  scope_revoked: "scope_revoked",
  /** RELAY 必须指定出口；DIRECT 不得指定（入参自相矛盾）。 */
  mode_topology_mismatch: "mode_topology_mismatch",
  /** 目标 host:port 格式非法。 */
  invalid_target: "invalid_target",
  /** V5-WP0：协议事实存在，但当前 runtime/Gate 未开放，禁止下发。 */
  unsupported_protocol: "unsupported_protocol",
  /**
   * V5-WP1：节点**尚未实现**这份配置所需的动作 / 协议 / 传输能力。
   *
   * 与 `unsupported_protocol` 刻意分开：那一个是「产品还没开放这个协议」（等版本
   * 或换协议），这一个是「这台节点还没实现」（升级 Agent 或换一台节点）。两者的
   * 下一步动作完全不同，压成一个码会把运维引向错误的修复方向。
   *
   * 精确原因（`upgrade_required` / `incompatible_agent` /
   * `malformed_capability_manifest` / `protocol_not_supported` /
   * `transport_not_supported` / `runtime_feature_not_supported`）随
   * `apply_error` 的 `[runtime_admission:<reason>:<layer>]` 前缀一起落库。
   */
  runtime_capability_denied: "runtime_capability_denied",

  /* ── ② bind / acquire（副作用开始产生，失败要补偿）── */
  /** 节点组下没有可用于该方向的 Node（role 不匹配或全部离线）。 */
  node_unavailable: "node_unavailable",
  /**
   * 候选节点全部没有有效的 per-node credential（WP7）。
   *
   * §3.3「服务端从 credential 得出 node identity，不得使用一个全局 token
   * 后相信 body 自报 node_id」——没有凭据的节点**不可被编排**：编排器即将
   * 向它下发真配置，此时若还不能证明「这台 Agent 就是节点 N 本人」，下发
   * 本身就建立在一个不可验证的身份上。与「节点离线」分开记：前者是拓扑
   * 故障，这是**身份缺口**，管理员要去 WP10 的 credential 端点补签。
   */
  node_credential_missing: "node_credential_missing",
  /** 入口/出口节点上都分不到端口（区间未配 / 耗尽 / 撞号）。 */
  port_allocation_failed: "port_allocation_failed",
  /** 端口 DB 唯一键之外的形态错误（user-specified 越界/黑名单）。 */
  port_invalid: "port_invalid",

  /* ── ③ apply / ACK ── */
  /** Egress 侧 apply 被拒或执行失败（含 payload_invalid / apply_failed）。 */
  egress_apply_rejected: "egress_apply_rejected",
  /** Egress ACK 超时或 status != applied。 */
  egress_ack_failed: "egress_ack_failed",
  /** Ingress 侧 apply 被拒或执行失败。 */
  ingress_apply_rejected: "ingress_apply_rejected",
  /** Ingress ACK 超时或 status != applied。 */
  ingress_ack_failed: "ingress_ack_failed",

  /* ── ④ 补偿自身失败（ rarely，但必须可观测）── */
  /** 补偿动作（remove / release lease）自身抛错。 */
  compensation_failed: "compensation_failed",

  /* ── ⑤ 其它 ── */
  /** 预条件断言失败（编码错误 / 状态机被外部篡改）。 */
  invariant_violated: "invariant_violated",
  /** 未能分类的内部错误。 */
  internal_error: "internal_error",
} as const;

export type SchedulerErrorCode = (typeof SCHEDULER_ERROR_CODES)[keyof typeof SCHEDULER_ERROR_CODES];

/**
 * `SCHEDULER_ERROR_CODES` → 是否「用户可自行修复并 Retry」。
 *
 * 前端据此分流：可重试的给按钮，不可重试的指向管理员/套餐页。
 * 放在服务层而不是 UI：重试语义属于编排知识，不是展示偏好。
 */
const RETRYABLE: ReadonlySet<SchedulerErrorCode> = new Set<SchedulerErrorCode>([
  SCHEDULER_ERROR_CODES.port_allocation_failed,
  SCHEDULER_ERROR_CODES.egress_ack_failed,
  SCHEDULER_ERROR_CODES.ingress_ack_failed,
  SCHEDULER_ERROR_CODES.egress_apply_rejected,
  SCHEDULER_ERROR_CODES.ingress_apply_rejected,
  SCHEDULER_ERROR_CODES.node_unavailable,
  SCHEDULER_ERROR_CODES.compensation_failed,
  // 注意 `node_credential_missing` **不在**这里：用户重试一万次也不会
  // 让节点凭空多出一把凭据，它必须由管理员补签（WP10 credential 端点）。
  // 把不可自愈的失败标成 retryable，前端只会给出一个注定无效的按钮。
]);

/** 该错误码是否值得让用户重试（Agent 抖动 / 端口竞态属于这一类）。 */
export function isRetryable(code: SchedulerErrorCode): boolean {
  return RETRYABLE.has(code);
}

/* ================================================================== */
/* 编排可观测性：步骤记录                                               */
/* ================================================================== */

/**
 * §7.11 的十个步骤，一一对应（顺序即验收口径）。
 * `orchestration.steps` 只用于观测与测试断言，不参与状态判定。
 */
export const SCHEDULER_STEPS = [
  "auth_quota",
  "create_pending",
  "bind_nodes",
  "acquire_ports",
  "bump_revision",
  "apply_egress",
  "egress_ack",
  // V5.4：三跳路由的中间跳（在出口之后、入口之前 —— 正向先远后近）。
  "apply_transit",
  "apply_ingress",
  "ingress_ack",
  "activate",
] as const;
export type SchedulerStep = (typeof SCHEDULER_STEPS)[number];

/** 单步执行结果（追加到 {@link CreateRelayTunnelRecord.steps}）。 */
export interface StepRecord {
  step: SchedulerStep;
  ok: boolean;
  /** 结构化错误码（ok=false 时必填）。 */
  error_code?: SchedulerErrorCode;
  /** 人读说明（**不写敏感内容**：不含凭据、完整 payload、token）。 */
  detail?: string;
  /** 步内细节（端口、revision、command_id），供测试与排障。 */
  meta?: Record<string, unknown>;
}

/* ================================================================== */
/* 入参 / 出参                                                         */
/* ================================================================== */

/** 单个出口目标（`EgressTarget` 行的最小投影；WP10 CRUD 之后由 DB 读出）。 */
export interface RelayTargetInput {
  host: string;
  port: number;
  weight?: number;
  order?: number;
}

export interface CreateRelayTunnelInput {
  /** 隧道名（写进 `tunnel.name` 与 Agent 侧 TunnelConfig.ID 后缀）。 */
  name: string;
  /** 创建者。auth 已由上层中间件完成，这里只用于归属与授权判定。 */
  userId: number;
  /** 目标 workspace（个人或团队）。 */
  workspaceId: number;
  /** 当前会话里解析出的「个人 workspace」id（`canUseNodeGroup` 需要）。 */
  personalWorkspaceId: number;
  /** 隧道协议（走 `checkTunnelCreation` 的 `protocol` 白名单）。 */
  tunnelType: string;
  /** 入口节点组（候选/授权组，落 `tunnel.in_node_group_id`）。 */
  inNodeGroupId: number;
  /** 出口节点组（RELAY 必填；落 `out_node_group_id`）。 */
  outNodeGroupId: number | null;
  /**
   * 出口目标池 id（`EgressPool.id`）。NULL = 用出口节点的 `default` 池
   * （§2.2「每个出口 Node 自动拥有一个 default pool」）。
   */
  egressPoolId?: number | null;
  /**
   * 用户指定入口端口（user-specified port）。NULL = 自动分配。
   * **与 auto 走完全相同的规则**（黑名单/区间/唯一性/DIRECT 预留），
   * 这是 §7.6 的硬要求，由 portPool 的 `portCandidates` 保证。
   */
  listenPort?: number | null;
  /** 入站监听地址；NULL = 0.0.0.0。 */
  listenIp?: string | null;
}

/** 创建失败时的返回值（Tunnel 已保留，`apply_status=error`）。 */
export interface CreateRelayFailure {
  ok: false;
  tunnelId: number;
  /** 编排已完成的步骤（含失败那一步）。 */
  steps: StepRecord[];
  /** 失败步骤。 */
  failedStep: SchedulerStep;
  error_code: SchedulerErrorCode;
  error: string;
  /** 是否建议用户重试。 */
  retryable: boolean;
}

/** 创建成功的返回值。 */
export interface CreateRelaySuccess {
  ok: true;
  tunnelId: number;
  /** 落库后的最终 revision（= 两端 ACK 的 revision）。 */
  revision: number;
  /** 实际绑定的入口节点（§2.1：禁止只存 NodeGroup）。 */
  ingressNodeId: number;
  /** 实际绑定的出口节点。 */
  egressNodeId: number | null;
  /** 用户可见入口端口。 */
  ingressPort: number;
  /** 节点间内部通信端口（非用户可见）。 */
  egressPort: number | null;
  /**
   * V5-WP2：本次下发所依据的 **RuntimePlan**（纯计划）。
   *
   * 返回它是为了让"计划"可被外部断言，而不是只有编排器自己知道：Gate V5-G0
   * 与后续协议都要检查「计划里的协议/传输/目标 == 实际下发到 Agent 的那一份」。
   * 计划本身不含 socket，只有事实。
   */
  runtimePlan?: ForwardRuntimePlan;
  steps: StepRecord[];
}

export type CreateRelayTunnelResult = CreateRelaySuccess | CreateRelayFailure;

/* ================================================================== */
/* 依赖注入                                                            */
/* ================================================================== */

/**
 * WP8 编排器需要的最小 DB 投影（`db` 满足之；测试用内存替身）。
 *
 * 为什么不直接 import `db`：`policy-concurrency.test.ts` 已经证明「内存替身 +
 * 注入」比 `mock.module` 稳（不随模块解析路径变化而静默失效）。WP3 的
 * portPool 也用同一模式（`PortPoolDeps`）。
 */
export interface SchedulerDb {
  tunnel: {
    create(args: unknown): Promise<Record<string, unknown>>;
    update(args: unknown): Promise<Record<string, unknown>>;
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
  };
  node: {
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
  nodeGroup: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
  egressPool: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  };
  egressTarget: {
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
  };
}

export interface SchedulerDeps {
  db?: SchedulerDb;
  /**
   * 控制面校验器（WP6 {@link ControlValidator}）。编排器每下发一条命令都
   * 经过它，因此 stale / duplicate / expired 三条硬规则在编排层同样生效。
   * 未传则**懒构造一个进程级实例**（跨请求共享 revision 闸门）。
   */
  validator?: ControlValidator;
  /** 依赖注入给 portPool 的替身（测试用；未传走 db/redis 单例）。 */
  portPoolDeps?: Parameters<typeof acquirePort>[1];
  /** 策略读取（默认 {@link getEffectivePolicy}）。 */
  loadPolicy?: (
    workspaceId: number,
  ) => Promise<Awaited<ReturnType<typeof getEffectivePolicy>>>;
  /** 节点组授权判定（默认 {@link canUseNodeGroup}）。 */
  authorizeGroup?: typeof canUseNodeGroup;
  /** Existing apply/retry/resume only; does not consume a creation count slot. */
  runtimeUse?: RuntimeUseChecker;
  /**
   * V5-WP1：读取节点已上报的 v2 协商事实（默认读 `node_state_report`）。
   * 注入点是**测试**用的，生产路径只有一处实现（services/runtime-admission.ts）。
   */
  loadCapabilityFacts?: CapabilityFactsLoader;
  /** 编排时钟（测试注入固定时间，避免 TTL 边界漂移）。 */
  now?: () => Date;
}

const defaultDeps: Required<
  Pick<SchedulerDeps, "db" | "loadPolicy" | "authorizeGroup" | "now">
> = {
  db: db as unknown as SchedulerDb,
  loadPolicy: (workspaceId: number) => getEffectivePolicy(workspaceId, { noCache: true }),
  authorizeGroup: canUseNodeGroup,
  now: () => new Date(),
};

function resolveDeps(over?: SchedulerDeps) {
  return {
    db: over?.db ?? defaultDeps.db,
    loadPolicy: over?.loadPolicy ?? defaultDeps.loadPolicy,
    authorizeGroup: over?.authorizeGroup ?? defaultDeps.authorizeGroup,
    runtimeUse: over?.runtimeUse ?? (async (workspaceId: number, resource: Parameters<RuntimeUseChecker>[1]) => {
      const { checkForwardRuntimeUse } = await import("./forward-capability.ts");
      return checkForwardRuntimeUse(workspaceId, resource);
    }),
    now: over?.now ?? defaultDeps.now,
    validator: over?.validator,
    portPoolDeps: over?.portPoolDeps,
    loadCapabilityFacts: over?.loadCapabilityFacts,
  };
}

/**
 * V5-WP1 runtime admission：**下发前**确认每一台参与节点都实现了
 * 「这个动作 + 这个协议 + 这个传输」。
 *
 * 为什么放在编排层而不是只依赖 Agent 侧的拒绝：
 *   · Agent 侧拒绝发生在命令**已经入队、端口租约已经产生**之后。RELAY 场景下
 *     出口可能已经 ACK，于是要跑一遍补偿才回到干净状态——一次本来可以在
 *     "零副作用"阶段拦下的失败，变成了三条写操作加一次撤隧道。
 *   · 「节点离线」和「节点不支持」必须能被区分。前者可以重试，后者重试一万
 *     次也没用，只能升级 Agent 或换节点。
 *
 * 判定规则本身**不在这里**（见 services/runtime-admission.ts）：本函数只负责
 * 取事实、把结构化原因翻译成 scheduler 的错误码空间、并落一条可排障的 detail。
 */
async function admitBoundRuntime(
  deps: ReturnType<typeof resolveDeps>,
  targets: readonly AdmissionTarget[],
  protocol: ForwardProtocol,
): Promise<RuntimeAdmissionDenied | null> {
  const admitted = await admitRuntimeFromStore(
    targets,
    { action: "apply_tunnel", protocol },
    deps.loadCapabilityFacts,
  );
  return admitted.ok ? null : admitted;
}

/**
 * V5-WP5-A1: the tls front's paths off a persisted row.
 *
 * Only returned for an admitted `tls` fact: handing paths to a tcp/ws tunnel
 * would put fields on the wire that the Agent must then decide to ignore, and
 * "the Agent ignores it" is not a contract.
 */
function tlsPathsFor(row: Record<string, unknown>, protocol: ForwardProtocol) {
  if (protocol !== "tls") return {};
  const cert = typeof row.tls_cert_path === "string" ? row.tls_cert_path.trim() : "";
  const key = typeof row.tls_key_path === "string" ? row.tls_key_path.trim() : "";
  if (cert === "" || key === "") {
    // A tls row without paths is a broken configuration, not a tcp tunnel: the
    // dispatch refuses (see Orchestrator.tlsFields) rather than downgrading.
    return { tlsCertPath: null, tlsKeyPath: null };
  }
  return { tlsCertPath: cert, tlsKeyPath: key };
}

/** admission 失败 → `Tunnel.apply_error` 上的结构化记录（不删业务行，§7.11）。 */
function admissionFailureText(denied: RuntimeAdmissionDenied): string {
  return admissionFailureDetail(denied);
}

/* ================================================================== */
/* 节点选择                                                            */
/* ================================================================== */

/** 编排器眼里的节点投影（§2.1：Node.role 是能力最终真相源）。 */
export interface SchedulableNode {
  id: number;
  node_id: string;
  role: "ingress" | "egress" | "both" | null;
  connect_ip: string | null;
  /** 端口分配区间；NULL 由 portPool 判 `node_range_unset`。 */
  port_range_min: number | null;
  port_range_max: number | null;
  lb_strategy: "round" | "rand" | null;
  /** 节点状态（`Node.status`：active / inactive）。 */
  status: "active" | "inactive";
  /** 最近心跳（`Node.last_seen_at`，WP7 之后由 session/state report 更新）。 */
  last_seen_at: Date | null;
  node_group_id: number;
  /**
   * WP7 per-node credential 状态（`Node.node_credential_hash` /
   * `credential_revoked`）。`node_credential_hash` 为 NULL = 该节点从未被
   * 签发凭据，即 §3.3 意义上「还没有可验证身份」；一旦有值就必须过
   * {@link decideNodeAuth} 的三条判定（含 revoked 优先）。
   */
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

/** 角色是否覆盖指定方向（`both` 同时覆盖入口与出口，§2.1）。 */
function roleCovers(role: SchedulableNode["role"], direction: "ingress" | "egress"): boolean {
  if (role === "both") return true;
  return role === direction;
}

/* ================================================================== */
/* 节点身份（WP7 node-credential，§3.3）                                */
/* ================================================================== */

/**
 * {@link SchedulableNode} 的凭据列投影（`Node.node_credential_hash` /
 * `Node.credential_revoked`，WP7 迁移 20260925120000 落地）。
 */
export interface NodeCredentialFields {
  node_credential_hash: string | null;
  credential_revoked: boolean;
}

/**
 * 一个节点当前是否**可被编排**（身份维度）。
 *
 * 直接复用 WP7 的 {@link decideNodeAuth} 而不是在这里重写判定：§3.3 的三条
 * 硬规则（没签过 → 拒、revoked → 拒、哈希不等 → 拒）必须只有一份实现，
 * 否则「撤销后还能下发」这类回归会从第二份实现里长出来。
 *
 * `presentedHash` 传什么：编排器拿不到也不该拿 Agent 的明文凭据（那是
 * Agent→面板方向的事，见 `routes/internal-node.ts`）。这里要回答的是
 * 「这台节点**有没有**一个有效的、控制面签发给它的身份」，所以用**节点行
 * 自己的哈希**去比对：命中 = 凭据在位且未被撤销；NULL = 从没签过。
 * revoked 优先级高于比对，与 WP7 的判定顺序一致。
 *
 * 刻意**不调** `authenticateNode`：那会连 Redis + DB，而编排器的 bind 阶段
 * 每建一条隧道就要跑两次，且单测必须离线。身份解析属于 IO 边界（WP7 的
 * HTTP 层），本模块只做「编排前的前置校验」这一态判定。
 */
export function nodeCredentialUsable(
  node: NodeCredentialFields | { node_credential_hash?: string | null; credential_revoked?: boolean },
): { ok: true } | { ok: false; reason: "invalid_credential" | "revoked" } {
  // 用节点自身哈希自证：decideNodeAuth 的语义是「这把钥匙能不能开这把锁」，
  // 编排视角则是「这把锁还在不在、有没有被吊销」。
  return decideNodeAuth(
    {
      node_credential_hash: node.node_credential_hash ?? null,
      credential_revoked: node.credential_revoked ?? false,
    },
    node.node_credential_hash ?? "",
  );
}

/** 节点是否算在线：`status=active` 且心跳未超时。离线仍可被选中但记 warning（见下）。 */
function isOnline(node: SchedulableNode, now: Date, timeoutMs: number): boolean {
  if (node.status !== "active") return false;
  if (node.last_seen_at === null) return false;
  return now.getTime() - node.last_seen_at.getTime() <= timeoutMs;
}

/**
 * 心跳超时窗口。与 legacy offline-detector 的既有口径保持一致（Redis 侧
 * 90s 防抖翻转 `node.status`），这里只做**兜底判定**：节点已被判 inactive
 * 时无需重复判断，仍在 active 但心跳过期时视为不可调度。
 */
const HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * 在候选组内挑一个可用的方向节点。
 *
 * 选择规则（刻意简单，且**不擅自迁移**——WP9 才有 Reconciler）：
 *   1. `role` 覆盖该方向（§2.1：`Node.role` 是最终真相源，`NodeGroup.node_type`
 *      只是 legacy 兼容，**不参与判定**）；
 *   2. **持有有效 per-node credential**（§3.3：编排器要向它下发真配置，
 *      身份不可验证的节点直接出局——这是 WP7 {@link decideNodeAuth} 的三条
 *      判定，`credential_revoked` 优先于哈希比对）；
 *   3. 优先在线节点（心跳新鲜）；
 *   4. 同组内多候选时取 `id` 最小（确定性，避免同一请求两次选到不同节点）。
 *
 * 全离线时仍返回候选（`online: false`）：节点可能只是心跳抖动，编排照常下发，
 * Agent ACK 超时才是真正的失败信号。真正要求「必须在线」的调用方（WP11 的
 * 立即生效语义）在 ACK 阶段自然失败，不会拿到一个假 active。
 *
 * 与（2）不同，凭据缺失**不**降级放行：心跳抖动是「可能还在跑」，凭据缺失
 * 是「根本无法证明它在跑」。`reason` 让调用方能区分「组里没节点」与「有节点
 * 但都没凭据」两种完全不同的排障路径。
 */
export function pickNode(
  candidates: readonly SchedulableNode[],
  direction: "ingress" | "egress",
  now: Date,
):
  | { ok: true; node: SchedulableNode; online: boolean }
  | { ok: false; reason: "no_role_match" | "no_credential" } {
  const usable = candidates.filter((n) => roleCovers(n.role, direction));
  if (usable.length === 0) return { ok: false, reason: "no_role_match" };
  // 身份闸门： revoked 与未签发都出局（WP7 decideNodeAuth，单一实现）。
  const credentialed = usable.filter((n) => nodeCredentialUsable(n).ok);
  if (credentialed.length === 0) return { ok: false, reason: "no_credential" };
  const sorted = [...credentialed].sort((a, b) => a.id - b.id);
  const online = sorted.find((n) => isOnline(n, now, HEARTBEAT_TIMEOUT_MS));
  if (online) return { ok: true, node: online, online: true };
  return { ok: true, node: sorted[0]!, online: false };
}

/* ================================================================== */
/* 端口预留：legacy DIRECT 交接（§5.2 / §7.6 硬要求）                   */
/* ================================================================== */

/**
 * 收集「同一物理节点上、DB 里没有租约行」的已占用端口。
 *
 * 这是 WP3 交接条款的落地：legacy `socket/port-allocator.ts` 分配的 DIRECT
 * `listen_port` **不写 `node_port_lease`**，那种撞号没有任何 DB 约束兜底，
 * 比 v3 内部撞号危险得多。因此 v3 分配前必须把这些端口灌进 `reservedPorts`。
 */
export function collectReservedPorts(tunnels: readonly { listen_port: number | null }[]): number[] {
  const out = new Set<number>();
  for (const t of tunnels) {
    if (typeof t.listen_port === "number" && Number.isInteger(t.listen_port) && t.listen_port > 0) {
      out.add(t.listen_port);
    }
  }
  return [...out];
}

/* ================================================================== */
/* 失败载体                                                            */
/* ================================================================== */

/** 编排期可预期失败（不抛到调用方面前，统一收进 Tunnel 的 error 字段）。 */
export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;
  readonly step?: SchedulerStep;
  constructor(code: SchedulerErrorCode, message: string, step?: SchedulerStep) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
    this.step = step;
  }
}

/* ================================================================== */
/* 端口分配（薄封装，把 AcquirePortOutcome 翻译成调度错误码）            */
/* ================================================================== */

export interface PortAllocationSuccess {
  ok: true;
  port: number;
  leaseId: number;
  /** 端口是否曾是 released 行被 revive（观测用）。 */
  reused: boolean;
}

export type PortAllocationFailure = {
  ok: false;
  code: SchedulerErrorCode;
  detail: string;
  /** user-specified 场景下的具体端口（便于回显）。 */
  port?: number;
};

/** WP3 失败码 → WP8 编排错误码（集中一处，避免散落的 if 链）。 */
function mapAcquireFailure(outcome: Extract<AcquirePortOutcome, { ok: false }>): PortAllocationFailure {
  const port = outcome.port;
  switch (outcome.code) {
    case "port_taken":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "端口已被占用", port };
    case "no_available_port":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "节点端口区间内无可用端口" };
    case "node_not_found":
      return { ok: false, code: SCHEDULER_ERROR_CODES.node_unavailable, detail: "节点不存在", port };
    case "node_range_unset":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "节点未配置端口区间（port_range_min/max）" };
    case "node_range_invalid":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: "节点端口区间不合法（min>max 或越界）" };
    case "port_out_of_range":
    case "port_blacklisted":
    case "port_outside_node_range":
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_invalid, detail: `端口 ${port ?? "?"} 不合法（${outcome.code}）`, port };
    default:
      return { ok: false, code: SCHEDULER_ERROR_CODES.port_allocation_failed, detail: `端口分配失败（${outcome.code}）`, port };
  }
}

/**
 * 申请一个端口租约。
 *
 * 纯粹的 portPool 适配层：**不 try/catch 之外的逻辑**。保留独立函数是为了
 * 测试可以单独钉死「user-specified 与 auto 走同一规则」这条 §7.6 要求
 * （cheap path：不需要整条编排流程）。
 */
export async function allocateTunnelPort(
  args: {
    nodeId: number;
    direction: "ingress" | "egress";
    preferred?: number | null;
    tunnelId?: number | null;
    reservedPorts?: readonly number[];
  },
  inject?: SchedulerDeps["portPoolDeps"],
): Promise<PortAllocationSuccess | PortAllocationFailure> {
  const outcome = await acquirePort(
    {
      nodeId: args.nodeId,
      leaseType: args.direction,
      preferredPort: args.preferred ?? null,
      tunnelId: args.tunnelId ?? null,
      reservedPorts: args.reservedPorts ?? [],
      deps: inject,
    },
    inject,
  );
  if (!outcome.ok) return mapAcquireFailure(outcome);
  return { ok: true, port: outcome.result.port, leaseId: outcome.result.leaseId, reused: outcome.result.reused };
}

/* ================================================================== */
/* 目标解析                                                            */
/* ================================================================== */

const HOST_PORT = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/;
const HOST_PORT_V4 = /^([^:\s]+):(\d{1,5})$/;

/**
 * 解析 `host:port`（IPv4 / 域名 / `[IPv6]` 三种形态）。
 *
 * 与 `routes/tunnels.ts` 的 `FORWARD_RE` 口径一致（DIRECT 与 RELAY 的用户
 * 输入不应有两套校验标准）。
 */
export function parseHostPort(value: string): { host: string; port: number } | null {
  const raw = value.trim();
  if (raw === "") return null;
  const v6 = HOST_PORT.exec(raw);
  if (v6) {
    const port = Number(v6[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: v6[1]!, port };
  }
  const m = HOST_PORT_V4.exec(raw);
  if (!m) return null;
  const host = m[1]!;
  if (host === "" || host.includes("[")) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/* ================================================================== */
/* 编排结果落库                                                        */
/* ================================================================== */

/**
 * 把 orchestrator 的 dispatch 失败码翻译成编排错误码。
 *
 * 为什么要翻译而不是直接复用：`agent_unreachable` / `agent_rejected` 只说明
 * 「这次下发没成」，不说明「发生在哪一端」。`apply_error_code` 是给前端和
 * 排障看的，必须能直接回答「该看入口还是出口」——同一个网络抖动，在入口
 * 失败意味着**用户已经连不上**，在出口失败则对外无感，处理优先级不同。
 */
export function mapDispatchCode(
  side: "ingress" | "egress",
  failure: DispatchFailure,
): SchedulerErrorCode {
  switch (failure.error_code) {
    case "agent_unreachable":
    case "ack_timeout":
    case "node_unaddressable":
      return side === "egress"
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.ingress_apply_rejected;
    case "revision_mismatch":
    case "ack_invalid":
      return side === "egress"
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.ingress_apply_rejected;
    case "ack_failed":
    case "agent_rejected":
    default:
      return side === "egress"
        ? SCHEDULER_ERROR_CODES.egress_apply_rejected
        : SCHEDULER_ERROR_CODES.ingress_apply_rejected;
  }
}

/** 构造写进 `apply_error` 的人读文案（`code` 已单独落列）。 */
function errorText(code: SchedulerErrorCode, detail: string): string {
  return `[${code}] ${detail}`;
}

/**
 * 把一次失败写进 Tunnel 行。
 *
 * **这是 §7.11「任何失败」四条要求的唯一落点**，因此它只做 update、绝不 delete：
 *   · `apply_status = "error"`；
 *   · `apply_error_code` / `apply_error` 结构化错误；
 *   · `desired_status` 回 `inactive`（控制面不认为这条隧道应该在跑）；
 *   · `last_applied_at` 不动（这段编排从未成功过）。
 */
async function persistFailure(
  store: SchedulerDb,
  tunnelId: number,
  args: { code: SchedulerErrorCode; detail: string; revision?: number | null },
): Promise<void> {
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      apply_status: APPLY_STATUS.error,
      apply_error_code: args.code,
      apply_error: errorText(args.code, args.detail).slice(0, 500),
      desired_status: DESIRED_STATUS.inactive,
      ...(args.revision != null ? { config_revision: args.revision } : {}),
    },
  });
}

/** 成功落库：两端 ACK 之后 `apply_status=active`、`last_applied_at=now`。 */
async function persistSuccess(
  store: SchedulerDb,
  tunnelId: number,
  args: { revision: number; at: Date },
): Promise<void> {
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      apply_status: APPLY_STATUS.active,
      desired_status: DESIRED_STATUS.active,
      applied_revision: args.revision,
      config_revision: args.revision,
      last_applied_at: args.at,
      apply_error_code: null,
      apply_error: null,
    },
  });
}

/* ================================================================== */
/* 主入口                                                              */
/* ================================================================== */

/**
 * 创建一条 RELAY 隧道并编排它到 `active`。
 *
 * 顺序**严格**遵循 §7.11 的十条；任何一步失败立即进入补偿路径，
 * 已执行的后续步骤不再执行（这也是为什么步骤记录对测试重要）。
 *
 * @param input  见 {@link CreateRelayTunnelInput}
 * @param orchestrator 下发通道（WP4 Agent API / WP7 node session）。
 *        默认构造一个基于 WP6 ControlValidator 的进程级 orchestrator。
 * @param deps   见 {@link SchedulerDeps}
 */
export async function createRelayTunnel(
  input: CreateRelayTunnelInput,
  orchestrator: Orchestrator,
  over?: SchedulerDeps,
): Promise<CreateRelayTunnelResult> {
  const deps = resolveDeps(over);
  const store = deps.db;
  const now = deps.now();
  const steps: StepRecord[] = [];

  const fail = (
    step: SchedulerStep,
    code: SchedulerErrorCode,
    detail: string,
    ctx: { tunnelId?: number; revision?: number | null; meta?: Record<string, unknown> },
  ): CreateRelayFailure => {
    steps.push({ step, ok: false, error_code: code, detail, meta: ctx.meta });
    if (ctx.tunnelId !== undefined) {
      // 保留 Tunnel（§7.11）：只写 error，不删行。写库失败不能吞——
      // 否则调会方拿到失败却看不到 DB 里的原因，Retry 时状态还是 pending。
      void persistFailure(store, ctx.tunnelId, { code, detail, revision: ctx.revision }).catch(() => {});
    }
    return {
      ok: false,
      tunnelId: ctx.tunnelId ?? -1,
      steps,
      failedStep: step,
      error_code: code,
      error: errorText(code, detail),
      retryable: isRetryable(code),
    };
  };

  /* ---------------- V5-WP0 protocol admission ---------------- */
  const protocol = normalizeForwardProtocol(input.tunnelType);
  if (protocol === null) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.unsupported_protocol,
      `协议 ${String(input.tunnelType)} 尚未通过当前 runtime Gate`,
      {},
    );
  }

  /* ---------------- ① auth / quota ---------------- */
  const policy = await deps.loadPolicy(input.workspaceId);
  const decision = checkTunnelCreation(policy, {
    // 编排在落库前先按当前计数判定；真正防超发的行锁由调用方（WP11 路由）
    // 在同事务里包住「判定 + 落库」。这里不重复实现 SOFT-01 的锁。
    tunnelCount: await countWorkspaceTunnels(input.workspaceId, store as never),
    trafficUsed: await sumWorkspaceTraffic(
      input.workspaceId,
      policy.limits.traffic_period,
      now,
      store as never,
    ),
    protocol,
    inGroupOwned: true, // 由下方授权判定取代：组授权未过根本走不到这里
    inGroupId: input.inNodeGroupId,
    outGroupId: input.outNodeGroupId,
    outGroupOwned: true,
  });
  if (!decision.allowed) {
    const code: SchedulerErrorCode =
      decision.reason === "tunnel_limit"
        ? SCHEDULER_ERROR_CODES.tunnel_limit
        : decision.reason === "traffic_exhausted"
          ? SCHEDULER_ERROR_CODES.traffic_exhausted
          : SCHEDULER_ERROR_CODES.policy_denied;
    return fail("auth_quota", code, decision.message ?? "策略拒绝", {});
  }
  steps.push({ step: "auth_quota", ok: true, meta: { reason: decision.reason ?? "allowed" } });

  /* 节点组授权：入口必授，出口必须显式指定且授权（RELAY 不能只用入口组）。 */
  const inGroup = await store.nodeGroup.findUnique({ where: { id: input.inNodeGroupId } });
  if (!inGroup) {
    return fail("auth_quota", SCHEDULER_ERROR_CODES.node_group_not_allowed, `入口节点组 ${input.inNodeGroupId} 不存在`, {});
  }
  const inGroupAllowed = await deps.authorizeGroup(
    input.userId,
    inGroup as never,
    "in",
    input.workspaceId,
    input.personalWorkspaceId,
  );
  if (!inGroupAllowed) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.node_group_not_allowed,
      `无权使用入口节点组 ${input.inNodeGroupId}`,
      {},
    );
  }
  if (input.outNodeGroupId === null) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      "RELAY 模式必须指定出口节点组",
      {},
    );
  }
  const outGroup = await store.nodeGroup.findUnique({ where: { id: input.outNodeGroupId } });
  if (!outGroup) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.node_group_not_allowed,
      `出口节点组 ${input.outNodeGroupId} 不存在`,
      {},
    );
  }
  const outGroupAllowed = await deps.authorizeGroup(
    input.userId,
    outGroup as never,
    "out",
    input.workspaceId,
    input.personalWorkspaceId,
  );
  if (!outGroupAllowed) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.node_group_not_allowed,
      `无权使用出口节点组 ${input.outNodeGroupId}`,
      {},
    );
  }

  /* ---------------- ② desired Tunnel = pending ---------------- */
  const created = await store.tunnel.create({
    data: {
      name: input.name,
      tunnel_type: protocol,
      // The compatibility create service admits product protocols before this
      // point. Keep legacy-only values uncanonicalized rather than relabeling them.
      forward_protocol: protocol,
      category: "port_forward",
      listen_ip: input.listenIp ?? null,
      listen_port: input.listenPort ?? null,
      listen_protocol: [protocol],
      status: "active",
      forward_addresses: [],
      load_balance_type: "round",
      ip_type: "ipv4",
      in_node_group_id: input.inNodeGroupId,
      out_node_group_id: input.outNodeGroupId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      tunnel_mode: "relay",
      desired_status: DESIRED_STATUS.inactive,
      apply_status: APPLY_STATUS.pending,
      config_revision: 0,
      applied_revision: null,
    },
  });
  const tunnelId = Number(created.id);
  steps.push({ step: "create_pending", ok: true, meta: { tunnel_id: tunnelId } });

  /* 从这里开始 Tunnel 行已存在：所有失败都要 persistFailure + 补偿。 */

  /* ---------------- ③ bind ingress / egress Node ---------------- */
  const [inCandidates, outCandidates] = await Promise.all([
    store.node.findMany({
      where: { node_group_id: input.inNodeGroupId },
      orderBy: { id: "asc" },
    }),
    store.node.findMany({
      where: { node_group_id: input.outNodeGroupId },
      orderBy: { id: "asc" },
    }),
  ]);

  const ingressPick = pickNode(inCandidates as unknown as SchedulableNode[], "ingress", now);
  if (!ingressPick.ok) {
    return fail(
      "bind_nodes",
      ingressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      ingressPick.reason === "no_credential"
        ? `入口节点组 ${input.inNodeGroupId} 内没有持有有效 per-node credential 的 ingress 节点（§3.3：身份不可验证的节点不可编排，请到 WP10 端点补签/轮换）`
        : `入口节点组 ${input.inNodeGroupId} 内没有 role 覆盖 ingress 的节点`,
      { tunnelId },
    );
  }
  const egressPick = pickNode(outCandidates as unknown as SchedulableNode[], "egress", now);
  if (!egressPick.ok) {
    return fail(
      "bind_nodes",
      egressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      egressPick.reason === "no_credential"
        ? `出口节点组 ${input.outNodeGroupId} 内没有持有有效 per-node credential 的 egress 节点（§3.3：身份不可验证的节点不可编排，请到 WP10 端点补签/轮换）`
        : `出口节点组 ${input.outNodeGroupId} 内没有 role 覆盖 egress 的节点`,
      { tunnelId },
    );
  }
  if (ingressPick.node.id === egressPick.node.id) {
    // 同一物理节点不能同时当事例的两端：出口端口与入口端口会落在同一
    // (node_id, port) 唯一键上（§5.1），RELAY 的双跳也就退化成单跳。
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `入口与出口绑定到同一节点 ${ingressPick.node.id}（RELAY 必须跨节点）`,
      { tunnelId },
    );
  }

  /* 出口池：显式指定 → 必须存在且属于该出口节点；未指定 → 取 default。 */
  let poolId: number | null = input.egressPoolId ?? null;
  let pool: Record<string, unknown> | null = null;
  if (poolId !== null) {
    pool = await store.egressPool.findUnique({ where: { id: poolId } });
    if (!pool || Number(pool.node_id) !== egressPick.node.id) {
      return fail(
        "bind_nodes",
        SCHEDULER_ERROR_CODES.node_unavailable,
        `出口池 ${poolId} 不存在或不属于出口节点 ${egressPick.node.id}`,
        { tunnelId },
      );
    }
  } else {
    pool = await store.egressPool.findFirst({
      where: { node_id: egressPick.node.id, name: "default" },
    });
    if (pool) poolId = Number(pool.id);
  }

  if (!ingressPick.online || !egressPick.online) {
    // 只记 warning 不中断：心跳抖动不应阻断创建，ACK 超时才是硬失败。
    steps.push({
      step: "bind_nodes",
      ok: true,
      detail: "入口或出口节点心跳超时，仍按候选绑定",
      meta: {
        ingress_online: ingressPick.online,
        egress_online: egressPick.online,
      },
    });
  } else {
    steps.push({ step: "bind_nodes", ok: true });
  }

  /* ---------------- V5-WP1 runtime admission（下发前，零副作用） ---------------- */
  //
  // 位置是有意的：在端口租约产生**之前**、在 placements 落库**之前**。到这里
  // 两端节点已经确定，因此可以一次判完 ingress + egress；任何一端不满足就直接
  // 失败，不产生租约、不产生 runtime、不需要补偿。
  const admissionDenied = await admitBoundRuntime(
    deps,
    [
      { nodeId: ingressPick.node.id, role: "ingress" },
      { nodeId: egressPick.node.id, role: "egress" },
    ],
    protocol,
  );
  if (admissionDenied) {
    return fail("bind_nodes", SCHEDULER_ERROR_CODES.runtime_capability_denied, admissionFailureText(admissionDenied), {
      tunnelId,
      meta: {
        runtime_admission: {
          node_id: admissionDenied.node_id,
          node_role: admissionDenied.node_role,
          layer: admissionDenied.layer,
          reason: admissionDenied.reason,
        },
      },
    });
  }

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: ingressPick.node.id,
      egress_node_id: egressPick.node.id,
      egress_pool_id: poolId,
      apply_status: APPLY_STATUS.applying,
    },
  });

  /* ---------------- ④ acquire ports ---------------- */
  // WP3 交接：同节点存量 DIRECT 的 listen_port 必须灌进 reservedPorts。
  // 只按 in/out 组取本组隧道的 listen_port 是**近似**防护：真正的 per-node
  // DIRECT 端口应按 bind 出来的 node_id 查。这里取组级是因为 legacy
  // port-allocator 就在组内分配（§7.6「LEGACY 交接」：两组作用域不同），
  // 而 Node 上的 v3 租约已由 acquirePort 的 DB 查询覆盖，不需要重复灌。
  const [inReserved, outReserved] = await Promise.all([
    store.tunnel.findMany({
      where: { in_node_group_id: input.inNodeGroupId },
      select: { id: true, listen_port: true },
    }),
    store.tunnel.findMany({
      where: { out_node_group_id: input.outNodeGroupId },
      select: { id: true, listen_port: true },
    }),
  ]);
  const ingressReserved = collectReservedPorts(
    (inReserved as { id: number; listen_port: number | null }[]).filter((t) => t.id !== tunnelId),
  );
  const egressReserved = collectReservedPorts(
    (outReserved as { id: number; listen_port: number | null }[]).filter((t) => t.id !== tunnelId),
  );

  const ingressAlloc = await allocateTunnelPort(
    {
      nodeId: ingressPick.node.id,
      direction: "ingress",
      preferred: input.listenPort ?? null,
      tunnelId,
      reservedPorts: ingressReserved,
    },
    deps.portPoolDeps,
  );
  if (!ingressAlloc.ok) {
    return fail("acquire_ports", ingressAlloc.code, ingressAlloc.detail, {
      tunnelId,
      meta: { direction: "ingress", port: ingressAlloc.port ?? null },
    });
  }

  const egressAlloc = await allocateTunnelPort(
    {
      nodeId: egressPick.node.id,
      direction: "egress",
      preferred: null, // 出口端口是节点间内部端口，永不接受用户指定
      tunnelId,
      reservedPorts: egressReserved,
    },
    deps.portPoolDeps,
  );
  if (!egressAlloc.ok) {
    // 补偿：入口租约已产生，先释放再报错。
    await releaseLease({ leaseId: ingressAlloc.leaseId }, deps.portPoolDeps).catch(() => {});
    return fail("acquire_ports", egressAlloc.code, `出口端口分配失败：${egressAlloc.detail}`, {
      tunnelId,
      meta: { direction: "egress", ingress_port: ingressAlloc.port },
    });
  }

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      listen_port: ingressAlloc.port,
      egress_port: egressAlloc.port,
    },
  });
  steps.push({
    step: "acquire_ports",
    ok: true,
    meta: {
      ingress_port: ingressAlloc.port,
      ingress_lease_id: ingressAlloc.leaseId,
      egress_port: egressAlloc.port,
      egress_lease_id: egressAlloc.leaseId,
    },
  });

  /* ---------------- ⑤ revision++ ---------------- */
  // 从库里读当前 revision 再 +1：createRelayTunnel 可能被重入
  // （WP9 的重试 / WP11 的 re-apply），那时 revision 必须继续前进，
  // 否则 Agent 侧会把命令当 stale 拒掉（§3.2 硬规则 1）。
  const current = await store.tunnel.findUnique({
    where: { id: tunnelId },
    select: { config_revision: true },
  });
  const revision = (Number(current?.config_revision ?? 0) || 0) + 1;
  await store.tunnel.update({
    where: { id: tunnelId },
    data: { config_revision: revision, apply_status: APPLY_STATUS.applying },
  });
  steps.push({ step: "bump_revision", ok: true, meta: { revision } });

  /* ---------------- ⑥⑦ apply Egress → ACK ---------------- */
  const egressTargets =
    poolId !== null
      ? await store.egressTarget.findMany({
          where: { pool_id: poolId, status: "active" },
          orderBy: { order_by: "asc" },
        })
      : [];

  // 出口池里没有 active 目标 → 不能下发。WP6 的 validatePayload 会把
  // `targets: []` 当坏 payload 抛 TypeError；那是编码器错误，但在这里它的
  // 直接诱因是**数据问题**（池被停用/目标全下线）。编排器的契约是
  // 「只返回结构化的 CreateRelayFailure」，所以数据问题要在这里先拦下并
  // 落成 apply_egress 失败 —— 否则调用方收到的是一个 TypeError 而不是
  // Tunnel 记录上的 apply_status=error，排障时对不上号。
  if (poolId !== null && egressTargets.length === 0) {
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail(
      "apply_egress",
      SCHEDULER_ERROR_CODES.egress_apply_rejected,
      `出口池 ${poolId} 下没有 active 目标（EgressTarget 全部下线或未配置）`,
      { tunnelId, revision },
    );
  }

  const egressDispatch = await orchestrator.dispatchEgress({
    tunnelId,
    revision,
    egressNode: egressPick.node,
    egressPort: egressAlloc.port,
    poolId,
    targets: egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    protocol,
  });
  if (!egressDispatch.ok) {
    // 补偿：出口侧没成功，两侧都没有 listener 活着，但**两个端口租约已产生**。
    // 必须先释放——否则这条隧道的端口被一条永远不会 active 的记录占着，
    // reconcile（WP9）要等 15 分钟预分配 TTL 才收得回。
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail("apply_egress", mapDispatchCode("egress", egressDispatch), egressDispatch.error, {
      tunnelId,
      revision,
      meta: { command_id: egressDispatch.commandId ?? null },
    });
  }
  steps.push({
    step: "apply_egress",
    ok: true,
    meta: { command_id: egressDispatch.result.commandId, revision },
  });
  steps.push({
    step: "egress_ack",
    ok: true,
    meta: { applied_revision: egressDispatch.result.revision },
  });

  /* ---------------- V5-WP2 RuntimePlan（事实齐了之后的自检） ---------------- */
  //
  // 位置就是重点：RELAY 的 next_hop 只有出口 ACK 之后才存在（§1.3 铁律一），
  // 所以计划只能在这里成型。在此之前用 `protocol` 原值下发，从这里开始一律走
  // 计划——协议、传输、placement、listener、upstream 全部来自同一份纯计划，
  // 不再由各调用点各自拼一遍。
  //
  // 自检失败 = 我们即将下发一份自相矛盾的配置（例如 RELAY 却没有 next_hop）。
  // 那时出口已经 ACK，所以必须先补偿再失败，绝不让入口带着坏 hop 启动。
  const plan = buildForwardRuntimePlan("relay", protocol, {
    revision,
    placement: {
      ingress_node_id: ingressPick.node.id,
      egress_node_id: egressPick.node.id,
      egress_pool_id: poolId,
    },
    listener: { host: input.listenIp ?? null, port: ingressAlloc.port },
    upstream: {
      targets: (egressTargets as { host: string; port: number }[]).map((t) => ({
        host: t.host,
        port: t.port,
      })),
      next_hop: `${egressDispatch.egress_host}:${egressAlloc.port}`,
    },
  });
  const planViolations = forwardRuntimePlanViolations(plan);
  if (planViolations.length > 0) {
    await orchestrator
      .removeTunnel({ tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "runtime plan invalid" })
      .catch(() => {});
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail(
      "apply_ingress",
      SCHEDULER_ERROR_CODES.invariant_violated,
      `RuntimePlan 自检未通过：${planViolations.join("; ")}`,
      { tunnelId, revision, meta: { runtime_plan_violations: planViolations } },
    );
  }

  /* ---------------- ⑧⑨ apply Ingress → ACK ---------------- */
  const ingressDispatch = await orchestrator.dispatchIngress({
    tunnelId,
    revision,
    ingressNode: ingressPick.node,
    ingressPort: ingressAlloc.port,
    nextHop: plan.upstream.next_hop as string,
    protocol: plan.protocol.name,
    ...tlsPathsFor(asRow<Record<string, unknown>>(created) as Record<string, unknown>, plan.protocol.name),
  });
  if (!ingressDispatch.ok) {
    /* 补偿：Egress 已经 ACK，必须先撤掉（否则它继续占着出口端口收流量）。 */
    await orchestrator
      .removeTunnel({ tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "ingress apply failed" })
      .catch(() => {});
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail("apply_ingress", mapDispatchCode("ingress", ingressDispatch), ingressDispatch.error, {
      tunnelId,
      revision,
      meta: { command_id: ingressDispatch.commandId ?? null },
    });
  }
  steps.push({
    step: "apply_ingress",
    ok: true,
    meta: { command_id: ingressDispatch.result.commandId, revision },
  });
  steps.push({
    step: "ingress_ack",
    ok: true,
    meta: { applied_revision: ingressDispatch.result.revision },
  });

  /* ---------------- ⑩ active ---------------- */
  await persistSuccess(store, tunnelId, { revision, at: deps.now() });
  steps.push({ step: "activate", ok: true, meta: { revision } });

  return {
    ok: true,
    tunnelId,
    revision,
    ingressNodeId: ingressPick.node.id,
    egressNodeId: egressPick.node.id,
    ingressPort: ingressAlloc.port,
    egressPort: egressAlloc.port,
    runtimePlan: plan,
    steps,
  };
}

/* ================================================================== */
/* 重入：对已存在的 RELAY 隧道重新编排（WP11 retry / resume 用）        */
/* ================================================================== */

/**
 * 对一条**已存在**的 RELAY 隧道重新走一遍 §7.11 的 ③–⑩ 步。
 *
 * 为什么不是 `createRelayTunnel`：那条入口的 ② 是 `tunnel.create`——
 * 对已有行调用会产生第二条记录，而 retry 的语义（§4.1「失败时保留
 * Tunnel 并允许 Retry」）明确要求**同一条行**重新编排。因此这里从
 * 「行已在」开始：bind → ports → revision++ → 下发 → active。
 *
 * 为什么不在 WP11 自己写下发：§7.13「所有运行操作统一走 orchestrator，
 * 禁止 route 自己写第二套下发逻辑」。retry 与创建走的是同两个
 * `dispatchEgress` / `dispatchIngress` 调用（本函数内的代码与
 * `createRelayTunnel` 的 ⑥–⑨ 逐行同源），铁律一（先出口后入口）
 * 依然只有一处实现。
 *
 * revision 语义：从库里当前 `config_revision` +1。**不能复用旧值**——
 * Agent 的闸门是「applied_revision ≥ incoming 即拒 stale」，上一次失败
 * 已经推进过 applied_revision 的话，同 revision 重发会被直接拒掉，
 * retry 就静默失效了（这与 {@link Orchestrator.removeTunnel} 用
 * revision+1 是同一条理由）。
 *
 * 端口语义：`listen_port` / `egress_port` 已有值则**原样复用**（重试不
 * 换端口：§7.12 把 `change_port` 列为默认禁止的自动动作，用户手动
 * retry 更不该偷偷换端口）；为空才分配。
 *
 * @param tunnelId 已存在的 RELAY 隧道 id。
 * @param orchestrator 下发通道（与创建共用同一个实例：revision 闸门
 *        是进程级的，重建实例会让两端看到不同的账本）。
 * @param over 见 {@link SchedulerDeps}。
 */
/* `admittedPersistedProtocol` moved to forward-contract.ts (WP4/G0): every
   dispatch path needs the same answer, and two copies is how one path admits a
   fact another refuses. */
const admittedPersistedProtocol = admitPersistedProtocol;

async function checkExistingRuntime(
  row: Record<string, unknown>,
  deps: ReturnType<typeof resolveDeps>,
  selected?: { ingress: SchedulableNode; egress?: SchedulableNode },
): Promise<RuntimeUseDenied | null> {
  // Concrete placements outrank the historical candidate-group columns. If a
  // Node has moved groups, retry must re-check its *new* scope before any write.
  const [ingress, egress] = selected
    ? [selected.ingress, selected.egress ?? null]
    : await Promise.all([
        row.ingress_node_id == null ? null : deps.db.node.findUnique({ where: { id: Number(row.ingress_node_id) } }),
        row.tunnel_mode !== "relay" || row.egress_node_id == null
          ? null : deps.db.node.findUnique({ where: { id: Number(row.egress_node_id) } }),
      ]);
  const validId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  const inGroup = ingress?.node_group_id ?? (row.ingress_node_id == null ? row.in_node_group_id : null);
  const outGroup = row.tunnel_mode === "relay"
    ? egress?.node_group_id ?? (row.egress_node_id == null ? row.out_node_group_id : null)
    : null;
  if (!validId(row.workspace_id) || !validId(row.user_id) || !validId(inGroup) ||
      (row.tunnel_mode === "relay" && !validId(outGroup))) {
    return { code: "forbidden", reason: "scope_revoked", error_layer: "resource_scope", message: "转发归属或实际节点组已失效" };
  }
  const protocol = admittedPersistedProtocol(row);
  if (protocol === null) {
    return {
      code: "policy_denied",
      reason: "protocol_not_supported",
      error_layer: "capability",
      message: "该转发使用的历史协议尚未进入 V5 runtime 白名单",
    };
  }
  return deps.runtimeUse(row.workspace_id, {
    user_id: row.user_id, in_node_group_id: inGroup,
    out_node_group_id: outGroup as number | null,
    protocol,
  });
}

async function recordRuntimeBlock(store: SchedulerDb, tunnelId: number, denied: RuntimeUseDenied) {
  const code = denied.code === "forbidden" ? SCHEDULER_ERROR_CODES.scope_revoked
    : denied.reason === "traffic_exhausted" ? SCHEDULER_ERROR_CODES.traffic_exhausted
      : SCHEDULER_ERROR_CODES.policy_denied;
  const detail = `[${denied.reason}:${denied.error_layer}] ${denied.message}`;
  // No desired/applied/revision mutation or release: blocking is not suspend.
  await store.tunnel.update({ where: { id: tunnelId }, data: {
    apply_status: APPLY_STATUS.error, apply_error_code: code, apply_error: detail.slice(0, 2000),
  } });
  return { code, detail };
}

export async function reapplyRelayTunnel(
  tunnelId: number,
  orchestrator: Orchestrator,
  over?: SchedulerDeps,
): Promise<CreateRelayTunnelResult> {
  const deps = resolveDeps(over);
  const store = deps.db;
  const now = deps.now();
  const steps: StepRecord[] = [];

  const fail = (
    step: SchedulerStep,
    code: SchedulerErrorCode,
    detail: string,
    ctx: { revision?: number | null; meta?: Record<string, unknown> } = {},
  ): CreateRelayFailure => {
    steps.push({ step, ok: false, error_code: code, detail, meta: ctx.meta });
    void persistFailure(store, tunnelId, { code, detail, revision: ctx.revision }).catch(() => {});
    return {
      ok: false,
      tunnelId,
      steps,
      failedStep: step,
      error_code: code,
      error: errorText(code, detail),
      retryable: isRetryable(code),
    };
  };

  const row = asRow<Record<string, unknown>>(
    await store.tunnel.findUnique({ where: { id: tunnelId } }),
  );
  if (!row) {
    return fail(
      "create_pending",
      SCHEDULER_ERROR_CODES.invariant_violated,
      `隧道 ${tunnelId} 不存在（重推前必须已落库）`,
    );
  }
  if (row.tunnel_mode !== "relay") {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `隧道 ${tunnelId} 不是 RELAY 模式（${String(row.tunnel_mode)}）`,
    );
  }
  if (admittedPersistedProtocol(row) === null) {
    return fail(
      "auth_quota",
      SCHEDULER_ERROR_CODES.unsupported_protocol,
      `隧道 ${tunnelId} 的协议未通过当前 runtime Gate`,
    );
  }
  const inNodeGroupId = Number(row.in_node_group_id);
  const outNodeGroupId = row.out_node_group_id === null ? null : Number(row.out_node_group_id);
  if (outNodeGroupId === null) {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `RELAY 隧道 ${tunnelId} 没有出口节点组，无法重推`,
    );
  }

  const blockRuntimeUse = async (denied: RuntimeUseDenied): Promise<CreateRelayFailure> => {
    const { code, detail } = await recordRuntimeBlock(store, tunnelId, denied);
    steps.push({ step: "auth_quota", ok: false, error_code: code, detail });
    return { ok: false, tunnelId, steps, failedStep: "auth_quota", error_code: code, error: detail, retryable: false };
  };
  const denied = await checkExistingRuntime(row, deps);
  if (denied) return blockRuntimeUse(denied);
  steps.push({ step: "auth_quota", ok: true });
  steps.push({ step: "create_pending", ok: true, meta: { tunnel_id: tunnelId, reapply: true } });

  // Resolved once, used for admission, dispatch and the canonical fact written
  // back below: three places that must agree on which protocol this is.
  const reapplyProtocol = admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL;

  /* ---------------- ③ bind nodes ---------------- */
  const [inCandidatesRaw, outCandidatesRaw] = await Promise.all([
    store.node.findMany({ where: { node_group_id: inNodeGroupId }, orderBy: { id: "asc" } }),
    store.node.findMany({ where: { node_group_id: outNodeGroupId }, orderBy: { id: "asc" } }),
  ]);
  // Initial apply may schedule from the group. Once concrete placement exists,
  // retry/resume must stay on those exact Nodes: no silent migration on a
  // transient failure. Explicit topology changes are a separate user action.
  const boundIngressId = row.ingress_node_id == null ? null : Number(row.ingress_node_id);
  const boundEgressId = row.egress_node_id == null ? null : Number(row.egress_node_id);
  const inCandidates = (inCandidatesRaw as unknown as SchedulableNode[]).filter(
    (node) => boundIngressId === null || node.id === boundIngressId,
  );
  const outCandidates = (outCandidatesRaw as unknown as SchedulableNode[]).filter(
    (node) => boundEgressId === null || node.id === boundEgressId,
  );
  const ingressPick = pickNode(inCandidates, "ingress", now);
  if (!ingressPick.ok) {
    return fail(
      "bind_nodes",
      ingressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      ingressPick.reason === "no_credential"
        ? `入口节点组 ${inNodeGroupId} 内没有持有有效 per-node credential 的 ingress 节点`
        : `入口节点组 ${inNodeGroupId} 内没有 role 覆盖 ingress 的节点`,
    );
  }
  const egressPick = pickNode(outCandidates as unknown as SchedulableNode[], "egress", now);
  if (!egressPick.ok) {
    return fail(
      "bind_nodes",
      egressPick.reason === "no_credential"
        ? SCHEDULER_ERROR_CODES.node_credential_missing
        : SCHEDULER_ERROR_CODES.node_unavailable,
      egressPick.reason === "no_credential"
        ? `出口节点组 ${outNodeGroupId} 内没有持有有效 per-node credential 的 egress 节点`
        : `出口节点组 ${outNodeGroupId} 内没有 role 覆盖 egress 的节点`,
    );
  }
  if (ingressPick.node.id === egressPick.node.id) {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      `入口与出口绑定到同一节点 ${ingressPick.node.id}（RELAY 必须跨节点）`,
    );
  }

  // 出口池：沿用行上的值；为空则取该出口节点的 default 池（§2.2）。
  let poolId = row.egress_pool_id === null ? null : Number(row.egress_pool_id);
  if (poolId !== null) {
    const pool = await store.egressPool.findUnique({ where: { id: poolId } });
    if (!pool || Number((pool as { node_id: number }).node_id) !== egressPick.node.id) {
      return fail(
        "bind_nodes",
        SCHEDULER_ERROR_CODES.node_unavailable,
        `出口池 ${poolId} 不存在或不属于出口节点 ${egressPick.node.id}`,
      );
    }
  } else {
    const pool = await store.egressPool.findFirst({
      where: { node_id: egressPick.node.id, name: "default" },
    });
    if (pool) poolId = Number((pool as { id: number }).id);
  }
  if (!ingressPick.online || !egressPick.online) {
    steps.push({
      step: "bind_nodes",
      ok: true,
      detail: "入口或出口节点心跳超时，仍按候选绑定",
      meta: { ingress_online: ingressPick.online, egress_online: egressPick.online },
    });
  } else {
    steps.push({ step: "bind_nodes", ok: true });
  }
  /* V5-WP1：重推走的是同一条 admission——重推不换节点，所以节点换过镜像
     （升级 / 回退）之后必须重新判一次，而不是沿用上一次的结论。 */
  const reapplyAdmissionDenied = await admitBoundRuntime(
    deps,
    [
      { nodeId: ingressPick.node.id, role: "ingress" },
      { nodeId: egressPick.node.id, role: "egress" },
    ],
    admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL,
  );
  if (reapplyAdmissionDenied) {
    return fail(
      "bind_nodes",
      SCHEDULER_ERROR_CODES.runtime_capability_denied,
      admissionFailureText(reapplyAdmissionDenied),
      {
      meta: {
        runtime_admission: {
          node_id: reapplyAdmissionDenied.node_id,
          node_role: reapplyAdmissionDenied.node_role,
          layer: reapplyAdmissionDenied.layer,
          reason: reapplyAdmissionDenied.reason,
        },
      },
    });
  }
  const targetDenied = await checkExistingRuntime(row, deps, { ingress: ingressPick.node, egress: egressPick.node });
  if (targetDenied) return blockRuntimeUse(targetDenied);
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: ingressPick.node.id, egress_node_id: egressPick.node.id, egress_pool_id: poolId,
      apply_status: APPLY_STATUS.applying, desired_status: DESIRED_STATUS.inactive,
      // V5-WP1/G0: a Forward created before the protocol column existed carries
      // its fact only in `tunnel_type`. Re-orchestrating it is the moment the
      // canonical fact can be materialised, and leaving it NULL means every
      // later reader keeps falling back to the legacy column forever. The value
      // is the admitted protocol (admission already ran above), never a default.
      forward_protocol: reapplyProtocol,
    },
  });

  /* ---------------- ④ ports（已有值复用，空才分配）---------------- */
  const ingressReserved = collectReservedPorts(
    (
      await store.tunnel.findMany({
        where: { in_node_group_id: inNodeGroupId },
        select: { id: true, listen_port: true },
      })
    )
      .map((t) => t as { id: number; listen_port: number | null })
      .filter((t) => t.id !== tunnelId),
  );
  const egressReserved = collectReservedPorts(
    (
      await store.tunnel.findMany({
        where: { out_node_group_id: outNodeGroupId },
        select: { id: true, listen_port: true },
      })
    )
      .map((t) => t as { id: number; listen_port: number | null })
      .filter((t) => t.id !== tunnelId),
  );

  // Even when the Tunnel row already contains a port, the durable
  // NodePortLease may not exist yet (notably the create -> reapply path where
  // the user-specified ingress port is persisted before orchestration). Always
  // acquire with the existing port as `preferred`: acquirePort is idempotent
  // for an already-held same tunnel/direction lease and creates the missing
  // canonical ownership row otherwise.
  const existingIngressPort = row.listen_port === null ? null : Number(row.listen_port);
  const ingressAlloc = await allocateTunnelPort(
    {
      nodeId: ingressPick.node.id,
      direction: "ingress",
      preferred: existingIngressPort,
      tunnelId,
      reservedPorts: ingressReserved,
    },
    deps.portPoolDeps,
  );
  if (!ingressAlloc.ok) {
    return fail("acquire_ports", ingressAlloc.code, ingressAlloc.detail, {
      meta: { direction: "ingress", port: existingIngressPort },
    });
  }

  const existingEgressPort = row.egress_port === null ? null : Number(row.egress_port);
  const egressAlloc = await allocateTunnelPort(
    {
      nodeId: egressPick.node.id,
      direction: "egress",
      preferred: existingEgressPort,
      tunnelId,
      reservedPorts: egressReserved,
    },
    deps.portPoolDeps,
  );
  if (!egressAlloc.ok) {
    if (!ingressAlloc.reused) {
      await releaseLease({ leaseId: ingressAlloc.leaseId }, deps.portPoolDeps).catch(() => {});
    }
    return fail("acquire_ports", egressAlloc.code, `出口端口分配失败：${egressAlloc.detail}`, {
      meta: { direction: "egress", ingress_port: ingressAlloc.port },
    });
  }

  const ingressPort = ingressAlloc.port;
  const egressPort = egressAlloc.port;

  // ── V5.4：三跳路由的中间跳端口（唯一新增的分配）──
  //
  // 创建路径此前完全不认识 `middle_node_id`：它只发入口与出口两腿，中间跳没有任何 runtime，
  // 于是流量**绕过中间跳**走单跳路径 —— 客户端照样通，所以只看"通不通"永远发现不了
  // （实测：中间节点上报里 has_any=0 而客户端有数据）。创建路径是"知道中间跳"的第二条路。
  const middleNodeId = (row as { middle_node_id?: number | null }).middle_node_id ?? null;
  let middlePort: number | null = null;
  if (middleNodeId != null) {
    const middleAlloc = await allocateTunnelPort(
      { nodeId: middleNodeId, direction: "egress", preferred: null, tunnelId, reservedPorts: [] },
      deps.portPoolDeps,
    );
    if (!middleAlloc.ok) {
      await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
      return fail("acquire_ports", middleAlloc.code, `中间跳端口分配失败：${middleAlloc.detail}`, {
        meta: { direction: "transit", middle_node_id: middleNodeId },
      });
    }
    middlePort = middleAlloc.port;
  }

  await store.tunnel.update({ where: { id: tunnelId }, data: { listen_port: ingressPort, egress_port: egressPort } });
  steps.push({
    step: "acquire_ports",
    ok: true,
    meta: {
      ingress_port: ingressPort,
      ingress_lease_id: ingressAlloc.leaseId,
      ingress_reused: ingressAlloc.reused,
      egress_port: egressPort,
      egress_lease_id: egressAlloc.leaseId,
      egress_reused: egressAlloc.reused,
    },
  });

  /* ---------------- ⑤ revision++ ---------------- */
  // 从库里读当前 revision 再 +1：上一次失败可能已推进 applied_revision，
  // 复用同值会被 Agent 的 stale 闸门拒掉，retry 就静默失效。
  const current = await store.tunnel.findUnique({ where: { id: tunnelId }, select: { config_revision: true } });
  const revision = (Number(current?.config_revision ?? 0) || 0) + 1;
  await store.tunnel.update({
    where: { id: tunnelId },
    data: { config_revision: revision, apply_status: APPLY_STATUS.applying },
  });
  steps.push({ step: "bump_revision", ok: true, meta: { revision } });

  /* ---------------- ⑥⑦ apply Egress → ACK ---------------- */
  const egressTargets =
    poolId !== null
      ? await store.egressTarget.findMany({ where: { pool_id: poolId, status: "active" }, orderBy: { order_by: "asc" } })
      : [];
  if (poolId !== null && egressTargets.length === 0) {
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail(
      "apply_egress",
      SCHEDULER_ERROR_CODES.egress_apply_rejected,
      `出口池 ${poolId} 下没有 active 目标（EgressTarget 全部下线或未配置）`,
      { revision },
    );
  }

  const egressDispatch = await orchestrator.dispatchEgress({
    tunnelId,
    revision,
    egressNode: egressPick.node,
    egressPort,
    poolId,
    targets: egressTargets as { host: string; port: number; weight?: number; order_by?: number }[],
    protocol: reapplyProtocol,
  });
  if (!egressDispatch.ok) {
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail("apply_egress", mapDispatchCode("egress", egressDispatch), egressDispatch.error, {
      revision,
      meta: { command_id: egressDispatch.commandId ?? null },
    });
  }
  steps.push({ step: "apply_egress", ok: true, meta: { command_id: egressDispatch.result.commandId, revision } });
  steps.push({ step: "egress_ack", ok: true, meta: { applied_revision: egressDispatch.result.revision } });

  // ── V5.4：中间跳（若有）──
  //
  // 与 rollout 路径**共用同一份实现**（`Orchestrator.dispatchTransit`）：编排可以有两处，
  // 但"怎么发一条中间跳"只能有一处 —— 否则两条路径会在某次改动后悄悄分叉。
  //
  // 正向顺序仍是**先远后近**：出口已发 → 现在发中间跳（目标 = 出口）→ 最后才切入口（目标 = 中间跳）。
  let transitHost: string | null = null;
  if (middleNodeId != null && middlePort != null) {
    const middleNode = (outCandidates as unknown as SchedulableNode[]).find((n) => n.id === middleNodeId)
      ?? (inCandidates as unknown as SchedulableNode[]).find((n) => n.id === middleNodeId);
    if (!middleNode) {
      await orchestrator
        .removeTunnel({ tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "middle node missing" })
        .catch(() => {});
      await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
      return fail("apply_transit", SCHEDULER_ERROR_CODES.invariant_violated, `中间跳节点 ${middleNodeId} 不存在`, {
        revision,
      });
    }
    const transit = await orchestrator.dispatchTransit({
      tunnelId,
      revision,
      node: {
        id: middleNode.id,
        node_id: String(middleNode.node_id ?? middleNode.id),
        connect_ip: (middleNode.connect_ip as string | null) ?? null,
        role: (middleNode.role as "both" | "egress" | "ingress" | null) ?? null,
      },
      port: middlePort,
      nextHop: `${egressDispatch.egress_host}:${egressPort}`,
      protocol: reapplyProtocol,
    });
    if (!transit.ok) {
      await orchestrator
        .removeTunnel({ tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "transit apply failed" })
        .catch(() => {});
      await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
      return fail("apply_transit", mapDispatchCode("egress", transit), transit.error, { revision });
    }
    transitHost = transit.host;
    steps.push({ step: "apply_transit", ok: true, meta: { middle_node_id: middleNodeId, port: middlePort } });
  }

  /* ---------------- V5-WP2 RuntimePlan 自检（与创建路径同源） ---------------- */
  const plan = buildForwardRuntimePlan("relay", reapplyProtocol, {
    revision,
    placement: {
      ingress_node_id: ingressPick.node.id,
      egress_node_id: egressPick.node.id,
      egress_pool_id: poolId,
    },
    listener: { host: typeof row.listen_ip === "string" ? row.listen_ip : null, port: ingressPort },
    upstream: {
      targets: (egressTargets as { host: string; port: number }[]).map((t) => ({
        host: t.host,
        port: t.port,
      })),
      // 三跳时入口的下一跳是**中间跳**，不是出口 —— 这正是 V5.4 之前这里会错的地方。
      next_hop:
        transitHost != null && middlePort != null
          ? `${transitHost}:${middlePort}`
          : `${egressDispatch.egress_host}:${egressPort}`,
    },
  });
  const planViolations = forwardRuntimePlanViolations(plan);
  if (planViolations.length > 0) {
    await orchestrator
      .removeTunnel({ tunnelId, node: egressPick.node, direction: "egress", revision: revision + 1, reason: "runtime plan invalid" })
      .catch(() => {});
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail(
      "apply_ingress",
      SCHEDULER_ERROR_CODES.invariant_violated,
      `RuntimePlan 自检未通过：${planViolations.join("; ")}`,
      { revision, meta: { runtime_plan_violations: planViolations } },
    );
  }

  /* ---------------- ⑧⑨ apply Ingress → ACK ---------------- */
  const ingressDispatch = await orchestrator.dispatchIngress({
    tunnelId,
    revision,
    ingressNode: ingressPick.node,
    ingressPort,
    nextHop: plan.upstream.next_hop as string,
    protocol: plan.protocol.name,
    ...tlsPathsFor(row, plan.protocol.name),
  });
  if (!ingressDispatch.ok) {
    await orchestrator
      .removeTunnel({ tunnelId, node: egressPick.node, revision: revision + 1, reason: "ingress apply failed" })
      .catch(() => {});
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    return fail("apply_ingress", mapDispatchCode("ingress", ingressDispatch), ingressDispatch.error, {
      revision,
      meta: { command_id: ingressDispatch.commandId ?? null },
    });
  }
  steps.push({ step: "apply_ingress", ok: true, meta: { command_id: ingressDispatch.result.commandId, revision } });
  steps.push({ step: "ingress_ack", ok: true, meta: { applied_revision: ingressDispatch.result.revision } });

  /* ---------------- ⑩ active ---------------- */
  await persistSuccess(store, tunnelId, { revision, at: deps.now() });
  steps.push({ step: "activate", ok: true, meta: { revision } });

  return {
    ok: true,
    tunnelId,
    revision,
    ingressNodeId: ingressPick.node.id,
    egressNodeId: egressPick.node.id,
    ingressPort,
    egressPort,
    steps,
  };
}

export type ApplyDirectResult =
  | {
      ok: true;
      tunnelId: number;
      revision: number;
      ingressNodeId: number;
      ingressPort: number;
    }
  | {
      ok: false;
      tunnelId: number;
      error_code: SchedulerErrorCode;
      error: string;
      retryable: boolean;
    };

/**
 * Apply/re-apply one existing DIRECT tunnel through the v3 runtime.
 *
 * Placement rule: once ingress_node_id exists, retry sticks to that concrete
 * Node. A retry must not silently migrate a user's tunnel.
 */
export async function reapplyDirectTunnel(
  tunnelId: number,
  orchestrator: Orchestrator,
  over?: SchedulerDeps,
): Promise<ApplyDirectResult> {
  const deps = resolveDeps(over);
  const store = deps.db;
  const now = deps.now();

  const row = asRow<Record<string, unknown>>(await store.tunnel.findUnique({ where: { id: tunnelId } }));
  if (!row) {
    return {
      ok: false,
      tunnelId,
      error_code: SCHEDULER_ERROR_CODES.invariant_violated,
      error: `隧道 ${tunnelId} 不存在`,
      retryable: false,
    };
  }
  if (row.tunnel_mode !== "direct") {
    return {
      ok: false,
      tunnelId,
      error_code: SCHEDULER_ERROR_CODES.mode_topology_mismatch,
      error: `隧道 ${tunnelId} 不是 DIRECT 模式`,
      retryable: false,
    };
  }
  if (admittedPersistedProtocol(row) === null) {
    const code = SCHEDULER_ERROR_CODES.unsupported_protocol;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        apply_error_code: code,
        apply_error: `[${code}] 协议未通过当前 runtime Gate`,
      },
    }).catch(() => {});
    return {
      ok: false,
      tunnelId,
      error_code: code,
      error: "协议未通过当前 runtime Gate",
      retryable: false,
    };
  }

  const blockRuntimeUse = async (denied: RuntimeUseDenied): Promise<ApplyDirectResult> => {
    const { code, detail } = await recordRuntimeBlock(store, tunnelId, denied);
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: false };
  };
  const denied = await checkExistingRuntime(row, deps);
  if (denied) return blockRuntimeUse(denied);

  const inNodeGroupId = Number(row.in_node_group_id);
  const candidates = await store.node.findMany({
    where: { node_group_id: inNodeGroupId },
    orderBy: { id: "asc" },
  }) as unknown as SchedulableNode[];

  let pick:
    | { ok: true; node: SchedulableNode; online: boolean }
    | { ok: false; reason: "no_role_match" | "no_credential" };

  const boundId = row.ingress_node_id == null ? null : Number(row.ingress_node_id);
  if (boundId !== null) {
    const bound = candidates.find((n) => n.id === boundId);
    pick = bound
      ? pickNode([bound], "ingress", now)
      : { ok: false, reason: "no_role_match" };
  } else {
    pick = pickNode(candidates, "ingress", now);
  }

  if (!pick.ok) {
    const code = pick.reason === "no_credential"
      ? SCHEDULER_ERROR_CODES.node_credential_missing
      : SCHEDULER_ERROR_CODES.node_unavailable;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] DIRECT 入口节点不可用`,
      },
    }).catch(() => {});
    return { ok: false, tunnelId, error_code: code, error: "DIRECT 入口节点不可用", retryable: isRetryable(code) };
  }

  const remoteHost = typeof row.remote_host === "string" ? row.remote_host.trim() : "";
  const remotePort = Number(row.remote_port ?? 0);
  if (!remoteHost || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    const code = SCHEDULER_ERROR_CODES.invalid_target;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] DIRECT 目标无效`,
      },
    }).catch(() => {});
    return { ok: false, tunnelId, error_code: code, error: "DIRECT 目标无效", retryable: false };
  }

  const targetDenied = await checkExistingRuntime(row, deps, { ingress: pick.node });
  if (targetDenied) return blockRuntimeUse(targetDenied);

  // Resolved once: admission, dispatch and the canonical fact written back below
  // must agree on which protocol this is.
  const directProtocol = admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL;

  /* V5-WP1 runtime admission（DIRECT：只需入口节点满足动作 + 协议 + 传输）。
     与 unsupported_protocol 同一处理：只写 apply_status/apply_error_code，
     不动 desired_status —— admission 拒绝不是用户意图改变，「失败保留业务
     资源」这条铁律在这里体现为不把 desired 改成 inactive。 */
  const directAdmissionDenied = await admitBoundRuntime(
    deps,
    [{ nodeId: pick.node.id, role: "ingress" }],
    admittedPersistedProtocol(row) ?? DEFAULT_FORWARD_PROTOCOL,
  );
  if (directAdmissionDenied) {
    const detail = admissionFailureText(directAdmissionDenied);
    const code = SCHEDULER_ERROR_CODES.runtime_capability_denied;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        apply_error_code: code,
        apply_error: detail.slice(0, 500),
      },
    }).catch(() => {});
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: false };
  }

  const reserved = collectReservedPorts(
    (await store.tunnel.findMany({
      where: { in_node_group_id: inNodeGroupId },
      select: { id: true, listen_port: true },
    }) as unknown as { id: number; listen_port: number | null }[])
      .filter((t) => t.id !== tunnelId),
  );

  let ingressPort = row.listen_port == null ? null : Number(row.listen_port);
  const alloc = await allocateTunnelPort({
    nodeId: pick.node.id,
    direction: "ingress",
    preferred: ingressPort,
    tunnelId,
    reservedPorts: reserved,
  }, deps.portPoolDeps);
  if (!alloc.ok) {
    const code = alloc.code;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] ${alloc.detail}`.slice(0, 500),
      },
    }).catch(() => {});
    return { ok: false, tunnelId, error_code: code, error: alloc.detail, retryable: isRetryable(code) };
  }
  ingressPort = alloc.port;

  const currentRevision = Number(row.config_revision ?? 0) || 0;
  const revision = currentRevision + 1;
  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      ingress_node_id: pick.node.id,
      listen_port: ingressPort,
      desired_status: DESIRED_STATUS.inactive,
      apply_status: APPLY_STATUS.applying,
      config_revision: revision,
      apply_error_code: null,
      apply_error: null,
      // See reapplyRelayTunnel: a successful re-orchestration materialises the
      // canonical protocol fact instead of leaving history's only evidence in
      // the legacy column.
      forward_protocol: directProtocol,
    },
  });

  /* V5-WP2 RuntimePlan 自检（DIRECT：端口分配后所有事实齐了）。 */
  const directPlan = buildForwardRuntimePlan("direct", directProtocol, {
    revision,
    placement: { ingress_node_id: pick.node.id },
    listener: { host: typeof row.listen_ip === "string" ? row.listen_ip : null, port: ingressPort },
    upstream: { targets: [{ host: remoteHost, port: remotePort }] },
  });
  const directPlanViolations = forwardRuntimePlanViolations(directPlan);
  if (directPlanViolations.length > 0) {
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    const code = SCHEDULER_ERROR_CODES.invariant_violated;
    const detail = `RuntimePlan 自检未通过：${directPlanViolations.join("; ")}`;
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        apply_error_code: code,
        apply_error: detail.slice(0, 500),
      },
    }).catch(() => {});
    return { ok: false, tunnelId, error_code: code, error: detail, retryable: false };
  }

  const dispatched = await orchestrator.dispatchDirect({
    tunnelId,
    revision,
    ingressNode: pick.node,
    ingressPort,
    remoteHost,
    remotePort,
    listenHost: typeof row.listen_ip === "string" ? row.listen_ip : null,
    protocol: directPlan.protocol.name,
    ...tlsPathsFor(row, directPlan.protocol.name),
  });
  if (!dispatched.ok) {
    await releaseLease({ tunnelId }, deps.portPoolDeps).catch(() => {});
    const code = mapDispatchCode("ingress", dispatched);
    await store.tunnel.update({
      where: { id: tunnelId },
      data: {
        apply_status: APPLY_STATUS.error,
        desired_status: DESIRED_STATUS.inactive,
        apply_error_code: code,
        apply_error: `[${code}] ${dispatched.error}`.slice(0, 500),
        config_revision: revision,
      },
    }).catch(() => {});
    return { ok: false, tunnelId, error_code: code, error: dispatched.error, retryable: isRetryable(code) };
  }

  await store.tunnel.update({
    where: { id: tunnelId },
    data: {
      apply_status: APPLY_STATUS.active,
      desired_status: DESIRED_STATUS.active,
      config_revision: revision,
      applied_revision: revision,
      last_applied_at: deps.now(),
      apply_error_code: null,
      apply_error: null,
    },
  });

  return { ok: true, tunnelId, revision, ingressNodeId: pick.node.id, ingressPort };
}

/** 行投影收窄（`findUnique` 返回 unknown，本文件内部使用）。 */
function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}

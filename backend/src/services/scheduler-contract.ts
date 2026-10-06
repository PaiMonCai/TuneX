/**
 * Scheduler public contract and stable error/state model.
 *
 * No DB, Redis, node selection or orchestration side effects belong here.
 */
import type { ForwardRuntimePlan } from "./forward-contract.ts";

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
  // V5.1b WP5-B2：入口 ACK 回报的跳端点与首次下发用的地址不同时，纠正出口腿的取证地址。
  "correct_hop_peer",
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


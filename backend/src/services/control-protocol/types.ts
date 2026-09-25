/**
 * WP6 — Command / Revision / ACK 协议契约（transport-agnostic）
 *
 * 依据 `DEVELOPMENT.md` §7.9「WP6 — Command / Revision / ACK Contract」
 * （Track B/C，可与 WP1/WP4 并行）。
 *
 * ── 本模块的边界（写死，防范围蔓延）──
 *  · 只定义**协议契约**：命令信封、ACK、revision 语义、错误码。
 *  · **不实现 orchestrator**（WP8 的 Egress/Ingress 编排、端口分配、补偿回滚都不在这里）。
 *  · **不绑定 transport**：不 import hono / socket.io / fetch；信封是纯数据，
 *    上层用 HTTP、WebSocket、Socket.IO 还是测试桩都随调用方。
 *  · **不要求 Panel 主动连 Agent**：§7.9 明确「控制 transport 仍由 Agent 主动出站」，
 *    本模块因此只描述「消息长什么样、按什么规则被接受/拒绝」，不描述通道谁发起。
 *  · **零运行时依赖**：本文件不 import 任何东西（连 node:crypto 都不要），
 *    保证契约测试可以在任何环境离线跑，也保证 WP8/WP7 引入它时不拖进 DB/Redis 客户端。
 *
 * ── 与 Prisma schema 的关系 ──
 *  WP6 允许与 WP1（schema 契约）并行，因此这里刻意**不 import @prisma/client**：
 *  `TUNNEL_TYPES` / `LOAD_BALANCE_TYPES` 等枚举值在本文件内按现有 schema 抄录一份，
 *  并注明「WP1 合并后复核」。schema 定稿后若要改为从 Prisma 引用，必须同步更新
 *  `__tests__/control-protocol.test.ts` 的对应断言。
 *
 * ── 版本纪律 ──
 *  信封字段一经冻结**只增不禁**：新增字段必须可选且旧实现可安全忽略。但校验侧对
 *  **未知顶层字段一律拒绝**（见 validator.ts）—— 宁可让拼写错误立刻炸掉，也不要
 *  静默吞掉一个本该生效的字段。回调方向（agent → panel）同样严格。
 */

/* ================================================================== */
/* 命令动作                                                             */
/* ================================================================== */

/**
 * §7.9 冻结的六个统一命令。
 *
 *  - `apply_tunnel`     新建/全量重放一条隧道（幂等的完整快照，非增量）。
 *  - `remove_tunnel`    下线一条隧道（保留数据，不物理删除；补偿语义见 WP8）。
 *  - `update_targets`   热更新目标池（不重建 listener）。
 *  - `suspend_tunnel`   暂停转发（保留隧道与配置）。
 *  - `state_request`    查询对端当前状态（非变更，返回 ResourceSnapshot）。
 *  - `command_ack`      把上面任一命令的 ACK 当作命令体在通道里回传（统一信封）。
 */
export const COMMAND_ACTIONS = [
  "apply_tunnel",
  "remove_tunnel",
  "update_targets",
  "suspend_tunnel",
  "state_request",
  "command_ack",
] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/**
 * Prisma 枚举的**抄录副本**（WP1 合并后复核是否改为直接引用）。
 * 抄录而不是 import：WP6 允许与 WP1 schema 契约并行，本模块不能被 schema
 * 的落地进度阻塞；同时这里不进 @prisma/client，契约测试零环境依赖。
 */
export const TUNNEL_TYPES = [
  "tcp",
  "mtcp",
  "udp",
  "tunex",
  "mtls",
  "mwss",
  "wss",
  "tls",
  "quic",
] as const;
export const LOAD_BALANCE_TYPES = ["round", "rand", "fifo", "hash", "ll", "lc"] as const;
export const IP_TYPES = ["auto", "ipv4", "ipv6"] as const;
export const TARGET_PROTOCOLS = ["tcp", "udp"] as const;

/** 被指挥的资源种类。v3 RELAY 阶段只有 tunnel 可直接指挥；node/agent 预留给 WP7/WP8。 */
export const COMMAND_RESOURCES = ["tunnel", "node", "node_group", "agent"] as const;
export type CommandResource = (typeof COMMAND_RESOURCES)[number];

/**
 * 每个动作的协议属性表。
 *
 *  - `mutating`  true = 受 revision 闸门管辖（stale/duplicate/atomic apply）；
 *               false = 查询/回报类，不改变对端状态。
 *  - `resources` 该动作允许作用于哪些资源（白名单，写错 resource 直接拒绝）。
 *  - `minRevision` revision 字段的下界；`state_request` 允许 0（"我不关心版本"），
 *    其余必须 ≥1（0 视为未初始化，禁止当版本号用）。
 */
export interface ActionSpec {
  readonly mutating: boolean;
  readonly resources: readonly CommandResource[];
  readonly minRevision: number;
}

export const ACTION_SPECS: Readonly<Record<CommandAction, ActionSpec>> = {
  apply_tunnel: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  remove_tunnel: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  update_targets: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  suspend_tunnel: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  state_request: { mutating: false, resources: ["tunnel", "node", "node_group", "agent"], minRevision: 0 },
  command_ack: { mutating: false, resources: ["tunnel", "node", "node_group", "agent"], minRevision: 1 },
};

/** 变更动作默认会把资源推到哪个状态（apply handler 可覆盖）。 */
export const DEFAULT_APPLIED_STATUS: Readonly<Record<string, ResourceStatus>> = {
  apply_tunnel: "active",
  update_targets: "active",
  suspend_tunnel: "suspended",
  remove_tunnel: "removed",
};

/* ================================================================== */
/* ACK 状态与错误码                                                     */
/* ================================================================== */

/**
 * ACK 的 `status` 四态。区分「协议层拒绝」与「执行失败」是故意的：
 * WP8 需要知道一条命令是**根本没被接受**（rejected，别重试同版本）还是
 * **接受了但没做成**（failed，可修完再发新版本）。
 */
export const ACK_STATUSES = ["applied", "duplicate", "rejected", "failed"] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

/** 协议错误码。`error_code` 是机器可判定的稳定标识，`error` 才是人读的说明。 */
export const ERROR_CODES = [
  /** 信封结构不合法（缺字段、类型错、未知字段、时间戳格式错）。 */
  "invalid_envelope",
  /** `action` 不在冻结清单里。 */
  "unknown_action",
  /** `resource` 不在清单里。 */
  "unknown_resource",
  /** 动作与资源不配套（如对 node 下发 apply_tunnel）。 */
  "action_resource_mismatch",
  /** payload 不符合该动作的 schema。 */
  "payload_invalid",
  /** `expires_at < now`，命令已过期。 */
  "command_expired",
  /** TTL 超过协议上限（防止有人下发一个永远有效的命令）。 */
  "ttl_exceeds_policy",
  /** `applied_revision > revision`：命令比已生效状态旧。 */
  "stale_revision",
  /** 同一 command_id 已被不同内容的命令占用。 */
  "duplicate_command_id",
  /** ACK 回显的 revision 与被 ack 的命令不一致。 */
  "revision_mismatch",
  /** ACK 回显的 resource/resource_id 与被 ack 的命令不一致。 */
  "command_mismatch",
  /** ACK 引用的 command_id 不存在（从未下发或已 aging 出幂等窗）。 */
  "unknown_command",
  /** 通过协议校验但执行期抛错；`applied_revision` 不前进。 */
  "apply_failed",
  /** 未分类的内部错误。 */
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/* ================================================================== */
/* 资源状态                                                             */
/* ================================================================== */

/**
 * 单资源在对端的生命周期状态。
 *  - `unknown`   从未收到过该资源的任何成功命令。
 *  - `applying`  正在执行中（同一资源的命令被串行化，见 validator.ts 的 per-resource 锁）。
 *  - `active`    正常生效。
 *  - `suspended` 已暂停。
 *  - `removed`   已下线（数据保留）。
 *  - `error`     上次执行失败（对应 WP8 的 apply_status=error，不物理删除）。
 */
export const RESOURCE_STATUSES = ["unknown", "applying", "active", "suspended", "removed", "error"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

/** `state_request` 返回的状态快照（原样进 ACK 的 `state` 字段）。 */
export interface ResourceSnapshot {
  resource: CommandResource;
  resource_id: string;
  /** 已知最新 desired revision（下发侧视野，可能高于 applied）。 */
  revision: number;
  /** 对端已生效的 revision。 */
  applied_revision: number;
  status: ResourceStatus;
  /** 当前是否有命令在执行中。 */
  applying: boolean;
  /** 最近一次被接受执行的 revision（用于观测卡在哪个版本）。 */
  last_attempted_revision: number | null;
}

/** 引擎内部持有的资源记录（可变；对外只暴露 ResourceSnapshot）。 */
export interface ResourceRecord {
  resource: CommandResource;
  resource_id: string;
  revision: number;
  applied_revision: number;
  status: ResourceStatus;
  applying: boolean;
  last_attempted_revision: number | null;
}

/* ================================================================== */
/* Payload 定义（按动作严格 schema）                                     */
/* ================================================================== */

/** 转发目标。`address` 支持 IPv4 / IPv6 / 域名（含 `[::1]` 形式）。 */
export interface TargetDescriptor {
  address: string;
  /** 1..65535 */
  port: number;
  /** 负载权重；缺省 1。 */
  weight?: number;
  protocol?: "tcp" | "udp";
}

/** apply_tunnel：完整快照，重复下发同 revision 必须幂等。 */
export interface ApplyTunnelPayload {
  tunnel: {
    name: string;
    /** 对齐 Prisma `TunnelType`（抄录版，WP1 合并后复核）。 */
    tunnel_type: string;
    listen_port: number;
    listen_ip?: string;
    protocol?: string;
    load_balance?: string;
    ip_type?: string;
    targets: TargetDescriptor[];
  };
}

/** remove_tunnel：不物理删除，`reason` 只进审计/日志。 */
export interface RemoveTunnelPayload {
  reason?: string;
}

/** update_targets：热更新目标池，不重建 listener。 */
export interface UpdateTargetsPayload {
  targets: TargetDescriptor[];
}

/** suspend_tunnel：暂停转发，隧道与配置保留。 */
export interface SuspendTunnelPayload {
  reason?: string;
}

/** state_request：不带任何业务字段（查询本身即全部意图）。 */
export interface StateRequestPayload {}

/** command_ack：把 ACK 装进信封回传（transport 只有一种消息形态时的统一通道）。 */
export interface CommandAckPayload {
  /** 被回应的命令 ID（**不是**本条 ack 信封自己的 command_id）。 */
  acked_command_id: string;
  /** 对端实际生效的 revision；拒绝/失败时可为上一版本或 null。 */
  applied_revision: number | null;
  status: AckStatus;
  error_code?: ErrorCode;
  error?: string;
  /** 可选的状态回执（响应 state_request 时携带）。 */
  state?: ResourceSnapshot | null;
}

export type CommandPayload =
  | ApplyTunnelPayload
  | RemoveTunnelPayload
  | UpdateTargetsPayload
  | SuspendTunnelPayload
  | StateRequestPayload
  | CommandAckPayload;

/* ================================================================== */
/* 命令信封                                                             */
/* ================================================================== */

/** 所有信封共用的头部。 */
export interface CommandEnvelopeBase {
  /** 全局唯一命令 ID（幂等键）。同一 ID 只能表达同一个命令。 */
  command_id: string;
  resource: CommandResource;
  resource_id: string;
  /** 该命令对应的 desired revision；`state_request` 允许 0。 */
  revision: number;
  /** ISO 8601，必带时区（`Z` 或 `±HH:MM`）。过期即拒，不给「迟早会到」的承诺。 */
  expires_at: string;
  /** 可选：下发时刻，便于链路观测；不得晚于 expires_at。 */
  issued_at?: string;
}

export type ApplyTunnelEnvelope = CommandEnvelopeBase & { action: "apply_tunnel"; payload: ApplyTunnelPayload };
export type RemoveTunnelEnvelope = CommandEnvelopeBase & { action: "remove_tunnel"; payload: RemoveTunnelPayload };
export type UpdateTargetsEnvelope = CommandEnvelopeBase & { action: "update_targets"; payload: UpdateTargetsPayload };
export type SuspendTunnelEnvelope = CommandEnvelopeBase & { action: "suspend_tunnel"; payload: SuspendTunnelPayload };
export type StateRequestEnvelope = CommandEnvelopeBase & { action: "state_request"; payload: StateRequestPayload };
export type CommandAckEnvelope = CommandEnvelopeBase & { action: "command_ack"; payload: CommandAckPayload };

/** 判别联合：`switch (env.action)` 即可把 payload 收敛到具体类型。 */
export type CommandEnvelope =
  | ApplyTunnelEnvelope
  | RemoveTunnelEnvelope
  | UpdateTargetsEnvelope
  | SuspendTunnelEnvelope
  | StateRequestEnvelope
  | CommandAckEnvelope;

/** 信封允许的顶层字段（校验侧据此拒绝未知字段）。 */
export const ENVELOPE_KEYS = [
  "command_id",
  "resource",
  "resource_id",
  "revision",
  "action",
  "expires_at",
  "payload",
  "issued_at",
] as const;

/* ================================================================== */
/* ACK 与结果记录                                                       */
/* ================================================================== */

/**
 * 对一条命令的回应。结构拒绝时回显字段为 `null` —— 语义是「这条报文里没能解析出该字段」，
 * 调用方不得把 null 当成合法值继续用。
 */
export interface CommandAck {
  command_id: string | null;
  action: CommandAction | null;
  resource: CommandResource | null;
  resource_id: string | null;
  /** 被回应的命令 revision（拒绝时 0/无法回显则为 null）。 */
  revision: number | null;
  /** 回应之后对端的已生效 revision。 */
  applied_revision: number | null;
  status: AckStatus;
  error_code?: ErrorCode;
  error?: string;
  /** 仅 state_request / command_ack 携带。 */
  state?: ResourceSnapshot | null;
  /** 生成 ACK 的时刻（ISO 8601）。 */
  acked_at?: string;
}

/**
 * 一条命令的最终结果记录（幂等重放的依据）。
 * `duplicate` 语义 = 把这条记录原样再发一遍，不重新执行。
 */
export interface CommandOutcome {
  command_id: string;
  action: CommandAction;
  resource: CommandResource;
  resource_id: string;
  revision: number;
  applied_revision: number | null;
  status: AckStatus;
  error_code?: ErrorCode;
  error?: string;
  state?: ResourceSnapshot | null;
  /** 该命令是否已收到对端 ACK（command_ack 记录成功时置位）。 */
  acked: boolean;
}

/** 下发侧构造命令的入参（command_id / expires_at 由工厂生成）。 */
export interface CreateCommandInput {
  resource: CommandResource;
  resource_id: string;
  revision: number;
  payload: CommandPayload;
  /** TTL（毫秒）。缺省用 ControlProtocol 的 defaultTtlMs。 */
  ttl_ms?: number;
  command_id?: string;
  issued_at?: string;
}

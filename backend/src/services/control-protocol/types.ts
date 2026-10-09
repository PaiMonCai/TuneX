/**
 * Transport-agnostic Command / Revision / ACK wire contract.
 *
 * The protocol defines data shapes only: no Hono, Redis, Prisma or transport
 * imports belong here. Mutation commands are revisioned and idempotent; read-only
 * diagnostic actions never enter the mutation revision gate.
 *
 * Product protocol names are copied as wire literals so the protocol package
 * stays independent from database/client generation. Runtime admission remains
 * fail-closed when a capability is not advertised/implemented.
 */

/* ================================================================== */
/* 命令动作                                                             */
/* ================================================================== */

/**
 * §7.9 冻结的六个统一命令。
 *
 *  - `apply_tunnel`     新建/全量重放一条隧道（幂等的完整快照，非增量）。
 *  - `remove_tunnel`    下线一条隧道（保留数据，不物理删除；补偿语义见 ）。
 *  - `update_targets`   热更新目标池（不重建 listener）。
 *  - `suspend_tunnel`   暂停转发（保留隧道与配置）。
 *  - `state_request`    查询对端当前状态（非变更，返回 ResourceSnapshot）。
 *  - `command_ack`      把上面任一命令的 ACK 当作命令体在通道里回传（统一信封）。
 */
export const COMMAND_ACTIONS = [
  "apply_link",
  "remove_link",
  "apply_tunnel",
  "remove_tunnel",
  "update_targets",
  "suspend_tunnel",
  "state_request",
  "command_ack",
  // : read-only, bounded reachability probe. It never mutates the
  // runtime, so it is declared non-mutating and needs no revision floor — but it
  // is also NOT a baseline action: an agent only accepts it after advertising
  // the capability (see services/agent-capability.ts).
  "diagnose_tunnel",
  // : Node-level self report. Read-only, no payload, capability-gated
  // exactly like diagnose_tunnel (an old agent must not receive it).
  "collect_diagnostics",
  // : Looking Glass — a bounded, public-target-only active test issued
  // by a user (contract §3 D7 / §5 ). It is a **new** action rather than a
  // reuse of diagnose_tunnel on purpose: diagnose targets come from a Forward's
  // own desired state (never from user input), while this one carries a target
  // the caller typed. Those two facts need different admission rules, different
  // caps and a different audit story, so they must not share an action name —
  // sharing one would let a user-typed target ride a path whose contract says
  // "targets are panel-owned".
  //
  // Read-only (no revision floor) and NOT a baseline action: an old agent has no
  // arm for it and must receive it only after advertising it.
  "looking_glass",
] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/**
 * Prisma 枚举的**抄录副本**（ 合并后复核是否改为直接引用）。
 * 抄录而不是 import： 允许与  schema 契约并行，本模块不能被 schema
 * 的落地进度阻塞；同时这里不进 @prisma/client，契约测试零环境依赖。
 */
export const TUNNEL_TYPES = [
  "tcp",
  // : `ws` is a PRODUCT protocol whose name the legacy Prisma enum does
  // not carry (it has `wss`, the historical wrapper). This whitelist is the WIRE
  // vocabulary, and it is allowed to lead the DB enum: the payload's
  // `tunnel_type` is a descriptive echo (the canonical fact is `protocol`, and
  // the Agent reads the tunnel config, not this field), while the DATABASE
  // column keeps its historical value set — see `legacyTunnelTypeColumn` in
  // services/forward-contract.ts, which omits the column for exactly this case
  // rather than writing `wss` and asserting "WebSocket over TLS".
  "ws",
  "both",
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

/** 被指挥的资源种类。v3 RELAY 阶段只有 tunnel 可直接指挥；node/agent 预留给 /。 */
export const COMMAND_RESOURCES = ["tunnel", "node", "node_group", "agent", "link"] as const;
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
/**
 *  diagnose payload.
 *
 * The panel builds this list from the tunnel's own authorized desired state —
 * never from a request body — so a caller cannot use the diagnose endpoint to
 * scan arbitrary hosts from a node.
 */
export interface DiagnoseTunnelPayload {
  /** Host/port pairs to probe, capped by the agent. */
  targets: { host: string; port: number }[];
  /** Per-attempt deadline; the agent clamps it to its own maximum. */
  timeout_ms?: number;
}

/**
 *  Node diagnostic payload: deliberately empty.
 *
 * A node self-report takes no input. Accepting one would invite "collect this
 * path" / "collect this process", which is how a diagnostic becomes a remote
 * administration surface.
 */
export interface CollectDiagnosticsPayload {
  readonly _empty?: never;
}

/**
 *  Looking Glass payload.
 *
 * **这里只有"钉死的公网字面地址"**：域名由面板解析、面板判公网，然后把地址写进
 * 命令；Agent 不会再解析任何名字（它是 DNS 重绑定的最后一道防线）。
 *
 * 校验分层（与 diagnose_tunnel 同一条纪律，见文件头）：
 *   · 本文件/validator 只管**形状**（键集闭合、类型、条数、长度上限）；
 *   · 语义白名单（公网段、规范写法、方法闭集）在 `services/looking-glass.ts`
 *     里**下发之前**判一次，Agent 侧再判一次 —— 校验器保持零依赖，不 import 业务策略。
 */
export interface LookingGlassTargetPayload {
  /** 规范 IPv4/IPv6 字面地址（面板解析后钉死；Agent 直接拨它）。 */
  address: string;
  port: number;
}

export interface LookingGlassPayload {
  /**
   * 方法闭集（task-40：`tcp_connect` + ICMP echo 两种）；未知方法拒绝而不是降级。
   * 与 `services/looking-glass.ts` 的 `LOOKING_GLASS_METHODS` 必须逐字一致。
   */
  method: "tcp_connect" | "ping" | "ping6";
  /** 面板钉死的公网目标（上限见 `looking-glass.ts` 常量表）。 */
  targets: LookingGlassTargetPayload[];
  /** 单次尝试超时（毫秒）；Agent 侧还有自己的硬上限。 */
  timeout_ms?: number;
}

export interface ActionSpec {
  readonly mutating: boolean;
  readonly resources: readonly CommandResource[];
  readonly minRevision: number;
}

export const ACTION_SPECS: Readonly<Record<CommandAction, ActionSpec>> = {
  apply_link: { mutating: true, resources: ["link"], minRevision: 1 },
  remove_link: { mutating: true, resources: ["link"], minRevision: 1 },
  apply_tunnel: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  remove_tunnel: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  update_targets: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  suspend_tunnel: { mutating: true, resources: ["tunnel"], minRevision: 1 },
  state_request: { mutating: false, resources: ["tunnel", "node", "node_group", "agent"], minRevision: 0 },
  command_ack: { mutating: false, resources: ["tunnel", "node", "node_group", "agent"], minRevision: 1 },
  diagnose_tunnel: { mutating: false, resources: ["tunnel", "node"], minRevision: 0 },
  collect_diagnostics: { mutating: false, resources: ["node"], minRevision: 0 },
  // : read-only, node-scoped, no revision floor. It must never enter the
  // mutation path: a diagnostic that advances a resource's revision is not a
  // diagnostic (same rule as diagnose_tunnel / collect_diagnostics).
  looking_glass: { mutating: false, resources: ["node"], minRevision: 0 },
};

/** 变更动作默认会把资源推到哪个状态（apply handler 可覆盖）。 */
export const DEFAULT_APPLIED_STATUS: Readonly<Record<string, ResourceStatus>> = {
  apply_link: "active",
  remove_link: "removed",
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
 *  需要知道一条命令是**根本没被接受**（rejected，别重试同版本）还是
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
 *  - `error`     上次执行失败（对应  的 apply_status=error，不物理删除）。
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
    /** 对齐 Prisma `TunnelType`（抄录版， 合并后复核）。 */
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
  /**
   * V5.1b：datagram RELAY 的入口在这个 ACK 里回报**它实际使用的跳端点**
   *（`ip:port`），面板据此告诉出口该对谁取证。
   *
   * 为什么必须走 ACK 而不是周期上报：出口腿**先于**入口腿下发（§3.2 铁律），所以那一刻
   * 该地址还不存在；等一拍上报（30s）会让每条新建的 datagram relay 在第一个周期内**必然
   * 不可用**，而面板分不清"还没服务"与"正在服务"。`next_hop` 正是走 egress ACK 回流的，
   * 一跳的两个方向只差方向不同。
   */
  hop_local_addr?: string;
}

export type CommandPayload =
  | CollectDiagnosticsPayload
  | DiagnoseTunnelPayload
  | LookingGlassPayload
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
export type DiagnoseTunnelEnvelope = CommandEnvelopeBase & { action: "diagnose_tunnel"; payload: DiagnoseTunnelPayload };
export type CollectDiagnosticsEnvelope = CommandEnvelopeBase & { action: "collect_diagnostics"; payload: CollectDiagnosticsPayload };
export type LookingGlassEnvelope = CommandEnvelopeBase & { action: "looking_glass"; payload: LookingGlassPayload };
/** Secret-free command metadata; the complete encrypted carrier config is a sibling. */
export interface LinkCommandPayload {
  link_id: number;
  workspace_id: number;
  node_id: number;
  config_digest?: string;
}
export type LinkEnvelope = CommandEnvelopeBase & {
  action: "apply_link" | "remove_link";
  payload: LinkCommandPayload;
};

/** 判别联合：`switch (env.action)` 即可把 payload 收敛到具体类型。 */
export type CommandEnvelope =
  | LinkEnvelope
  | CollectDiagnosticsEnvelope
  | DiagnoseTunnelEnvelope
  | LookingGlassEnvelope
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
  /**
   * V5.1b：datagram RELAY 的入口回报的跳端点（`ip:port`）。
   *
   * 它必须**跟着 ACK 一起被记忆**：账本会把 ACK 存下来供重放（重复 ACK / 换页重投递），
   * 若重放时丢掉这个字段，纠正就会**静默不发生**——而面板两侧的账本看起来都正常。
   */
  hop_local_addr?: string;
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

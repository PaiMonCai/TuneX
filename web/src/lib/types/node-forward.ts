/** Domain types extracted from the legacy flat types.ts facade. */
import type { ForwardProtocolFact } from "../forward-protocol";
import type { ID, Status, LBStrategy, Node, TunnelApplyStatus, TunnelDesiredStatus, Tunnel } from "./base";
import type { ListQuery } from "./attention";
import type { NodeConnectionValue, NodeRuntimeCounts, NodeHostMetrics } from "./node-health";
import type { NodeAdmissionRejection } from "./node-lifecycle";
/* ================================================================== */
/* v3 节点凭据 / 出口池 / 运行态（WP10 Admin API 契约）                  */
/* ================================================================== */

/**
 * 凭据签发的**一次性明文**（POST /admin/node/:id/credential[/rotate] 响应）。
 *
 * 明文只在这一次响应体里出现：后端不落任何存储/日志，前端也不得持久化——
 * 所以类型上只作为「立刻展示 + 复制」的瞬态值存在，关掉弹窗即消失。
 */
export interface NodeCredentialIssued {
  /** 一次性明文凭据。只在本次响应可见，勿写入 localStorage/URL */
  credential: string;
  /** 节点主键（数字） */
  node_id: ID;
  /** 节点对外标识（字符串 node_id，Agent 启动参数用） */
  node_key: string;
  /** issue 时为 issued_at，rotate 时为 rotated_at（后端二者不同名） */
  issued_at?: string;
  rotated_at?: string;
}

/** 撤销结果（POST /admin/node/:id/credential/revoke 响应）。哈希保留，仅置 revoked 位 */
export interface NodeCredentialRevoked {
  revoked: true;
  node_id: ID;
  node_key: string;
}

/** 创建/重新安装节点时只显示一次的短时 enrollment。 */
export interface NodeEnrollmentIssued {
  token: string;
  node_id: ID;
  node_key: string;
  agent_id: string;
  expires_at: string;
  install_command: string;
}

/** 用户侧 Node-first 列表的安全节点投影。 */
export interface UserNode extends Node {
  agent_id: string;
  registered?: boolean;
  has_credential?: boolean;
  /**
   * V4-WP8 §13.4.1 —— Connection 层（**事实**）。
   *
   * 后端 `routes/nodes.ts` 直接投影 `deriveConnection()` 的结论。前端**不得**
   * 用 `status` + `last_seen_at` 自行推导：改造前路由层与
   * `services/node-lifecycle.ts` 各写了一遍同一个 90s 窗口判据，两处分叉时
   * 「列表说在线、准入说不可用」就会出现（见 WP8 报告 F2/N1）。
   *
   * 缺省（旧后端 / 旧 fixture）：回落到 `online` 布尔，仍然不做本地判定。
   */
  connection?: NodeConnectionValue | null;
  /**
   * V4-WP8 §13.4.1 —— Admission 层：该节点现在能不能接新业务。
   *
   * 它是 `connection` 与 `lifecycle` 的**共同结论**，不是第三个独立状态：
   *   · `false` + `admission_rejection === "node_waiting_install"` → 去安装；
   *   · `false` + 其余码 → 去改生命周期/清依赖；
   *   · `true` + `connection === "offline"` → 掉线是故障提示，但**不影响**
   *     新业务准入（已有转发保持运行，也不是「不可用」）。
   */
  accepts_new_business?: boolean | null;
  /** Admission 拒绝码；`accepts_new_business === true` 时为 null。 */
  admission_rejection?: NodeAdmissionRejection | null;
}

/**
 * Ingress 可选择的已绑定出口。
 *
 * V4-WP9 §13.6「Binding usage」：`used_by_forward_count` / `unbind_blocked` 是
 * 服务端的**响应投影**（不新增 DB 列）。列表接口一次 groupBy 得到全部出口的
 * 使用量，因此前端在解绑前就能显示影响面、并提前禁用按钮——而不是等 409。
 */
export interface NodeBinding {
  id: ID;
  ingress_node_id: ID;
  egress_node_id: ID;
  egress_node: UserNode;
  created_at: string;
  used_by_forward_count: number;
  /** > 0 即解绑会被 409 拒绝（与后端同一判定）。 */
  unbind_blocked: boolean;
}

export interface PortForward {
  /** Missing/null creator is read-only in own mutation scope. */
  creator_user_id?: number | null;
  id: ID;
  name: string;
  /**
   * 这一行的**协议事实**（后端投影：`forward_protocol` 优先，回落
   * legacy `tunnel_type`，所以协议列出现之前的行也会报告它当时是什么）。
   *
   * 联合类型给出本契约开放的取值（`tcp` / `tls` / `ws` / `udp`，见
   * `lib/forward-protocol.ts`）；开口的那一支让历史事实（`wss` / `quic` …）保持
   * 诚实 —— 界面只渲染行上写着的东西，绝不改写它。是否被当前运行时开放看
   * {@link protocol_supported}。
   */
  protocol: ForwardProtocolFact;
  /**
   * 当前运行时是否开放这个协议（后端 `protocol_supported`）。
   * `false` = 历史/未开放的协议事实：按原样展示，**不得**替换成缺省值。
   */
  protocol_supported: boolean;
  /**
   * tls 入口的节点本地证书/私钥路径（**只有路径**，永远没有密钥内容）。
   * 后端 `forwardView` 对非 tls 行投影 `null`，所以这里恒有两个字段。
   * 详情页展示它们，编辑器用它们做 tls 路径编辑的「当前值」。
   */
  tls_cert_path: string | null;
  tls_key_path: string | null;
  mode: "direct" | "relay";
  ingress_node_id: ID;
  ingress_node: Pick<Node, "id" | "node_id" | "agent_id" | "connect_ip" | "role"> | null;
  egress_node_id: ID | null;
  egress_node: Pick<Node, "id" | "node_id" | "agent_id" | "connect_ip" | "role"> | null;
  listen_ip: string | null;
  listen_port: number | null;
  target_host: string | null;
  target_port: number | null;
  target_weight: number | null;
  traffic: number;
  traffic_cost: number;
  online: boolean;
  desired_status: TunnelDesiredStatus | null;
  apply_status: TunnelApplyStatus | null;
  config_revision: number | null;
  applied_revision: number | null;
  /** 指向最新 desired snapshot 的指针（前端作审计展示，不自行解析）。 */
  desired_revision_id: number | null;
  /** 最新 revision 号（与 config_revision 同值）；保存时作 expected_revision 回传。 */
  latest_revision: number;
  apply_error_code: string | null;
  apply_error: string | null;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortForwardCreateInput {
  name: string;
  listen_port?: number | null;
  target_host: string;
  target_port: number;
  egress_node_id?: ID | null;
}

/** Forward 创建载荷：Forward 显式拥有 mode 与 ingress 选择。 */
export interface ForwardCreateInput extends PortForwardCreateInput {
  mode: "direct" | "relay";
  ingress_node_id: ID;
  /**
   * 创建时选定的协议。省略时后端兼容回落 `tcp`；界面总是显式
   * 携带（创建了什么就发什么）。取值只能是契约白名单里的值。
   */
  protocol?: ForwardProtocolFact;
  /**
   * `tls` 入口监听使用的证书/私钥路径 —— **只有路径**，绝不含密钥内容
   * （§6.1：证书归运维，以节点本地文件存在）。非 tls 协议携带它们是 400，因此
   * 只能经 `forwardProtocolFields()` 生成，保证非 tls 的请求里这两个键不存在。
   */
  tls_cert_path?: string;
  tls_key_path?: string;
  /**
   * 三跳（多跳）的中间跳（`backend/src/routes/forwards.ts:154` 的
   * `middle_node_id: z.number().int().positive().nullable().optional()`）；省略 = 两段。
   *
   * 创建时服务端会校验**两段**邻接绑定（入口→中间、中间→出口）都存在，缺任何一段即
   * 409 `binding_required`（`backend/src/services/forward-service.ts:764-783`）。
   * 注意：`PortForward`（forwardView）**不含**中间跳 —— 列表/详情读数看不到它，
   * 只有 `GET /forwards/:id/topology` 会给 `ingress_to_middle` / `middle_to_egress` 两段。
   */
  middle_node_id?: ID | null;
}

/**
 * Forward 全字段编辑 patch（与后端 ForwardPatchSchema 同形）。
 * `expected_revision` 是可选的乐观并发凭据；缺失 = 首次请求或有意跳过检查。
 *
 * `tls_cert_path` / `tls_key_path` 被 patch schema 接受；
 * —— 证书路径属于一条转发的 desired 配置，运维换文件名不该被迫删了重建（重建还会
 * 重新分配监听端口）。规则与创建完全相同（只有 tls 能带、且必须成对）。
 *
 * `protocol` 仍然**不可编辑**：把 tcp 改成 tls 不是一次编辑（端口租约、目标语义、
 * RELAY 形态全都变），§6.1 没有冻结这套语义，所以后端 schema 用「不接受该键」
 * 而不是猜一个行为。编辑器因此只读展示协议。
 */
export interface ForwardPatchInput {
  name?: string;
  mode?: "direct" | "relay";
  ingress_node_id?: ID;
  egress_node_id?: ID | null;
  /** null = 自动分配 */
  listen_port?: number | null;
  target_host?: string | null;
  target_port?: number | null;
  /**
   * 只有 tls 行可以携带；必须成对、以 `/` 开头、≤512。非 tls 携带它们
   * 在创建路径上是 400，因此界面**结构上**不发（只能经
   * `forwardProtocolPatchFields()` 生成）。
   */
  tls_cert_path?: string;
  tls_key_path?: string;
  expected_revision?: number | null;
}

/** preview 的候选 config 投影（与后端 ForwardCandidateConfig 同形）。 */
export interface ForwardPreviewConfig {
  name: string;
  mode: "direct" | "relay";
  /** 持久化协议事实（后端 ForwardCandidateConfig.protocol）。 */
  protocol?: string;
  ingress_node_id: number;
  egress_node_id: number | null;
  listen_port: number | null;
  target_host: string | null;
  target_port: number | null;
  /** tls 的节点本地路径（非 tls 为 null），与 `forwardView` 同一投影口径。 */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
}

/**
 * preview / update 共用的影响面（§13.3.3 逐项）。
 *
 * 字段名与后端 ForwardImpact 逐条同名；UI 只消费形状，语义以后端为准。
 */
export interface ForwardImpact {
  metadata_only: boolean;
  runtime_change: boolean;
  changes_external_address: boolean;
  listen_port_change: boolean;
  listener_replacement: boolean;
  ingress_node_change: boolean;
  egress_node_change: boolean;
  mode_change: boolean;
  target_change: boolean;
  egress_target_change: boolean;
  nodes_prepare_drain: string[];
  binding_required: boolean;
  port_status: "ok" | "auto" | "conflict" | "out_of_range";
  desired_address: string | null;
}

export interface ForwardValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  reasons: string[];
}

/** `POST /api/forwards/:id/preview` 响应体（不写库）。 */
export interface ForwardPreviewResult {
  current: {
    revision: number;
    config: ForwardPreviewConfig;
    apply_status: TunnelApplyStatus | null;
    desired_status: TunnelDesiredStatus | null;
  };
  candidate: {
    revision: number;
    config: ForwardPreviewConfig;
  };
  impact: ForwardImpact;
  validation: ForwardValidation;
}

export interface ForwardSummary {
  total: number;
  direct: number;
  relay: number;
  active: number;
  error: number;
  suspended: number;
  pending: number;
  traffic: number;
  traffic_cost: number;
}

/**
 * V4-WP9 §13.6：服务端列表的查询参数（与后端 `forward-list-query.ts` 的词表一致）。
 *
 * `sort` 的取值是**后端白名单**（order_by / name / status / mode / listen_port /
 * traffic / created_at / updated_at）；这里不写联合类型是有意的——后端对未知键
 * 回落默认而不是报错，前端若把它写窄反而会逼出 `as` 断言。合法性由列表头的
 * 常量数组（`FORWARD_SORT_OPTIONS`）在渲染侧保证。
 */
export interface ForwardListQuery extends ListQuery {
  mode?: "direct" | "relay";
  apply_status?: string;
  ingress_node_id?: number;
  egress_node_id?: number;
  sort?: string;
  order?: "asc" | "desc";
}

/** Batch action whitelist mirrors the backend; delete requires confirmation. */
export type ForwardBatchAction = "retry" | "suspend" | "resume" | "delete";

export type ForwardBatchInput =
  | { action: Exclude<ForwardBatchAction, "delete">; ids: number[] }
  | { action: "delete"; ids: number[]; confirm_delete: true };

export interface ForwardBatchItemResult {
  id: ID;
  ok: boolean;
  apply_status: string | null;
  code?: string;
  message?: string;
  apply_error_code?: string;
  reconciliation_pending?: boolean;
  warning_code?: string;
  warning_message?: string;
  error_layer?: "authentication" | "rbac" | "resource_scope" | "capability" | "quota" | "runtime_admission";
}

/** 逐条结果 + 汇总计数。部分失败仍是 200，所以必须读 `failed`。 */
export interface ForwardBatchResult {
  action: ForwardBatchAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: ForwardBatchItemResult[];
}

export interface ForwardDeleteReceipt {
  ok: true;
  reconciliation_pending: boolean;
  warning_code?: "federation_release_pending" | "federation_release_unconfirmed";
  warning_message?: string;
}

export interface ProvisionNodeResult {
  node: UserNode;
  enrollment: NodeEnrollmentIssued;
}

/** 出口池（EgressPool）：挂 Node（role=egress|both），内含多个 EgressTarget */
export interface EgressPool {
  id: ID;
  node_id: ID;
  name: string;
  /** 池内目标选择策略；NULL = 回落 node.lb_strategy → round */
  lb_strategy: LBStrategy | null;
  status: Status;
  targets?: EgressTarget[];
  created_at: string;
  updated_at: string;
}

/** 出口目标（EgressPool 成员）：host 与 port 分列，不存 host:port 组合串 */
export interface EgressTarget {
  id: ID;
  pool_id: ID;
  host: string;
  port: number;
  /** 加权策略下生效；创建后必须存在至少一个 weight>0 的目标 */
  weight: number;
  order_by: number;
  remark: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface EgressPoolInput {
  name: string;
  lb_strategy?: LBStrategy | null;
  status?: Status;
}

export interface EgressTargetInput {
  host: string;
  port: number;
  weight?: number;
  order_by?: number;
  remark?: string | null;
  status?: Status;
}

/**
 * 节点运行态诊断（WP7 Agent 状态上报 → NodeStateReport）。
 *
 * 口径：`reported_at` 是面板收到上报的时刻（DB 侧时钟，非 Agent 时钟），
 * 离线判定用它而不是 Agent 自述时间，避免被节点时钟漂移骗到。
 *
 * ── 这个类型描述的是**落库行**，而 `GET /api/admin/node/:id/state` 返回的是
 *    `NodeStateView`（19 键，`backend/src/services/node-admin-state.ts:11-35`）──
 *
 * 两者**不是**同一个形状，而且差别不是措辞问题：
 *   · 状态端点**不会**返回 `known_revision` / `agent_started_at` / `hostname` /
 *     `os` / `arch` / `runtime_counts` / `host_metrics` / `error_count` /
 *     `last_error_at` / `updated_at`（这些是落库列；健康/遥测切片走别的端点读）；
 *   · 状态端点**会**返回 `node_key` / `reported_role` / `role_mismatch` / `online` /
 *     `status` / `last_seen_at` / `age_seconds` / `stale` /
 *     `control_protocol_version` / `capabilities`（下面这些"视图侧字段"）。
 * 因此视图侧字段刻意声明为**可选**：落库行投影（健康切片）没有它们，状态端点载荷有。
 * 缺省 = 这份载荷不是状态端点给的，**不是**「该字段为 0 / 空」。
 */
export interface NodeStateReport {
  node_id: ID;
  /** Agent 版本号（面板据此提示节点升级） */
  version: string | null;
  /**
   * **面板侧**角色（`node.role`，面板自己的认定）。
   *
   * 这行注释曾经写成「Agent 自报角色，与 node.role 不一致时以 node.role 为准」——那是
   * **反的**，会把两件事混成一个字段：状态端点里的 `role` 来自 `node.role`，Agent 自报值在
   * {@link NodeStateReport.reported_role}。真实面板上两者连大小写都不同
   * （`role: "ingress"` / `reported_role: "INGRESS"`）；把它们当同一个值渲染，在 mock 里
   * 看不出来（mock 曾把落库行直接回显，两个字段同值），到生产就变成一句谎话。
   */
  role: string | null;
  /** Agent 已知的最新 revision；与 Tunnel.config_revision 对比判断是否落后 */
  reported_revision: number | null;
  /** 隧道快照：`{ "tunnels": [{ id, mode, ingress_port, egress_port, revision, targets? }] }` */
  tunnels: NodeRuntimeTunnel[] | null;
  /** 出口池快照：`{ "<tunnelId>": { strategy, targets: ["host:port"] } }` */
  egress_pools: Record<string, { strategy: string; targets: string[] }> | null;
  /** 已占用端口列表（agent 侧 usedPorts） */
  used_ports: number[] | null;
  /** Agent 自述的最近错误（不写凭据） */
  last_error: string | null;
  reported_at: string;
  updated_at: string;
  // ── 视图侧字段（`NodeStateView` 有、落库行没有；可选性见文件头说明）──
  /** 节点名（`node.node_id`），状态视图用它标识节点。 */
  node_key?: string;
  /** **Agent 自报**角色（`node_state_report.role`）；`null` = 这次上报没带角色。 */
  reported_role?: string | null;
  /**
   * 面板侧角色与 Agent 自报角色是否不一致（后端 `isRoleMismatch`：两侧都非空才判，
   * 且**大小写归一**后比较）。
   *
   * `false` 有歧义（两侧一致 / 有一侧没值），所以界面必须同时看 `role` 与
   * `reported_role` 才说得清；只有 `true` 才是"确实不一致"。
   */
  role_mismatch?: boolean;
  /** 面板侧在线判定（`node.status === "active"`）——与 `stale` 是两件不同的事。 */
  online?: boolean;
  status?: string;
  last_seen_at?: string | null;
  /**
   * 上报快照的年龄（秒）。`null` = 没有快照（从未上报）。
   *
   * 它回答的是"这一格事实有多旧"，**不是**"节点在线/离线"。
   */
  age_seconds?: number | null;
  /**
   * 快照是否陈旧（后端阈值 `NODE_STATE_STALE_SECONDS = 300`）。
   *
   * **不得**渲染成"离线"或"异常"：一台在线但超过 5 分钟没上报的节点
   * `online: true` 与 `stale: true` 同时成立；反过来从未上报时后端恒给 `true`
   * （无快照 = 无新鲜证据），那更不是"离线"。
   */
  stale?: boolean;
  /** Agent 自述的控制协议版本；`null` = 未上报（按基线动作处理）。 */
  control_protocol_version?: number | null;
  /** Agent 自述已实现的动作清单；`null` = 未上报（**不得**当成空数组）。 */
  capabilities?: string[] | null;
  // ── V4-WP6 §13.4.4 扩展列（迁移 20260928000000，**落库行**）──
  //
  // 全部可空且**没有默认值**：NULL = 「Agent 还没报过这件事」，不是 0。
  // 面板必须按「未知」处理（例如旧 Agent 不报内存时不能显示「内存 0%」）。
  /** Agent 在信封里**见过**的最新 revision（不是已应用的那条） */
  known_revision?: number | null;
  /** Agent 进程启动时刻（uptime 由面板算，不用 Agent 时钟） */
  agent_started_at?: string | null;
  hostname?: string | null;
  /** runtime.GOOS */
  os?: string | null;
  /** runtime.GOARCH */
  arch?: string | null;
  /** DIRECT / RELAY-ingress / EGRESS 的 runtime 数量 */
  runtime_counts?: NodeRuntimeCounts | null;
  /** CPU / memory / disk / load 的轻量采样 */
  host_metrics?: NodeHostMetrics | null;
  /** 累计 apply/runtime 错误条数（NULL = 旧 Agent 没有这个账本） */
  error_count?: number | null;
  /** 最近一次错误时刻（NULL = 从未出错或旧 Agent） */
  last_error_at?: string | null;
}

/**
 * Agent 上报的 runtime 条目（`node_state_report.tunnels[]`）。
 *
 * `id` 是**字符串 runtime id**（`tunex-<tunnelId>-direct|relay|egress`），
 * 与后端 `parseReportedRuntimes` 的判据一致——它显式丢弃 `id` 不是字符串的行。
 * 这里原来是 `number`（早期按「隧道 id」占位写的），与真实上报形状不符：
 * 上报里同一隧道可能有两个 runtime，数字 id 无法区分 ingress/egress。
 * WP6 的 telemetry 直接消费该字段，故按后端口径校正为 string。
 */
export interface NodeRuntimeTunnel {
  /** runtime id：`tunex-<tunnelId>-direct` / `-relay` / `-egress` */
  id: string;
  mode: string;
  ingress_port?: number | null;
  egress_port?: number | null;
  revision?: number | null;
  targets?: string[];
}

/**
 * 节点详情（界面模型：节点行 + 服务端派生 role + 出口池）。
 *
 * 由 `projectNodeDetail`（`lib/api/admin.ts`）从后端聚合
 * `GET /api/admin/node/:id/detail` 的**嵌套**形状投影而来。
 *
 * **没有 `state` 字段**：运行态已拆成独立端点 `GET /api/admin/node/:id/state`，
 * 由 `loadNodeState` 取成三态（`reported` / `never_reported` / `unavailable`）。
 * 这里若保留一个可空的 `state`，消费方会把它读成"该节点没有上报"，而实际上
 * 是"这个端点不再提供运行态"——即被本专项明令禁止的"把取不到说成没有"。
 */
export interface NodeDetail extends Node {
  pools: EgressPool[];
}


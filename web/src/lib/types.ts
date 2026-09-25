/**
 * 与 backend/prisma/schema.prisma 对齐的前端类型定义。
 * 命名保持 Prisma 原样（snake_case），避免与后端 JSON 字段不一致。
 */

export type ID = number;

export type Status = "active" | "inactive";
export type NodeType = "in" | "out";
export type TunnelType = "tcp" | "mtcp" | "udp" | "tunex" | "mtls" | "mwss" | "wss" | "tls" | "quic";
export type LoadBalanceType = "round" | "rand" | "fifo" | "hash" | "ll" | "lc";
export type IpType = "auto" | "ipv4" | "ipv6";
export type TunnelCategory = "port_forward" | "remote_port_forward";
export type BillingCycle = "month" | "quarter" | "half_year" | "year" | "lifetime";
export type BypassType = "whitelist" | "blacklist";
export type TopupOrderStatus = "pending" | "success" | "cancelled";
export type TicketStatus = "open" | "closed";
export type PaymentMethod = "epay" | "bepusdt" | "heleket";
export type BalanceLogType = "topup" | "plan" | "commission_transfer" | "admin_adjust";
export type PermissionLevel = "read" | "write";
export type LicenseType = "none" | "personal" | "business";
/** v3 节点角色（WP1 schema enum NodeRole）。NULL = 尚未声明，不可默认成 ingress */
export type NodeRole = "ingress" | "egress" | "both";
/** v3 出口池默认策略（schema enum LBStrategy）；池内策略优先于节点默认值 */
export type LBStrategy = "round" | "rand";

export interface User {
  id: ID;
  email: string;
  super_admin: boolean;
  balance: number;
  commission_balance: number;
  tg_id: string | null;
  uid: string | null;
  note: string | null;
  parent_id: ID | null;
  referral_commission_rate: number | null;
  auto_renew: boolean;
  /**
   * 密钥字段：后端哈希化后，profile 读取一律返回 null（明文只在轮换端点出现一次）。
   * 前端不得依赖该值做展示或拼接订阅地址，统一走 null 兜底分支。
   */
  api_key: string | null;
  subscription_key: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
  /** TEN-03：邮箱验证时间；null = 未验证（0.1 阶段软约束，不阻断登录） */
  email_verified_at: string | null;
  // 关联（可选，由后端 include 决定）
  user_plan?: UserPlan | null;
  roles?: AdminRole[];
  admin_roles?: AdminRole[];
}

export interface AdminRole {
  id: ID;
  name: string;
  description: string | null;
  permissions: Record<string, PermissionLevel>;
  _count?: { users: number };
  created_at: string;
  updated_at: string;
}

/** 角色新建/编辑载荷（PUT /admin/role/:id、POST /admin/role） */
export interface AdminRoleInput {
  name: string;
  description: string | null;
  permissions: Record<string, PermissionLevel>;
}

/** 权限元数据资源项（GET /admin/meta/resources） */
export interface AdminResourceMeta {
  key: string;
  label: string;
  group: string;
  url: string;
  business: boolean;
  apiPrefixes: string[];
  granted: PermissionLevel | null;
}

/* ------------------------------------------------------------------ *
 * TEN-01 工作空间（Workspace / Membership / Invite）
 * 字段与 backend/prisma/schema.prisma 及 backend/src/routes/workspaces.ts 对齐。
 * ------------------------------------------------------------------ */

/** personal = 注册时自动创建的个人空间；team = 手动创建的团队空间 */
export type WorkspaceKind = "personal" | "team";
/** 固定四角色（services/workspace.ts 的 canWorkspaceAction 决定各动作权限） */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/** GET /api/workspaces 的一行：工作空间 + 当前用户在该空间的角色 */
export interface Workspace {
  id: ID;
  name: string;
  slug: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  created_at: string;
}

/** GET /api/workspaces/:id/members 的一行（user.email 被拍平成 email） */
export interface WorkspaceMember {
  user_id: ID;
  email: string;
  role: WorkspaceRole;
  created_at: string;
}

/** POST /api/workspaces 的载荷（团队空间名，1–120 字符） */
export interface WorkspaceCreateInput {
  name: string;
}

/** POST /api/workspaces/:id/invites 的载荷（受邀角色不含 owner） */
export interface WorkspaceInviteInput {
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
}

/**
 * 邀请响应：`token` 只在创建时返回一次（后端仅存 sha256），
 * 因此必须当场展示/复制，刷新后无法再找回。
 */
export interface WorkspaceInvite {
  id: ID;
  email: string;
  role: WorkspaceRole;
  expires_at: string;
  token: string;
}

/** POST /api/workspaces/invites/accept 的响应 */
export interface WorkspaceAcceptInviteResult {
  workspace_id: ID;
}

/** 系统配置项（config 表一行） */
export interface SystemConfigItem {
  id: ID;
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

/** 授权信息（GET /admin/license） */
export interface LicenseInfo {
  type: LicenseType;
  [key: string]: unknown;
}

/** 审计日志一行（GET /admin/audit-logs，仅超级管理员可读） */
export interface AuditLog {
  id: ID;
  actor_type: "user" | "super_admin" | "admin" | "system" | "anonymous";
  actor_id: number | null;
  actor_email: string | null;
  /** 形如 `POST /api/admin/users/:id` */
  action: string;
  resource: string;
  resource_id: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** 通用列表查询（管理端各处复用） */
export interface AdminListInput {
  page?: number;
  page_size?: number;
  keyword?: string;
  status?: string;
  kind?: string;
  user_id?: number;
}

/** 审计日志查询（GET /admin/audit-logs） */
export interface AuditLogQuery extends AdminListInput {
  actor_type?: string;
  method?: string;
  resource?: string;
}

/** 只读资源的分页列表查询（供只读表格组件复用，含 page_size） */
export interface AdminListQuery {
  page?: number;
  page_size?: number;
  keyword?: string;
  status?: string;
  kind?: string;
  user_id?: number;
}

/** 切换开关载荷（通用 PUT/PATCH body） */
export interface ToggleInput {
  status?: Status;
  [key: string]: unknown;
}

/** 登录响应：原版使用托管认证，本实现自签本地 JWT */
export interface AuthSession {
  user: User;
  token?: string;
  expires_at?: string;
  /** TEN-03：后端在登录/注册响应里附带，供前端弹出「去验证邮箱」提示 */
  email_verified?: boolean;
  /**
   * 仅 mock 模式：后端没有真实响应头，浏览器拿不到 Set-Cookie，
   * 故由 mock 下发会话 cookie 字符串，api 层在客户端写入 document.cookie。
   * 真实后端存在时该字段为 undefined（走真正的 Set-Cookie）。
   */
  session_cookie?: string;
}

export interface NodeGroup {
  id: ID;
  token: string;
  name: string;
  port_range: string | null;
  connect_ip: string | null;
  node_type: NodeType;
  load_balance_type: LoadBalanceType;
  allow_listen_protocol: boolean;
  allow_listen_protocols: string[] | null;
  allow_tunnel_types: TunnelType[] | null;
  bypass_type: BypassType;
  bypass_list: string[] | null;
  admission: boolean;
  block_protocols: string[] | null;
  traffic_rate: number;
  need_out_node_group: boolean;
  allow_out_node_groups: number[] | null;
  allow_in_node_groups: number[] | null;
  order_by: number;
  user_id: ID;
  created_at: string;
  updated_at: string;
  // 统计字段
  node_count?: number;
  online_node_count?: number;
}

export interface Node {
  id: ID;
  /** 用户可读节点名/标签。 */
  node_id: string;
  /** Panel 生成的不可变物理 Agent 唯一 ID；旧管理接口/fixture 迁移期可缺省。 */
  agent_id?: string;
  weight: number;
  status: Status;
  connect_ip: string | null;
  version: string;
  backup: boolean;
  order_by: number;
  custom_line: string | null;
  dns_status: boolean;
  node_group_id: ID;
  node_group?: Pick<NodeGroup, "id" | "name" | "node_type">;
  created_at: string;
  updated_at: string;
  online?: boolean;
  traffic?: number;
  // ── v3 增量字段（WP1 schema：全部可空，存量行 = 尚未声明 / 从未配置）──
  /**
   * v3 节点角色。NULL = 尚未声明（WP2 回填策略「不改 / 不猜」的产物）。
   * 面板必须显式展示「未声明」并允许设置，不得默认成 ingress —— 那会让
   * 未声明节点被误当入口参与调度（DEVELOPMENT.md §7.1）。
   */
  role?: NodeRole | null;
  /** 最近一次心跳；NULL = 从未心跳（不替代 offline-detector 的 Redis 防抖） */
  last_seen_at?: string | null;
  /** 可分配端口区间（WP3 NodePortLease 的分配域）；NULL = 未配置 */
  port_range_min?: number | null;
  port_range_max?: number | null;
  /** egress/both 节点的默认池策略；NULL = 回落 round */
  lb_strategy?: LBStrategy | null;
  // ── v3 增量字段（WP7 per-node credential）──
  /**
   * 服务端**绝不下发** `node_credential_hash`（列表/详情接口不含该列），
   * 前端只凭这三个派生状态渲染凭据区块：
   *   - hasCredential = hash != null → 已签发（是否有效另看 revoked）
   *   - credential_revoked = true → 已撤销（哈希保留，面板能区分「撤销」与「瞎猜」）
   * 因此 `has_credential` 这类布尔是展示便利字段，真值永远在后端。
   */
  has_credential?: boolean;
  credential_revoked?: boolean;
  credential_rotated_at?: string | null;
  /** 最近一次 rejected 认证时刻：rotate 时识别「谁还在拿旧 token 敲门」 */
  credential_last_rejected_at?: string | null;
}

/**
 * v3 隧道模式（schema enum TunnelMode，DEVELOPMENT.md §2.1）。
 * NULL = 存量行 / 未参与 v3 编排的 legacy DIRECT 隧道，**不得**默认成 direct
 * 之外的任何值——存量隧道在补列当口就是「未声明」，与 NodeRole 同理。
 */
export type TunnelMode = "direct" | "relay";

/**
 * v3 隧道 apply 状态机（schema 注释 / DEVELOPMENT.md §4.1）。
 *
 *   pending   —— 已生成期望状态（desired_status + config_revision），尚未下发
 *   applying  —— 已下发，等待 Agent ACK
 *   active    —— RELAY 两端（先 egress 后 ingress）均 ACK 同一 revision
 *   error     —— 任一步失败：保留记录，原因见 apply_error_code / apply_error
 *   suspended —— 节点失效 / 管理员暂停后的可解释状态（不物理删除隧道数据）
 *
 * NULL = legacy DIRECT 隧道（无 revision / 无编排），走旧 config-generator。
 */
export type TunnelApplyStatus = "pending" | "applying" | "active" | "error" | "suspended";

/** 期望状态（控制面想让隧道处于什么状态；与运行态 apply_status 是两列）。 */
export type TunnelDesiredStatus = "active" | "inactive";

export interface Tunnel {
  id: ID;
  name: string;
  tunnel_type: TunnelType;
  category: TunnelCategory;
  listen_ip: string | null;
  listen_port: number | null;
  listen_protocol: string[] | null;
  status: Status;
  /** legacy DIRECT 开关列（active/inactive）；与 desired_status 并行存在。 */
  forward_addresses: string[];
  forward_addresses_protocol: string[] | null;
  load_balance_type: LoadBalanceType;
  ip_type: IpType;
  order_by: number;
  ip_limit: number | null;
  client_limit: number | null;
  bandwidth_limit: number | null;
  traffic: number;
  traffic_cost: number;
  proxy_protocol: boolean;
  in_node_group_id: ID;
  in_node_group?: Pick<NodeGroup, "id" | "name" | "node_type">;
  out_node_group_id: ID | null;
  out_node_group?: Pick<NodeGroup, "id" | "name" | "node_type"> | null;
  user_id: ID;
  user?: Pick<User, "id" | "email">;
  port_conflict_at: string | null;
  created_at: string;
  updated_at: string;
  // 运行态（由 agent 上报，非 schema 列）
  online?: boolean;
  client_count?: number;
  // ---------------------------------------------------------------
  // v3 RELAY 增量字段（WP1 schema：全部可空，存量行 = 未参与 v3 编排）
  // ---------------------------------------------------------------
  /**
   * v3 隧道模式。NULL = 存量 legacy DIRECT（§7.1「不改 / 不猜」）。
   * 面板必须显式渲染「未声明」，不得默认成 direct。
   */
  tunnel_mode?: TunnelMode | null;
  /** v4 入口节点主键；旧 Tunnel payload 迁移期可缺省。 */
  ingress_node_id?: ID | null;
  /** RELAY 实际出口节点（schema §2.1：禁止只存 NodeGroup）；DIRECT = NULL */
  egress_node_id?: ID | null;
  /** 出口节点展示引用（由后端 include 提供，缺失时回落 id） */
  egress_node?: Pick<Node, "id" | "node_id" | "connect_ip"> | null;
  /** RELAY 出口侧内部通信端口（节点间端口，**不是**用户可见端口） */
  egress_port?: number | null;
  /** RELAY 指向的出口目标池（Tunnel.egress_pool_id） */
  egress_pool_id?: ID | null;
  egress_pool?: Pick<EgressPool, "id" | "name" | "lb_strategy" | "status"> | null;
  /** DIRECT 模式目标（由存量 forward_addresses[0] 回填）；RELAY 不使用 */
  remote_host?: string | null;
  remote_port?: number | null;
  /** 期望状态：控制面想让隧道处于什么状态（active/inactive） */
  desired_status?: TunnelDesiredStatus | null;
  /** 实际 apply 状态机；NULL = legacy DIRECT（无编排） */
  apply_status?: TunnelApplyStatus | null;
  /** 控制面期望版本；每次 desired/配置变更自增 */
  config_revision?: number | null;
  /** 最近被 Agent ACK 确认的版本；< config_revision = 待下发 */
  applied_revision?: number | null;
  /** 结构化错误码 + 原文；失败时保留 Tunnel（§4.1 禁止物理删除） */
  apply_error_code?: string | null;
  apply_error?: string | null;
  last_applied_at?: string | null;
  /**
   * RELAY 编排步骤摘要（WP8 十步有序的只读回放，用于解释「卡在哪一步」）。
   * 后端返回 steps 列表；前端只展示，不据此发明状态。
   */
  apply_steps?: TunnelApplyStep[] | null;
}

export interface TunnelCreateInput {
  name: string;
  tunnel_type: TunnelType;
  category: TunnelCategory;
  in_node_group_id: ID;
  out_node_group_id?: ID | null;
  forward_addresses: string[];
  listen_port?: number | null;
  ip_type?: IpType;
  load_balance_type?: LoadBalanceType;
  bandwidth_limit?: number | null;
  client_limit?: number | null;
  ip_limit?: number | null;
  // ── v3（WP11 Tunnel RELAY API 契约；后端未落地字段一律不下发）──
  /**
   * v3 模式：direct = 单跳到 remote_host/remote_port；relay = 双跳经出口节点。
   * 缺省 = 交给后端按 forward_addresses 推导（存量路径不变）。
   */
  tunnel_mode?: TunnelMode;
  /** RELAY 出口目标池；缺省 = 出口节点的 default 池（§2.2） */
  egress_pool_id?: ID | null;
  /** RELAY 出口节点 id（backends 显式绑定；不传则由编排器从出口组挑选） */
  egress_node_id?: ID | null;
  /** DIRECT 模式目标（单跳）；RELAY 不使用（目标在 EgressTarget 上） */
  remote_host?: string;
  remote_port?: number;
}

export interface Plan {
  id: ID;
  name: string;
  description: string | null;
  original_price: number | null;
  price: number;
  max_tunnels: number | null;
  traffic: number | null; // GB
  ip_limit: number | null;
  client_limit: number | null;
  bandwidth_limit: number | null;
  whitelist_limit: number | null;
  allow_custom_in_node_group: boolean;
  allow_custom_out_node_group: boolean;
  all_in_node_groups: boolean;
  all_out_node_groups: boolean;
  setup_fee: number | null;
  billing_cycle: BillingCycle;
  status: Status;
  renewable: boolean;
  stock: number | null;
  order_by: number;
  created_at: string;
  updated_at: string;
  node_groups?: Pick<NodeGroup, "id" | "name">[];
}

export interface UserPlan {
  id: ID;
  user_id: ID;
  traffic: number | null;
  traffic_used: number;
  max_tunnels: number | null;
  whitelist_ips: string[] | null;
  expired_at: string | null;
  plan_id: ID;
  plan?: Plan;
  created_at: string;
  updated_at: string;
}

export interface PlanOrder {
  id: ID;
  user_id: ID;
  user?: Pick<User, "id" | "email">;
  plan_id: ID;
  plan?: Pick<Plan, "id" | "name" | "price" | "billing_cycle">;
  price: number;
  balance: number;
  coupon_id: ID | null;
  created_at: string;
  updated_at: string;
}

export interface TopupOrder {
  id: ID;
  user_id: ID;
  user?: Pick<User, "id" | "email">;
  price: number;
  balance: number;
  bonus: number;
  payment_id: ID;
  payment?: Pick<Payment, "id" | "name" | "method">;
  pay_url: string;
  status: TopupOrderStatus;
  order_id: string;
  trade_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: ID;
  name: string;
  method: PaymentMethod;
  url: string;
  fixed_fee: number | null;
  percent_fee: number | null;
  type: string | null;
  status: Status;
  order_by: number;
}

export interface BalanceLog {
  id: ID;
  user_id: ID;
  balance: number;
  amount: number;
  type: BalanceLogType;
  created_at: string;
  updated_at: string;
}

export interface TicketReply {
  id: ID;
  content: string;
  is_admin: boolean;
  ticket_id: ID;
  user_id: ID;
  created_at: string;
  updated_at: string;
}

export interface Ticket {
  id: ID;
  title: string;
  content: string;
  status: TicketStatus;
  user_id: ID;
  user?: Pick<User, "id" | "email">;
  replies?: TicketReply[];
  created_at: string;
  updated_at: string;
}

export interface TunnelTraffic {
  id: ID;
  tunnel_id: ID;
  traffic: number;
  traffic_cost: number;
  date: string;
}

export interface TrafficPoint {
  date: string;
  traffic: number;
  traffic_cost: number;
}

/**
 * OPS-03：workspace 级流量聚合（对应 GET /api/workspaces/:id/traffic，
 * 后端 services/traffic.ts 的 WorkspaceTrafficSummary）。
 *
 * 与旧的 `dashboard.traffic`（用户级、无归属过滤）的区别：
 *   · 带 `workspace_id` 与策略周期口径（`period`），与「流量耗尽」判定同源；
 *   · 同时给 `by_tunnel`（排行）与 `by_day`（趋势，缺日子补 0）。
 */
export type TrafficPeriod = "day" | "month" | "total";

/** 单隧道流量排行项（后端按 traffic 降序返回）。 */
export interface TunnelTrafficGroup {
  tunnel_id: ID;
  name: string;
  tunnel_type: TunnelType;
  in_node_group_id: ID | null;
  in_node_group_name: string | null;
  traffic: number;
  traffic_cost: number;
}

export interface WorkspaceTrafficSummary {
  workspace_id: ID;
  /** 生效策略的流量计量周期（聚合窗口口径）。 */
  period: TrafficPeriod;
  /** 窗口起点 ISO 串；`total` 周期为 null（不限窗口）。 */
  since: string | null;
  total_traffic: number;
  total_traffic_cost: number;
  by_tunnel: TunnelTrafficGroup[];
  /** 按日界补齐的序列（缺日子补 0，前端图表点数稳定）。 */
  by_day: TrafficPoint[];
  orphan_rows: number;
}

export interface DashboardStats {
  balance: number;
  commission_balance: number;
  tunnel_count: number;
  max_tunnels: number | null;
  traffic_used: number;
  traffic_limit: number | null;
  plan_name: string | null;
  expired_at: string | null;
  active_nodes: number;
  total_nodes: number;
  today_traffic: number;
  month_traffic: number;
}

export interface AdminDashboardStats {
  user_count: number;
  tunnel_count: number;
  node_count: number;
  online_node_count: number;
  order_count: number;
  pending_topup_count: number;
  open_ticket_count: number;
  total_balance: number;
  today_revenue: number;
  today_traffic: number;
  tunnel_type_distribution: { type: string; count: number }[];
  revenue_trend: { date: string; amount: number }[];
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface ListQuery {
  page?: number;
  page_size?: number;
  keyword?: string;
  status?: string;
  [key: string]: string | number | boolean | undefined;
}

/* ------------------------------------------------------------------ *
 * 写操作的请求体类型：与后端 REST 契约对齐（前端表单直接复用）
 * ------------------------------------------------------------------ */

/** 隧道可更新字段（PATCH /tunnels/:id） */
export interface TunnelUpdateInput {
  name?: string;
  status?: Status;
  forward_addresses?: string[];
  load_balance_type?: LoadBalanceType;
  ip_type?: IpType;
  bandwidth_limit?: number | null;
  client_limit?: number | null;
  ip_limit?: number | null;
  order_by?: number;
  // ── v3（WP11 契约；只改 desired state，revision 自增由控制面负责）──
  /** v3 模式切换（direct ↔ relay）；relay 必须给出口组/池 */
  tunnel_mode?: TunnelMode;
  out_node_group_id?: ID | null;
  egress_pool_id?: ID | null;
  egress_node_id?: ID | null;
  remote_host?: string | null;
  remote_port?: number | null;
  /** 期望状态（active/inactive）；resume 走这里，不是 apply_status 直写 */
  desired_status?: TunnelDesiredStatus;
}

/* ================================================================== */
/* WP13 Tunnel Web —— v3 隧道编排运行态契约（mock 标注见 api.tunnels）   */
/* ================================================================== */

/**
 * WP8 十步编排的一步（只读回放）。前端只用于解释「卡在哪一步」，
 * 不据此推导状态机（状态真相是 apply_status）。
 */
export interface TunnelApplyStep {
  step: string;
  ok: boolean;
  meta?: Record<string, unknown> | null;
  error?: string | null;
}

/** retry / suspend / resume 三个运行操作的统一响应（WP11 unified orchestrator）。 */
export interface TunnelRuntimeAction {
  tunnel: Tunnel;
  /** 操作后隧道进入的状态（前端据此刷新徽章，不自行推断） */
  apply_status: TunnelApplyStatus;
  /** 操作后的 revision（retry 会 +1；suspend/resume 不变） */
  config_revision: number | null;
  /** 编排是否已重入（幂等键命中时 true，不算失败） */
  reentered?: boolean;
}

/** 隧道列表查询（WP11：按 apply_status 过滤替代 legacy status） */
export interface TunnelListQuery {
  page?: number;
  page_size?: number;
  keyword?: string;
  /** legacy 开关列过滤 */
  status?: Status;
  /** v3 apply 状态机过滤（pending/applying/active/error/suspended） */
  apply_status?: TunnelApplyStatus;
  /** v3 模式过滤 */
  tunnel_mode?: TunnelMode;
  /** 只看「待下发」：applied_revision < config_revision */
  pending_only?: boolean;
  [key: string]: string | number | boolean | undefined;
}

/** 创建 RELAY 隧道时可选的出口池候选项（用户侧只展示可用池，不暴露 Node 主键细节）。 */
export interface TunnelEgressPoolOption {
  id: ID;
  name: string;
  node_id: ID;
  node_label: string;
  lb_strategy: LBStrategy | null;
  status: Status;
  targets: { host: string; port: number; weight: number; status: Status }[];
}

/** 个人设置：基础资料（PATCH /settings/profile） */
export interface ProfileUpdateInput {
  email?: string;
  note?: string | null;
  tg_id?: string | null;
  auto_renew?: boolean;
}

/** 个人设置：修改密码（POST /settings/password） */
export interface PasswordChangeInput {
  current_password: string;
  new_password: string;
}

/** 管理端：套餐新建/编辑（不变量字段由后端补齐） */
export interface PlanInput {
  name: string;
  description: string | null;
  price: number;
  original_price: number | null;
  max_tunnels: number | null;
  traffic: number | null;
  ip_limit: number | null;
  client_limit: number | null;
  bandwidth_limit: number | null;
  whitelist_limit: number | null;
  setup_fee: number | null;
  billing_cycle: BillingCycle;
  status: Status;
  renewable: boolean;
  stock: number | null;
  order_by: number;
  allow_custom_in_node_group: boolean;
  allow_custom_out_node_group: boolean;
  all_in_node_groups: boolean;
  all_out_node_groups: boolean;
}

/** 管理端：节点组新建/编辑 */
export interface NodeGroupInput {
  name: string;
  token: string;
  port_range: string | null;
  connect_ip: string | null;
  node_type: NodeType;
  load_balance_type: LoadBalanceType;
  traffic_rate: number;
  bypass_type: BypassType;
  bypass_list: string[] | null;
  allow_listen_protocol: boolean;
  allow_listen_protocols: string[] | null;
  allow_tunnel_types: TunnelType[] | null;
  admission: boolean;
  need_out_node_group: boolean;
  order_by: number;
}

/** 管理端：节点新建/编辑 */
export interface NodeInput {
  node_id: string;
  connect_ip: string | null;
  weight: number;
  version: string;
  status: Status;
  backup: boolean;
  custom_line: string | null;
  dns_status: boolean;
  order_by: number;
  node_group_id: ID;
  // ── v3 增量字段（可选：旧面板只发上面的字段时后端按「不动该列」处理）──
  role?: NodeRole | null;
  port_range_min?: number | null;
  port_range_max?: number | null;
  lb_strategy?: LBStrategy | null;
}

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
}

/** Ingress 可选择的已绑定出口。 */
export interface NodeBinding {
  id: ID;
  ingress_node_id: ID;
  egress_node_id: ID;
  egress_node: UserNode;
  created_at: string;
}

export interface PortForward {
  id: ID;
  name: string;
  protocol: "tcp";
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

/** V4 product API payload. Forward owns the explicit mode + ingress choice. */
export interface ForwardCreateInput extends PortForwardCreateInput {
  mode: "direct" | "relay";
  ingress_node_id: ID;
}

export interface ForwardPatchInput {
  name?: string;
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
 */
export interface NodeStateReport {
  node_id: ID;
  /** Agent 版本号（面板据此提示节点升级） */
  version: string | null;
  /** Agent 自报角色，与 node.role 不一致时以 node.role 为准 */
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
}

export interface NodeRuntimeTunnel {
  id: number;
  mode: string;
  ingress_port?: number | null;
  egress_port?: number | null;
  revision?: number | null;
  targets?: string[];
}

/** 节点详情（列表行 + 凭据状态派生 + 出口池 + 运行态） */
export interface NodeDetail extends Node {
  pools: EgressPool[];
  state: NodeStateReport | null;
}

/** 管理端：用户新建/编辑 */
export interface AdminUserInput {
  email: string;
  balance: number;
  commission_balance: number;
  super_admin: boolean;
  status: Status;
  uid: string | null;
  note: string | null;
  referral_commission_rate: number | null;
  auto_renew: boolean;
  password?: string;
}

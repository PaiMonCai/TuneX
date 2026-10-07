/** Domain types extracted from the legacy flat types.ts facade. */
import type { TunnelApplyStep } from "./admin-inputs";
import type { PortForward, EgressPool, EgressTarget } from "./node-forward";
import type { NodeLifecycleValue } from "./node-health";
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
/** 节点角色。NULL = 尚未声明，不可默认成 ingress。 */
export type NodeRole = "ingress" | "egress" | "both";
/** 出口池默认策略；池内策略优先于节点默认值。 */
export type LBStrategy = "round" | "rand" | "weighted_round" | "fallback" | "ip_hash";

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
  /** 邮箱验证时间；null = 未验证。 */
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

/* Workspace / Membership / Invite —— 与后端 schema/routes 对齐。 */

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
  role_id?: number | null;
  custom_role_id?: number | null;
  custom_role_name?: string | null;
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
  /**
   * 配置值。**凭据类键恒为空串**（后端只回"配没配"，不回明文）：
   * 例如 `RESEND_API_KEY` / `CHATWOOT_TOKEN`（历史上的 `SMTP_PASS` 也是这一类）。
   */
  value: string;
  /**
   * 仅凭据类键存在：`true` = 服务端已存了一个非空值（**只写不读**，因此只能靠这个字段显示状态）。
   * N-F3：此前类型里没有它 ⇒ 界面**无法**显示"已配置"，用户只看到一个空输入框、无从判断现状。
   */
  secret_configured?: boolean;
  /**
   * `true` = 这个键**只读**：后端不再接受写入（当前只有已废弃的 `NOTICE*` 三个键）。
   * 它仍然出现在列表里，是为了让旧值**可见**（审计/迁移）；界面不得渲染可编辑控件。
   */
  read_only?: boolean;
  /** 只读的原因（目前只有 `deprecated`：公告真相已迁到 `announcement` 表）。 */
  read_only_reason?: "deprecated";
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
  /**
   * 节点角色。NULL = 尚未声明；不得替历史节点猜成 ingress。
   * 面板必须显式展示「未声明」并允许设置，不得默认成 ingress —— 那会让
   * 未声明节点被误当入口参与调度（DEVELOPMENT.md §7.1）。
   */
  role?: NodeRole | null;
  /** 最近一次心跳；NULL = 从未心跳（不替代 offline-detector 的 Redis 防抖） */
  last_seen_at?: string | null;
  /** 可分配端口区间；NULL = 未配置。 */
  port_range_min?: number | null;
  port_range_max?: number | null;
  /** egress/both 节点的默认池策略；NULL = 回落 round */
  lb_strategy?: LBStrategy | null;
  /**
   * 节点生命周期，默认 active。
   *
   * 与 `connection` 正交（§13.4.1）：连接是**事实**，生命周期是**期望**。
   * 「维护中」的在线节点不是故障，所以面板把它渲染成中性的 maintenance
   * 徽章，而不是红色 error；health 视图据此展示，不做第二套判定。
   */
  lifecycle?: NodeLifecycleValue | null;
  /**
   * 进入 maintenance / disabled / retiring 的原因（用户填写，纯备注、不参与判定）。
   *
   * 注意它**不在** lifecycle 视图里（后端 `lifecycleView` 的键是固定的十个，
   * 有意不含备注），而是节点行的一列。管理端 `/admin/nodes[/:id]` 用的是全字段
   * select，所以这里能拿到；用视图判断「有没有备注」会永远读到 undefined。
   */
  lifecycle_note?: string | null;
  /** 最近一次 lifecycle 变更时刻（展示「维护了多久」）。 */
  lifecycle_updated_at?: string | null;
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
 * 兼容 Tunnel 的模式。NULL = 补列前存量行，必须保持“未声明”，不得自行猜成 direct/relay。
 */
export type TunnelMode = "direct" | "relay";

/**
 * 兼容 Tunnel 的 apply 状态机。
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
  /**
   * 行级协议事实（`Tunnel.forward_protocol` 列）。
   *
   * 只给 **mock 的 store** 用：mock 的行是 DB 行（含 `remote_host` 等运行态列）的
   * 镜像，而 `forward_protocol` 是 `PortForward.protocol` 投影的唯一来源，
   * mock 必须保留它，否则历史协议会被错误回落成 `tcp`。
   * 真实 `/api/tunnels` 的响应是否携带该列由后端决定，前端不依赖它。
   */
  forward_protocol?: string | null;
  /** tls 入口的证书/私钥路径列（仅路径，无密钥内容）。 */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
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
  /**
   * Tunnel 模式。NULL = 存量 legacy 行；不得替它猜模式。
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
   * RELAY 编排步骤摘要（只读回放，用于解释“卡在哪一步”）。
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
  // Legacy Tunnel orchestration fields.
  /**
   * direct = 单跳到 remote_host/remote_port；relay = 双跳经出口节点。
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
  /// V5-WP20-4b：套餐 → 能力策略的显式绑定。NULL = 未绑定（购买时不发放 purchase 发放）。
  policy_id?: ID | null;
  /// 管理端读投影：绑定的策略摘要（列表/保存响应里由后端 `include` 带出）。
  policy?: { id: ID; key: string; name: string; status: Status; is_ceiling: boolean } | null;
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
  /**
   * V5-WP20-5：到期/宽限的可观测投影（后端 `policy-service#buildUsageExpiryView` 的输出）。
   * `null` = 策略读取失败（与「没有到期点」区分：后者是 `policy_expires_at: null`）。
   *
   * 为什么展示层要读它而不是自己判断到期：拒绝文案的唯一实现是后端的 `describeDeny`，
   * 前端抄一份中文就会出现两处口径（改一处忘一处）。这里只渲染后端给的 `deny_message`。
   */
  expiry?: {
    policy_expires_at: string | null;
    in_grace: boolean;
    grace_expires_at: string | null;
    deny_scope: boolean;
    deny_reason: string | null;
    deny_message: string | null;
  } | null;
  active_nodes: number;
  total_nodes: number;
  today_traffic: number;
  month_traffic: number;
}


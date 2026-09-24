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
  node_id: string;
  weight: number;
  status: Status;
  connect_ip: string;
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
}

export interface Tunnel {
  id: ID;
  name: string;
  tunnel_type: TunnelType;
  category: TunnelCategory;
  listen_ip: string | null;
  listen_port: number | null;
  listen_protocol: string[] | null;
  status: Status;
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
  connect_ip: string;
  weight: number;
  version: string;
  status: Status;
  backup: boolean;
  custom_line: string | null;
  dns_status: boolean;
  order_by: number;
  node_group_id: ID;
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

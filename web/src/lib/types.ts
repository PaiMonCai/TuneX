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
  api_key: string;
  subscription_key: string;
  status: Status;
  created_at: string;
  updated_at: string;
  // 关联（可选，由后端 include 决定）
  user_plan?: UserPlan | null;
  roles?: AdminRole[];
}

export interface AdminRole {
  id: ID;
  name: string;
  description: string | null;
  permissions: string[];
  created_at: string;
  updated_at: string;
}

/** 登录响应：原版使用托管认证，本实现自签本地 JWT */
export interface AuthSession {
  user: User;
  token?: string;
  expires_at?: string;
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

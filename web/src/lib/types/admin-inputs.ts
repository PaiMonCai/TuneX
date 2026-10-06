/** Domain types extracted from the legacy flat types.ts facade. */
import type { ID, Status, NodeType, TunnelType, LoadBalanceType, IpType, BillingCycle, BypassType, NodeRole, LBStrategy, Node, TunnelMode, TunnelApplyStatus, TunnelDesiredStatus, Tunnel } from "./base";
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
  // Legacy Tunnel desired-state fields.
  /** 模式切换（direct ↔ relay）；relay 必须给出口组/池。 */
  tunnel_mode?: TunnelMode;
  out_node_group_id?: ID | null;
  egress_pool_id?: ID | null;
  egress_node_id?: ID | null;
  remote_host?: string | null;
  remote_port?: number | null;
  /** 期望状态（active/inactive）；resume 走这里，不是 apply_status 直写 */
  desired_status?: TunnelDesiredStatus;
}

/* Legacy Tunnel runtime compatibility types. */

/** 编排步骤的只读回放；状态真相始终是 apply_status。 */
export interface TunnelApplyStep {
  step: string;
  ok: boolean;
  meta?: Record<string, unknown> | null;
  error?: string | null;
}

/** retry / suspend / resume 三个兼容运行操作的统一响应。 */
export interface TunnelRuntimeAction {
  tunnel: Tunnel;
  /** 操作后隧道进入的状态（前端据此刷新徽章，不自行推断） */
  apply_status: TunnelApplyStatus;
  /** 操作后的 revision；retry 重放当前 revision，resume 可推进 desired revision。 */
  config_revision: number | null;
  /** 编排是否已重入（幂等键命中时 true，不算失败） */
  reentered?: boolean;
}

/** 兼容 Tunnel 列表查询。 */
export interface TunnelListQuery {
  page?: number;
  page_size?: number;
  keyword?: string;
  /** legacy 开关列过滤 */
  status?: Status;
  /** apply 状态过滤（pending/applying/active/error/suspended）。 */
  apply_status?: TunnelApplyStatus;
  /** 模式过滤。 */
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
  /// V5-WP20-4b：`null` = 显式解绑；`undefined`（不传）= 不改动（PATCH 部分更新语义）。
  policy_id?: ID | null;
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


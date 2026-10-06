/** Domain types extracted from the legacy flat types.ts facade. */
import type { ID, Status, NodeRole, Node } from "./base";
import type { NodeConnectionValue, NodeLifecycleValue } from "./node-health";
/* ================================================================== */
/* V4-WP5/WP7 Node Lifecycle —— 生命周期视图与依赖影响（§13.4.2/§13.4.3） */
/* ================================================================== */

/**
 * 运行条件拒绝码（后端 `services/node-lifecycle.ts` 的
 * `LifecycleConditionCode` 镜像）。
 *
 * §13.5 明文要求「运行条件拒绝必须使用可区分的错误码，Web 才能给用户正确
 * 下一步」。UI 必须按码给出不同下一步，**不得**把不同码渲染成同一句
 * 「操作失败」——这里声明的是后端契约，不是前端自己的判定规则。
 */
export type NodeLifecycleConditionCode =
  | "invalid_transition"
  | "node_in_maintenance"
  | "node_disabled"
  | "node_retiring"
  | "node_not_retiring"
  | "node_still_used_as_ingress"
  | "node_still_used_as_egress"
  | "dependency_blocked"
  | "port_range_would_orphan_leases";

/**
 * 准入拒绝码。
 *
 * 比生命周期多一个 `node_waiting_install`：`waiting` 节点（还没装 Agent）当然
 * 不能接新业务，但它的下一步是「去安装」而不是「去改生命周期」。
 */
export type NodeAdmissionRejection = "node_waiting_install" | NodeLifecycleConditionCode;

/** 依赖影响统计（后端 `NodeImpact` 的镜像；五类计数 + 阻塞描述）。 */
export interface NodeImpact {
  ingress_forward_count: number;
  egress_forward_count: number;
  binding_count: number;
  active_port_lease_count: number;
  egress_pool_count: number;
  /** 阻塞当前操作的具体原因（空数组 = 无阻塞）。 */
  blockers: string[];
}

/** 角色 / 端口区间变更的前置检查结果（`GET /impact` 的 `role_check`）。 */
export type NodeRoleCheckResult =
  | { ok: true }
  | { ok: false; condition: NodeLifecycleConditionCode; message: string };

/** `GET /api/admin/node/:id/impact` 的 data。 */
export interface NodeImpactResult {
  impact: NodeImpact;
  role_check: NodeRoleCheckResult;
}

/**
 * 单节点生命周期视图（`GET /api/admin/node/:id/lifecycle` 的 data）。
 *
 * 只含 Lifecycle 与 Connection 两层（§13.4.1）；Health 层由 WP6 的
 * `/admin/node/:id/health` 提供——同一个节点在详情页同时展示三层，但**不合并**
 * 成一个「综合状态」，三层的语义与下一步动作各不相同。
 */
export interface NodeLifecycleView {
  id: ID;
  node_id: string;
  role: NodeRole | null;
  lifecycle: NodeLifecycleValue;
  connection: NodeConnectionValue;
  accepts_new_business: boolean;
  has_credential: boolean;
  credential_revoked: boolean;
  /** 拒绝新业务的具体原因码（`accepts_new_business=true` 时为 null）。 */
  admission_rejection: NodeAdmissionRejection | null;
  /** 当前生命周期下所有合法迁移目标（UI 渲染可用按钮的唯一依据）。 */
  allowed_transitions: NodeLifecycleValue[];
}

/** `PATCH /api/admin/node/:id/lifecycle` 的 data：写后整行 + 新视图。 */
export interface NodeLifecycleChangeResult {
  node: Node;
  view: NodeLifecycleView;
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


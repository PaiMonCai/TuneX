/**
 * V4-WP8 §13.4.1 —— 用户侧 Node 三层状态投影（**纯函数**，无 IO / 无 React）。
 *
 * ── 这个模块为什么存在 ──
 * 改造前 `routes/nodes.ts` 的 `nodeView()` 自己写了一遍在线判据
 * （`status==="active" && last_seen<=90s && has_credential && !revoked`），
 * 而 `services/node-lifecycle.ts` 的 `deriveConnection()` 又写了一遍同样的
 * 窗口与凭据条件 —— **同一事实的两份实现**，靠人工保持同步。任何一处调整
 * 窗口/凭据规则，用户列表与准入判定就会分叉，正是 §13.4.4「不允许出现第二套
 * Node 监控真相」禁止的形态。
 *
 * 本模块把「形状翻译」与「判定」彻底分开：
 *   · 判定 —— 只来自 `services/node-lifecycle.ts` 的 `deriveConnection`
 *     （Connection 层事实）与 `nodeAdmission`（Lifecycle 层准入结论）；
 *   · 翻译 —— 本文件只把两者投影成用户侧 API 的响应形状。
 *
 * 因此本文件里**没有**任何阈值、窗口、凭据条件或生命周期白名单的字面量：
 * 出现它们就说明判定又被复制了一份。
 *
 * ── 三层状态在用户侧的呈现 ──
 *   connection            waiting | online | offline        （事实：上报/凭据推导）
 *   lifecycle             active | maintenance | disabled | retiring（期望：用户设置）
 *   accepts_new_business  boolean + admission_rejection 原因码（准入结论）
 *
 * Health 层（§13.4.4）不在这里：它需要遥测快照，属 WP6 的 node-health 视图
 * （管理端 `/api/admin/node/:id/health`）。本投影**不发明**一个「综合状态」把
 * 三层糊成一个布尔——offline ≠ error，maintenance 也不等于故障。
 */
import {
  deriveConnection,
  nodeAdmission,
  type LifecycleConditionCode,
  type NodeConnectionValue,
  type NodeLifecycleValue,
} from "./node-lifecycle.ts";

/**
 * 准入拒绝码（与 WP5 `nodeAdmission` 的返回一致；`node_waiting_install` 是
 * Connection 层的拒绝，不在 lifecycle 条件码集合里）。
 */
export type NodeAdmissionRejection = "node_waiting_install" | LifecycleConditionCode;

/** 判定所需的事实列（与 `nodeAdmission` 的入参同形，不含任何展示字段）。 */
export interface UserNodeFacts {
  status?: string | null;
  last_seen_at?: Date | null;
  has_credential?: boolean;
  credential_revoked?: boolean;
  lifecycle?: string | null;
}

/** 投影输出（用户侧 API 的增量字段）。 */
export interface UserNodeProjection {
  lifecycle: NodeLifecycleValue;
  connection: NodeConnectionValue;
  accepts_new_business: boolean;
  /** `accepts_new_business=true` 时为 null；否则是具体拒绝原因码。 */
  admission_rejection: NodeAdmissionRejection | null;
  /** 兼容投影：= `connection === "online"`，不再是独立判据。 */
  online: boolean;
  has_credential: boolean;
  registered: boolean;
}

/**
 * schema 的 `Node.lifecycle` 有 `@default(active)`；旧 fixture / 未迁移的行可能
 * 不 select 这一列。缺省时按 schema 默认值呈现为 `active`，而不是凭空造一个
 * 「未知生命周期」——那会让老管理端在 UI 上多出一个不存在的状态。
 */
function lifecycleOf(lifecycle: string | null | undefined): NodeLifecycleValue {
  return (lifecycle ?? "active") as NodeLifecycleValue;
}

/**
 * 把节点行投影成用户侧视图。
 *
 * `credential_hash` 既不明文也不哈希地出现在返回值里——只留 `has_credential`
 * 布尔（与 WP5/WP6 的凭据纪律一致）。
 */
export function projectUserNode(node: UserNodeFacts): UserNodeProjection {
  const hasCredential = Boolean(node.has_credential);
  const facts = {
    lifecycle: lifecycleOf(node.lifecycle),
    status: node.status ?? null,
    last_seen_at: node.last_seen_at ?? null,
    has_credential: hasCredential,
    credential_revoked: Boolean(node.credential_revoked),
  };
  const connection = deriveConnection(facts);
  const admission = nodeAdmission(facts);
  return {
    lifecycle: facts.lifecycle,
    connection,
    accepts_new_business: admission.ok,
    admission_rejection: admission.ok ? null : admission.condition,
    online: connection === "online",
    has_credential: hasCredential,
    registered: hasCredential && !facts.credential_revoked,
  };
}
